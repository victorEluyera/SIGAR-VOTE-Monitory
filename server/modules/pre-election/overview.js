/**
 * The pre-election Overview: what a candidate or stakeholder should see first, from the same
 * figures as the Pulse and the Insight map so no two tabs disagree.
 *
 * It reports the campaign's own standing only. Rival candidates are never named: vote intention is
 * Sen. Alli's share against "other candidates" and "no candidate named".
 */

// Where each LGA stands, from Sen. Alli's survey share among people who named a candidate.
export const STANDING = [
  { id: 'strong', label: 'Strong', from: 0.5 },
  { id: 'leaning', label: 'Leaning our way', from: 0.35 },
  { id: 'battleground', label: 'Battleground', from: 0.2 },
  { id: 'weak', label: 'Weak', from: 0 },
];
const standingOf = (share) => (share == null ? 'nodata' : STANDING.find((band) => share >= band.from).id);
const fmt = (value) => Number(value || 0).toLocaleString('en-US');
const pct = (value) => `${Math.round((value || 0) * 100)}%`;

export function buildOverview({ pulse, map }) {
  const survey = pulse.survey || {};
  const focus = survey.focus || null;
  const responses = survey.responses || 0;
  const named = survey.named || 0;
  const focusVotes = focus?.votes || 0;
  const weightedFocus = focus ? survey.weighted?.rows?.find((row) => row.name === focus.name)?.share ?? null : null;

  const intention = survey.available && focus ? {
    share: focus.share, // of people who named a candidate
    votes: focusVotes,
    named,
    responses,
    weightedShare: weightedFocus,
    // Of everyone surveyed: us, other candidates (unnamed here), no candidate named.
    split: [
      { id: 'us', label: 'Sen. Alli', count: focusVotes, share: responses ? focusVotes / responses : 0 },
      { id: 'others', label: 'Other candidates', count: named - focusVotes, share: responses ? (named - focusVotes) / responses : 0 },
      { id: 'none', label: 'No candidate named yet', count: responses - named, share: responses ? (responses - named) / responses : 0 },
    ],
  } : null;

  const lgas = map.rows.map((row) => ({ key: row.key, name: row.name, share: row.values.support ?? null, standing: standingOf(row.values.support), registered: row.values.registered, members: row.values.members, calls: row.values.calls }));
  const standing = [...STANDING, { id: 'nodata', label: 'Not enough survey data' }].map((band) => ({
    id: band.id,
    label: band.label,
    lgas: lgas.filter((row) => row.standing === band.id).sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).map((row) => ({ key: row.key, name: row.name, share: row.share })),
  }));

  const members = pulse.members || {};
  const reference = pulse.reference || {};
  const center = pulse.contactCenter || {};

  const watch = [];
  if (center.available && center.open) watch.push({ tone: 'risk', text: `${fmt(center.open)} call-center calls are still open${center.followUpRequested ? ` and ${fmt(center.followUpRequested)} people asked to be called back` : ''}.` });
  const disputes = center.themes?.find((theme) => theme.id === 'party');
  if (disputes) watch.push({ tone: 'risk', text: `${fmt(disputes.calls)} calls reported party unity or leadership disputes. Refer them to the LGA coordinators.` });
  const blind = lgas.filter((row) => row.share == null && !row.calls).sort((a, b) => (b.registered || 0) - (a.registered || 0));
  if (blind.length) watch.push({ tone: 'watch', text: `No survey and no calls yet in ${blind.slice(0, 4).map((row) => row.name).join(', ')}${blind.length > 4 ? ` and ${blind.length - 4} more` : ''} (${fmt(blind.reduce((sum, row) => sum + (row.registered || 0), 0))} registered voters).` });
  const weakest = lgas.filter((row) => row.share != null && row.share < 0.2).sort((a, b) => a.share - b.share);
  if (weakest.length) watch.push({ tone: 'watch', text: `Sen. Alli is weakest in ${weakest.slice(0, 3).map((row) => `${row.name} (${pct(row.share)})`).join(', ')}.` });
  const noMembers = lgas.filter((row) => !row.members);
  if (noMembers.length) watch.push({ tone: 'risk', text: `No APC confirmed members recorded in ${noMembers.slice(0, 4).map((row) => row.name).join(', ')}.` });

  return {
    place: pulse.filter?.label || 'All of Oyo',
    intention,
    numbers: {
      registered: reference.registeredVoters?.value ?? null,
      pvcRate: reference.pvcRate ?? null,
      members: members.available ? members.total : null,
      pollingUnitsReached: members.available ? members.unitsCovered : null,
      pollingUnits: members.available ? members.pollingUnits : pulse.register?.pollingUnits ?? null,
      lgasReached: members.available ? members.lgasWithMembers : null,
      lgas: pulse.register?.lgas ?? 33,
      tenx: pulse.tenx?.available ? pulse.tenx.total : null,
      tenxConnected: Boolean(pulse.tenx?.available),
    },
    standing,
    requests: {
      survey: (survey.topIssues || []).slice(0, 4).map((row) => ({ name: row.name, share: row.share })),
      callers: (center.requests?.length ? center.requests : center.themes || []).filter((row) => row.id !== 'party').slice(0, 4).map((row) => ({ name: row.label, calls: row.calls })),
    },
    platforms: (survey.platform || []).slice(0, 4).map((row) => ({ name: row.name, share: row.share })),
    callCenter: center.available ? {
      period: center.period,
      calls: center.calls,
      people: center.unique,
      supporters: center.supporters,
      notEstablished: center.notEstablished,
      open: center.open,
      followUp: center.followUpRequested,
      droppedShare: center.droppedShare,
      lgasCalled: center.lgasCalled,
      wardsReached: center.wardsReached,
    } : null,
    watch,
  };
}
