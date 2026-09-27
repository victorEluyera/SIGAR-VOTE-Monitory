#!/usr/bin/env node
/**
 * Builds the pre-election data the app ships with, so the Pulse shows real figures before
 * anyone uploads anything. Uploads made later in the Data tab take precedence over it.
 *
 *   node scripts/build-pre-election-baseline.mjs \
 *     --survey Oyo_Polls.xlsx \
 *     --contacts Raw_Phone_Number_Oyo.csv \
 *     --members "APC confirmed members=APC_contacts.csv|name,gender,date of birth,phone,polling unit,ward,lga,sim lga,call status" \
 *     --source "APC confirmed members=Where the list came from" \
 *     --register register-areas.json \
 *     --source "register=Where the voter register came from" \
 *     --contact-center Contact_Center_Report.xlsx
 *
 * What is written (server/data/pre-election-baseline.json.gz) holds no names and no phone
 * numbers: the survey is the same anonymised dataset an upload produces (collectors are opaque
 * numbers), contacts are counts per LGA, and each member is a random token -- the same token for
 * the same person across lists, so the two lists still deduplicate, but not derivable from the
 * phone number the way an upload's keyed hash is.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { openCsvWorkbook, openWorkbook } from '../server/modules/voter-survey/xlsx.js';
import { buildSurveyDataset } from '../server/modules/voter-survey/import.js';
import { buildDataset } from '../server/modules/pre-election/datasets.js';
import { wardResolver } from '../server/modules/pre-election/geo.js';
import { matchLga } from '../server/modules/pre-election/lga.js';

const args = process.argv.slice(2);
const option = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]] : []));
const open = (file) => (/\.csv$/i.test(file) ? openCsvWorkbook(readFileSync(file)) : openWorkbook(readFileSync(file)));
const builtAt = new Date().toISOString();
const meta = (dataset, file) => ({ ...dataset, sourceFile: basename(file), uploadedBy: 'built-in', uploadedAt: builtAt, builtIn: true });

// A file with no header row names its columns after a "|":
//   --members "Party members=list.csv|name,gender,date of birth,phone,polling unit,ward,lga,sim lga,call status"
const withHeader = (workbook, header) => (header
  ? { sheetNames: workbook.sheetNames, rows: (name) => { const rows = workbook.rows(name); return rows ? [header.split(',').map((cell) => cell.trim()), ...rows] : rows; } }
  : workbook);
// Where a list came from, shown with it in the Data tab:  --source "Party members=Claimed on a call"
const sources = new Map(option('source').map((spec) => spec.split(/=(.*)/s)));

const datasets = [];
const tokens = new Map();
for (const spec of option('members')) {
  const [label, target] = spec.includes('=') ? spec.split(/=(.*)/s) : ['Members', spec];
  const [file, header] = target.split('|');
  const dataset = buildDataset('members', withHeader(open(file), header), { label, source: sources.get(label) || '' });
  // Match keys (phone / name + polling unit / name + birth date, all keyed hashes) let 10x volunteers
  // be checked against this list. They only match if built with the server's own secret, so they
  // are kept only when PRE_ELECTION_HASH_KEY is set here to the same value as on the server.
  const keepKeys = Boolean(process.env.PRE_ELECTION_HASH_KEY);
  dataset.records = dataset.records.map(([lga, ward, unit, id, keys]) => {
    if (!tokens.has(id)) tokens.set(id, randomBytes(9).toString('base64url'));
    return keepKeys && keys?.length ? [lga, ward, unit, tokens.get(id), keys] : [lga, ward, unit, tokens.get(id)];
  });
  if (!keepKeys) console.log(`  (${label}: no match keys kept -- set PRE_ELECTION_HASH_KEY to the server's value to allow 10x checks)`);
  datasets.push(meta(dataset, file));
}
for (const file of option('contacts')) datasets.push(meta(buildDataset('contacts', open(file), { label: 'Contacts in our possession' }), file));
for (const file of option('contact-center')) datasets.push(meta(buildDataset('contact-center', open(file)), file));
for (const file of option('reference')) datasets.push(meta(buildDataset('reference', open(file), { source: sources.get('Population & voter register') || '' }), file));

// Voter register totals (from scripts/aggregate-voter-register.mjs), placed on INEC wards and
// polling units so the sentiment map can read them at every level. Ward and unit labels are
// matched the same way member lists are; voters whose ward or unit cannot be placed still count
// in their LGA (and ward) totals.
let register = null;
const registerFile = option('register')[0];
if (registerFile) {
  const raw = JSON.parse(readFileSync(registerFile, 'utf8'));
  const nameKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const merge = (into, from) => {
    into.v += from.v; into.f += from.f; into.d += from.d; into.p += from.p;
    from.a.forEach((count, i) => { into.a[i] += count; });
    for (const [key, count] of Object.entries(from.o)) into.o[key] = (into.o[key] || 0) + count;
    return into;
  };
  const empty = () => ({ v: 0, f: 0, a: raw.bands.map(() => 0), o: {}, d: 0, p: 0 });
  register = { source: sources.get('register') || basename(registerFile), bands: raw.bands, total: raw.total, lgas: {}, unplaced: { lgas: 0, wards: 0, units: 0 } };
  for (const [label, lga] of Object.entries(raw.lgas)) {
    const name = matchLga(label);
    if (!name) { register.unplaced.lgas += lga.s.v; continue; }
    const out = (register.lgas[name] ||= { s: empty(), wards: {} });
    merge(out.s, lga.s);
    const resolveWard = wardResolver(name, Object.keys(lga.wards));
    for (const [wardLabel, ward] of Object.entries(lga.wards)) {
      const place = resolveWard(wardLabel);
      if (!place) { register.unplaced.wards += ward.s.v; continue; }
      const wardOut = (out.wards[place.number] ||= { s: empty(), units: {} });
      merge(wardOut.s, ward.s);
      const units = new Map(place.units.map((unit) => [nameKey(unit.name), unit.number]));
      for (const [unitLabel, stats] of Object.entries(ward.units)) {
        const number = units.get(nameKey(unitLabel)) ?? (/^\d+$/.test(unitLabel) ? Number(unitLabel) : undefined);
        if (number === undefined) { register.unplaced.units += stats.v; continue; }
        wardOut.units[number] = merge(wardOut.units[number] || empty(), stats);
      }
    }
  }
  // Registered voters per LGA become the reference table too, unless one was given explicitly.
  if (!option('reference').length) {
    const csv = `LGA,Registered voters\n${Object.entries(register.lgas).map(([name, lga]) => `"${name}",${lga.s.v}`).join('\n')}\n`;
    datasets.push(meta(buildDataset('reference', openCsvWorkbook(Buffer.from(csv)), { source: sources.get('register') || 'Voter register' }), registerFile));
  }
}

let survey = null;
const surveyFile = option('survey')[0];
if (surveyFile) {
  survey = buildSurveyDataset(open(surveyFile), { sourceFile: basename(surveyFile), importedBy: 'built-in' });
  // Written answers stay (the sentiment analysis reads them), minus anything shaped like a phone number.
  for (const field of ['impression', 'whyYes', 'whyNo', 'secondChoiceResponse']) {
    if (survey.values[field]) survey.values[field] = survey.values[field].map((text) => text.replace(/\+?\d[\d\s-]{6,}\d/g, '[number removed]'));
  }
  survey.builtIn = true;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data', 'pre-election-baseline.json.gz');
writeFileSync(out, gzipSync(JSON.stringify({ builtAt, survey, datasets, register })));
console.log(`Wrote ${out}`);
for (const dataset of datasets) console.log(`  ${dataset.kind.padEnd(15)} ${dataset.label}: ${JSON.stringify(dataset.summary).slice(0, 160)}`);
if (survey) console.log(`  survey          ${survey.responseCount} responses from ${survey.sourceFile}`);
if (register) {
  const wards = Object.values(register.lgas).reduce((sum, lga) => sum + Object.keys(lga.wards).length, 0);
  const units = Object.values(register.lgas).reduce((sum, lga) => sum + Object.values(lga.wards).reduce((n, ward) => n + Object.keys(ward.units).length, 0), 0);
  console.log(`  register        ${register.total} voters · ${Object.keys(register.lgas).length} LGAs, ${wards} wards, ${units} polling units placed · not placed: ${JSON.stringify(register.unplaced)}`);
}
