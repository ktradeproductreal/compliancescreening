// Shared list-ingest logic — called by both the UI upload controller and the
// cron sync scripts. Records are deduplicated via an IDENTITY KEY:
//   - NACTA with CNIC:    (cnic, full_name)
//   - NACTA without CNIC: (full_name, father_name)
//   - UNSC:               ref_code
// Behaviour per record:
//   - identity matches active record   → keep (NACTA) / update other fields (UNSC)
//   - identity matches inactive record → reactivate (+ update for UNSC)
//   - identity not in DB               → insert with is_active = 1
//   - active record absent from file   → mark is_active = 0 (kept for audit)
//
// Both functions take a transaction connection so the whole ingest is atomic.
import { withTransaction } from '../db/db.js';
import { nextVersion } from './versionService.js';

// ─── identity-key helpers ────────────────────────────────────────────────────

/** NACTA identity. CNIC-bearing → (cnic, full_name). CNIC-less → (full_name, father_name). */
function nactaKey(r) {
  if (r.cnic) return `c|${r.cnic}|${r.full_name}`;
  return `n|${r.full_name}|${r.father_name}`;
}

// ─── NACTA ingest ────────────────────────────────────────────────────────────

async function ingestNactaInner({ conn, records, filename, userId }) {
  // Per-record audit events collected throughout the ingest and returned to the
  // caller (which persists them to sync_events + logs them to stdout).
  const events = [];

  // 1. Dedupe within the incoming file (first occurrence wins).
  const incomingByKey = new Map();
  const firstRowByKey = new Map();
  let duplicatesInFile = 0;
  for (const r of records) {
    const k = nactaKey(r);
    if (incomingByKey.has(k)) {
      duplicatesInFile += 1;
      events.push({
        event_type: 'duplicate_in_file',
        row_number: r.row_number ?? null,
        cnic: r.cnic,
        full_name: r.raw_full_name,
        father_name: r.raw_father_name,
        detail: r.cnic
          ? `Same CNIC + name as row ${firstRowByKey.get(k)} in this file — second occurrence dropped.`
          : `Same name + father as row ${firstRowByKey.get(k)} in this file — second occurrence dropped (CNIC-less record).`,
      });
      continue;
    }
    incomingByKey.set(k, r);
    firstRowByKey.set(k, r.row_number ?? null);
  }

  // 2. Compute next list version + flip list-metadata active flag.
  const version = await nextVersion(conn, 'nacta');
  await conn.execute('UPDATE nacta_lists SET is_active = 0 WHERE is_active = 1');
  const [listResult] = await conn.execute(
    `INSERT INTO nacta_lists
       (version_major, version_minor, version_label, filename, uploaded_by, record_count, is_active)
     VALUES (?, ?, ?, ?, ?, 0, 1)`,
    [version.major, version.minor, version.label, filename, userId],
  );
  const listId = listResult.insertId;

  // 3. Load every existing record (active + inactive) for identity matching.
  const [existing] = await conn.query(
    'SELECT id, cnic, full_name, father_name, is_active FROM nacta_records',
  );
  const existingByKey = new Map();
  for (const r of existing) existingByKey.set(nactaKey(r), r);

  // 4. Categorise.
  const toInsert = [];
  const toActivate = []; // ids of inactive existing rows that reappear
  const matchedExistingIds = new Set();

  for (const [key, incoming] of incomingByKey) {
    const hit = existingByKey.get(key);
    if (hit) {
      matchedExistingIds.add(hit.id);
      if (!hit.is_active) {
        toActivate.push(hit.id);
        events.push({
          event_type: 'reactivated',
          row_number: incoming.row_number ?? null,
          cnic: incoming.cnic,
          full_name: incoming.raw_full_name,
          father_name: incoming.raw_father_name,
          existing_record_id: hit.id,
          detail: `Existing DB record #${hit.id} was inactive; reappeared in this upload — reactivated.`,
        });
      }
    } else {
      toInsert.push(incoming);
      events.push({
        event_type: 'added',
        row_number: incoming.row_number ?? null,
        cnic: incoming.cnic,
        full_name: incoming.raw_full_name,
        father_name: incoming.raw_father_name,
        detail: incoming.cnic
          ? `New person — no prior DB record with CNIC ${incoming.cnic}.`
          : 'New person — no prior DB record with this name/father (CNIC-less).',
      });
    }
  }

  // 5. Deactivate rows that were active but no longer appear.
  const deactivatedRows = existing.filter((r) => r.is_active && !matchedExistingIds.has(r.id));
  const toDeactivateIds = deactivatedRows.map((r) => r.id);
  if (toDeactivateIds.length > 0) {
    await conn.query('UPDATE nacta_records SET is_active = 0 WHERE id IN (?)', [toDeactivateIds]);
    for (const r of deactivatedRows) {
      events.push({
        event_type: 'deactivated',
        row_number: null,
        cnic: r.cnic,
        full_name: r.full_name,
        father_name: r.father_name,
        existing_record_id: r.id,
        detail: `DB record #${r.id} not present in current upload — marked inactive (kept in DB for audit).`,
      });
    }
  }

  // 6. Reactivate rows that reappear.
  if (toActivate.length > 0) {
    await conn.query('UPDATE nacta_records SET is_active = 1 WHERE id IN (?)', [toActivate]);
  }

  // 7. Bulk-insert new records.
  if (toInsert.length > 0) {
    const values = toInsert.map((r) => [
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

  // 8. record_count = currently active count.
  const totalActive = matchedExistingIds.size + toInsert.length;
  await conn.execute('UPDATE nacta_lists SET record_count = ? WHERE id = ?', [totalActive, listId]);

  const kept = matchedExistingIds.size - toActivate.length;
  return {
    listId,
    version,
    events, // per-record audit events for sync_events + stdout
    stats: {
      total_active: totalActive,
      added: toInsert.length,
      kept,
      reactivated: toActivate.length,
      deactivated: toDeactivateIds.length,
      duplicates_in_file: duplicatesInFile,
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
