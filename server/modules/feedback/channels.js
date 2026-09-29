import { createSurveyReader, FOCUS_PATTERN } from '../voter-survey/analysis.js';
import { themeLabel } from '../pre-election/contact-center.js';
import { lgaLabel, matchLga } from '../pre-election/lga.js';

/**
 * The three feedback channels as cards, each with a drill-down, plus the critical intelligence
 * drawn from all three:
 *
 *   Call center -- the contact center report (calls, supporters, open calls, what callers ask for).
 *   10x (field work) -- the field survey. Until oyo10x shares its own survey answers, the field
 *     survey is the campaign's field work and is presented as the 10x channel.
 *   Online -- the latest social-listening report (server/data/online-report.json).
 *
 * Counts and shares only. Rival candidates are not named, except in the online report, which is
 * itself a head-to-head with one named opponent.
 */

const MIN_NAMED = 30;
const share = (part, whole) => (whole ? Number((part / whole).toFixed(4)) : null);
const fmt = (value) => Number(value || 0).toLocaleString('en-US');
const pct = (value) => `${Math.round((value || 0) * 100)}%`;
const named = (rows, pattern) => (rows || []).find((row) => pattern.test(row.name))?.calls || 0;
const HIDDEN_THEMES = new Set(['other', 'assistance']);
const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] || '');
const sentence = (text) => { const words = String(text || '').toLowerCase(); return words.charAt(0).toUpperCase() + words.slice(1); };
const lower = (text) => String(text || '').replace(/^[A-Z](?![A-Z])/, (letter) => letter.toLowerCase());

function callCenterChannel(centerSet, wanted) {
  const report = centerSet?.report;
  if (!report) return { available: false };
  const o = report.overview;
  const reached = report.contactTypes.reduce((sum, row) => sum + row.calls, 0) || o.calls;
  const supporters = named(report.contactTypes, /^supporter/i);
  const here = wanted ? report.byLga[wanted] || { calls: 0, unique: 0, wards: 0 } : null;
  const themes = (wanted
    ? Object.entries(report.issues.byLga[wanted] || {}).map(([id, calls]) => ({ id, label: themeLabel(id), calls }))
    : report.issues.themes).filter((row) => !HIDDEN_THEMES.has(row.id)).sort((a, b) => b.calls - a.calls);
  const requests = (report.requests?.themes || []).filter((row) => !HIDDEN_THEMES.has(row.id));
  const top = (rows, count = 6) => rows.filter((row) => row.name && !/not recorded/i.test(row.name)).sort((a, b) => b.calls - a.calls).slice(0, count).map((row) => ({ name: row.name, calls: row.calls }));
  return {
    available: true,
    period: report.period,
    scope: wanted ? 'lga' : 'state',
    calls: here ? here.calls : o.calls,
    people: here ? here.unique : o.uniqueContacts,
    supporters: wanted ? null : { count: supporters, share: share(supporters, reached) },
    open: wanted ? null : o.open,
    followUp: wanted ? null : report.requests?.followUp || 0,
    perDay: report.perDay.slice(-7).map((row) => ({ date: row.date, calls: row.calls })),
    detail: {
      themes: themes.slice(0, 8),
      themeUnit: wanted ? 'issue reports' : 'calls',
      requests: wanted ? [] : requests.slice(0, 6),
      byLga: Object.entries(report.byLga).map(([name, row]) => ({ lga: name, name: lgaLabel(name), calls: row.calls, wards: row.wards })).sort((a, b) => b.calls - a.calls).slice(0, 10),
      contactTypes: top(report.contactTypes),
      categories: top(report.categories),
      informationRequests: top(report.informationRequests || []),
      lgasCalled: Object.values(report.byLga).filter((row) => row.calls > 0).length,
      wardsReached: here ? here.wards : Object.values(report.byLga).reduce((sum, row) => sum + row.wards, 0),
      inbound: wanted ? null : o.inbound,
      outbound: wanted ? null : o.outbound,
      partyDisputes: wanted ? null : report.issues.themes.find((row) => row.id === 'party')?.calls || 0,
    },
  };
}

function fieldChannel(survey, analysis, wanted) {
  if (!survey) return { available: false };
  const read = createSurveyReader(survey);
  const rows = wanted ? survey.rows.filter((row) => matchLga(read.value(row, 'lga')) === wanted) : survey.rows;
  // Sen. Alli's share of named choices, per LGA.
  const byLga = new Map();
  for (const row of survey.rows) {
    const lga = matchLga(read.value(row, 'lga'));
    if (!lga) continue;
    if (!byLga.has(lga)) byLga.set(lga, { answers: 0, named: 0, focus: 0 });
    const bucket = byLga.get(lga);
    bucket.answers += 1;
    const choice = read.value(row, 'firstChoice');
    if (!choice) continue;
    bucket.named += 1;
    if (FOCUS_PATTERN.test(choice)) bucket.focus += 1;
  }
  const lgas = [...byLga.entries()].map(([lga, row]) => ({ lga, name: lgaLabel(lga), answers: row.answers, named: row.named, share: row.named >= MIN_NAMED ? share(row.focus, row.named) : null }));
  const placed = lgas.filter((row) => row.share != null).sort((a, b) => a.share - b.share);
  const question = (id) => analysis.questions.find((item) => item.id === id);
  const answers = (id, count = 5) => (question(id)?.rows || []).filter((row) => row.field).sort((a, b) => b.field - a.field).slice(0, count).map((row) => ({ name: row.name, share: row.field }));
  return {
    available: true,
    label: '10x field work',
    responses: rows.length,
    collectors: survey.agentCount || null,
    focusShare: analysis.intention.field.share,
    undecided: analysis.intention.field.undecided,
    topIssues: answers('topIssue', 5),
    detail: {
      weakest: wanted ? [] : placed.slice(0, 5),
      strongest: wanted ? [] : [...placed].reverse().slice(0, 5),
      thin: wanted ? [] : lgas.filter((row) => row.answers < MIN_NAMED).sort((a, b) => a.answers - b.answers).map((row) => row.name),
      lgaProblem: answers('lgaProblem'),
      satisfaction: answers('satisfaction'),
      platform: answers('platform'),
      barrier: answers('barrier'),
      candidateFactor: answers('candidateFactor'),
      byLga: [...lgas].sort((a, b) => b.answers - a.answers).slice(0, 10),
    },
  };
}

/** What the online report tells the campaign to do, in plain sentences. */
function onlineFeedback(online) {
  const out = [];
  const us = online.subjects.us;
  const s = online.sentiment;
  const e = online.emotion;
  if (s.us.neutral >= 50) out.push({ tone: 'watch', text: `${s.us.neutral}% of mentions of ${us} are neutral: most of the talk is news and sharing, not persuasion. There is room to win people over.` });
  if (e.us.anger >= 30) out.push({ tone: 'risk', text: `Anger is the main feeling (${e.us.anger}%), driven by ${online.negativeTopic}. Answer with his delivery record, not with more argument.` });
  if (s.rival.positive > s.us.positive) out.push({ tone: 'risk', text: `${online.subjects.rival} is talked about less (${fmt(online.totals.mentions.rival)} vs ${fmt(online.totals.mentions.us)} mentions) but more warmly: ${s.rival.positive}% positive against ${s.us.positive}% for ${us}.` });
  const bigVoices = online.voices.filter((voice) => voice.sentiment !== 'negative').slice(0, 2);
  if (bigVoices.length) out.push({ tone: 'good', text: `Most of ${us}'s reach comes from large accounts the campaign does not run (${bigVoices.map((voice) => voice.name).join(', ')}). Brief them with facts and visuals.` });
  const ours = online.hashtags.filter((tag) => tag.side === 'us');
  if (ours[0]) out.push({ tone: 'watch', text: `${ours[0].tag} carries the campaign online (${ours[0].count} uses); the others are small. Put one hashtag on every post.` });
  if (online.activity?.busiest?.length) out.push({ tone: 'good', text: `Best times to post: ${list(online.activity.busiest.map((slot) => slot.when))}. Quietest: ${online.activity.quietest}.` });
  return out;
}

function onlineChannel(online) {
  if (!online) return { available: false };
  return { available: true, ...online, feedback: onlineFeedback(online) };
}

/** The few things to act on now, from all three channels, most serious first. */
function critical({ callCenter, field, online }) {
  const out = [];
  const add = (tone, source, text) => out.push({ tone, source, text });
  if (callCenter.available && callCenter.scope === 'state') {
    if (callCenter.open) add('risk', 'Call center', `${fmt(callCenter.open)} calls (${pct(share(callCenter.open, callCenter.calls))}) are still open${callCenter.followUp ? ` and ${fmt(callCenter.followUp)} callers asked for a follow-up` : ''}. Close these before the next outreach round.`);
    const asks = (callCenter.detail.requests.length ? callCenter.detail.requests : callCenter.detail.themes).filter((row) => row.id !== 'party').slice(0, 3);
    if (asks.length) add('watch', 'Call center', `Callers most often raise ${list(asks.map((row) => `${lower(row.label)} (${fmt(row.calls)})`))}.`);
    if (callCenter.detail.partyDisputes) add('risk', 'Call center', `${fmt(callCenter.detail.partyDisputes)} calls reported party unity or leadership disputes. Refer them to the LGA coordinators.`);
  } else if (callCenter.available && callCenter.detail.themes[0]) {
    add('watch', 'Call center', `${fmt(callCenter.calls)} calls from here; callers raise ${list(callCenter.detail.themes.slice(0, 3).map((row) => lower(row.label)))} most.`);
  }
  if (field.available) {
    const weak = field.detail.weakest.filter((row) => row.share < 0.2).slice(0, 3);
    if (weak.length) add('risk', '10x field work', `Sen. Alli is weakest in ${list(weak.map((row) => `${row.name} (${pct(row.share)})`))}, as a share of people who named a candidate.`);
    if (field.topIssues[0]) add('watch', '10x field work', `${sentence(field.topIssues[0].name)} is the top issue in the field (${pct(field.topIssues[0].share)} of answers)${field.topIssues[1] ? `, then ${lower(field.topIssues[1].name)} (${pct(field.topIssues[1].share)})` : ''}.`);
    if (field.detail.thin.length) add('watch', '10x field work', `Fewer than ${MIN_NAMED} field answers in ${list(field.detail.thin.slice(0, 4))}${field.detail.thin.length > 4 ? ` and ${field.detail.thin.length - 4} more` : ''}: send 10x teams there.`);
  }
  if (online.available) {
    add('risk', 'Online', `Anger is ${online.emotion.us.anger}% of the feeling in ${online.subjects.us}'s mentions and negative mentions rose ${online.sentiment.change.negative}% on the week before (${online.period.label}).`);
  }
  const order = { risk: 0, watch: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

export function buildChannels({ survey = null, centerSet = null, online = null, analysis, lga = '' }) {
  const wanted = lga ? matchLga(lga) : '';
  const callCenter = callCenterChannel(centerSet, wanted);
  const field = fieldChannel(survey, analysis, wanted);
  const onlineView = onlineChannel(online);
  return { callCenter, field, online: onlineView, critical: critical({ callCenter, field, online: onlineView }) };
}
