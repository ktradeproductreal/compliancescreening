// Shared list-ingest logic — called by both the UI upload controller and the
// cron sync scripts.
//
// NACTA (2026-07-20): wipe-and-reinsert. Every sync DELETEs all nacta_records
// and INSERTs the incoming set as-is. No identity dedup, no duplicates dropped
// — the DB is an exact mirror of what NACTA published at scrape time. Rationale:
// the previous identity-key dedup could hide records NACTA legitimately listed
// twice, and the every-15-min cron makes per-record "first seen" audit
// low-value. Per-run audit is preserved via sync_log.delta_json (added,
// deactivated counts).
//
// UNSC: still uses identity-key (ref_code) dedup with field-refresh on match —
// UNSC records legitimately update over time (aliases, DOB corrections), and
// ref_code is guaranteed unique upstream.
//
// Both functions take a transaction connection so the whole ingest is atomic.
import { withTransaction } from '../db/db.js';
import { nextVersion } from './versionService.js';

// ─── NACTA ingest (wipe & re-insert) ─────────────────────────────────────────

async function ingestNactaInner({ conn, records, filename, userId }) {
  // Per-record audit events. For wipe-and-reinsert we don't emit added/
  // deactivated per row (would be 5000+ rows every 15 min → sync_events
  // balloon); the delta_json summary covers it. Parser-level events
  // (skipped, warning) are still logged by the caller.
  const events = [];

  // 1. Create the new list version + flip list-metadata active flag.
  const version = await nextVersion(conn, 'nacta');
  await conn.execute('UPDATE nacta_lists SET is_active = 0 WHERE is_active = 1');
  const [listResult] = await conn.execute(
    `INSERT INTO nacta_lists
       (version_major, version_minor, version_label, filename, uploaded_by, record_count, is_active)
     VALUES (?, ?, ?, ?, ?, 0, 1)`,
    [version.major, version.minor, version.label, filename, userId],
  );
  const listId = listResult.insertId;

  // 2. Wipe. No FK points at nacta_records, so DELETE is safe. Old
  //    sync_events.existing_record_id values become dangling ints — that's
  //    fine, they're informational, not a FK.
  const [delResult] = await conn.execute('DELETE FROM nacta_records');
  const previouslyStored = delResult.affectedRows;

  // 3. Bulk-insert everything as-is (no dedup).
  if (records.length > 0) {
    const values = records.map((r) => [
      listId, r.full_name, r.father_name, r.cnic,
      r.raw_full_name, r.raw_father_name, r.raw_cnic, 1,
    ]);
    await conn.query(
      `INSERT INTO nacta_records
         (list_id, full_name, father_name, cnic,
          raw_full_name, raw_father_name, raw_cnic, is_active)
       VALUES ?`,
      [values],
    );
  }

  // 4. record_count = what we just inserted.
  const totalActive = records.length;
  await conn.execute('UPDATE nacta_lists SET record_count = ? WHERE id = ?', [totalActive, listId]);

  // Keep the stats shape the same as before so downstream (frontend Sync Logs,
  // UI upload response) don't need to change. In wipe mode: added == total,
  // deactivated == previous count, kept/reactivated/duplicates_in_file == 0.
  return {
    listId,
    version,
    events,
    stats: {
      total_active: totalActive,
      added: totalActive,
      kept: 0,
      reactivated: 0,
      deactivated: previouslyStored,
      duplicates_in_file: 0,
    },
  };
}

// ─── UNSC ingest (dedupe by ref_code, UPDATE other fields on match) ──────────

async function ingestUnscInner({ conn, records, filename, userId }) {
  // 1. Dedupe within the file by ref_code.
  const incomingByRef = new Map();
  let duplicatesInFile = 0;
  for (const r of records) {
    if (incomingByRef.has(r.ref_code)) {
      duplicatesInFile += 1;
      continue;
    }
    incomingByRef.set(r.ref_code, r);
  }

  // 2. Next version + flip list-metadata flag.
  const version = await nextVersion(conn, 'unsc');
  await conn.execute('UPDATE unsc_lists SET is_active = 0 WHERE is_active = 1');
  const [listResult] = await conn.execute(
    `INSERT INTO unsc_lists
       (version_major, version_minor, version_label, filename, uploaded_by, record_count, is_active)
     VALUES (?, ?, ?, ?, ?, 0, 1)`,
    [version.major, version.minor, version.label, filename, userId],
  );
  const listId = listResult.insertId;

  // 3. Load existing records (identity columns only).
  const [existing] = await conn.query('SELECT id, ref_code, is_active FROM unsc_records');
  const existingByRef = new Map();
  for (const r of existing) existingByRef.set(r.ref_code, r);

  // 4. Categorise.
  const toInsert = [];
  const toUpdate = [];
  const matchedExistingIds = new Set();

  for (const [ref, incoming] of incomingByRef) {
    const hit = existingByRef.get(ref);
    if (hit) {
      matchedExistingIds.add(hit.id);
      toUpdate.push({ id: hit.id, incoming, wasInactive: !hit.is_active });
    } else {
      toInsert.push(incoming);
    }
  }

  // 5. Deactivate vanished rows.
  const toDeactivateIds = existing
    .filter((r) => r.is_active && !matchedExistingIds.has(r.id))
    .map((r) => r.id);
  if (toDeactivateIds.length > 0) {
    await conn.query('UPDATE unsc_records SET is_active = 0 WHERE id IN (?)', [toDeactivateIds]);
  }

  // 6. Update existing rows (refresh fields + ensure is_active = 1).
  for (const u of toUpdate) {
    const r = u.incoming;
    await conn.execute(
      `UPDATE unsc_records SET
         primary_name = ?, primary_name_normalised = ?,
         name_parts_json = ?, aliases_json = ?, aliases_normalised_json = ?,
         nationality = ?, address = ?, dob = ?, pob = ?,
         designation = ?, listed_on = ?, original_script_name = ?, other_information = ?,
         identification_numbers_json = ?,
         is_active = 1
       WHERE id = ?`,
      [
        r.primary_name, r.primary_name_normalised,
        JSON.stringify(r.name_parts_json), JSON.stringify(r.aliases_json),
        JSON.stringify(r.aliases_normalised_json),
        r.nationality, r.address, r.dob, r.pob,
        r.designation, r.listed_on, r.original_script_name, r.other_information,
        JSON.stringify(r.identification_numbers_json || []),
        u.id,
      ],
    );
  }

  // 7. Bulk-insert truly new records.
  if (toInsert.length > 0) {
    const values = toInsert.map((r) => [
      listId, r.ref_code, r.primary_name, r.primary_name_normalised,
      JSON.stringify(r.name_parts_json), JSON.stringify(r.aliases_json),
      JSON.stringify(r.aliases_normalised_json), r.nationality, r.address, r.dob, r.pob,
      r.designation, r.listed_on, r.original_script_name, r.other_information,
      JSON.stringify(r.identification_numbers_json || []), 1,
    ]);
    await conn.query(
      `INSERT INTO unsc_records
         (list_id, ref_code, primary_name, primary_name_normalised,
          name_parts_json, aliases_json, aliases_normalised_json,
          nationality, address, dob, pob,
          designation, listed_on, original_script_name, other_information,
          identification_numbers_json, is_active)
       VALUES ?`,
      [values],
    );
  }

  const totalActive = matchedExistingIds.size + toInsert.length;
  await conn.execute('UPDATE unsc_lists SET record_count = ? WHERE id = ?', [totalActive, listId]);

  const reactivated = toUpdate.filter((u) => u.wasInactive).length;
  const kept = toUpdate.length - reactivated;
  return {
    listId,
    version,
    stats: {
      total_active: totalActive,
      added: toInsert.length,
      kept,
      reactivated,
      updated: toUpdate.length,
      deactivated: toDeactivateIds.length,
      duplicates_in_file: duplicatesInFile,
    },
  };
}

// ─── Public API (wraps each in a transaction) ────────────────────────────────

/** Persist a NACTA list (Excel parser output) with dedup. */
export function ingestNacta({ records, filename, userId }) {
  return withTransaction((conn) => ingestNactaInner({ conn, records, filename, userId }));
}

/** Persist a UNSC list (HTML or XML parser output) with dedup + field refresh. */
export function ingestUnsc({ records, filename, userId }) {
  return withTransaction((conn) => ingestUnscInner({ conn, records, filename, userId }));
}
