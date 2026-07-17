// Screening controllers (PRD §7.4–7.6 / §10).
import { runScreening, getScreening, listHistory } from '../services/screeningService.js';
import { streamReport } from '../services/pdfService.js';

/** POST /api/screening/run */
export async function runScreeningHandler(req, res) {
  const result = await runScreening(req.user, req.body || {});
  res.status(201).json(result);
}

/** GET /api/screening/history?page=&pageSize=&q= */
export async function historyHandler(req, res) {
  const result = await listHistory({
    page: req.query.page,
    pageSize: req.query.pageSize,
    q: req.query.q,
  });
  res.json(result);
}

/** GET /api/screening/:id */
export async function getOneHandler(req, res) {
  const screening = await getScreening(Number(req.params.id));
  res.json(screening);
}

/** GET /api/screening/:id/pdf — streamed application/pdf, opened in a new tab. */
export async function pdfHandler(req, res) {
  const screening = await getScreening(Number(req.params.id));
  streamReport(res, screening);
}
