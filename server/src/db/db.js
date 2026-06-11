// Thin mysql2 query helper over a connection pool (PRD §3 — "a thin db.js query
// helper is sufficient"). Pool is Cloud SQL friendly per the deployment memory.
import mysql from 'mysql2/promise';
import { config } from '../config/env.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  namedPlaceholders: true,
  // Keep JSON columns as parsed objects on read; we stringify explicitly on write.
  dateStrings: false,
  // MySQL stores timestamps in UTC (container system_time_zone = UTC). Tell mysql2
  // to parse DATETIME values as UTC instead of the Node process's local timezone —
  // otherwise on a non-UTC host the read-back Date is shifted, and report times come
  // out wrong (e.g. PKT host showed 06:40 instead of 11:40). Formatting to PKT is
  // then handled in utils/dates.js.
  timezone: 'Z',
});

/**
 * Run a parameterised query and return rows.
 * @param {string} sql
 * @param {object|array} [params]
 */
export async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Convenience: return the first row or null. */
export async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Run a function inside a transaction. The callback receives a dedicated
 * connection; commit/rollback are handled automatically. Used by uploads where
 * the version row + bulk record insert must be atomic.
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} fn
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Verify connectivity at boot — fail fast with a clear message. */
export async function assertConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}
