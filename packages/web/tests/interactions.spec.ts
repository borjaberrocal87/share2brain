// Harness coverage for the pre-Epic-5 frontend-debt fixes (Epic 4 retro Action
// Items #4 and #5), verified against the REAL global CSS via getComputedStyle:
//   #4 — the inline-`border`-shorthand-vs-:hover cascade on result cards + chips
//        (the same class of bug the 4.5 harness caught on .kh-search-input:focus).
//   #5 — prefers-reduced-motion neutralising the kh-* animations.
// Dark theme is forced by loginAs, so tokens resolve to their dark values.
import { expect, test } from '@playwright/test';

import { loginAs } from './helpers/session';

const BORDER = 'rgb(32, 38, 47)'; // --border #20262F
const BORDER_HOVER = 'rgb(58, 66, 80)'; // --border-hover #3A4250
const CHIP_ACTIVE_BORDER = 'rgba(245, 166, 35, 0.45)'; // active chip amber border

test.describe('Frontend-debt fixes (Epic 4 retro AI#4/#5)', () => {
  test('result card + inactive chip border-color changes on :hover; active chip beats :hover (AI#4)', async ({
    page,
  }, testInfo) => {
    await loginAs(page, 'e2e-member');
    await page.locator('.kh-search-input').fill('hivly');

    // Result card: base --border at rest, --border-hover on hover (previously the
    // inline `border` shorthand pinned it and the :hover rule never applied).
    const card = page.locator('.kh-result-card').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS('border-color', BORDER);
    await card.hover();
    await expect(card).toHaveCSS('border-color', BORDER_HOVER);

    // Inactive chip (#general): same fix — hover flips border-color.
    const inactiveChip = page.getByRole('button', { name: '#general' });
    await expect(inactiveChip).toHaveCSS('border-color', BORDER);
    await inactiveChip.hover();
    await expect(inactiveChip).toHaveCSS('border-color', BORDER_HOVER);

    // Active chip (todos) keeps its amber border inline ON PURPOSE, so :hover does
    // NOT override it (mirrors .kh-nav-item--active).
    const activeChip = page.getByRole('button', { name: 'todos' });
    await activeChip.hover();
    await expect(activeChip).toHaveCSS('border-color', CHIP_ACTIVE_BORDER);

    await page.screenshot({ path: testInfo.outputPath('hover-states.png'), fullPage: true });
  });

  test('prefers-reduced-motion collapses the kh-* animations (AI#5)', async ({ page }) => {
    await loginAs(page, 'e2e-member');
    const dot = page.getByTestId('live-pulse'); // header "indexando en vivo" pulse (kh-pulse 1.6s)
    await expect(dot).toBeVisible();

    // No preference: the animation runs at its authored duration.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(dot).toHaveCSS('animation-duration', '1.6s');

    // Reduce: the global reset (global.css) collapses it toward zero.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await dot.evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(reduced)).toBeLessThan(0.1);
  });
});
