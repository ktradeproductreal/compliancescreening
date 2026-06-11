import { Router } from 'express';
import {
  runScreeningHandler,
  historyHandler,
  getOneHandler,
  pdfHandler,
} from '../controllers/screening.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const screeningRouter = Router();

screeningRouter.use(requireAuth);

screeningRouter.post('/run', asyncHandler(runScreeningHandler));
screeningRouter.get('/history', asyncHandler(historyHandler));
// `/history` is declared before `/:id` so it isn't captured as an id param.
screeningRouter.get('/:id/pdf', asyncHandler(pdfHandler));
screeningRouter.get('/:id', asyncHandler(getOneHandler));
