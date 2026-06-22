// Upload controllers (PRD §7.2). Thin HTTP wrappers around the ingest service.
// Manual uploads from the UI go through these; cron syncs use the same service
// directly (see scripts/sync-*.js).
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
