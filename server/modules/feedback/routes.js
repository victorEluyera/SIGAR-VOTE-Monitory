import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { recordAudit } from '../foundation/audit-helper.js';
import { createRateLimitState } from '../../security.js';
import { withBaseline } from '../pre-election/baseline.js';
import { oyoGeo } from '../pre-election/geo.js';
import { matchLga } from '../pre-election/lga.js';
import { buildFeedbackAnalysis } from './analysis.js';
import { formDefinition, validateSubmission } from './form.js';

const CAN_VIEW = ['Stakeholder', 'Admin', 'Super Admin'];
const CAN_MANAGE = ['Admin', 'Super Admin'];
const MIN_FILL_MS = 8_000;          // faster than a person can read ten questions
const MAX_FORM_AGE_MS = 12 * 3_600_000;
const MAX_BODY_BYTES = 16 * 1024;
// Many phones share one IP on Nigerian mobile networks (carrier NAT), so the per-IP ceiling is high;
// the real guard against repeats is that each loaded form can be submitted once.
const PER_IP_PER_LINK_PER_HOUR = 120;

/**
 * Public (no login):
 *   GET  /api/public/feedback/:token                 the form for a share link
 *   GET  /api/public/feedback/:token/places?lga=&ward=   wards of an LGA, or units of a ward
 *   POST /api/public/feedback/:token                 submit answers
 * Signed in:
 *   GET  /api/feedback/analysis?lga=                 feedback analysis (stakeholders, admins)
 *   GET  /api/feedback/links                         share links with their response counts (admins)
 *   POST /api/feedback/links                         create a link { label, lga? } (admins)
 *   PUT  /api/feedback/links/:id                     { active } switch a link on or off (admins)
 *   GET  /api/feedback/projects                      proposed projects voters rate (admins)
 *   POST /api/feedback/projects                      add one { title, lga, ward?, candidate? } (admins)
 *   PUT  /api/feedback/projects/:id                  { active } (admins)
 *
 * A field agent who opens a link while signed in is credited with the answers automatically
 * (question 18); for everyone else the answer is anonymous.
 *
 * The public form is open to anyone with a link, so it is guarded: a signed, single-use start
 * token per loaded form (so one form cannot be replayed, and instant submissions are refused), a
 * hidden field only bots fill in, a generous per-IP ceiling (shared mobile IPs are common), strict
 * answer checking and a small size cap. It collects no names, phones or voter numbers.
 */
export function registerFeedbackRoutes({ app, auth, rateLimit, asyncRoute, store, oyo10x = null, authenticateToken = null, secret = process.env.JWT_SECRET || randomBytes(32).toString('hex') }) {
  const submitLimiter = createRateLimitState();
  // Start tokens already used, with when they expire; pruned as it grows.
  const usedStarts = new Map();
  const markUsed = (value) => {
    const now = Date.now();
    if (usedStarts.size > 50_000) for (const [key, expires] of usedStarts) if (expires < now) usedStarts.delete(key);
    usedStarts.set(value, now + MAX_FORM_AGE_MS);
  };
  const sign = (value) => createHmac('sha256', `${secret}:feedback`).update(String(value)).digest('base64url');
  const startToken = (token) => { const at = Date.now(); return `${at}.${sign(`${token}|${at}`)}`; };
  const startedAt = (token, value) => {
    const [at, mac] = String(value || '').split('.');
    if (!at || !mac) return null;
    const expected = Buffer.from(sign(`${token}|${at}`));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given) ? Number(at) : null;
  };
  const activeLink = async (req, res) => {
    const link = await store.feedbackLinkByToken(String(req.params.token || '').slice(0, 40));
    if (!link || !link.active) { res.status(404).json({ message: 'This feedback link is not active. Ask whoever shared it for a new one.' }); return null; }
    return link;
  };

  app.get('/api/public/feedback/:token', rateLimit, asyncRoute(async (req, res) => {
    const link = await activeLink(req, res);
    if (!link) return;
    res.set('Cache-Control', 'no-store');
    res.json({ form: formDefinition(link), started: startToken(link.token) });
  }));

  app.get('/api/public/feedback/:token/places', rateLimit, asyncRoute(async (req, res) => {
    const link = await activeLink(req, res);
    if (!link) return;
    const lga = matchLga(link.lga || req.query.lga);
    const geo = lga ? oyoGeo().lgas.get(lga) : null;
    if (!geo) return res.json({ wards: [], units: [] });
    const ward = req.query.ward ? geo.wards.get(Number(req.query.ward)) : null;
    const projects = (await store.feedbackProjects()).filter((project) => project.active && project.lga === lga && (project.ward == null || project.ward === ward?.number));
    res.set('Cache-Control', 'no-store');
    res.json({
      wards: geo.wardList.map((item) => ({ number: item.number, name: item.name })),
      units: ward ? ward.units.map((unit) => ({ number: unit.number, name: unit.name })) : [],
      projects: projects.map((project) => ({ id: project.id, title: project.title, candidate: project.candidate, ward: project.ward })),
    });
  }));

  app.post('/api/public/feedback/:token', asyncRoute(async (req, res) => {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return res.status(413).json({ message: 'That submission is too large.' });
    const ip = req.ip || 'unknown';
    const limit = submitLimiter.hit(`${ip}:${req.params.token}`, PER_IP_PER_LINK_PER_HOUR, 60 * 60_000);
    if (!limit.allowed) return res.status(429).json({ message: 'Too many answers from this network just now. Please try again in a little while.' });
    const link = await activeLink(req, res);
    if (!link) return;
    // Bots fill every field; people never see this one.
    if (req.body?.website) return res.status(201).json({ ok: true });
    const started = startedAt(link.token, req.body?.started);
    const age = started ? Date.now() - started : null;
    if (age === null || age > MAX_FORM_AGE_MS) return res.status(400).json({ message: 'This form has expired. Reload the page and try again.' });
    if (age < MIN_FILL_MS) return res.status(400).json({ message: 'Please take a moment to read the questions before submitting.' });
    if (usedStarts.has(req.body.started)) return res.status(409).json({ message: 'These answers were already sent. Thank you.' });
    const checked = validateSubmission(req.body, link, { projects: await store.feedbackProjects() });
    if (checked.error) return res.status(400).json({ message: checked.error });
    // 18. A signed-in field agent is credited automatically; a bad or missing token just means anonymous.
    let collectedBy = '';
    const bearer = String(req.headers.authorization || '');
    if (authenticateToken && bearer.startsWith('Bearer ')) {
      try { collectedBy = (await authenticateToken(bearer.slice(7)))?.id || ''; } catch { collectedBy = ''; }
    }
    markUsed(req.body.started);
    await store.addFeedbackResponse({ linkId: link.id, ...checked.value, collectedBy });
    res.status(201).json({ ok: true });
  }));

  // ---- Signed-in: analysis and link management ------------------------------------------------
  const cache = new Map();
  app.get('/api/feedback/analysis', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_VIEW.includes(req.user?.role)) return res.status(403).json({ message: 'Feedback analysis is available to stakeholders and administrators.' });
    const [responses, links, projects, survey, uploaded, snapshot] = await Promise.all([
      store.feedbackResponses(), store.feedbackLinks(), store.feedbackProjects(), store.voterSurvey(), store.preElectionDatasets(), oyo10x ? oyo10x.snapshot() : null,
    ]);
    const canManage = CAN_MANAGE.includes(req.user.role);
    // Agent names are for administrators only; stakeholders see counts.
    const agents = canManage ? new Map((await store.users()).map((user) => [user.id, user.name])) : null;
    const centerSet = withBaseline(uploaded).filter((item) => item.kind === 'contact-center').sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0] || null;
    const lga = String(req.query.lga || '').slice(0, 80);
    const key = `${responses.length}|${responses.at(-1)?.id || ''}|${links.length}|${projects.length}|${survey?.id || ''}|${centerSet?.id || ''}|${snapshot?.fetchedAt || ''}|${lga}|${canManage}`;
    if (!cache.has(key)) {
      if (cache.size > 100) cache.clear();
      cache.set(key, buildFeedbackAnalysis({ survey, responses, links, projects, centerSet, tenx: snapshot?.data || null, lga, agents }));
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ ...cache.get(key), canManage });
  }));

  app.get('/api/feedback/links', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_MANAGE.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can manage feedback links.' });
    const [links, responses] = await Promise.all([store.feedbackLinks(), store.feedbackResponses()]);
    const counts = new Map();
    for (const response of responses) counts.set(response.linkId, (counts.get(response.linkId) || 0) + 1);
    res.json(links.map((link) => ({ ...link, responses: counts.get(link.id) || 0 })));
  }));

  app.post('/api/feedback/links', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_MANAGE.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can manage feedback links.' });
    const label = String(req.body?.label || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!label) return res.status(400).json({ message: 'Give the link a name, e.g. "WhatsApp – Ibadan North".' });
    const lga = req.body?.lga ? matchLga(req.body.lga) : '';
    if (req.body?.lga && !lga) return res.status(400).json({ message: 'That is not an Oyo LGA.' });
    const link = await store.createFeedbackLink({ label, lga, createdBy: req.user.id });
    await recordAudit(store, req, { action: 'feedback_link.created', entityType: 'feedback_link', entityId: link.id, details: { label, lga } });
    res.status(201).json({ ...link, responses: 0 });
  }));

  app.put('/api/feedback/links/:id', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_MANAGE.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can manage feedback links.' });
    const link = await store.setFeedbackLinkActive(String(req.params.id), req.body?.active !== false);
    if (!link) return res.status(404).json({ message: 'That link was not found.' });
    await recordAudit(store, req, { action: link.active ? 'feedback_link.activated' : 'feedback_link.deactivated', entityType: 'feedback_link', entityId: link.id });
    res.json(link);
  }));

  app.get('/api/feedback/projects', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_MANAGE.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can manage projects.' });
    res.json(await store.feedbackProjects());
  }));

  app.post('/api/feedback/projects', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_MANAGE.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can manage projects.' });
    const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) return res.status(400).json({ message: 'Name the project, e.g. "Borehole at Oja Oba".' });
    const lga = matchLga(req.body?.lga);
    if (!lga) return res.status(400).json({ message: 'Choose the LGA the project is for.' });
    let ward = null;
    if (req.body?.ward) {
      const place = oyoGeo().lgas.get(lga)?.wards.get(Number(req.body.ward));
      if (!place) return res.status(400).json({ message: 'That ward is not in the chosen LGA.' });
      ward = place.number;
    }
    const candidate = String(req.body?.candidate || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const project = await store.createFeedbackProject({ title, lga, ward, candidate, createdBy: req.user.id });
    await recordAudit(store, req, { action: 'feedback_project.created', entityType: 'feedback_project', entityId: project.id, details: { title, lga, ward } });
    res.status(201).json(project);
  }));

  app.put('/api/feedback/projects/:id', auth, rateLimit, asyncRoute(async (req, res) => {
    if (!CAN_MANAGE.includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can manage projects.' });
    const project = await store.setFeedbackProjectActive(String(req.params.id), req.body?.active !== false);
    if (!project) return res.status(404).json({ message: 'That project was not found.' });
    res.json(project);
  }));
}
