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

/**
 * Scan free-form text and return every CNIC-shaped value it contains, in
 * canonical XXXXX-XXXXXXX-X form, deduplicated.
 *
 * Matches:
 *   - "44103-5251752-5"  (canonical, with dashes or spaces)
 *   - "4410352517525"    (13 consecutive digits)
 *   - "Pakistan national identity card number 44103-5251752-5" → extracts the embedded CNIC
 *
 * Does NOT match (returned as []):
 *   - Passport numbers like "CV9157521" (letters present, wrong digit count)
 *   - Phone numbers / random digit sequences not in 5-7-1 shape
 *   - Anything < 13 or > 13 digits as one token
 */
export function extractCnics(value) {
  if (!value) return [];
  const text = String(value);
  const cnics = new Set();

  // Pattern 1: 5-7-1 grouped form with dashes or spaces as separators.
  for (const m of text.match(/\b\d{5}[-\s]\d{7}[-\s]\d\b/g) || []) {
    const d = m.replace(/\D/g, '');
    cnics.add(`${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`);
  }
  // Pattern 2: 13 consecutive digits standing on their own (not part of a longer number).
  for (const m of text.match(/(?<!\d)\d{13}(?!\d)/g) || []) {
    cnics.add(`${m.slice(0, 5)}-${m.slice(5, 12)}-${m.slice(12)}`);
  }

  return Array.from(cnics);
}
