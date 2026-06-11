import { Router } from 'express';
import { uploadNacta, uploadUnsc, getStatus } from '../controllers/upload.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadNactaFile, uploadUnscFile } from '../middleware/upload.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const uploadRouter = Router();

// All upload routes require auth (PRD §10). multer runs before the controller.
uploadRouter.use(requireAuth);

uploadRouter.post('/nacta', uploadNactaFile, asyncHandler(uploadNacta));
uploadRouter.post('/unsc', uploadUnscFile, asyncHandler(uploadUnsc));
uploadRouter.get('/status', asyncHandler(getStatus));
