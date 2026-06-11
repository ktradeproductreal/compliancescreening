// Upload controllers (PRD §7.2). Parse in memory → version → atomically flip the
// active flag and bulk-insert records. Old records are retained for audit.
import { withTransaction, query } from '../db/db.js';
import { parseNactaExcel } from '../parsers/excelParser.js';
import { parseUnscHtml } from '../parsers/htmlParser.js';
import { nextVersion } from '../services/versionService.js';
import { HttpError } from '../utils/asyncHandler.js';

const NACTA_COLUMNS = ['list_id', 'full_name', 'father_name', 'cnic', 'raw_full_name', 'raw_father_name', 'raw_cnic'];
const UNSC_COLUMNS = [
  'list_id', 'ref_code', 'primary_name', 'primary_name_normalised', 'name_parts_json',
  'aliases_json', 'aliases_normalised_json', 'nationality', 'address', 'dob', 'pob',
  'designation', 'listed_on', 'original_script_name', 'other_information',
];

/** Insert a new active list version + its records inside one transaction. */
async function ingest({ listType, table, filename, userId, records, toRow, columns }) {
  return withTransaction(async (conn) => {
    const version = await nextVersion(conn, listType);

    // Demote the currently-active version (records stay for historical reports).
    await conn.execute(`UPDATE ${table} SET is_active = 0 WHERE is_active = 1`);

    const [listResult] = await conn.execute(
      `INSERT INTO ${table}
         (version_major, version_minor, version_label, filename, uploaded_by, record_count, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [version.major, version.minor, version.label, filename, userId, records.length],
    );
    const listId = listResult.insertId;

    if (records.length > 0) {
      const recordsTable = listType === 'nacta' ? 'nacta_records' : 'unsc_records';
      const values = records.map((r) => toRow(listId, r));
      // Bulk insert via nested-array VALUES (use query, not execute, for this form).
      await conn.query(`INSERT INTO ${recordsTable} (${columns.join(', ')}) VALUES ?`, [values]);
    }

    return { listId, version };
  });
}

export async function uploadNacta(req, res) {
  if (!req.file) throw new HttpError(400, 'No file uploaded. Send the Excel file as field "file".');

  const { records, skipped, withoutCnic, warnings, totalRows } = parseNactaExcel(req.file.buffer);
  if (records.length === 0) {
    throw new HttpError(400, 'No valid rows found in the Excel file after parsing.');
  }

  const { version } = await ingest({
    listType: 'nacta',
    table: 'nacta_lists',
    filename: req.file.originalname,
    userId: req.user.id,
    records,
    columns: NACTA_COLUMNS,
    toRow: (listId, r) => [
      listId, r.full_name, r.father_name, r.cnic, r.raw_full_name, r.raw_father_name, r.raw_cnic,
    ],
  });

  res.status(201).json({
    list: 'nacta',
    version_label: version.label,
    record_count: records.length,
    name_only_records: withoutCnic,
    rows_seen: totalRows,
    skipped,
    warnings,
    uploaded_at: new Date().toISOString(),
  });
}

export async function uploadUnsc(req, res) {
  if (!req.file) throw new HttpError(400, 'No file uploaded. Send the HTML file as field "file".');

  const { records, parseErrors, warnings } = parseUnscHtml(req.file.buffer);
  if (records.length === 0) {
    throw new HttpError(400, 'No UNSC entries found. Check that the file uses the expected tr.rowtext layout.');
  }

  const { version } = await ingest({
    listType: 'unsc',
    table: 'unsc_lists',
    filename: req.file.originalname,
    userId: req.user.id,
    records,
    columns: UNSC_COLUMNS,
    toRow: (listId, r) => [
      listId, r.ref_code, r.primary_name, r.primary_name_normalised,
      JSON.stringify(r.name_parts_json), JSON.stringify(r.aliases_json),
      JSON.stringify(r.aliases_normalised_json), r.nationality, r.address, r.dob, r.pob,
      r.designation, r.listed_on, r.original_script_name, r.other_information,
    ],
  });

  res.status(201).json({
    list: 'unsc',
    version_label: version.label,
    record_count: records.length,
    parse_errors: parseErrors,
    warnings,
    uploaded_at: new Date().toISOString(),
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
