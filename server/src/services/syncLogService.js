// Sync-log queries backing the compliance "Sync Logs" UI tab.
// Reads from sync_log (one row per cron run) and sync_events (per-record
// audit trail written by scripts/_runSync.js -> logEvents).
import { query, queryOne } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';

/** Paginated list of sync runs, most recent first. Optional source/status filters. */
export async function listLogs({ page = 1, pageSize = 20, source = '', status = '' } = {}) {
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const clauses = [];
  const params = {};
  if (source === 'nacta' || source === 'unsc') {
    clauses.push('source = :source');
    params.source = source;
  }
  if (status && ['success', 'unchanged', 'failed', 'running'].includes(status)) {
    clauses.push('status = :status');
    params.status = status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await query(
    `SELECT l.id, l.source, l.started_at, l.ended_at, l.status,
            l.delta_json, l.error, l.triggered_by,
            (SELECT COUNT(*) FROM sync_events e WHERE e.sync_log_id = l.id) AS event_count
     FROM sync_log l ${where}
     ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM sync_log ${where}`, params);

  return {
    page: Math.max(Number(page) || 1, 1),
    pageSize: limit,
    total: totalRow.total,
    rows: rows.map((r) => ({
      ...r,
      delta_json: asJson(r.delta_json),
    })),
  };
}

/** One run with its full per-record event trail. */
export async function getLog(id) {
  const log = await queryOne(
    `SELECT id, source, started_at, ended_at, status, delta_json, error, triggered_by
     FROM sync_log WHERE id = :id`,
    { id },
  );
  if (!log) throw new HttpError(404, `Sync log #${id} not found.`);

  const events = await query(
    `SELECT id, event_type, \`row_number\`, cnic, full_name, father_name,
            ref_code, existing_record_id, detail, created_at
     FROM sync_events WHERE sync_log_id = :id
     ORDER BY id ASC`,
    { id },
  );

  return {
    ...log,
    delta_json: asJson(log.delta_json),
    events,
  };
}

function asJson(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
