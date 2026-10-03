import test from 'node:test';
import assert from 'node:assert/strict';
import { createOyo10xClient, sanitizeOyo10x } from './oyo10x.js';

const sample = () => ({
  generated_at: '2026-09-23T17:58:44.812Z',
  summary: {
    totals: { registered: 120, verified: 80, pending: 30, flagged: 6, rejected: 4, unit_promoters: 15, grassroots: 90 },
    coverage: { lgas: 12, wards: 40, polling_units: 210 },
    surveys: { count: 2, responses: 55 },
  },
  registrations_report: {
    completeness: { missing_nin: 3, missing_bank_details: 5 },
    registrations_per_day: [{ date: '2026-09-22', count: 70 }, { date: '2026-09-23', count: 50 }],
  },
  coverage: { by_senatorial_district: [{ name: 'Oyo South', members: 60, verified: 40, unit_promoters: 8, grassroots: 45, wards: 20, polling_units: 100 }] },
  candidates: [
    { name: 'Sen. Sharafadeen Abiodun Alli', office: 'Governor', nominees: { total: 10, verified: 7 }, reports_filed: 2 },
    { name: 'Oyewole Abiola O.', office: 'House of Assembly', nominees: { total: 4, verified: 1 }, reports_filed: 0 },
    { name: 'Test Split-LGA Seat (delete me)', office: 'House of Assembly', nominees: { total: 99, verified: 99 }, reports_filed: 99 },
  ],
  projects: {
    total: 4,
    rows: [
      { title: 'Borehole', status: 'promised', lga: 'Akinyele', ward: 'Ojo-Emo/Moniya', candidate: { name: 'Oyewole Abiola O.' }, sites: [{ lat: 7.4, lng: 3.9, label: 'x' }] },
      { title: 'Road', status: 'In progress', lga: 'Akinyele', ward: 'OJO-EMO / MONIYA', candidate: { name: 'Oyewole Abiola O.' } },
      { title: 'Clinic', status: 'completed', lga: 'Iseyin', ward: 'Ado', candidate: { name: 'Oyewole Abiola O.' } },
      { title: 'Data', status: 'promised', candidate: { name: 'Test Split-LGA Seat (delete me)' } },
    ],
  },
  notes: { project_status: 'Most projects are "promised".' },
  // What a person-level response would carry. None of this may survive sanitising.
  registrations: [{ name: 'Adebayo Okafor', phone: '08030000000', nin: '12345678901', pvc: '90F5B', bank_account: '0123456789' }],
});

test('only aggregate counts cross into SIGAR Vote, never person-level fields', () => {
  const clean = sanitizeOyo10x(sample());
  const serialized = JSON.stringify(clean);
  for (const leak of ['Adebayo Okafor', '08030000000', '12345678901', '90F5B', '0123456789', 'lat', 'missing_nin', 'missing_bank']) {
    assert.equal(serialized.includes(leak), false, `sanitised payload must not contain "${leak}"`);
  }
  assert.equal(clean.totals.registered, 120);
  assert.equal(clean.coverage.pollingUnits, 210);
  assert.equal(clean.bySenatorialDistrict[0].members, 60);
});

test("oyo10x's own test records are excluded from every figure", () => {
  const clean = sanitizeOyo10x(sample());
  assert.equal(clean.candidates.total, 2, 'the "(delete me)" candidate must not be counted');
  assert.equal(clean.candidates.nomineesTotal, 14);
  assert.equal(clean.candidates.reportsFiled, 2);
  assert.equal(clean.projects.total, 3, 'the test project must not be counted');
  assert.equal(clean.projects.testRecordsExcluded, 1);
});

test('projects fold into four stages and count the wards and LGAs they reach', () => {
  const { projects } = sanitizeOyo10x(sample());
  assert.deepEqual(projects.stages, { submitted: 1, notStarted: 0, ongoing: 1, completed: 1, other: 0 });
  assert.equal(projects.wards, 2, 'the same ward spelt two ways counts once');
  assert.deepEqual(projects.byLga, [{ name: 'Akinyele', projects: 2 }, { name: 'Iseyin', projects: 1 }]);
  assert.equal(JSON.stringify(projects).includes('Oyewole'), false, 'candidate names stay out');
});

test('malformed or negative figures read as zero rather than corrupting totals', () => {
  const clean = sanitizeOyo10x({ summary: { totals: { registered: -5, verified: 'lots', pending: null } }, candidates: 'nope', projects: null });
  assert.equal(clean.totals.registered, 0);
  assert.equal(clean.totals.verified, 0);
  assert.equal(clean.candidates.total, 0);
  assert.equal(clean.projects.total, 0);
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json; charset=utf-8' },
  json: async () => body,
});

test('base URLs and full /all endpoint URLs use the same endpoint and API-key header', async () => {
  for (const baseUrl of ['https://example.test/api/external/v1', 'https://example.test/api/external/v1/all/']) {
    const client = createOyo10xClient({
      baseUrl, apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://example.test/api/external/v1/all');
        assert.equal(options.headers['X-API-Key'], 'test-key');
        return jsonResponse(sample());
      },
    });
    assert.equal((await client.snapshot()).status, 'ok');
  }
});

test('not configured means no network call at all', async () => {
  let calls = 0;
  const client = createOyo10xClient({ baseUrl: '', apiKey: '', fetchImpl: async () => { calls += 1; } });
  const result = await client.snapshot();
  assert.equal(result.status, 'not-configured');
  assert.equal(calls, 0);
});

test('responses are cached, so frequent dashboard refreshes do not reach oyo10x', async () => {
  let calls = 0;
  let clock = 0;
  const client = createOyo10xClient({
    baseUrl: 'https://example.test/api/external/v1', apiKey: 'k',
    fetchImpl: async () => { calls += 1; return jsonResponse(sample()); },
    now: () => clock,
  });
  await client.snapshot();
  clock += 30_000;
  await client.snapshot();
  assert.equal(calls, 1, 'a second request inside the cache window must be served from cache');
  clock += 40_000;
  await client.snapshot();
  assert.equal(calls, 2, 'after the cache expires it refreshes');
});

test('a failing oyo10x is backed off, not retried on every refresh, and never throws', async () => {
  let calls = 0;
  let clock = 0;
  let healthy = true;
  const client = createOyo10xClient({
    baseUrl: 'https://example.test/api/external/v1', apiKey: 'k',
    fetchImpl: async () => { calls += 1; return healthy ? jsonResponse(sample()) : jsonResponse({}, 504); },
    now: () => clock,
  });

  const first = await client.snapshot();
  assert.equal(first.status, 'ok');

  healthy = false;
  clock += 61_000;
  const failed = await client.snapshot();
  assert.equal(failed.status, 'stale', 'last good figures are kept, clearly marked stale');
  assert.equal(failed.data.totals.registered, 120);
  assert.match(failed.error, /504/);
  const callsAfterFailure = calls;

  for (let i = 0; i < 10; i += 1) { clock += 5_000; await client.snapshot(); }
  assert.equal(calls, callsAfterFailure, 'inside the back-off window oyo10x must not be contacted at all');

  healthy = true;
  clock += 60_000;
  const recovered = await client.snapshot();
  assert.equal(recovered.status, 'ok');
});

test('concurrent requests share a single call to oyo10x', async () => {
  let calls = 0;
  const client = createOyo10xClient({
    baseUrl: 'https://example.test/api/external/v1', apiKey: 'k',
    fetchImpl: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return jsonResponse(sample()); },
  });
  await Promise.all([client.snapshot(), client.snapshot(), client.snapshot(), client.snapshot()]);
  assert.equal(calls, 1);
});
