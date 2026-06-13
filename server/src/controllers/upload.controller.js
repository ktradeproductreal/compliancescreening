// Upload controllers (PRD §7.2, modified 2026-06-13 for deduplicated storage).
//
// Each upload no longer inserts every record fresh. Instead records are matched
// against existing rows by an IDENTITY KEY:
//   - NACTA with CNIC:    (cnic, full_name)
//   - NACTA without CNIC: (full_name, father_name)
//   - UNSC:               ref_code
// Behaviour per record:
//   - identity matches an existing ACTIVE record   → keep (do nothing for NACTA,
//                                                   update fields for UNSC)
//   - identity matches an INACTIVE record           → reactivate (+ update for UNSC)
//   - identity not in DB                           → insert with is_active = 1
//   - existing active record absent from new file  → mark is_active = 0 (kept for audit)
//
// `nacta_lists` / `unsc_lists` still track each upload as an audit row.
import { withTransaction, query } from '../db/db.js';
import { parseNactaExcel } from '../parsers/excelParser.js';
import { parseUnscHtml } from '../parsers/htmlParser.js';
import { nextVersion } from '../services/versionService.js';
import { HttpError } from '../utils/asyncHandler.js';

// ─── identity-key helpers ────────────────────────────────────────────────────

/** NACTA identity. CNIC-bearing → (cnic, full_name). CNIC-less → (full_name, father_name). */
function nactaKey(r) {
  if (r.cnic) return `c|${r.cnic}|${r.full_name}`;
  return `n|${r.full_name}|${r.father_name}`;
}

// ─── NACTA ingest ────────────────────────────────────────────────────────────

async function ingestNacta({ conn, records, filename, userId }) {
  // 1. Dedupe within the incoming file itself (first occurrence wins).
  const incomingByKey = new Map();
  let duplicatesInFile = 0;
  for (const r of records) {
    const k = nactaKey(r);
    if (incomingByKey.has(k)) {
      duplicatesInFile += 1;
      continue;
    }
    incomingByKey.set(k, r);
  }

  // 2. Compute next list version + flip active flag at list-metadata level.
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
  const toActivate = []; // ids of inactive existing rows that reappear in this file
  const matchedExistingIds = new Set();

  for (const [key, incoming] of incomingByKey) {
    const hit = existingByKey.get(key);
    if (hit) {
      matchedExistingIds.add(hit.id);
      if (!hit.is_active) toActivate.push(hit.id);
      // NACTA "stay as is" — don't update other fields on identity match.
    } else {
      toInsert.push(incoming);
    }
  }

  // 5. Deactivate rows that were active but no longer appear.
  const toDeactivateIds = existing
    .filter((r) => r.is_active && !matchedExistingIds.has(r.id))
    .map((r) => r.id);
  if (toDeactivateIds.length > 0) {
    await conn.query('UPDATE nacta_records SET is_active = 0 WHERE id IN (?)', [toDeactivateIds]);
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

  // 8. Update the list's record_count to mean "currently active record count".
  const totalActive = matchedExistingIds.size + toInsert.length;
  await conn.execute('UPDATE nacta_lists SET record_count = ? WHERE id = ?', [totalActive, listId]);

  const kept = matchedExistingIds.size - toActivate.length;
  return {
    listId,
    version,
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

async function ingestUnsc({ conn, records, filename, userId }) {
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

  // 3. Load existing records (just identity columns to keep memory small).
  const [existing] = await conn.query('SELECT id, ref_code, is_active FROM unsc_records');
  const existingByRef = new Map();
  for (const r of existing) existingByRef.set(r.ref_code, r);

  // 4. Categorise.
  const toInsert = [];
  const toUpdate = []; // existing records whose fields we refresh from new file
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
         is_active = 1
       WHERE id = ?`,
      [
        r.primary_name, r.primary_name_normalised,
        JSON.stringify(r.name_parts_json), JSON.stringify(r.aliases_json),
        JSON.stringify(r.aliases_normalised_json),
        r.nationality, r.address, r.dob, r.pob,
        r.designation, r.listed_on, r.original_script_name, r.other_information,
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
      r.designation, r.listed_on, r.original_script_name, r.other_information, 1,
    ]);
    await conn.query(
      `INSERT INTO unsc_records
         (list_id, ref_code, primary_name, primary_name_normalised,
          name_parts_json, aliases_json, aliases_normalised_json,
          nationality, address, dob, pob,
          designation, listed_on, original_script_name, other_information, is_active)
       VALUES ?`,
      [values],
    );
  }

  // 8. Record_count = total currently active.
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

// ─── HTTP handlers ───────────────────────────────────────────────────────────

export async function uploadNacta(req, res) {
  if (!req.file) throw new HttpError(400, 'No file uploaded. Send the Excel file as field "file".');

  const { records, skipped, withoutCnic, warnings, totalRows } = parseNactaExcel(req.file.buffer);
  if (records.length === 0) {
    throw new HttpError(400, 'No valid rows found in the Excel file after parsing.');
  }

  const result = await withTransaction((conn) =>
    ingestNacta({ conn, records, filename: req.file.originalname, userId: req.user.id }),
  );

  res.status(201).json({
    list: 'nacta',
    version_label: result.version.label,
    record_count: result.stats.total_active,
    name_only_records: withoutCnic,
    rows_seen: totalRows,
    skipped,
    warnings,
    uploaded_at: new Date().toISOString(),
    // Dedup stats — show what actually changed vs the previous active set.
    delta: {
      added: result.stats.added,
      kept: result.stats.kept,
      reactivated: result.stats.reactivated,
      deactivated: result.stats.deactivated,
      duplicates_in_file: result.stats.duplicates_in_file,
    },
  });
}

export async function uploadUnsc(req, res) {
  if (!req.file) throw new HttpError(400, 'No file uploaded. Send the HTML file as field "file".');

  const { records, parseErrors, warnings } = parseUnscHtml(req.file.buffer);
  if (records.length === 0) {
    throw new HttpError(400, 'No UNSC entries found. Check that the file uses the expected tr.rowtext layout.');
  }

  const result = await withTransaction((conn) =>
    ingestUnsc({ conn, records, filename: req.file.originalname, userId: req.user.id }),
  );

  res.status(201).json({
    list: 'unsc',
    version_label: result.version.label,
    record_count: result.stats.total_active,
    parse_errors: parseErrors,
    warnings,
    uploaded_at: new Date().toISOString(),
    delta: {
      added: result.stats.added,
      kept: result.stats.kept,
      reactivated: result.stats.reactivated,
      updated: result.stats.updated,
      deactivated: result.stats.deactivated,
      duplicates_in_file: result.stats.duplicates_in_file,
    },
  });
}

/** GET /api/upload/status — active version summary for both lists (PRD §11 dashboard). */
export async function getStatus(_req, res) {
  const [nacta] = await query(
    `SELECT version_label, record_count, uploaded_at FROM nacta_lists WHERE is_active = 1 LIMIT 1`,
  );
  const [unsc] = await query(
    `SELECT version_label, record_count, uploaded_at FROM unsc_lists WHERE is_active = 1 LIMIT 1`,
  );

  res.json({
    nacta: nacta || null,
    unsc: unsc || null,
  });
}
