import { createSurveyReader, FOCUS_PATTERN } from '../voter-survey/analysis.js';
import { classifyPhrase, themeLabel as reasonLabel } from '../voter-survey/sentiment.js';
import { themeLabel, themesOf } from '../pre-election/contact-center.js';
import { oyoGeo } from '../pre-election/geo.js';
import { lgaLabel, matchLga, oyoLgas } from '../pre-election/lga.js';
import { FACILITY_THEME, FACILITY_TYPES, FOCUS_CANDIDATE, NEED_THEME_OF_ANSWER, QUESTIONS } from './form.js';

/**
 * Feedback analysis: what people are telling the campaign, from every channel that carries their
 * voice -- the field survey, the feedback form (share links and signed-in agents), the call
 * center and 10x -- side by side and combined into one ranking of needs.
 *
 * Comparable by construction: the form asks the Core Field Questionnaire, the field survey's older
 * wording is mapped onto the form's options (below), and every need (survey issue, form answer,
 * facility report, caller request) is mapped onto the call center's themes. Only counts and shares
 * leave the server, and written answers are quoted only once five or more people used the same
 * words. Rival candidates are never named in the results.
 */

// Questions compared field-vs-form, in questionnaire order.
const COMPARED = ['respondent', 'topIssue', 'satisfaction', 'sector', 'fairAttention', 'lgaProblem', 'communicate', 'hasPvc', 'votedLast', 'likelihood', 'barrier', 'platform', 'truthSource', 'candidateFactor', 'familiarity', 'goodGovernor'];
// The field survey's wording -> the form's option (after a case-insensitive match fails).
const FIELD_ALIASES = {
  respondent: { 'religious leader - iman': 'Religious Leader', 'religious leader - pastor': 'Religious Leader', 'religious leader - traditional': 'Religious Leader', 'labor union member': 'Labour Union', 'labor union leader': 'Labour Union', 'civil servant leader': 'Civil Service', 'traditional ruler': 'Traditional Leader' },
  topIssue: { 'health care': 'Healthcare' },
  sector: { others: 'Other' },
  lgaProblem: { 'lack of business support': 'Business Support', 'waste management': 'Waste', 'poor schooling conditions': 'Education', 'health facility challenges': 'Healthcare' },
  communicate: { 'community engagement': 'Community Development', 'anti-corruption commitments': 'Anti-Corruption' },
  barrier: { 'security concerns': 'Security', 'transportation issues': 'Transport', 'work commitments': 'Work', 'uncertainty about candidates': 'Lack of Confidence' },
  platform: { twitter: 'X/Twitter', 'grassroot engagement': 'Community Meetings' },
  truthSource: { 'verified media (newspaper)': 'Verified Media', 'social media posts': 'Social Media', 'family & friends': 'Family/Friends', 'celebrities/influencers': 'Other' },
  candidateFactor: { 'party affiliation': 'Party', 'religion/ethnicity': 'Other', 'inclusive policies for senior citizens': 'Policies' },
};
const QUESTION = Object.fromEntries(QUESTIONS.map((question) => [question.id, question]));
const NOT_NEEDS = new Set(['appreciation', 'other', 'assistance', 'campaign']);
const MIN_QUOTE = 5;
const share = (part, whole) => (whole ? Number((part / whole).toFixed(4)) : null);
const fmt = (value) => Number(value || 0).toLocaleString('en-US');
const pct = (value) => `${Math.round((value || 0) * 100)}%`;
const phraseKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A field survey answer in the form's wording ('' when blank). */
function fieldOption(questionId, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const options = QUESTION[questionId]?.options || [];
  return options.find((option) => option.toLowerCase() === text.toLowerCase()) || FIELD_ALIASES[questionId]?.[text.toLowerCase()] || text;
}

function tally(values) {
  const counts = new Map();
  let answered = 0;
  for (const value of values) {
    if (!value) continue;
    answered += 1;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return { answered, counts };
}

/** Need themes named in one respondent's answers (field or form), in the call center's terms. */
function needsOf(values) {
  const themes = new Set();
  for (const value of values) {
    const theme = NEED_THEME_OF_ANSWER[String(value || '').trim().toLowerCase()];
    if (theme) themes.add(theme);
  }
  return themes;
}

export function buildFeedbackAnalysis({ survey = null, responses = [], links = [], projects = [], centerSet = null, tenx = null, lga = '', agents = null }) {
  const wanted = lga ? matchLga(lga) : '';
  const place = wanted ? lgaLabel(wanted) : 'Oyo State';
  const read = survey ? createSurveyReader(survey) : null;
  const fieldValue = (row, key) => (read ? read.value(row, key) : '');
  const field = read ? (wanted ? survey.rows.filter((row) => matchLga(fieldValue(row, 'lga')) === wanted) : survey.rows) : [];
  const form = wanted ? responses.filter((item) => item.lga === wanted) : responses;
  const report = centerSet?.report || null;
  const callerThemes = report ? (wanted ? report.issues?.byLga?.[wanted] || {} : Object.values(report.issues?.byLga || {}).reduce((sum, themes) => {
    for (const [id, count] of Object.entries(themes)) sum[id] = (sum[id] || 0) + count;
    return sum;
  }, {})) : {};
  const calls = report ? (wanted ? report.byLga?.[wanted]?.calls || 0 : report.overview?.calls || 0) : null;
  const collected = form.filter((item) => item.collectedBy);

  // ---- Sources ----------------------------------------------------------------------------
  const sources = {
    field: { available: Boolean(survey), responses: field.length },
    form: { available: true, responses: form.length, byAgents: collected.length, agents: new Set(collected.map((item) => item.collectedBy)).size, public: form.length - collected.length, links: links.length, activeLinks: links.filter((item) => item.active).length },
    callCenter: { available: Boolean(report), calls, period: report?.overview?.period || centerSet?.summary?.period || null },
    // oyo10x shares only how many survey responses it holds, not the answers, and only state-wide.
    tenx: { available: Boolean(tenx), surveys: tenx?.surveys?.count ?? null, responses: wanted ? null : tenx?.surveys?.responses ?? null },
  };

  // ---- Needs: one ranking across channels -------------------------------------------------
  const fieldNeeds = new Map();
  let fieldNeedAnswers = 0;
  for (const row of field) {
    const themes = needsOf([fieldValue(row, 'topIssue'), fieldValue(row, 'lgaProblem')]);
    if (!themes.size) continue;
    fieldNeedAnswers += 1;
    for (const theme of themes) fieldNeeds.set(theme, (fieldNeeds.get(theme) || 0) + 1);
  }
  const formNeeds = new Map();
  let formNeedAnswers = 0;
  for (const response of form) {
    const themes = needsOf([response.answers.topIssue, response.answers.lgaProblem]);
    if (response.facility && FACILITY_THEME[response.facility.type]) themes.add(FACILITY_THEME[response.facility.type]);
    if (!themes.size) continue;
    formNeedAnswers += 1;
    for (const theme of themes) formNeeds.set(theme, (formNeeds.get(theme) || 0) + 1);
  }
  const callerTotal = Object.entries(callerThemes).filter(([id]) => !NOT_NEEDS.has(id)).reduce((sum, [, count]) => sum + count, 0);
  const needIds = new Set([...fieldNeeds.keys(), ...formNeeds.keys(), ...Object.keys(callerThemes).filter((id) => !NOT_NEEDS.has(id))]);
  const needs = [...needIds].map((id) => {
    const parts = {
      field: fieldNeedAnswers >= 20 ? share(fieldNeeds.get(id) || 0, fieldNeedAnswers) : null,
      link: formNeedAnswers >= 10 ? share(formNeeds.get(id) || 0, formNeedAnswers) : null,
      callers: callerTotal >= 10 ? share(callerThemes[id] || 0, callerTotal) : null,
    };
    const present = Object.values(parts).filter((value) => value != null);
    return { id, label: themeLabel(id), ...parts, calls: callerThemes[id] || 0, score: present.length ? Number((present.reduce((sum, value) => sum + value, 0) / present.length).toFixed(4)) : 0, channels: present.length };
  }).sort((a, b) => b.score - a.score);

  // ---- Question by question: field vs form --------------------------------------------------
  const questions = COMPARED.map((id) => {
    const question = QUESTION[id];
    const fromField = tally(field.map((row) => fieldOption(id, fieldValue(row, id))));
    const fromForm = tally(form.map((response) => response.answers[id]));
    const names = [...new Set([...question.options, ...fromField.counts.keys()])].filter((name) => (fromField.counts.get(name) || 0) + (fromForm.counts.get(name) || 0) > 0);
    return {
      id,
      n: question.n,
      text: question.text,
      fieldAnswered: fromField.answered,
      linkAnswered: fromForm.answered,
      rows: names.map((name) => ({ name, field: share(fromField.counts.get(name) || 0, fromField.answered), link: share(fromForm.counts.get(name) || 0, fromForm.answered) }))
        .sort((a, b) => (b.field || 0) + (b.link || 0) - ((a.field || 0) + (a.link || 0))),
    };
  });

  // ---- Vote intention: Sen. Alli's share only, no rival named -------------------------------
  const fieldNamed = field.filter((row) => fieldValue(row, 'firstChoice'));
  const fieldFocus = fieldNamed.filter((row) => FOCUS_PATTERN.test(fieldValue(row, 'firstChoice'))).length;
  const choices = tally(form.map((response) => response.answers.choice));
  const undecided = (choices.counts.get('Undecided') || 0);
  const notSaying = (choices.counts.get('Prefer Not to Say') || 0);
  const formNamed = choices.answered - undecided - notSaying;
  const intention = {
    field: { share: share(fieldFocus, fieldNamed.length), named: fieldNamed.length, undecided: share(field.length - fieldNamed.length, field.length) },
    link: { share: share(choices.counts.get(FOCUS_CANDIDATE) || 0, formNamed), named: formNamed, undecided: share(undecided, choices.answered) },
  };

  // ---- How people see Sen. Alli (form questions 14-15) --------------------------------------
  const scale = (id) => {
    const counts = tally(form.map((response) => response.answers[id]));
    return { answered: counts.answered, rows: QUESTION[id].options.map((name) => ({ name, share: share(counts.counts.get(name) || 0, counts.answered), count: counts.counts.get(name) || 0 })) };
  };
  const reasons = { answers: 0, tone: { positive: 0, negative: 0, neutral: 0, mixed: 0 }, themes: new Map(), phrases: new Map() };
  for (const response of form) {
    const text = response.answers.why;
    if (!text) continue;
    const { tone, themes } = classifyPhrase(text);
    if (!tone) continue;
    reasons.answers += 1;
    reasons.tone[tone] += 1;
    for (const theme of themes) reasons.themes.set(theme, (reasons.themes.get(theme) || 0) + 1);
    const key = phraseKey(text);
    reasons.phrases.set(key, (reasons.phrases.get(key) || 0) + 1);
  }
  const perception = {
    impression: scale('impression'),
    goodGovernor: scale('goodGovernor'),
    familiarity: scale('familiarity'),
    reasons: {
      answers: reasons.answers,
      positive: share(reasons.tone.positive, reasons.answers),
      negative: share(reasons.tone.negative + reasons.tone.mixed, reasons.answers),
      themes: [...reasons.themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, count]) => ({ id, label: reasonLabel(id), count, share: share(count, reasons.answers) })),
      quotes: [...reasons.phrases.entries()].filter(([, count]) => count >= MIN_QUOTE).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([phrase, count]) => ({ phrase, count })),
    },
  };

  // ---- Projects (question 16) -----------------------------------------------------------------
  const ratings = new Map();
  for (const response of form) for (const [id, score] of Object.entries(response.answers.projects || {})) {
    if (!ratings.has(id)) ratings.set(id, []);
    ratings.get(id).push(score);
  }
  const wardName = (lgaName, number) => (number == null ? null : oyoGeo().lgas.get(lgaName)?.wards.get(number)?.name || null);
  const projectRows = projects.filter((project) => !wanted || project.lga === wanted).map((project) => {
    const scores = ratings.get(project.id) || [];
    return {
      id: project.id,
      title: project.title,
      lga: lgaLabel(project.lga),
      ward: wardName(project.lga, project.ward),
      candidate: project.candidate || null,
      active: project.active,
      ratings: scores.length,
      average: scores.length ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1)) : null,
      urgent: share(scores.filter((score) => score >= 8).length, scores.length),
    };
  }).sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || b.ratings - a.ratings);

  // ---- Facilities and problem spots (question 17) --------------------------------------------
  const reported = form.filter((response) => response.facility?.type);
  const facilities = {
    total: reported.length,
    pinned: reported.filter((response) => response.facility.lat != null).length,
    byType: FACILITY_TYPES.map((type) => ({ type, count: reported.filter((response) => response.facility.type === type).length })).filter((row) => row.count).sort((a, b) => b.count - a.count),
    // Where and what, for the people who act on it (administrators).
    recent: agents ? [...reported].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 25).map((response) => ({
      type: response.facility.type,
      note: response.facility.note || '',
      lga: lgaLabel(response.lga),
      ward: wardName(response.lga, response.ward),
      lat: response.facility.lat ?? null,
      lng: response.facility.lng ?? null,
      at: response.submittedAt,
    })) : null,
  };

  // ---- Field agents (question 18), administrators only ----------------------------------------
  const agentRows = agents ? [...tally(collected.map((item) => item.collectedBy)).counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ name: agents.get(id) || 'Former user', count })) : null;

  // ---- By LGA --------------------------------------------------------------------------------
  const fieldByLga = new Map();
  for (const row of field) {
    const name = wanted || matchLga(fieldValue(row, 'lga'));
    if (!name) continue;
    if (!fieldByLga.has(name)) fieldByLga.set(name, []);
    fieldByLga.get(name).push(row);
  }
  const byLga = oyoLgas().filter((item) => !wanted || item.name === wanted).map((item) => {
    const fieldHere = fieldByLga.get(item.name) || [];
    const formHere = form.filter((response) => response.lga === item.name);
    const counts = new Map();
    for (const row of fieldHere) for (const theme of needsOf([fieldValue(row, 'topIssue'), fieldValue(row, 'lgaProblem')])) counts.set(theme, (counts.get(theme) || 0) + 1);
    for (const response of formHere) for (const theme of needsOf([response.answers.topIssue, response.answers.lgaProblem])) counts.set(theme, (counts.get(theme) || 0) + 1);
    for (const [id, count] of Object.entries(report?.issues?.byLga?.[item.name] || {})) if (!NOT_NEEDS.has(id)) counts.set(id, (counts.get(id) || 0) + count);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return { lga: item.name, name: lgaLabel(item.name), field: fieldHere.length, link: formHere.length, calls: report ? report.byLga?.[item.name]?.calls || 0 : null, facilities: formHere.filter((response) => response.facility?.type).length, topNeed: top ? themeLabel(top[0]) : null };
  }).sort((a, b) => (b.field + b.link + (b.calls || 0)) - (a.field + a.link + (a.calls || 0)));

  // ---- Intelligence --------------------------------------------------------------------------
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  const heard = sources.field.responses + sources.form.responses + (calls || 0);
  add('info', `${fmt(heard)} voices heard in ${place}: ${fmt(sources.field.responses)} field survey answers, ${fmt(sources.form.responses)} feedback forms${sources.form.byAgents ? ` (${fmt(sources.form.byAgents)} by field agents)` : ''}, ${fmt(calls || 0)} call-center calls${sources.tenx.responses ? `, and ${fmt(sources.tenx.responses)} 10x survey responses` : ''}.`);
  const top = needs.filter((need) => need.channels >= 2).slice(0, 3);
  if (top.length) add('risk', `What people ask for most, across channels: ${top.map((need) => need.label.toLowerCase()).join(', ')}.`);
  const callerFirst = [...needs].filter((need) => need.callers != null && need.field != null).sort((a, b) => (b.callers - b.field) - (a.callers - a.field))[0];
  if (callerFirst && callerFirst.callers - callerFirst.field > 0.08) add('watch', `${callerFirst.label} comes up far more on calls (${pct(callerFirst.callers)} of requests) than in the survey (${pct(callerFirst.field)}): an urgent, local need the survey under-states.`);
  const q = (id) => questions.find((item) => item.id === id);
  const satisfied = (source) => q('satisfaction').rows.filter((row) => /^(very )?satisfied$/i.test(row.name)).reduce((sum, row) => sum + (row[source] || 0), 0);
  if (q('satisfaction').fieldAnswered) add('info', `${pct(satisfied('field'))} of field survey respondents are satisfied with the current government${q('satisfaction').linkAnswered >= 10 ? `, against ${pct(satisfied('link'))} on the feedback form` : ''}.`);
  const noPvc = q('hasPvc').rows.filter((row) => row.name !== 'Yes').reduce((sum, row) => sum + (row.link || 0), 0);
  if (q('hasPvc').linkAnswered >= 10 && noPvc > 0.1) add('risk', `${pct(noPvc)} of people on the feedback form have no PVC yet or are awaiting it: a collection drive is needed.`);
  const barrier = q('barrier').rows.find((row) => row.name !== 'Nothing');
  if (barrier) add('watch', `The main thing that could stop people voting: ${barrier.name.toLowerCase()}.`);
  const platform = q('platform').rows[0];
  if (platform) add('info', `${platform.name} is where most people get their political information.`);
  const good = perception.goodGovernor;
  if (good.answered >= 10) add(good.rows[0].share >= 0.5 ? 'good' : 'watch', `${pct(good.rows[0].share)} of people on the feedback form think ${FOCUS_CANDIDATE} would make a good governor; ${pct(good.rows.find((row) => row.name === "Don't Know Enough").share)} say they don't know enough about him.`);
  const topProject = projectRows.find((project) => project.ratings >= 5);
  if (topProject) add('info', `Most needed project so far: ${topProject.title} (${topProject.lga}${topProject.ward ? `, ${topProject.ward}` : ''}), rated ${topProject.average}/10 by ${fmt(topProject.ratings)} people.`);
  if (facilities.total) add('watch', `${fmt(facilities.total)} facilities or problem spots reported${facilities.byType[0] ? `, most often: ${facilities.byType[0].type.toLowerCase()}` : ''}.`);
  const silent = byLga.filter((row) => !row.field && !row.link && !row.calls);
  if (silent.length && !wanted) add('risk', `No feedback at all yet from ${silent.slice(0, 5).map((row) => row.name).join(', ')}${silent.length > 5 ? ` and ${silent.length - 5} more` : ''}. Share the link there.`);
  if (!form.length) add('info', 'No feedback forms yet. Create a share link and send it on WhatsApp, to coordinators and field agents.');

  const order = { risk: 0, watch: 1, good: 2, info: 3 };
  return {
    place,
    lga: wanted || null,
    sources,
    needs: needs.slice(0, 10),
    questions,
    intention,
    perception,
    projects: projectRows,
    facilities,
    agents: agentRows,
    byLga,
    insights: [out[0], ...out.slice(1).sort((a, b) => order[a.tone] - order[b.tone])],
  };
}
