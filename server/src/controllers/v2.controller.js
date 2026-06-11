// External PDF API (PRD §13). Validates input, runs the same screening engine as
// the UI (NACTA + UNSC), persists the result for audit (no user attached), and
// returns the PDF report as a file download.
import { runScreening, getScreening } from '../services/screeningService.js';
import { streamReport } from '../services/pdfService.js';

/** GET|POST /api/v2/screen — params from query or JSON body. Auth via requireApiKey. */
export async function screenAndReport(req, res) {
  const src = { ...req.query, ...req.body };

  // Accept snake_case (documented) and camelCase aliases for convenience.
  const input = {
    cnic: src.cnic,
    full_name: src.full_name ?? src.fullName ?? src.name,
    father_name: src.father_name ?? src.fatherName ?? '',
  };

  // No human user behind an API call → screened_by is null (column is nullable).
  const result = await runScreening({ id: null }, input);
  const screening = await getScreening(result.id);

  streamReport(res, screening, { disposition: 'attachment' });
}
