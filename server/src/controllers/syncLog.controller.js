// Sync-log HTTP handlers. Thin wrappers around syncLogService.
import { listLogs, getLog } from '../services/syncLogService.js';

/** GET /api/sync-logs?page=&pageSize=&source=&status= */
export async function listHandler(req, res) {
  const result = await listLogs({
    page: req.query.page,
    pageSize: req.query.pageSize,
    source: req.query.source,
    status: req.query.status,
  });
  res.json(result);
}

/** GET /api/sync-logs/:id — run + all its per-record events. */
export async function getOneHandler(req, res) {
  const result = await getLog(Number(req.params.id));
  res.json(result);
}
