// Retroactive visual verification of Story 4.4 (Documentos) via getComputedStyle
// against the REAL global CSS (Story 4.5), extended by Story 7.6 (description +
// resource link) and Story 8.1 (read/unread redesign + 6-col layout). Dark theme
// is forced by loginAs. The mutating "mark all read" test runs LAST in this
// file; workers:1 + file order keep it isolated from the non-mutating tests and
// from search.spec.
import { expect, test } from '@playwright/test';

import { loginAs } from './helpers/session';

// Dark-theme computed tokens (see global.css :root).
const ACCENT_INK = 'rgb(245, 166, 35)'; // --accent-ink #F5A623
const HOVER_ROW = 'rgb(20, 25, 34)'; // --hover-row #141922
const TEXT_PRIMARY = 'rgb(230, 233, 239)'; // --text-primary #E6E9EF
const TEXT_MUTED = 'rgb(124, 132, 148)'; // --text-muted #7C8494
const TEXT_TERTIARY = 'rgb(154, 163, 178)'; // --text-tertiary #9AA3B2
const TEXT_SUBTLE = 'rgb(100, 108, 124)'; // --text-subtle #646C7C
const BORDER_STRONG = 'rgb(42, 49, 61)'; // --border-strong #2A313D

// The first DocsView row (ORDER BY created_at DESC → newest) is e2e-msg-g1, the
// same resource as the top search result; its link is the exact seed value.
const FIRST_DOC_RESOURCE_LINK = 'https://example.com/e2e/configurar-canales-indexados';

async function gotoDocs(page: import('@playwright/test').Page): Promise<void> {
  await loginAs(page, 'e2e-member');
  await page.getByRole('button', { name: /Documentos/ }).click();
  await expect(page.locator('.kh-doc-row').first()).toBeVisible();
}

test.describe('Story 4.4 — Documentos (retroactive visual verification)', () => {
  test('grid, header cells, read/unread rows, row hover, and sidebar badge (4.4, 8.1)', async ({
    page,
  }, testInfo) => {
    await gotoDocs(page);

    // Table grid: 6 tracks; minmax(160px,1fr) resolves to px in Chromium.
    const firstRow = page.locator('.kh-doc-row').first();
    await expect(firstRow).toHaveCSS(
      'grid-template-columns',
      /^150px \d+(\.\d+)?px 44px 92px 116px 84px$/,
    );

    // Header cells (source lowercase, uppercased by CSS): mono, 10.5px, uppercase, subtle.
    const header = page.getByText('título', { exact: true });
    await expect(header).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(header).toHaveCSS('font-size', '10.5px');
    await expect(header).toHaveCSS('text-transform', 'uppercase');
    await expect(header).toHaveCSS('color', TEXT_SUBTLE);

    // Unread row: amber dot + glow, "Nuevo" badge, amber row accent; primary
    // title color, weight 700.
    const unreadRow = page.locator('.kh-doc-row[data-read="false"]').first();
    const unreadDot = unreadRow.getByTestId('doc-row-dot');
    await expect(unreadDot).toHaveCSS('background-color', ACCENT_INK);
    await expect(unreadDot).toHaveCSS('box-shadow', 'rgba(245, 166, 35, 0.16) 0px 0px 0px 3px');
    const unreadContent = unreadRow.getByTestId('doc-row-content');
    await expect(unreadContent).toHaveCSS('color', TEXT_PRIMARY);
    await expect(unreadContent).toHaveCSS('font-weight', '700');
    const unreadBadge = unreadRow.getByTestId('doc-row-new-badge');
    await expect(unreadBadge).toBeVisible();
    await expect(unreadBadge).toHaveCSS('color', ACCENT_INK);
    await expect(unreadBadge).toHaveCSS('background-color', 'rgba(245, 166, 35, 0.13)');
    await expect(unreadBadge).toHaveCSS('text-transform', 'uppercase');
    await expect(unreadBadge).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(unreadRow).toHaveCSS('box-shadow', 'rgb(245, 166, 35) 3px 0px 0px 0px inset');

    // Read row: checkmark (no dot, no badge); primary title color (never dimmed),
    // weight 500; transparent row accent (same computed shape as the unread
    // accent, only the color differs — D3).
    const readRow = page.locator('.kh-doc-row[data-read="true"]').first();
    await expect(readRow.getByTestId('doc-row-dot')).toHaveCount(0);
    const readCheck = readRow.getByTestId('doc-row-check');
    await expect(readCheck).toBeVisible();
    await expect(readCheck).toHaveCSS('color', TEXT_SUBTLE);
    await expect(readRow.getByTestId('doc-row-new-badge')).toHaveCount(0);
    const readContent = readRow.getByTestId('doc-row-content');
    await expect(readContent).toHaveCSS('color', TEXT_PRIMARY);
    await expect(readContent).toHaveCSS('font-weight', '500');
    await expect(readRow).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0) 3px 0px 0px 0px inset');

    // Row hover background (.kh-doc-row:hover → --hover-row).
    await firstRow.hover();
    await expect(firstRow).toHaveCSS('background-color', HOVER_ROW);

    // Sidebar "Documentos" badge: amber pill, mono 10.5px (unread total > 0).
    const badge = page.getByTestId('sidebar-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveCSS('background-color', ACCENT_INK);
    await expect(badge).toHaveCSS('min-width', '18px');
    await expect(badge).toHaveCSS('height', '18px');
    await expect(badge).toHaveCSS('border-radius', '9px');
    await expect(badge).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(badge).toHaveCSS('font-size', '10.5px');

    await page.screenshot({ path: testInfo.outputPath('docs-table.png'), fullPage: true });
  });

});

// Story 7.5 restructured the DocsView main cell into a title + a 2-line-clamped
// description + a "ver recurso" resource link; Story 8.1 gave the title its own
// 2-line clamp (was single-line ellipsis) and replaced the text link with a
// 28×28 icon-button (.kh-doc-link). jsdom can't verify the clamp/typography/
// hover; this harness does (Epic 4 retro AI#6). Both tests run AFTER the 4.4
// dots test (which needs the seeded read/unread mix) and BEFORE the terminal
// mark-all mutation below.
test.describe('Story 7.6 — DocsView description + resource link', () => {
  test('first row: clamped title, clamped description, resource icon-button (AC2)', async ({
    page,
  }, testInfo) => {
    await gotoDocs(page);
    const firstRow = page.locator('.kh-doc-row').first();

    // Description: tertiary color, 2-line -webkit-box clamp. NOTE: with
    // -webkit-line-clamp engaged, Chromium reports the *computed* `display` as
    // `flow-root` (not `-webkit-box`) even though the specified/used value is
    // -webkit-box and the clamp works — so we assert the clamp via the
    // properties that DO compute meaningfully (line-clamp + box-orient +
    // overflow), which a non-clamped span would lack.
    const description = firstRow.getByTestId('doc-row-description');
    await expect(description).toHaveCSS('color', TEXT_TERTIARY);
    await expect(description).toHaveCSS('-webkit-line-clamp', '2');
    await expect(description).toHaveCSS('-webkit-box-orient', 'vertical');
    await expect(description).toHaveCSS('overflow-x', 'hidden');
    // overflow-y is the axis the 2-line clamp needs to hide the 3rd+ line; without
    // it the clamp is inert, so assert it too (not just overflow-x).
    await expect(description).toHaveCSS('overflow-y', 'hidden');

    // Title: same 2-line clamp set as the description — never assert `display`
    // on a line-clamped element (see the note above).
    const title = firstRow.getByTestId('doc-row-content');
    await expect(title).toHaveCSS('-webkit-line-clamp', '2');
    await expect(title).toHaveCSS('-webkit-box-orient', 'vertical');
    await expect(title).toHaveCSS('overflow-x', 'hidden');
    await expect(title).toHaveCSS('overflow-y', 'hidden');

    // Resource icon-button: seed href, new tab, 28×28 geometry, base muted
    // color, hover amber (color AND border-color — the border-color hover is
    // the D2 cascade guard: base border/color live in .kh-doc-link, not inline,
    // Epic 4 retro AI#4).
    const resourceLink = firstRow.locator('.kh-doc-link');
    await expect(resourceLink).toHaveAttribute('href', FIRST_DOC_RESOURCE_LINK);
    await expect(resourceLink).toHaveAttribute('target', '_blank');
    await expect(resourceLink).toHaveCSS('width', '28px');
    await expect(resourceLink).toHaveCSS('height', '28px');
    await expect(resourceLink).toHaveCSS('border-radius', '8px');
    await expect(resourceLink).toHaveCSS('color', TEXT_MUTED);
    await resourceLink.hover();
    await expect(resourceLink).toHaveCSS('color', ACCENT_INK);
    await expect(resourceLink).toHaveCSS('border-top-color', ACCENT_INK);

    await page.screenshot({ path: testInfo.outputPath('docs-resource.png'), fullPage: true });
  });

  // MUTATING — clicking the "ver recurso" icon-button on an UNREAD row bubbles
  // to handleRowClick (the anchor has no stopPropagation, 7.5 F2, verbatim
  // under the 8.1 icon-button) and flips the row read. Ordered before the
  // terminal mark-all so the file's last mutation stays mark-all. The external
  // host is route-blocked so the target="_blank" popup never egresses.
  test('"ver recurso" bubbles to mark the row read (AC3)', async ({ page }, testInfo) => {
    await gotoDocs(page);

    // Block the resource host so the popup opens but never hits the network.
    await page.context().route('https://example.com/**', (route) => route.abort());

    // Anchor on the resource href (STABLE), not on [data-read="false"] — that
    // filter re-evaluates after the flip and would follow onto a DIFFERENT still-
    // unread row, so the assertion would never see 'true'.
    const firstUnread = page.locator('.kh-doc-row[data-read="false"]').first();
    await expect(firstUnread).toBeVisible();
    const href = await firstUnread.locator('.kh-doc-link').getAttribute('href');
    const row = page.locator('.kh-doc-row', {
      has: page.locator(`.kh-doc-link[href="${href}"]`),
    });
    await expect(row).toHaveAttribute('data-read', 'false');

    // Capture the popup BEFORE the click, then close it — the mark-read is driven
    // by the bubbled click on the SPA page, independent of the popup.
    const popupPromise = page.waitForEvent('popup');
    await row.locator('.kh-doc-link').click();
    const popup = await popupPromise;
    await popup.close();

    // The optimistic handleRowClick flips data-read synchronously on the same click.
    await expect(row).toHaveAttribute('data-read', 'true');

    await page.screenshot({ path: testInfo.outputPath('docs-bubble-read.png'), fullPage: true });
  });
});

// MUTATING — marks every fragment read for the member; the TERMINAL mutation of
// this file. Moved into its own describe (7.6) so the bubbling test can flip one
// row before it while mark-all stays last. No later spec reads user_read_status.
test.describe('Story 4.4 — mark all read (mutating, terminal)', () => {
  test('all-read empty state + badge disappearance (4.4)', async ({ page }, testInfo) => {
    await gotoDocs(page);

    await page.getByRole('button', { name: 'Marcar todas como leídas' }).click();
    // After mark-all the count refreshes to 0 and the sidebar badge unmounts.
    await expect(page.getByTestId('sidebar-badge')).toHaveCount(0);

    // Toggle the "Sin leer" filter → the all-read empty state.
    await page.getByRole('button', { name: /Sin leer/ }).click();

    const empty = page.getByTestId('docs-empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveCSS('border-style', 'dashed');
    await expect(empty).toHaveCSS('border-width', '1px');
    await expect(empty).toHaveCSS('border-color', BORDER_STRONG);

    // Green check-circle: 38px round, positive color on a tinted background.
    const check = empty.getByTestId('docs-empty-state-check');
    await expect(check).toHaveCSS('width', '38px');
    await expect(check).toHaveCSS('height', '38px');
    await expect(check).toHaveCSS('border-radius', '50%');
    await expect(check).toHaveCSS('color', 'rgb(59, 165, 93)');
    await expect(check).toHaveCSS('background-color', 'rgba(59, 165, 93, 0.12)');

    await expect(empty.getByText('¡Estás al día! No te quedan fuentes sin leer.')).toBeVisible();
    await expect(
      empty.getByText('Quitá el filtro "Sin leer" para ver todo el conocimiento indexado.'),
    ).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('docs-all-read.png'), fullPage: true });
  });
});
