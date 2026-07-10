// Retroactive visual verification of Story 4.3 (Búsqueda) via getComputedStyle
// against the REAL global CSS (Story 4.5). Dark theme is forced by loginAs, so
// every token below resolves to its dark computed value (see the story's
// computed-value table). If any assertion contradicts a 4.3 AC, that is a real
// regression finding — do not soften the assertion to match the code.
import { expect, test } from '@playwright/test';

import { loginAs } from './helpers/session';

// Dark-theme computed tokens (see global.css :root).
const ACCENT_INK = 'rgb(245, 166, 35)'; // --accent-ink #F5A623
const SURFACE = 'rgb(18, 22, 29)'; // --surface #12161D
const TEXT_PRIMARY = 'rgb(230, 233, 239)'; // --text-primary #E6E9EF
const TEXT_SECONDARY = 'rgb(199, 205, 216)'; // --text-secondary #C7CDD8
const TEXT_TERTIARY = 'rgb(154, 163, 178)'; // --text-tertiary #9AA3B2
const TEXT_MUTED = 'rgb(124, 132, 148)'; // --text-muted #7C8494
const BORDER_STRONG = 'rgb(42, 49, 61)'; // --border-strong #2A313D

// The top result card (query 'share2brain', similarity 1.0) is the #general one-hot(0)
// fragment e2e-msg-g1 — its title/description/link are the exact seed values.
const TOP_TITLE = 'Cómo configurar los canales a indexar';
const TOP_RESOURCE_LINK = 'https://example.com/e2e/configurar-canales-indexados';

test.describe('Story 4.3 — Búsqueda (retroactive visual verification)', () => {
  test('title, search bar, focus ring, result card, and chips (4.3 AC1/AC2/AC4/AC5)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');

    // 4.3-AC1 — title typography + search bar height.
    const title = page.getByRole('heading', { name: 'Búsqueda de conocimiento' });
    await expect(title).toHaveCSS('font-family', /Space Grotesk/);
    await expect(title).toHaveCSS('font-weight', '600');
    await expect(title).toHaveCSS('font-size', '25px');

    const input = page.locator('.kh-search-input');
    await expect(input).toHaveCSS('height', '54px');

    // 4.3-AC2 — focus ring: accent border + amber glow (from .kh-search-input:focus).
    await input.focus();
    await expect(input).toHaveCSS('border-color', ACCENT_INK);
    await expect(input).toHaveCSS('box-shadow', 'rgba(245, 166, 35, 0.12) 0px 0px 0px 3px');

    // 4.3-AC3/AC4 — type a query (250ms debounce; rely on auto-retry) and inspect
    // the first result card (top similarity = the #general one-hot fragment).
    await input.fill('share2brain');
    const card = page.locator('.kh-result-card').first();
    await expect(card).toBeVisible();

    // Channel badge: amber-tinted background, monospace 12px.
    const badge = card.getByText('#general', { exact: true });
    await expect(badge).toHaveCSS('background-color', 'rgba(245, 166, 35, 0.1)');
    await expect(badge).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(badge).toHaveCSS('font-size', '12px');

    // Similarity bar: 54×5 track, radius 3, amber→highlight gradient fill.
    const bar = card.getByTestId('similarity-bar');
    await expect(bar).toHaveCSS('width', '54px');
    await expect(bar).toHaveCSS('height', '5px');
    await expect(bar).toHaveCSS('border-radius', '3px');
    const fill = bar.locator('div');
    await expect(fill).toHaveCSS(
      'background-image',
      /linear-gradient\(90deg, rgb\(245, 166, 35\), rgb\(255, 203, 107\)\)/,
    );

    // Avatar: 24px round. "e2e-author-ada" → initials "E2" (single token).
    const avatar = card.getByText('E2', { exact: true });
    await expect(avatar).toHaveCSS('width', '24px');
    await expect(avatar).toHaveCSS('height', '24px');
    await expect(avatar).toHaveCSS('border-radius', '50%');

    // 4.3-AC5 — chip styles. "todos" is active on load; "#general" is inactive.
    const activeChip = page.getByRole('button', { name: 'todos' });
    await expect(activeChip).toHaveCSS('background-color', 'rgba(245, 166, 35, 0.14)');
    await expect(activeChip).toHaveCSS('border-width', '1px');
    await expect(activeChip).toHaveCSS('border-style', 'solid');
    await expect(activeChip).toHaveCSS('border-color', 'rgba(245, 166, 35, 0.45)');
    await expect(activeChip).toHaveCSS('color', ACCENT_INK);

    const inactiveChip = page.getByRole('button', { name: '#general' });
    await expect(inactiveChip).toHaveCSS('background-color', SURFACE);
    await expect(inactiveChip).toHaveCSS('color', TEXT_TERTIARY);

    await page.screenshot({ path: testInfo.outputPath('search-results.png'), fullPage: true });
  });

  test('empty state when the scope has no indexed knowledge (4.3 AC6)', async ({
    page,
  }, testInfo) => {
    // The empty user's only channel (e2e-ch-void) has zero embeddings — the only
    // way to reach 0 results, since search has no similarity threshold.
    await loginAs(page, 'e2e-empty');

    await page.locator('.kh-search-input').fill('share2brain');

    const empty = page.getByTestId('search-empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveCSS('border-style', 'dashed');
    await expect(empty).toHaveCSS('border-width', '1px');
    await expect(empty).toHaveCSS('border-color', BORDER_STRONG);
    await expect(
      empty.getByText('Sin coincidencias en el conocimiento indexado.'),
    ).toBeVisible();
    await expect(
      empty.getByText('Probá con otros términos o consultá al agente en el chat.'),
    ).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('search-empty.png'), fullPage: true });
  });
});

// Story 7.5 rendered the resource title heading, the description body, and the
// "ver recurso" link on each result card; its jsdom unit tests could not verify
// the typography/color/hover (jsdom resolves no CSS custom properties). This
// harness asserts the pixel reality (Epic 4 retro AI#6). Non-mutating (search is
// read-only) so it can sit alongside the 4.3 tests.
test.describe('Story 7.6 — SearchView resource title + link', () => {
  test('top card renders the resource title, description, and "ver recurso" link (AC1)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');

    await page.locator('.kh-search-input').fill('share2brain');
    const card = page.locator('.kh-result-card').first();
    await expect(card).toBeVisible();

    // Title <h3>: Space Grotesk 600 / 15.5px, primary color, seeded text.
    const title = card.locator('h3');
    await expect(title).toHaveText(TOP_TITLE);
    await expect(title).toHaveCSS('font-family', /Space Grotesk/);
    await expect(title).toHaveCSS('font-weight', '600');
    await expect(title).toHaveCSS('font-size', '15.5px');
    await expect(title).toHaveCSS('color', TEXT_PRIMARY);

    // Description <p> under the title: secondary color, 14px.
    const description = card.locator('p');
    await expect(description).toHaveCSS('color', TEXT_SECONDARY);
    await expect(description).toHaveCSS('font-size', '14px');

    // "ver recurso" link: seed href, opens a new tab, base muted color, hover amber.
    // The base color lives in .kh-resource-link (components.css), NOT inline, so
    // :hover can override it (7.5 cascade fix) — the hover assertion is the guard.
    const resourceLink = card.locator('.kh-resource-link');
    await expect(resourceLink).toHaveAttribute('href', TOP_RESOURCE_LINK);
    await expect(resourceLink).toHaveAttribute('target', '_blank');
    await expect(resourceLink).toHaveCSS('color', TEXT_MUTED);
    await resourceLink.hover();
    await expect(resourceLink).toHaveCSS('color', ACCENT_INK);

    // The pre-existing "ver en Discord" deep link is unchanged and coexists.
    const discordLink = card.locator('.kh-discord-link');
    await expect(discordLink).toHaveAttribute('href', /discord\.com\/channels/);

    await page.screenshot({ path: testInfo.outputPath('search-resource.png'), fullPage: true });
  });
});
