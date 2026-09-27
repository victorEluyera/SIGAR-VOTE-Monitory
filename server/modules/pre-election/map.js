import { analyzeSurvey, createSurveyReader, lgaKey as surveyLgaKey } from '../voter-survey/analysis.js';
import { themeLabel } from './contact-center.js';
import { STATE_BASELINE } from './pulse.js';
import { lgaResults2023, oyoGeo, presFromUnits, wardResolver } from './geo.js';
import { lgaLabel, matchLga, oyoLgas } from './lga.js';

/**
 * The sentiment map: every layer the pre-election data can show, for all 33 LGAs, the wards of
 * one LGA, or the polling units of one ward, plus "where to act" and findings for that view.
 *
 * Levels and what each layer can show there:
 *   LGA   everything: register (voters, age, gender, occupation…), ground, outreach, undecided
 *         (survey), 2023 governorship and presidential
 *   ward  register, APC confirmed members, 10x volunteers, polling units reached, calls, 2023
 *         presidential; the survey and caller needs exist only per LGA, so they come as context
 *   PU    register, APC confirmed members, 10x volunteers, 2023 presidential result
 *
 * Register figures come from the voter register's own records (built-in data, counts only).
 * 10x volunteers come live from the oyo10x platform and read "not connected" without it.
 */

const ALL_LEVELS = ['lga', 'ward', 'pu'];
export const LAYERS = {
  population: { label: 'Population', group: 'Register', levels: ['lga'], format: 'count' },
  registered: { label: 'Registered voters', group: 'Register', levels: ALL_LEVELS, format: 'count' },
  pvc: { label: 'PVCs collected', group: 'Register', levels: ['lga'], format: 'count' },
  // Who is on the voter register, from its own records (age at 1 Jan 2027).
  women: { label: 'Women', group: 'Register', levels: ALL_LEVELS, format: 'share' },
  youth: { label: 'Aged 18–34', group: 'Register', levels: ALL_LEVELS, format: 'share' },
  middleAge: { label: 'Aged 35–54', group: 'Register', levels: ALL_LEVELS, format: 'share' },
  older: { label: 'Aged 55+', group: 'Register', levels: ALL_LEVELS, format: 'share' },
  occupation: { label: 'Main occupation', group: 'Register', levels: ALL_LEVELS, format: 'category' },
  phone: { label: 'Phone on file', group: 'Register', levels: ALL_LEVELS, format: 'share' },
  disability: { label: 'With a disability', group: 'Register', levels: ALL_LEVELS, format: 'count' },
  members: { label: 'APC confirmed members', group: 'Ground', levels: ALL_LEVELS, format: 'count' },
  tenx: { label: '10x volunteers', group: 'Ground', levels: ALL_LEVELS, format: 'count', source: 'oyo10x' },
  reached: { label: 'Polling units reached', group: 'Ground', levels: ['lga', 'ward'], format: 'share' },
  contacts: { label: 'Contacts', group: 'Ground', levels: ['lga'], format: 'count' },
  calls: { label: 'Call center reached', group: 'Outreach', levels: ['lga', 'ward'], format: 'count' },
  needs: { label: 'Needs', group: 'Outreach', levels: ['lga'], format: 'category' },
  undecided: { label: 'Undecided', group: 'Opinion', levels: ['lga'], format: 'share' },
  gov2023: { label: '2023 Governorship', group: 'History', levels: ['lga'], format: 'share' },
  pres2023: { label: '2023 Presidential', group: 'History', levels: ALL_LEVELS, format: 'share' },
};
// "Colour by" options that compare two layers.
export const COMPARISONS = {
  membersPerPu: { label: 'APC confirmed members per polling unit', needs: ['members'], levels: ['lga', 'ward'] },
  callsPer1k: { label: 'Calls per 1,000 registered voters', needs: ['calls', 'registered'], levels: ['lga', 'ward'] },
};

export const OCCUPATIONS = { trading: 'Trading', student: 'Students', artisan: 'Artisans', business: 'Business', farming: 'Farming & fishing', public: 'Civil & public service', homemaker: 'Homemakers', other: 'Other' };

/** Map values and card detail for one area's register totals ({ v, f, a, o, d, p }), or nulls. */
function registerFigures(stats, bands) {
  if (!stats?.v) return { values: { women: null, youth: null, middleAge: null, older: null, occupation: null, phone: null, disability: null }, detail: null };
  const age = (from, to) => stats.a.slice(from, to).reduce((sum, count) => sum + count, 0);
  const occupations = Object.entries(stats.o).sort((a, b) => b[1] - a[1]);
  const main = occupations.find(([id]) => id !== 'other')?.[0] || null;
  return {
    values: {
      women: share(stats.f, stats.v),
      youth: share(age(0, 2), stats.v),
      middleAge: share(age(2, 4), stats.v),
      older: share(age(4, 6), stats.v),
      occupation: main,
      phone: share(stats.p, stats.v),
      disability: stats.d,
    },
    detail: {
      voters: stats.v,
      women: share(stats.f, stats.v),
      ages: bands.map((label, i) => ({ label, share: share(stats.a[i], stats.v) })),
      occupations: occupations.slice(0, 5).map(([id, count]) => ({ id, label: OCCUPATIONS[id] || id, share: share(count, stats.v) })),
      disability: stats.d,
      phone: share(stats.p, stats.v),
    },
  };
}

/**
 * 10x volunteers per area from the oyo10x snapshot (aggregate counts only). null when oyo10x is
 * not connected, so the layer reads "not connected" rather than zero.
 */
function tenxCounts(tenx) {
  if (!tenx) return null;
  const byLga = new Map();
  const byWard = new Map();
  const byUnit = new Map();
  for (const row of tenx.byLga || []) {
    const lga = matchLga(row.name);
    if (lga) byLga.set(lga, (byLga.get(lga) || 0) + row.members);
  }
  for (const row of tenx.byWard || []) {
    const lga = matchLga(row.lga);
    if (!lga) continue;
    const ward = wardResolver(lga)(row.name);
    if (ward) byWard.set(`${lga}|${ward.number}`, (byWard.get(`${lga}|${ward.number}`) || 0) + row.members);
  }
  for (const row of tenx.byPollingUnit || []) {
    const lga = matchLga(row.lga);
    if (!lga) continue;
    const ward = wardResolver(lga)(row.ward);
    const number = ward?.units.find((unit) => String(unit.number) === String(Number(row.code ?? row.name)) || unit.name.toLowerCase() === String(row.name).toLowerCase())?.number;
    if (ward && number !== undefined) byUnit.set(`${lga}|${ward.number}|${number}`, (byUnit.get(`${lga}|${ward.number}|${number}`) || 0) + row.members);
  }
  return { byLga, byWard, byUnit, total: tenx.totals?.registered ?? null };
}

const MIN_NAMED = 30;
const round = (value, digits = 4) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const share = (part, whole) => (whole > 0 && part != null ? round(part / whole) : null);
const pct = (value) => `${Math.round(value * 100)}%`;
const pts = (value) => `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value * 100))} pts`;
const fmt = (value) => Number(value || 0).toLocaleString('en-US');
const latest = (items) => [...items].sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0] || null;

/** People (deduplicated) per area key from member records placed by `place`. */
function tallyMembers(memberSets, place) {
  const areas = new Map();
  let unplaced = 0;
  for (const set of memberSets) {
    for (const record of set.records) {
      const key = place(record);
      if (key === undefined) continue; // outside this view
      if (key === null) { unplaced += 1; continue; }
      if (!areas.has(key)) areas.set(key, { all: new Set(), units: new Set() });
      const area = areas.get(key);
      area.all.add(record[3]);
      if (record[2]) area.units.add(`${record[1]}|${record[2]}`);
    }
  }
  return { areas, unplaced };
}

function surveyByLga(survey) {
  if (!survey) return new Map();
  const analysis = analyzeSurvey(survey);
  return new Map(analysis.byLga.map((row) => [matchLga(row.lga), row]).filter(([key]) => key));
}

// Survey answers that name a need, in the same themes as the contact center's callers.
const SURVEY_NEED_THEMES = {
  'roads & infrastructure': 'roads', 'poor roads': 'roads', security: 'security', insecurity: 'security',
  agriculture: 'agriculture', 'job creation': 'jobs', unemployment: 'jobs', 'youth development': 'jobs', 'lack of business support': 'jobs',
  'power/energy': 'electricity', education: 'education', 'poor schooling conditions': 'education',
  'health care': 'health', 'health facility challenges': 'health', 'waste management': 'sanitation',
};

/** Per LGA: how often each need theme comes up in the survey (top issue + biggest LGA problem). */
function surveyNeeds(survey) {
  const out = new Map();
  if (!survey) return out;
  const read = createSurveyReader(survey);
  for (const row of survey.rows) {
    const lga = matchLga(read.value(row, 'lga'));
    if (!lga) continue;
    if (!out.has(lga)) out.set(lga, { answers: 0, themes: {} });
    const bucket = out.get(lga);
    for (const field of ['topIssue', 'lgaProblem']) {
      const theme = SURVEY_NEED_THEMES[String(read.value(row, field)).trim().toLowerCase()];
      if (!theme) continue;
      bucket.answers += 1;
      bucket.themes[theme] = (bucket.themes[theme] || 0) + 1;
    }
  }
  return out;
}

/** Needs from both sources, each as a share of its own answers, averaged where both exist. */
function combineNeeds(fromSurvey, fromCallers) {
  const callerTotal = Object.values(fromCallers || {}).reduce((sum, value) => sum + value, 0);
  const ids = new Set([...Object.keys(fromSurvey?.answers >= 20 ? fromSurvey.themes : {}), ...Object.keys(fromCallers || {})].filter((id) => !['other', 'assistance', 'appreciation', 'party', 'campaign'].includes(id)));
  return [...ids].map((id) => {
    const surveyShare = fromSurvey?.answers >= 20 ? (fromSurvey.themes[id] || 0) / fromSurvey.answers : null;
    const callerShare = callerTotal ? (fromCallers[id] || 0) / callerTotal : null;
    const parts = [surveyShare, callerShare].filter((value) => value != null);
    return { id, label: themeLabel(id), score: round(parts.reduce((sum, value) => sum + value, 0) / parts.length), survey: round(surveyShare), callers: fromCallers?.[id] || 0 };
  }).sort((a, b) => b.score - a.score);
}

function lgaView({ memberSets, contactSet, centerSet, reference, survey, register, tenx }) {
  const results = lgaResults2023();
  const geo = oyoGeo();
  const surveyRows = surveyByLga(survey);
  const { areas } = tallyMembers(memberSets, (record) => record[0]);
  const report = centerSet?.report;
  const needsSurvey = surveyNeeds(survey);
  // Registered voters per LGA: uploaded reference, else the voter register, else the INEC PU register.
  // The state total is the sum of the same figures, so population shares always add up.
  const registeredOf = (name) => reference?.values?.[name]?.registeredVoters ?? register?.lgas?.[name]?.s.v ?? geo.lgas.get(name)?.registered ?? null;
  const stateRegistered = oyoLgas().reduce((sum, item) => sum + (registeredOf(item.name) || 0), 0);
  return oyoLgas().map((lga) => {
    const members = areas.get(lga.name);
    const surveyRow = surveyRows.get(lga.name);
    const readable = surveyRow && surveyRow.named >= MIN_NAMED;
    const gov = results.governorship.get(lga.name);
    const pres = results.presidential.get(lga.name);
    const ref = reference?.values?.[lga.name] || {};
    const geoLga = geo.lgas.get(lga.name);
    const needs = combineNeeds(needsSurvey.get(lga.name), report?.issues?.byLga?.[lga.name]);
    const support = readable ? surveyRow.focusShare : null;
    const pollingUnits = geoLga?.pollingUnits || lga.pollingUnits;
    const voterRegister = registerFigures(register?.lgas?.[lga.name]?.s, register?.bands || []);
    const registered = registeredOf(lga.name);
    const values = {
      // Uploaded NPC figure when there is one; otherwise the state projection shared out by each
      // LGA's share of registered voters (flagged as an estimate in the detail).
      population: ref.population ?? (registered && stateRegistered ? Math.round(STATE_BASELINE.population.value * (registered / stateRegistered)) : null),
      registered,
      pvc: ref.pvcCollected ?? null,
      ...voterRegister.values,
      members: members ? members.all.size : 0,
      tenx: tenx ? tenx.byLga.get(lga.name) || 0 : null,
      reached: share(Math.min(members?.units.size || 0, pollingUnits), pollingUnits),
      contacts: contactSet ? contactSet.counts[lga.name] || 0 : null,
      calls: report ? report.byLga[lga.name]?.calls || 0 : null,
      needs: needs[0]?.id || null,
      support,
      undecided: surveyRow && surveyRow.responses >= MIN_NAMED ? share(surveyRow.responses - surveyRow.named, surveyRow.responses) : null,
      gov2023: gov?.apc ?? null,
      pres2023: pres?.apc ?? null,
    };
    values.changeGov = support != null && values.gov2023 != null ? round(support - values.gov2023) : null;
    values.changePres = support != null && values.pres2023 != null ? round(support - values.pres2023) : null;
    values.membersPerPu = round(values.members / Math.max(pollingUnits, 1), 2);
    values.callsPer1k = values.calls != null && registered ? round((values.calls / registered) * 1000, 2) : null;
    return {
      key: lga.name,
      name: lgaLabel(lga.name),
      pollingUnits,
      wards: geoLga?.wardList.length || lga.wards,
      unitsWithMember: Math.min(members?.units.size || 0, pollingUnits),
      values,
      detail: {
        survey: surveyRow ? { responses: surveyRow.responses, named: surveyRow.named, leader: surveyRow.leader, leaderShare: surveyRow.leaderShare } : null,
        gov2023: gov ? { winner: gov.winner, apc: gov.apc, pdp: gov.pdp, total: gov.total } : null,
        pres2023: pres ? { winner: pres.winner, apc: pres.apc, pdp: pres.pdp, total: pres.total } : null,
        needs: needs.slice(0, 5),
        populationEstimated: ref.population == null,
        callWards: report?.byLga[lga.name]?.wards ?? null,
        register: voterRegister.detail,
      },
    };
  });
}

function wardView({ lga, memberSets, centerSet, register: voterRegister, tenx }) {
  const registerWards = voterRegister?.lgas?.[lga]?.wards || {};
  const register = oyoGeo().lgas.get(lga);
  if (!register) return { rows: [], unplaced: 0 };
  const resolve = wardResolver(lga);
  const { areas, unplaced } = tallyMembers(memberSets, (record) => (record[0] !== lga ? undefined : resolve(record[1])?.number ?? null));
  // Units are counted per ward number so "WARD 3|4" and "AGUODO WARD 03|4" are the same unit.
  const unitSets = new Map();
  for (const set of memberSets) for (const record of set.records) {
    if (record[0] !== lga || !record[2]) continue;
    const ward = resolve(record[1]);
    if (!ward) continue;
    if (!ward.units.some((unit) => String(unit.number) === record[2])) continue;
    if (!unitSets.has(ward.number)) unitSets.set(ward.number, new Set());
    unitSets.get(ward.number).add(record[2]);
  }
  const calls = new Map();
  let callsUnplaced = 0;
  for (const row of centerSet?.report?.byWard || []) {
    if (row.lga !== lga) continue;
    const ward = resolve(row.ward);
    if (!ward) { callsUnplaced += row.calls; continue; }
    calls.set(ward.number, (calls.get(ward.number) || 0) + row.calls);
  }
  const rows = register.wardList.map((ward) => {
    const members = areas.get(ward.number);
    const pres = presFromUnits(ward.units);
    const reachedUnits = unitSets.get(ward.number)?.size || 0;
    const stats = registerWards[ward.number]?.s;
    const figures = registerFigures(stats, voterRegister?.bands || []);
    const registered = stats?.v || ward.registered || null;
    const values = {
      registered,
      ...figures.values,
      members: members ? members.all.size : 0,
      tenx: tenx ? tenx.byWard.get(`${lga}|${ward.number}`) || 0 : null,
      reached: share(reachedUnits, ward.units.length),
      calls: centerSet ? calls.get(ward.number) || 0 : null,
      pres2023: pres?.apc ?? null,
    };
    values.membersPerPu = round(values.members / Math.max(ward.units.length, 1), 2);
    values.callsPer1k = values.calls != null && registered ? round((values.calls / registered) * 1000, 2) : null;
    return {
      key: String(ward.number),
      name: ward.name,
      code: ward.code,
      number: ward.number,
      pollingUnits: ward.units.length,
      unitsWithMember: reachedUnits,
      values,
      detail: { pres2023: pres, register: figures.detail },
    };
  });
  return { rows, unplaced, callsUnplaced };
}

function unitView({ lga, wardNumber, memberSets, register: voterRegister, tenx }) {
  const register = oyoGeo().lgas.get(lga);
  const ward = register?.wards.get(Number(wardNumber));
  if (!ward) return { rows: [], unplaced: 0, ward: null };
  const resolve = wardResolver(lga);
  const unitNumbers = new Set(ward.units.map((unit) => String(unit.number)));
  const { areas, unplaced } = tallyMembers(memberSets, (record) => {
    if (record[0] !== lga || resolve(record[1])?.number !== ward.number) return undefined;
    return unitNumbers.has(record[2]) ? record[2] : null;
  });
  const rows = ward.units.map((unit) => {
    const members = areas.get(String(unit.number));
    const pres = unit.pres ? presFromUnits([unit]) : null;
    const stats = voterRegister?.lgas?.[lga]?.wards?.[ward.number]?.units?.[unit.number];
    const figures = registerFigures(stats, voterRegister?.bands || []);
    return {
      key: String(unit.number),
      name: unit.name,
      code: unit.code,
      number: unit.number,
      values: {
        registered: stats?.v || unit.registered || null,
        ...figures.values,
        members: members ? members.all.size : 0,
        tenx: tenx ? tenx.byUnit.get(`${lga}|${ward.number}|${unit.number}`) || 0 : null,
        pres2023: pres?.apc ?? null,
      },
      detail: { accredited: unit.accredited || null, pres2023: pres, sheet: unit.status, register: figures.detail },
    };
  });
  return { rows, unplaced, ward };
}

/** 0-1: how much an area needs attention, with the reasons that drove it. */
function priority(rows, level) {
  const max = (key) => Math.max(...rows.map((row) => row.values[key] || 0), 1);
  const maxRegistered = max('registered');
  const maxCalls = Math.max(...rows.map((row) => row.values.callsPer1k || 0), 0.01);
  for (const row of rows) {
    const v = row.values;
    const parts = [];
    if (level !== 'pu') {
      if (v.reached != null) parts.push(['few polling units reached', 1 - v.reached]);
      if (v.callsPer1k != null) parts.push(['few calls for its size', 1 - Math.min(v.callsPer1k / maxCalls, 1)]);
    } else {
      parts.push(['no member here', v.members ? Math.max(0, 1 - v.members / 3) : 1]);
      if (v.pres2023 != null) parts.push(['APC lost here in 2023', v.pres2023 < 0.5 ? 1 - v.pres2023 : 0]);
    }
    const size = v.registered ? 0.5 + 0.5 * (v.registered / maxRegistered) : 0.75;
    const base = parts.length ? parts.reduce((sum, [, value]) => sum + value, 0) / parts.length : 0;
    row.values.priority = round(base * size, 3);
    row.priorityReasons = parts.filter(([, value]) => value >= 0.5).sort((a, b) => b[1] - a[1]).map(([reason]) => reason).slice(0, 3);
  }
}

function lgaInsights(rows) {
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  const changes = rows.filter((row) => row.values.changeGov != null).sort((a, b) => b.values.changeGov - a.values.changeGov);
  const gains = changes.filter((row) => row.values.changeGov >= 0.25).slice(0, 4);
  if (gains.length) add('good', `${gains.map((row) => row.name).join(', ')} moved hardest toward Sen. Alli (${gains.map((row) => pts(row.values.changeGov)).join(', ')} on APC's 2023 governorship share).`);
  const drops = changes.filter((row) => row.values.changeGov <= -0.1).reverse().slice(0, 4);
  if (drops.length) add('risk', `Sen. Alli polls below APC's 2023 governorship share in ${drops.map((row) => `${row.name} (${pts(row.values.changeGov)})`).join(', ')}.`);
  const blind = rows.filter((row) => row.values.support == null && !row.values.calls).sort((a, b) => (b.values.registered || 0) - (a.values.registered || 0));
  if (blind.length) add('risk', `No readable survey and no calls in ${blind.slice(0, 4).map((row) => `${row.name}${row.values.gov2023 != null ? ` (APC ${pct(row.values.gov2023)} in 2023)` : ''}`).join(', ')}: blind spots.`);
  const heavy = rows.filter((row) => row.values.support != null && row.values.gov2023 != null && row.values.support < row.values.gov2023 && (row.values.members >= 400 || (row.values.calls || 0) >= 60));
  if (heavy.length) add('risk', `${heavy.map((row) => row.name).join(', ')} ${heavy.length === 1 ? 'has' : 'have'} ${fmt(heavy.reduce((sum, row) => sum + row.values.members, 0))} members and ${fmt(heavy.reduce((sum, row) => sum + (row.values.calls || 0), 0))} calls, yet Sen. Alli polls below APC's 2023 share there: the ground work is not yet moving opinion.`);
  const silent = rows.filter((row) => row.values.members > 0 && row.values.calls === 0).sort((a, b) => b.values.members - a.values.members);
  if (silent.length) add('risk', `${silent.length} LGA${silent.length === 1 ? ' has' : 's have'} members but no contact-center calls: ${silent.slice(0, 4).map((row) => `${row.name} (${fmt(row.values.members)})`).join(', ')}.`);
  const apcWon = rows.filter((row) => row.detail.gov2023?.winner === 'APC').map((row) => row.name);
  if (apcWon.length) add('watch', `APC won only ${apcWon.join(' and ')} in the 2023 governorship.`);
  const thin = rows.filter((row) => row.values.registered && row.values.members / row.values.registered < 0.001).sort((a, b) => b.values.registered - a.values.registered);
  if (thin.length) add('watch', `Fewer than 1 member per 1,000 voters in ${thin.slice(0, 4).map((row) => `${row.name} (${fmt(row.values.registered)} voters)`).join(', ')}.`);
  return out;
}

function wardInsights(rows, { lgaName, unplaced, callsUnplaced, lgaRow }) {
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  const empty = rows.filter((row) => !row.values.members);
  if (empty.length) add('risk', `${empty.length} of ${rows.length} wards in ${lgaName} have no members: ${empty.slice(0, 5).map((row) => row.name).join(', ')}.`);
  const called = rows.filter((row) => row.values.calls != null);
  if (called.length) {
    const quiet = rows.filter((row) => row.values.members >= 20 && (row.values.calls || 0) <= 2).sort((a, b) => b.values.members - a.values.members);
    if (quiet.length) add('watch', `Members but almost no calls in ${quiet.slice(0, 4).map((row) => `${row.name} (${row.values.members} members, ${row.values.calls || 0} calls)`).join(', ')}.`);
  }
  const withPres = rows.filter((row) => row.values.pres2023 != null);
  if (withPres.length) {
    const strong = [...withPres].sort((a, b) => b.values.pres2023 - a.values.pres2023)[0];
    add('info', `APC's strongest 2023 presidential ward here was ${strong.name} (${pct(strong.values.pres2023)}), with ${strong.values.members} members and ${strong.values.calls ?? 0} calls now.`);
    const lost = withPres.filter((row) => row.values.pres2023 < 0.5 && row.detail.pres2023?.winner !== 'APC');
    if (lost.length) add('watch', `APC lost ${lost.length} ward${lost.length === 1 ? '' : 's'} here in the 2023 presidential: ${lost.slice(0, 4).map((row) => `${row.name} (${row.detail.pres2023.winner} won)`).join(', ')}.`);
    if (lgaRow?.values.support != null && lgaRow.values.pres2023 != null) {
      const delta = lgaRow.values.support - lgaRow.values.pres2023;
      if (delta < -0.1) add('risk', `APC took ${pct(lgaRow.values.pres2023)} here in the 2023 presidential, but the survey puts Sen. Alli at ${pct(lgaRow.values.support)} across ${lgaName}.`);
    }
  }
  const best = [...rows].sort((a, b) => (b.values.reached || 0) - (a.values.reached || 0))[0];
  if (best?.values.reached) add('good', `${best.name} is the best-covered ward: members on ${best.unitsWithMember} of ${best.pollingUnits} polling units.`);
  if (unplaced) add('watch', `${fmt(unplaced)} member records in ${lgaName} carry a ward label that could not be matched to an INEC ward.`);
  if (callsUnplaced) add('watch', `${fmt(callsUnplaced)} calls in ${lgaName} had a ward label that could not be matched.`);
  return out;
}

function unitInsights(rows, { wardName, unplaced }) {
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  const empty = rows.filter((row) => !row.values.members).sort((a, b) => (b.values.registered || 0) - (a.values.registered || 0));
  if (empty.length) add('risk', `${empty.length} of ${rows.length} polling units in ${wardName} have no member. Largest first: ${empty.slice(0, 4).map((row) => `PU ${String(row.number).padStart(3, '0')} ${row.name} (${fmt(row.values.registered)} voters)`).join('; ')}.`);
  else add('good', `Every polling unit in ${wardName} has at least one member.`);
  const lost = rows.filter((row) => row.values.pres2023 != null && row.detail.pres2023?.winner !== 'APC');
  if (lost.length) add('watch', `APC lost ${lost.length} unit${lost.length === 1 ? '' : 's'} here in the 2023 presidential${lost.some((row) => !row.values.members) ? `, ${lost.filter((row) => !row.values.members).length} of them with no member now` : ''}.`);
  const noSheet = rows.filter((row) => row.detail.sheet === 'n').length;
  if (noSheet) add('info', `${noSheet} unit${noSheet === 1 ? ' has' : 's have'} no transcribed 2023 result sheet.`);
  if (unplaced) add('watch', `${fmt(unplaced)} members in this ward have a polling-unit number that is not in INEC's list for the ward.`);
  return out;
}

export function buildMap({ datasets = [], survey = null, lga = '', ward = '', register = null, tenx: tenxData = null }) {
  const tenx = tenxCounts(tenxData);
  const memberSets = datasets.filter((item) => item.kind === 'members');
  const contactSet = latest(datasets.filter((item) => item.kind === 'contacts'));
  const centerSet = latest(datasets.filter((item) => item.kind === 'contact-center'));
  const reference = latest(datasets.filter((item) => item.kind === 'reference'));
  const wantedLga = lga ? matchLga(lga) : '';
  const level = wantedLga && ward ? 'pu' : wantedLga ? 'ward' : 'lga';

  const lgaRows = lgaView({ memberSets, contactSet, centerSet, reference, survey, register, tenx });
  priority(lgaRows, 'lga');
  let rows = lgaRows;
  let insights = [];
  let context = null;
  let wardInfo = null;
  if (level === 'lga') insights = lgaInsights(lgaRows);
  else {
    const lgaRow = lgaRows.find((row) => row.key === wantedLga);
    context = lgaRow;
    if (level === 'ward') {
      const view = wardView({ lga: wantedLga, memberSets, centerSet, register, tenx });
      rows = view.rows;
      priority(rows, 'ward');
      insights = wardInsights(rows, { lgaName: lgaLabel(wantedLga), unplaced: view.unplaced, callsUnplaced: view.callsUnplaced, lgaRow });
    } else {
      const view = unitView({ lga: wantedLga, wardNumber: ward, memberSets, register, tenx });
      rows = view.rows;
      const wardStats = register?.lgas?.[wantedLga]?.wards?.[view.ward?.number]?.s;
      wardInfo = view.ward ? { number: view.ward.number, name: view.ward.name, code: view.ward.code, registered: wardStats?.v || view.ward.registered, pollingUnits: view.ward.units.length, register: registerFigures(wardStats, register?.bands || []).detail } : null;
      priority(rows, 'pu');
      insights = view.ward ? unitInsights(rows, { wardName: view.ward.name, unplaced: view.unplaced }) : [];
    }
  }
  const order = { risk: 0, watch: 1, good: 2, info: 3 };
  const layers = Object.fromEntries(Object.entries(LAYERS).map(([key, layer]) => [key, {
    ...layer,
    available: layer.levels.includes(level) && rows.some((row) => row.values[key] != null && row.values[key] !== 0),
    loaded: lgaRows.some((row) => row.values[key] != null && row.values[key] !== 0),
    // Why an empty layer is empty, when it is not something an upload fixes.
    ...(layer.source === 'oyo10x' ? { hint: !tenxData ? 'oyo10x is not connected to this platform yet' : 'oyo10x has not reported volunteers by area yet' } : {}),
  }]));
  return {
    level,
    lga: wantedLga ? { key: wantedLga, name: lgaLabel(wantedLga) } : null,
    ward: wardInfo,
    layers,
    comparisons: Object.fromEntries(Object.entries(COMPARISONS).filter(([, item]) => item.levels.includes(level)).map(([key, item]) => [key, { label: item.label, needs: item.needs }])),
    totals: {
      members: new Set(memberSets.flatMap((set) => set.records.map((record) => record[3]))).size,
      tenx: tenx?.total ?? null,
      contacts: contactSet ? Object.values(contactSet.counts).reduce((sum, value) => sum + value, 0) : null,
      calls: centerSet?.report?.overview.calls ?? null,
      registered: register?.total || [...oyoGeo().lgas.values()].reduce((sum, item) => sum + item.registered, 0),
    },
    context,
    rows,
    ranking: [...rows].filter((row) => row.priorityReasons?.length).sort((a, b) => b.values.priority - a.values.priority).slice(0, 6).map((row) => ({ key: row.key, name: row.name, number: row.number, priority: row.values.priority, reasons: row.priorityReasons })),
    insights: insights.sort((a, b) => order[a.tone] - order[b.tone]),
    sources: {
      history: 'INEC IReV 2023 result sheets, transcribed; incomplete where sheets were missing, so shares are indicative.',
      register: register ? register.source : oyoGeo().source,
      tenx: tenxData ? 'oyo10x platform' : 'oyo10x is not connected',
    },
  };
}

// Survey LGA keys are matched through the survey's own normaliser elsewhere; exported for tests.
export { surveyLgaKey };
