import { registerTurnRoutes } from './integrations/turn-routes.js';
import { createAccessPolicy } from './modules/identity/access-policy.js';
import { configureHttp } from './middleware/http.js';
import { logEvent, requestId } from './middleware/observability.js';
import { createRuntime } from './bootstrap/runtime.js';
import { deployment } from "./config/deployment.js";
import { registerFieldRealtime } from './modules/field-operations/realtime.js';
import { registerIntelligenceRoutes } from './modules/intelligence/routes.js';
import { registerIrevIntegration } from './integrations/irev.js';
import { registerHistoryRoutes } from './modules/results/history-routes.js';
import { registerBoundaryRoutes } from './modules/geography/boundary-routes.js';
import { registerOperationalViewRoutes } from './modules/geography/operational-view-routes.js';
import { registerAuditRoutes } from './modules/foundation/audit-routes.js';
import { createAiProviders } from './integrations/ai-providers.js';
import { createGeocodingClient } from './integrations/geocoding.js';
import { registerLayerRoutes } from './modules/geography/layer-routes.js';
import { registerCameraRoutes } from './modules/field-operations/camera-routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerIncidentRoutes } from './modules/incidents/routes.js';
import { registerResultRoutes } from './modules/results/routes.js';
import { registerUserRoutes } from './modules/identity/user-routes.js';
import { registerAuthRoutes } from './modules/identity/auth-routes.js';
import { registerReportingRoutes } from './modules/reporting/routes.js';
import { registerStakeholderRoutes } from './modules/stakeholder/routes.js';
import { registerOyo10xRoutes } from './integrations/oyo10x.js';
import { registerVoterSurveyRoutes } from './modules/voter-survey/routes.js';
import { registerPreElectionRoutes } from './modules/pre-election/routes.js';
import { registerReferenceDataRoutes } from './modules/reference-data/routes.js';
import { registerEvidenceRoutes } from './modules/foundation/evidence-routes.js';
import { registerTaskRoutes } from './modules/tasks/routes.js';
import { registerReconciliationRoutes } from './modules/results/reconciliation-routes.js';
import { registerDemographicsRoutes } from './modules/intelligence/demographics-routes.js';
import { registerConnectivityRoutes } from './modules/intelligence/connectivity-routes.js';
import { startTaskWorker } from './modules/tasks/worker.js';
import { registerMediaRoutes } from './modules/field-operations/media-routes.js';
import { registerCameraRecordingRoutes } from './modules/field-operations/camera-recording-routes.js';

import express from "express";
import cors from "cors";

import { createServer } from "node:http";
import { Server } from "socket.io";
import { attachRealtimeCluster } from "./infrastructure/realtime-cluster.js";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createId, createRateLimitState, normalizeText, sanitizeString } from "./security.js";

import { createChatRouter } from "./routes/chat.js";

import {
  adminOnly,
  createAuth,
  isAdminRole,
  superAdminOnly,
} from "./middleware/auth.js";

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const publicUser = ({ password, ...user }) => user;
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const { store, pool, secret, agent1Email, agent2Email, hasCloudflareTurn, hasExpressTurn, expressTurnServers, cloudflareTurnKeyId, cloudflareTurnApiToken, cloudflareTurnTtl, bundledOsunIrevArchive, runtimePolicy } = await createRuntime({ serverDirectory });

const app = express();
const server = createServer(app);
const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  process.env.RENDER_EXTERNAL_URL ||
  "http://127.0.0.1:5173"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const isAllowedOrigin = (origin, callback) =>
  callback(null, !origin || allowedOrigins.includes(origin));
const io = new Server(server, {
  cors: { origin: isAllowedOrigin, credentials: true },
  maxHttpBufferSize: 1_000_000,
  perMessageDeflate: false,
});
await attachRealtimeCluster(io);
const activeCameraShares = new Map();
const loginLimiter = createRateLimitState();
const generalLimiter = createRateLimitState();
const irevOcrLimiter = createRateLimitState();
const socketLimiter = createRateLimitState();
const { reverseLocation } = createGeocodingClient({});

const { openAiPrimaryModel, openAiFallbackModel, groqPrimaryModel, groqFallbackModel, groqNewsModel, geminiVisionModel, geminiApiKeys, callGeminiVision, callGroq, callGroqWithFallback, normalizeNewsTitle, normalizeNewsDate, isOyoStateNews } = createAiProviders({});

const ipLog = [];
const MAX_IP_LOG = 500;
const getClientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";
const logIp = (type, user, incidentId, ip) => {
  ipLog.unshift({
    type,
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    incidentId,
    ip,
    timestamp: new Date().toISOString(),
  });
  if (ipLog.length > MAX_IP_LOG) ipLog.length = MAX_IP_LOG;
};

configureHttp({ app, isAllowedOrigin });
app.use(requestId());

const {
  issueToken,
  sessionCookie,
  clearSessionCookie,
  authenticateToken,
  auth,
  revokeTokenFromRequest,
} = createAuth({
  secret,
  store,
  publicUser,
  asyncRoute,
});

const rateLimit = (req, res, next) => {
  const key = req.ip || "global";
  const result = generalLimiter.hit(key, 120, 60_000);
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  if (!result.allowed) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
    );
    return res
      .status(429)
      .json({ message: "Too many requests. Please try again shortly." });
  }
  next();
};
const loginRateLimit = (req, res, next) => {
  const key = `${req.ip || "global"}:${String(req.body?.email || "")
    .trim()
    .toLowerCase()}`;
  const result = loginLimiter.hit(key, 5, 15 * 60_000);
  if (!result.allowed) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
    );
    return res
      .status(429)
      .json({ message: "Too many login attempts. Please try again later." });
  }
  next();
};
const irevOcrRateLimit = (req, res, next) => {
  const key = `${req.ip || "global"}:${req.user?.id || "anonymous"}`;
  const result = irevOcrLimiter.hit(key, 600, 60_000);
  if (!result.allowed) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
    );
    return res
      .status(429)
      .json({
        code: "OCR_QUEUE_RATE_LIMITED",
        message:
          "The result-sheet queue is busy. OCR will resume automatically.",
      });
  }
  next();
};
const { canManageUsers, visibleUsersFor, canCreateUser, canDeleteUser, canAccessRoom, isSosIncident, canAccessIncident, canSupervisorAssign, emitIncidentToViewers, emitNotification, normalizeKey, canAccessGeography, canAccessUserGeography, emitAuthorized, sosVisibleTo, emitEmergencyAlert } = createAccessPolicy({ io });

app.get("/api/health", rateLimit, (_, res) =>
  res.json({
    ok: true,
    service: deployment.name,
    deployment,
    turn: {
      // `active` is the last observed result, not merely what the env vars claim.
      // Error detail is deliberately omitted here -- this endpoint is unauthenticated.
      primary: turnStatus().configured,
      active: turnStatus().active,
      expressTurnBackup: hasExpressTurn,
    },
  }),
);
const { turnStatus, verifyTurnProvider } = registerTurnRoutes({ app, auth, rateLimit, asyncRoute, hasExpressTurn, hasCloudflareTurn, expressTurnServers, cloudflareTurnKeyId, cloudflareTurnApiToken, cloudflareTurnTtl });
// Exercise the Cloudflare credential path once at boot so an invalid or revoked token is
// visible in the deploy log immediately, rather than surfacing as silent STUN-only relaying
// the first time someone opens a live feed.
if (hasCloudflareTurn)
  verifyTurnProvider().then((status) => {
    if (status.active === 'cloudflare') console.log('[turn] Cloudflare TURN verified and active.');
    else console.error(`[turn] Cloudflare TURN is configured but NOT working (${status.lastError}). Live video will relay through ${status.active}.`);
  });

// Liveness (/api/health above) only says the process is up. Readiness checks whether
// this instance can actually serve traffic -- a real database round trip when one is
// configured, not just "the pool object exists". A misconfigured DATABASE_URL or a
// database outage must fail this, not silently report healthy.
app.get("/api/ready", rateLimit, asyncRoute(async (_req, res) => {
  const checks = { database: pool ? "checking" : "not-configured" };
  if (pool) {
    try {
      await pool.query("select 1");
      checks.database = "ok";
    } catch (error) {
      checks.database = "error";
      checks.databaseError = error.message;
    }
  }
  checks.mediaService = process.env.MEDIA_SERVICE_URL ? "configured" : "not-configured";
  // Every entry in `checks` must stay a scalar -- the System Health tab renders them straight
  // into chips, so an object here crashes that screen. `active` is the verified truth,
  // `turnConfigured` is what the env vars claim; the error detail stays out of this
  // unauthenticated endpoint.
  const turn = turnStatus();
  checks.turn = turn.active;
  checks.turnConfigured = turn.configured;
  const ready = checks.database !== "error";
  res.status(ready ? 200 : 503).json({ ready, checks, checkedAt: new Date().toISOString() });
}));

// Composes existing per-domain signals into one dashboard-style read. This is not an
// alert dispatcher (no email/Slack/PagerDuty integration exists in this codebase) --
// it is the data an external monitor would poll to raise one.
app.get("/api/metrics", auth, adminOnly, rateLimit, asyncRoute(async (_req, res) => {
  const [incidents, pendingOutboxCount, tasks, referenceReleases, auditRecent] = await Promise.all([
    store.incidents(),
    store.countPendingNotificationOutbox(),
    store.tasks({}),
    store.referenceDataReleases({ status: "pending-approval" }),
    store.auditEvents({ limit: 1, since: new Date(Date.now() - 86400000).toISOString() }),
  ]);
  const openIncidents = incidents.filter((item) => !["closed", "resolved"].includes(String(item.status || "").toLowerCase())).length;
  const overdueTasks = tasks.filter((item) => item.status === "overdue").length;
  res.json({
    generatedAt: new Date().toISOString(),
    incidents: { total: incidents.length, open: openIncidents },
    notificationOutbox: { pending: pendingOutboxCount },
    tasks: { total: tasks.length, overdue: overdueTasks },
    referenceData: { pendingApproval: referenceReleases.length },
    audit: { eventsLast24h: auditRecent.total },
    limitations: ["No alert dispatch is wired to these numbers; an external monitor must poll this endpoint."],
  });
}));

registerBoundaryRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store });
registerOperationalViewRoutes({ app, auth, rateLimit, asyncRoute, store, canAccessGeography });
registerAuditRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store });
app.get('/api/security/policy', auth, adminOnly, rateLimit, (_req, res) => res.json(runtimePolicy));
app.get('/api/security/access-review', auth, adminOnly, rateLimit, asyncRoute(async (_req, res) => {
  res.json(await store.accessReviewStatus({ cadenceDays: runtimePolicy.accessReview.cadenceDays }));
}));

registerHistoryRoutes({ app, auth, rateLimit, asyncRoute });

// Retain legacy pilot data without exposing it as this deployment's election.
app.use('/api/irev/osun', (_req, res, next) => process.env.ENABLE_OSUN_PILOT !== 'false' ? next() : res.status(404).json({ message: 'Osun pilot is disabled for the Oyo deployment.' }));
const { IREV_OYO_ELECTION_ID, loadOyoIrev, loadOsunIrevPilot } = registerIrevIntegration({ app, auth, adminOnly, rateLimit, irevOcrRateLimit, asyncRoute, store, isAdminRole, geminiApiKeys, geminiVisionModel, callGeminiVision, bundledOsunIrevArchive });

registerIntelligenceRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, canAccessGeography, reverseLocation, openAiPrimaryModel, openAiFallbackModel, groqPrimaryModel, groqFallbackModel, groqNewsModel, callGroq, callGroqWithFallback, normalizeNewsTitle, normalizeNewsDate, isOyoStateNews });
registerReportingRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, canAccessGeography });
registerStakeholderRoutes({ app, auth, rateLimit, asyncRoute, store });
const oyo10x = registerOyo10xRoutes({ app, auth, rateLimit, asyncRoute });
registerVoterSurveyRoutes({ app, auth, rateLimit, asyncRoute, store, openAiPrimaryModel, openAiFallbackModel, callGroqWithFallback, geminiApiKeys });
registerPreElectionRoutes({ app, auth, rateLimit, asyncRoute, store, geminiApiKeys, callGroqWithFallback, openAiPrimaryModel, oyo10x });
registerReferenceDataRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store });
registerEvidenceRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, canAccessIncident });

app.get("/api/admin/ip-log", auth, adminOnly, rateLimit, (req, res) => {
  const { userId, type, limit = 200 } = req.query;
  let results = ipLog;
  if (userId) results = results.filter((entry) => entry.userId === userId);
  if (type) results = results.filter((entry) => entry.type === type);
  res.json(results.slice(0, Number(limit)));
});
registerAuthRoutes({ app, auth, rateLimit, loginRateLimit, asyncRoute, store, agent1Email, agent2Email, publicUser, issueToken, sessionCookie, clearSessionCookie, revokeTokenFromRequest });

registerUserRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, io, publicUser, visibleUsersFor, canManageUsers, canCreateUser, canDeleteUser, superAdminOnly, emitAuthorized });

registerResultRoutes({ app, auth, rateLimit, adminOnly, superAdminOnly, asyncRoute, store, io, normalizeKey, logIp, getClientIp, emitIncidentToViewers });

registerIncidentRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, io, isAdminRole, canAccessIncident, canSupervisorAssign, emitIncidentToViewers, emitNotification, logIp, getClientIp, isSosIncident, sosVisibleTo, emitEmergencyAlert, emitAuthorized });

registerNotificationRoutes({ app, auth, rateLimit, asyncRoute, store });
registerTaskRoutes({ app, auth, rateLimit, asyncRoute, store });
registerReconciliationRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store });
registerDemographicsRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store });
registerConnectivityRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store });

registerCameraRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, io, emitAuthorized, canAccessGeography });
registerMediaRoutes({ app, auth, rateLimit, asyncRoute, store, canAccessGeography, secret });
registerCameraRecordingRoutes({ app, auth, adminOnly, rateLimit, asyncRoute, store, canAccessGeography });

registerLayerRoutes({ app, auth, superAdminOnly, rateLimit, asyncRoute, store, io, isAdminRole, emitAuthorized });

app.use(
  "/api/chat",
  createChatRouter({
    auth,
    rateLimit,
    asyncRoute,
    store,
    io,
    canManageUsers,
    visibleUsersFor,
    canAccessRoom,
    isAdminRole,
    createId,
    normalizeText,
    sanitizeString,
    emitNotification,
  }),
);

registerFieldRealtime({ app, auth, rateLimit, io, store, socketLimiter, authenticateToken, activeCameraShares, isAdminRole, reverseLocation, logIp, emitEmergencyAlert, canAccessUserGeography });
const taskWorker = startTaskWorker({ store, emitNotification });

app.use((err, req, res, _next) => {
  logEvent("error", err?.message || "Unhandled request error", {
    requestId: req?.id || "",
    path: req?.path || "",
    method: req?.method || "",
    stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
  });
  res.status(500).json({ message: "Server error. Please check logs.", requestId: req?.id || "" });
});

const enableIrevAutoSync = process.env.IREV_AUTO_SYNC === "true";
if (enableIrevAutoSync && IREV_OYO_ELECTION_ID) {
  const syncIrevArchive = () =>
    loadOyoIrev(true).catch((error) =>
      console.warn(
        "[irev] Background Oyo archive update failed:",
        error.message,
      ),
    );
  const initialIrevSync = setTimeout(syncIrevArchive, 5_000);
  initialIrevSync.unref?.();
  const recurringIrevSync = setInterval(syncIrevArchive, 5 * 60_000);
  recurringIrevSync.unref?.();
} else if (!IREV_OYO_ELECTION_ID) {
  console.log(
    "[irev] Oyo 2027 feed is dormant until IREV_OYO_ELECTION_ID is configured.",
  );
}

if (enableIrevAutoSync && process.env.ENABLE_OSUN_PILOT !== "false") {
  const osunIrevArchiveSync = () =>
    loadOsunIrevPilot(true).catch((error) =>
      console.warn(
        "[irev] Background Osun archive update failed:",
        error.message,
      ),
    );
  const initialOsunIrevSync = setTimeout(osunIrevArchiveSync, 2_000);
  initialOsunIrevSync.unref?.();
  const recurringOsunIrevSync = setInterval(osunIrevArchiveSync, 60_000);
  recurringOsunIrevSync.unref?.();
} else {
  console.log(
    "[irev] Background sync disabled; serving the persistent archive.",
  );
}

app.use('/api', (_req, res) => res.status(404).json({ message: 'API endpoint not found' }));

if (process.env.NODE_ENV === "production" && process.env.API_ONLY !== "true") {
  const distDirectory = join(serverDirectory, "..", "dist");
  app.use(
    express.static(distDirectory, {
      setHeaders: (res, filePath) => {
        const normalizedPath = filePath.replace(/\\/g, "/");
        if (normalizedPath.includes("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (
          normalizedPath.endsWith("/service-worker.js") ||
          normalizedPath.endsWith("/index.html")
        ) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  app.get(/.*/, (_, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(join(distDirectory, "index.html"));
  });
}
server.listen(process.env.PORT || 5000, "0.0.0.0", () =>
  console.log(
    `Oyo Election Intelligence API listening on port ${server.address().port}`,
  ),
);
