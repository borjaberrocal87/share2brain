// Extends the Playwright visual harness (Story 4.5 pattern, followed by 5.3/5.4/
// 7.6) to the Estadísticas view (Story 9.2). This file sorts ALPHABETICALLY
// BEFORE every mutating spec (chat.spec.ts persists a conversation; docs.spec.ts
// marks all read), so every assertion below binds to seed-fresh figures
// (coverage 2/5/40%, queries 1) identically in a standalone run and a full-suite
// run — see tests/README.md for the ordering invariant. All 7 tests here are
// non-mutating (logins only); no later spec is affected.
//
// Story 9.2 rendered the Estadísticas view but explicitly deferred the computed-
// style verification (jsdom resolves no CSS custom properties) to this story —
// see the story's Dev Notes for the full traceability mapping.
import { expect, test } from '@playwright/test';

import { loginAs } from './helpers/session';

// Dark-theme computed tokens (see global.css :root, dark block).
const ACCENT_INK = 'rgb(245, 166, 35)'; // --accent-ink #F5A623
const TEXT_PRIMARY = 'rgb(230, 233, 239)'; // --tx #E6E9EF
const TEXT_SECONDARY = 'rgb(199, 205, 216)'; // --tx2 #C7CDD8
const TEXT_TERTIARY = 'rgb(154, 163, 178)'; // --tx3 #9AA3B2
const TEXT_MUTED = 'rgb(124, 132, 148)'; // --tx4 #7C8494
const SURFACE = 'rgb(18, 22, 29)'; // --surface #12161D
const BORDER = 'rgb(32, 38, 47)'; // --border #20262F
const TRACK = 'rgb(34, 41, 52)'; // --track #222934

test.describe('Story 9.3 — Estadísticas visual harness', () => {
  test('nav entry + active state + view mounts (AC2)', async ({ page }, testInfo) => {
    await loginAs(page, 'e2e-member');

    const navItems = page.locator('.kh-nav-item');
    await expect(navItems).toHaveCount(3);

    const statsNav = navItems.nth(2);
    await expect(statsNav).toHaveAccessibleName('Estadísticas');
    await expect(statsNav.locator('svg')).toHaveAttribute('width', '18');

    await statsNav.click();
    await expect(statsNav).toHaveAttribute('aria-current', 'page');
    await expect(statsNav).toHaveCSS('background-color', 'rgba(245, 166, 35, 0.12)');
    await expect(statsNav).toHaveCSS('color', ACCENT_INK);

    const heading = page.getByRole('heading', { name: 'Estadísticas' });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS('font-family', /Space Grotesk/);
    await expect(heading).toHaveCSS('font-weight', '600');
    await expect(heading).toHaveCSS('font-size', '25px');
    await expect(heading).toHaveCSS('color', TEXT_PRIMARY);

    const intro = page.getByText(
      'El pulso del conocimiento de la comunidad: qué se indexa, quién participa y cuánto se consulta al agente.',
    );
    await expect(intro).toHaveCSS('font-size', '14px');
    await expect(intro).toHaveCSS('color', TEXT_TERTIARY);

    const inner = heading.locator('..');
    await expect(inner).toHaveCSS('max-width', '1040px');

    await page.screenshot({ path: testInfo.outputPath('analytics-nav.png'), fullPage: true });
  });

  test('KPI cards render seed-exact content + design truth (AC3)', async ({ page }, testInfo) => {
    await loginAs(page, 'e2e-member');
    await page.getByRole('button', { name: 'Estadísticas' }).click();

    const cards = page.getByTestId('stats-kpi-card');
    await expect(cards).toHaveCount(4);

    const order = ['resources', 'channels', 'authors', 'queries'] as const;
    for (const [i, key] of order.entries()) {
      await expect(cards.nth(i)).toHaveAttribute('data-kpi', key);
    }

    await expect(cards.nth(0).getByText('Recursos indexados')).toBeVisible();
    await expect(cards.nth(0).getByText('5', { exact: true })).toBeVisible();
    await expect(cards.nth(0).getByText('+0 esta semana')).toBeVisible();

    await expect(cards.nth(1).getByText('Canales')).toBeVisible();
    await expect(cards.nth(1).getByText('2', { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText('de 2 accesibles')).toBeVisible();

    await expect(cards.nth(2).getByText('Autores')).toBeVisible();
    await expect(cards.nth(2).getByText('2', { exact: true })).toBeVisible();
    await expect(cards.nth(2).getByText('en tus canales')).toBeVisible();

    await expect(cards.nth(3).getByText('Tus consultas al agente')).toBeVisible();
    await expect(cards.nth(3).getByText('1', { exact: true })).toBeVisible();
    await expect(cards.nth(3).getByText('últimos 30 días')).toBeVisible();

    // Design truth on the resources card: value typography + icon chip + card chrome.
    const value = cards.nth(0).getByText('5', { exact: true });
    await expect(value).toHaveCSS('font-family', /Space Grotesk/);
    await expect(value).toHaveCSS('font-weight', '700');
    await expect(value).toHaveCSS('font-size', '29px');
    await expect(value).toHaveCSS('color', TEXT_PRIMARY);

    const iconChip = cards.nth(0).locator('svg').locator('..');
    await expect(iconChip).toHaveCSS('width', '32px');
    await expect(iconChip).toHaveCSS('height', '32px');
    await expect(iconChip).toHaveCSS('border-radius', '9px');
    await expect(iconChip).toHaveCSS('color', ACCENT_INK);
    await expect(iconChip).toHaveCSS('background-color', 'rgba(245, 166, 35, 0.12)');

    await expect(cards.nth(0)).toHaveCSS('background-color', SURFACE);
    await expect(cards.nth(0)).toHaveCSS('border-color', BORDER);

    await page.screenshot({ path: testInfo.outputPath('analytics-kpis.png'), fullPage: true });
  });

  test('activity chart renders 14 zero-stub bars with the today gradient (AC4)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');
    await page.getByRole('button', { name: 'Estadísticas' }).click();

    const chart = page.getByTestId('stats-activity-chart');
    await expect(chart).toBeVisible();

    const bars = page.getByTestId('stats-activity-bar');
    await expect(bars).toHaveCount(14);

    // D5: every bar is a 4px min-height stub — the June seed dates sit outside
    // the 14-day window. A leak on the D3 canary would make the last one tall.
    for (let i = 0; i < 14; i++) {
      await expect(bars.nth(i).locator('div')).toHaveCSS('height', '4px');
    }

    // Chromium quirk (7.6 precedent): 180deg is the linear-gradient default
    // direction ("to bottom"), so the computed serialization drops it entirely
    // rather than echoing it back — verified live, asserting the colors (the
    // meaningful property) instead of deleting the check.
    const lastFill = bars.nth(13).locator('div');
    await expect(lastFill).toHaveCSS(
      'background-image',
      /linear-gradient\(rgb\(255, 203, 107\), rgb\(245, 166, 35\)\)/,
    );
    const otherFill = bars.nth(0).locator('div');
    await expect(otherFill).toHaveCSS('background-color', TRACK);

    const barArea = bars.first().locator('..');
    await expect(barArea).toHaveCSS('height', '180px');

    const total = page.getByTestId('stats-activity-total');
    await expect(total).toHaveText('0 recursos · últimos 14 días');
    await expect(total).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(total).toHaveCSS('font-size', '11.5px');
    await expect(total).toHaveCSS('color', TEXT_MUTED);

    await expect(chart.getByText('hace 14 días')).toBeVisible();
    await expect(chart.getByText('hoy')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('analytics-activity.png'), fullPage: true });
  });

  test('channels + coverage donut render seed-exact figures (AC5)', async ({ page }, testInfo) => {
    await loginAs(page, 'e2e-member');
    await page.getByRole('button', { name: 'Estadísticas' }).click();

    const rows = page.getByTestId('stats-channel-row');
    await expect(rows).toHaveCount(2);

    const first = rows.nth(0);
    const firstName = first.getByText('#general', { exact: true });
    await expect(firstName).toBeVisible();
    await expect(first.getByText('3', { exact: true })).toBeVisible();
    await expect(firstName).toHaveCSS('font-family', /IBM Plex Mono/);
    await expect(firstName).toHaveCSS('font-size', '12.5px');
    await expect(firstName).toHaveCSS('color', ACCENT_INK);

    const firstFill = first.locator('div div').last();
    await expect(firstFill).toHaveAttribute('style', /width: 100%/);
    await expect(firstFill).toHaveCSS(
      'background-image',
      /linear-gradient\(90deg, rgb\(245, 166, 35\), rgb\(255, 203, 107\)\)/,
    );
    const firstTrack = firstFill.locator('..');
    await expect(firstTrack).toHaveCSS('height', '9px');
    await expect(firstTrack).toHaveCSS('background-color', TRACK);

    const second = rows.nth(1);
    await expect(second.getByText('#random', { exact: true })).toBeVisible();
    await expect(second.getByText('2', { exact: true })).toBeVisible();
    const secondFill = second.locator('div div').last();
    await expect(secondFill).toHaveAttribute('style', /; width: 67%/);

    // Coverage donut.
    const donut = page.getByTestId('stats-coverage-donut');
    await expect(donut).toHaveCSS('width', '120px');
    await expect(donut).toHaveCSS('height', '120px');
    await expect(donut).toHaveCSS(
      'background-image',
      /conic-gradient\(rgb\(245, 166, 35\) 40%/,
    );

    const donutCenter = donut.getByText('40%', { exact: true });
    await expect(donutCenter).toBeVisible();
    await expect(donutCenter).toHaveCSS('font-family', /Space Grotesk/);
    await expect(donutCenter).toHaveCSS('font-weight', '700');
    await expect(donutCenter).toHaveCSS('font-size', '23px');
    await expect(donut.getByText('leído')).toBeVisible();

    const legend = page.getByTestId('stats-coverage-legend');
    const readRow = legend.locator('div').first();
    const unreadRow = legend.locator('div').last();
    await expect(readRow.getByText('Leídos · 2')).toBeVisible();
    await expect(unreadRow.getByText('Sin leer · 3')).toBeVisible();
    await expect(readRow).toHaveCSS('font-size', '13px');
    await expect(readRow).toHaveCSS('color', TEXT_SECONDARY);

    const readSwatch = readRow.locator('span').first();
    await expect(readSwatch).toHaveCSS('width', '11px');
    await expect(readSwatch).toHaveCSS('height', '11px');
    await expect(readSwatch).toHaveCSS('border-radius', '3px');
    await expect(readSwatch).toHaveCSS('background-color', ACCENT_INK);

    const unreadSwatch = unreadRow.locator('span').first();
    await expect(unreadSwatch).toHaveCSS('background-color', TRACK);

    await expect(page.getByText('5 documentos en total')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('analytics-channels-coverage.png'), fullPage: true });
  });

  test('top users render seed-exact order + RBAC absence canaries (AC6)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');
    await page.getByRole('button', { name: 'Estadísticas' }).click();

    const rows = page.getByTestId('stats-top-user-row');
    await expect(rows).toHaveCount(2);

    const first = rows.nth(0);
    await expect(first.getByText('1', { exact: true })).toBeVisible();
    await expect(first.getByText('AL', { exact: true })).toBeVisible();
    await expect(first.getByText('Ada Lovelace')).toBeVisible();
    await expect(first.getByText('3', { exact: true })).toBeVisible();

    const firstAvatar = first.getByText('AL', { exact: true });
    await expect(firstAvatar).toHaveCSS('width', '30px');
    await expect(firstAvatar).toHaveCSS('height', '30px');
    await expect(firstAvatar).toHaveCSS('border-radius', '50%');
    await expect(firstAvatar).toHaveCSS('background-color', 'rgb(245, 166, 35)');

    const firstFill = first.locator('div div').last();
    await expect(firstFill).toHaveAttribute('style', /width: 100%/);
    await expect(firstFill).toHaveCSS(
      'background-image',
      /linear-gradient\(90deg, rgb\(88, 101, 242\), rgb\(136, 145, 245\)\)/,
    );
    const firstTrack = firstFill.locator('..');
    await expect(firstTrack).toHaveCSS('height', '7px');
    await expect(firstTrack).toHaveCSS('background-color', TRACK);

    const second = rows.nth(1);
    await expect(second.getByText('LT', { exact: true })).toBeVisible();
    await expect(second.getByText('Linus Torvalds')).toBeVisible();
    const secondRankAndCount = second.getByText('2', { exact: true });
    await expect(secondRankAndCount).toHaveCount(2); // rank '2' + count '2'

    const secondAvatar = second.getByText('LT', { exact: true });
    await expect(secondAvatar).toHaveCSS('background-color', 'rgb(199, 146, 234)');

    const secondFill = second.locator('div div').last();
    await expect(secondFill).toHaveAttribute('style', /; width: 67%/);

    // D3 RBAC leak canaries — the denied channel/author must appear NOWHERE.
    await expect(page.getByText('#secreto')).toHaveCount(0);
    await expect(page.getByText('Eve Intrusa')).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath('analytics-top-users.png'), fullPage: true });
  });

  test('error state renders on a malformed /api/stats response (AC7a)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');

    await page.route('**/api/stats', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );

    await page.getByRole('button', { name: 'Estadísticas' }).click();

    const error = page.getByTestId('stats-error');
    await expect(error).toHaveText('No se pudieron cargar las estadísticas. Reintentá.');

    await page.screenshot({ path: testInfo.outputPath('analytics-error.png'), fullPage: true });
  });

  test('empty scope renders all-zero figures (AC7b)', async ({ page }, testInfo) => {
    await loginAs(page, 'e2e-empty');
    await page.getByRole('button', { name: 'Estadísticas' }).click();

    const cards = page.getByTestId('stats-kpi-card');
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(0).getByText('0', { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText('0', { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText('de 1 accesibles')).toBeVisible();
    await expect(cards.nth(2).getByText('0', { exact: true })).toBeVisible();
    await expect(cards.nth(3).getByText('0', { exact: true })).toBeVisible();

    const bars = page.getByTestId('stats-activity-bar');
    await expect(bars).toHaveCount(14);
    for (let i = 0; i < 14; i++) {
      await expect(bars.nth(i).locator('div')).toHaveCSS('height', '4px');
    }
    await expect(page.getByTestId('stats-activity-total')).toHaveText('0 recursos · últimos 14 días');

    await expect(page.getByTestId('stats-channels-empty')).toHaveText(
      'Sin datos en tus canales todavía.',
    );
    await expect(page.getByTestId('stats-top-users-empty')).toHaveText('Sin autores todavía.');

    const donut = page.getByTestId('stats-coverage-donut');
    await expect(donut.getByText('0%', { exact: true })).toBeVisible();
    await expect(page.getByText('0 documentos en total')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('analytics-empty.png'), fullPage: true });
  });
});
