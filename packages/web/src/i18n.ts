// i18n singleton (Story 10.2, D1). Resources are bundled at build time (no lazy
// loading, no Suspense — AD-3 static SPA), so init is effectively synchronous.
// Boot (main.tsx) awaits changeLanguage(<resolved language>) before the first
// render; the default here (`es`) only matters for code paths that read i18n
// before that resolves (e.g. tests via src/test-setup.ts).
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import es from './locales/es.json';

// No built-in `document.documentElement.lang` sync in i18next — stamp it
// manually. Registered before init() so it also fires for the initial load.
// Guarded: the root Vitest "unit" project runs plain *.test.ts files (like
// apiError.test.ts) under a node environment with no `document` global —
// only the "web" project (jsdom) has one.
i18n.on('languageChanged', (lng) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
});

void i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    en: { translation: en },
  },
  lng: 'es',
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
});

export default i18n;
