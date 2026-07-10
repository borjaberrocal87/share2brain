// Playwright config for the E2E visual-verification harness (Story 4.5). Drives
// the BUILT SPA (`vite build && vite preview`) against a spawned deterministic
// test backend (`packages/backend/src/e2e/server.ts`), so the real global CSS is
// applied and `getComputedStyle` can verify the 4.3/4.4 visual ACs.
//
// Prereqs: `docker compose up -d postgres redis` (+ local Redis on 6379, see
// tests/README.md) and `npx playwright install chromium`.
import { defineConfig, devices } from '@playwright/test';

// Single source of truth for the harness's ports/origins — passed explicitly to
// the spawned backend's env below rather than relying on packages/backend/src/e2e
// /server.ts's own defaults happening to match (those remain only a fallback for
// running `e2e:server` directly, outside Playwright).
const WEB_PORT = 4173;
const BACKEND_PORT = 3100;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;

export default defineConfig({
  testDir: './tests',
  // One seeded DB shared across specs, and the Documentos spec mutates read-status
  // (mark-all) — a single worker keeps the specs from racing each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: WEB_ORIGIN,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Two servers: the test backend (seeded on boot) and the built SPA behind vite
  // preview (its preview.proxy points /api + /health at the test backend). Preview
  // inherits SHARE2BRAIN_API_PROXY_TARGET from `env` so it proxies to :3100.
  webServer: [
    {
      command: 'npm run e2e:server -w @share2brain/backend',
      url: `${BACKEND_ORIGIN}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { E2E_BACKEND_PORT: String(BACKEND_PORT), E2E_WEB_ORIGIN: WEB_ORIGIN },
    },
    {
      // `--port` pins `vite preview` to WEB_PORT explicitly — otherwise it only
      // matches WEB_ORIGIN by coincidence (Vite's own preview default is 4173).
      command: `npm run build -w @share2brain/web && npm run preview -w @share2brain/web -- --port ${WEB_PORT}`,
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { SHARE2BRAIN_API_PROXY_TARGET: BACKEND_ORIGIN },
    },
  ],
});
