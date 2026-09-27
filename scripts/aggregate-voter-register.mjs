#!/usr/bin/env node
/**
 * Summarises the Oyo voter register workbook into area totals, for the pre-election built-in data.
 *
 *   node scripts/aggregate-voter-register.mjs Oyo_Voter_Register_Master.xlsx register-areas.json
 *   node scripts/build-pre-election-baseline.mjs ... --register register-areas.json
 *
 * The register holds every voter's name, phone, address and voter ID number. None of that is
 * written: the output is counts per LGA -> ward -> polling unit (as the register labels them):
 *   v voters · f women · a age bands (18-24, 25-34, 35-44, 45-54, 55-64, 65+, at 1 Jan 2027)
 *   o occupation groups · d with a recorded disability · p with a phone number on file
 *
 * The workbook is ~250MB with sheets that unpack to ~760MB each, far past what can be read in
 * one piece, so each sheet is inflated and parsed as a stream.
 */
import { fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { createInflateRaw, inflateRawSync } from 'node:zlib';

const [FILE, OUT] = process.argv.slice(2);
if (!FILE || !OUT) {
  console.error('Usage: node scripts/aggregate-voter-register.mjs <register.xlsx> <out.json>');
  process.exit(1);
}

const fd = openSync(FILE, 'r');
const size = fstatSync(fd).size;
const read = (pos, len) => { const buffer = Buffer.alloc(len); readSync(fd, buffer, 0, len, pos); return buffer; };

// Zip central directory: where each workbook part starts and how it is compressed.
const tail = read(Math.max(0, size - 65_557), Math.min(size, 65_557));
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
if (eocd < 0) throw new Error('Not an .xlsx workbook.');
const directory = read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));
const entries = new Map();
for (let offset = 0, n = 0; n < tail.readUInt16LE(eocd + 10); n += 1) {
  const nameLength = directory.readUInt16LE(offset + 28);
  entries.set(directory.toString('utf8', offset + 46, offset + 46 + nameLength), {
    method: directory.readUInt16LE(offset + 10),
    compressedSize: directory.readUInt32LE(offset + 20),
    localOffset: directory.readUInt32LE(offset + 42),
  });
  offset += 46 + nameLength + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
}
const dataStart = (entry) => { const header = read(entry.localOffset, 30); return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28); };
const smallPart = (name) => {
  const entry = entries.get(name);
  const raw = read(dataStart(entry), entry.compressedSize);
  return (entry.method ? inflateRawSync(raw) : raw).toString('utf8');
};

const unescape = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const columnIndex = (ref) => { let index = 0; for (const char of ref) index = index * 26 + (char.charCodeAt(0) - 64); return index - 1; };
const cellsOf = (rowXml) => {
  const row = [];
  for (const cell of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1];
    const inner = cell[2] || '';
    const text = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
    row[ref ? columnIndex(ref) : row.length] = unescape(text);
  }
  return row;
};

// Voter sheets, in workbook order (the register also carries an "Index" notes sheet).
const workbook = smallPart('xl/workbook.xml');
const rels = smallPart('xl/_rels/workbook.xml.rels');
const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [m[1].match(/\bId="([^"]+)"/)?.[1], m[1].match(/\bTarget="([^"]+)"/)?.[1]]));
const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)]
  .map((m) => ({ name: m[1].match(/\bname="([^"]*)"/)?.[1], path: `xl/${String(targets.get(m[1].match(/\br:id="([^"]+)"/)?.[1])).replace(/^\/?xl\//, '')}` }))
  .filter((sheet) => !/^index$/i.test(sheet.name) && entries.has(sheet.path));

const BANDS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const ELECTION_YEAR_START = new Date('2027-01-01');
const bandOf = (dob) => {
  const m = String(dob).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return -1;
  const age = (ELECTION_YEAR_START - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 3.15576e10;
  if (!(age >= 16 && age < 120)) return -1;
  return age < 25 ? 0 : age < 35 ? 1 : age < 45 ? 2 : age < 55 ? 3 : age < 65 ? 4 : 5;
};
const OCCUPATION = { TRADING: 'trading', STUDENT: 'student', ARTISAN: 'artisan', BUSINESS: 'business', 'FARMING/FISHING': 'farming', 'CIVIL SERVANT': 'public', 'PUBLIC SERVANT': 'public', 'HOUSE WIFE': 'homemaker', HOUSEWIFE: 'homemaker' };
const NO_DISABILITY = new Set(['', 'NONE', 'NIL', 'NO', 'N/A']);
const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const blank = () => ({ v: 0, f: 0, a: [0, 0, 0, 0, 0, 0], o: {}, d: 0, p: 0 });
const add = (stats, voter) => {
  stats.v += 1;
  if (voter.female) stats.f += 1;
  if (voter.band >= 0) stats.a[voter.band] += 1;
  stats.o[voter.occupation] = (stats.o[voter.occupation] || 0) + 1;
  if (voter.disabled) stats.d += 1;
  if (voter.phone) stats.p += 1;
};

const lgas = {};
let total = 0;
let header = null;

async function streamSheet(sheet) {
  const entry = entries.get(sheet.path);
  const start = dataStart(entry);
  const end = start + entry.compressedSize;
  const inflate = createInflateRaw();
  let buffer = '';
  const handle = (rowXml) => {
    const row = cellsOf(rowXml);
    const first = String(row[0] || '').toLowerCase();
    if (!header) { header = row.map((cell) => String(cell).toLowerCase()); return; }
    if (first === header[0]) return; // each sheet repeats the header
    const column = (name) => row[header.indexOf(name)];
    total += 1;
    const voter = {
      female: String(column('gender') || '').toLowerCase().startsWith('f'),
      band: bandOf(column('date of birth')),
      occupation: OCCUPATION[clean(column('occupation'))] || 'other',
      disabled: !NO_DISABILITY.has(clean(column('disability type'))),
      phone: /^0?[789]\d{9}$/.test(String(column('phone no') || '').replace(/\D/g, '')),
    };
    const lga = (lgas[clean(column('lga'))] ||= { s: blank(), wards: {} });
    const ward = (lga.wards[clean(column('ward'))] ||= { s: blank(), units: {} });
    add(lga.s, voter);
    add(ward.s, voter);
    add((ward.units[clean(column('polling unit'))] ||= blank()), voter);
  };
  await new Promise((resolve, reject) => {
    inflate.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let consumed = 0;
      for (const match of buffer.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) { handle(match[1]); consumed = match.index + match[0].length; }
      buffer = buffer.slice(consumed);
    });
    inflate.on('end', resolve);
    inflate.on('error', reject);
    let position = start;
    const pump = () => {
      while (position < end) {
        const length = Math.min(1 << 20, end - position);
        const ok = inflate.write(read(position, length));
        position += length;
        if (!ok) { inflate.once('drain', pump); return; }
      }
      inflate.end();
    };
    pump();
  });
  console.log(`${sheet.name}: ${total.toLocaleString()} voters so far`);
}

for (const sheet of sheets) await streamSheet(sheet);
writeFileSync(OUT, JSON.stringify({ total, bands: BANDS, lgas }));
console.log(`Wrote ${OUT}: ${total.toLocaleString()} voters in ${Object.keys(lgas).length} LGAs (totals only).`);
