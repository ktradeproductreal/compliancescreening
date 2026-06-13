// Screening orchestration (PRD §7.4). Validates input, resolves the active list
// versions, runs NACTA + UNSC matching in parallel, and persists a full result
// snapshot so PDF reports remain reproducible from the DB alone.
import { query, queryOne } from '../db/db.js';
import { matchNacta } from '../matching/nactaMatcher.js';
import { matchUnsc } from '../matching/unscMatcher.js';
import { isValidCnic, formatCnic } from '../utils/cnic.js';
import { versionStamp } from '../utils/dates.js';
import { HttpError } from '../utils/asyncHandler.js';

const NO_LIST = { matched: false, match_type: 'NO_LIST_UPLOADED', records: [] };

/** Fetch the active list row (id + version metadata) or null. */
async function activeList(table) {
  return queryOne(
    `SELECT id, version_label, uploaded_at FROM ${table} WHERE is_active = 1 LIMIT 1`,
  );
}

/**
 * @param {{ id: number }} user
 * @param {{ cnic: string, full_name: string, father_name?: string }} input
 * @returns {Promise<{ id: number, nacta: object, unsc: object, nacta_list_version: string|null, unsc_list_version: string|null }>}
 */
export async function runScreening(user, input) {
  const fullName = (input.full_name || '').trim();
  const fatherName = (input.father_name || '').trim();

  // Validation (PRD §7.4). CNIC required (Q12); full name ≥ 2 chars; father optional.
  if (!isValidCnic(input.cnic)) {
    throw new HttpError(400, 'CNIC is required and must contain exactly 13 digits.');
  }
  if (fullName.length < 2) {
    throw new HttpError(400, 'Full name is required (minimum 2 characters).');
  }
  const cnic = formatCnic(input.cnic);

  const [nactaList, unscList] = await Promise.all([
    activeList('nacta_lists'),
    activeList('unsc_lists'),
  ]);

  // Run both checks in parallel (PRD §7.4). The matchers query records by
  // is_active=1 directly (not by list_id) since 2026-06-13. We still gate on
  // activeList for the audit version label + the "no list uploaded" display.
  const [nactaResult, unscResult] = await Promise.all([
    nactaList ? matchNacta({ cnic, fullName, fatherName }) : Promise.resolve(NO_LIST),
    unscList ? matchUnsc({ fullName }) : Promise.resolve(NO_LIST),
  ]);

  const nactaVersion = nactaList ? versionStamp(nactaList.version_label, nactaList.uploaded_at) : null;
  const unscVersion = unscList ? versionStamp(unscList.version_label, unscList.uploaded_at) : null;

  // query() returns the ResultSetHeader directly for INSERT (not wrapped in an array).
  const result = await query(
    `INSERT INTO screenings
       (screened_by, input_cnic, input_full_name, input_father_name,
        nacta_result_json, unsc_result_json, nacta_list_version, unsc_list_version)
     VALUES (:by, :cnic, :name, :father, :nacta, :unsc, :nv, :uv)`,
    {
      by: user.id,
      cnic,
      name: fullName,
      father: fatherName || null,
      nacta: JSON.stringify(nactaResult),
      unsc: JSON.stringify(unscResult),
      nv: nactaVersion,
      uv: unscVersion,
    },
  );

  return {
    id: result.insertId,
    cnic,
    full_name: fullName,
    father_name: fatherName || null,
    nacta: nactaResult,
    unsc: unscResult,
    nacta_list_version: nactaVersion,
    unsc_list_version: unscVersion,
  };
}

/** Load a single screening row, parsing JSON columns. Throws 404 if absent. */
export async function getScreening(id) {
  const row = await queryOne('SELECT * FROM screenings WHERE id = :id', { id });
  if (!row) throw new HttpError(404, `Screening #${id} not found.`);
  return {
    ...row,
    nacta_result_json: asJson(row.nacta_result_json),
    unsc_result_json: asJson(row.unsc_result_json),
  };
}

/** Paginated history, most recent first (PRD §7.6 / §11). */
export async function listHistory({ page = 1, pageSize = 20 } = {}) {
  // LIMIT/OFFSET are inlined (not bound) — mysql2 prepared statements reject them
  // as parameters. Safe here because both are coerced to bounded integers.
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const rows = await query(
    `SELECT id, input_cnic, input_full_name, input_father_name,
            nacta_result_json, unsc_result_json, screened_at
     FROM screenings ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
  );
  const totalRow = await queryOne('SELECT COUNT(*) AS total FROM screenings');

  return {
    page: Math.max(Number(page) || 1, 1),
    pageSize: limit,
    total: totalRow.total,
    rows: rows.map((r) => ({
      id: r.id,
      cnic: r.input_cnic,
      full_name: r.input_full_name,
      father_name: r.input_father_name,
      screened_at: r.screened_at,
      nacta_matched: asJson(r.nacta_result_json).matched,
      nacta_match_type: asJson(r.nacta_result_json).match_type,
      unsc_matched: asJson(r.unsc_result_json).matched,
      unsc_match_type: asJson(r.unsc_result_json).match_type,
    })),
  };
}

function asJson(v) {
  if (v && typeof v === 'object') return v; // mysql2 already parsed JSON columns
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}
