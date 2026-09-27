import { wardResolver } from './geo.js';
import { matchLga } from './lga.js';
import { createPlaceKeyer, identityKeys, normalizePhone } from './datasets.js';

/**
 * Voter analysis: how many of the registered voters in each LGA, ward or polling unit the
 * campaign already has, and who those voters are.
 *
 *   our voters = APC confirmed members + 10x volunteers who are not already APC members
 *   reach      = our voters / registered voters
 *
 * A 10x volunteer counts only when they are not already an APC member. They are the same person
 * when any one of these matches (see identityKeys in datasets.js):
 *   the phone number · the name at the same polling unit · the name with the same date of birth
 * A name alone never matches: common names repeat many times in the APC list.
 *
 * That check needs oyo10x to send each volunteer's name, phone, date of birth and polling unit (a
 * per-person feed). They are turned into the same keyed hashes the member lists use the moment
 * they arrive and are never stored or returned. Until that feed exists, 10x volunteers are shown
 * on their own and are not added to "our voters", so nobody is counted twice.
 */

export const REACH_STATUS = [
  { id: 'strong', label: 'Strong', from: 0.1 },
  { id: 'good', label: 'Good', from: 0.05 },
  { id: 'thin', label: 'Thin', from: 0.02 },
  { id: 'veryThin', label: 'Very thin', from: Number.MIN_VALUE },
  { id: 'none', label: 'None yet', from: -Infinity },
];
const statusOf = (reach) => (reach == null ? null : REACH_STATUS.find((status) => reach >= status.from).id);
const fmt = (value) => Number(value || 0).toLocaleString('en-US');
const pct = (value, digits = 0) => `${((value || 0) * 100).toFixed(digits)}%`;
// "EKUNLE II" -> "Ekunle II", "L.A. SCHOOL" -> "L.A. School": Roman numerals and initials stay capitals.
const titleCase = (value) => String(value || '').toLowerCase()
  .replace(/(^|[\s/(-])([a-z])/g, (match, lead, char) => lead + char.toUpperCase())
  .replace(/\b(i{1,3}|iv|vi{0,3}|ix|xi{0,2})\b/gi, (numeral) => numeral.toUpperCase())
  .replace(/\b([a-z])\.(?=[a-z]\.)|(?<=\.)([a-z])\./gi, (match) => match.toUpperCase());

/** Every match key on the member lists (records carry them as their 5th element). */
export const memberMatchKeys = (memberSets) => new Set(memberSets.flatMap((set) => set.records.flatMap((record) => record[4] || [])));

/**
 * 10x volunteers who are not already APC members, placed on this view's areas.
 * people: [{ name, phone, dateOfBirth, lga, ward, pollingUnit }] from oyo10x;
 * memberKeys: Set of the member lists' match keys (memberMatchKeys).
 */
export function uniqueTenx(people, memberKeys, { level, lga = '', ward = null } = {}) {
  const placeKey = createPlaceKeyer();
  const perArea = new Map();
  let alreadyMembers = 0;
  let unique = 0;
  let unplaced = 0;
  const resolvers = new Map();
  const resolverFor = (name) => { if (!resolvers.has(name)) resolvers.set(name, wardResolver(name)); return resolvers.get(name); };
  for (const person of people) {
    const personLga = matchLga(person.lga);
    const keys = identityKeys({
      phone: normalizePhone(person.phone),
      name: person.name,
      dob: person.dateOfBirth ?? person.dob,
      place: placeKey(personLga, person.ward, person.pollingUnit),
    });
    if (keys.some((key) => memberKeys.has(key))) { alreadyMembers += 1; continue; }
    unique += 1;
    if (level === 'lga') { if (personLga) perArea.set(personLga, (perArea.get(personLga) || 0) + 1); else unplaced += 1; continue; }
    if (personLga !== lga) continue;
    const place = resolverFor(lga)(person.ward);
    if (level === 'ward') { if (place) perArea.set(String(place.number), (perArea.get(String(place.number)) || 0) + 1); else unplaced += 1; continue; }
    if (!place || place.number !== ward) continue;
    const unit = place.units.find((item) => String(item.number) === String(Number(person.pollingUnit)) || item.name.toLowerCase() === String(person.pollingUnit || '').toLowerCase());
    if (unit) perArea.set(String(unit.number), (perArea.get(String(unit.number)) || 0) + 1); else unplaced += 1;
  }
  return { perArea, total: people.length, alreadyMembers, unique, unplaced };
}

const weighted = (rows, key) => {
  const usable = rows.filter((row) => row[key] != null && row.registered);
  const voters = usable.reduce((sum, row) => sum + row.registered, 0);
  return voters ? usable.reduce((sum, row) => sum + row[key] * row.registered, 0) / voters : null;
};
const median = (values) => {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

export function buildVoterAnalysis({ map, memberKeys = new Set(), tenxPeople = null }) {
  const level = map.level;
  const areaWord = { lga: 'LGA', ward: 'ward', pu: 'polling unit' }[level];
  const place = level === 'lga' ? 'Oyo State' : level === 'ward' ? map.lga?.name : titleCase(map.ward?.name);
  // Without match keys on the member lists every volunteer would look new, so nothing is checked.
  const canCheck = Boolean(tenxPeople) && memberKeys.size > 0;
  const tenx = canCheck ? uniqueTenx(tenxPeople, memberKeys, { level, lga: map.lga?.key, ward: map.ward?.number }) : null;
  const tenxStatus = tenx ? 'checked' : tenxPeople ? 'no-member-keys' : map.totals.tenx != null ? 'totals-only' : 'not-connected';

  const rows = map.rows.map((row) => {
    const v = row.values;
    const registered = v.registered || null;
    const apc = v.members || 0;
    const tenxUnique = tenx ? tenx.perArea.get(row.key) || 0 : null;
    const ours = apc + (tenxUnique || 0);
    const reach = registered ? ours / registered : null;
    return {
      key: row.key,
      name: level === 'lga' ? row.name : titleCase(row.name),
      number: row.number ?? null,
      registered,
      apc,
      tenx: v.tenx ?? null,
      tenxUnique,
      ours,
      reach: reach == null ? null : Number(reach.toFixed(4)),
      gap: registered ? Math.max(registered - ours, 0) : null,
      status: statusOf(reach),
      women: v.women ?? null,
      youth: v.youth ?? null,
      older: v.older ?? null,
      occupation: v.occupation ?? null,
      phone: v.phone ?? null,
      pres2023: v.pres2023 ?? null,
    };
  });

  const registered = rows.reduce((sum, row) => sum + (row.registered || 0), 0);
  // A person listed in two LGAs is counted in each LGA row, but only once in the state total.
  const apc = level === 'lga' && map.totals.members != null ? map.totals.members : rows.reduce((sum, row) => sum + row.apc, 0);
  const tenxUnique = tenx ? rows.reduce((sum, row) => sum + (row.tenxUnique || 0), 0) : null;
  const ours = apc + (tenxUnique || 0);
  const summary = {
    place,
    level,
    areaWord,
    areas: rows.length,
    registered,
    apc,
    tenx: tenx ? tenx.total : map.totals.tenx ?? null,
    tenxUnique,
    tenxAlreadyMembers: tenx ? tenx.alreadyMembers : null,
    tenxStatus,
    ours,
    reach: registered ? Number((ours / registered).toFixed(4)) : null,
    status: REACH_STATUS.map((status) => ({ id: status.id, label: status.label, areas: rows.filter((row) => row.status === status.id).length })),
    // The register's profile of this whole view, weighted by each area's voters.
    profile: {
      women: weighted(rows, 'women'),
      youth: weighted(rows, 'youth'),
      older: weighted(rows, 'older'),
      phone: weighted(rows, 'phone'),
    },
  };

  // ---- Intelligence ------------------------------------------------------------------------
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  const names = (list, value) => list.map((row) => `${row.name}${value ? ` (${value(row)})` : ''}`).join(', ');
  const withVoters = rows.filter((row) => row.registered);
  const midReach = median(withVoters.map((row) => row.reach));
  const midVoters = median(withVoters.map((row) => row.registered));
  const midYouth = median(withVoters.map((row) => row.youth));

  add('info', `${pct(summary.reach, 1)} of registered voters in ${place} are ${tenx ? 'APC members or 10x volunteers' : 'APC confirmed members'}: ${fmt(ours)} of ${fmt(registered)}.`);
  const gaps = [...withVoters].sort((a, b) => b.gap - a.gap).slice(0, 3);
  if (gaps.length) add('watch', `Most voters still to reach: ${names(gaps, (row) => `${fmt(row.gap)} voters`)}.`);
  const none = withVoters.filter((row) => !row.ours).sort((a, b) => b.registered - a.registered);
  if (none.length) add('risk', `${fmt(none.length)} ${areaWord}${none.length === 1 ? ' has' : 's have'} no member yet. Largest: ${names(none.slice(0, 3), (row) => `${fmt(row.registered)} voters`)}.`);
  const weak = withVoters.filter((row) => row.ours && row.registered >= (midVoters || 0)).sort((a, b) => a.reach - b.reach).slice(0, 3);
  if (weak.length && withVoters.length > 3) add('risk', `Thinnest membership among the larger ${areaWord}s: ${names(weak, (row) => pct(row.reach, 1))}.`);
  const strong = [...withVoters].sort((a, b) => b.reach - a.reach).slice(0, 3);
  if (strong.length && withVoters.length > 3) add('good', `Deepest membership: ${names(strong, (row) => pct(row.reach, 1))}.`);
  const young = withVoters.filter((row) => row.youth != null && midYouth != null && row.youth > midYouth && row.reach < (midReach || 0)).sort((a, b) => b.youth - a.youth).slice(0, 3);
  if (young.length) add('watch', `Young electorates with thin membership: ${names(young, (row) => `${pct(row.youth)} aged 18–34`)}. Youth programmes and social media fit here.`);
  const phoneless = withVoters.filter((row) => row.phone != null).sort((a, b) => a.phone - b.phone).slice(0, 3);
  if (phoneless.length && withVoters.length > 3) add('info', `Hardest to reach by phone (fewest voters with a phone on file): ${names(phoneless, (row) => pct(row.phone))}. Plan door-to-door and radio there.`);
  const protect = withVoters.filter((row) => row.pres2023 != null && row.pres2023 >= 0.5 && row.reach < (midReach || 0)).slice(0, 3);
  if (protect.length) add('watch', `APC won these in the 2023 presidential vote, but membership is below average: ${names(protect, (row) => `APC ${pct(row.pres2023)} in 2023`)}. Protect the base.`);
  const convert = withVoters.filter((row) => row.pres2023 != null && row.pres2023 < 0.4 && row.reach >= (midReach || 0)).sort((a, b) => b.reach - a.reach).slice(0, 3);
  if (convert.length) add('good', `Strong membership where APC lost in 2023: ${names(convert, (row) => `APC ${pct(row.pres2023)} in 2023`)}. These members can win votes back.`);
  if (tenxStatus !== 'checked') add('info', {
    'not-connected': '10x volunteers are not included yet: oyo10x is not connected.',
    'totals-only': '10x volunteers are shown but not added to our voters yet: oyo10x sends totals only, so they cannot be checked against APC members.',
    'no-member-keys': '10x volunteers are shown but not added to our voters yet: the APC list was loaded without the details needed to check them against it.',
  }[tenxStatus]);
  else if (tenx.alreadyMembers) add('info', `${fmt(tenx.alreadyMembers)} of ${fmt(tenx.total)} 10x volunteers are already APC members and are counted once.`);

  const order = { risk: 0, watch: 1, good: 2, info: 3 };
  return {
    level,
    lga: map.lga,
    ward: map.ward ? { number: map.ward.number, name: titleCase(map.ward.name) } : null,
    summary,
    rows: rows.sort((a, b) => (b.registered || 0) - (a.registered || 0)),
    insights: [out[0], ...out.slice(1).sort((a, b) => order[a.tone] - order[b.tone])],
  };
}
