// Visual verification of the chat widget (Story 5.3 shell + Story 5.4 chat) via
// getComputedStyle against the REAL global CSS (Epic 4 retro AI#6 — a visual AC is
// not done until the harness asserts it). Dark theme is forced by loginAs, so the
// assertions use the dark-theme computed tokens.
//
// Discovery order: Playwright loads spec files alphabetically and runs with
// workers:1, so `chat.spec.ts` sorts BEFORE `docs.spec.ts`. Story 5.3 + the 5.4
// composer/history-load tests are read-only; the 5.4 STREAMING test at the end
// PERSISTS a new conversation (mutating) — it is ordered LAST in this file, and no
// test asserts an exact conversation count after it. Conversation rows don't touch
// the documents/user_read_status tables `docs.spec.ts` asserts on, so the docs
// spec's mutating "mark all read" test still runs last and stays isolated. See
// tests/README.md.
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
const LINE = 'rgb(24, 29, 37)'; // --line #181D25 (disabled send button bg)
const AMBER = 'rgb(245, 166, 35)'; // #F5A623 (enabled send button bg)
const TEXT_PRIMARY = 'rgb(230, 233, 239)'; // --tx #E6E9EF

// The seeded conversation's one citation (CONVERSATION_CITATIONS[0] in seed.ts):
// the chip shows this resource title and links to this href.
const CITATION_TITLE = 'Cómo configurar los canales a indexar';
const CITATION_LINK = 'https://example.com/e2e/configurar-canales-indexados';

// Must match packages/backend/src/e2e/seed.ts (the seeded conversation the history
// overlay lists and 5.4 loads). Title is DERIVED from the first user message.
const SEEDED_TITLE = '¿Cómo configuro las notificaciones externas?';
const SEEDED_ANSWER =
  'Las notificaciones externas se configuran en Share2Brain.config.yml bajo la sección notifications.';
// The harness fakeChatModel (test-helpers.ts) streams a fixed token list for a
// NEW turn, so a freshly-sent message's agent bubble ends at exactly this text.
const FAKE_ANSWER = 'Hola desde Share2Brain.';

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

test.describe('Story 5.4 — Chat messages + streaming', () => {
  test('composer: disabled empty look → enabled amber look + footer (AC1, AC2)', async ({ page }, testInfo) => {
    await gotoChat(page);

    const send = page.getByTestId('chat-send');
    // Disabled while the draft is empty: grey (--line) bg, not-allowed cursor.
    await expect(send).toBeDisabled();
    await expect(send).toHaveCSS('background-color', LINE);
    await expect(send).toHaveCSS('cursor', 'not-allowed');
    await expect(send).toHaveCSS('width', '40px');
    await expect(send).toHaveCSS('height', '40px');
    await expect(send).toHaveCSS('border-radius', '11px');

    // The input row's base border turns amber on :focus-within.
    const inputRow = page.getByTestId('chat-input-row');
    await expect(inputRow).toHaveCSS('border-color', BORDER_STRONG);
    await page.getByTestId('chat-input').focus();
    await expect(inputRow).toHaveCSS('border-color', ACCENT_INK);

    // Footer privacy string.
    await expect(page.getByText(/Respuestas con fuente verificable/)).toBeVisible();

    // Typing enables the send button: amber (#F5A623) bg, pointer cursor.
    await page.getByTestId('chat-input').fill('¿Qué es RBAC?');
    await expect(send).toBeEnabled();
    await expect(send).toHaveCSS('background-color', AMBER);
    await expect(send).toHaveCSS('cursor', 'pointer');

    await page.screenshot({ path: testInfo.outputPath('chat-composer.png'), fullPage: true });
  });

  test('history load: selecting the seeded row renders its messages + citation (AC6)', async ({ page }, testInfo) => {
    await gotoChat(page);

    await page.getByRole('button', { name: 'Historial de conversaciones' }).click();
    await page.getByTestId('chat-history-item').first().click();

    // Overlay closes; the seeded user + agent bubbles render.
    await expect(page.getByTestId('chat-history-overlay')).toHaveCount(0);
    await expect(page.getByTestId('chat-msg-user')).toContainText(SEEDED_TITLE);
    await expect(page.getByTestId('chat-msg-agent')).toContainText(SEEDED_ANSWER);

    // Its one citation chip: a #general source (mono, --accent-ink) with a hover
    // border that turns Discord blurple.
    const citation = page.getByTestId('chat-citation').first();
    await expect(citation).toContainText('#general');
    await expect(citation).toHaveCSS('border-color', BORDER);

    // Story 7.6 (7.5-rendered, jsdom-unverifiable): the chip shows the resource
    // title and links to the resource, not a placeholder discord.com/channels href.
    await expect(citation).toHaveAttribute('href', CITATION_LINK);
    const citationTitle = citation.getByText(CITATION_TITLE, { exact: true });
    await expect(citationTitle).toHaveCSS('color', TEXT_PRIMARY);
    await expect(citationTitle).toHaveCSS('text-overflow', 'ellipsis');
    // overflow:hidden makes the ellipsis + max-width truncation actually engage;
    // without it the ellipsis is inert, so a regression dropping it must fail here.
    await expect(citationTitle).toHaveCSS('overflow-x', 'hidden');
    await expect(citationTitle).toHaveCSS('max-width', '180px');

    await citation.hover();
    await expect(citation).toHaveCSS('border-color', 'rgb(88, 101, 242)'); // #5865F2

    // A loaded (historical) conversation is not streaming — no cursor.
    await expect(page.getByTestId('chat-cursor')).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath('chat-history-load.png'), fullPage: true });
  });

  // MUTATES (persists a new conversation) — must be the LAST test in this file
  // (D9). No test after this may assert an exact conversation count.
  test('streaming: sending accumulates the fake answer + citations, cursor gone on done (AC3, AC4)', async ({
    page,
  }, testInfo) => {
    await gotoChat(page);

    await page.getByTestId('chat-input').fill('¿Cómo configuro Share2Brain?');
    await page.getByTestId('chat-send').click();

    // The user bubble echoes the sent text; the agent bubble accumulates the
    // fake model's fixed tokens to exactly "Hola desde Share2Brain.".
    await expect(page.getByTestId('chat-msg-user')).toContainText('¿Cómo configuro Share2Brain?');
    await expect(page.getByTestId('chat-msg-agent')).toContainText(FAKE_ANSWER);

    // The retrieve step (fake embedder + seeded member embeddings) yields ≥1
    // citation, rendered under the agent bubble after the tokens.
    await expect(page.getByTestId('chat-citation').first()).toBeVisible();
    expect(await page.getByTestId('chat-citation').count()).toBeGreaterThanOrEqual(1);

    // The blinking cursor is gone once the `done` frame arrives.
    await expect(page.getByTestId('chat-cursor')).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath('chat-streaming.png'), fullPage: true });
  });
});
