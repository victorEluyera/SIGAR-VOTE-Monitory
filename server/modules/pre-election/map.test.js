import test from 'node:test';
import assert from 'node:assert/strict';
import { createWardMatcher, wardByName, wardNumber } from '../../../shared/wardMatch.js';
import { baselineRegister, baselineSurvey, withBaseline } from './baseline.js';
import { oyoGeo, wardResolver } from './geo.js';
import { buildMap } from './map.js';

test('ward labels: names, spelling slips, Roman numerals and bare numbers', () => {
  const wards = ['AAJE/OGUNBADO', 'ABOGUNDE', 'AGUODO/ MASIFA', 'ISALE ALAASA', 'SABO/TARA', 'TEDE I', 'TEDE II'];
  assert.equal(wardByName('AGUODO/MASIFA . WARD 3', wards), 'AGUODO/ MASIFA');
  assert.equal(wardByName('MASIFA AGUODO', wards), 'AGUODO/ MASIFA');
  assert.equal(wardByName('ALASA WARD 05', wards), 'ISALE ALAASA');
  assert.equal(wardByName('SABO /TAARA. WARD 10', wards), 'SABO/TARA');
  assert.equal(wardByName('TEDE II', wards), 'TEDE II');
  assert.equal(wardByName('TEDE I', wards), 'TEDE I');
  assert.equal(wardByName('WARD 3', wards), '', 'a bare number is not a name');
  assert.equal(wardNumber('WARD3'), 3);
  assert.equal(wardNumber('ALASA. WARD O5'), 5);
  assert.equal(wardNumber('ABOGUNDE WARD ONE'), 1);
  assert.equal(wardNumber('11: GBONJE / OLELE'), 11);
  assert.equal(wardNumber('10 OKEOLA'), 10);
  assert.equal(wardNumber('IJERU WARD II'), 2);
  const numbered = new Map([[1, 'ABOGUNDE'], [3, 'AGUODO/ MASIFA']]);
  const match = createWardMatcher(wards, [], numbered);
  assert.equal(match('WARD 3'), 'AGUODO/ MASIFA');
  assert.equal(match('03'), 'AGUODO/ MASIFA');
  assert.equal(match('WARD 9'), '', 'an unknown number stays unmatched');
});

test('the bundled register covers all 6,390 Oyo polling units in 351 numbered wards', () => {
  const lgas = [...oyoGeo().lgas.values()];
  assert.equal(lgas.length, 33);
  assert.equal(lgas.reduce((sum, lga) => sum + lga.wardList.length, 0), 351);
  assert.equal(lgas.reduce((sum, lga) => sum + lga.pollingUnits, 0), 6390);
  const resolve = wardResolver('OGBOMOSO NORTH');
  assert.equal(resolve('WARD 3').name, 'AGUODO/ MASIFA');
  assert.equal(resolve('SABO /TAARA. WARD 10').number, 10);
});

test('map: LGA layers join ground work, survey, needs and 2023 history', () => {
  const map = buildMap({ datasets: withBaseline([]), survey: baselineSurvey() });
  assert.equal(map.level, 'lga');
  assert.equal(map.rows.length, 33);
  const oyoWest = map.rows.find((row) => row.key === 'OYO WEST');
  assert.equal(oyoWest.detail.gov2023.winner, 'PDP');
  assert.ok(oyoWest.values.changeGov > 0.4, 'Oyo West moved strongly toward Sen. Alli');
  assert.ok(oyoWest.values.population > 0 && oyoWest.detail.populationEstimated);
  assert.ok(oyoWest.detail.needs.length > 0 && oyoWest.detail.needs[0].survey != null);
  const population = map.rows.reduce((sum, row) => sum + row.values.population, 0);
  assert.ok(Math.abs(population - 7_976_100) < 50, 'estimates add up to the state projection');
  assert.equal(map.layers.pvc.loaded, false, 'PVCs by LGA need an upload');
  assert.ok(map.insights.some((item) => /blind spots/.test(item.text)));
  assert.ok(map.ranking.length > 0 && map.ranking[0].reasons.length > 0);
});

test('map: register layers at every level, 10x volunteers, and no support or agent/volunteer layers', () => {
  const register = baselineRegister();
  assert.equal(register.total, 3_276_307);
  assert.equal(Object.keys(register.lgas).length, 33);
  assert.equal(Object.values(register.lgas).reduce((sum, lga) => sum + Object.keys(lga.wards).length, 0), 351, 'every INEC ward placed');
  assert.ok(!/0[789]\d{9}/.test(JSON.stringify(register)), 'register totals carry no phone numbers');

  const map = buildMap({ datasets: withBaseline([]), survey: baselineSurvey(), register });
  for (const gone of ['support', 'agents', 'volunteers']) assert.equal(map.layers[gone], undefined, `${gone} layer removed`);
  assert.equal(map.comparisons.changeGov, undefined, 'comparisons built on support removed');
  assert.equal(map.layers.members.label, 'APC confirmed members');
  assert.equal(map.layers.reached.label, 'Polling units reached');
  assert.equal(map.layers.calls.label, 'Call center reached');
  assert.equal(map.totals.registered, 3_276_307);
  const oluyole = map.rows.find((row) => row.key === 'OLUYOLE');
  assert.equal(oluyole.values.registered, 130_659, 'registered voters from the full register');
  for (const key of ['women', 'youth', 'middleAge', 'older', 'phone']) assert.ok(oluyole.values[key] > 0 && oluyole.values[key] < 1, key);
  assert.ok(oluyole.values.occupation && oluyole.values.occupation !== 'other');
  assert.equal(oluyole.detail.register.ages.length, 6);
  assert.equal(oluyole.values.tenx, null, 'oyo10x not connected: no 10x figure, not zero');
  assert.equal(map.layers.tenx.loaded, false);
  assert.match(map.layers.tenx.hint, /not connected/);

  const wards = buildMap({ datasets: withBaseline([]), survey: baselineSurvey(), register, lga: 'Ibadan South-East' });
  assert.ok(wards.rows.every((row) => row.values.registered > 0 && row.values.women != null), 'every ward, including "S 7B"-style names, has register figures');
  const units = buildMap({ datasets: withBaseline([]), survey: baselineSurvey(), register, lga: 'Ogbomoso North', ward: '3' });
  assert.ok(units.rows.filter((row) => row.detail.register).length >= 30, 'polling units carry register figures');
  assert.ok(units.ward.register.voters > 10_000);
});

test('map: 10x volunteers are placed by LGA and ward when oyo10x reports them', () => {
  const tenx = {
    totals: { registered: 900, verified: 600 },
    byLga: [{ name: 'Atiba', members: 400 }, { name: 'Ogbomosho North', members: 500 }],
    byWard: [{ lga: 'Ogbomoso North', name: 'AGUODO/ MASIFA', members: 120 }],
    byPollingUnit: [],
  };
  const map = buildMap({ datasets: [], tenx });
  assert.equal(map.totals.tenx, 900);
  assert.equal(map.rows.find((row) => row.key === 'ATIBA').values.tenx, 400);
  assert.equal(map.rows.find((row) => row.key === 'OGBOMOSO NORTH').values.tenx, 500, 'LGA spellings matched');
  assert.equal(map.rows.find((row) => row.key === 'IREPO').values.tenx, 0, 'connected but none reported: zero');
  assert.equal(map.layers.tenx.loaded, true);
  const wards = buildMap({ datasets: [], tenx, lga: 'Ogbomoso North' });
  assert.equal(wards.rows.find((row) => row.number === 3).values.tenx, 120);
});

test('map: drilling into wards and polling units keeps members and calls placed', () => {
  const datasets = withBaseline([]);
  const wards = buildMap({ datasets, survey: baselineSurvey(), lga: 'Ogbomoso North' });
  assert.equal(wards.level, 'ward');
  assert.equal(wards.rows.length, 10);
  const masifa = wards.rows.find((row) => row.number === 3);
  assert.ok(masifa.values.members > 100 && masifa.values.calls > 20);
  assert.ok(masifa.values.pres2023 > 0 && masifa.values.registered > 10000);
  assert.equal(wards.context.key, 'OGBOMOSO NORTH');

  const units = buildMap({ datasets, survey: baselineSurvey(), lga: 'Ogbomoso North', ward: '3' });
  assert.equal(units.level, 'pu');
  assert.equal(units.ward.name, 'AGUODO/ MASIFA');
  assert.equal(units.rows.length, 40);
  assert.ok(units.rows.filter((row) => row.values.members > 0).length >= 30);
  assert.ok(units.insights.length > 0);
});

test('map: cleaned party data, 2023 turnout, dropdown options and critical alerts', () => {
  const datasets = withBaseline([]);
  const survey = baselineSurvey();
  const register = baselineRegister();
  const map = buildMap({ datasets, survey, register });
  const sum = (key) => map.rows.reduce((total, row) => total + (row.values[key] || 0), 0);
  assert.ok(sum('cleaned') > 0 && sum('cleaned') <= sum('members'), 'cleaned members are a subset of members');
  assert.equal(map.rows.reduce((total, row) => total + row.unitsWithMember, 0), 5992, 'reached matches the Pulse');
  assert.ok(map.rows.every((row) => row.values.turnout2023 == null || (row.values.turnout2023 > 0 && row.values.turnout2023 <= 1)));
  assert.equal(map.options.lgas.length, 33);
  assert.equal(map.layers.activePhones.loaded, false);
  assert.match(map.layers.activePhones.hint, /NCC/);
  assert.ok(map.alerts.length > 0 && map.alerts.length <= 8);
  const rank = { high: 0, medium: 1, low: 2 };
  assert.ok(map.alerts.every((alert, i, all) => !i || rank[all[i - 1].severity] <= rank[alert.severity]), 'most serious first');
  const wards = buildMap({ datasets, survey, register, lga: 'Ibadan North' });
  assert.equal(wards.options.wards.length, 12);
  assert.ok(wards.alerts.every((alert) => !/[A-Z]{5,}/.test(alert.title.replace(/NW\d|N\d+A?/g, ''))), 'ward names are title-cased');
  const tenx = { totals: { registered: 10 }, byLga: [], byWard: [], byPollingUnit: [], projects: { byWard: [{ lga: 'Ibadan North', ward: 'Ward I N2', projects: 2, cost: 5_000_000 }] } };
  const withProjects = buildMap({ datasets, survey, register, lga: 'Ibadan North', tenx });
  assert.equal(withProjects.rows.find((row) => row.number === 1).values.projects, 2);
  assert.equal(withProjects.rows.find((row) => row.number === 1).values.projectCost, 5_000_000);
});
