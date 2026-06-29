// External PDF API (PRD §13).
//   POST /api/v2/screen          — API-key auth; runs screening; returns JSON
//                                  { record_found, file_url, screening_id, ... }
//   GET  /api/v2/reports/<tok>   — public (auth = the unguessable token);
//                                  regenerates and streams the PDF.
//
// Response shape changed 2026-06-29: was binary PDF; now JSON with a public
// file_url. The PDF lives behind a 128-bit random token rather than the API key,
// so the URL is browser-shareable but unguessable.
import {
  runScreening,
  getScreeningByToken,
} from '../services/screeningService.js';
import { streamReport } from '../services/pdfService.js';
import { HttpError } from '../utils/asyncHandler.js';

const REPORT_TOKEN_RE = /^[a-f0-9]{32}$/i;

/** Compose the absolute URL for a public report, honouring the Nginx-forwarded scheme/host. */
function buildReportUrl(req, token) {
  // We set `app.set('trust proxy', 1)` so req.protocol reflects X-Forwarded-Proto.
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/api/v2/reports/${token}.pdf`;
}

/** POST | GET /api/v2/screen — runs screening, returns JSON. */
export async function screenAndReport(req, res) {
  const src = { ...req.query, ...req.body };

  const input = {
    cnic: src.cnic,
    full_name: src.full_name ?? src.fullName ?? src.name,
    father_name: src.father_name ?? src.fatherName ?? '',
    // DOB required since 2026-06-23 for UNSC matching. Format: dd-MMM-yyyy.
    dob: src.dob ?? src.date_of_birth ?? src.dateOfBirth ?? '',
  };

  // No human user behind an API call → screened_by stays NULL.
  const result = await runScreening({ id: null }, input);

  // A "record found" means at least one of the two lists returned a hit.
  // `matched: false` is the only "not found" outcome — both NO_MATCH and
  // NO_LIST_UPLOADED leave matched=false.
  const recordFound = !!(result.nacta?.matched || result.unsc?.matched);

  res.status(200).json({
    record_found: recordFound ? 'yes' : 'no',
    file_url: buildReportUrl(req, result.report_token),
    screening_id: result.id,
    screened_at: new Date().toISOString(),
    nacta_match_type: result.nacta?.match_type ?? null,
    unsc_match_type: result.unsc?.match_type ?? null,
  });
}

/**
 * GET /api/v2/reports/<token>(.pdf)
 *
 * Public — the token IS the auth. We accept an optional ".pdf" suffix so the
 * URL looks file-like in a browser, then strip it before lookup. Anything that
 * doesn't match the 32-hex shape returns 404 (don't leak whether the token form
 * is valid).
 */
export async function getReportByToken(req, res) {
  const raw = String(req.params.token || '').replace(/\.pdf$/i, '');
  if (!REPORT_TOKEN_RE.test(raw)) {
    throw new HttpError(404, 'Report not found.');
  }
  const screening = await getScreeningByToken(raw);
  // 'inline' so browsers open the PDF in-tab when the URL is clicked.
  streamReport(res, screening, { disposition: 'inline' });
}
