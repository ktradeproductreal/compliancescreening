// UNSC matching engine — SCORED 3-CHECK MODE (changed 2026-07-13 per user request).
//
// Same three inputs (name, DOB year, ID/CNIC) but now graded instead of pass/fail.
// Name matching is MANDATORY (token-AND fuzzy). Once name matches, we count how
// many corroborating checks positively pass (each contributes 0 or 1):
//
//   • DOB check positive: submitted year is in the UNSC record's extractYears(dob).
//     Null / missing dob on record → 0 (not a positive).
//   • CNIC check positive: submitted CNIC (canonical digits) matches one of the
//     UNSC record's identification_numbers_json entries.
//     Null / empty ID list on record → 0 (not a positive).
//
// Classification (corroboratingCount = 0..2 after name passes):
//   • 2 → CONFIRMED_MATCH  (all three align — high-confidence hit)
//   • 1 → POSSIBLE_MATCH   (partial — name + one other; needs manual review)
//   • 0 → NO_MATCH         (name alone is too weak, not surfaced)
//
// Under this model a UNSC record with BOTH null DOB and null ID is effectively
// unmatchable (nothing to corroborate a name hit). That's intentional — matches
// on name alone against records with no verifiable identifiers would be pure
// noise for a Pakistani-only customer base.
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
    // ── CHECK 1: NAME (mandatory) — token-AND across primary + aliases ──
    const candidates = [row.primary_name_normalised, ...asArray(row.aliases_normalised_json)];
    let nameSim = 0;
    for (const c of candidates) {
      const score = coverageScore(queryTokens, c);
      if (score !== null && score > nameSim) nameSim = score;
    }
    if (nameSim < MIN_SIMILARITY) continue;

    // ── CHECK 2 (corroborating): DOB year ──
    // Positive only if the record has extractable years AND the submitted year
    // is among them. Null/missing dob → 0 corroborating.
    const years = extractYears(row.dob);
    const dobPositive = years.length > 0 && years.includes(dobParts.year);

    // ── CHECK 3 (corroborating): CNIC ──
    // Positive only if the record's identification_numbers array contains the
    // submitted CNIC (alnum-normalised comparison). Empty list → 0 corroborating.
    const ids = asArray(row.identification_numbers_json);
    const cnicPositive = ids.some((id) => idsMatch(cnicAlnum, id));

    const corroboratingCount = (dobPositive ? 1 : 0) + (cnicPositive ? 1 : 0);
    if (corroboratingCount === 0) continue; // name-only match is not a hit

    const criteriaMatched = ['name'];
    const criteriaNotMatched = [];
    if (dobPositive) criteriaMatched.push('dob'); else criteriaNotMatched.push('dob');
    if (cnicPositive) criteriaMatched.push('cnic'); else criteriaNotMatched.push('cnic');

    hits.push({
      row,
      similarity: round2(nameSim),
      corroboratingCount,
      criteriaMatched,
      criteriaNotMatched,
    });
  }

  if (hits.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };

  // Sort strongest first: 2/2 before 1/2, then by name similarity within each band.
  hits.sort((a, b) =>
    b.corroboratingCount - a.corroboratingCount || b.similarity - a.similarity,
  );

  // Top-level match_type reflects the STRONGEST hit — a run with any 2/2 hit
  // reports CONFIRMED even if it also contains 1/2 partials.
  const anyConfirmed = hits.some((h) => h.corroboratingCount === 2);

  return {
    matched: true,
    match_type: anyConfirmed ? 'CONFIRMED_MATCH' : 'POSSIBLE_MATCH',
    records: hits.map(({ row, similarity, corroboratingCount, criteriaMatched, criteriaNotMatched }) => ({
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
      // Per-record classification — a POSSIBLE hit inside a run that also has
      // a CONFIRMED hit still shows as POSSIBLE at the record level.
      match_type: corroboratingCount === 2 ? 'CONFIRMED_MATCH' : 'POSSIBLE_MATCH',
      criteria_matched: criteriaMatched,
      criteria_not_matched: criteriaNotMatched,
    })),
  };
}
