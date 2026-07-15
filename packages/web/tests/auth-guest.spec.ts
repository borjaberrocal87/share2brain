// E2E visual + RBAC verification of guest access (Story 2.5). Guest access is
// enabled in the harness only (packages/backend/src/e2e/server.ts); `e2e-role-guest`
// is mapped to `e2e-ch-general` ALONE in the seed.
//
// This file sorts ALPHABETICALLY SECOND (analytics < auth-guest < chat), so
// `analytics` still runs first against seed-fresh figures. It is STRICTLY
// NON-MUTATING (guest login only — no chat message, no doc-row click, no mark-all),
// because it runs before the mutating `chat`/`docs` specs — see tests/README.md.
import { expect, test } from '@playwright/test';

import { loginAsGuest } from './helpers/session';

// Dark-theme computed tokens (see global.css :root, dark block). loginAsGuest /
// the login-screen test both force the dark theme before the first paint.
const BORDER_STRONG = 'rgb(42, 49, 61)'; // --border-strong #2A313D
const TEXT_SECONDARY = 'rgb(199, 205, 216)'; // --tx2 #C7CDD8

test.describe('Story 2.5 — guest access (E2E)', () => {
  test('login screen shows the guest button with its base colors (harness enabled)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'dark'));
    await page.goto('/');

    // The availability probe (GET /api/auth/guest) resolves 200 in the harness →
    // the button renders under the "o para la demo" divider.
    const guestBtn = page.getByTestId('guest-login-btn');
    await expect(guestBtn).toBeVisible();
    await expect(page.getByText('o para la demo')).toBeVisible();
    // Base border + color live in .kh-guest-btn (cascade gotcha) — assert the
    // computed base values (not the amber :hover).
    await expect(guestBtn).toHaveCSS('border-color', BORDER_STRONG);
    await expect(guestBtn).toHaveCSS('color', TEXT_SECONDARY);

    // Story 2.6: the harness configures inviteUrl, so the demo-invite row renders
    // under the guest button — the "¿No tienes acceso?" prompt + a new-tab link to
    // the configured invite. The base border-bottom is transparent (turns on :hover).
    await expect(page.getByText('¿No tienes acceso?')).toBeVisible();
    const inviteLink = page.getByTestId('demo-invite-link');
    await expect(inviteLink).toBeVisible();
    await expect(inviteLink).toHaveText('Únete al servidor Discord de demo');
    await expect(inviteLink).toHaveAttribute('href', 'https://discord.gg/e2e-demo');
    await expect(inviteLink).toHaveAttribute('target', '_blank');
    await expect(inviteLink).toHaveAttribute('rel', 'noopener');
    await expect(inviteLink).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
  });

  test('clicking the guest button enters the guest shell (badge + identity + "Salir")', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'dark'));
    await page.goto('/');

    await page.getByTestId('guest-login-btn').click();

    // Authenticated layout in guest mode: the amber "Modo invitado" pill + the
    // guest identity in the header. No full-page reload (AC6).
    await expect(page.getByTestId('guest-mode-badge')).toBeVisible();
    await expect(page.getByTestId('guest-mode-badge')).toHaveText('Modo invitado');
    await expect(page.getByRole('banner').getByText('Invitado', { exact: true })).toBeVisible();
    // Icon-only logout button's accessible name flips to "Salir".
    await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);
  });

  test('the chat widget hides the history button in guest mode (shared-identity isolation)', async ({ page }) => {
    await loginAsGuest(page);

    // Opening the chat panel is non-mutating (no message sent). In guest mode the
    // "Historial" button is absent — the list/detail endpoints are server-side
    // isolated for the shared guest identity, so there is no per-guest history.
    await page.getByTestId('chat-fab').click();
    await expect(page.getByTestId('chat-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Historial de conversaciones' })).toHaveCount(0);
    // The rest of the header is intact (new-chat + close still present).
    await expect(page.getByRole('button', { name: 'Nueva conversación' })).toBeVisible();
  });

  test('DocsView is RBAC-scoped to #general only (canaries absent)', async ({ page }) => {
    await loginAsGuest(page);

    await page.getByRole('button', { name: /Documentos/ }).click();
    await expect(page.locator('.kh-doc-row').first()).toBeVisible();

    // The guest sees exactly the 3 #general resources — not #random's 2, never
    // the #secreto canary (AD-12 in-SQL scoping).
    await expect(page.locator('.kh-doc-row')).toHaveCount(3);
    await expect(page.getByText('RBAC dentro de la query vectorial')).toBeVisible();
    // #random docs are out of scope (scoping, not just the canary).
    await expect(page.getByText('Similitud coseno con pgvector')).toHaveCount(0);
    await expect(page.getByText('Sesiones en Redis, sin tabla propia')).toHaveCount(0);
    // #secreto RBAC canaries (README canary trio) must NEVER surface.
    await expect(page.getByText('Eve Intrusa')).toHaveCount(0);
    await expect(page.getByText('Notas del canal secreto')).toHaveCount(0);
  });

  test('logging out returns to the login screen', async ({ page }) => {
    await loginAsGuest(page);

    await page.getByRole('button', { name: 'Salir' }).click();

    // Back on the login screen: the Discord button + the guest button (probe re-fires).
    await expect(page.getByRole('button', { name: /Continuar con Discord/ })).toBeVisible();
    await expect(page.getByTestId('guest-login-btn')).toBeVisible();
  });
});
