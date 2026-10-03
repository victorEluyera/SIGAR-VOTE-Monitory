import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkbook } from '../voter-survey/xlsx.js';
import { buildXlsx } from '../voter-survey/test-fixtures.js';
import { baselineRegister, baselineSurvey, withBaseline } from './baseline.js';
import { birthDateKey, buildDataset, personNameKey } from './datasets.js';
import { buildMap } from './map.js';
import { buildOverview, onlineReport } from './overview.js';
import { buildPulse } from './pulse.js';
import { buildVoterAnalysis, memberMatchKeys, uniqueTenx } from './voters.js';

const members = () => buildDataset('members', openWorkbook(buildXlsx({
  Master: [
    ['Name', 'Phone', 'Date of birth', 'LGA', 'Ward', 'Polling unit'],
    ['ADE OLU', '08060811060', '1980-01-01', 'Atiba', 'WARD 1', '1'],
    ['KEMI ADE', '07011112222', '1985-05-05', 'Atiba', 'WARD 1', '2'],
    ['SAHEED AZEEZ', '08033334444', '1990-02-02', 'Atiba', 'WARD 1', '3'],
  ],
})), { label: 'APC confirmed members' });

test('names are compared loosely: order, case, punctuation and titles do not matter', () => {
  assert.equal(personNameKey('ALH. SAHEED  AZEEZ'), personNameKey('azeez saheed'));
  assert.equal(personNameKey('Mrs Kemi Ade'), 'ade kemi');
  assert.equal(personNameKey('Kemi'), '', 'one word is not enough to match on');
  assert.equal(birthDateKey('05/05/1985'), '1985-05-05');
  assert.equal(birthDateKey('1988-6-10'), '1988-06-10');
  assert.equal(birthDateKey('not a date'), '');
});

test('a 10x volunteer is the same person by phone, by name at the same polling unit, or by name and birth date', () => {
  const list = members();
  const keys = memberMatchKeys([list]);
  const people = [
    { name: 'Someone Else', phone: '0806 081 1060', lga: 'Atiba', ward: 'WARD 1', pollingUnit: '99' }, // same phone
    { name: 'Olu Ade', phone: '08011110000', lga: 'Atiba', ward: 'OKE-AFIN 1', pollingUnit: '1' }, // same name + same polling unit
    { name: 'Alhaja Kemi Ade', dateOfBirth: '05/05/1985', phone: '08022220000', lga: 'Atiba', ward: 'WARD 1', pollingUnit: '7' }, // same name + birth date
    { name: 'Saheed Azeez', dateOfBirth: '1970-01-01', phone: '08055550000', lga: 'Atiba', ward: 'WARD 1', pollingUnit: '5' }, // a different Saheed Azeez
    { name: 'New Person', phone: '08099990001', lga: 'Ogbomosho North', ward: 'WARD 3', pollingUnit: '1' }, // new, another LGA spelling
  ];
  const result = uniqueTenx(people, keys, { level: 'lga' });
  assert.equal(result.alreadyMembers, 3);
  assert.equal(result.unique, 2, 'a shared common name alone is not a match');
  assert.equal(result.perArea.get('ATIBA'), 1);
  assert.equal(result.perArea.get('OGBOMOSO NORTH'), 1);

  const view = buildVoterAnalysis({ map: buildMap({ datasets: [list] }), memberKeys: keys, tenxPeople: people });
  assert.equal(view.summary.tenxStatus, 'checked');
  assert.equal(view.summary.apc, 3);
  assert.equal(view.summary.tenxUnique, 2);
  assert.equal(view.summary.tenxAlreadyMembers, 3);
  assert.equal(view.summary.ours, 5, 'three APC members plus two new 10x volunteers');
  const text = JSON.stringify({ view, list });
  for (const secret of ['0806', 'Saheed', 'SAHEED', '1985-05-05']) assert.equal(text.includes(secret), false, 'no names, phones or birth dates stored or returned');
});

test('without a per-person 10x feed, or without match keys, 10x volunteers are not added to our voters', () => {
  const list = members();
  const map = buildMap({ datasets: [list], tenx: { totals: { registered: 50 }, byLga: [{ name: 'Atiba', members: 50 }] } });
  const view = buildVoterAnalysis({ map, memberKeys: memberMatchKeys([list]) });
  assert.equal(view.summary.tenxStatus, 'totals-only');
  assert.equal(view.summary.tenx, 50);
  assert.equal(view.summary.ours, 3, 'only APC members until the overlap can be checked');
  assert.ok(view.insights.some((item) => /cannot be checked against APC members/.test(item.text)));

  const noKeys = buildVoterAnalysis({ map, memberKeys: new Set(), tenxPeople: [{ name: 'Ade Olu', phone: '08060811060', lga: 'Atiba' }] });
  assert.equal(noKeys.summary.tenxStatus, 'no-member-keys', 'a list without match keys would count everyone twice, so it is not used');
  assert.equal(noKeys.summary.ours, 3);
});

test('voter analysis on the built-in data: reach per area, register profile, and intelligence', () => {
  const datasets = withBaseline([]);
  const register = baselineRegister();
  const state = buildVoterAnalysis({ map: buildMap({ datasets, survey: baselineSurvey(), register }) });
  assert.equal(state.summary.registered, 3_276_307);
  assert.equal(state.summary.apc, 157_289, 'a person listed in two LGAs counts once in the state total');
  assert.equal(state.rows.length, 33);
  assert.ok(state.summary.profile.women > 0.45 && state.summary.profile.women < 0.55);
  assert.ok(state.insights.length >= 4);

  const wards = buildVoterAnalysis({ map: buildMap({ datasets, register, lga: 'Iseyin' }) });
  assert.equal(wards.level, 'ward');
  assert.equal(wards.rows.length, 11);
  const units = buildVoterAnalysis({ map: buildMap({ datasets, register, lga: 'Iseyin', ward: '4' }) });
  assert.equal(units.level, 'pu');
  assert.ok(units.rows.every((row) => row.status !== null || row.registered == null));
});

test('overview: vote intention without naming any rival, reach, call center and requests', () => {
  const datasets = withBaseline([]);
  const survey = baselineSurvey();
  const overview = buildOverview({ pulse: buildPulse({ datasets, survey }), map: buildMap({ datasets, survey, register: baselineRegister() }) });
  const text = JSON.stringify(overview);
  for (const rival of ['Hamzat', 'Adelabu', 'Ajadi', 'Ogundoyin']) assert.equal(text.includes(rival), false, `${rival} is not named`);
  const split = overview.intention.split.reduce((sum, item) => sum + item.count, 0);
  assert.equal(split, overview.intention.responses);
  assert.equal(overview.numbers.lgasReached, 33);
  assert.equal(overview.numbers.pollingUnitsReached, 5992);
  assert.equal(overview.standing.reduce((sum, band) => sum + band.lgas.length, 0), 33);
  assert.equal(overview.coverage.length, 10);
  assert.ok(overview.coverage.every((row, i, rows) => !i || rows[i - 1].share <= row.share), 'weakest coverage first');
  assert.equal(overview.intelligence.length, 5);
  assert.equal(overview.numbers.pvcUncollected, Math.round(overview.numbers.registered * (1 - overview.numbers.pvcRate)));
  assert.equal(overview.tenx.connected, false);
  assert.equal(overview.projects, null);
  assert.equal(overview.callCenter.calls, 1204);
});

test('overview: 10x promoters and projects, and the online report, feed the numbers and the five alerts', () => {
  const datasets = withBaseline([]);
  const survey = baselineSurvey();
  const tenx = { totals: { unitPromoters: 5832 }, coverage: { pollingUnits: 4210 }, projects: { total: 3, stages: { submitted: 1, notStarted: 0, ongoing: 1, completed: 1, other: 0 }, wards: 2, byLga: [{ name: 'Ibadan North', projects: 3 }] } };
  const overview = buildOverview({ pulse: buildPulse({ datasets, survey }), map: buildMap({ datasets, survey, register: baselineRegister() }), tenx, online: onlineReport(), promoterTarget: 750000 });
  assert.deepEqual(overview.tenx, { connected: true, promoters: 5832, apc10xPromoters: null, apcOverlapLoaded: false, target: 750000, pollingUnits: 4210, updatedAt: null });
  assert.equal(overview.projects.wards, 2);
  assert.equal(overview.projects.lgas, 1);
  assert.equal(overview.projects.lgasWithout.length, 32);
  const alerts = Object.fromEntries(overview.intelligence.map((item) => [item.id, item.text]));
  assert.match(alerts.projects, /^349 of 351 wards/);
  assert.match(alerts.media, /Anger is 43.6%/);
  const online = overview.online;
  for (const side of ['us', 'rival']) {
    assert.ok(Math.abs(Object.values(online.sentiment[side]).reduce((a, b) => a + b, 0) - 100) < 0.2);
    assert.ok(Math.abs(Object.values(online.emotion[side]).reduce((a, b) => a + b, 0) - 100) < 0.2);
  }
});
