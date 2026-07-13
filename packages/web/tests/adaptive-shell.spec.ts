// E2E visual verification of the Epic 11 MOBILE shell (Story 11.5). Extends the
// computed-style harness (Story 4.5) to the 390×844 viewport — the design keys
// the layout off `matchMedia('(max-width: 760px)')` (useIsMobile), which
// Playwright's `viewport` drives in Chromium, so a 390-wide viewport set at
// `describe` scope flips `isMobile=true` BEFORE mount. Asserts the mobile-defining
// layout anchors (AC2 shell, AC3 chat geometry) and the mobile×light token deltas
// (AC4) — NOT a re-assertion of the desktop×dark value set (D5).
//
// This file sorts ALPHABETICALLY FIRST (adaptive < analytics < auth-guest < chat
// < docs), so it runs BEFORE the mutating `docs.spec.ts` (its "mark all read"
// zeroes the unread bottom-nav-badge) — the seeded unread count (3) it asserts
// is therefore seed-fresh. It is STRICTLY NON-MUTATING (login + view navigation +
// chat-panel open only; no message sent, no doc-row marked read) — see
// tests/README.md §"Spec discovery order (invariant)".
import { expect, test, type Page } from '@playwright/test';

import { loginAs } from './helpers/session';

// Dark-theme computed tokens (see global.css :root, dark block).
const DARK_BG_DEEP = 'rgb(11, 14, 19)'; // --bg-deep #0B0E13
const DARK_LINE = 'rgb(24, 29, 37)'; // --line #181D25
const DARK_ACCENT_INK = 'rgb(245, 166, 35)'; // --accent-ink #F5A623
const DARK_TX4 = 'rgb(124, 132, 148)'; // --tx4 #7C8494 (inactive nav item)
const DARK_BORDER_STRONG = 'rgb(42, 49, 61)'; // --border-strong #2A313D
// Light-theme computed tokens (see global.css [data-kh="light"]).
const LIGHT_BG = 'rgb(244, 245, 247)'; // --bg #F4F5F7
const LIGHT_BG_DEEP = 'rgb(236, 238, 241)'; // --bg-deep #ECEEF1
const LIGHT_ACCENT_INK = 'rgb(154, 91, 0)'; // --accent-ink #9A5B00 (the key theme delta)
const LIGHT_TX = 'rgb(27, 31, 39)'; // --tx #1B1F27 (view text)
const LIGHT_SURFACE = 'rgb(255, 255, 255)'; // --surface #FFFFFF (== --card in light)
const LIGHT_BORDER_STRONG = 'rgb(211, 216, 223)'; // --border-strong #D3D8DF
// Brand amber badge (theme-independent): #F5A623 bg / --on-accent #0E1116 text.
const BADGE_BG = 'rgb(245, 166, 35)';
const BADGE_TEXT = 'rgb(14, 17, 22)';
// The seeded member has 5 resources, 2 pre-read → 3 unread (analytics.spec.ts
// asserts "Sin leer · 3"). Seed-fresh here because this file sorts before docs.
const SEEDED_UNREAD = '3';

// The `<nav>` that holds the mobile bottom-nav items (never the desktop sidebar
// `<nav>`, which is absent below 760px — conditional render, not display:none).
const bottomNav = (page: Page) =>
  page.locator('nav').filter({ has: page.locator('.kh-bottom-nav-item') });

test.describe('Story 11.5 — mobile shell + chat geometry (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('mobile×dark — bottom-nav present, sidebar absent, header compacted (AC2)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member'); // dark default

    // BottomNav geometry + tokens.
    const nav = bottomNav(page);
    await expect(nav).toHaveCSS('position', 'fixed');
    await expect(nav).toHaveCSS('bottom', '0px');
    await expect(nav).toHaveCSS('height', '62px');
    await expect(nav).toHaveCSS('z-index', '55');
    await expect(nav).toHaveCSS('background-color', DARK_BG_DEEP); // --bg-deep
    await expect(nav).toHaveCSS('border-top-color', DARK_LINE); // --line

    // Exactly the three reused nav items; the desktop sidebar is NOT in the DOM.
    await expect(page.locator('.kh-bottom-nav-item')).toHaveCount(3);
    await expect(page.locator('.kh-nav-item')).toHaveCount(0);

    // Active item (Búsqueda on landing): amber ink + aria-current="page".
    const active = page.locator('.kh-bottom-nav-item[aria-current="page"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveCSS('color', DARK_ACCENT_INK); // --accent-ink
    const inactive = page.locator('.kh-bottom-nav-item:not([aria-current="page"])').first();
    await expect(inactive).toHaveCSS('color', DARK_TX4); // --tx4

    // Docs unread badge shows the seeded member's unread count, amber pill.
    const badge = page.getByTestId('bottom-nav-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(SEEDED_UNREAD);
    await expect(badge).toHaveCSS('background-color', BADGE_BG); // #F5A623, theme-independent
    await expect(badge).toHaveCSS('color', BADGE_TEXT); // --on-accent

    // Header compaction: tight padding, hexagon logo present, desktop-only chrome absent.
    const header = page.getByRole('banner');
    await expect(header).toHaveCSS('padding', '0px 14px');
    const hexagon = header.locator('[style*="polygon"]').first();
    await expect(hexagon).toBeVisible();
    await expect(hexagon).toHaveCSS('width', '28px'); // Hexagon size={28} — mobile-only
    await expect(page.getByTestId('live-pulse')).toHaveCount(0); // live-indexing pill
    await expect(header.getByText('e2e-member', { exact: true })).toHaveCount(0); // username span
    await expect(header.getByText(/pgvector/)).toHaveCount(0); // statsLine (desktop-only, t('app.statsLine'))

    await page.screenshot({ path: testInfo.outputPath('mobile-dark-shell.png'), fullPage: true });
  });

  test('mobile×dark — active bottom-nav follows navigation across docs & stats (AC5)', async ({
    page,
  }) => {
    await loginAs(page, 'e2e-member');

    // Search is active on landing; navigating swaps aria-current + amber ink.
    await page.getByRole('button', { name: /Documentos/ }).click();
    const docsItem = page.getByRole('button', { name: /Documentos/ });
    await expect(docsItem).toHaveAttribute('aria-current', 'page');
    await expect(docsItem).toHaveCSS('color', DARK_ACCENT_INK);

    await page.getByRole('button', { name: /Estadísticas/ }).click();
    const statsItem = page.getByRole('button', { name: /Estadísticas/ });
    await expect(statsItem).toHaveAttribute('aria-current', 'page');
    await expect(statsItem).toHaveCSS('color', DARK_ACCENT_INK);
    // The bottom-nav bar persists across every view (fixed shell).
    await expect(bottomNav(page)).toHaveCSS('position', 'fixed');
  });

  test('mobile — chat FAB + open panel adopt the mobile corner geometry (AC3)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');

    // Closed FAB: bottom:78 (clears the 62px bottom-nav) / right:16 (vs 24/24 desktop).
    const fab = page.getByTestId('chat-fab');
    await expect(fab).toHaveCSS('position', 'fixed');
    await expect(fab).toHaveCSS('bottom', '78px');
    await expect(fab).toHaveCSS('right', '16px');
    await expect(fab).toHaveCSS('width', '60px');
    await expect(fab).toHaveCSS('height', '60px');
    await expect(fab).toHaveCSS('z-index', '60');

    // Open panel: same corner offsets; the STATIC (not isMobile-bound) max-width/
    // max-height clamps are what make it fit at 390×844.
    await fab.click();
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('bottom', '78px');
    await expect(panel).toHaveCSS('right', '16px');
    // USED width = 358px: the 404px design width is clamped by max-width:calc(100vw
    // - 32px) (=358 at 390 wide), so the panel fits with 16px side margins (358 +
    // 16 + 16 = 390) — no horizontal overflow. Height (642) stays natural because
    // it is below max-height:calc(100vh - 48px) (=796 at 844 tall) → no clip.
    await expect(panel).toHaveCSS('width', '358px'); // clamped by max-width
    await expect(panel).toHaveCSS('height', '642px'); // natural (< max-height)
    await expect(panel).toHaveCSS('max-width', '358px'); // calc(100vw - 32px) @ 390
    await expect(panel).toHaveCSS('max-height', '796px'); // calc(100vh - 48px) @ 844
    await expect(panel).toHaveCSS('border-color', DARK_BORDER_STRONG); // --border-strong

    await page.screenshot({ path: testInfo.outputPath('mobile-chat-panel.png'), fullPage: true });
  });

  test('mobile×light — shell + view tokens resolve to the light set (AC4/AC5)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member', 'light');

    // Shell in light: header --bg, bottom-nav --bg-deep, active item --accent-ink
    // (the #F5A623 → #9A5B00 delta — active tab / focus ring / active chip).
    await expect(page.getByRole('banner')).toHaveCSS('background-color', LIGHT_BG); // --bg
    const nav = bottomNav(page);
    await expect(nav).toHaveCSS('background-color', LIGHT_BG_DEEP); // --bg-deep
    await expect(page.locator('.kh-bottom-nav-item[aria-current="page"]')).toHaveCSS(
      'color',
      LIGHT_ACCENT_INK, // --accent-ink #9A5B00
    );

    // Search view (landing): heading text resolves to --tx light.
    await expect(page.getByRole('heading', { name: 'Búsqueda de conocimiento' })).toHaveCSS(
      'color',
      LIGHT_TX, // --tx
    );

    // Stats view: KPI card background resolves to the light card surface.
    await page.getByRole('button', { name: /Estadísticas/ }).click();
    await expect(page.getByTestId('stats-kpi-card').first()).toHaveCSS(
      'background-color',
      LIGHT_SURFACE, // --surface (== --card in light, both #FFFFFF)
    );

    // Docs view: doc-row content text resolves to --tx light.
    await page.getByRole('button', { name: /Documentos/ }).click();
    await expect(page.getByTestId('doc-row-content').first()).toHaveCSS('color', LIGHT_TX); // --tx

    await page.screenshot({ path: testInfo.outputPath('mobile-light-shell.png'), fullPage: true });
  });

  test('mobile — login screen reachable in both themes (AC4/AC5 login)', async ({ page }) => {
    // Pre-auth: no loginAs — set theme + goto, mirroring auth-guest.spec.ts's
    // login-screen test. Dark first, then light, both at the mobile viewport.
    await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'dark'));
    await page.goto('/');
    await expect(page.getByTestId('guest-login-btn')).toBeVisible();
    await expect(page.getByTestId('guest-login-btn')).toHaveCSS(
      'border-color',
      DARK_BORDER_STRONG,
    );

    await page.addInitScript(() => localStorage.setItem('share2brain-theme', 'light'));
    await page.goto('/');
    await expect(page.getByTestId('guest-login-btn')).toBeVisible();
    await expect(page.getByTestId('guest-login-btn')).toHaveCSS(
      'border-color',
      LIGHT_BORDER_STRONG,
    );
  });
});
