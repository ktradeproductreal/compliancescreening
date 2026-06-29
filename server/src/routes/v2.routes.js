import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import {
  screenAndReport,
  getReportByToken,
  v2ScreenResponse,
} from '../controllers/v2.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const v2Router = Router();

// ── Public report URL: auth is the 128-bit token in the URL path ────────────
// Defined BEFORE the API-key routes so it's reachable without a key.
v2Router.get('/reports/:token', asyncHandler(getReportByToken));

// ── API-key protected: run a new screening, get back JSON + file_url ────────
// Both verbs supported: POST keeps PII out of access logs; GET is for quick tests.
v2Router.get('/screen', requireApiKey, asyncHandler(screenAndReport));
v2Router.post('/screen', requireApiKey, asyncHandler(screenAndReport));

// ── Router-level error handler: gives /screen errors the SAME JSON shape as
//    a success response, with nulls + an `error` field. Anything else (e.g.
//    /reports/<token>) falls through to the global handler.
//
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
v2Router.use((err, req, res, next) => {
  if (!req.path.startsWith('/screen')) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[v2/screen]', err.stack || err.message);
  res.status(status).json(
    v2ScreenResponse({ success: false, error: err.message || 'Internal server error' }),
  );
});
