// Vite build for the static SPA (AD-3): emits packages/web/dist, served by nginx.
//
// Dev proxy (Story 2.4): the SPA runs on :5173 and the backend on :3000 — different
// origins, so the `sid` session cookie set by :3000 would not ride along on the
// SPA's fetches, and SameSite=Lax blocks cross-origin cookies. Proxying /api and
// /health to the backend makes the whole dev flow same-origin, so the cookie is
// scoped to :5173 and sent automatically. In prod nginx fronts /api the same way.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Proxy target: the dev backend on :3000 by default; the E2E harness overrides it
// to the test backend (:3100) via SHARE2BRAIN_API_PROXY_TARGET so the built SPA served
// by `vite preview` talks to the seeded deterministic backend (Story 4.5).
const apiTarget = process.env.SHARE2BRAIN_API_PROXY_TARGET || 'http://localhost:3000';

const apiProxy = {
  '/api': { target: apiTarget, changeOrigin: true },
  '/health': { target: apiTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: apiProxy,
  },
  // 🔴 `vite preview` does NOT inherit `server.proxy`, so the preview server needs
  // its OWN proxy block — without it every /api call from the built SPA 404s and
  // the E2E harness dies at login. Same-origin proxying also keeps the `sid`
  // session cookie scoped to the SPA origin (SameSite=Lax), as in dev and prod.
  preview: {
    proxy: apiProxy,
  },
});
