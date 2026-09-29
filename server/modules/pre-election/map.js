import { analyzeSurvey, createSurveyReader, lgaKey as surveyLgaKey } from '../voter-survey/analysis.js';
import { themeLabel } from './contact-center.js';
import { STATE_BASELINE } from './pulse.js';
import { lgaResults2023, oyoGeo, presFromUnits, wardResolver } from './geo.js';
import { titleCase } from './voters.js';
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
  // Members whose record lands on a real INEC ward and polling unit (the rest carry labels that
  // match nothing in INEC's list, so they cannot be worked on the ground as they are).
  cleaned: { label: 'Cleaned party data', group: 'Ground', levels: ALL_LEVELS, format: 'count' },
  // The same person listed again (same phone, or same name in the same household and LGA).
  duplicates: { label: 'Duplicate member records', group: 'Ground', levels: ALL_LEVELS, format: 'count', note: 'Records of a person already on the list' },
  tenx: { label: '10x volunteers', group: '10x', levels: ALL_LEVELS, format: 'count', source: 'oyo10x' },
  promoters: { label: '10x PU promoters', group: '10x', levels: ALL_LEVELS, format: 'count', source: 'oyo10x' },
  reached: { label: 'Polling units reached', group: 'Ground', levels: ['lga', 'ward'], format: 'share' },
  contacts: { label: 'Contacts', group: 'Ground', levels: ['lga'], format: 'count' },
  calls: { label: 'Call center reached', group: 'Outreach', levels: ['lga', 'ward'], format: 'count' },
  needs: { label: 'Needs', group: 'Outreach', levels: ['lga'], format: 'category' },
  activePhones: { label: 'Active phone numbers (NCC)', group: 'Outreach', levels: ALL_LEVELS, format: 'count', source: 'ncc' },
  projects: { label: 'Community projects', group: '10x', levels: ALL_LEVELS, format: 'count', source: 'oyo10x' },
  projectCost: { label: 'Project cost (estimate)', group: '10x', levels: ALL_LEVELS, format: 'naira', source: 'oyo10x' },
  undecided: { label: 'Undecided', group: 'Opinion', levels: ['lga'], format: 'share' },
  gov2023: { label: '2023 Governorship', group: 'History', levels: ['lga'], format: 'share' },
  pres2023: { label: '2023 Presidential', group: 'History', levels: ALL_LEVELS, format: 'share' },
  turnout2023: { label: '2023 turnout', group: 'History', levels: ALL_LEVELS, format: 'share', note: 'Accredited voters ÷ registered voters, from the 2023 presidential result sheets' },
};
// Why a layer with no data is empty, when an upload in Manage Data is not the fix.
const SOURCE_HINTS = {
  ncc: 'Needs the NCC active-number check on our phone lists; not supplied yet',
};
// "Colour by" options that compare two layers.
export const COMPARISONS = {
  membersPerPu: { label: 'APC confirmed members per polling unit', needs: ['members'], levels: ['lga', 'ward'] },
  callsPer1k: { label: 'Calls per 1,000 registered voters', needs: ['calls', 'registered'], levels: ['lga', 'ward'] },
  cleanedPerPu: { label: 'Cleaned party data per polling unit', needs: ['cleaned'], levels: ['lga', 'ward'] },
  promotersPerPu: { label: '10x promoters per polling unit', needs: ['promoters'], levels: ['lga', 'ward'] },
  projectsPerPu: { label: 'Community projects per polling unit', needs: ['projects'], levels: ['lga', 'ward'] },
  projectCostPerPu: { label: 'Project cost per polling unit', needs: ['projectCost'], levels: ['lga', 'ward'] },
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
  const promoters = { byLga: new Map(), byWard: new Map(), byUnit: new Map() };
  const bump = (map, key, value) => map.set(key, (map.get(key) || 0) + (value || 0));
  for (const row of tenx.byLga || []) {
    const lga = matchLga(row.name);
    if (lga) { byLga.set(lga, (byLga.get(lga) || 0) + row.members); bump(promoters.byLga, lga, row.unitPromoters); }
  }
  for (const row of tenx.byWard || []) {
    const lga = matchLga(row.lga);
    if (!lga) continue;
    const ward = wardResolver(lga)(row.name);
    if (ward) { byWard.set(`${lga}|${ward.number}`, (byWard.get(`${lga}|${ward.number}`) || 0) + row.members); bump(promoters.byWard, `${lga}|${ward.number}`, row.unitPromoters); }
  }
  for (const row of tenx.byPollingUnit || []) {
    const lga = matchLga(row.lga);
    if (!lga) continue;
    const ward = wardResolver(lga)(row.ward);
    const number = ward?.units.find((unit) => String(unit.number) === String(Number(row.code ?? row.name)) || unit.name.toLowerCase() === String(row.name).toLowerCase())?.number;
    if (ward && number !== undefined) { byUnit.set(`${lga}|${ward.number}|${number}`, (byUnit.get(`${lga}|${ward.number}|${number}`) || 0) + row.members); bump(promoters.byUnit, `${lga}|${ward.number}|${number}`, row.unitPromoters); }
  }
  // Community projects per LGA and ward (10x places them by name; there is no polling unit).
  const projects = { byLga: new Map(), byWard: new Map(), byUnit: new Map(), cost: { byLga: new Map(), byWard: new Map(), byUnit: new Map() }, costed: 0 };
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
  for (const row of tenx.projects?.byWard || []) {
    const lga = matchLga(row.lga);
    if (!lga) continue;
    add(projects.byLga, lga, row.projects);
    if (row.cost) { add(projects.cost.byLga, lga, row.cost); projects.costed += 1; }
    const ward = row.ward ? wardResolver(lga)(row.ward) : null;
    if (!ward) continue;
    add(projects.byWard, `${lga}|${ward.number}`, row.projects);
    if (row.cost) add(projects.cost.byWard, `${lga}|${ward.number}`, row.cost);
  }
  // Projects tied to one polling unit, when 10x sends the unit (INEC code or number).
  for (const row of tenx.projects?.byPollingUnit || []) {
    const lga = matchLga(row.lga);
    const ward = lga ? wardResolver(lga)(row.ward) : null;
    const code = String(row.code || '').split(/[-/]/).pop();
    const number = ward?.units.find((unit) => String(unit.number) === String(Number(code || row.name)) || unit.name.toLowerCase() === String(row.name || '').toLowerCase())?.number;
    if (number === undefined) continue;
    add(projects.byUnit, `${lga}|${ward.number}|${number}`, row.projects);
    if (row.cost) add(projects.cost.byUnit, `${lga}|${ward.number}|${number}`, row.cost);
  }
  return { byLga, byWard, byUnit, promoters, projects, total: tenx.totals?.registered ?? null };
}

/** 2023 turnout over the units that have a transcribed result sheet: accredited ÷ registered. */
function turnoutOf(units) {
  const counted = units.filter((unit) => unit.accredited > 0 && unit.registered > 0);
  if (!counted.length) return null;
  return share(counted.reduce((sum, unit) => sum + unit.accredited, 0), counted.reduce((sum, unit) => sum + unit.registered, 0));
}

// Where each member record lands on INEC's map, worked out once per uploaded list: [lga, ward
// number or null, polling unit number or null, person]. Each distinct ward label goes through the
// fuzzy matcher only once.
// Per list: true for each record whose person already appeared earlier in the lists.
function duplicateFlags(memberSets) {
  const seen = new Set();
  return memberSets.map((set) => {
    const flags = set.records.map((record) => {
      const again = seen.has(record[3]);
      seen.add(record[3]);
      return again;
    });
    return flags;
  });
}
/** Duplicate records per area key from `key(record)` (undefined = outside this view). */
function tallyDuplicates(memberSets, key) {
  const flags = duplicateFlags(memberSets);
  const out = new Map();
  memberSets.forEach((set, i) => set.records.forEach((record, j) => {
    if (!flags[i][j]) return;
    const area = key(record);
    if (area === undefined || area === null) return;
    out.set(area, (out.get(area) || 0) + 1);
  }));
  return out;
}

const placedCache = new WeakMap();
function placeRecords(set) {
  if (placedCache.has(set.records)) return placedCache.get(set.records);
  const resolvers = new Map();
  const labels = new Map();
  const placed = set.records.map((record) => {
    const [lga, wardLabel, unit, person] = record;
    if (!resolvers.has(lga)) resolvers.set(lga, wardResolver(lga));
    const labelKey = `${lga}|${wardLabel}`;
    if (!labels.has(labelKey)) labels.set(labelKey, wardLabel ? resolvers.get(lga)(wardLabel) : null);
    const ward = labels.get(labelKey);
    const onUnit = ward && unit && ward.units.some((item) => String(item.number) === String(unit)) ? Number(unit) : null;
    return [lga, ward?.number ?? null, onUnit, person];
  });
  placedCache.set(set.records, placed);
  return placed;
}

/** Cleaned members (on a real INEC unit) and the units they cover, per area key from `key`. */
function tallyCleaned(memberSets, key) {
  const areas = new Map();
  for (const set of memberSets) {
    for (const [lga, ward, unit, person] of placeRecords(set)) {
      if (unit === null) continue;
      const area = key(lga, ward, unit);
      if (area === undefined) continue;
      if (!areas.has(area)) areas.set(area, { people: new Set(), units: new Set() });
      areas.get(area).people.add(person);
      areas.get(area).units.add(`${ward}|${unit}`);
    }
  }
  return areas;
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
  const cleaned = tallyCleaned(memberSets, (lga) => lga);
  const duplicates = tallyDuplicates(memberSets, (record) => record[0]);
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
    const clean = cleaned.get(lga.name);
    const unitsReached = Math.min(clean?.units.size || 0, pollingUnits);
    const values = {
      // Uploaded NPC figure when there is one; otherwise the state projection shared out by each
      // LGA's share of registered voters (flagged as an estimate in the detail).
      population: ref.population ?? (registered && stateRegistered ? Math.round(STATE_BASELINE.population.value * (registered / stateRegistered)) : null),
      registered,
      pvc: ref.pvcCollected ?? null,
      ...voterRegister.values,
      members: members ? members.all.size : 0,
      cleaned: clean?.people.size || 0,
      duplicates: memberSets.length ? duplicates.get(lga.name) || 0 : null,
      tenx: tenx ? tenx.byLga.get(lga.name) || 0 : null,
      promoters: tenx ? tenx.promoters.byLga.get(lga.name) || 0 : null,
      // Reached = polling units with a member placed on a real INEC unit, as in the Pulse.
      reached: share(unitsReached, pollingUnits),
      activePhones: null,
      projects: tenx ? tenx.projects.byLga.get(lga.name) || 0 : null,
      projectCost: tenx?.projects.costed ? tenx.projects.cost.byLga.get(lga.name) || 0 : null,
      contacts: contactSet ? contactSet.counts[lga.name] || 0 : null,
      calls: report ? report.byLga[lga.name]?.calls || 0 : null,
      needs: needs[0]?.id || null,
      support,
      undecided: surveyRow && surveyRow.responses >= MIN_NAMED ? share(surveyRow.responses - surveyRow.named, surveyRow.responses) : null,
      gov2023: gov?.apc ?? null,
      pres2023: pres?.apc ?? null,
      turnout2023: geoLga ? turnoutOf(geoLga.wardList.flatMap((ward) => ward.units)) : null,
    };
    values.changeGov = support != null && values.gov2023 != null ? round(support - values.gov2023) : null;
    values.changePres = support != null && values.pres2023 != null ? round(support - values.pres2023) : null;
    values.membersPerPu = round(values.members / Math.max(pollingUnits, 1), 2);
    values.callsPer1k = values.calls != null && registered ? round((values.calls / registered) * 1000, 2) : null;
    values.cleanedPerPu = round(values.cleaned / Math.max(pollingUnits, 1), 2);
    values.promotersPerPu = values.promoters != null ? round(values.promoters / Math.max(pollingUnits, 1), 2) : null;
    values.projectsPerPu = values.projects != null ? round(values.projects / Math.max(pollingUnits, 1), 3) : null;
    values.projectCostPerPu = values.projectCost != null ? round(values.projectCost / Math.max(pollingUnits, 1), 0) : null;
    return {
      key: lga.name,
      name: lgaLabel(lga.name),
      pollingUnits,
      wards: geoLga?.wardList.length || lga.wards,
      unitsWithMember: unitsReached,
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
  const cleaned = tallyCleaned(memberSets, (recordLga, ward) => (recordLga === lga ? ward : undefined));
  const duplicates = tallyDuplicates(memberSets, (record) => (record[0] === lga ? resolve(record[1])?.number ?? null : undefined));
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
      cleaned: cleaned.get(ward.number)?.people.size || 0,
      duplicates: memberSets.length ? duplicates.get(ward.number) || 0 : null,
      tenx: tenx ? tenx.byWard.get(`${lga}|${ward.number}`) || 0 : null,
      promoters: tenx ? tenx.promoters.byWard.get(`${lga}|${ward.number}`) || 0 : null,
      reached: share(reachedUnits, ward.units.length),
      calls: centerSet ? calls.get(ward.number) || 0 : null,
      activePhones: null,
      projects: tenx ? tenx.projects.byWard.get(`${lga}|${ward.number}`) || 0 : null,
      projectCost: tenx?.projects.costed ? tenx.projects.cost.byWard.get(`${lga}|${ward.number}`) || 0 : null,
      pres2023: pres?.apc ?? null,
      turnout2023: turnoutOf(ward.units),
    };
    values.membersPerPu = round(values.members / Math.max(ward.units.length, 1), 2);
    values.callsPer1k = values.calls != null && registered ? round((values.calls / registered) * 1000, 2) : null;
    values.cleanedPerPu = round(values.cleaned / Math.max(ward.units.length, 1), 2);
    values.promotersPerPu = values.promoters != null ? round(values.promoters / Math.max(ward.units.length, 1), 2) : null;
    values.projectsPerPu = values.projects != null ? round(values.projects / Math.max(ward.units.length, 1), 3) : null;
    values.projectCostPerPu = values.projectCost != null ? round(values.projectCost / Math.max(ward.units.length, 1), 0) : null;
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
  const duplicates = tallyDuplicates(memberSets, (record) => (record[0] === lga && resolve(record[1])?.number === ward.number && unitNumbers.has(record[2]) ? record[2] : undefined));
  const rows = ward.units.map((unit) => {
    const members = areas.get(String(unit.number));
    const unitKey = `${lga}|${ward.number}|${unit.number}`;
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
        cleaned: members ? members.all.size : 0,
        duplicates: memberSets.length ? duplicates.get(String(unit.number)) || 0 : null,
        tenx: tenx ? tenx.byUnit.get(unitKey) || 0 : null,
        promoters: tenx ? tenx.promoters.byUnit.get(unitKey) || 0 : null,
        projects: tenx ? tenx.projects.byUnit.get(unitKey) || 0 : null,
        projectCost: tenx?.projects.costed ? tenx.projects.cost.byUnit.get(unitKey) || 0 : null,
        activePhones: null,
        pres2023: pres?.apc ?? null,
        turnout2023: turnoutOf([unit]),
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

/**
 * Critical alerts for the level on screen: high, medium or low, most serious first. Each names one
 * place and says why in a few words, so the panel reads like a to-do list.
 */
function buildAlerts({ level, rows: areaRows, tenx, place }) {
  const out = [];
  // INEC writes ward and unit names in capitals; alerts read better in title case.
  const rows = level === 'lga' ? areaRows : areaRows.map((row) => ({ ...row, name: titleCase(row.name) }));
  const more = (count, unit) => `${count} more ${unit}${count === 1 ? '' : 's'}`;
  const add = (severity, title, detail) => out.push({ severity, title, detail });
  const byLargest = (list) => [...list].sort((a, b) => (b.values.registered || 0) - (a.values.registered || 0));
  const pu = (row) => `PU ${String(row.number).padStart(3, '0')}`;
  if (level !== 'pu') {
    const unit = level === 'lga' ? 'LGA' : 'ward';
    const membership = rows.filter((row) => row.values.registered).map((row) => ({ row, share: row.values.members / row.values.registered })).sort((a, b) => a.share - b.share);
    if (membership[0]) add('high', `Low APC membership in ${membership[0].row.name}`, `Only ${(membership[0].share * 100).toFixed(1)}% of registered voters are members`);
    const unreached = rows.map((row) => ({ row, gap: (row.pollingUnits || 0) - (row.unitsWithMember || 0) })).filter((item) => item.gap > 0).sort((a, b) => b.gap - a.gap);
    if (unreached[0]) add('high', `Unreached polling units in ${unreached[0].row.name}`, `${fmt(unreached[0].gap)} of ${fmt(unreached[0].row.pollingUnits)} polling units not yet reached`);
    const low = rows.filter((row) => row.values.support != null && row.values.support < 0.2).sort((a, b) => a.values.support - b.values.support);
    if (low[0]) add('high', `Low support in ${low[0].name}`, `Sen. Alli has ${pct(low[0].values.support)} of named choices in the survey`);
    const empty = rows.filter((row) => !row.values.members);
    if (empty.length) add('high', `${empty.length} ${unit}${empty.length === 1 ? '' : 's'} with no member`, byLargest(empty).slice(0, 3).map((row) => row.name).join(', '));
    const silent = byLargest(rows.filter((row) => row.values.calls === 0));
    if (silent.length) add('medium', `No call-center calls in ${silent[0].name}`, `${fmt(silent[0].values.registered)} registered voters${silent.length > 1 ? ` · ${more(silent.length - 1, unit)} with none` : ''}`);
    const dupes = rows.filter((row) => row.values.duplicates > 0).sort((a, b) => b.values.duplicates - a.values.duplicates);
    if (dupes[0]) add('medium', `Duplicate member records in ${dupes[0].name}`, `${fmt(dupes[0].values.duplicates)} records repeat a person already listed`);
    const uncleaned = rows.filter((row) => row.values.members > row.values.cleaned).map((row) => ({ row, gap: row.values.members - row.values.cleaned })).sort((a, b) => b.gap - a.gap);
    if (uncleaned[0]) add('medium', `Party data needs cleaning in ${uncleaned[0].row.name}`, `${fmt(uncleaned[0].gap)} member records do not match an INEC polling unit`);
    if (tenx) {
      const thin = rows.filter((row) => row.values.tenx != null && row.pollingUnits).sort((a, b) => a.values.tenx / a.pollingUnits - b.values.tenx / b.pollingUnits);
      if (thin[0]) add('medium', `Few 10x volunteers in ${thin[0].name}`, `${fmt(thin[0].values.tenx)} volunteers for ${fmt(thin[0].pollingUnits)} polling units`);
      const noProject = byLargest(rows.filter((row) => row.values.projects === 0));
      if (noProject.length) add('low', `No community project in ${noProject[0].name}`, noProject.length > 1 ? `and ${more(noProject.length - 1, unit)}` : 'Nothing submitted or ongoing');
    }
    const turnout = rows.filter((row) => row.values.turnout2023 != null).sort((a, b) => a.values.turnout2023 - b.values.turnout2023);
    if (turnout[0]) add('low', `Low 2023 turnout in ${turnout[0].name}`, `${pct(turnout[0].values.turnout2023)} of registered voters were accredited`);
  } else {
    const empty = byLargest(rows.filter((row) => !row.values.members));
    if (empty.length) add('high', `${empty.length} polling unit${empty.length === 1 ? '' : 's'} with no member${place ? ` in ${titleCase(place)}` : ''}`, `Largest: ${pu(empty[0])} ${empty[0].name} (${fmt(empty[0].values.registered)} voters)`);
    const lostEmpty = rows.filter((row) => row.values.pres2023 != null && row.values.pres2023 < 0.5 && !row.values.members);
    if (lostEmpty.length) add('medium', `APC lost ${lostEmpty.length} unit${lostEmpty.length === 1 ? '' : 's'} in 2023 with no member now`, lostEmpty.slice(0, 3).map(pu).join(', '));
    const turnout = rows.filter((row) => row.values.turnout2023 != null).sort((a, b) => a.values.turnout2023 - b.values.turnout2023);
    if (turnout[0]) add('low', `Lowest 2023 turnout: ${pu(turnout[0])}`, `${pct(turnout[0].values.turnout2023)} of registered voters were accredited`);
    const noSheet = rows.filter((row) => row.detail.sheet === 'n').length;
    if (noSheet) add('low', `${noSheet} unit${noSheet === 1 ? '' : 's'} without a 2023 result sheet`, 'Turnout and 2023 shares are missing there');
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 8);
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
  const alerts = buildAlerts({ level, rows, tenx, place: wardInfo?.name });
  const layers = Object.fromEntries(Object.entries(LAYERS).map(([key, layer]) => [key, {
    ...layer,
    available: layer.levels.includes(level) && rows.some((row) => row.values[key] != null && row.values[key] !== 0),
    loaded: lgaRows.some((row) => row.values[key] != null && row.values[key] !== 0),
    // Why an empty layer is empty, when it is not something an upload fixes.
    ...(layer.source === 'oyo10x' ? { hint: !tenxData ? 'oyo10x is not connected to this platform yet' : key === 'projectCost' ? '10x does not send project cost estimates yet' : key === 'projects' ? '10x has not shared community projects yet' : key === 'promoters' ? '10x has not reported promoters by area yet' : 'oyo10x has not reported volunteers by area yet' } : {}),
    ...(SOURCE_HINTS[layer.source] ? { hint: SOURCE_HINTS[layer.source] } : {}),
  }]));
  return {
    level,
    lga: wantedLga ? { key: wantedLga, name: lgaLabel(wantedLga) } : null,
    ward: wardInfo,
    layers,
    comparisons: Object.fromEntries(Object.entries(COMPARISONS).filter(([, item]) => item.levels.includes(level)).map(([key, item]) => [key, { label: item.label, needs: item.needs }])),
    totals: {
      members: new Set(memberSets.flatMap((set) => set.records.map((record) => record[3]))).size,
      cleaned: lgaRows.reduce((sum, row) => sum + row.values.cleaned, 0),
      records: memberSets.reduce((sum, set) => sum + set.records.length, 0),
      duplicates: lgaRows.reduce((sum, row) => sum + (row.values.duplicates || 0), 0),
      promoters: tenxData?.totals?.unitPromoters ?? null,
      tenx: tenx?.total ?? null,
      contacts: contactSet ? Object.values(contactSet.counts).reduce((sum, value) => sum + value, 0) : null,
      calls: centerSet?.report?.overview.calls ?? null,
      registered: register?.total || [...oyoGeo().lgas.values()].reduce((sum, item) => sum + item.registered, 0),
    },
    context,
    rows,
    alerts,
    // For the LGA and ward dropdowns.
    options: {
      lgas: lgaRows.map((row) => ({ key: row.key, name: row.name })),
      wards: wantedLga ? (oyoGeo().lgas.get(wantedLga)?.wardList || []).map((item) => ({ number: item.number, name: item.name })) : [],
    },
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
