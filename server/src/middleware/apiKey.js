// API-key guard for the external /api/v2 endpoints (PRD §13). Unlike the JWT
// routes, this is a single shared secret. The key may be supplied via the
// `X-API-Key` header (preferred), a `key` query param, or a `key` body field.
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { HttpError } from '../utils/asyncHandler.js';

/** Constant-time string compare (avoids leaking the key via timing). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function requireApiKey(req, _res, next) {
  if (!config.apiKey) {
    return next(new HttpError(503, 'External API is not configured (set API_KEY on the server).'));
  }
  const provided = req.get('x-api-key') || req.query.key || (req.body && req.body.key);
  if (!provided || !safeEqual(provided, config.apiKey)) {
    return next(new HttpError(401, 'Invalid or missing API key.'));
  }
  next();
}
