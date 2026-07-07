// Visual verification of the Story 5.3 chat widget shell via getComputedStyle
// against the REAL global CSS (Epic 4 retro AI#6 — a visual AC is not done until
// the harness asserts it). Dark theme is forced by loginAs, so the assertions use
// the dark-theme computed tokens.
//
// Discovery order: Playwright loads spec files alphabetically and runs with
// workers:1, so `chat.spec.ts` sorts BEFORE `docs.spec.ts`. This spec is
// read-only (the history overlay only reads GET /api/conversations; nothing
// mutates), so the docs spec's mutating "mark all read" test still runs last and
// stays isolated. See tests/README.md.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { loginAs } from './helpers/session';

// The AC1 test needs to assert the FAB's closed/resting state first, so it
// can't use this helper; the other 3 tests below open straight into the panel.
async function gotoChat(page: Page): Promise<void> {
  await loginAs(page, 'e2e-member');
  await page.getByTestId('chat-fab').click();
}

// Dark-theme computed tokens (see global.css :root) + fixed brand colors.
const ACCENT_INK = 'rgb(245, 166, 35)'; // --accent-ink #F5A623
const BG = 'rgb(14, 17, 22)'; // --bg / --on-accent #0E1116
const SURFACE = 'rgb(18, 22, 29)'; // --surface #12161D
const BORDER = 'rgb(32, 38, 47)'; // --border #20262F
const BORDER_STRONG = 'rgb(42, 49, 61)'; // --border-strong #2A313D

// Must match packages/backend/src/e2e/seed.ts CONVERSATION_TITLE (derived from the
// seeded first user message — the exact text the history row renders).
const SEEDED_TITLE = '¿Cómo configuro las notificaciones externas?';

test.describe('Story 5.3 — Chat widget (FAB + panel shell)', () => {
  test('FAB geometry + amber shadow + hexagon clip-path (AC1)', async ({ page }, testInfo) => {
    await loginAs(page, 'e2e-member');

    const fab = page.getByTestId('chat-fab');
    await expect(fab).toBeVisible();
    await expect(fab).toHaveCSS('position', 'fixed');
    await expect(fab).toHaveCSS('bottom', '24px');
    await expect(fab).toHaveCSS('right', '24px');
    await expect(fab).toHaveCSS('z-index', '60');
    await expect(fab).toHaveCSS('width', '60px');
    await expect(fab).toHaveCSS('height', '60px');

    // The amber hexagon is the first (aria-hidden) span: gradient fill, clip-path,
    // and the amber drop shadow (box-shadow serializes color-first in Chromium).
    const hexSpan = fab.locator('span').first();
    await expect(hexSpan).toHaveCSS('clip-path', /polygon\(/);
    await expect(hexSpan).toHaveCSS('box-shadow', 'rgba(245, 166, 35, 0.65) 0px 14px 34px -10px');

    // The chat icon is stroked in var(--on-accent) (#0E1116) via the wrapper color.
    await expect(fab.locator('svg')).toHaveCSS('stroke', BG);

    // Hover lifts the FAB by 2px (transform: translateY(-2px)).
    await fab.hover();
    await expect(fab).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -2)');

    await page.screenshot({ path: testInfo.outputPath('chat-fab.png'), fullPage: true });
  });

  test('panel dimensions, chrome, and FAB hide/return (AC2, AC3)', async ({ page }, testInfo) => {
    await gotoChat(page);

    // AC3: the FAB is not rendered while the panel is open.
    await expect(page.getByTestId('chat-fab')).toHaveCount(0);

    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    // In the default 1280×720 viewport both dimensions resolve under their clamps.
    await expect(panel).toHaveCSS('width', '404px');
    await expect(panel).toHaveCSS('height', '642px');
    await expect(panel).toHaveCSS('border-radius', '18px');
    await expect(panel).toHaveCSS('position', 'fixed');
    await expect(panel).toHaveCSS('z-index', '60');
    await expect(panel).toHaveCSS('background-color', BG);
    await expect(panel).toHaveCSS('border-color', BORDER_STRONG);
    await expect(panel).toHaveCSS('border-style', 'solid');
    await expect(panel).toHaveCSS('animation-name', 'kh-pop');

    await page.screenshot({ path: testInfo.outputPath('chat-panel.png'), fullPage: true });

    // AC3: closing brings the FAB back.
    await page.getByRole('button', { name: 'Cerrar chat' }).click();
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
    await expect(page.getByTestId('chat-fab')).toHaveCount(1);
  });

  test('empty state: hexagon, heading, and 3 suggestion chips (AC4)', async ({ page }, testInfo) => {
    await gotoChat(page);

    const empty = page.getByTestId('chat-empty-state');
    await expect(empty).toBeVisible();

    // Centered 60px hexagon (its outer layer is the empty state's first child div).
    const hexagon = empty.locator('> div').first();
    await expect(hexagon).toHaveCSS('width', '60px');
    await expect(hexagon).toHaveCSS('clip-path', /polygon\(/);

    // Heading: Space Grotesk 600 / 21px.
    const heading = empty.getByText('Preguntá lo que quieras');
    await expect(heading).toHaveCSS('font-family', /Space Grotesk/);
    await expect(heading).toHaveCSS('font-size', '21px');
    await expect(heading).toHaveCSS('font-weight', '600');

    // Exactly 3 suggestion chips, each with the prototype's surface/border look.
    const suggestions = page.getByTestId('chat-suggestion');
    await expect(suggestions).toHaveCount(3);
    const firstChip = suggestions.first();
    await expect(firstChip).toHaveCSS('border-radius', '11px');
    await expect(firstChip).toHaveCSS('background-color', SURFACE);
    await expect(firstChip).toHaveCSS('border-color', BORDER);

    // A suggestion chip hovers to an amber border.
    await firstChip.hover();
    await expect(firstChip).toHaveCSS('border-color', ACCENT_INK);

    await page.screenshot({ path: testInfo.outputPath('chat-empty.png'), fullPage: true });
  });

  test('conversation-history overlay populated from the seed (AC5)', async ({ page }, testInfo) => {
    await gotoChat(page);

    await page.getByRole('button', { name: 'Historial de conversaciones' }).click();

    const overlay = page.getByTestId('chat-history-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCSS('background-color', BG);

    // The uppercase mono label.
    const label = overlay.getByText('Historial de conversaciones');
    await expect(label).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(label).toHaveCSS('text-transform', 'uppercase');

    // The seeded conversation renders as one row with the derived title.
    const items = page.getByTestId('chat-history-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText(SEEDED_TITLE);

    await page.screenshot({ path: testInfo.outputPath('chat-history.png'), fullPage: true });
  });
});
