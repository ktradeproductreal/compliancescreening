// Upload controllers (PRD §7.2). Thin HTTP wrappers around the ingest service.
// Manual uploads from the UI go through these; cron syncs use the same service
// directly (see scripts/sync-*.js).
import XLSX from 'xlsx';
import { query, queryOne } from '../db/db.js';
import { parseNactaExcel } from '../parsers/excelParser.js';
import { parseUnscHtml } from '../parsers/htmlParser.js';
import { ingestNacta, ingestUnsc } from '../services/listIngestService.js';
import { HttpError } from '../utils/asyncHandler.js';

export async function uploadNacta(req, res) {
  if (!req.file) throw new HttpError(400, 'No file uploaded. Send the Excel file as field "file".');

  const { records, skipped, withoutCnic, warnings, totalRows } = parseNactaExcel(req.file.buffer);
  if (records.length === 0) {
    throw new HttpError(400, 'No valid rows found in the Excel file after parsing.');
  }

  const result = await ingestNacta({
    records,
    filename: req.file.originalname,
    userId: req.user.id,
  });

  res.status(201).json({
    list: 'nacta',
    version_label: result.version.label,
    record_count: result.stats.total_active,
    name_only_records: withoutCnic,
    rows_seen: totalRows,
    skipped,
    warnings,
    uploaded_at: new Date().toISOString(),
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

  const result = await ingestUnsc({
    records,
    filename: req.file.originalname,
    userId: req.user.id,
  });

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

/**
 * GET /api/upload/status — Dashboard data: active list + last sync per source.
 * The last_sync block is null until the first cron run.
 */
export async function getStatus(_req, res) {
  const nacta = await queryOne(
    `SELECT version_label, record_count, uploaded_at
       FROM nacta_lists WHERE is_active = 1 LIMIT 1`,
  );
  const unsc = await queryOne(
    `SELECT version_label, record_count, uploaded_at
       FROM unsc_lists WHERE is_active = 1 LIMIT 1`,
  );

  // Most recent sync_log row per source (any status).
  const lastNactaSync = await queryOne(
    `SELECT started_at, ended_at, status, delta_json, error
       FROM sync_log WHERE source = 'nacta' ORDER BY id DESC LIMIT 1`,
  );
  const lastUnscSync = await queryOne(
    `SELECT started_at, ended_at, status, delta_json, error
       FROM sync_log WHERE source = 'unsc' ORDER BY id DESC LIMIT 1`,
  );

  res.json({
    nacta: nacta ? { ...nacta, last_sync: lastNactaSync || null } : null,
    unsc: unsc ? { ...unsc, last_sync: lastUnscSync || null } : null,
  });
}

/**
 * GET /api/upload/nacta/download — Excel export of the currently-active NACTA
 * list. Raw display columns (Full Name, Father Name, CNIC) so it round-trips
 * back through the same parser if re-uploaded.
 */
export async function downloadNacta(_req, res) {
  const activeList = await queryOne(
    `SELECT id, version_label FROM nacta_lists WHERE is_active = 1 LIMIT 1`,
  );
  if (!activeList) throw new HttpError(404, 'No active NACTA list to download.');

  const rows = await query(
    `SELECT raw_full_name, full_name, raw_father_name, father_name, raw_cnic, cnic
       FROM nacta_records
      WHERE is_active = 1
      ORDER BY id ASC`,
  );

  const sheetRows = rows.map((r) => ({
    'Full Name': r.raw_full_name || r.full_name || '',
    'Father Name': r.raw_father_name || r.father_name || '',
    CNIC: r.raw_cnic || r.cnic || '',
  }));

  const ws = XLSX.utils.json_to_sheet(sheetRows, {
    header: ['Full Name', 'Father Name', 'CNIC'],
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NACTA');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const safeVersion = String(activeList.version_label).replace(/[^\w.-]+/g, '_');
  const filename = `nacta-list-v${safeVersion}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

/**
 * GET /api/upload/unsc/download — Excel export of the currently-active UNSC
 * list. Full column set including JSON arrays (aliases, identification numbers)
 * joined with '; ' for readability.
 */
export async function downloadUnsc(_req, res) {
  const activeList = await queryOne(
    `SELECT id, version_label FROM unsc_lists WHERE is_active = 1 LIMIT 1`,
  );
  if (!activeList) throw new HttpError(404, 'No active UNSC list to download.');

  const rows = await query(
    `SELECT ref_code, primary_name, aliases_json, nationality, dob, pob, address,
            designation, listed_on, original_script_name, other_information,
            identification_numbers_json
       FROM unsc_records
      WHERE is_active = 1
      ORDER BY id ASC`,
  );

  const joinJsonArray = (v) => {
    if (!v) return '';
    const arr = Array.isArray(v) ? v : (() => { try { return JSON.parse(v); } catch { return []; } })();
    return Array.isArray(arr) ? arr.filter(Boolean).join('; ') : '';
  };

  const sheetRows = rows.map((r) => ({
    'Ref Code': r.ref_code || '',
    'Primary Name': r.primary_name || '',
    Aliases: joinJsonArray(r.aliases_json),
    Nationality: r.nationality || '',
    DOB: r.dob || '',
    POB: r.pob || '',
    Address: r.address || '',
    Designation: r.designation || '',
    'Listed On': r.listed_on || '',
    'Original Script Name': r.original_script_name || '',
    'Other Information': r.other_information || '',
    'Identification Numbers': joinJsonArray(r.identification_numbers_json),
  }));

  const ws = XLSX.utils.json_to_sheet(sheetRows, {
    header: [
      'Ref Code',
      'Primary Name',
      'Aliases',
      'Nationality',
      'DOB',
      'POB',
      'Address',
      'Designation',
      'Listed On',
      'Original Script Name',
      'Other Information',
      'Identification Numbers',
    ],
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'UNSC');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const safeVersion = String(activeList.version_label).replace(/[^\w.-]+/g, '_');
  const filename = `unsc-list-v${safeVersion}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}
