import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { screenAndReport, getReportByToken } from '../controllers/v2.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const v2Router = Router();

// ── Public report URL: auth is the 128-bit token in the URL path ────────────
// Defined BEFORE the API-key routes so it's reachable without a key.
v2Router.get('/reports/:token', asyncHandler(getReportByToken));

// ── API-key protected: run a new screening, get back JSON + file_url ────────
// Both verbs supported: POST keeps PII out of access logs; GET is for quick tests.
v2Router.get('/screen', requireApiKey, asyncHandler(screenAndReport));
v2Router.post('/screen', requireApiKey, asyncHandler(screenAndReport));
