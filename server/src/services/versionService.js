// Version numbering (PRD §7.3). vMAJOR.MINOR; minor 1→20 then major++ resets
// minor to 1. NACTA and UNSC tracked independently (separate tables).
import { HttpError } from '../utils/asyncHandler.js';

const TABLES = { nacta: 'nacta_lists', unsc: 'unsc_lists' };
const MAX_MINOR = 20;

/**
 * Compute the next version for a list type, using the provided transaction
 * connection so the read + later insert stay consistent.
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {'nacta'|'unsc'} listType
 * @returns {Promise<{ major: number, minor: number, label: string }>}
 */
export async function nextVersion(conn, listType) {
  const table = TABLES[listType];
  if (!table) throw new HttpError(400, `Unknown list type: ${listType}`);

  const [rows] = await conn.query(
    `SELECT version_major, version_minor FROM ${table} ORDER BY id DESC LIMIT 1`,
  );

  let major;
  let minor;
  if (rows.length === 0) {
    major = 1;
    minor = 1;
  } else if (rows[0].version_minor >= MAX_MINOR) {
    major = rows[0].version_major + 1;
    minor = 1;
  } else {
    major = rows[0].version_major;
    minor = rows[0].version_minor + 1;
  }

  return { major, minor, label: `v${major}.${minor}` };
}
