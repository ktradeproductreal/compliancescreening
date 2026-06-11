// JWT auth guard (PRD §7.1). Every route except POST /api/auth/login requires a
// valid `Authorization: Bearer <token>`. On success req.user is populated.
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { HttpError } from '../utils/asyncHandler.js';

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Missing or malformed Authorization header.'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { id: payload.sub, email: payload.email, full_name: payload.full_name };
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token.'));
  }
}

/** Sign a session token for a user row. */
export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, full_name: user.full_name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}
