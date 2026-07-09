// Retroactive visual verification of Story 4.4 (Documentos) via getComputedStyle
// against the REAL global CSS (Story 4.5). Dark theme is forced by loginAs. The
// mutating "mark all read" test runs LAST in this file; workers:1 + file order
// keep it isolated from the non-mutating tests and from search.spec.
import { expect, test } from '@playwright/test';

import { loginAs } from './helpers/session';

// Dark-theme computed tokens (see global.css :root).
const ACCENT_INK = 'rgb(245, 166, 35)'; // --accent-ink #F5A623
const DOT_READ = 'rgb(39, 46, 57)'; // --dot-read #272E39
const HOVER_ROW = 'rgb(20, 25, 34)'; // --hover-row #141922
const TEXT_PRIMARY = 'rgb(230, 233, 239)'; // --text-primary #E6E9EF
const TEXT_MUTED = 'rgb(124, 132, 148)'; // --text-muted #7C8494
const TEXT_SUBTLE = 'rgb(100, 108, 124)'; // --text-subtle #646C7C
const BORDER_STRONG = 'rgb(42, 49, 61)'; // --border-strong #2A313D

async function gotoDocs(page: import('@playwright/test').Page): Promise<void> {
  await loginAs(page, 'e2e-member');
  await page.getByRole('button', { name: /Documentos/ }).click();
  await expect(page.locator('.kh-doc-row').first()).toBeVisible();
}

test.describe('Story 4.4 — Documentos (retroactive visual verification)', () => {
  test('grid, header cells, read/unread dots, row hover, and sidebar badge (4.4)', async ({
    page,
  }, testInfo) => {
    await gotoDocs(page);

    // Table grid: 1fr resolves to px in Chromium; the three fixed tracks stay.
    const firstRow = page.locator('.kh-doc-row').first();
    await expect(firstRow).toHaveCSS(
      'grid-template-columns',
      /^\d+(\.\d+)?px 130px 130px 96px$/,
    );

    // Header cells (source lowercase, uppercased by CSS): mono, 10.5px, uppercase, subtle.
    const header = page.getByText('recurso', { exact: true });
    await expect(header).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(header).toHaveCSS('font-size', '10.5px');
    await expect(header).toHaveCSS('text-transform', 'uppercase');
    await expect(header).toHaveCSS('color', TEXT_SUBTLE);

    // Unread row: amber dot + glow; primary-color content, weight 500.
    const unreadRow = page.locator('.kh-doc-row[data-read="false"]').first();
    const unreadDot = unreadRow.getByTestId('doc-row-dot');
    await expect(unreadDot).toHaveCSS('background-color', ACCENT_INK);
    await expect(unreadDot).toHaveCSS('box-shadow', 'rgba(245, 166, 35, 0.16) 0px 0px 0px 3px');
    const unreadContent = unreadRow.getByTestId('doc-row-content');
    await expect(unreadContent).toHaveCSS('color', TEXT_PRIMARY);
    await expect(unreadContent).toHaveCSS('font-weight', '500');

    // Read row: grey dot, no shadow; muted content, weight 400.
    const readRow = page.locator('.kh-doc-row[data-read="true"]').first();
    const readDot = readRow.getByTestId('doc-row-dot');
    await expect(readDot).toHaveCSS('background-color', DOT_READ);
    await expect(readDot).toHaveCSS('box-shadow', 'none');
    const readContent = readRow.getByTestId('doc-row-content');
    await expect(readContent).toHaveCSS('color', TEXT_MUTED);
    await expect(readContent).toHaveCSS('font-weight', '400');

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

  // MUTATING — marks every fragment read for the member; runs LAST in this file.
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
