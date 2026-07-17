// Express application factory. Wires middleware + routes but does NOT listen —
// index.js owns the lifecycle so the app can also be imported by tests later.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/env.js';
import { authRouter } from './routes/auth.routes.js';
import { uploadRouter } from './routes/upload.routes.js';
import { screeningRouter } from './routes/screening.routes.js';
import { syncLogRouter } from './routes/syncLog.routes.js';
import { v2Router } from './routes/v2.routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

// Rate limiters — tuned for a single-officer portal exposed publicly.
// All numbers are per client IP. Standard headers expose retry-after info.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,                  // protect against brute-force on /api/auth/login
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});
const apiV2Limiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 60,                  // external API: 60 calls / 5 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded for the external API.' },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 600,                 // global cap on all /api/* traffic per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded.' },
});

export function createApp() {
  const app = express();

  // Behind Nginx in production — trust ONE proxy hop so req.ip is the real
  // client IP (needed for accurate rate limiting per IP).
  app.set('trust proxy', 1);

  // Standard security headers (X-Content-Type-Options, X-Frame-Options, etc.).
  // CSP is disabled here because the API only serves JSON/PDF; Nginx sets CSP
  // for the SPA. crossOriginResourcePolicy off so the PDF stream is readable.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  app.use(
    cors({
      origin: config.corsOrigin.includes('*') ? true : config.corsOrigin,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  // Liveness probe — handy for PM2 / load balancer health checks in Phase 2.
  // Skips the API-wide limiter so monitors don't get throttled.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // Global cap on every /api/* request, applied before the more specific limits.
  app.use('/api', apiLimiter);

  app.use('/api/auth/login', loginLimiter);
  app.use('/api/v2', apiV2Limiter);

  app.use('/api/auth', authRouter);
  app.use('/api/upload', uploadRouter);
  app.use('/api/screening', screeningRouter);
  app.use('/api/sync-logs', syncLogRouter);
  app.use('/api/v2', v2Router); // external API-key PDF endpoint

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
