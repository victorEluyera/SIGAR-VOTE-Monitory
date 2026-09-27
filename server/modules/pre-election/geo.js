import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createWardMatcher } from '../../../shared/wardMatch.js';
import { matchLga } from './lga.js';

/**
 * Oyo's electoral geography for the sentiment map, from the bundled INEC polling-unit register
 * (server/data/oyo-pu-register-2023.json.gz): every LGA -> ward (with its INEC number) -> polling
 * unit (with its INEC number, name, registered voters and the transcribed 2023 presidential
 * result), plus the 2023 LGA results (server/data/oyo-2023-lga-results.json).
 */

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const PRES_PARTIES = ['APC', 'PDP', 'LP', 'NNPP'];

let geo;
export function oyoGeo() {
  if (geo) return geo;
  const file = join(DATA, 'oyo-pu-register-2023.json.gz');
  const raw = existsSync(file) ? JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) : { units: [] };
  const lgas = new Map();
  for (const [lgaCode, wardCode, puCode, lgaName, wardName, name, registered, accredited, pres, status] of raw.units) {
    const lga = matchLga(lgaName);
    if (!lga) continue;
    if (!lgas.has(lga)) lgas.set(lga, { name: lga, code: lgaCode, wards: new Map() });
    const wards = lgas.get(lga).wards;
    const number = Number(wardCode);
    if (!wards.has(number)) wards.set(number, { number, code: `${lgaCode}-${wardCode}`, names: new Map(), units: [] });
    const ward = wards.get(number);
    // A few sheets carry a neighbouring ward's name; the ward is named by what most of its units say.
    ward.names.set(wardName, (ward.names.get(wardName) || 0) + 1);
    ward.units.push({ number: Number(puCode), code: `${lgaCode}-${wardCode}-${puCode}`, name, registered, accredited, pres: pres ? Object.fromEntries(PRES_PARTIES.map((party, i) => [party, pres[i]])) : null, status });
  }
  for (const lga of lgas.values()) {
    lga.wardList = [...lga.wards.values()].sort((a, b) => a.number - b.number).map((ward) => {
      ward.name = [...ward.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
      delete ward.names;
      ward.units.sort((a, b) => a.number - b.number);
      ward.registered = ward.units.reduce((sum, unit) => sum + unit.registered, 0);
      return ward;
    });
    lga.registered = lga.wardList.reduce((sum, ward) => sum + ward.registered, 0);
    lga.pollingUnits = lga.wardList.reduce((sum, ward) => sum + ward.units.length, 0);
    lga.numbered = new Map(lga.wardList.map((ward) => [ward.number, ward.name]));
  }
  geo = { source: raw.source || '', lgas };
  return geo;
}

/** match(label) -> ward (object) or null, for one LGA; labels help learn nothing when INEC numbers exist. */
export function wardResolver(lgaName, labels = []) {
  const lga = oyoGeo().lgas.get(lgaName);
  if (!lga) return () => null;
  const match = createWardMatcher(lga.wardList.map((ward) => ward.name), labels, lga.numbered);
  const byName = new Map(lga.wardList.map((ward) => [ward.name, ward]));
  // A label that is exactly an INEC ward name wins outright. The matcher reads the number inside
  // names like "S 7B" (Ibadan South-East) as a ward number and gives up on them.
  const nameKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const exact = new Map(lga.wardList.map((ward) => [nameKey(ward.name), ward]));
  return (label) => exact.get(nameKey(label)) || byName.get(match(label)) || null;
}

let results;
/** 2023 LGA results: { governorship, presidential } -> Map(lga -> { apc, pdp, winner, total, parties }). */
export function lgaResults2023() {
  if (results) return results;
  const file = join(DATA, 'oyo-2023-lga-results.json');
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const shape = (office) => new Map((office?.lgas || []).map((row) => {
    const sorted = Object.entries(row.parties).sort((a, b) => b[1] - a[1]);
    return [matchLga(row.lga), { total: row.total, parties: row.parties, winner: sorted[0]?.[0] || '', apc: row.total ? (row.parties.APC || 0) / row.total : null, pdp: row.total ? (row.parties.PDP || 0) / row.total : null }];
  }));
  results = { source: raw.governorship?.source || '', governorship: shape(raw.governorship), presidential: shape(raw.presidential) };
  return results;
}

/** Presidential 2023 summed over polling units that had a transcribed sheet. */
export function presFromUnits(units) {
  const withSheet = units.filter((unit) => unit.pres);
  if (!withSheet.length) return null;
  const parties = Object.fromEntries(PRES_PARTIES.map((party) => [party, withSheet.reduce((sum, unit) => sum + unit.pres[party], 0)]));
  const total = Object.values(parties).reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  const winner = Object.entries(parties).sort((a, b) => b[1] - a[1])[0][0];
  return { total, parties, winner, apc: parties.APC / total, pdp: parties.PDP / total, unitsWithSheet: withSheet.length, units: units.length };
}
