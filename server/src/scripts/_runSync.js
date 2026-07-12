// Shared helpers for the cron sync scripts.
// Each run gets a row in sync_log so phpMyAdmin / the Dashboard can show what happened.
// Per-record events (added/deactivated/reactivated/duplicate/warning/skipped) are
// written to sync_events and also emitted to stdout for aaPanel's Cron Log to capture.
import { pool, query, queryOne } from '../db/db.js';

/** Insert a 'running' sync_log row, return its id. */
export async function logStart(source) {
  const result = await query(
    `INSERT INTO sync_log (source, status, triggered_by) VALUES (:src, 'running', 'cron')`,
    { src: source },
  );
  return result.insertId;
}

export async function logUnchanged(id, reason) {
  await query(
    `UPDATE sync_log
        SET status = 'unchanged', ended_at = NOW(),
            delta_json = JSON_OBJECT('reason', :reason)
      WHERE id = :id`,
    { id, reason },
  );
}

export async function logSuccess(id, delta) {
  await query(
    `UPDATE sync_log
        SET status = 'success', ended_at = NOW(), delta_json = :delta
      WHERE id = :id`,
    { id, delta: JSON.stringify(delta) },
  );
}

export async function logFailure(id, err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  await query(
    `UPDATE sync_log
        SET status = 'failed', ended_at = NOW(), error = :err
      WHERE id = :id`,
    { id, err: msg.slice(0, 5000) },
  );
}

/** Read the persisted last-seen state for a source. Always returns an object. */
export async function readState(source) {
  const row = await queryOne(
    `SELECT last_count, last_signature FROM sync_state WHERE source = :src`,
    { src: source },
  );
  return row || { last_count: null, last_signature: null };
}

/** Upsert one or both state fields. Pass only what you want to update. */
export async function writeState(source, { last_count, last_signature } = {}) {
  // MySQL UPSERT via ON DUPLICATE KEY UPDATE.
  await query(
    `INSERT INTO sync_state (source, last_count, last_signature)
     VALUES (:src, :count, :sig)
     ON DUPLICATE KEY UPDATE
       last_count     = COALESCE(:count, last_count),
       last_signature = COALESCE(:sig,   last_signature)`,
    {
      src: source,
      count: last_count ?? null,
      sig: last_signature ?? null,
    },
  );
}

/** Cleanly close the pool at end-of-script so node exits. */
export async function shutdown() {
  await pool.end();
}

/**
 * Persist a batch of ingest events to sync_events AND emit descriptive lines to
 * stdout so aaPanel's Cron Log captures them for compliance evidence.
 *
 * Volume is small (typically 10s of events per successful sync, 0 for unchanged),
 * so a single INSERT is fine.
 */
export async function logEvents(syncLogId, source, events) {
  if (!Array.isArray(events) || events.length === 0) return;

  // 1) Descriptive stdout — one line per event, human-readable.
  for (const e of events) {
    const parts = [`[${source}] ${e.event_type}`];
    if (e.row_number != null) parts.push(`row ${e.row_number}`);
    if (e.existing_record_id != null) parts.push(`existing #${e.existing_record_id}`);
    if (e.ref_code) parts.push(`ref ${e.ref_code}`);
    if (e.cnic) parts.push(`CNIC ${e.cnic}`);
    else if (e.event_type === 'added' || e.event_type === 'deactivated' || e.event_type === 'reactivated' || e.event_type === 'duplicate_in_file') {
      parts.push('(no CNIC)');
    }
    if (e.full_name) parts.push(`name "${e.full_name}"`);
    if (e.father_name) parts.push(`father "${e.father_name}"`);
    if (e.detail) parts.push(`— ${e.detail}`);
    console.log(parts.join(' '));
  }

  // 2) DB insert. Use pool.query for bulk VALUES ? syntax (pool.execute doesn't support it).
  const values = events.map((e) => [
    syncLogId,
    source,
    e.event_type,
    e.row_number ?? null,
    e.cnic ?? null,
    e.full_name ?? null,
    e.father_name ?? null,
    e.ref_code ?? null,
    e.existing_record_id ?? null,
    e.detail ?? null,
  ]);
  await pool.query(
    `INSERT INTO sync_events
       (sync_log_id, source, event_type, row_number,
        cnic, full_name, father_name, ref_code, existing_record_id, detail)
     VALUES ?`,
    [values],
  );
}

/**
 * Top-level runner: wraps a sync body so it always logs the outcome, closes
 * the pool, and sets a non-zero exit code on failure (so cron can detect it).
 * @param {string} source 'nacta' | 'unsc'
 * @param {(logId:number)=>Promise<{outcome:'success'|'unchanged', delta?:object, reason?:string}>} body
 */
export async function runSync(source, body) {
  const t0 = Date.now();
  let logId;
  try {
    logId = await logStart(source);
    const result = await body(logId);
    if (result.outcome === 'unchanged') {
      await logUnchanged(logId, result.reason || 'unchanged');
      console.log(`[${source}] unchanged (${result.reason || 'no change'}) — ${Date.now() - t0}ms`);
    } else {
      await logSuccess(logId, result.delta);
      console.log(`[${source}] success ${JSON.stringify(result.delta)} — ${Date.now() - t0}ms`);
    }
  } catch (err) {
    if (logId) await logFailure(logId, err);
    console.error(`[${source}] FAILED:`, err.message);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}
