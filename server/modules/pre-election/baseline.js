import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * The pre-election data the app ships with (built by scripts/build-pre-election-baseline.mjs
 * from the campaign's files), so the Pulse is populated before anyone uploads. An upload always
 * wins: a member list replaces the built-in list with the same name, and a contact list, contact
 * center report, reference table or survey replaces the built-in one of its kind.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'pre-election-baseline.json.gz');
let cached;
function load() {
  if (cached !== undefined) return cached;
  try {
    cached = existsSync(FILE) ? JSON.parse(gunzipSync(readFileSync(FILE)).toString('utf8')) : null;
  } catch (error) {
    console.warn('[pre-election] Built-in data could not be read:', error.message);
    cached = null;
  }
  return cached;
}

export const baselineSurvey = () => load()?.survey || null;

/**
 * Voter register totals by LGA -> INEC ward number -> INEC unit number (see
 * scripts/aggregate-voter-register.mjs): voters, women, age bands, occupation groups, disability,
 * phone on file. Counts only. null when the built-in data has no register.
 */
export const baselineRegister = () => load()?.register || null;

/** Uploaded datasets plus the built-in ones no upload has replaced. */
export function withBaseline(uploaded = []) {
  const builtIn = (load()?.datasets || []).filter((item) => !uploaded.some((upload) => upload.kind === item.kind
    && (item.kind !== 'members' || upload.label.toLowerCase() === item.label.toLowerCase())));
  return [...uploaded, ...builtIn];
}
