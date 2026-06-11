// UNSC matching engine (PRD §8.3) — TOKEN-AWARE.
//
// Why not plain Fuse.js: Fuse scores character overlap across the whole string,
// so "ABDUL BARI" scores high against any "ABDUL ..." name because the shared
// "ABDUL" chunk dominates — returning dozens of irrelevant hits that merely share
// a common name particle. Instead we require that a SINGLE name/alias contains a
// match for EVERY query word (token-AND). "ABDUL BARI" therefore matches only
// names that have both an ABDUL-like AND a BARI-like token.
//
// Score model is unchanged conceptually: a 0..1 similarity with the same bands
// (≥0.85 confirmed; ≥ floor possible). Here the score is the average of each
// query word's best per-word similarity within the matching name/alias.
import { query } from '../db/db.js';
import { normaliseForUnsc } from './normalise.js';
import { config } from '../config/env.js';

const MIN_SIMILARITY = config.matching.unscThreshold; // overall floor (0.65)
const CONFIRMED_SIMILARITY = 0.85;
const TOKEN_SIM = config.matching.unscTokenThreshold; // per-word floor (0.8)

/** Split a name into comparable word tokens (drop particles shorter than 2 chars). */
function tokenize(s) {
  return String(s ?? '')
    .split(/[\s\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/** Levenshtein edit distance (iterative, two-row). Inputs are short name tokens. */
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

/** Per-word similarity in [0,1]. */
function wordSim(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

/**
 * If `candidateStr` contains a ≥TOKEN_SIM match for EVERY query token, return the
 * average best per-token similarity (the match score). Otherwise return null
 * (a required word is missing → not a match).
 */
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
    if (best < TOKEN_SIM) return null; // this query word is not present
    sum += best;
  }
  return sum / queryTokens.length;
}

const mentionsPakistan = (v) => typeof v === 'string' && v.toLowerCase().includes('pakistan');
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/** Pakistan relevance flag — also shown in results/PDF for kept records. */
function pakistanLink(r) {
  if (mentionsPakistan(r.nationality)) return 'Pakistani national';
  if (mentionsPakistan(r.pob)) return `Place of birth mentions Pakistan: ${r.pob}`;
  if (mentionsPakistan(r.address)) return `Address mentions Pakistan: ${r.address}`;
  if (mentionsPakistan(r.other_information)) return `Other information mentions Pakistan: ${r.other_information}`;
  return null;
}

/**
 * Pakistan-relevance filter (business rule, 2026-05-29): customers are all
 * Pakistani, so foreign-only sanctions entries are noise. KEEP a record if it
 * mentions Pakistan ANYWHERE (nationality / POB / address / other-information),
 * OR if it has no nationality/POB/whereabouts at all (can't rule it out). DROP it
 * only when it has geographic info that does not reference Pakistan.
 * NOTE: this deviates from PRD §8.3 (which keeps all UNSC hits) and can suppress a
 * genuine match to a non-Pakistan-linked individual — accepted for this use case.
 */
function isPakistanRelevant(r) {
  if (
    mentionsPakistan(r.nationality) ||
    mentionsPakistan(r.pob) ||
    mentionsPakistan(r.address) ||
    mentionsPakistan(r.other_information)
  ) {
    return true;
  }
  const hasGeo = nonEmpty(r.nationality) || nonEmpty(r.pob) || nonEmpty(r.address);
  return !hasGeo; // no geography to exclude on → keep (match by name)
}

/**
 * @param {{ fullName: string }} input
 * @param {number} listId active unsc_lists.id
 * @returns {Promise<{ matched: boolean, match_type: string, records: object[] }>}
 */
export async function matchUnsc({ fullName }, listId) {
  const needle = normaliseForUnsc(fullName);
  const queryTokens = tokenize(needle);
  if (queryTokens.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };

  const rows = await query('SELECT * FROM unsc_records WHERE list_id = :listId', { listId });
  if (rows.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };

  const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? safeJson(v) : []);

  const hits = [];
  for (const row of rows) {
    // Evaluate primary name AND each alias as standalone candidates — all query
    // words must appear within ONE of them (not spread across different aliases).
    const candidates = [row.primary_name_normalised, ...asArray(row.aliases_normalised_json)];
    let best = 0;
    for (const c of candidates) {
      const score = coverageScore(queryTokens, c);
      if (score !== null && score > best) best = score;
    }
    if (best >= MIN_SIMILARITY) hits.push({ row, similarity: round2(best) });
  }

  if (hits.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };

  // Pakistan-relevance filter: drop foreign-only sanctions entries (see isPakistanRelevant).
  const relevant = hits.filter((h) => isPakistanRelevant(h.row));
  if (relevant.length === 0) return { matched: false, match_type: 'NO_MATCH', records: [] };
  relevant.sort((a, b) => b.similarity - a.similarity);

  const anyConfirmed = relevant.some((h) => h.similarity >= CONFIRMED_SIMILARITY);

  return {
    matched: true,
    match_type: anyConfirmed ? 'CONFIRMED_MATCH' : 'POSSIBLE_MATCH',
    records: relevant.map(({ row, similarity }) => ({
      ref_code: row.ref_code,
      primary_name: row.primary_name,
      aliases: asArray(row.aliases_json),
      dob: row.dob,
      nationality: row.nationality,
      designation: row.designation,
      listed_on: row.listed_on,
      pakistan_link: pakistanLink(row),
      match_score: similarity,
    })),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function safeJson(v) {
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
