// Text normalisation for matching (PRD §8.1). Applied to inputs and stored names
// before fuzzy comparison so transliterated/diacritic variants line up.
import unidecode from 'unidecode';

// Common Arabic name prefixes stripped for UNSC search input only (PRD §8.1 step 5).
// Order matters: multi-word prefixes ("AL ") are checked alongside hyphenated ones.
const UNSC_PREFIXES = ['AL-', 'AL ', 'ABU ', 'BIN ', 'BINT ', 'OULD ', 'WULD '];

/**
 * Base normalisation shared by NACTA and UNSC (steps 1–4):
 *   trim → collapse spaces → UPPERCASE → strip diacritics (unidecode).
 */
export function normalise(value) {
  if (value === null || value === undefined) return '';
  const ascii = unidecode(String(value));
  return ascii.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * UNSC-specific input normalisation (step 5): base normalise, then repeatedly
 * strip a leading Arabic prefix. Applied to the SEARCH INPUT only — stored
 * display names keep their prefixes.
 */
export function normaliseForUnsc(value) {
  let result = normalise(value);
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of UNSC_PREFIXES) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return result;
}
