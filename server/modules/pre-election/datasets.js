import { createHmac, randomUUID } from 'node:crypto';
import { buildContactCenter } from './contact-center.js';
import { matchLga, oyoLgas } from './lga.js';
import { oyoGeo, wardResolver } from './geo.js';

/**
 * Turns uploaded spreadsheets into stored pre-election datasets. Three kinds:
 *
 *   members    party members / polling-unit agents / volunteers. Kept per person as
 *              { lga, ward, unit, id } where id is a keyed hash of the phone number (or of the
 *              name when there is no phone). Names and phone numbers are dropped at the door --
 *              the hash exists only so the same person in two lists is counted once.
 *   contacts   a phone list. Only the count per LGA is kept.
 *   reference  one row per LGA: population, registered voters, PVCs collected.
 *   contact-center  the contact center's weekly report (already aggregated; see contact-center.js).
 *
 * Spreadsheets arrive in many shapes (one sheet per LGA, a title row above the header, "WARD 1"
 * as a column name), so columns are found by what their header says, not where they sit.
 */

export const DATASET_KINDS = ['members', 'contacts', 'reference', 'contact-center'];

const headerKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const COLUMN_PATTERNS = {
  lga: [/^lga\b/, /^local government/, /^l g a\b/, /^lgas?$/],
  // Order matters: the first pattern that hits any column wins, so specific names go first.
  ward: [/^ward name/, /^ward source/, /^wards?$/, /^ward\b(?! no)/],
  wardNo: [/^ward no/],
  unit: [/^pu code/, /^polling unit\b.*\b(no|code|number)\b/, /^unit\b/, /^units\b/, /^polling units?$/],
  phone: [/^phone (no|number)/, /phone/, /^mobile/, /^gsm/, /^tel\b/],
  name: [/^agent name/, /^member name/, /^full name/, /^names?$/, /^name\b/],
  dob: [/^date of birth/, /^dob\b/, /^birth ?date/],
  population: [/^population/],
  registeredVoters: [/^registered voters?/, /^registered/],
  pvcCollected: [/^pvcs? collected/, /^pvc/],
};

function findColumns(header) {
  const keys = header.map(headerKey);
  const columns = {};
  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (const pattern of patterns) {
      const index = keys.findIndex((key, i) => key && pattern.test(key) && !Object.values(columns).includes(i));
      if (index >= 0) { columns[field] = index; break; }
    }
  }
  return columns;
}

/** The header is the first of the top rows that names the columns this kind needs. */
function locateTable(rows, needs) {
  for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
    const columns = findColumns(rows[i] || []);
    if (needs.every((field) => columns[field] !== undefined)) return { headerIndex: i, columns };
  }
  return null;
}

// Workbooks exported by the cleaning tool carry a Master sheet plus per-LGA copies and review
// sheets of the same people. Read only the Master when there is one; skip review/summary sheets.
const SKIP_SHEET = /summary|review|duplicate|chart|analysis|dashboard|pivot/i;
function sheetsToRead(workbook) {
  const master = workbook.sheetNames.find((name) => /^master$/i.test(name.trim()));
  if (master) return [master];
  return workbook.sheetNames.filter((name) => !SKIP_SHEET.test(name));
}

function phoneFromDigits(text) {
  let digits = String(text).replace(/\.0+$/, '').replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) digits = `0${digits.slice(3)}`;
  // Excel stores phone numbers as numbers and drops the leading 0.
  if (digits.length === 10 && /^[789]/.test(digits)) digits = `0${digits}`;
  return /^0[789]\d{9}$/.test(digits) ? digits : '';
}

/** 11-digit Nigerian mobile number, or ''. A cell holding two numbers yields the first. */
export function normalizePhone(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const whole = phoneFromDigits(text);
  if (whole) return whole;
  for (const part of text.split(/[,/;&|]|\s+or\s+|\s{2,}/i)) {
    const phone = phoneFromDigits(part);
    if (phone) return phone;
  }
  const digits = text.replace(/\D/g, '');
  return digits.length === 22 ? phoneFromDigits(digits.slice(0, 11)) : '';
}

const hashKey = () => process.env.PRE_ELECTION_HASH_KEY || process.env.JWT_SECRET || 'sigar-pre-election';
// `household` is set when this list gives one phone number to several different people (by name
// and date of birth) -- a family sharing a line. Each of them is then a person of their own; a
// phone used by one person stays keyed by the phone alone, so they still match across lists.
const personId = (phone, name, lga, household = '') => {
  const basis = phone ? `p:${phone}${household ? `|${household}` : ''}` : `n:${clean(name).toLowerCase()}|${lga}`;
  return createHmac('sha256', hashKey()).update(basis).digest('base64url').slice(0, 16);
};
/** The key a member list stores for a phone number, so another list (e.g. 10x) can be checked against it. */
export const memberKey = (phone) => personId(phone, '', '');

// ---- Is this the same person? ------------------------------------------------------------------
// Another list (10x volunteers) is checked against the member lists with three keys, any one of
// which is a match: the phone number; the name at the same INEC polling unit; the name with the
// same date of birth. A name alone is never enough -- "Saheed Azeez" appears 21 times in the APC
// list. Every key is a keyed hash: names, phones and birth dates are not stored.
const TITLES = new Set(['alh', 'alhaji', 'alhaja', 'mr', 'mrs', 'miss', 'ms', 'chief', 'dr', 'hon', 'pastor', 'prince', 'princess', 'engr', 'deacon', 'deaconess', 'rev', 'evang', 'mallam', 'otunba', 'comrade', 'barr', 'prof', 'elder', 'mama', 'baba', 'iya', 'alfa']);
/** "ALH. SAHEED  AZEEZ" and "Azeez Saheed" -> "azeez saheed". '' when fewer than two name words remain. */
export function personNameKey(value) {
  const words = String(value ?? '').toLowerCase().replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter((word) => word.length >= 2 && !TITLES.has(word));
  return words.length >= 2 ? [...new Set(words)].sort().join(' ') : '';
}
/** YYYY-MM-DD from "1988-6-10", "10/06/1988" or an Excel date number; '' otherwise. */
export function birthDateKey(value) {
  const text = String(value ?? '').trim();
  let y; let m; let d;
  let hit = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (hit) [, y, m, d] = hit;
  else if ((hit = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [, d, m, y] = hit;
  else if (/^\d{5}(\.\d+)?$/.test(text)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(text)) * 86_400_000);
    [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else return '';
  const [year, month, day] = [Number(y), Number(m), Number(d)];
  if (year < 1900 || year > 2015 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const matchHash = (basis) => createHmac('sha256', hashKey()).update(basis).digest('base64url').slice(0, 12);

/** INEC "LGA|ward number|unit number" for a place, or '' when it cannot be placed exactly. */
export function createPlaceKeyer() {
  const resolvers = new Map();
  return (lga, ward, unit) => {
    if (!lga || !ward || !unit) return '';
    if (!resolvers.has(lga)) resolvers.set(lga, wardResolver(lga));
    const place = resolvers.get(lga)(ward);
    if (!place) return '';
    const number = /^\d+$/.test(String(unit)) ? Number(unit) : place.units.find((item) => nameKey(item.name) === nameKey(unit))?.number;
    return number !== undefined && place.units.some((item) => item.number === number) ? `${lga}|${place.number}|${number}` : '';
  };
}

/** The match keys for one person: any shared key with another list means the same person. */
export function identityKeys({ phone = '', name = '', dob = '', place = '' }) {
  const keys = [];
  if (phone) keys.push(matchHash(`p:${phone}`));
  const person = personNameKey(name);
  if (person && place) keys.push(matchHash(`np:${person}|${place}`));
  const born = birthDateKey(dob);
  if (person && born) keys.push(matchHash(`nd:${person}|${born}`));
  return keys;
}
const nameKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Lists drawn from the voter register name the polling unit ("BAPTIST SCHOOL, IDIYAN I") instead
 * of numbering it. Match the name to the INEC register -- inside the member's ward when the ward
 * can be placed, otherwise only when the name is unique in the LGA -- so coverage and the map
 * count it as the real INEC unit. Returns { ward, unit } or null; never guesses between two.
 */
function createUnitNameResolver() {
  const perLga = new Map();
  return (lga, ward, unitName) => {
    if (!perLga.has(lga)) {
      const byName = new Map();
      for (const place of oyoGeo().lgas.get(lga)?.wardList || []) {
        for (const unit of place.units) {
          const key = nameKey(unit.name);
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key).push({ place, unit });
        }
      }
      perLga.set(lga, { byName, resolveWard: wardResolver(lga) });
    }
    const { byName, resolveWard } = perLga.get(lga);
    const hits = byName.get(nameKey(unitName)) || [];
    if (!hits.length) return null;
    const place = ward ? resolveWard(ward) : null;
    const hit = (place && hits.find((item) => item.place === place)) || (hits.length === 1 ? hits[0] : null);
    return hit ? { ward: hit.place.name.toUpperCase().slice(0, 80), unit: String(hit.unit.number) } : null;
  };
}
const unitKey = (value) => {
  const text = clean(value);
  const number = text.match(/^0*(\d{1,3})\b/);
  return number ? String(Number(number[1])) : text.toLowerCase().slice(0, 60);
};

function buildMembers(workbook) {
  const pending = [];
  const unmatched = new Map();
  const resolveUnitName = createUnitNameResolver();
  const placeKey = createPlaceKeyer();
  let rowsRead = 0;
  let noPhone = 0;
  let unitsByName = 0;
  let unitsByNameMatched = 0;
  const sheetsUsed = [];
  for (const sheet of sheetsToRead(workbook)) {
    const rows = workbook.rows(sheet) || [];
    const table = locateTable(rows, ['phone']) || locateTable(rows, ['name']);
    if (!table) continue;
    const { columns, headerIndex } = table;
    // One-sheet-per-LGA workbooks have no LGA column: the sheet name is the LGA.
    const sheetLga = columns.lga === undefined ? matchLga(sheet) : '';
    if (columns.lga === undefined && !sheetLga) { unmatched.set(sheet, (unmatched.get(sheet) || 0) + Math.max(rows.length - headerIndex - 1, 0)); continue; }
    sheetsUsed.push(sheet);
    for (const row of rows.slice(headerIndex + 1)) {
      const name = columns.name !== undefined ? clean(row[columns.name]) : '';
      const phone = columns.phone !== undefined ? normalizePhone(row[columns.phone]) : '';
      if (!name && !phone) continue;
      rowsRead += 1;
      const rawLga = columns.lga !== undefined ? clean(row[columns.lga]) : sheet;
      const lga = sheetLga || matchLga(rawLga);
      if (!lga) { unmatched.set(rawLga || '(blank)', (unmatched.get(rawLga || '(blank)') || 0) + 1); continue; }
      if (!phone) noPhone += 1;
      // "Ward No." and "Ward Name" together ("03 IWERE-ILE III") give the matcher both a number and a name.
      let ward = clean([columns.wardNo, columns.ward].filter((index) => index !== undefined).map((index) => clean(row[index])).filter(Boolean).join(' ')).toUpperCase().slice(0, 80);
      let unit = columns.unit !== undefined ? unitKey(row[columns.unit]) : '';
      if (unit && !/^\d+$/.test(unit)) {
        unitsByName += 1;
        const hit = resolveUnitName(lga, ward, row[columns.unit]);
        if (hit) { unitsByNameMatched += 1; ({ ward, unit } = hit); }
      }
      const dob = columns.dob !== undefined ? clean(row[columns.dob]) : '';
      const person = columns.dob !== undefined ? `${nameKey(name)}|${dob}` : '';
      pending.push({ lga, ward, unit, phone, name, person, keys: identityKeys({ phone, name, dob, place: placeKey(lga, ward, unit) }) });
    }
  }
  if (!rowsRead) throw new Error('No member rows were found. The sheet needs a header row with a phone number or name column, and an LGA column (or one sheet per LGA).');

  // Which phones this list gives to more than one person (only knowable with a date of birth).
  const peoplePerPhone = new Map();
  for (const entry of pending) {
    if (!entry.phone || !entry.person) continue;
    if (!peoplePerPhone.has(entry.phone)) peoplePerPhone.set(entry.phone, new Set());
    peoplePerPhone.get(entry.phone).add(entry.person);
  }
  const sharedPhones = [...peoplePerPhone.values()].filter((people) => people.size > 1).length;
  // [lga, ward, unit, person id, match keys]: the keys let another list (10x) be checked against this one.
  const records = pending.map(({ lga, ward, unit, phone, name, person, keys }) =>
    [lga, ward, unit, personId(phone, name, lga, peoplePerPhone.get(phone)?.size > 1 ? person : ''), keys]);

  const unique = new Set(records.map((record) => record[3])).size;
  return {
    records,
    summary: {
      rowsRead,
      stored: records.length,
      uniquePeople: unique,
      duplicatesInFile: records.length - unique,
      noPhone,
      ...(sharedPhones ? { sharedPhones } : {}),
      ...(unitsByName ? { unitsByName, unitsByNameMatched } : {}),
      sheets: sheetsUsed,
      unmatched: [...unmatched.entries()].map(([name, count]) => ({ name, count })),
    },
  };
}

function buildContacts(workbook) {
  const counts = {};
  const seen = new Set();
  const unmatched = new Map();
  let rowsRead = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const sheet of sheetsToRead(workbook)) {
    const rows = workbook.rows(sheet) || [];
    const table = locateTable(rows, ['phone']);
    if (!table) continue;
    const { columns, headerIndex } = table;
    const sheetLga = columns.lga === undefined ? matchLga(sheet) : '';
    for (const row of rows.slice(headerIndex + 1)) {
      const raw = row[columns.phone];
      if (!clean(raw)) continue;
      rowsRead += 1;
      const phone = normalizePhone(raw);
      if (!phone) { invalid += 1; continue; }
      if (seen.has(phone)) { duplicates += 1; continue; }
      seen.add(phone);
      const rawLga = columns.lga !== undefined ? clean(row[columns.lga]) : sheet;
      const lga = sheetLga || matchLga(rawLga);
      if (!lga) { unmatched.set(rawLga || '(blank)', (unmatched.get(rawLga || '(blank)') || 0) + 1); continue; }
      counts[lga] = (counts[lga] || 0) + 1;
    }
  }
  if (!rowsRead) throw new Error('No phone numbers were found. The sheet needs a header row with a phone number column and an LGA column.');
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  // 1,048,575 data rows is Excel's sheet limit: a file that size was almost certainly cut off.
  const truncated = rowsRead >= 1_048_574;
  return { counts, summary: { rowsRead, stored: total, invalid, duplicatesInFile: duplicates, truncated, unmatched: [...unmatched.entries()].map(([name, count]) => ({ name, count })) } };
}

const numberOf = (value) => {
  const text = String(value ?? '').replace(/[,\s]/g, '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};

function buildReference(workbook) {
  const values = {};
  const unmatched = new Map();
  let rowsRead = 0;
  for (const sheet of workbook.sheetNames) {
    const rows = workbook.rows(sheet) || [];
    const table = locateTable(rows, ['lga']);
    if (!table) continue;
    const { columns, headerIndex } = table;
    if (!['population', 'registeredVoters', 'pvcCollected'].some((field) => columns[field] !== undefined)) continue;
    for (const row of rows.slice(headerIndex + 1)) {
      const rawLga = clean(row[columns.lga]);
      if (!rawLga || /^total$/i.test(rawLga)) continue;
      rowsRead += 1;
      const lga = matchLga(rawLga);
      if (!lga) { unmatched.set(rawLga, (unmatched.get(rawLga) || 0) + 1); continue; }
      const entry = values[lga] || {};
      for (const field of ['population', 'registeredVoters', 'pvcCollected']) {
        if (columns[field] === undefined) continue;
        const number = numberOf(row[columns[field]]);
        if (number !== null) entry[field] = number;
      }
      values[lga] = entry;
    }
  }
  if (!rowsRead) throw new Error('No LGA rows were found. Use the template: LGA, Population, Registered voters, PVCs collected.');
  const warnings = Object.entries(values)
    .filter(([, entry]) => entry.pvcCollected != null && entry.registeredVoters != null && entry.pvcCollected > entry.registeredVoters)
    .map(([lga]) => `${lga}: PVCs collected is higher than registered voters.`);
  const missing = oyoLgas().map((lga) => lga.name).filter((name) => !values[name]);
  return { values, summary: { rowsRead, stored: Object.keys(values).length, missingLgas: missing, warnings, unmatched: [...unmatched.entries()].map(([name, count]) => ({ name, count })) } };
}

export function buildDataset(kind, workbook, { label = '', sourceFile = '', source = '', year = '', uploadedBy = '', now = new Date() } = {}) {
  if (!DATASET_KINDS.includes(kind)) throw new Error(`Unknown dataset type. Use one of: ${DATASET_KINDS.join(', ')}.`);
  const built = kind === 'members' ? buildMembers(workbook)
    : kind === 'contacts' ? buildContacts(workbook)
      : kind === 'reference' ? buildReference(workbook)
        : (({ summary, ...report }) => ({ summary, report }))(buildContactCenter(workbook));
  return {
    id: randomUUID(),
    kind,
    label: clean(label).slice(0, 80) || { members: 'Members', contacts: 'Contacts in our possession', reference: 'Population & voter register', 'contact-center': `Contact center report${built.summary.period ? ` (${built.summary.period})` : ''}` }[kind],
    source: clean(source).slice(0, 200),
    year: clean(year).slice(0, 10),
    sourceFile: clean(sourceFile).slice(0, 200),
    uploadedBy,
    uploadedAt: now.toISOString(),
    ...built,
  };
}

/** What the data manager lists: everything but the stored rows. */
export const describeDataset = ({ records, counts, values, report, ...rest }) => rest;
