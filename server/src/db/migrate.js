// Apply schema.sql to the configured database. Idempotent: every statement uses
// CREATE TABLE IF NOT EXISTS, so this is safe to run repeatedly. Useful for local
// dev and for first deploy to the GCP VM where MySQL was not provisioned by Docker.
//
//   npm run db:migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'schema.sql');

async function main() {
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // multipleStatements lets us run the whole DDL file in one go. We deliberately
  // use a one-off connection (not the app pool) and close it when done.
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    console.log(`Applying schema to ${config.db.database}@${config.db.host}:${config.db.port} ...`);
    await conn.query(sql);
    console.log('Schema applied successfully.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
