import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey.js';
import { screenAndReport } from '../controllers/v2.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const v2Router = Router();

// API-key protected (no JWT). Both verbs supported: GET for quick URL access,
// POST for keeping the CNIC/key out of URLs and logs.
v2Router.get('/screen', requireApiKey, asyncHandler(screenAndReport));
v2Router.post('/screen', requireApiKey, asyncHandler(screenAndReport));
