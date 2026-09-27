import { useEffect, useMemo, useState } from "react";
import { FaSearch, FaSyncAlt, FaTimes } from "react-icons/fa";
import { MdFlashOn, MdWarning } from "react-icons/md";
import { API_BASE_URL } from "../../config.js";
import { apiRequest as request } from "../../api/client.js";
import PreElectionAnalysis from "./PreElectionAnalysis.jsx";
import AnalyticsPanel from "./AnalyticsPanel.jsx";
import AiGenerationBadge from "./AiGenerationBadge.jsx";
import ReconciliationReview from "./ReconciliationReview.jsx";
import { EvidenceThumb } from "./EvidenceMedia.jsx";
import OverVotingCheck from "./OverVotingCheck.jsx";

export default function ResultsCenter({ incidents, parties = [], officers = [], personnel = [], mapLayers = [], selected, onClose, authToken, canAdmin = false, initialFocusParty = "", initialView = "pulse", onPartyMapChange, onFocusLocation, onTool, onCsv, onClear, helpers }) {
  const { parseResultEntries, POLLING_RESULT_TYPE, RESULT_SOURCES } = helpers;

  const [view, setView] = useState(initialView);
  const [resultSourceFilter, setResultSourceFilter] = useState("");
  const [focusParty, setFocusParty] = useState(initialFocusParty);
  const [outlook, setOutlook] = useState("");
  const [outlookMeta, setOutlookMeta] = useState(null);
  const [outlookLoading, setOutlookLoading] = useState(false);
  const [postElectionBrief, setPostElectionBrief] = useState("");
  const [postElectionBriefMeta, setPostElectionBriefMeta] = useState(null);
  const [postElectionLoading, setPostElectionLoading] = useState(false);
  const [irevPilot, setIrevPilot] = useState(null);
  const [irevPublishedResults, setIrevPublishedResults] = useState(null);
  const [irevLoading, setIrevLoading] = useState(false);
  const [irevError, setIrevError] = useState("");
  const [irevSection, setIrevSection] = useState("uploads");
  const [irevSearch, setIrevSearch] = useState("");
  const [irevPreview, setIrevPreview] = useState(null);
  const [irevPreviewLoading, setIrevPreviewLoading] = useState("");
  const [compareWithIrev, setCompareWithIrev] = useState(false);
  const [irevCompareLoading, setIrevCompareLoading] = useState(false);
  const [fieldMismatchDetail, setFieldMismatchDetail] = useState(null);
  const focusedPreElection = initialView === "pre" || view === "pre";
  const focusedPostElection = initialView === "post" || view === "post";
  useEffect(() => {
    setView(initialView);
  }, [initialView]);
  const loadIrevPilot = async (force = false) => {
    setIrevLoading(true);
    setIrevError("");
    try {
      const pilot = await request(`/irev/osun${force ? "?refresh=1" : ""}`, authToken);
      setIrevPilot(pilot);
      return pilot;
    } catch (error) {
      setIrevError(error.message || "The official IReV feed is unavailable.");
      return null;
    } finally {
      setIrevLoading(false);
    }
  };
  useEffect(() => {
    if (!["irev", "post"].includes(view)) return undefined;
    let stopped = false;
    let timer = null;
    const poll = async () => {
      const pilot = await loadIrevPilot();
      const refreshInterval = Number(pilot?.refreshIntervalMs || 0);
      if (!stopped && !pilot?.pollingStopped && refreshInterval > 0) {
        timer = window.setTimeout(poll, Math.max(60_000, refreshInterval));
      }
    };
    poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [view, authToken]);
  useEffect(() => {
    if (!["irev", "post"].includes(view) || irevPublishedResults) return;
    request("/irev/osun/results", authToken)
      .then(setIrevPublishedResults)
      .catch(error => setIrevError(error.message || "Prepared Osun results are unavailable."));
  }, [view, authToken, irevPublishedResults]);
  const closeIrevPreview = () => {
    if (irevPreview?.objectUrl) URL.revokeObjectURL(irevPreview.imageUrl);
    setIrevPreview(null);
  };
  const openIrevPreview = async (upload) => {
    setIrevError("");
    if (upload.imageUrl) {
      setIrevPreview(upload);
      return;
    }
    setIrevPreviewLoading(upload.id);
    try {
      const liveUpload = await request(`/irev/osun/uploads/${encodeURIComponent(upload.puCode)}`, authToken);
      const imageResponse = await fetch(`${API_BASE_URL}${liveUpload.imageUrl}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!imageResponse.ok) throw new Error(`The official result sheet could not be loaded (${imageResponse.status}).`);
      const imageBlob = await imageResponse.blob();
      if (!imageBlob.type.startsWith("image/")) throw new Error("The official result-sheet file is not an image.");
      setIrevPreview({ ...upload, ...liveUpload, imageUrl: URL.createObjectURL(imageBlob), objectUrl: true });
    } catch (error) {
      setIrevError(error.message || "The official result-sheet image is temporarily unavailable.");
    } finally {
      setIrevPreviewLoading("");
    }
  };
  const reports = useMemo(
    () => incidents.filter((item) => item.reportType === POLLING_RESULT_TYPE),
    [incidents],
  );
  const summary = useMemo(() => {
    const rows = reports.map((report) => {
      let results = [];
      try { const parsed = JSON.parse(report.resultCount || "[]"); if (Array.isArray(parsed)) results = parsed; } catch { results = parseResultEntries(report.resultCount).map(item => ({ party: item.label, votes: item.value })); }
      const creatorRole = personnel.find((person) => person.id === report.createdBy)?.role || officers.find((officer) => officer.id === report.createdBy)?.role;
      const resultSource = report.style?.resultSource || (creatorRole === "Supervisor" ? "Supervisor" : creatorRole === "Admin" || creatorRole === "Super Admin" ? "INEC IReV" : "Agent");
      return { ...report, results, resultSource };
    });
    const historicalParties = rows.flatMap(row => row.results.map(item => item.party));
    const partyNames = [...new Set([...parties, ...historicalParties].filter(Boolean))];
    const totals = Object.fromEntries(partyNames.map(party => [party, rows.reduce((sum, row) => sum + Number(row.results.find(item => item.party === party)?.votes || 0), 0)]));
    return {
      partyNames, totals,
      rows: rows.sort((a, b) => `${a.lga}${a.ward}${a.pollingUnit}`.localeCompare(`${b.lga}${b.ward}${b.pollingUnit}`)),
    };
  }, [reports, parties, personnel, officers]);
  const sourceStats = useMemo(() => RESULT_SOURCES.map((source) => {
    const rows = summary.rows.filter((row) => row.resultSource === source);
    const liveIrevUploads = source === "INEC IReV" ? Number(irevPilot?.submitted || 0) : 0;
    return {
      source,
      submissions: Math.max(rows.length, liveIrevUploads),
      units: new Set(rows.map((row) => `${row.lga}|${row.ward}|${row.pollingUnit}`)).size,
      votes: rows.reduce((total, row) => total + row.results.reduce((sum, item) => sum + Number(item.votes || 0), 0), 0),
      liveIrevUploads,
    };
  }), [summary.rows, irevPilot]);
  const fieldResultRows = useMemo(() => summary.rows.filter((row) => row.resultSource !== "INEC IReV"), [summary.rows]);
  const fieldResultTotals = useMemo(() => Object.fromEntries(summary.partyNames.map((party) => [party, fieldResultRows.reduce((total, row) => total + Number(row.results.find((item) => item.party === party)?.votes || 0), 0)])), [fieldResultRows, summary.partyNames]);
  const fieldTopParties = useMemo(() => Object.keys(fieldResultTotals).filter((party) => fieldResultTotals[party] > 0).sort((a, b) => fieldResultTotals[b] - fieldResultTotals[a]).slice(0, 6), [fieldResultTotals]);
  const displayedResultRows = useMemo(
    () => resultSourceFilter ? fieldResultRows.filter((row) => row.resultSource === resultSourceFilter) : fieldResultRows,
    [fieldResultRows, resultSourceFilter],
  );
  const normalizeResultKeyPart = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const resultUnitKey = (row) => [row.lga, row.ward, row.pollingUnit].map(normalizeResultKeyPart).join("|");
  const fieldRowsByUnit = useMemo(() => {
    const units = new Map();
    fieldResultRows.forEach((row) => {
      const key = resultUnitKey(row);
      if (!units.has(key)) units.set(key, {});
      const current = units.get(key)[row.resultSource];
      if (!current || new Date(row.createdAt).getTime() >= new Date(current.createdAt).getTime()) units.get(key)[row.resultSource] = row;
    });
    return units;
  }, [fieldResultRows]);
  const filteredIrevUploads = useMemo(() => {
    const query = irevSearch.trim().toLowerCase();
    const uploads = irevPilot?.uploads || [];
    if (!query) return uploads;
    return uploads.filter((upload) => [upload.puCode, upload.pollingUnit, upload.ward, upload.lga].some((value) => String(value || "").toLowerCase().includes(query)));
  }, [irevPilot, irevSearch]);
  const irevResultRows = useMemo(() => irevPublishedResults?.pollingUnits || [], [irevPublishedResults]);
  const filteredIrevResultRows = useMemo(() => {
    const query = irevSearch.trim().toLowerCase();
    if (!query) return irevResultRows;
    return irevResultRows.filter((row) => [row.puCode, row.pollingUnit, row.ward, row.lga].some(value => String(value || "").toLowerCase().includes(query)));
  }, [irevResultRows, irevSearch]);
  const irevRowsByUnit = useMemo(() => new Map(irevResultRows.map((row) => [resultUnitKey(row), row])), [irevResultRows]);
  const irevOnlyTotals = useMemo(() => Object.fromEntries((irevPublishedResults?.totals || []).map(({ party, votes }) => [party, Number(votes || 0)])), [irevPublishedResults]);
  const irevTopParties = useMemo(() => Object.keys(irevOnlyTotals).filter((party) => irevOnlyTotals[party] > 0).sort((a, b) => irevOnlyTotals[b] - irevOnlyTotals[a]).slice(0, 5), [irevOnlyTotals]);
  const top6 = useMemo(() => summary.partyNames.filter((party) => summary.totals[party] > 0).sort((a,b) => summary.totals[b]-summary.totals[a]).slice(0,6), [summary]);
  const winLoss = useMemo(() => {
    const groups = (key) => {
      const map = new Map();
      for (const row of summary.rows) { const id = key(row); if (!map.has(id)) map.set(id, { label: id, rows: [] }); map.get(id).rows.push(row); }
      return [...map.values()].map(group => {
        const votes = Object.fromEntries(summary.partyNames.map(p => [p, group.rows.reduce((n,r) => n + Number(r.results.find(x => x.party === p)?.votes || 0), 0)]));
        const max = Math.max(0, ...Object.values(votes));
        const leaders = max ? summary.partyNames.filter(p => votes[p] === max) : [];
        return { ...group, votes, max, leaders, winner: leaders.length === 1 ? leaders[0] : null, tied: leaders.length > 1 };
      });
    };
    return { wards: groups(r => `${r.lga || "Unknown LGA"} / ${r.ward || "Unknown Ward"}`), lgas: groups(r => r.lga || "Unknown LGA") };
  }, [summary]);
  const forecast = useMemo(() => {
    const total = Object.values(summary.totals).reduce((a, b) => a + b, 0);
    const ranked = summary.partyNames.slice().sort((a,b) => summary.totals[b] - summary.totals[a]);
    const leader = ranked[0] || null;
    const second = ranked[1] ? summary.totals[ranked[1]] : 0;
    const margin = leader ? summary.totals[leader] - second : 0;
    const coverage = new Set(summary.rows.map(r => `${r.lga}|${r.ward}|${r.pollingUnit}`)).size;
    return { leader, margin, total, coverage, confidence: total && leader ? Math.min(99, Math.round((summary.totals[leader] / total) * 100 + Math.min(20, coverage / 10))) : 0 };
  }, [summary]);
  const partyAnalysis = useMemo(() => {
    if (!focusParty || view !== "action") return null;
    const wards = winLoss.wards.filter(g => g.winner === focusParty).length;
    const assessedLgas = winLoss.lgas.filter(g => g.max > 0);
    const winningLgas = assessedLgas.filter(g => g.winner === focusParty).map(g => {
      const runnerUp = Object.entries(g.votes).filter(([party]) => party !== focusParty).sort((a, b) => b[1] - a[1])[0] || ["No challenger", 0];
      return { name: g.label, votes: g.votes[focusParty] || 0, opponent: runnerUp[0], opponentVotes: runnerUp[1], margin: (g.votes[focusParty] || 0) - runnerUp[1] };
    }).sort((a, b) => b.margin - a.margin);
    const losingLgas = assessedLgas.filter(g => g.winner && g.winner !== focusParty).map(g => ({
      name: g.label,
      votes: g.votes[focusParty] || 0,
      opponent: g.winner,
      opponentVotes: g.votes[g.winner] || 0,
      margin: (g.votes[g.winner] || 0) - (g.votes[focusParty] || 0)
    })).sort((a, b) => b.margin - a.margin);
    const tiedLgas = assessedLgas.filter(g => g.tied && g.leaders.includes(focusParty)).map(g => g.label);
    const incidentsForParty = incidents.filter(i => String(i.description || "").toLowerCase().includes(focusParty.toLowerCase())).length;
    return { votes: summary.totals[focusParty] || 0, wards, lgas: winningLgas.length, winningLgas, losingLgas, tiedLgas, incidents: incidentsForParty };
  }, [focusParty, incidents, summary, winLoss, view]);
  useEffect(() => {
    if (!onPartyMapChange) return;
    if (!focusParty || !partyAnalysis) {
      onPartyMapChange(null);
      return;
    }
    const byLga = {};
    partyAnalysis.winningLgas.forEach(item => { byLga[item.name] = { ...item, status: "winning" }; });
    partyAnalysis.losingLgas.forEach(item => { byLga[item.name] = { ...item, status: "losing" }; });
    partyAnalysis.tiedLgas.forEach(name => { byLga[name] = { name, status: "tied" }; });
    onPartyMapChange({ party: focusParty, byLga });
  }, [focusParty, partyAnalysis, onPartyMapChange]);
  const actionableIntel = useMemo(() => {
    const critical = incidents.filter(i => i.severity === "Critical" || i.reportType === "SOS-Emergency").length;
    const open = incidents.filter(i => !["resolved", "closed", "submitted"].includes(String(i.status || "").toLowerCase())).length;
    return { critical, otherOpen: Math.max(0, open - critical) };
  }, [incidents]);
  const postElection = useMemo(() => {
    const unitKey = (row) => `${row.lga || ""}|${row.ward || ""}|${row.pollingUnit || ""}`;
    const compareResults = (left, right) => summary.partyNames.every((party) => {
      const partyKey = normalizeResultKeyPart(party);
      const leftVotes = Number(left?.results?.find((item) => normalizeResultKeyPart(item.party) === partyKey)?.votes || 0);
      const rightVotes = Number(right?.results?.find((item) => normalizeResultKeyPart(item.party) === partyKey)?.votes || 0);
      return leftVotes === rightVotes;
    });
    const fieldMismatches = [...fieldRowsByUnit.entries()].filter(([, pair]) => pair.Agent && pair.Supervisor && !compareResults(pair.Agent, pair.Supervisor));
    const irevMismatches = [...fieldRowsByUnit.entries()].filter(([key, pair]) => {
      const official = irevRowsByUnit.get(key);
      const field = pair.Supervisor || pair.Agent;
      return official && field && !compareResults(field, official);
    });
    const uniqueSourceUnits = new Set(summary.rows.map((row) => `${unitKey(row)}|${row.resultSource}`));
    const duplicates = Math.max(0, summary.rows.length - uniqueSourceUnits.size);
    const missingEvidence = fieldResultRows.filter((row) => !Array.isArray(row.media) || row.media.length === 0);
    const zeroVoteSheets = fieldResultRows.filter((row) => row.results.reduce((sum, item) => sum + Number(item.votes || 0), 0) === 0);
    const fieldPairCount = [...fieldRowsByUnit.values()].filter((pair) => pair.Agent && pair.Supervisor).length;
    const irevComparableCount = [...fieldRowsByUnit.keys()].filter((key) => irevRowsByUnit.has(key)).length;
    const readinessPenalty = (missingEvidence.length / Math.max(1, fieldResultRows.length)) * 35
      + (fieldMismatches.length / Math.max(1, fieldPairCount)) * 25
      + (irevMismatches.length / Math.max(1, irevComparableCount)) * 25
      + (duplicates / Math.max(1, summary.rows.length)) * 10
      + (zeroVoteSheets.length / Math.max(1, fieldResultRows.length)) * 5;
    const readinessScore = summary.rows.length ? Math.max(0, Math.min(100, 100 - Math.round(readinessPenalty))) : 0;

    const canonicalRows = [...fieldRowsByUnit.values()].map((pair) => pair.Supervisor || pair.Agent).filter(Boolean);
    const spatialGroups = new Map();
    canonicalRows.forEach((row) => {
      const label = `${row.lga || "Unknown LGA"} / ${row.ward || "Unknown Ward"}`;
      if (!spatialGroups.has(label)) spatialGroups.set(label, []);
      spatialGroups.get(label).push(row);
    });
    const wardSpatial = [...spatialGroups.entries()].map(([label, rows]) => {
      const votes = Object.fromEntries(summary.partyNames.map((party) => [party, rows.reduce((sum, row) => sum + Number(row.results.find((item) => item.party === party)?.votes || 0), 0)]));
      const max = Math.max(0, ...Object.values(votes));
      const leaders = max ? summary.partyNames.filter((party) => votes[party] === max) : [];
      const group = { label, rows, votes, winner: leaders.length === 1 ? leaders[0] : null };
      const totalVotes = Object.values(group.votes).reduce((sum, value) => sum + Number(value || 0), 0);
      const ranked = Object.entries(group.votes).sort((a, b) => b[1] - a[1]);
      const margin = Number(ranked[0]?.[1] || 0) - Number(ranked[1]?.[1] || 0);
      const [lga, ward] = group.label.split(" / ");
      const relatedIncidents = incidents.filter((item) => item.reportType !== POLLING_RESULT_TYPE && normalizeResultKeyPart(item.lga) === normalizeResultKeyPart(lga) && normalizeResultKeyPart(item.ward) === normalizeResultKeyPart(ward));
      const point = group.rows.find((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)));
      return { ...group, lga, ward, totalVotes, margin, reports: group.rows.length, incidentCount: relatedIncidents.length, criticalCount: relatedIncidents.filter((item) => item.severity === "Critical" || item.reportType === "SOS-Emergency").length, lat: Number(point?.lat), lng: Number(point?.lng) };
    }).sort((a, b) => b.totalVotes - a.totalVotes);

    const chronological = canonicalRows.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const trendParties = top6.slice(0, 4);
    const running = Object.fromEntries(trendParties.map((party) => [party, 0]));
    let runningAllVotes = 0;
    const trendPoints = chronological.map((row, index) => {
      trendParties.forEach((party) => { running[party] += Number(row.results.find((item) => item.party === party)?.votes || 0); });
      runningAllVotes += row.results.reduce((sum, item) => sum + Number(item.votes || 0), 0);
      return { index, shares: Object.fromEntries(trendParties.map((party) => [party, runningAllVotes ? (running[party] / runningAllVotes) * 100 : 0])) };
    });
    const trendSeries = trendParties.map((party) => ({
      party,
      points: trendPoints.map((point, index) => `${trendPoints.length < 2 ? 0 : (index / (trendPoints.length - 1)) * 320},${96 - point.shares[party] * 0.9}`).join(" "),
      share: trendPoints.at(-1)?.shares?.[party] || 0,
      movement: (trendPoints.at(-1)?.shares?.[party] || 0) - (trendPoints[Math.max(0, Math.floor(trendPoints.length / 2) - 1)]?.shares?.[party] || 0),
    }));

    const people = new Map(personnel.map((person) => [person.id, person]));
    const creatorIds = [...new Set(fieldResultRows.map((row) => row.createdBy).filter(Boolean))];
    const performance = creatorIds.map((creatorId) => {
      const rows = fieldResultRows.filter((row) => row.createdBy === creatorId);
      const evidenceRate = rows.length ? rows.filter((row) => Array.isArray(row.media) && row.media.length > 0).length / rows.length : 0;
      let comparable = 0; let matching = 0;
      rows.forEach((row) => {
        const pair = fieldRowsByUnit.get(resultUnitKey(row)) || {};
        const counterpart = row.resultSource === "Agent" ? pair.Supervisor : pair.Agent;
        if (counterpart) { comparable += 1; if (compareResults(row, counterpart)) matching += 1; }
      });
      const consistencyRate = comparable ? matching / comparable : 0.5;
      const authoredIncidents = incidents.filter((item) => item.createdBy === creatorId && item.reportType !== POLLING_RESULT_TYPE);
      const closureRate = authoredIncidents.length ? authoredIncidents.filter((item) => ["resolved", "closed"].includes(String(item.status || "").toLowerCase())).length / authoredIncidents.length : 1;
      return { id: creatorId, name: people.get(creatorId)?.name || creatorId, role: people.get(creatorId)?.role || rows[0]?.resultSource || "Field", submissions: rows.length, evidenceRate, consistencyRate, closureRate };
    });
    const maxSubmissions = Math.max(1, ...performance.map((item) => item.submissions));
    performance.forEach((item) => { item.score = Math.round(item.evidenceRate * 35 + item.consistencyRate * 35 + item.closureRate * 10 + (item.submissions / maxSubmissions) * 20); });
    performance.sort((a, b) => b.score - a.score || b.submissions - a.submissions);

    return { readinessScore, fieldMismatches, irevMismatches, duplicates, missingEvidence, zeroVoteSheets, wardSpatial, trendSeries, performance };
  }, [summary, fieldRowsByUnit, fieldResultRows, irevRowsByUnit, winLoss, incidents, top6, personnel]);
  const actions = useMemo(() => [
    `Prioritize: ${actionableIntel.critical} critical/SOS item${actionableIntel.critical === 1 ? "" : "s"} for response verification.`,
    `Review: ${actionableIntel.otherOpen} other open incident${actionableIntel.otherOpen === 1 ? "" : "s"}.`,
  ], [actionableIntel]);
  const cleanSummaryText = (value) => String(value || "").replace(/\*\*/g, "").trim();
  const aiBriefingSections = useMemo(() => {
    const text = cleanSummaryText(outlook);
    if (!text) return [];
    const knownHeadings = ["EXECUTIVE ASSESSMENT", "EVIDENCE & PATTERNS", "RISKS & UNCERTAINTIES", "ACTIONABLE NEXT STEPS", "CONFIDENCE"];
    const sections = [];
    let current = null;
    text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(line => {
      const normalized = line.replace(/:$/, "").toUpperCase();
      if (knownHeadings.includes(normalized)) {
        current = { title: normalized, lines: [] };
        sections.push(current);
        return;
      }
      if (!current) {
        current = { title: "OPERATIONAL BRIEFING", lines: [] };
        sections.push(current);
      }
      current.lines.push(line.replace(/^[-•]\s*/, ""));
    });
    return sections;
  }, [outlook]);
  const runOperationalAnalysis = async () => {
    const safeIncidents = incidents.slice(0, 100).map(item => ({
      id: item.id,
      title: item.title,
      description: String(item.description || "").slice(0, 500),
      reportType: item.reportType,
      severity: item.severity,
      status: item.status,
      lga: item.lga,
      ward: item.ward,
      pollingUnit: item.pollingUnit,
      assignedTo: item.assignedTo,
      mediaCount: Array.isArray(item.media) ? item.media.length : 0,
      createdAt: item.createdAt,
    }));
    const severityCounts = incidents.reduce((counts, item) => ({ ...counts, [item.severity || "Unknown"]: (counts[item.severity || "Unknown"] || 0) + 1 }), {});
    const statusCounts = incidents.reduce((counts, item) => ({ ...counts, [item.status || "Unknown"]: (counts[item.status || "Unknown"] || 0) + 1 }), {});
    setOutlookLoading(true);
    setOutlook("");
    setOutlookMeta(null);
    try {
      const response = await request("/analysis/ai", authToken, {
        method: "POST",
        body: JSON.stringify({ context: {
          generatedAt: new Date().toISOString(),
          projection: forecast,
          resultSummary: { submissions: reports.length, partyTotals: summary.totals, assessedWards: winLoss.wards.length, assessedLgas: winLoss.lgas.length },
          selectedParty: focusParty || null,
          partyAnalysis,
          incidentSummary: { total: incidents.length, severityCounts, statusCounts, actionableIntel },
          incidents: safeIncidents,
          currentActions: actions,
        } }),
      });
      setOutlook(response.analysis || "No operational analysis returned.");
      setOutlookMeta(response.generationType ? response : null);
    } catch (error) {
      setOutlook(error.message || "Operational analysis unavailable.");
    } finally {
      setOutlookLoading(false);
    }
  };
  const runPostElectionAnalysis = async () => {
    setPostElectionLoading(true);
    setPostElectionBrief("");
    setPostElectionBriefMeta(null);
    try {
      const response = await request("/analysis/ai", authToken, {
        method: "POST",
        body: JSON.stringify({ context: {
          analysisMode: "POST_ELECTION",
          generatedAt: new Date().toISOString(),
          projection: forecast,
          resultSummary: { submissions: reports.length, partyTotals: summary.totals, assessedWards: winLoss.wards.length, assessedLgas: winLoss.lgas.length },
          evidenceAndLitigation: { readinessScore: postElection.readinessScore, missingEvidence: postElection.missingEvidence.length, fieldMismatches: postElection.fieldMismatches.length, irevMismatches: postElection.irevMismatches.length, duplicateSubmissions: postElection.duplicates, zeroVoteSheets: postElection.zeroVoteSheets.length },
          spatialConcentrations: postElection.wardSpatial.slice(0, 10).map((item) => ({ ward: item.label, submittedVotes: item.totalVotes, leader: item.winner, margin: item.margin, incidents: item.incidentCount, criticalIncidents: item.criticalCount })),
          reportingPerformance: postElection.performance.slice(0, 12).map((item) => ({ name: item.name, role: item.role, score: item.score, submissions: item.submissions, evidenceRate: Math.round(item.evidenceRate * 100), consistencyRate: Math.round(item.consistencyRate * 100) })),
          objective: "Assess evidence preservation for possible litigation, operational lessons for the next election cycle, and objective field-team performance. Keep all recommendations neutral and evidence-based.",
        } }),
      });
      setPostElectionBrief(response.analysis || "No post-election briefing returned.");
      setPostElectionBriefMeta(response.generationType ? response : null);
    } catch (error) {
      setPostElectionBrief(error.message || "Post-election AI analysis is unavailable.");
    } finally {
      setPostElectionLoading(false);
    }
  };
  const toggleIrevComparison = async () => {
    if (compareWithIrev) return setCompareWithIrev(false);
    setIrevCompareLoading(true);
    const pilot = await loadIrevPilot();
    setIrevCompareLoading(false);
    if (pilot?.configured && pilot.uploads?.length) setCompareWithIrev(true);
    else setIrevError("Osun IReV results are not available right now.");
  };
  const partyVoteFor = (row, party) => Number(row?.results?.find((result) => normalizeResultKeyPart(result.party) === normalizeResultKeyPart(party))?.votes || 0);
  const renderFieldVote = (row, party) => {
    const ownVotes = partyVoteFor(row, party);
    const pair = fieldRowsByUnit.get(resultUnitKey(row)) || {};
    const hasBothFieldSources = Boolean(pair.Agent && pair.Supervisor);
    const agentVotes = partyVoteFor(pair.Agent, party);
    const supervisorVotes = partyVoteFor(pair.Supervisor, party);
    const fieldMismatch = hasBothFieldSources && agentVotes !== supervisorVotes;
    const irevRow = irevRowsByUnit.get(resultUnitKey(row));
    const irevParty = irevRow?.results?.find((result) => normalizeResultKeyPart(result.party) === normalizeResultKeyPart(party));
    const irevVotes = Number(irevParty?.votes || 0);
    const irevMismatch = compareWithIrev && irevParty && ownVotes !== irevVotes;
    const count = <><strong>{ownVotes.toLocaleString()}</strong>{irevMismatch && <small className="irev-count-mismatch">IReV: {irevVotes.toLocaleString()}</small>}</>;
    return fieldMismatch
      ? <button type="button" className="field-count-mismatch" onClick={() => setFieldMismatchDetail({ pollingUnit: row.pollingUnit, lga: row.lga, ward: row.ward, party, agentVotes, supervisorVotes })}>{count}</button>
      : <span className="field-count-match">{count}</span>;
  };
  return (
    <div className={`results-center${focusedPreElection ? " pre-election-focused" : ""}`}>
      <header className="results-center-head">
        <div>
          <span className="eyebrow">{focusedPreElection ? "PRE-ELECTION DASHBOARD" : "INTELLIGENCE DASHBOARD"}</span>
          <h1>{focusedPreElection ? "Pre-Election Dashboard" : "Analytics Dashboard"}</h1>
          <p>{focusedPreElection ? "Overview, voter and feedback analysis, insight, next actions and resources." : "Live operational pulse, election results, and actions."}</p>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close dashboard"><FaTimes /></button>
      </header>
      {focusedPreElection ? <div className="rc-tab-bar"><button className="rc-tab active" onClick={() => setView("pre")}>Pre-Election</button></div> : focusedPostElection ? <div className="rc-tab-bar"><button className="rc-tab active" onClick={() => setView("post")}>Post-Election</button></div> : <div className="rc-tab-bar"><button className={view === "pulse" ? "rc-tab active" : "rc-tab"} onClick={() => setView("pulse")}>Pulse</button><button className={view === "action" ? "rc-tab active" : "rc-tab"} onClick={() => setView("action")}>Action</button><button className={["breakdown", "winloss", "winloss-lga"].includes(view) ? "rc-tab active" : "rc-tab"} onClick={() => setView("breakdown")}>Result</button><button className={view === "irev" ? "rc-tab irev-tab active" : "rc-tab irev-tab"} onClick={() => setView("irev")}>IReV</button><button className={view === "pre" ? "rc-tab active" : "rc-tab"} onClick={() => setView("pre")}>Pre-Election</button><button className={view === "post" ? "rc-tab active" : "rc-tab"} onClick={() => setView("post")}>Post-Election</button></div>}
      <main className="results-center-body">
        {view === "pulse" && <AnalyticsPanel helpers={helpers} incidents={incidents} officers={officers} mapLayers={mapLayers} selected={selected} onClose={onClose} onTool={onTool} onCsv={onCsv} onClear={onClear} embedded />}
        {view === "pre" && <PreElectionAnalysis authToken={authToken} canAdmin={canAdmin} />}
        {["breakdown", "winloss", "winloss-lga"].includes(view) && <div className="wl-sub-tabs result-view-tabs"><button className={view === "breakdown" ? "wl-sub-tab active" : "wl-sub-tab"} onClick={() => setView("breakdown")}>Polling Unit Breakdown</button><button className={view !== "breakdown" ? "wl-sub-tab active" : "wl-sub-tab"} onClick={() => setView("winloss")}>Win / Loss Analysis</button></div>}
        {["winloss", "winloss-lga"].includes(view) && <section className="result-total-strip"><article className="result-total-card grand"><span>Current projection</span><strong>{forecast.leader || "—"}</strong><small>{forecast.confidence}% indicative confidence; not a final result</small></article><article className="result-total-card"><span>Vote margin</span><strong>{forecast.margin.toLocaleString()}</strong><small>Against second place</small></article><article className="result-total-card"><span>Units covered</span><strong>{forecast.coverage.toLocaleString()}</strong><small>Unique submitted units</small></article></section>}
        {view === "action" && <section className="result-table-card" style={{ marginBottom: 16 }}>
          <div className="result-table-title">
            <div><h2>Insight</h2><p>Realtime analysis of performance, insight &amp; operational intelligence</p></div>
            <div className="analysis-actions"><button className="primary action-btn summary-action-btn" disabled={outlookLoading} onClick={runOperationalAnalysis}><MdFlashOn /> <span>{outlookLoading ? "Analyzing…" : "Operational Analysis"}</span></button></div>
          </div>
          <div className="actionable-intel">
            <h3>Actionable Intel</h3>
            <div className={`actionable-intel-grid ${focusParty ? "party-only" : ""}`}>
              {!focusParty && <article className="actionable-intel-card prioritize"><span>Prioritize</span><p><strong>{actionableIntel.critical}</strong> critical/SOS item{actionableIntel.critical === 1 ? "" : "s"} for response verification.</p></article>}
              {!focusParty && <article className="actionable-intel-card review"><span>Review</span><p><strong>{actionableIntel.otherOpen}</strong> other open incident{actionableIntel.otherOpen === 1 ? "" : "s"}</p></article>}
              <article className="actionable-intel-card party"><span>Party focus</span><label className="party-focus-field"><select value={focusParty} onChange={e => setFocusParty(e.target.value)} aria-label="Select party for operational analysis"><option value="">No parties</option>{summary.partyNames.map(p => <option key={p} value={p}>{p}</option>)}</select></label></article>
            </div>
          </div>
          {partyAnalysis && <article className="party-result-card"><header><span>Focused result</span><strong>{focusParty}</strong></header><div><section><span>Total votes</span><b>{partyAnalysis.votes.toLocaleString()}</b></section><section><span>Wards leading</span><b>{partyAnalysis.wards}</b></section><section><span>LGAs leading</span><b>{partyAnalysis.lgas}</b></section><section><span>Related incidents</span><b>{partyAnalysis.incidents}</b></section></div></article>}
          {aiBriefingSections.length > 0 && <section className="ai-intelligence-response"><header><div><span>AI Intelligence</span><h3>Operational assessment &amp; actions</h3></div><AiGenerationBadge meta={outlookMeta} /></header><div className="ai-intelligence-grid">{aiBriefingSections.map(section => <article className={section.title === "ACTIONABLE NEXT STEPS" ? "ai-section actionable" : "ai-section"} key={section.title}><h4>{section.title}</h4>{section.lines.map((line, index) => <p key={`${section.title}-${index}`}>{section.title === "ACTIONABLE NEXT STEPS" && <span className="ai-action-number">{index + 1}</span>}{line}</p>)}</article>)}</div></section>}
        </section>}
        {view === "post" && <section className="post-election-dashboard">
          <div className="post-election-head">
            <div><span className="eyebrow">AFTER RESULTS</span><h2>Post-Election Analysis</h2><p>Evidence readiness, result trends, spatial concentration, operational lessons and field performance.</p></div>
            <button className="primary action-btn" disabled={postElectionLoading || !summary.rows.length} onClick={runPostElectionAnalysis}><MdFlashOn /> {postElectionLoading ? "Analyzing…" : "Generate AI Brief"}</button>
          </div>
          <p className="post-election-caution">These are provisional analytical indicators from submitted records—not certified results, legal conclusions, turnout estimates or voter-targeting advice.</p>
          <div className="post-kpi-grid">
            <article className={postElection.readinessScore >= 80 ? "ready" : postElection.readinessScore >= 55 ? "review" : "risk"}><span>Evidence readiness</span><strong>{postElection.readinessScore}%</strong><small>For legal-team review</small></article>
            <article><span>Field discrepancies</span><strong>{postElection.fieldMismatches.length}</strong><small>Agent vs Supervisor</small></article>
            <article><span>IReV discrepancies</span><strong>{postElection.irevMismatches.length}</strong><small>Where official sheets are available</small></article>
            <article><span>Missing evidence</span><strong>{postElection.missingEvidence.length}</strong><small>Field result submissions</small></article>
            <article><span>Duplicate updates</span><strong>{postElection.duplicates}</strong><small>Same source and polling unit</small></article>
          </div>

          <div className="post-analysis-grid">
            <article className="post-card trend-card">
              <header><div><h3>Voting Pattern Trend</h3><p>Cumulative share as field submissions arrived</p></div><b>{postElection.trendSeries.length} parties</b></header>
              {postElection.trendSeries.length ? <><svg className="post-trend-chart" viewBox="0 0 320 100" preserveAspectRatio="none" aria-label="Cumulative party vote share trend">{postElection.trendSeries.map((series, index) => <polyline key={series.party} points={series.points} fill="none" stroke={["#facc15", "#4ade80", "#38bdf8", "#fb7185"][index]} strokeWidth="3" vectorEffect="non-scaling-stroke" />)}</svg><div className="post-trend-legend">{postElection.trendSeries.map((series, index) => <div key={series.party}><i style={{background:["#facc15", "#4ade80", "#38bdf8", "#fb7185"][index]}} /><span>{series.party}</span><strong>{series.share.toFixed(1)}%</strong><small className={series.movement >= 0 ? "up" : "down"}>{series.movement >= 0 ? "+" : ""}{series.movement.toFixed(1)} pts</small></div>)}</div></> : <p className="post-empty">Submit polling-unit results to generate a trend.</p>}
            </article>

            <article className="post-card litigation-card">
              <header><div><h3>Litigation Preparation</h3><p>Records requiring preservation or reconciliation</p></div></header>
              <div className="litigation-list">
                <div><span>Unsigned / missing result evidence</span><b>{postElection.missingEvidence.length}</b></div>
                <div><span>Agent–Supervisor count conflicts</span><b>{postElection.fieldMismatches.length}</b></div>
                <div><span>Field–IReV count conflicts</span><b>{postElection.irevMismatches.length}</b></div>
                <div><span>Zero-total result sheets</span><b>{postElection.zeroVoteSheets.length}</b></div>
                <div><span>Duplicate source submissions</span><b>{postElection.duplicates}</b></div>
              </div>
              <p className="post-card-note">Preserve original files, timestamps, submitter identity and chain-of-custody records before making corrections.</p>
            </article>

            <OverVotingCheck authToken={authToken} />
          </div>

          <ReconciliationReview authToken={authToken} />

          <article className="post-card spatial-card">
            <header><div><h3>Spatial Distribution &amp; Hotspots</h3><p>Wards ranked by submitted vote volume, margin and reported incidents</p></div><small>High volume means reporting concentration—not verified turnout.</small></header>
            <div className="spatial-grid">{postElection.wardSpatial.slice(0, 12).map((item, index) => <button type="button" key={item.label} onClick={() => Number.isFinite(item.lat) && onFocusLocation?.(item)} disabled={!Number.isFinite(item.lat)}><span className="spatial-rank">#{index + 1}</span><div><strong>{item.label}</strong><small>{item.winner || "No leader"} · margin {item.margin.toLocaleString()}</small></div><div><b>{item.totalVotes.toLocaleString()}</b><small>{item.reports} reports · {item.incidentCount} incidents</small></div>{item.criticalCount > 0 && <em>{item.criticalCount} critical</em>}</button>)}{!postElection.wardSpatial.length && <p className="post-empty">No ward-level result distribution is available.</p>}</div>
          </article>

          <div className="post-analysis-grid">
            <article className="post-card next-cycle-card">
              <header><div><h3>Next Election Cycle</h3><p>Operational improvements from the current evidence</p></div></header>
              <ol>
                <li><b>Close evidence gaps:</b> obtain signed result media for {postElection.missingEvidence.length} submission{postElection.missingEvidence.length === 1 ? "" : "s"}.</li>
                <li><b>Reconcile counts:</b> verify {postElection.fieldMismatches.length + postElection.irevMismatches.length} conflicting unit record{postElection.fieldMismatches.length + postElection.irevMismatches.length === 1 ? "" : "s"} against original sheets.</li>
                <li><b>Strengthen deployment:</b> review the {postElection.wardSpatial.filter((item) => item.incidentCount > 0).length} ward{postElection.wardSpatial.filter((item) => item.incidentCount > 0).length === 1 ? "" : "s"} with result-linked operational incidents.</li>
                <li><b>Improve reporting discipline:</b> coach teams below 70% performance and document corrective actions before the next exercise.</li>
              </ol>
            </article>
            <article className="post-card performance-card">
              <header><div><h3>Performance &amp; Reward Review</h3><p>Objective score: evidence 35%, consistency 35%, volume 20%, closure 10%</p></div></header>
              <div className="performance-list">{postElection.performance.slice(0, 10).map((item, index) => <div key={item.id}><span>{index + 1}</span><div><strong>{item.name}</strong><small>{item.role} · {item.submissions} submissions</small></div><div className="performance-meter"><i style={{width:`${item.score}%`}} /></div><b>{item.score}%</b>{item.score >= 80 && item.submissions > 0 && <em>Reward review</em>}</div>)}{!postElection.performance.length && <p className="post-empty">No attributable field submissions are available.</p>}</div>
            </article>
          </div>
          {postElectionBrief && <article className="post-card post-ai-brief"><header><div><h3>AI Post-Election Brief</h3><p>Neutral synthesis for command, evidence and planning teams</p></div><AiGenerationBadge meta={postElectionBriefMeta} /></header><div>{cleanSummaryText(postElectionBrief)}</div></article>}
        </section>}
        {partyAnalysis && view !== "breakdown" && view !== "irev" && view !== "news" && <section className="party-lga-analysis"><div className="party-lga-summary"><div><span>Selected party</span><strong>{focusParty}</strong></div><div className="winning"><span>LGAs winning</span><strong>{partyAnalysis.winningLgas.length}</strong></div><div className="losing"><span>LGAs losing</span><strong>{partyAnalysis.losingLgas.length}</strong></div><div><span>Total votes</span><strong>{partyAnalysis.votes.toLocaleString()}</strong></div></div><div className="party-lga-columns"><section className="party-lga-column winning"><header><div><span className="performance-dot" />Winning LGAs</div><b>{partyAnalysis.winningLgas.length}</b></header><div className="party-lga-list">{partyAnalysis.winningLgas.map(item => <article key={item.name}><div><strong>{item.name}</strong><small>Ahead of {item.opponent}</small></div><div><b>+{item.margin.toLocaleString()}</b><small>{item.votes.toLocaleString()} votes</small></div></article>)}{!partyAnalysis.winningLgas.length && <p>No confirmed LGA lead for {focusParty} yet.</p>}</div></section><section className="party-lga-column losing"><header><div><span className="performance-dot" />Losing LGAs</div><b>{partyAnalysis.losingLgas.length}</b></header><div className="party-lga-list">{partyAnalysis.losingLgas.map(item => <article key={item.name}><div><strong>{item.name}</strong><small>Behind {item.opponent}</small></div><div><b>-{item.margin.toLocaleString()}</b><small>{item.votes.toLocaleString()} votes</small></div></article>)}{!partyAnalysis.losingLgas.length && <p>No confirmed LGA loss for {focusParty} yet.</p>}</div></section></div>{partyAnalysis.tiedLgas.length > 0 && <p className="party-tied-note">Tied in: {partyAnalysis.tiedLgas.join(", ")}.</p>}<p className="party-analysis-note">Leading in {partyAnalysis.wards} wards. Related incident mentions: {partyAnalysis.incidents}. Based only on submitted polling-unit results.</p></section>}
        {view === "winloss" && <section className="result-table-card"><div className="result-table-title"><div><h2>Win / Loss Analysis</h2><p>Leading party by ward and LGA from submitted polling-unit results.</p></div><b>Top {top6.length} parties</b></div><div className="wl-sub-tabs"><button className="wl-sub-tab active">By Ward</button><button className="wl-sub-tab" onClick={() => setView("winloss-lga")}>By LGA</button></div><div className="result-table-scroll"><table className="result-progress-table"><thead><tr><th>Ward</th><th>Winner</th>{top6.map(p => <th key={p}>{p}</th>)}</tr></thead><tbody>{winLoss.wards.map(g => <tr key={g.label}><td>{g.label}</td><td><b>{g.winner || "—"}</b></td>{top6.map(p => <td key={p}>{g.votes[p].toLocaleString()} {g.winner === p ? "✓" : g.winner ? "✕" : ""}</td>)}</tr>)}{!winLoss.wards.length && <tr><td colSpan={top6.length + 2} className="result-empty">No ward-level data available yet.</td></tr>}</tbody></table></div></section>}
        {view === "winloss-lga" && <section className="result-table-card"><div className="result-table-title"><div><h2>LGA Win / Loss Analysis</h2><p>Leading party in each Local Government Area.</p></div></div><div className="wl-sub-tabs"><button className="wl-sub-tab" onClick={() => setView("winloss")}>By Ward</button><button className="wl-sub-tab active">By LGA</button></div><div className="result-table-scroll"><table className="result-progress-table"><thead><tr><th>LGA</th><th>Winner</th>{top6.map(p => <th key={p}>{p}</th>)}</tr></thead><tbody>{winLoss.lgas.map(g => <tr key={g.label}><td><b>{g.label}</b></td><td><b>{g.winner || "—"}</b></td>{top6.map(p => <td key={p}>{g.votes[p].toLocaleString()} {g.winner === p ? "✓" : g.winner ? "✕" : ""}</td>)}</tr>)}</tbody></table></div></section>}
        {["winloss", "winloss-lga"].includes(view) && <div className="result-table-card" style={{marginTop: 16}}><p className="muted">Select a party in the Action tab to compare its wins and losses. Results update automatically as new submissions arrive.</p></div>}
        {view !== "breakdown" ? null : <>
        <section className="result-source-grid field-source-grid" aria-label="Result submission sources">
          {sourceStats.filter((item) => item.source !== "INEC IReV").map((item) => <button type="button" className={`result-source-card ${resultSourceFilter === item.source ? "active" : ""}`} key={item.source} onClick={() => setResultSourceFilter((current) => current === item.source ? "" : item.source)}><span>{item.source}</span><strong>{item.submissions}</strong><small>{item.units} polling unit{item.units === 1 ? "" : "s"} · {item.votes.toLocaleString()} votes</small></button>)}
          <article className="result-source-card field-total"><span>Field submissions</span><strong>{fieldResultRows.length}</strong><small>Agent and Supervisor updates</small></article>
        </section>
        </>}
        {view === "irev" && <section className="irev-pilot-card">
          <header className="irev-pilot-head">
            <div><span className="eyebrow">LIVE OFFICIAL SOURCE · SHOWCASE PILOT</span><h2>INEC IReV — Osun</h2><p>Reads public polling-unit upload metadata and original result-sheet images from IReV every 60 seconds.</p></div>
            <div className="irev-pilot-actions"><a href={irevPilot?.portalUrl || "https://irev.inecnigeria.org/"} target="_blank" rel="noreferrer">Open IReV</a><button type="button" disabled={irevLoading} onClick={() => loadIrevPilot(true)}><FaSyncAlt /> {irevLoading ? "Checking…" : "Refresh now"}</button></div>
          </header>
          {irevError && <div className="error">{irevError}</div>}
          {irevPilot && <>
            {irevSection === "results" && irevResultRows.length > 0 && <section className="result-total-strip irev-result-totals">{irevTopParties.map((party) => <article className="result-total-card" key={party}><span>{party}</span><strong>{irevOnlyTotals[party].toLocaleString()}</strong></article>)}</section>}
            <div className="irev-pilot-stats"><div><span>Uploaded</span><strong>{irevPilot.submitted.toLocaleString()}</strong></div><div><span>Expected</span><strong>{irevPilot.expected.toLocaleString()}</strong></div><div><span>Coverage</span><strong>{irevPilot.expected ? `${((irevPilot.submitted / irevPilot.expected) * 100).toFixed(1)}%` : "—"}</strong></div><div><span>Last checked</span><strong>{new Date(irevPilot.fetchedAt).toLocaleTimeString()}</strong></div></div>
            {irevPilot.notice && <p className="irev-verification-note"><MdWarning /> {irevPilot.notice}</p>}
            <div className="wl-sub-tabs irev-sub-tabs"><button className={irevSection === "uploads" ? "wl-sub-tab active" : "wl-sub-tab"} onClick={() => setIrevSection("uploads")}>Polling-unit uploads</button>{irevResultRows.length > 0 && <button className={irevSection === "results" ? "wl-sub-tab active" : "wl-sub-tab"} onClick={() => setIrevSection("results")}>Published results</button>}</div>
            {irevSection === "uploads" && <>
            <div className="irev-table-toolbar"><div><strong>All uploaded polling units</strong><span>{filteredIrevUploads.length.toLocaleString()} of {irevPilot.uploads.length.toLocaleString()} sheets shown</span></div><label><FaSearch /><input value={irevSearch} onChange={(event) => setIrevSearch(event.target.value)} placeholder="Search LGA, ward, polling unit or PU code" />{irevSearch && <button type="button" onClick={() => setIrevSearch("")} aria-label="Clear IReV search"><FaTimes /></button>}</label></div>
            <div className="irev-table-scroll">
              <table className="result-progress-table irev-full-table">
                <thead><tr><th>#</th><th>LGA</th><th>Ward</th><th>Polling unit</th><th>PU code</th><th>Uploaded</th><th>Status</th><th>Result sheet</th></tr></thead>
                <tbody>{filteredIrevUploads.map((upload, index) => <tr key={upload.id}><td>{index + 1}</td><td><b>{upload.lga || "—"}</b></td><td>{upload.ward || "—"}</td><td>{upload.pollingUnit || "—"}</td><td><strong>{upload.puCode}</strong></td><td>{upload.uploadedAt ? new Date(upload.uploadedAt).toLocaleString() : "—"}</td><td><span className="irev-awaiting-badge">{upload.verificationStatus}</span></td><td><button className="irev-sheet-link" type="button" disabled={irevPreviewLoading === upload.id} onClick={() => openIrevPreview(upload)}>{irevPreviewLoading === upload.id ? "Loading…" : "View image"}</button></td></tr>)}{!filteredIrevUploads.length && <tr><td className="result-empty" colSpan="8">No Osun result sheets are available from the live source right now.</td></tr>}</tbody>
              </table>
            </div>
            </>}
            {irevSection === "results" && <>
              <p className="irev-verification-note"><MdWarning /> Prepared polling-unit vote figures for demonstration. No image reading is performed. Source: <a href={irevPublishedResults?.sourceUrl} target="_blank" rel="noreferrer">{irevPublishedResults?.sourceName}</a>.</p>
              <div className="irev-table-toolbar"><div><strong>Polling-unit result counts</strong><span>{filteredIrevResultRows.length.toLocaleString()} of {irevResultRows.length.toLocaleString()} units shown</span></div><label><FaSearch /><input value={irevSearch} onChange={(event) => setIrevSearch(event.target.value)} placeholder="Search LGA, ward, polling unit or PU code" />{irevSearch && <button type="button" onClick={() => setIrevSearch("")} aria-label="Clear result search"><FaTimes /></button>}</label></div>
              <div className="irev-table-scroll"><table className="result-progress-table irev-results-table"><thead><tr><th>LGA</th><th>Ward</th><th>Polling unit</th><th>PU code</th><th>Winner</th>{irevTopParties.slice(0, 3).map((party) => <th key={party}>{party}</th>)}</tr></thead><tbody>{filteredIrevResultRows.map((row) => <tr key={row.id}><td><b>{row.lga}</b></td><td>{row.ward}</td><td>{row.pollingUnit}</td><td><strong>{row.puCode}</strong></td><td><b>{row.winner}</b></td>{irevTopParties.slice(0, 3).map((party) => <td key={party}><strong>{Number(row.results.find((result) => result.party === party)?.votes || 0).toLocaleString()}</strong></td>)}</tr>)}{!filteredIrevResultRows.length && <tr><td className="result-empty" colSpan="8">No prepared polling-unit results match this search.</td></tr>}</tbody></table></div>
            </>}
            {irevPreview && <div className="irev-preview-backdrop" onClick={closeIrevPreview}><section className="irev-preview-modal" onClick={(event) => event.stopPropagation()}><header><div><span className="eyebrow">INEC IREV RESULT SHEET</span><h2>{irevPreview.puCode}</h2><p>{irevPreview.lga} · {irevPreview.ward} · {irevPreview.pollingUnit}</p></div><button type="button" className="icon-btn" onClick={closeIrevPreview} aria-label="Close image preview"><FaTimes /></button></header><div className="irev-preview-body"><div className="irev-preview-image"><img src={irevPreview.imageUrl} alt={`INEC IReV result sheet for ${irevPreview.puCode}`} /></div><aside><div className="irev-preview-actions"><a href={irevPreview.imageUrl} download target="_blank" rel="noreferrer">Download image</a></div><h3>Original result sheet</h3><p className="muted">This image is shown exactly as published on IReV. Prepared polling-unit vote figures are available in the Published results tab.</p></aside></div></section></div>}
          </>}
          {!irevPilot && irevLoading && <p className="muted">Connecting to the official IReV feed…</p>}
        </section>}
        {view !== "breakdown" ? null : <>
        <section className="result-total-strip">
          {fieldTopParties.map(party => <article className="result-total-card" key={party}><span>{party}</span><strong>{fieldResultTotals[party].toLocaleString()}</strong></article>)}
        </section>
        <section className="result-table-card">
          <div className="result-table-title"><div><h2>Polling-unit breakdown</h2><p>{resultSourceFilter ? `${resultSourceFilter} submissions only. Select the active source card again to show all.` : "Agent and Supervisor counts with field evidence."}</p></div><div className="result-compare-actions"><button type="button" className={compareWithIrev ? "irev-compare-btn active" : "irev-compare-btn"} disabled={irevCompareLoading} onClick={toggleIrevComparison}>{irevCompareLoading ? "Loading IReV…" : compareWithIrev ? "IReV comparison on" : "Compare with IReV"}</button><b>{displayedResultRows.length} shown</b></div></div>
          <div className="result-table-scroll">
            <table className="result-progress-table">
              <thead><tr><th>Source</th><th>LGA</th><th>Ward</th><th>Polling unit</th>{fieldTopParties.map(party => <th key={party}>{party}</th>)}<th>Location</th><th>Evidence</th><th>Uploaded</th></tr></thead>
              <tbody>
                {displayedResultRows.map((row) => (
                  <tr key={row.id}><td><span className={`result-source-badge source-${row.resultSource.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{row.resultSource}</span></td><td>{row.lga || "—"}</td><td>{row.ward || "—"}</td><td><b>{row.pollingUnit || "—"}</b></td>{fieldTopParties.map(party => <td key={party}>{renderFieldVote(row, party)}</td>)}<td>{Number(row.lat).toFixed(5)}, {Number(row.lng).toFixed(5)}</td><td><div className="result-evidence">{(row.media || []).filter((item) => item.type === "image").slice(0, 2).map((item, index) => <EvidenceThumb item={item} token={authToken} alt={`Evidence for ${row.pollingUnit}`} key={item.id || `${row.id}-${index}`} />)}</div></td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>
                ))}
                {!displayedResultRows.length && <tr><td className="result-empty" colSpan={fieldTopParties.length + 8}>No {resultSourceFilter || "polling-unit"} results have been uploaded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        {fieldMismatchDetail && <div className="field-mismatch-backdrop" onClick={() => setFieldMismatchDetail(null)}><section className="field-mismatch-modal" onClick={(event) => event.stopPropagation()}><header><div><span>{fieldMismatchDetail.lga} · {fieldMismatchDetail.ward}</span><h3>{fieldMismatchDetail.pollingUnit}</h3></div><button type="button" onClick={() => setFieldMismatchDetail(null)} aria-label="Close comparison"><FaTimes /></button></header><h4>{fieldMismatchDetail.party}</h4><div><article><span>Agent reported</span><strong>{fieldMismatchDetail.agentVotes.toLocaleString()}</strong></article><article><span>Supervisor reported</span><strong>{fieldMismatchDetail.supervisorVotes.toLocaleString()}</strong></article></div></section></div>}
        </>}
      </main>
    </div>
  );
}
