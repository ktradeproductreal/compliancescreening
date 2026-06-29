// UNSC Consolidated List HTML parser (PRD §9.2). Input is a Buffer from multer
// memory storage. Each individual entry lives in a `td` inside `tr.rowtext`.
// Phase 1 parses individuals only (Q11). Nothing is written to disk.
import * as cheerio from 'cheerio';
import { normalise } from '../matching/normalise.js';
import { extractCnics } from '../utils/cnic.js';

// All field labels that may appear in an entry, in their natural document order.
// extractField() captures the text between a label and whichever label comes next.
const FIELD_LABELS = [
  'Title',
  'Designation',
  'DOB',
  'POB',
  'Good quality a.k.a.',
  'Low quality a.k.a.',
  'Nationality',
  'Passport no',
  'National identification no',
  'Address',
  'Listed on',
  'Other information',
];

/**
 * Extract a single field's value from the entry's raw text.
 * Captures from `fieldName:` up to the earliest following known label (or end
 * of text). Mirrors the PRD helper signature but resolves the "next field"
 * automatically so optional/missing fields don't break extraction.
 * @returns {string|null}
 */
function extractField(rawText, fieldName) {
  const startIdx = FIELD_LABELS.indexOf(fieldName);
  const nextLabels = startIdx === -1 ? [] : FIELD_LABELS.slice(startIdx + 1);
  // Build an alternation of the remaining labels as terminators (escape regex chars).
  const terminator = nextLabels
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':')
    .join('|');
  const tail = terminator ? `(?:${terminator}|$)` : '$';
  const re = new RegExp(`${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:?\\s*(.+?)\\s*${tail}`, 's');
  const m = rawText.match(re);
  if (!m) return null;
  // Collapse internal newlines/tabs/runs of spaces — real UNSC HTML is full of them.
  const value = m[1].replace(/\s+/g, ' ').trim();
  return value && value.toLowerCase() !== 'na' ? value : null;
}

/** Extract the text strictly between two markers (exclusive). */
function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return '';
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  return (end === -1 ? text.slice(from) : text.slice(from, end)).trim();
}

/** Split an a.k.a. block ("a) Foo b) Bar") into clean alias strings. */
function parseAliasBlock(block) {
  if (!block) return [];
  return block
    .split(/[a-z]\)\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && s.toLowerCase() !== 'na');
}


/** Parse the "Name: 1: X 2: Y ..." section into ordered parts (PRD §9.2 c). */
function parseNameParts(rawText) {
  const m = rawText.match(/Name:\s*1:\s*(.+?)\s*(?:Name \(original|Title:)/s);
  if (!m) return [];
  return ('1: ' + m[1])
    .split(/[1-4]:\s*/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && s.toLowerCase() !== 'na');
}

/**
 * @param {Buffer} buffer
 * @returns {{ records: object[], parseErrors: number, warnings: string[] }}
 */
export function parseUnscHtml(buffer) {
  const $ = cheerio.load(buffer.toString('utf8'));
  const records = [];
  const warnings = [];
  let parseErrors = 0;

  $('tr.rowtext td').each((_i, el) => {
    try {
      const $el = $(el);
      const rawText = $el.text();

      const refCode = ($el.find('strong').first().text() || '').replace(/\s+/g, '').trim();
      const nameParts = parseNameParts(rawText);
      const primaryName = nameParts.join(' ').trim();

      // An entry with neither a ref code nor a name is not a real record (e.g.
      // a spacer cell) — count it as a parse skip, not a hard failure.
      if (!refCode && !primaryName) return;

      const originalScriptName = $el.find('span.oscr').text().trim() || null;

      const goodAka = parseAliasBlock(between(rawText, 'Good quality a.k.a.:', 'Low quality a.k.a.:'));
      const lowAka = parseAliasBlock(between(rawText, 'Low quality a.k.a.:', 'Nationality:'));
      const aliases = [...goodAka, ...lowAka];

      // CNICs only (Pakistani customer base — passport / foreign IDs are noise).
      // Scan the entire raw entry text for CNIC-shaped values; extractCnics
      // returns canonical XXXXX-XXXXXXX-X form, deduplicated. Most UNSC entries
      // won't yield any (which is fine — they'll never match a CNIC screening).
      const identificationNumbers = extractCnics(rawText);

      const record = {
        ref_code: refCode || '(unknown)',
        primary_name: primaryName,
        primary_name_normalised: normalise(primaryName),
        name_parts_json: nameParts,
        aliases_json: aliases,
        aliases_normalised_json: aliases.map((a) => normalise(a)),
        nationality: extractField(rawText, 'Nationality'),
        address: extractField(rawText, 'Address'),
        dob: extractField(rawText, 'DOB'),
        pob: extractField(rawText, 'POB'),
        designation: extractField(rawText, 'Designation'),
        listed_on: extractField(rawText, 'Listed on'),
        original_script_name: originalScriptName,
        other_information: extractField(rawText, 'Other information'),
        identification_numbers_json: identificationNumbers,
      };
      records.push(record);
    } catch (err) {
      parseErrors += 1;
      warnings.push(`Failed to parse an entry: ${err.message}`);
    }
  });

  return { records, parseErrors, warnings };
}
