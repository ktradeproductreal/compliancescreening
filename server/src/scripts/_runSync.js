// Shared helpers for the cron sync scripts.
// Each run gets a row in sync_log so phpMyAdmin / the Dashboard can show what happened.
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
