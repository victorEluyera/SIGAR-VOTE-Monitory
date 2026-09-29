import express from 'express';
import { recordAudit } from '../foundation/audit-helper.js';
import { openCsvWorkbook, openWorkbook } from '../voter-survey/xlsx.js';
import { buildDataset, DATASET_KINDS, describeDataset } from './datasets.js';
import { lgaLabel, oyoLgas } from './lga.js';
import { baselineRegister, withBaseline } from './baseline.js';
import { buildMap } from './map.js';
import { buildPulse } from './pulse.js';
import { buildOverview, onlineReport } from './overview.js';
import { buildVoterAnalysis, memberMatchKeys } from './voters.js';
import { aiPrompt, buildFacts, checkAiPlan, HORIZONS, QUADRANTS, ruleActions, ruleBrief, STATUSES } from './actions.js';
import { askModels } from './ai.js';

const CAN_VIEW = ['Stakeholder', 'Admin', 'Super Admin'];
const CAN_UPLOAD = ['Admin', 'Super Admin'];
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

const TEMPLATES = {
  members: () => 'LGA,Ward,Polling unit,Name,Phone number\nIbadan North,Ward 1,001,,\n',
  contacts: () => 'LGA,Phone number\nIbadan North,\n',
  reference: () => `LGA,Population,Registered voters,PVCs collected\n${oyoLgas().map((lga) => `${lgaLabel(lga.name)},,,`).join('\n')}\n`,
};

/**
 * GET    /api/pre-election/pulse?lga=        the Pulse for Oyo or one LGA (aggregates only)
 * GET    /api/pre-election/map?lga=&ward=    the sentiment map: 33 LGAs, one LGA's wards, or one ward's units
 * GET    /api/pre-election/actions?lga=&horizon=     next actions as an Eisenhower matrix
 * POST   /api/pre-election/actions/generate          ask the AI to write the matrix from the facts
 * PUT    /api/pre-election/actions/status            to do / doing / done for one action (admins)
 * GET    /api/pre-election/datasets          uploaded datasets, without their rows (admins)
 * POST   /api/pre-election/datasets?kind=    upload a member list, contact list or reference table (admins)
 * DELETE /api/pre-election/datasets/:id      remove an upload (admins)
 * GET    /api/pre-election/templates/:kind   a blank CSV in the expected shape
 */
export function registerPreElectionRoutes({ app, auth, rateLimit, asyncRoute, store, geminiApiKeys = [], callGroqWithFallback = null, openAiPrimaryModel = '', oyo10x = null }) {
  const cache = new Map();
  // 10x volunteers, live from oyo10x (cached and backed off by its client; never throws). null
  // when it is not connected or has not answered yet, which the views show as "not connected".
  const tenxSnapshot = async () => {
    const snapshot = oyo10x ? await oyo10x.snapshot() : null;
    return { data: snapshot?.data || null, version: snapshot?.fetchedAt || snapshot?.status || 'none' };
  };
  const canView = (req, res) => {
    if (CAN_VIEW.includes(req.user?.role)) return true;
    res.status(403).json({ message: 'The pre-election pulse is available to stakeholders and administrators.' });
    return false;
  };
  const canUpload = (req, res) => {
    if (CAN_UPLOAD.includes(req.user?.role)) return true;
    res.status(403).json({ message: 'Only administrators can manage pre-election data.' });
    return false;
  };

  app.get('/api/pre-election/pulse', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canView(req, res)) return;
    const [uploaded, survey] = await Promise.all([store.preElectionDatasets(), store.voterSurvey()]);
    const datasets = withBaseline(uploaded);
    const lga = String(req.query.lga || '').slice(0, 80);
    const tenx = await tenxSnapshot();
    const key = `${datasets.map((item) => item.id).sort().join(',')}|${survey?.id || ''}|${tenx.version}|${lga}`;
    if (!cache.has(key)) {
      if (cache.size > 100) cache.clear();
      cache.set(key, buildPulse({ datasets, survey, lga, tenx: tenx.data }));
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ ...cache.get(key), canUpload: CAN_UPLOAD.includes(req.user.role) });
  }));

  app.get('/api/pre-election/map', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canView(req, res)) return;
    const [uploaded, survey] = await Promise.all([store.preElectionDatasets(), store.voterSurvey()]);
    const datasets = withBaseline(uploaded);
    const lga = String(req.query.lga || '').slice(0, 80);
    const ward = /^\d{1,2}$/.test(String(req.query.ward || '')) ? String(Number(req.query.ward)) : '';
    const tenx = await tenxSnapshot();
    const key = `map|${datasets.map((item) => item.id).sort().join(',')}|${survey?.id || ''}|${tenx.version}|${lga}|${ward}`;
    if (!cache.has(key)) {
      if (cache.size > 100) cache.clear();
      cache.set(key, buildMap({ datasets, survey, lga, ward, register: baselineRegister(), tenx: tenx.data }));
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.json(cache.get(key));
  }));

  // ---- Overview and voter analysis --------------------------------------------------------------
  // Both are built from the same pulse and map figures, so every tab agrees.
  const loadViews = async () => {
    const [uploaded, survey] = await Promise.all([store.preElectionDatasets(), store.voterSurvey()]);
    const datasets = withBaseline(uploaded);
    const tenx = await tenxSnapshot();
    return { datasets, survey, tenx, version: `${datasets.map((item) => item.id).sort().join(',')}|${survey?.id || ''}|${tenx.version}` };
  };

  app.get('/api/pre-election/overview', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canView(req, res)) return;
    const { datasets, survey, tenx, version } = await loadViews();
    const key = `overview|${version}`;
    if (!cache.has(key)) {
      if (cache.size > 100) cache.clear();
      const pulse = buildPulse({ datasets, survey, tenx: tenx.data });
      const map = buildMap({ datasets, survey, register: baselineRegister(), tenx: tenx.data });
      cache.set(key, buildOverview({ pulse, map, tenx: tenx.data, online: onlineReport() }));
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.json(cache.get(key));
  }));

  app.get('/api/pre-election/voters', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canView(req, res)) return;
    const { datasets, survey, tenx, version } = await loadViews();
    const lga = String(req.query.lga || '').slice(0, 80);
    const ward = /^\d{1,2}$/.test(String(req.query.ward || '')) ? String(Number(req.query.ward)) : '';
    const key = `voters|${version}|${lga}|${ward}`;
    if (!cache.has(key)) {
      if (cache.size > 100) cache.clear();
      const map = buildMap({ datasets, survey, lga, ward, register: baselineRegister(), tenx: tenx.data });
      const memberKeys = memberMatchKeys(datasets.filter((item) => item.kind === 'members'));
      // tenx.data.people is the per-person feed oyo10x does not send yet (see voters.js).
      cache.set(key, buildVoterAnalysis({ map, memberKeys, tenxPeople: tenx.data?.people || null }));
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.json(cache.get(key));
  }));

  // ---- Next actions ---------------------------------------------------------------------------
  const scopeOf = (req, source) => {
    const horizon = HORIZONS[source.horizon] ? source.horizon : 'week';
    const lga = String(source.lga || '').slice(0, 80);
    return { lga, horizon };
  };
  const loadFacts = async ({ lga }) => {
    const [uploaded, survey] = await Promise.all([store.preElectionDatasets(), store.voterSurvey()]);
    const datasets = withBaseline(uploaded);
    const dataKey = `${datasets.map((item) => item.id).sort().join(',')}|${survey?.id || ''}`;
    return { ...buildFacts({ datasets, survey, lga }), dataKey, datasets, survey };
  };
  const planKey = (context, horizon) => `${context.pulse.filter.lga || 'state'}|${horizon}`;
  const dataGapsFrom = (facts, survey) => [
    ...facts.filter((fact) => fact.id.startsWith('D')).map((fact) => fact.fact),
    ...(survey ? [] : ['No voter survey is loaded.']),
  ];

  app.get('/api/pre-election/actions', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canView(req, res)) return;
    const { lga, horizon } = scopeOf(req, req.query);
    const { facts, context, dataKey, datasets, survey } = await loadFacts({ lga });
    const [stored, statuses] = await Promise.all([store.preElectionPlan(planKey(context, horizon)), store.preElectionActionStatus()]);
    const useAi = stored?.plan && stored.dataKey === dataKey;
    const quadrants = useAi ? stored.plan.quadrants : ruleActions({ facts, context }, { horizon });
    for (const quadrant of QUADRANTS) for (const action of quadrants[quadrant] || []) {
      const entry = statuses[action.key];
      action.status = entry?.status || 'todo';
      action.statusAt = entry?.at || null;
    }
    const counts = {
      survey: survey?.responseCount || 0,
      members: context.pulse.members.available ? context.pulse.members.total : 0,
      calls: context.pulse.contactCenter.available ? context.pulse.contactCenter.stateCalls : 0,
      contacts: context.pulse.contacts.available ? context.pulse.contacts.total : 0,
      pollingUnits: context.pulse.register.pollingUnits,
      datasets: datasets.length,
    };
    res.json({
      scope: { lga: context.pulse.filter.lga, label: context.pulse.filter.label, options: context.pulse.filter.options },
      horizon,
      horizons: HORIZONS,
      plan: useAi
        ? { source: 'ai', provider: stored.provider, model: stored.model, generatedAt: stored.generatedAt }
        : { source: 'rules', staleAi: Boolean(stored?.plan), previousAiAt: stored?.generatedAt || null },
      brief: useAi && stored.plan.brief?.where_we_stand ? stored.plan.brief : ruleBrief({ facts, context }),
      quadrants,
      dataGaps: useAi && stored.plan.data_gaps?.length ? stored.plan.data_gaps : dataGapsFrom(facts, survey),
      facts: facts.map(({ id, fact }) => ({ id, fact })),
      counts,
      canEdit: CAN_UPLOAD.includes(req.user.role),
    });
  }));

  app.post('/api/pre-election/actions/generate', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canView(req, res)) return;
    const { lga, horizon } = scopeOf(req, req.body || {});
    const { facts, context, dataKey } = await loadFacts({ lga });
    const answer = await askModels(aiPrompt(facts, { place: context.place, horizon }), { geminiApiKeys, callGroqWithFallback, openAiPrimaryModel });
    const plan = answer ? checkAiPlan(answer.text, facts) : null;
    if (!plan) {
      return res.status(503).json({ message: answer ? 'The AI answer could not be checked against the data, so the rule-based plan is shown instead.' : 'No AI provider answered. The rule-based plan is shown instead.' });
    }
    const saved = { plan, provider: answer.provider, model: answer.model, generatedAt: new Date().toISOString(), generatedBy: req.user.id, dataKey };
    await store.savePreElectionPlan(planKey(context, horizon), saved);
    await recordAudit(store, req, { action: 'pre_election.actions_generated', entityType: 'plan', entityId: planKey(context, horizon), details: { provider: answer.provider, model: answer.model, actions: QUADRANTS.reduce((sum, key) => sum + plan.quadrants[key].length, 0) } });
    res.status(201).json({ ok: true, provider: answer.provider, model: answer.model, generatedAt: saved.generatedAt });
  }));

  app.put('/api/pre-election/actions/status', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canUpload(req, res)) return;
    const key = String(req.body?.key || '').slice(0, 80);
    const status = String(req.body?.status || '');
    if (!/^(rule|ai):[a-z0-9-]{1,60}$/.test(key) || !STATUSES.includes(status)) return res.status(400).json({ message: 'A valid action and status (todo, doing, done) are required.' });
    await store.setPreElectionActionStatus(key, { status, by: req.user.id, at: new Date().toISOString() });
    res.json({ key, status });
  }));

  app.get('/api/pre-election/datasets', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canUpload(req, res)) return;
    const [uploaded, survey] = await Promise.all([store.preElectionDatasets(), store.voterSurvey()]);
    const datasets = withBaseline(uploaded);
    res.json({
      datasets: datasets.map(describeDataset).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))),
      survey: survey ? { id: survey.id, sourceFile: survey.sourceFile, importedAt: survey.importedAt, responses: survey.responseCount, builtIn: Boolean(survey.builtIn) } : null,
    });
  }));

  app.post(
    '/api/pre-election/datasets',
    auth,
    rateLimit,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    asyncRoute(async (req, res) => {
      if (!canUpload(req, res)) return;
      const kind = String(req.query.kind || '');
      if (!DATASET_KINDS.includes(kind)) return res.status(400).json({ message: `Choose a dataset type: ${DATASET_KINDS.join(', ')}.` });
      const fileName = String(req.query.fileName || 'upload.xlsx').slice(0, 200);
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ message: 'No file was received. Choose an Excel or CSV file and try again.' });
      let dataset;
      try {
        const isCsv = /\.csv$/i.test(fileName) || String(req.headers['content-type'] || '').includes('text/csv');
        dataset = buildDataset(kind, isCsv ? openCsvWorkbook(req.body) : openWorkbook(req.body), {
          label: req.query.label, source: req.query.source, year: req.query.year, sourceFile: fileName, uploadedBy: req.user.id,
        });
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }
      const { replaced } = await store.savePreElectionDataset(dataset);
      cache.clear();
      await recordAudit(store, req, {
        action: 'pre_election.dataset_uploaded',
        entityType: 'dataset',
        entityId: dataset.id,
        details: { kind, label: dataset.label, sourceFile: fileName, replaced, ...dataset.summary, sheets: undefined, unmatched: dataset.summary.unmatched?.length },
        source: 'upload',
      });
      res.status(201).json({ ...describeDataset(dataset), replaced: replaced.length });
    }),
  );

  app.delete('/api/pre-election/datasets/:id', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!canUpload(req, res)) return;
    const removed = await store.deletePreElectionDataset(String(req.params.id));
    if (!removed) return res.status(404).json({ message: 'That upload no longer exists.' });
    cache.clear();
    await recordAudit(store, req, { action: 'pre_election.dataset_deleted', entityType: 'dataset', entityId: removed.id, details: { kind: removed.kind, label: removed.label, sourceFile: removed.sourceFile } });
    res.status(204).end();
  }));

  app.get('/api/pre-election/templates/:kind', auth, rateLimit, (req, res) => {
    const template = TEMPLATES[req.params.kind];
    if (!template) return res.status(404).json({ message: 'Unknown template.' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="pre-election-${req.params.kind}-template.csv"`);
    res.send(template());
  });
}
