// NACTA matching engine (PRD §8.2).
//
// Score model note: the PRD describes a Fuse.js "threshold" of 0.8 but also talks
// about high-similarity results. Fuse's raw `score` is a DISTANCE (0 = perfect,
// 1 = no match), which is the opposite of intuition. To keep one consistent model
// across NACTA + UNSC + the PDF ("Match Score: 72%"), we convert every Fuse score
// to a SIMILARITY = (1 - score) and compare against the configured threshold as a
// *minimum similarity* (higher = stricter). nactaThreshold (0.8) therefore means
// "names must be ≥80% similar to count", matching the PRD's "strict" intent.
import Fuse from 'fuse.js';
import { query } from '../db/db.js';
import { normalise } from './normalise.js';
import { config } from '../config/env.js';

const THRESHOLD = config.matching.nactaThreshold; // minimum similarity (0..1)

// Permissive Fuse distance threshold so we receive candidates with scores, then
// filter by computed similarity ourselves. ignoreLocation: match anywhere in string.
const FUSE_OPTS = { includeScore: true, ignoreLocation: true, threshold: 0.6 };

/** Best similarity (0..1) of `needle` against a list of candidate strings. */
function bestSimilarity(needle, candidates) {
  const clean = candidates.filter(Boolean);
  if (!needle || clean.length === 0) return 0;
  const fuse = new Fuse(clean.map((s) => ({ s })), { ...FUSE_OPTS, keys: ['s'] });
  const results = fuse.search(needle);
  if (results.length === 0) return 0;
  return 1 - (results[0].score ?? 1);
}

function displayRecord(r) {
  return {
    full_name: r.raw_full_name || r.full_name,
    father_name: r.raw_father_name || r.father_name,
    cnic: r.cnic,
  };
}

/**
 * @param {{ cnic: string, fullName: string, fatherName?: string }} input
 *        cnic must be the canonical XXXXX-XXXXXXX-X form; names are raw text.
 * @returns {Promise<{ matched: boolean, match_type: string, records: object[] }>}
 *
 * As of 2026-06-13 records carry their own `is_active` flag — we no longer scope
 * by a single list_id. All currently-active records (regardless of which upload
 * first introduced them) are eligible.
 */
export async function matchNacta({ cnic, fullName, fatherName }) {
  const normName = normalise(fullName);
  const normFather = normalise(fatherName);

  // ── Step 1: CNIC exact match (indexed) ────────────────────────────────────
  const cnicRows = await query(
    'SELECT * FROM nacta_records WHERE is_active = 1 AND cnic = :cnic',
    { cnic },
  );

  if (cnicRows.length > 0) {
    // Step 1a: confirm name + father name against the CNIC-matched record(s).
    const nameSim = bestSimilarity(normName, cnicRows.map((r) => r.full_name));
    const fatherSim = normFather
      ? bestSimilarity(normFather, cnicRows.map((r) => r.father_name))
      : 1; // no father name supplied → don't let it block confirmation

    const confirmed = nameSim >= THRESHOLD && fatherSim >= THRESHOLD;
    return {
      matched: true,
      match_type: confirmed ? 'CNIC_MATCH_NAME_CONFIRMED' : 'CNIC_MATCH_NAME_UNCONFIRMED',
      records: cnicRows.map(displayRecord),
    };
  }

  // ── Step 2: name + father fuzzy fallback ──────────────────────────────────
  // CRITICAL: only consider records that have NO CNIC. A record with a CNIC that
  // differs from the submitted one is a different person and must never be returned
  // by a name match — not even as a possible match. Name matching therefore applies
  // exclusively to name-only (CNIC-less) records.
  const allRows = await query(
    "SELECT * FROM nacta_records WHERE is_active = 1 AND (cnic IS NULL OR cnic = '')",
  );
  if (allRows.length === 0) {
    return { matched: false, match_type: 'NO_MATCH', records: [] };
  }

  const indexed = allRows.map((r) => ({
    combined: `${r.full_name} ${r.father_name}`.trim(),
    row: r,
  }));
  const fuse = new Fuse(indexed, { ...FUSE_OPTS, keys: ['combined'] });
  const needle = `${normName} ${normFather}`.trim();
  const hits = fuse
    .search(needle)
    .map((h) => ({ ...h, similarity: 1 - (h.score ?? 1) }))
    .filter((h) => h.similarity >= THRESHOLD);

  if (hits.length === 0) {
    return { matched: false, match_type: 'NO_MATCH', records: [] };
  }

  return {
    matched: true,
    match_type: 'NAME_ONLY_MATCH',
    records: hits.map((h) => displayRecord(h.item.row)),
  };
}
