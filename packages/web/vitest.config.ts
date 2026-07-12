// Web unit-test project (Story 2.1). Runs in jsdom with the React plugin so
// .tsx components render under @testing-library/react. Registered in the root
// vitest.config.ts `test.projects` array and run by `npm run test`.
//
// Note: jsdom does NOT apply external stylesheets or resolve CSS custom
// properties from global.css, so the token/font/keyframe ACs are verified
// manually in the browser (see the story's completion notes) — not here.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    root: import.meta.dirname,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Story 10.2 (D10): real i18next `es` resources for every test via the
    // default instance, so useTranslation() works without a Provider and all
    // existing Spanish-literal assertions stay unmodified.
    setupFiles: ['./src/test-setup.ts'],
  },
});
