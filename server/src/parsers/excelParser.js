// NACTA Excel parser (PRD §9.1). Input is a Buffer from multer memory storage;
// nothing is written to disk. Finds the three required columns by header name so
// extra columns (PROVINCE, DISTRICT) and a leading index column are tolerated
// (Q13 resolved). CNICs in the file are plain 13 digits without dashes.
import XLSX from 'xlsx';
import { normalise } from '../matching/normalise.js';
import { formatCnic, digitsOnly } from '../utils/cnic.js';

// Accepted header spellings per logical column (compared case-insensitively and
// whitespace-collapsed). Real NACTA files vary — e.g. "Father" vs "FATHER NAME".
// Extra columns like PROVINCE / DISTRICT and a leading index column are ignored.
const COLUMN_ALIASES = {
  name: ['NAME', 'FULL NAME'],
  father: ['FATHER NAME', 'FATHER', "FATHER'S NAME", 'FATHERS NAME', 'FATHER/HUSBAND NAME'],
  cnic: ['CNIC', 'CNIC NO', 'CNIC NUMBER', 'CNIC #'],
};

/** Index of the first cell whose normalised header matches one of the aliases. */
function findCol(keys, aliases) {
  return keys.findIndex((k) => aliases.includes(k));
}

/** Header cells are compared case-insensitively and whitespace-collapsed. */
function headerKey(cell) {
  return String(cell ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * @param {Buffer} buffer
 * @returns {{ records: object[], skipped: number, warnings: string[], totalRows: number }}
 * @throws {Error} with `.status = 400` and a descriptive message when required headers are absent.
 */
export function parseNactaExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    const err = new Error('The Excel file contains no sheets.');
    err.status = 400;
    throw err;
  }
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

  // Locate the header row: the first row containing all three required headers.
  let headerRowIndex = -1;
  let cols = null;
  for (let i = 0; i < rows.length; i += 1) {
    const keys = rows[i].map(headerKey);
    const nameCol = findCol(keys, COLUMN_ALIASES.name);
    const fatherCol = findCol(keys, COLUMN_ALIASES.father);
    const cnicCol = findCol(keys, COLUMN_ALIASES.cnic);
    if (nameCol !== -1 && fatherCol !== -1 && cnicCol !== -1) {
      headerRowIndex = i;
      cols = { nameCol, fatherCol, cnicCol };
      break;
    }
  }

  if (headerRowIndex === -1) {
    // Report which logical columns we could not find, with their accepted spellings.
    const allKeys = new Set(rows.flatMap((r) => r.map(headerKey)));
    const missing = Object.entries(COLUMN_ALIASES)
      .filter(([, aliases]) => !aliases.some((a) => allKeys.has(a)))
      .map(([col, aliases]) => `${col} (accepted: ${aliases.join(' / ')})`);
    const err = new Error(
      `Could not find the required column header(s): ${missing.join('; ')}.`,
    );
    err.status = 400;
    throw err;
  }

  const records = [];
  const warnings = [];
  let skipped = 0;
  let withoutCnic = 0;

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rawFullName = String(row[cols.nameCol] ?? '').trim();
    const rawFatherName = String(row[cols.fatherCol] ?? '').trim();
    const rawCnic = String(row[cols.cnicCol] ?? '').trim();

    // Skip fully blank rows silently.
    if (!rawFullName && !rawFatherName && !rawCnic) continue;

    // NAME is mandatory; rows without one are not a screenable record.
    if (!rawFullName) {
      skipped += 1;
      warnings.push(`Row ${i + 1}: missing NAME — row skipped.`);
      continue;
    }

    // CNIC is OPTIONAL. A row without a usable 13-digit CNIC is RETAINED with
    // cnic = null so it can be matched by name only (screening Level 2). It will
    // never be returned by an exact-CNIC lookup. Malformed (non-blank) CNICs are
    // treated as missing but surfaced as a warning.
    const cnic = formatCnic(rawCnic); // null unless exactly 13 digits
    if (!cnic) {
      withoutCnic += 1;
      if (digitsOnly(rawCnic).length > 0) {
        warnings.push(
          `Row ${i + 1}: CNIC "${rawCnic}" is not 13 digits — stored without CNIC (name-only record).`,
        );
      }
    }

    records.push({
      full_name: normalise(rawFullName),
      father_name: normalise(rawFatherName),
      cnic, // null for name-only records
      raw_full_name: rawFullName,
      raw_father_name: rawFatherName,
      raw_cnic: rawCnic || null,
    });
  }

  return { records, skipped, withoutCnic, warnings, totalRows: rows.length - headerRowIndex - 1 };
}
