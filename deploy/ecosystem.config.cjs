// PM2 process file for the Compliance API.
// On the server (one-time):
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save
//   pm2 startup        # follow the printed command so PM2 survives reboot
//
// On every deploy:
//   git pull && cd server && npm ci --omit=dev
//   cd ../client && npm ci && npm run build
//   pm2 reload compliance-api
//
// Env vars (DB_*, JWT_SECRET, API_KEY, CORS_ORIGIN, PORT, etc.) are loaded by
// the app from server/.env — they are NOT defined here.

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'compliance-api',
      cwd: path.resolve(__dirname, '..', 'server'),
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 5000,        // matches the graceful SIGTERM handler in index.js
      env: { NODE_ENV: 'production' },
      // PM2 default log location is ~/.pm2/logs/compliance-api-*.log
    },
  ],
};
