import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeOyo10x } from './oyo10x.js';
import { buildChannels } from '../modules/feedback/channels.js';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const sample = () => fixture('oyo10x-aggregate-synthetic.json');
const channel = (raw, lga = '') => buildChannels({ tenx: sanitizeOyo10x(raw), lga }).field;

test('v2: APC overlap preserves loaded, unloaded, zero and missing states', () => {
  const loaded = sanitizeOyo10x(sample());
  assert.equal(loaded.totals.apc10xPromoters, 2);
  assert.equal(loaded.apcPromoterOverlap.matchedPromoterRecords, 3);
  assert.equal(sanitizeOyo10x(fixture('oyo10x-apc-unloaded-synthetic.json')).totals.apc10xPromoters, null);
  const raw = sample(); raw.apc_promoter_overlap.matched_promoters = 0;
  assert.equal(sanitizeOyo10x(raw).totals.apc10xPromoters, 0);
  delete raw.apc_promoter_overlap; delete raw.summary.totals.apc_10x_promoters;
  assert.equal(sanitizeOyo10x(raw).totals.apc10xPromoters, null);
});

test('v2: field-work is preferred to the upload and uses classified answer shares', () => {
  const raw = sample(); raw.field_work.responses = 20; raw.field_work.sentiment.other = 7;
  const field = channel(raw);
  assert.equal(field.source, 'oyo10x');
  assert.equal(field.responses, 20);
  assert.equal(field.sentiment.positiveShare, 3 / 5);
  assert.equal(field.sentiment.negativeShare, 2 / 5);
  assert.equal(field.sentiment.other, 7);
  assert.equal(field.topIssues[0].share, 3 / 20);
  assert.equal(field.detail.locations[0].polling_unit_code, '30/01/01/001');
});

test('v2: LGA filtering merges topic and question counts without merging task identities', () => {
  const raw = sample();
  const second = structuredClone(raw.field_work.by_location[0]);
  second.questions.forEach((row) => { row.task_id = 2; });
  raw.field_work.by_location.push(second);
  const field = channel(raw, 'Afijio');
  assert.equal(field.responses, 10);
  assert.equal(field.topIssues[0].count, 6);
  assert.equal(field.detail.questions.length, 4);
  assert.equal(field.sentiment.positiveShare, 0.6);
  const elsewhere = channel(raw, 'Iseyin');
  assert.equal(elsewhere.responses, 0);
  assert.equal(elsewhere.sentimentAvailable, false);
  assert.equal(elsewhere.sentiment.positiveShare, null);
});

test('v2: empty field-work does not become an uploaded survey or neutral sentiment', () => {
  const raw = sample();
  raw.field_work = { responses: 0, surveys: 0, sentiment_available: false };
  const channels = buildChannels({ tenx: sanitizeOyo10x(raw), survey: { rows: ['must not read this'] } });
  assert.equal(channels.field.responses, 0);
  assert.equal(channels.field.sentimentAvailable, false);
  assert.equal(channels.field.sentiment.positiveShare, null);
  assert.ok(channels.critical.some((row) => row.text === 'No sentiment answers collected.'));
});

test('v2: aggregate whitelist excludes unexpected personal data and original free text', () => {
  const raw = sample();
  raw.field_work.phone = 'PRIVATE_PHONE';
  raw.field_work.by_location[0].respondents = [{ name: 'PRIVATE_NAME' }];
  raw.field_work.questions.push({ type: 'free_text', answers: [{ value: 'PRIVATE_TEXT', responses: 1 }] });
  const clean = JSON.stringify(sanitizeOyo10x(raw));
  for (const value of ['PRIVATE_PHONE', 'PRIVATE_NAME', 'PRIVATE_TEXT']) assert.equal(clean.includes(value), false);
});
