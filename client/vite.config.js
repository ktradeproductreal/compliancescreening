import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy /api to the Express server so the browser sees a single origin
// (no CORS) — mirrors the Nginx same-origin setup in Phase 2. Override the
// backend target with VITE_PROXY_TARGET if it runs elsewhere.
export default defineConfig(({ mode }) => {
  const target = process.env.VITE_PROXY_TARGET || 'http://localhost:4000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist', // served by Nginx in production
    },
  };
});
