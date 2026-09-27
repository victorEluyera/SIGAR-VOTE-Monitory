import express from 'express';
import { getRegistrationLocationOptions } from '../../../shared/electionData.js';
import { recordAudit } from '../foundation/audit-helper.js';
import { openCsvWorkbook, openWorkbook } from './xlsx.js';
import { appendSurveyDataset, buildSurveyDataset } from './import.js';
import { analyzeSurvey, lgaKey } from './analysis.js';
import { withBaseline } from '../pre-election/baseline.js';

const CAN_VIEW = ['Stakeholder', 'Admin', 'Super Admin'];
const CAN_IMPORT = ['Admin', 'Super Admin'];
const MAX_WORKBOOK_BYTES = 40 * 1024 * 1024;

/** Polling units per LGA, from the bundled INEC register -- the fallback weighting. */
function pollingUnitWeights() {
  const weights = new Map();
  for (const lga of getRegistrationLocationOptions('Oyo').lgas) {
    let units = 0;
    for (const ward of getRegistrationLocationOptions('Oyo', lga).wards) units += getRegistrationLocationOptions('Oyo', lga, ward).pollingUnits.length;
    if (units) weights.set(lgaKey(lga), units);
  }
  return weights;
}

/**
 * GET  /api/voter-survey          the analysis (optional ?lga= and ?respondent= filters)
 * POST /api/voter-survey/import   replace the survey with a new workbook (admins only)
 *
 * Only aggregates leave the server. The stored dataset itself -- even anonymised -- is never
 * returned, and written-answer examples are shown only once a phrase recurs, so a single
 * respondent's words cannot be picked out.
 */
export function registerVoterSurveyRoutes({ app, auth, rateLimit, asyncRoute, store, openAiPrimaryModel, openAiFallbackModel, callGroqWithFallback, geminiApiKeys = [] }) {
  const fallbackWeights = pollingUnitWeights();
  const cache = new Map();

  const weightsFor = async () => {
    try {
      const datasets = await store.demographicDatasets({ metric: 'registered-voters', resolution: 'lga', status: 'approved' });
      const latest = [...datasets].sort((a, b) => String(b.publicationDate || '').localeCompare(String(a.publicationDate || '')))[0];
      if (latest?.records?.length) {
        const weights = new Map(latest.records.map((record) => [lgaKey(record.geography?.lga), Number(record.value) || 0]).filter(([key, value]) => key && value > 0));
        if (weights.size >= 20) return { weights, basis: `registered voters per LGA (${latest.sourceName})`, version: latest.id };
      }
    } catch {
      // Fall through to the pre-election reference table.
    }
    try {
      // The pre-election "Population & voter register" table (uploaded, or built in from the voter register).
      const reference = withBaseline(await store.preElectionDatasets()).filter((item) => item.kind === 'reference')
        .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))[0];
      const weights = new Map(Object.entries(reference?.values || {}).map(([lga, entry]) => [lgaKey(lga), Number(entry.registeredVoters) || 0]).filter(([key, value]) => key && value > 0));
      if (weights.size >= 20) return { weights, basis: 'registered voters per LGA (voter register)', version: reference.id };
    } catch {
      // Fall through to the polling-unit proxy.
    }
    return { weights: fallbackWeights, basis: 'number of polling units per LGA (a stand-in for voter numbers until an approved registered-voter dataset is loaded)', version: 'units' };
  };

  app.get('/api/voter-survey', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_VIEW.includes(req.user?.role)) return res.status(403).json({ message: 'The voter survey is available to stakeholders and administrators.' });
    const dataset = await store.voterSurvey();
    if (!dataset) return res.json({ status: 'empty', canImport: CAN_IMPORT.includes(req.user.role) });

    const filter = { lga: String(req.query.lga || '').slice(0, 80), respondent: String(req.query.respondent || '').slice(0, 80) };
    const { weights, basis, version } = await weightsFor();
    // The weighting source is part of the key, so newly loaded voter figures take effect at once.
    const key = `${dataset.id}|${version}|${filter.lga}|${filter.respondent}`;
    if (!cache.has(key)) {
      if (cache.size > 200) cache.clear();
      cache.set(key, analyzeSurvey(dataset, filter, { lgaWeights: weights, weightBasis: basis }));
    }
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ status: 'ok', canImport: CAN_IMPORT.includes(req.user.role), ...cache.get(key) });
  }));

  app.post(
    '/api/voter-survey/import',
    auth,
    rateLimit,
    express.raw({ type: () => true, limit: MAX_WORKBOOK_BYTES }),
    asyncRoute(async (req, res) => {
      if (!CAN_IMPORT.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can import the voter survey.' });
      const fileName = String(req.query.fileName || 'survey.xlsx').slice(0, 200);
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ message: 'No file was received. Choose the survey .xlsx workbook and try again.' });

      let dataset;
      try {
        const isCsv = /\.csv$/i.test(fileName) || String(req.headers['content-type'] || '').includes('text/csv');
        dataset = buildSurveyDataset(isCsv ? openCsvWorkbook(req.body) : openWorkbook(req.body), { sourceFile: fileName, importedBy: req.user.id });
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }
      if (!dataset.responseCount) return res.status(400).json({ message: 'The survey sheet has no responses.' });

      const previous = await store.voterSurvey();
      const combined = appendSurveyDataset(previous, dataset, { sourceFile: fileName, importedBy: req.user.id });
      await store.saveVoterSurvey(combined);
      cache.clear();
      await recordAudit(store, req, {
        action: 'voter_survey.imported',
        entityType: 'dataset',
        entityId: combined.id,
        details: { sourceFile: fileName, sheet: dataset.sourceSheet, addedResponses: dataset.responseCount, totalResponses: combined.responseCount, collectors: dataset.agentCount },
        source: 'upload',
      });

      // Prove the import read what Excel read: compare with the workbook's own headline totals.
      const analysis = analyzeSurvey(dataset);
      const totals = dataset.workbookTotals || {};
      const checks = [
        ['Total responses', totals.responses, dataset.responseCount],
        ['Named-candidate answers', totals.namedVotes, analysis.vote.named],
        ['Sen. Alli first-choice votes', totals.focusVotes, analysis.focus?.votes],
      ].filter(([, expected]) => Number.isFinite(expected)).map(([label, expected, actual]) => ({ label, workbook: expected, imported: actual, matches: expected === actual }));

      res.status(201).json({ id: combined.id, sourceFile: fileName, sheet: dataset.sourceSheet, addedResponses: dataset.responseCount, totalResponses: combined.responseCount, collectors: dataset.agentCount, fields: dataset.fields.length, checks });
    }),
  );

  app.post('/api/voter-survey/ai', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_VIEW.includes(req.user?.role)) return res.status(403).json({ message: 'The voter survey is available to stakeholders and administrators.' });
    const dataset = await store.voterSurvey();
    if (!dataset) return res.status(404).json({ message: 'Load a survey before requesting an analysis.' });
    const filter = { lga: String(req.body?.lga || '').slice(0, 80), respondent: String(req.body?.respondent || '').slice(0, 80) };
    const view = analyzeSurvey(dataset, filter);
    const context = {
      responses: view.filter.responses,
      lgas: view.source.lgas,
      firstChoice: view.vote.firstChoice.slice(0, 8),
      weightedFirstChoice: view.vote.weighted?.rows?.slice(0, 8) || [],
      secondChoice: view.vote.transfers,
      topQuestions: Object.fromEntries(Object.entries(view.questions).map(([key, value]) => [key, value.rows.slice(0, 5)])),
      sentiment: { answers: view.sentiment.answers, tone: view.sentiment.tone, themes: view.sentiment.themes.slice(0, 8) },
      lgaLeaders: view.byLga.map((row) => ({ lga: row.lga, responses: row.responses, leader: row.leader, leaderShare: row.leaderShare })).slice(0, 33),
    };
    const prompt = `Act as a senior neutral survey analyst. Analyze only the supplied aggregate results from a campaign voter survey. Do not invent facts, forecast an election, target individuals, or recommend manipulation or partisan persuasion. Clearly distinguish what respondents said from what the survey can support. Give practical, ethical campaign planning implications without micro-targeting. Return no more than 500 words with these plain-text sections: EXECUTIVE SUMMARY, STRONGEST SIGNALS, IMPORTANT DIFFERENCES, WHAT TO DO NEXT, LIMITATIONS.\n\nAGGREGATE SURVEY DATA:\n${JSON.stringify(context)}`;

    if (geminiApiKeys.length) {
      const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.6-flash', process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'])];
      for (const model of models) {
        for (const apiKey of geminiApiKeys) {
          try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 900 } }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body?.error?.message || 'Gemini request failed');
            const analysis = body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
            if (analysis.trim()) return res.json({ analysis, provider: 'gemini', model });
          } catch (error) { console.error(`[survey-ai] Gemini ${model} failed:`, error.message); }
        }
      }
    }
    if (process.env.GROQ_API_KEY && callGroqWithFallback) {
      try {
        const result = await callGroqWithFallback(prompt);
        if (String(result.text || '').trim()) return res.json({ analysis: result.text, provider: 'groq', model: result.model });
      } catch (error) { console.error('[survey-ai] Groq failed:', error.message); }
    }
    if (process.env.OPENAI_API_KEY) {
      const call = async (model) => {
        const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: prompt, max_output_tokens: 900 }) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || 'OpenAI request failed');
        return body.output_text || body.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('') || '';
      };
      try {
        const model = openAiPrimaryModel || process.env.OPENAI_MODEL || 'gpt-5.6-terra';
        const analysis = await call(model);
        if (analysis.trim()) return res.json({ analysis, provider: 'openai', model });
      } catch (error) { console.error('[survey-ai] OpenAI failed:', error.message); }
    }
    const configured = {
      groq: Boolean(process.env.GROQ_API_KEY && callGroqWithFallback),
      gemini: geminiApiKeys.length > 0,
      openai: Boolean(process.env.OPENAI_API_KEY),
    };
    const anyConfigured = Object.values(configured).some(Boolean);
    console.error('[survey-ai] no provider returned usable analysis', configured);
    return res.status(503).json({
      message: anyConfigured
        ? 'Survey AI providers are configured, but none returned usable analysis. Check the Render logs for the provider error. Statistical analysis is still available.'
        : 'No survey AI provider key is available to the running server. Check the Render environment variables and redeploy. Statistical analysis is still available.',
      configured,
    });
  }));
}
