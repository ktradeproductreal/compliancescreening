// Helpers for the DOB screening input (format: dd-MMM-yyyy, e.g. "10-JAN-2030").
// Used by both the screening service (validate input) and the UNSC matcher
// (compare years).

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOB_REGEX = /^(\d{1,2})[-\s]([A-Z]{3})[-\s](\d{4})$/i;

/**
 * Parse a dd-MMM-yyyy DOB string into structured parts.
 * Returns `null` for invalid input. Lenient on case + separators (`-` / space).
 * Tolerates 1-digit days and trims whitespace.
 */
export function parseDob(value) {
  if (!value) return null;
  const m = String(value).trim().toUpperCase().match(DOB_REGEX);
  if (!m) return null;
  const day = Number(m[1]);
  const monthIdx = MONTH_ABBR.indexOf(m[2]);
  const year = Number(m[3]);
  if (monthIdx === -1) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  return { day, month: monthIdx + 1, monthAbbr: MONTH_ABBR[monthIdx], year };
}

/** True when `value` is a valid dd-MMM-yyyy DOB. */
export function isValidDob(value) {
  return parseDob(value) !== null;
}

/** Re-render a DOB into the canonical "DD-MMM-YYYY" form (uppercase month). */
export function formatDob(value) {
  const p = parseDob(value);
  if (!p) return null;
  return `${String(p.day).padStart(2, '0')}-${p.monthAbbr}-${p.year}`;
}

/**
 * Extract every 4-digit year (19xx / 20xx) from a freeform UNSC DOB string.
 * Examples:
 *   "3 Nov. 1957"                            -> [1957]
 *   "Approximately 1953"                     -> [1953]
 *   "Between 1957 and 1959"                  -> [1957, 1959]
 *   "a) Approximately 1960 b) 9 Sep. 1966"   -> [1960, 1966]
 *   null / "na"                              -> []
 */
export function extractYears(dobString) {
  if (!dobString) return [];
  const matches = String(dobString).match(/\b(19\d{2}|20\d{2})\b/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map(Number))).sort((a, b) => a - b);
}
