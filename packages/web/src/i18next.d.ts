// Typed translation keys (Story 10.2, D8). The `{ translation: ... }` wrapper is
// load-bearing: `resources` maps namespace → keys, so passing the JSON type
// directly would make each top-level section its own namespace and
// `defaultNS: 'translation'` would fail to typecheck (TS2344).
import 'i18next';

import type es from './locales/es.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof es;
    };
  }
}
