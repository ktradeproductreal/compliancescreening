import { Router } from 'express';
import { login, me } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authRouter = Router();

// The only public route (PRD §7.1).
authRouter.post('/login', asyncHandler(login));
authRouter.get('/me', requireAuth, asyncHandler(me));
