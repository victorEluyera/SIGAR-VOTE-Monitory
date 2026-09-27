import test from 'node:test';
import assert from 'node:assert/strict';
import { openCsvWorkbook, openWorkbook } from '../voter-survey/xlsx.js';
import { buildSurveyDataset } from '../voter-survey/import.js';
import { ALLI, HAMZAT, buildXlsx, SURVEY_HEADER, surveyRow } from '../voter-survey/test-fixtures.js';
import { buildDataset, describeDataset, normalizePhone } from './datasets.js';
import { themesOf } from './contact-center.js';
import { matchLga, oyoLgas } from './lga.js';
import { buildPulse, STATE_BASELINE } from './pulse.js';
import { createPreElectionRepository } from './repository.js';

test('matchLga maps campaign spellings onto the 33 register LGAs', () => {
  assert.equal(oyoLgas().length, 33);
  const cases = {
    'OYO EAST LG': 'OYO EAST',
    'OGBOMOSHO NORTH': 'OGBOMOSO NORTH',
    'IB SOUTHWEST LG': 'IBADAN SOUTH WEST',
    'IBADAN SOUTH- EAST': 'IBADAN SOUTH-EAST',
    'Ibadan South-East': 'IBADAN SOUTH-EAST',
    'Oriire': 'ORI IRE',
    'Orelope': 'OORELOPE',
    'Ona-Ara': 'ONA-ARA',
    'OGO-OLUWA LG': 'OGO-OLUWA',
    'SUURULERE LG': 'SURULERE',
    'Surulere': 'SURULERE',
    'Local Government': '',
    'Lagos Island': '',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(matchLga(input), expected, input);
});

test('normalizePhone restores the leading zero and rejects malformed numbers', () => {
  assert.equal(normalizePhone('7010000584'), '07010000584');
  assert.equal(normalizePhone(8060811060), '08060811060');
  assert.equal(normalizePhone('+234 806 081 1060'), '08060811060');
  assert.equal(normalizePhone('08060811060, 07034767826'), '08060811060');
  assert.equal(normalizePhone('0806081106'), '');
  assert.equal(normalizePhone(''), '');
});

test('member lists keep no names or phones and count a person in two lists once', () => {
  const agents = buildDataset('members', openWorkbook(buildXlsx({
    Master: [
      ['Record ID', 'State', 'LGA', 'Ward / source label', 'PU code', 'Polling unit / location', 'Agent name', 'Phone number', 'Name supplied'],
      ['OY-1', 'Oyo', 'Atiba', 'WARD 1', '001', 'School', 'ADE OLU', '08060811060', 1],
      ['OY-2', 'Oyo', 'Atiba', 'WARD 1', '002', 'Market', 'BOLA ADE', '8034767826', 1],
      ['OY-3', 'Oyo', 'Atiba', 'WARD 1', '002', 'Market', 'BOLA ADE', '08034767826', 1],
    ],
    'Atiba': [['Record ID', 'Agent name', 'Phone number'], ['OY-1', 'ADE OLU', '08060811060']],
  })), { label: 'Polling-unit agents' });
  assert.equal(agents.summary.rowsRead, 3, 'reads only the Master sheet');
  assert.equal(agents.summary.uniquePeople, 2);
  assert.ok(!JSON.stringify(agents).includes('08060811060'));
  assert.ok(!JSON.stringify(agents).includes('ADE OLU'));

  // One sheet per LGA, no LGA column, a title-less header on row 1.
  const volunteers = buildDataset('members', openWorkbook(buildXlsx({
    'OYO WEST LG': [['S/N', 'NAME', 'PHONE NO', 'WARD', 'UNIT'], [1, 'ADE OLU', '08060811060', 'WARD 2', 4], [2, 'KEMI', '07011112222', 'WARD 2', 5]],
    'Summary': [['LGA', 'Count'], ['Oyo West', 2]],
  })), { label: 'Volunteers' });
  assert.equal(volunteers.summary.rowsRead, 2);
  assert.deepEqual(volunteers.summary.sheets, ['OYO WEST LG']);
  assert.equal(describeDataset(volunteers).records, undefined);

  const pulse = buildPulse({ datasets: [agents, volunteers] });
  assert.equal(pulse.members.total, 3, 'the shared phone number is one person');
  assert.equal(pulse.members.inMoreThanOneList, 1);
  assert.deepEqual(pulse.members.groups.map((group) => group.people), [2, 2]);
  assert.equal(pulse.byLga.find((row) => row.lga === 'ATIBA').members, 2);
  assert.equal(pulse.byLga.find((row) => row.lga === 'OYO WEST').members, 2, 'listed in both LGAs, counted in each');
  const atiba = buildPulse({ datasets: [agents, volunteers], lga: 'atiba' });
  assert.equal(atiba.filter.lga, 'ATIBA');
  assert.equal(atiba.members.total, 2);
  assert.equal(atiba.members.unitsCovered, 2);
});

test('a register-style member list: named polling units become INEC units, and a shared phone is not one person', () => {
  const header = ['Name', 'Gender', 'Date of birth', 'Phone', 'Polling unit', 'Ward', 'LGA'];
  const members = buildDataset('members', openWorkbook(buildXlsx({
    List: [
      header,
      ['ADE OLU', 'male', '1980-01-01', '08060811060', 'baptist school, idiyan i', 'ofiki ii', 'ibarapa north'],
      // Same phone, different person (a family line): counted as a second person.
      ['KEMI OLU', 'female', '1985-05-05', '08060811060', 'baptist school, idiyan ii', 'ofiki ii', 'ibarapa north'],
      // The same person listed twice: still one.
      ['ADE OLU', 'male', '1980-01-01', '08060811060', 'baptist school, idiyan i', 'ofiki ii', 'ibarapa north'],
      // "Community hall i" exists in three Ibarapa North wards; without a ward it cannot be placed.
      ['BOLA ADE', 'male', '1990-02-02', '07011112222', 'community hall i', '', 'ibarapa north'],
    ],
  })), { label: 'Party members' });

  assert.equal(members.summary.uniquePeople, 3);
  assert.equal(members.summary.sharedPhones, 1);
  assert.equal(members.summary.unitsByName, 4);
  assert.equal(members.summary.unitsByNameMatched, 3, 'an ambiguous unit name is left unmatched, never guessed');
  assert.deepEqual(members.records[0].slice(0, 3), ['IBARAPA NORTH', 'OFIKI II', '8']);
  assert.deepEqual(members.records[1].slice(0, 3), ['IBARAPA NORTH', 'OFIKI II', '9']);
  assert.ok(!JSON.stringify(members).includes('08060811060'));
  assert.ok(!JSON.stringify(members).includes('1980-01-01'));

  const pulse = buildPulse({ datasets: [members] });
  assert.equal(pulse.members.total, 3);
  assert.equal(pulse.members.unitsCovered, 3, 'two INEC units found from their names, plus the unplaceable one counted as typed');

  // A list without dates of birth keeps the old rule: one phone is one person.
  const agents = buildDataset('members', openWorkbook(buildXlsx({ Master: [['Agent name', 'Phone', 'LGA'], ['ADE OLU', '08060811060', 'Atiba'], ['KEMI OLU', '08060811060', 'Atiba']] })));
  assert.equal(agents.summary.uniquePeople, 1);
});

test('contact lists keep only counts per LGA and flag Excel-truncated files', () => {
  const csv = Buffer.from('Lga ,Phone Number\nAFIJIO,7010000584\nAFIJIO,7010000584\nIBADAN SOUTH- EAST,8031234567\nIBADAN SOUTH-EAST,8031234568\nNOWHERE,8031234569\nAFIJIO,123\n');
  const contacts = buildDataset('contacts', openCsvWorkbook(csv));
  assert.deepEqual(contacts.counts, { AFIJIO: 1, 'IBADAN SOUTH-EAST': 2 });
  assert.equal(contacts.summary.duplicatesInFile, 1);
  assert.equal(contacts.summary.invalid, 1);
  assert.deepEqual(contacts.summary.unmatched, [{ name: 'NOWHERE', count: 1 }]);
  assert.equal(contacts.summary.truncated, false);
  assert.equal(buildPulse({ datasets: [contacts] }).contacts.total, 3);
});

test('reference figures use the upload per LGA and published totals until every LGA is loaded', () => {
  const reference = buildDataset('reference', openCsvWorkbook(Buffer.from('LGA,Population,Registered voters,PVCs collected\nAtiba,"250,000",120000,100000\nOyo West,200000,90000,95000\nTotal,1,1,1\n')));
  assert.equal(reference.summary.stored, 2);
  assert.equal(reference.summary.warnings.length, 1, 'PVCs above registered voters is flagged');
  const state = buildPulse({ datasets: [reference] });
  assert.equal(state.reference.registeredVoters.value, STATE_BASELINE.registeredVoters.value);
  assert.equal(state.reference.lgaLevelLoaded, 2);
  const atiba = buildPulse({ datasets: [reference], lga: 'Atiba' });
  assert.equal(atiba.reference.population.value, 250000);
  assert.equal(atiba.reference.pvcRate, 0.8333);
  const iseyin = buildPulse({ datasets: [reference], lga: 'Iseyin' });
  assert.equal(iseyin.reference.population.basis, 'estimate', 'without an upload, population is a labelled estimate');
  assert.equal(iseyin.reference.registeredVoters.basis, 'register');
  assert.equal(iseyin.reference.pvcCollected, null, 'PVCs by LGA only come from an upload');
});

test('the pulse joins the survey and writes findings; empty sources say they are not loaded', () => {
  const survey = buildSurveyDataset(openWorkbook(buildXlsx({
    'Cleaned Table': [
      SURVEY_HEADER,
      ...Array.from({ length: 40 }, (_, i) => surveyRow({ id: i, vote: i < 22 ? ALLI : HAMZAT, lga: 'Atiba' })),
      ...Array.from({ length: 40 }, (_, i) => surveyRow({ id: 100 + i, vote: i < 30 ? HAMZAT : i < 35 ? ALLI : '', lga: 'Ibadan North-East', issue: 'Security' })),
    ],
  })));
  const pulse = buildPulse({ survey });
  assert.equal(pulse.survey.responses, 80);
  assert.equal(pulse.survey.candidates[0].short, 'Hamzat');
  assert.equal(pulse.members.available, false);
  assert.equal(pulse.contacts.available, false);
  assert.ok(pulse.insights.some((item) => /No member list loaded/.test(item.text)));
  assert.ok(pulse.insights.some((item) => item.tone === 'risk' && /Sen\. Alli is #2/.test(item.text)));
  assert.equal(pulse.byLga.find((row) => row.lga === 'IBADAN NORTH EAST').responses, 40);

  const atiba = buildPulse({ survey, lga: 'ATIBA' });
  assert.equal(atiba.survey.responses, 40);
  assert.equal(atiba.survey.candidates[0].short, 'Sen. Alli');
  assert.ok(atiba.insights.some((item) => /Only 40 survey responses/.test(item.text)));
});

test('repository replaces uploads of the same kind and label only', async () => {
  const jsonDb = {};
  const repo = createPreElectionRepository({ jsonDb, saveJson: () => {} });
  const make = (kind, label, id) => ({ id, kind, label, uploadedAt: new Date().toISOString() });
  await repo.savePreElectionDataset(make('members', 'Agents', 'a'));
  await repo.savePreElectionDataset(make('members', 'Volunteers', 'b'));
  const { replaced } = await repo.savePreElectionDataset(make('members', 'agents', 'c'));
  assert.deepEqual(replaced, ['a']);
  await repo.savePreElectionDataset(make('contacts', 'List 1', 'd'));
  await repo.savePreElectionDataset(make('contacts', 'List 2', 'e'));
  assert.deepEqual((await repo.preElectionDatasets()).map((item) => item.id).sort(), ['b', 'c', 'e']);
  assert.equal((await repo.deletePreElectionDataset('b')).id, 'b');
  assert.equal(await repo.deletePreElectionDataset('b'), null);
});

test('contact center report: overview, LGAs, themed issues, and no agent names', () => {
  const title = (name) => [['Sen. Sharafadeen Alli Contact Center Report'], [`${name} | 19 Sep 2026 - 25 Sep 2026`], [name]];
  const workbook = openWorkbook(buildXlsx({
    Overview: [...title('Report Summary'), ['Metric', 'Value'], ['Reporting Period', '19 Sep 2026 - 25 Sep 2026'], ['Total Calls', 100], ['Unique Contacts', 90], ['Inbound', 10], ['Outbound', 90], ['Open', 40], ['Closed', 60]],
    'Calls Per Day': [...title('Calls Per Day'), ['Date', 'Calls', 'Unique Contacts', 'Inbound', 'Outbound'], ['2026-09-22', 40, 38, 5, 35], ['2026-09-23', 60, 52, 5, 55]],
    'Calls Per LGA': [...title('Calls By LGA'), ['LGA', 'Calls', 'Unique Contacts', 'Wards Reached'], ['OGBOMOSO NORTH', 70, 60, 8], ['IBADAN NORTH-WEST', 25, 25, 4], ['Unspecified', 5, 5, 0]],
    'Calls Per Category': [...title('Project Call Categories'), ['Project Category', 'Calls', 'Unique Contacts'], ['Project Topic Not Recorded', 30, 30], ['Community / Ward Challenge', 70, 60]],
    'Issues in the Area': [
      ...title('Issues in the Area'), ['Issue Raised', 'Calls', 'Unique Contacts', 'LGAs'],
      ['Bad road, no borehole', 3, 3, 'OGBOMOSO NORTH, IBADAN NORTH-WEST'],
      ['They need money for campaign', 2, 2, 'OGBOMOSO NORTH'],
      ['non for now', 1, 1, 'OGBOMOSO NORTH'],
      [],
      ['Assistance Requests', '', ''], ['Request', 'Calls', 'Unique Contacts'], ['follow up requested', 6, 6], ['No assistance needed', 2, 2], ['financial support', 4, 4],
    ],
    'Contact Categories': [...title('Contact Categories'), ['Scenario', 'Calls', 'Unique Contacts'], ['Supporter', 75, 70], ['Not Established', 25, 20]],
    'Location Insights': [...title('Location Confirmation'), ['Location Result', 'Calls'], ['Confirmed', 70], ['Not Confirmed', 30]],
    'Agent Performance': [...title('Calls By Agent'), ['Agent', 'Username', 'Calls', 'Unique Contacts', 'Inbound', 'Outbound'], ['Ada Obi', 'ada', 60, 55, 5, 55], ['Tunde Ola', 'tunde', 40, 35, 5, 35], [], ['Call Outcomes', ''], ['Outcome', 'Calls'], ['Completed / substantive contact', 70], ['Call dropped', 30]],
  }));
  const report = buildDataset('contact-center', workbook);
  assert.equal(report.label, 'Contact center report (19 Sep 2026 - 25 Sep 2026)');
  assert.deepEqual(report.summary.unmatched, [{ name: 'Unspecified', count: 5 }]);
  assert.ok(!JSON.stringify(report).includes('Ada Obi'), 'agent names are dropped');
  assert.equal(describeDataset(report).report, undefined);
  assert.deepEqual(report.report.issues.byLga['IBADAN NORTH WEST'], { roads: 1, water: 1 });
  assert.equal(report.report.requests.followUp, 6);
  assert.equal(report.report.agents.count, 2);

  const state = buildPulse({ datasets: [report] });
  assert.equal(state.contactCenter.calls, 100);
  assert.equal(state.contactCenter.supporters.share, 0.75);
  assert.equal(state.contactCenter.droppedShare, 0.3);
  assert.deepEqual(state.contactCenter.themes.map((row) => row.id).slice(0, 2), ['roads', 'water']);
  assert.equal(state.byLga.find((row) => row.lga === 'OGBOMOSO NORTH').calls, 70);
  assert.ok(state.insights.some((item) => /40 calls \(40%\) are still open and 6 callers asked for a follow-up/.test(item.text)));
  assert.ok(state.insights.some((item) => /31 LGAs have had no contact-center calls/.test(item.text)));

  const lga = buildPulse({ datasets: [report], lga: 'Ibadan North West' });
  assert.equal(lga.contactCenter.calls, 25);
  assert.equal(lga.contactCenter.shareOfState, 0.25);
  const empty = buildPulse({ datasets: [report], lga: 'Iseyin' });
  assert.ok(empty.insights.some((item) => /has not called anyone in Iseyin/.test(item.text)));
});

test('issue themes read callers\' own words', () => {
  assert.deepEqual(themesOf('Bad electricity, no borehole, Bad roads').sort(), ['electricity', 'roads', 'water']);
  assert.deepEqual(themesOf('THE PREVIOUS EXCOS ARE MAKING IT DIFFICULT'), ['party']);
  assert.deepEqual(themesOf('non for now'), []);
  assert.deepEqual(themesOf('assistance'), ['assistance']);
  assert.deepEqual(themesOf('They need more people in the group'), ['other']);
});

test('built-in data fills the pulse until an upload of the same kind (or member list name) replaces it', async () => {
  const { withBaseline, baselineSurvey } = await import('./baseline.js');
  const builtIn = withBaseline([]);
  assert.deepEqual(builtIn.map((item) => item.kind).sort(), ['contact-center', 'contacts', 'members', 'reference']);
  assert.ok(builtIn.every((item) => item.builtIn));
  assert.ok(!JSON.stringify(builtIn).match(/0[789]\d{9}/), 'no phone numbers ship with the app');
  assert.equal(baselineSurvey().responseCount, 28536);

  const pulse = buildPulse({ datasets: builtIn, survey: baselineSurvey() });
  assert.equal(pulse.members.total, 157289, 'APC confirmed members only; agent and volunteer lists are no longer built in');
  assert.deepEqual(pulse.members.groups.map((group) => group.label), ['APC confirmed members']);
  assert.equal(pulse.members.unitsCovered, 5992, 'counted as INEC polling units');
  assert.equal(pulse.contacts.total, 1048574);
  assert.equal(pulse.contactCenter.calls, 1204);
  assert.equal(pulse.reference.registeredVoters.value, 3276307, 'registered voters per LGA from the voter register, all 33 LGAs');
  assert.equal(pulse.reference.lgaLevelLoaded, 0, 'a registered-voters-only table does not count as population or PVC figures');

  const upload = { id: 'u1', kind: 'members', label: 'bsa-yv volunteers', records: [['ATIBA', 'W1', '1', 'x']], uploadedAt: new Date().toISOString() };
  const merged = withBaseline([upload]);
  assert.deepEqual(merged.filter((item) => item.kind === 'members').map((item) => item.label).sort(), ['APC confirmed members', 'bsa-yv volunteers']);
  assert.equal(withBaseline([{ id: 'c', kind: 'contacts', label: 'New list' }]).filter((item) => item.kind === 'contacts').length, 1);
});
