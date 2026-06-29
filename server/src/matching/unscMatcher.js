// UNSC matching engine — STRICT 3-CHECK MODE (changed 2026-06-23 per requirement).
//
// Tightening rationale: customer base is Pakistani-only, so we now require
// EVERY one of these three independent checks to pass before returning a hit:
//
//   1. NAME match     — same token-AND fuzzy logic as before (no change).
//   2. DOB YEAR match — submitted DOB's year must appear in the UNSC record's
//                       dob field (UNSC records often only have year info).
//   3. ID match       — submitted CNIC digits must match one of the UNSC record's
//                       identification_numbers_json entries (passports / national
//                       IDs / etc). If the UNSC record has NO ID, the check fails.
//
// "If 2 of 3 match it's still NO_MATCH" — explicitly required by user.
// The previous "Pakistan-relevance" filter is REMOVED.
//
// Compliance trade-off: this is high-precision / low-recall. In practice the UNSC
// list rarely has Pakistani CNICs as IDs, so most genuine sanctions hits won't
// surface. The compliance officer should treat UNSC NO_MATCH as "no entry with a
// matching ID" — not "person definitively not on the UN list."
import { query } from '../db/db.js';
import { normaliseForUnsc } from './normalise.js';
import { config } from '../config/env.js';
import { parseDob, extractYears } from '../utils/dob.js';

const MIN_SIMILARITY = config.matching.unscThreshold;       // 0.65 — name floor
const CONFIRMED_SIMILARITY = 0.85;
const TOKEN_SIM = config.matching.unscTokenThreshold;       // 0.8 — per-word

// ─── name-match helpers (unchanged from previous token-AND logic) ────────────

function tokenize(s) {
  return String(s ?? '').split(/[\s\-]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function wordSim(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

/** Average best per-token similarity if every query token is "present"; else null. */
function coverageScore(queryTokens, candidateStr) {
  const candTokens = tokenize(candidateStr);
  if (candTokens.length === 0) return null;
  let sum = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const c of candTokens) {
      const s = wordSim(q, c);
      if (s > best) best = s;
      if (best === 1) break;
    }
    if (best < TOKEN_SIM) return null;
    sum += best;
  }
  return sum / queryTokens.length;
}

// ─── ID-match helpers ────────────────────────────────────────────────────────

/** Compare two ID strings ignoring everything non-alphanumeric, case-insensitive. */
function idsMatch(submittedDigits, recordValue) {
  if (!recordValue) return false;
  const a = String(recordValue).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return a.length > 0 && a === submittedDigits;
}

const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? safeJson(v) : []);

function safeJson(v) {
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Informational (kept so UI/PDF can still display the link if it exists)
// — but does NOT filter results anymore.
function pakistanLink(r) {
  const has = (v) => typeof v === 'string' && v.toLowerCase().includes('pakistan');
  if (has(r.nationality)) return 'Pakistani national';
  if (has(r.pob)) return `Place of birth mentions Pakistan: ${r.pob}`;
  if (has(r.address)) return `Address mentions Pakistan: ${r.address}`;
  if (has(r.other_information)) return `Other information mentions Pakistan: ${r.other_information}`;
  return null;
}

// ─── Public entrypoint ──────────────────────────────────────────────────────

/**
 * @param {{ fullName: string, cnic: string, dob: string }} input
 *        cnic = canonical XXXXX-XXXXXXX-X; dob = "DD-MMM-YYYY".
 *        ALL three are required — missing any → NO_MATCH (cannot pass 3 checks).
 */
export async function matchUnsc({ fullName, cnic, dob }) {
  // Pre-flight: ALL three inputs needed to even attempt a match.
  const dobParts = parseDob(dob);
  const cnicAlnum = String(cnic || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!fullName || !dobParts || cnicAlnum.length === 0) {
    return { matched: false, match_type: 'NO_MATCH', records: [] };
  }

  const needle = normaliseForUnsc(fullName);
  const queryTokens = tokenize(needle);
  if (queryTokens.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };

  const rows = await query('SELECT * FROM unsc_records WHERE is_active = 1');
  if (rows.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };

  const hits = [];
  for (const row of rows) {
    // ── CHECK 1: NAME (token-AND across primary + aliases) ──
    const candidates = [row.primary_name_normalised, ...asArray(row.aliases_normalised_json)];
    let nameSim = 0;
    for (const c of candidates) {
      const score = coverageScore(queryTokens, c);
      if (score !== null && score > nameSim) nameSim = score;
    }
    if (nameSim < MIN_SIMILARITY) continue;

    // ── CHECK 2: DOB YEAR ──
    // UNSC records often store only year (or year ranges). Submitted DOB's year
    // must appear in the extracted year set.
    const years = extractYears(row.dob);
    if (years.length === 0) continue;            // no DOB info on record → can't verify → not a match
    if (!years.includes(dobParts.year)) continue;

    // ── CHECK 3: IDENTIFICATION NUMBER ──
    // Submitted CNIC (digits only, dashes stripped) must equal any one of the
    // record's identification_numbers (also alnum-only, case-insensitive).
    const ids = asArray(row.identification_numbers_json);
    if (ids.length === 0) continue;              // record has no IDs → can't verify → not a match
    const anyIdMatches = ids.some((id) => idsMatch(cnicAlnum, id));
    if (!anyIdMatches) continue;

    // All three independent verifications passed.
    hits.push({ row, similarity: round2(nameSim) });
  }

  if (hits.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };
  hits.sort((a, b) => b.similarity - a.similarity);

  const anyConfirmed = hits.some((h) => h.similarity >= CONFIRMED_SIMILARITY);

  return {
    matched: true,
    match_type: anyConfirmed ? 'CONFIRMED_MATCH' : 'POSSIBLE_MATCH',
    records: hits.map(({ row, similarity }) => ({
      ref_code: row.ref_code,
      primary_name: row.primary_name,
      aliases: asArray(row.aliases_json),
      dob: row.dob,
      nationality: row.nationality,
      designation: row.designation,
      listed_on: row.listed_on,
      identification_numbers: asArray(row.identification_numbers_json),
      pakistan_link: pakistanLink(row), // informational only
      match_score: similarity,
    })),
  };
}
