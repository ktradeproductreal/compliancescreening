// UNSC Consolidated List XML parser. Targets the official UN feed at
// https://scsanctions.un.org/resources/xml/en/consolidated.xml — a stable,
// machine-readable feed designed for automation (used by the cron sync).
//
// Returns the same record shape as the HTML parser so the existing ingest path
// (services/listIngestService.ingestUnsc) works without changes.
//
// Phase 1 still only screens INDIVIDUALS (Q11). ENTITIES are skipped.
import { XMLParser } from 'fast-xml-parser';
import { normalise } from '../matching/normalise.js';
import { extractCnics } from '../utils/cnic.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

/** Always return an array (the XML parser collapses single elements to objects). */
function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Render a text-bearing value, dropping null/undefined and trimming whitespace. */
function s(v) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).replace(/\s+/g, ' ').trim() || null;
}

/** Join an array of strings with `sep`, dropping empties. */
function join(arr, sep = ' ') {
  return arr.filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join(sep);
}

// ─── Field extractors (single source of truth so HTML/XML parsers stay aligned) ──

function nameParts(ind) {
  return [ind.FIRST_NAME, ind.SECOND_NAME, ind.THIRD_NAME, ind.FOURTH_NAME]
    .map(s)
    .filter(Boolean);
}

function aliases(ind) {
  // INDIVIDUAL_ALIAS can be one object or an array. Each has ALIAS_NAME + QUALITY.
  return asArray(ind.INDIVIDUAL_ALIAS)
    .map((a) => s(a?.ALIAS_NAME))
    .filter(Boolean);
}

function nationality(ind) {
  // NATIONALITY/VALUE → string or array; entities can have multiple nationalities.
  if (!ind.NATIONALITY) return null;
  const values = asArray(ind.NATIONALITY.VALUE).map(s).filter(Boolean);
  return values.length ? join(values, '; ') : null;
}

function designation(ind) {
  if (!ind.DESIGNATION) return null;
  const values = asArray(ind.DESIGNATION.VALUE).map(s).filter(Boolean);
  return values.length ? join(values, '; ') : null;
}

function address(ind) {
  // INDIVIDUAL_ADDRESS may be one or many; each has STREET/CITY/STATE_PROVINCE/COUNTRY/NOTE.
  return asArray(ind.INDIVIDUAL_ADDRESS)
    .map((a) => join([a?.STREET, a?.CITY, a?.STATE_PROVINCE, a?.COUNTRY, a?.NOTE].map(s), ', '))
    .filter(Boolean)
    .join(' | ') || null;
}

function pob(ind) {
  // INDIVIDUAL_PLACE_OF_BIRTH may be one or many; CITY/STATE_PROVINCE/COUNTRY.
  return asArray(ind.INDIVIDUAL_PLACE_OF_BIRTH)
    .map((p) => join([p?.CITY, p?.STATE_PROVINCE, p?.COUNTRY].map(s), ', '))
    .filter(Boolean)
    .join(' | ') || null;
}

function dob(ind) {
  // INDIVIDUAL_DATE_OF_BIRTH carries TYPE_OF_DATE + DATE / YEAR / FROM_YEAR-TO_YEAR.
  const dobs = asArray(ind.INDIVIDUAL_DATE_OF_BIRTH).map((d) => {
    if (!d) return null;
    if (d.DATE) return s(d.DATE);
    if (d.YEAR) return s(d.YEAR);
    if (d.FROM_YEAR || d.TO_YEAR) return `Between ${s(d.FROM_YEAR) || '?'} and ${s(d.TO_YEAR) || '?'}`;
    return null;
  }).filter(Boolean);
  return dobs.length ? dobs.join(' | ') : null;
}

/**
 * Extract CNICs from an individual's documents.
 *
 * We scan EVERY field on each INDIVIDUAL_DOCUMENT (not just NUMBER) because the
 * UN feed occasionally tucks the digits into NOTE / DATE_OF_ISSUE / TYPE strings.
 * Then extractCnics() filters by shape so only Pakistani CNICs survive — passport
 * numbers ("CV9157521"), foreign IDs, and free text are discarded.
 */
function identificationNumbers(ind) {
  const cnics = new Set();
  for (const doc of asArray(ind.INDIVIDUAL_DOCUMENT)) {
    if (!doc) continue;
    // Flatten every text-bearing value on this document into one searchable blob.
    const blob = Object.values(doc).filter((v) => typeof v === 'string').join(' ');
    for (const cnic of extractCnics(blob)) cnics.add(cnic);
  }
  return Array.from(cnics);
}

function listedOn(ind) {
  // Prefer LAST_DAY_UPDATED.VALUE if present (most recent amendment); fall back to LISTED_ON.
  const updated = asArray(ind.LAST_DAY_UPDATED?.VALUE).map(s).filter(Boolean);
  if (updated.length) {
    return `${s(ind.LISTED_ON) || ''} (amended on ${updated.join(', ')})`.trim();
  }
  return s(ind.LISTED_ON);
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * @param {Buffer|string} input XML buffer or string from the UN feed
 * @returns {{ records: object[], parseErrors: number, warnings: string[] }}
 */
export function parseUnscXml(input) {
  const xml = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const parsed = xmlParser.parse(xml);

  // Root element name varies slightly across UN feeds — search broadly.
  const root = parsed.CONSOLIDATED_LIST || parsed.consolidatedList || parsed.ConsolidatedList || parsed;
  const individuals = asArray(
    root.INDIVIDUALS?.INDIVIDUAL ||
    root.Individuals?.Individual ||
    root.individuals?.individual,
  );

  if (individuals.length === 0) {
    const err = new Error(
      'UNSC XML: no INDIVIDUAL entries found. The feed may have changed format or returned an error page.',
    );
    err.status = 400;
    throw err;
  }

  const records = [];
  const warnings = [];
  let parseErrors = 0;

  for (const ind of individuals) {
    try {
      const parts = nameParts(ind);
      const primaryName = join(parts);
      const refCode = s(ind.REFERENCE_NUMBER) || s(ind.DATAID);

      if (!refCode || !primaryName) {
        warnings.push(`Skipped entry without ref_code/primary_name (dataid=${ind.DATAID || '?'}).`);
        continue;
      }

      const aliasList = aliases(ind);
      records.push({
        ref_code: refCode,
        primary_name: primaryName,
        primary_name_normalised: normalise(primaryName),
        name_parts_json: parts,
        aliases_json: aliasList,
        aliases_normalised_json: aliasList.map((a) => normalise(a)),
        nationality: nationality(ind),
        address: address(ind),
        dob: dob(ind),
        pob: pob(ind),
        designation: designation(ind),
        listed_on: listedOn(ind),
        original_script_name: s(ind.NAME_ORIGINAL_SCRIPT),
        other_information: s(ind.COMMENTS1) || s(ind.COMMENTS),
        identification_numbers_json: identificationNumbers(ind),
      });
    } catch (err) {
      parseErrors += 1;
      warnings.push(`Failed to parse an individual entry: ${err.message}`);
    }
  }

  return { records, parseErrors, warnings };
}
