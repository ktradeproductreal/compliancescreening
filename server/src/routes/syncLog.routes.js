import { Router } from 'express';
import { listHandler, getOneHandler } from '../controllers/syncLog.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const syncLogRouter = Router();

syncLogRouter.use(requireAuth);

syncLogRouter.get('/', asyncHandler(listHandler));
syncLogRouter.get('/:id', asyncHandler(getOneHandler));
