// Session bootstrap for the E2E harness (Story 4.5, AC3). Obtains an
// authenticated `sid` cookie by driving the fake-OAuth flow — NO real Discord,
// NO production auth-bypass route. `page.request` shares the browser context's
// cookie jar, so the `sid` cookie set by the callback lands in the browser
// automatically; subsequent page navigations are authenticated.
//
// Reuse from Stories 5.3/5.4: `import { loginAs } from './helpers/session'`.
import { expect, type Page } from '@playwright/test';

/** The two seeded identities (see packages/backend/src/e2e/seed.ts). */
export type LoginCode = 'e2e-member' | 'e2e-empty';

/**
 * Log in through the fake-OAuth flow and land on the authenticated SPA shell.
 * Forces the dark theme (token assertions are theme-dependent) BEFORE the first
 * navigation so the pre-paint theme script reads it.
 */
export async function loginAs(page: Page, code: LoginCode = 'e2e-member'): Promise<void> {
  // 1. Start the flow: the backend 302-redirects to discord.com with a `state`.
  //    Never follow the redirect (it points at the real Discord).
  const login = await page.request.get('/api/auth/login', { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  const state = new URL(login.headers()['location']).searchParams.get('state');
  expect(state).toBeTruthy();

  // 2. Callback with the fake code + the echoed state → 302 to the frontend, with
  //    a regenerated `sid` cookie (fixation guard). page.request's shared cookie
  //    jar keeps it, scoped to the SPA origin via the preview proxy.
  const callback = await page.request.get(
    `/api/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`,
    { maxRedirects: 0 },
  );
  expect(callback.status()).toBe(302);

  // 3. Force the dark theme before the first paint (see index.html theme script).
  await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'dark'));

  // 4. Load the SPA: it calls /api/auth/me, resolves authed, renders AppLayout.
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Búsqueda/ })).toBeVisible();
}

/**
 * Log in as a GUEST (Story 2.5) via the real POST /api/auth/guest endpoint (guest
 * access is enabled in the harness only). Mirrors {@link loginAs}: shared cookie
 * jar, dark-theme init script, then land on the authenticated shell.
 */
export async function loginAsGuest(page: Page): Promise<void> {
  // CSRF (L-2): requireCustomHeader rejects mutating /api requests without this
  // header — mirrors the SPA's CSRF_HEADER (src/api/csrf.ts).
  const res = await page.request.post('/api/auth/guest', {
    maxRedirects: 0,
    headers: { 'X-Requested-With': 'share2brain' },
  });
  expect(res.status()).toBe(200);

  await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'dark'));

  await page.goto('/');
  await expect(page.getByRole('button', { name: /Búsqueda/ })).toBeVisible();
}
