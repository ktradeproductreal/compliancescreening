// CNIC helpers. A Pakistani CNIC is 13 digits, displayed XXXXX-XXXXXXX-X.
// Q12 (resolved): CNIC is REQUIRED for screening in Phase 1.
// Q13 (resolved): NACTA Excel stores CNICs as plain 13 digits without dashes.

/** Strip everything that is not a digit. */
export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** True when the value has exactly 13 digits (ignoring dashes/spaces). */
export function isValidCnic(value) {
  return digitsOnly(value).length === 13;
}

/**
 * Normalise to canonical display form XXXXX-XXXXXXX-X.
 * Returns null when the input does not contain exactly 13 digits — callers
 * decide whether that is a hard error (screening input) or a skipped row (parser).
 */
export function formatCnic(value) {
  const digits = digitsOnly(value);
  if (digits.length !== 13) return null;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}
