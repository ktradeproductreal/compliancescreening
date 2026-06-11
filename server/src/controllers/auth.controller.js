// Auth controllers (PRD §7.1 / §10).
import bcrypt from 'bcryptjs';
import { queryOne } from '../db/db.js';
import { signToken } from '../middleware/auth.js';
import { HttpError } from '../utils/asyncHandler.js';

/** POST /api/auth/login — email + password → JWT. */
export async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    throw new HttpError(400, 'Email and password are required.');
  }

  const user = await queryOne(
    'SELECT id, email, password_hash, full_name FROM users WHERE email = :email',
    { email },
  );

  // Same generic message whether the email is unknown or the password is wrong.
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, full_name: user.full_name },
  });
}

/** GET /api/auth/me — current user from the verified token. */
export async function me(req, res) {
  res.json({ user: req.user });
}
