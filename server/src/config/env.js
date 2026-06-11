// Central env loader. Single source of truth for configuration so nothing in the
// codebase reads process.env directly or hardcodes localhost (see deployment memory).
//
// Loads the project-root .env (shared with docker-compose) when present, then
// falls back to a server-local .env. In production (PM2 / GCP) env vars are set
// by the process manager and no .env file is needed.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(__dirname, '../../../.env'); // compliance_project/.env
const localEnv = path.resolve(__dirname, '../../.env'); // server/.env

if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv }); // local overrides root

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),

  // Comma-separated list → array; '*' allows all (dev convenience only).
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  db: {
    host: optional('DB_HOST', '127.0.0.1'),
    port: Number(optional('DB_PORT', '3306')),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: optional('JWT_EXPIRES_IN', '8h'),
  },

  // Shared secret for the external /api/v2/screen PDF API (PRD §13). Empty = API
  // disabled (endpoint rejects all requests until a key is configured).
  apiKey: optional('API_KEY', ''),

  seed: {
    email: optional('SEED_USER_EMAIL', 'officer@example.com'),
    password: optional('SEED_USER_PASSWORD', 'ChangeMe123!'),
    name: optional('SEED_USER_NAME', 'Compliance Officer'),
  },

  // PRD §8 matching thresholds — centralised so they are tunable without code edits.
  matching: {
    nactaThreshold: Number(optional('NACTA_FUZZY_THRESHOLD', '0.8')),
    // 0.65: tuned up from the PRD's 0.5 to drop floor-noise on real UNSC data (2026-05-25).
    unscThreshold: Number(optional('UNSC_FUZZY_THRESHOLD', '0.65')),
    // Per-word similarity needed for a query word to count as "present" in a UNSC
    // name/alias. 0.8 allows minor transliteration variants (ABDUL≈ABDEL) but not
    // major ones (ABDUL≠ABD). Token-AND matching uses this (see unscMatcher).
    unscTokenThreshold: Number(optional('UNSC_TOKEN_THRESHOLD', '0.8')),
  },
};
