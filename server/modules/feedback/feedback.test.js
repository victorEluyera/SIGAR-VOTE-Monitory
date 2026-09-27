import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkbook } from '../voter-survey/xlsx.js';
import { buildSurveyDataset } from '../voter-survey/import.js';
import { ALLI, HAMZAT, buildXlsx, SURVEY_HEADER, surveyRow } from '../voter-survey/test-fixtures.js';
import { buildFeedbackAnalysis } from './analysis.js';
import { FOCUS_CANDIDATE, QUESTIONS, validateSubmission } from './form.js';

const REQUIRED = { respondent: 'Youth Member', topIssue: 'Job Creation', satisfaction: 'Dissatisfied', hasPvc: 'No', likelihood: 'Likely' };
const link = { id: 'l1', token: 't', lga: '', active: true };
const projects = [
  { id: 'p1', title: 'Borehole at Oja Oba', lga: 'OGBOMOSO NORTH', ward: 3, active: true },
  { id: 'p2', title: 'Road to the market', lga: 'OGBOMOSO NORTH', ward: null, active: true },
  { id: 'p3', title: 'Clinic in Atiba', lga: 'ATIBA', ward: null, active: true },
];

test('the form carries the Core Field Questionnaire, with two-part questions split in two', () => {
  const numbers = QUESTIONS.map((question) => String(question.n));
  for (const n of ['1', '3', '4', '5', '6a', '6b', '7', '8a', '8b', '9a', '9b', '10', '11', '12', '13', '14a', '14b', '15a', '15b', '15c']) assert.ok(numbers.includes(n), `question ${n}`);
  assert.ok(QUESTIONS.every((question) => question.type === 'text' || question.options.length >= 2));
});

test('submissions accept only real places, listed answers, offered projects rated 1-10, and pins inside Oyo', () => {
  assert.match(validateSubmission({ answers: REQUIRED }, link).error, /LGA/);
  assert.match(validateSubmission({ lga: 'Atiba', answers: { ...REQUIRED, topIssue: 'Free money' } }, link).error, /not one of the answers/);
  assert.match(validateSubmission({ lga: 'Atiba', answers: { topIssue: 'Security' } }, link).error, /Please answer/);
  assert.match(validateSubmission({ lga: 'Atiba', ward: '99', answers: REQUIRED }, link).error, /ward/);
  assert.match(validateSubmission({ lga: 'Atiba', answers: REQUIRED, projects: { p1: 7 } }, link, { projects }).error, /not offered/);
  assert.match(validateSubmission({ lga: 'Ogbomosho North', ward: '3', answers: REQUIRED, projects: { p1: 11 } }, link, { projects }).error, /1 \(not needed\) to 10/);
  assert.match(validateSubmission({ lga: 'Atiba', answers: REQUIRED, facility: { type: 'Spaceport' } }, link).error, /kind of facility/);

  const ok = validateSubmission({
    lga: 'ogbomosho north', ward: '3', unit: '1',
    answers: { ...REQUIRED, why: 'Good man, call 08060811060', extra: 'ignored' },
    projects: { p1: 9, p2: '6' },
    facility: { type: 'Flooding or erosion point', note: 'Drain blocked by the school', lat: 8.1334567, lng: 4.2456789, accuracy: 12.4 },
  }, link, { projects });
  assert.equal(ok.value.lga, 'OGBOMOSO NORTH');
  assert.equal(ok.value.ward, 3);
  assert.equal(ok.value.unit, 1);
  assert.equal(ok.value.answers.why, 'Good man, call [number removed]', 'phone numbers never stored');
  assert.equal(ok.value.answers.extra, undefined, 'unknown fields are dropped');
  assert.deepEqual(ok.value.answers.projects, { p1: 9, p2: 6 });
  assert.deepEqual(ok.value.facility, { type: 'Flooding or erosion point', note: 'Drain blocked by the school', lat: 8.13346, lng: 4.24568, accuracy: 12 });
  const lagos = validateSubmission({ lga: 'Atiba', answers: REQUIRED, facility: { type: 'School', lat: 6.45, lng: 3.39 } }, link);
  assert.equal(lagos.value.facility.lat, undefined, 'a pin outside Oyo is dropped');
  assert.equal(validateSubmission({ lga: 'Iseyin', answers: REQUIRED }, { ...link, lga: 'ATIBA' }).value.lga, 'ATIBA', 'a link made for an LGA keeps its LGA');
});

test('feedback analysis joins the field survey, the form and callers; field wording maps onto the form', () => {
  const survey = buildSurveyDataset(openWorkbook(buildXlsx({ 'Cleaned Table': [SURVEY_HEADER, ...Array.from({ length: 30 }, (_, i) => surveyRow({ id: i + 1, vote: i < 20 ? ALLI : HAMZAT, issue: i < 18 ? 'Job creation' : 'Health care', lga: 'Atiba' }))] })));
  const responses = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`, linkId: 'l1', lga: 'ATIBA', collectedBy: i < 4 ? 'agent-1' : '',
    answers: { ...REQUIRED, lgaProblem: 'Poor Roads', choice: i < 6 ? FOCUS_CANDIDATE : 'Oriyomi Hamzat', goodGovernor: i < 9 ? 'Yes' : "Don't Know Enough", why: i < 6 ? 'He is competent' : 'Integrity', projects: { p3: i < 6 ? 9 : 7 } },
    facility: i < 3 ? { type: 'Water or borehole', note: 'Broken borehole', lat: 8.1, lng: 4.1 } : null,
    submittedAt: new Date(2026, 8, 27, 10, i).toISOString(),
  }));
  const centerSet = { report: { overview: { calls: 30 }, byLga: { ATIBA: { calls: 30 } }, issues: { byLga: { ATIBA: { electricity: 20, roads: 10, appreciation: 5 } } } } };

  const view = buildFeedbackAnalysis({ survey, responses, links: [link], projects, centerSet, tenx: { surveys: { count: 2, responses: 40 } }, agents: new Map([['agent-1', 'Ade Field']]) });
  assert.equal(view.sources.field.responses, 30);
  assert.equal(view.sources.form.responses, 12);
  assert.equal(view.sources.form.byAgents, 4);
  assert.equal(view.sources.form.agents, 1);
  assert.equal(view.sources.callCenter.calls, 30);
  assert.equal(view.sources.tenx.responses, 40);

  const topIssue = view.questions.find((question) => question.id === 'topIssue');
  assert.equal(topIssue.rows.find((row) => row.name === 'Healthcare').field, 0.4, "field 'Health care' is the form's 'Healthcare'");
  assert.equal(topIssue.rows.find((row) => row.name === 'Job Creation').link, 1);
  const jobs = view.needs.find((need) => need.id === 'jobs');
  assert.equal(jobs.field, 0.6);
  assert.equal(view.needs.find((need) => need.id === 'water').link, 0.25, 'reported boreholes count as a water need');
  assert.equal(view.needs.some((need) => need.id === 'appreciation'), false);

  assert.equal(view.intention.field.share, Number((20 / 30).toFixed(4)));
  assert.equal(view.intention.link.share, 0.5);
  assert.equal(view.perception.goodGovernor.rows[0].share, 0.75);
  assert.equal(view.perception.reasons.answers, 12);
  assert.equal(view.perception.reasons.quotes.length, 2);
  const clinic = view.projects.find((project) => project.id === 'p3');
  assert.equal(clinic.ratings, 12);
  assert.equal(clinic.average, 8);
  assert.equal(view.facilities.total, 3);
  assert.equal(view.facilities.recent[0].note, 'Broken borehole');
  assert.deepEqual(view.agents, [{ name: 'Ade Field', count: 4 }]);
  assert.equal(JSON.stringify(view).includes('Hamzat'), false, 'no rival is named in the results');

  const stakeholder = buildFeedbackAnalysis({ responses, links: [link], projects });
  assert.equal(stakeholder.agents, null, 'agent names are for administrators only');
  assert.equal(stakeholder.facilities.recent, null);
});

test('a written reason used by fewer than five people is never quoted', () => {
  const responses = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, linkId: 'l1', lga: 'ATIBA', answers: { ...REQUIRED, why: 'Tunde Bakare told me he is honest' } }));
  const view = buildFeedbackAnalysis({ responses, links: [link] });
  assert.equal(view.perception.reasons.quotes.length, 0);
  assert.equal(JSON.stringify(view).includes('Tunde'), false);
});
