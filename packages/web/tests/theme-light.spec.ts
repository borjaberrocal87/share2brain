// E2E visual verification of the Epic 11 LIGHT theme on DESKTOP (Story 11.5).
// Extends the computed-style harness (Story 4.5) to `data-kh="light"`, set before
// first paint via loginAs(…, 'light'). Asserts the light-defining token anchors
// (AC4) on one representative element per view — login, search, docs, stats, chat
// — NOT a re-assertion of the desktop×dark value set (D5). The mobile×light
// combination lives in adaptive-shell.spec.ts.
//
// This file sorts ALPHABETICALLY LAST (… < search < theme-light), so it runs
// AFTER the mutating `chat`/`docs` specs. That is safe because every assertion
// here is a THEME TOKEN (color), never a seed-fresh count: `docs.spec.ts`'s
// mark-all and `chat.spec.ts`'s streaming perturb figures, not token values, and
// this file is itself STRICTLY NON-MUTATING (login + view navigation + chat-panel
// open only). See tests/README.md §"Spec discovery order (invariant)".
import { expect, test } from '@playwright/test';

import { loginAs } from './helpers/session';

// Light-theme computed tokens (see global.css [data-kh="light"]).
const LIGHT_BG = 'rgb(244, 245, 247)'; // --bg #F4F5F7
const LIGHT_TX = 'rgb(27, 31, 39)'; // --tx #1B1F27
const LIGHT_SURFACE = 'rgb(255, 255, 255)'; // --surface #FFFFFF (== --card in light)
const LIGHT_ACCENT_INK = 'rgb(154, 91, 0)'; // --accent-ink #9A5B00 (the key theme delta)
const LIGHT_BORDER_STRONG = 'rgb(211, 216, 223)'; // --border-strong #D3D8DF

test.describe('Story 11.5 — desktop × light theme (data-kh="light")', () => {
  test('login screen renders in light theme, guest button reachable (AC4 login)', async ({
    page,
  }) => {
    // Pre-auth: no loginAs — force the theme + goto, mirroring auth-guest.spec.ts.
    await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'light'));
    await page.goto('/');

    const guestBtn = page.getByTestId('guest-login-btn');
    await expect(guestBtn).toBeVisible();
    await expect(guestBtn).toHaveCSS('border-color', LIGHT_BORDER_STRONG); // --border-strong
  });

  test('search view — header, heading text, result card in light (AC4 search)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member', 'light');

    // Header background = --bg light.
    await expect(page.getByRole('banner')).toHaveCSS('background-color', LIGHT_BG); // --bg
    // View heading text = --tx light.
    await expect(page.getByRole('heading', { name: 'Búsqueda de conocimiento' })).toHaveCSS(
      'color',
      LIGHT_TX, // --tx
    );

    // A result card (search is read-only → non-mutating). Its surface = --surface
    // light (identical to --card in this theme). Also assert the active chip ink =
    // --accent-ink light (#9A5B00 — the amber→brown delta on active chips).
    await page.locator('.kh-search-input').fill('share2brain');
    await expect(page.locator('.kh-result-card').first()).toHaveCSS(
      'background-color',
      LIGHT_SURFACE, // --surface
    );
    await expect(page.getByRole('button', { name: 'todos' })).toHaveCSS('color', LIGHT_ACCENT_INK); // --accent-ink

    await page.screenshot({ path: testInfo.outputPath('desktop-light-search.png'), fullPage: true });
  });

  test('docs view — doc-row content text in light (AC4 docs)', async ({ page }) => {
    await loginAs(page, 'e2e-member', 'light');

    await page.getByRole('button', { name: /Documentos/ }).click();
    // doc-row-content is the resource title; its color is --tx in both read
    // states (never dimmed), so this holds even after docs.spec.ts's mark-all.
    await expect(page.getByTestId('doc-row-content').first()).toHaveCSS('color', LIGHT_TX); // --tx
  });

  test('stats view — KPI card surface in light (AC4 stats)', async ({ page }) => {
    await loginAs(page, 'e2e-member', 'light');

    await page.getByRole('button', { name: /Estadísticas/ }).click();
    await expect(page.getByTestId('stats-kpi-card').first()).toHaveCSS(
      'background-color',
      LIGHT_SURFACE, // --surface (== --card in light)
    );
  });

  test('chat panel — border + background in light (AC4 chat)', async ({ page }, testInfo) => {
    await loginAs(page, 'e2e-member', 'light');

    // Opening the panel is non-mutating (no message sent).
    await page.getByTestId('chat-fab').click();
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('border-color', LIGHT_BORDER_STRONG); // --border-strong
    await expect(panel).toHaveCSS('background-color', LIGHT_BG); // --bg

    await page.screenshot({ path: testInfo.outputPath('desktop-light-chat.png'), fullPage: true });
  });
});
