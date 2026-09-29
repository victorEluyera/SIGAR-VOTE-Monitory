import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchLga } from './lga.js';

/**
 * The pre-election Overview: what a candidate or stakeholder should see first, from the same
 * figures as the Pulse and the Insight map so no two tabs disagree.
 *
 * The voter intention poll never names a rival: it is Sen. Alli against "other candidates" and "not
 * decided". The only rival shown anywhere is in the online report, which is itself a head-to-head.
 */

// Sen. Alli's survey share among people who named a candidate.
export const STANDING = [
  { id: 'strong', label: 'Strong', from: 0.5 },
  { id: 'leaning', label: 'Leaning our way', from: 0.35 },
  { id: 'battleground', label: 'Battleground', from: 0.2 },
  { id: 'weak', label: 'Weak', from: 0 },
];
const standingOf = (share) => (share == null ? 'nodata' : STANDING.find((band) => share >= band.from).id);
const fmt = (value) => Number(value || 0).toLocaleString('en-US');
const pct = (value) => `${Math.round((value || 0) * 100)}%`;
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');

// The 10x promoter target (one promoter per ~4 voters is the campaign's plan); override per deployment.
export const PROMOTER_TARGET = Number(process.env.TENX_PROMOTER_TARGET) > 0 ? Number(process.env.TENX_PROMOTER_TARGET) : 750_000;
const STATE_WARDS = 351;

// Coverage status for a whole LGA: red under 90% of its polling units, amber to 95%, green above.
const coverageStatus = (share) => (share < 0.9 ? 'risk' : share < 0.95 ? 'watch' : 'good');

const ONLINE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'online-report.json');
let onlineCache;
/** The latest social-listening report shipped with the app, or null. */
export function onlineReport() {
  if (onlineCache !== undefined) return onlineCache;
  try {
    onlineCache = existsSync(ONLINE_FILE) ? JSON.parse(readFileSync(ONLINE_FILE, 'utf8')) : null;
  } catch (error) {
    console.warn('[pre-election] Online report could not be read:', error.message);
    onlineCache = null;
  }
  return onlineCache;
}

function projectsView(tenx, lgaRows) {
  const projects = tenx?.projects;
  if (!projects || !projects.total) return null;
  const withProjects = new Set((projects.byLga || []).map((row) => matchLga(row.name)).filter(Boolean));
  const without = lgaRows.filter((row) => !withProjects.has(row.lga)).sort((a, b) => (b.registeredVoters || 0) - (a.registeredVoters || 0));
  return {
    total: projects.total,
    stages: projects.stages || null,
    wards: projects.wards ?? null,
    wardsTotal: STATE_WARDS,
    lgas: withProjects.size,
    lgasWithout: without.map((row) => row.label),
    partial: Boolean(projects.partial),
  };
}

export function buildOverview({ pulse, map, tenx = null, online = null, promoterTarget = PROMOTER_TARGET }) {
  const survey = pulse.survey || {};
  const focus = survey.focus || null;
  const responses = survey.responses || 0;
  const named = survey.named || 0;
  const focusVotes = focus?.votes || 0;

  const intention = survey.available && focus ? {
    share: focus.share, // of people who named a candidate
    votes: focusVotes,
    named,
    responses,
    weightedShare: survey.weighted?.rows?.find((row) => row.name === focus.name)?.share ?? null,
    split: [
      { id: 'us', label: 'Sen. Alli', count: focusVotes, share: responses ? focusVotes / responses : 0 },
      { id: 'others', label: 'Other candidates', count: named - focusVotes, share: responses ? (named - focusVotes) / responses : 0 },
      { id: 'none', label: 'Not decided', count: responses - named, share: responses ? (responses - named) / responses : 0 },
    ],
  } : null;

  const members = pulse.members || {};
  const reference = pulse.reference || {};
  const center = pulse.contactCenter || {};
  const registered = reference.registeredVoters?.value ?? null;
  const pvcRate = reference.pvcRate ?? null;

  // The LGAs with the smallest share of polling units that have someone on the ground.
  const coverage = members.available
    ? (pulse.byLga || []).filter((row) => row.pollingUnits).map((row) => {
      const share = (row.unitsCovered || 0) / row.pollingUnits;
      return { key: row.lga, name: row.label, covered: row.unitsCovered || 0, units: row.pollingUnits, share, status: coverageStatus(share) };
    }).sort((a, b) => a.share - b.share || b.units - a.units).slice(0, 10)
    : [];

  const standing = map.rows.map((row) => ({ name: row.name, share: row.values.support ?? null, named: row.detail?.survey?.named || 0 }));
  const projects = projectsView(tenx, pulse.byLga || []);

  // Five things to act on, always in the same order so the eye learns where to look.
  const intelligence = [];
  const gap = members.available ? members.pollingUnits - members.unitsCovered : null;
  intelligence.push({
    id: 'coverage', title: 'Weakest coverage',
    tone: coverage[0]?.status === 'risk' ? 'risk' : 'watch',
    text: coverage.length
      ? `${list(coverage.slice(0, 3).map((row) => `${row.name} (${pct(row.share)})`))} have the smallest share of polling units with an APC member. ${fmt(gap)} polling units across Oyo have none yet.`
      : 'Load the APC member list to see polling-unit coverage.',
  });
  const low = standing.filter((row) => row.share != null && row.share < 0.2 && row.named >= 30).sort((a, b) => a.share - b.share);
  intelligence.push({
    id: 'sentiment', title: 'Low sentiment',
    tone: low.length ? 'risk' : 'good',
    text: low.length
      ? `Sen. Alli has under 20% of named choices in ${list([...low.slice(0, 3).map((row) => `${row.name} (${pct(row.share)})`), ...(low.length > 3 ? [`${low.length - 3} more LGAs`] : [])])}.`
      : survey.available ? 'No LGA with enough answers has Sen. Alli under 20%.' : 'No voter survey has been loaded yet.',
  });
  intelligence.push({
    id: 'projects', title: 'No project submitted or ongoing',
    tone: projects ? 'watch' : 'none',
    text: projects
      ? `${fmt(Math.max(STATE_WARDS - (projects.wards || 0), 0))} of ${STATE_WARDS} wards have no 10x community project yet${projects.lgasWithout.length ? `, including every ward in ${list(projects.lgasWithout.slice(0, 3))}` : ''}.`
      : tenx ? '10x has not shared any community projects yet.' : 'Waiting for 10x to connect; community projects come from there.',
  });
  intelligence.push({
    id: 'media', title: 'On media',
    tone: online ? 'risk' : 'none',
    text: online
      ? `Anger is ${online.emotion.us.anger}% of the feeling in Sen. Alli's online mentions, and negative mentions rose ${online.sentiment.change.negative}% on the week before${online.negativeTopic ? `, led by ${online.negativeTopic}` : ''} (${online.period.label}).`
      : 'No online report has been loaded yet.',
  });
  const requests = (center.requests?.length ? center.requests : center.themes || []).filter((row) => row.id !== 'party').slice(0, 3);
  intelligence.push({
    id: 'callers', title: 'Call center',
    tone: center.available && center.open ? 'risk' : 'watch',
    text: center.available
      ? `${fmt(center.open)} calls are still open${center.followUpRequested ? ` and ${fmt(center.followUpRequested)} callers asked to be called back` : ''}.${requests.length ? ` Callers raise ${list(requests.map((row) => `${row.label.toLowerCase()} (${fmt(row.calls)})`))}.` : ''}`
      : 'No call-center report has been loaded yet.',
  });

  return {
    place: pulse.filter?.label || 'All of Oyo',
    intention,
    numbers: {
      registered,
      pvcRate,
      pvcUncollected: registered != null && pvcRate != null ? Math.round(registered * (1 - pvcRate)) : null,
      members: members.available ? members.total : null,
      pollingUnitsReached: members.available ? members.unitsCovered : null,
      pollingUnits: members.available ? members.pollingUnits : pulse.register?.pollingUnits ?? null,
      lgasReached: members.available ? members.lgasWithMembers : null,
      lgas: pulse.register?.lgas ?? 33,
    },
    tenx: tenx ? {
      connected: true,
      promoters: tenx.totals?.unitPromoters ?? 0,
      target: promoterTarget,
      pollingUnits: tenx.coverage?.pollingUnits ?? 0,
      updatedAt: tenx.sourceGeneratedAt || null,
    } : { connected: false, target: promoterTarget },
    projects,
    coverage,
    intelligence,
    online,
    callCenter: center.available ? { period: center.period, calls: center.calls, open: center.open, followUp: center.followUpRequested } : null,
    standing: [...STANDING, { id: 'nodata', label: 'Not enough survey data' }].map((band) => ({
      id: band.id,
      label: band.label,
      lgas: standing.filter((row) => standingOf(row.share) === band.id).map((row) => row.name),
    })),
  };
}
