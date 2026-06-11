// Server entry point. Verifies DB connectivity, then starts listening.
// Logs to stdout/stderr only (no file logging) so PM2 / Cloud Logging capture
// everything in Phase 2 (see deployment memory).
import { createApp } from './app.js';
import { config } from './config/env.js';
import { assertConnection, pool } from './db/db.js';

async function start() {
  try {
    await assertConnection();
    console.log(`[db] connected to ${config.db.database}@${config.db.host}:${config.db.port}`);
  } catch (err) {
    console.error('[db] connection failed — is MySQL running? (docker compose up -d)');
    console.error(`[db] ${err.message}`);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port} (${config.env})`);
  });

  // Graceful shutdown so PM2 restarts/reloads don't drop in-flight requests.
  const shutdown = (signal) => {
    console.log(`[server] ${signal} received — shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
