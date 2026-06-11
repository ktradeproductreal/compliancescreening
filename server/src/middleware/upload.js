// Multer configured for IN-MEMORY storage (PRD §5 — no files persisted to disk).
// File buffers go straight to the parsers. Extension allow-lists give a clear
// 400 before we waste time reading a wrong file type.
import multer from 'multer';
import { HttpError } from '../utils/asyncHandler.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — list files are comfortably under this.

function extensionFilter(allowed) {
  return (_req, file, cb) => {
    const ok = allowed.some((ext) => file.originalname.toLowerCase().endsWith(ext));
    if (ok) return cb(null, true);
    cb(new HttpError(400, `Unsupported file type. Expected one of: ${allowed.join(', ')}`));
  };
}

const memory = multer.memoryStorage();

export const uploadNactaFile = multer({
  storage: memory,
  limits: { fileSize: MAX_BYTES },
  fileFilter: extensionFilter(['.xlsx', '.xls']),
}).single('file');

export const uploadUnscFile = multer({
  storage: memory,
  limits: { fileSize: MAX_BYTES },
  fileFilter: extensionFilter(['.html', '.htm']),
}).single('file');
