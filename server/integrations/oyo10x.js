/**
 * Read-only client for oyo10x, the campaign's grassroots mobilisation platform.
 *
 * Three rules shape this file:
 *
 * 1. Counts only. oyo10x holds registrants' NIN, PVC and bank details, and its API will return
 *    person-level rows if asked (`?include=registrations,surveys`). We never ask. Only aggregate
 *    figures are read, and `sanitize` whitelists them field by field, so nothing personal can
 *    reach SIGAR Vote even if their response grows new fields.
 * 2. Never hammer their server. Earlier builds of their `/all` endpoint crashed the whole app on
 *    each request. Responses are cached, only one request is in flight at a time, and failures
 *    back off exponentially instead of retrying every refresh.
 * 3. A failure there must never break SIGAR Vote. Callers always get a result object with a
 *    status -- the last good figures marked stale, or an explicit "unavailable" -- never a throw.
 */

import { sanitizeFieldWork, sanitizeOverlap } from './oyo10x-field-work.js';

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

// oyo10x's own marker for records meant to be deleted. Their test data must not be presented to
// stakeholders as real campaign activity.
const isTestRecord = (name) => /\(delete me\)|^test\b/i.test(String(name || '').trim());

const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
// One area's aggregate counts; `label` picks the place-name fields that area type carries.
const areaRows = (rows, label) => (Array.isArray(rows) ? rows : [])
  .filter((row) => !isTestRecord(row?.name))
  .map((row) => ({ ...label(row), members: count(row?.members ?? row?.registered), verified: count(row?.verified), unitPromoters: count(row?.unit_promoters), grassroots: count(row?.grassroots) }))
  .filter((row) => row.name);

// oyo10x's project statuses, folded into the four stages the Overview shows. "Not started" is
// checked before "ongoing" because it contains "started"; anything unrecognised is "other".
const PROJECT_STAGES = [
  ['completed', /complet|done|finish|deliver|commission/i],
  ['notStarted', /not.?started|approv|pending|planned|await|queue/i],
  ['ongoing', /ongoing|progress|start|under.?way|execut|active/i],
  ['submitted', /promis|submit|propos|request|new|draft/i],
];
export const projectStage = (status) => PROJECT_STAGES.find(([, pattern]) => pattern.test(String(status || '')))?.[0] || 'other';
const placeKey = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function sanitizeOyo10x(raw = {}) {
  const summary = raw.summary || {};
  const totals = summary.totals || {};
  const coverage = summary.coverage || {};
  const surveys = summary.surveys || {};
  const report = raw.registrations_report || {};
  const apcPromoterOverlap = sanitizeOverlap(raw.apc_promoter_overlap, totals.apc_10x_promoters);

  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).filter((c) => !isTestRecord(c?.name));
  const byOffice = new Map();
  for (const candidate of candidates) {
    const office = String(candidate.office || 'Other').trim() || 'Other';
    byOffice.set(office, (byOffice.get(office) || 0) + 1);
  }

  // Project figures are rebuilt from the rows so a test project cannot inflate them. If their
  // rows are capped below the stated total, say so rather than under-count silently.
  const projectRows = Array.isArray(raw.projects?.rows) ? raw.projects.rows : [];
  const realProjects = projectRows.filter((row) => !isTestRecord(row?.candidate?.name) && !isTestRecord(row?.title));
  const byStatus = new Map();
  for (const row of realProjects) {
    const status = String(row.status || 'unknown').trim() || 'unknown';
    byStatus.set(status, (byStatus.get(status) || 0) + 1);
  }
  const statedProjectTotal = count(raw.projects?.total);
  // Where projects are: place names and counts only (their candidate names and site pins stay out).
  const stages = { submitted: 0, notStarted: 0, ongoing: 0, completed: 0, other: 0 };
  const projectWards = new Set();
  const projectsByLga = new Map();
  const projectsByWard = new Map();
  const projectsByUnit = new Map();
  for (const row of realProjects) {
    stages[projectStage(row.status)] += 1;
    const lga = String(row.lga || '').trim();
    if (!lga) continue;
    projectsByLga.set(lga, (projectsByLga.get(lga) || 0) + 1);
    if (placeKey(row.ward)) projectWards.add(`${placeKey(lga)}|${placeKey(row.ward)}`);
    // Per ward, with the estimated cost when 10x sends one (naira; any non-number is ignored).
    const wardKey = `${placeKey(lga)}|${placeKey(row.ward)}`;
    if (!projectsByWard.has(wardKey)) projectsByWard.set(wardKey, { lga, ward: String(row.ward || '').trim(), projects: 0, cost: 0 });
    const bucket = projectsByWard.get(wardKey);
    bucket.projects += 1;
    bucket.cost += count(row.estimated_cost ?? row.cost ?? row.budget);
    const unit = String(row.polling_unit_code ?? row.polling_unit ?? '').trim();
    if (unit) {
      const unitKey = `${wardKey}|${placeKey(unit)}`;
      if (!projectsByUnit.has(unitKey)) projectsByUnit.set(unitKey, { lga, ward: String(row.ward || '').trim(), code: /\d/.test(unit) ? unit : '', name: /\d/.test(unit) ? '' : unit, projects: 0, cost: 0 });
      projectsByUnit.get(unitKey).projects += 1;
      projectsByUnit.get(unitKey).cost += count(row.estimated_cost ?? row.cost ?? row.budget);
    }
  }

  return {
    sourceGeneratedAt: raw.generated_at || summary.generated_at || null,
    fieldWork: sanitizeFieldWork(raw.field_work),
    apcPromoterOverlap,
    totals: {
      registered: count(totals.registered),
      verified: count(totals.verified),
      pending: count(totals.pending),
      flagged: count(totals.flagged),
      rejected: count(totals.rejected),
      unitPromoters: count(totals.unit_promoters),
      apc10xPromoters: apcPromoterOverlap.matchedPromoters,
      grassroots: count(totals.grassroots),
    },
    coverage: {
      lgas: count(coverage.lgas),
      wards: count(coverage.wards),
      pollingUnits: count(coverage.polling_units),
    },
    surveys: { count: count(surveys.count), responses: count(surveys.responses) },
    bySenatorialDistrict: (Array.isArray(raw.coverage?.by_senatorial_district) ? raw.coverage.by_senatorial_district : []).map((row) => ({
      name: String(row?.name || 'Unnamed'),
      members: count(row?.members),
      verified: count(row?.verified),
      unitPromoters: count(row?.unit_promoters),
      grassroots: count(row?.grassroots),
      wards: count(row?.wards),
      pollingUnits: count(row?.polling_units),
    })),
    // Volunteers per LGA, ward and polling unit, for the sentiment map. Counts and place names
    // only -- the same aggregate shape as the district rows above.
    byLga: areaRows(raw.coverage?.by_lga, (row) => ({ name: String(row?.name || row?.lga || '') })),
    byWard: areaRows(raw.coverage?.by_ward, (row) => ({ name: String(row?.name || row?.ward || ''), lga: String(row?.lga || '') })),
    byPollingUnit: areaRows(raw.coverage?.by_polling_unit, (row) => ({
      name: String(row?.name || row?.polling_unit || ''),
      code: String(row?.code || row?.polling_unit_code || ''),
      ward: String(row?.ward || ''),
      lga: String(row?.lga || ''),
    })),
    registrationsPerDay: (Array.isArray(report.registrations_per_day) ? report.registrations_per_day : [])
      .map((row) => ({ date: String(row?.date || row?.day || ''), count: count(row?.count ?? row?.registrations) }))
      .filter((row) => row.date),
    candidates: {
      total: candidates.length,
      byOffice: [...byOffice.entries()].map(([office, total]) => ({ office, count: total })).sort((a, b) => b.count - a.count),
      nomineesTotal: candidates.reduce((sum, c) => sum + count(c?.nominees?.total), 0),
      nomineesVerified: candidates.reduce((sum, c) => sum + count(c?.nominees?.verified), 0),
      reportsFiled: candidates.reduce((sum, c) => sum + count(c?.reports_filed), 0),
    },
    projects: {
      total: realProjects.length,
      byStatus: [...byStatus.entries()].map(([status, total]) => ({ status, count: total })),
      stages,
      wards: projectWards.size,
      byLga: [...projectsByLga.entries()].map(([name, total]) => ({ name, projects: total })),
      byWard: [...projectsByWard.values()],
      byPollingUnit: [...projectsByUnit.values()],
      partial: projectRows.length < statedProjectTotal,
      testRecordsExcluded: projectRows.length - realProjects.length,
    },
    notes: {
      projectStatus: String(raw.notes?.project_status || ''),
    },
  };
}

export function createOyo10xClient({
  baseUrl = process.env.OYO10X_API_URL,
  apiKey = process.env.OYO10X_API_KEY,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  const key = String(apiKey || '').trim();
  let cache = null;          // { data, fetchedAt }
  let inFlight = null;       // de-duplicates concurrent refreshes
  let failures = 0;
  let retryAt = 0;
  let lastError = '';

  const configured = Boolean(url && key);

  const refresh = async () => {
    const response = await fetchImpl(url.endsWith('/all') ? url : `${url}/all`, {
      headers: { 'X-API-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`oyo10x returned HTTP ${response.status}`);
    const contentType = String(response.headers?.get?.('content-type') || '');
    if (!contentType.includes('application/json')) throw new Error('oyo10x did not return JSON');
    const data = sanitizeOyo10x(await response.json());
    cache = { data, fetchedAt: now() };
    failures = 0;
    retryAt = 0;
    lastError = '';
    return cache;
  };

  const snapshot = async () => {
    if (!configured) return { status: 'not-configured', fetchedAt: null, data: null };

    const fresh = cache && now() - cache.fetchedAt < CACHE_TTL_MS;
    if (fresh) return { status: 'ok', fetchedAt: new Date(cache.fetchedAt).toISOString(), data: cache.data };

    // Still inside a back-off window: do not touch their server at all.
    if (now() < retryAt) {
      return cache
        ? { status: 'stale', fetchedAt: new Date(cache.fetchedAt).toISOString(), data: cache.data, error: lastError }
        : { status: 'unavailable', fetchedAt: null, data: null, error: lastError };
    }

    try {
      inFlight ||= refresh().finally(() => { inFlight = null; });
      const result = await inFlight;
      return { status: 'ok', fetchedAt: new Date(result.fetchedAt).toISOString(), data: result.data };
    } catch (error) {
      failures += 1;
      retryAt = now() + Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      lastError = error?.name === 'TimeoutError' ? 'oyo10x did not respond in time' : String(error?.message || 'oyo10x request failed');
      console.warn(`[oyo10x] ${lastError}; next attempt in ${Math.round((retryAt - now()) / 1000)}s`);
      return cache
        ? { status: 'stale', fetchedAt: new Date(cache.fetchedAt).toISOString(), data: cache.data, error: lastError }
        : { status: 'unavailable', fetchedAt: null, data: null, error: lastError };
    }
  };

  return { configured, snapshot };
}

const VIEW_ROLES = ['Admin', 'Super Admin', 'Stakeholder'];

/** Safe dashboard diagnosis without returning URLs, API keys or upstream response bodies. */
export function oyo10xConnectionView(snapshot) {
  const status = snapshot?.status || 'not-configured';
  const error = snapshot?.error || '';
  let message = 'Connected.';
  if (status === 'not-configured') message = 'Configure OYO10X_API_URL and OYO10X_API_KEY on the SIGAR backend, then restart or redeploy it.';
  else if (status !== 'ok') {
    if (/HTTP (401|403)\b/.test(error)) message = '10x rejected API access. Check that the backend API key is active and has access.';
    else if (/HTTP 404\b/.test(error)) message = '10x endpoint was not found. Check the API URL and that the 10x deployment is complete.';
    else if (/respond in time/.test(error)) message = '10x timed out. The connection will retry automatically.';
    else message = '10x is unavailable. Check the 10x deployment and backend connection; retry is automatic.';
    if (status === 'stale') message += ' Showing the last successful figures.';
  }
  return { status, message, fetchedAt: snapshot?.fetchedAt || null };
}

/** Registers the route and returns the client, so other modules share its cache and back-off. */
export function registerOyo10xRoutes({ app, auth, rateLimit, asyncRoute, client = createOyo10xClient() }) {
  if (!client.configured)
    console.warn('[oyo10x] OYO10X_API_URL / OYO10X_API_KEY not set: the grassroots mobilisation panel will show as not connected.');

  app.get(
    '/api/integrations/oyo10x',
    auth,
    rateLimit,
    asyncRoute(async (req, res) => {
      if (!VIEW_ROLES.includes(req.user?.role))
        return res.status(403).json({ message: 'This view is available to stakeholders and administrators.' });
      res.set('Cache-Control', 'private, max-age=30');
      res.json(await client.snapshot());
    }),
  );
  return client;
}
