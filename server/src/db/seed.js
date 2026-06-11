// Create the first Compliance Officer (PRD §4 — single role in Phase 1).
// Credentials come from SEED_USER_* env vars. Idempotent: if the email already
// exists, the password hash is refreshed rather than inserting a duplicate.
//
//   npm run db:seed
import bcrypt from 'bcryptjs';
import { pool, queryOne } from './db.js';
import { config } from '../config/env.js';

const SALT_ROUNDS = 12; // PRD §7.1

async function main() {
  const { email, password, name } = config.seed;
  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  const existing = await queryOne('SELECT id FROM users WHERE email = :email', { email });

  if (existing) {
    await pool.execute(
      'UPDATE users SET password_hash = :hash, full_name = :name WHERE id = :id',
      { hash, name, id: existing.id },
    );
    console.log(`Updated existing user ${email} (id=${existing.id}).`);
  } else {
    const [result] = await pool.execute(
      'INSERT INTO users (email, password_hash, full_name) VALUES (:email, :hash, :name)',
      { email, hash, name },
    );
    console.log(`Created user ${email} (id=${result.insertId}).`);
  }

  console.log('Seed complete. Log in with the SEED_USER_* credentials from your .env.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
