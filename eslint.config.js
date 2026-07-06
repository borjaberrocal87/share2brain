// ESLint 9 flat config — machine-enforces AD-2: services never import each other.
// Only @hivly/shared is a legal cross-package dependency.
import tseslint from 'typescript-eslint';

const SIBLING_SERVICES = ['@hivly/bot', '@hivly/backend', '@hivly/workers', '@hivly/web'];

// Bans importing any sibling service from within `self`'s package. @hivly/shared
// stays allowed everywhere because it is never listed in the banned group.
const SIBLING_IMPORT_BAN = {
  group: SIBLING_SERVICES.flatMap((s) => [s, `${s}/**`]),
  message: 'Services must not import each other (AD-2). Only @hivly/shared is shared.',
};

const banSiblingServices = (self) => ({
  files: [`packages/${self}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': ['error', { patterns: [SIBLING_IMPORT_BAN] }],
  },
});

// @hivly/web is a browser bundle (AD-3). It must import ONLY browser-safe
// @hivly/shared entrypoints: `/schemas` (zod only) and `/types/events` (pure types).
// The root barrel and `/db` re-export the Drizzle client and pull `pg` + Node
// built-ins into the bundle; `/config` needs `node:fs`. Banning them keeps the SPA
// free of server-only deps (Epic 1 retrospective action item #3). This block
// REPLACES banSiblingServices('web') — a later flat-config object wins the whole
// `no-restricted-imports` option, so the sibling ban is folded back in here.
const WEB_BROWSER_SAFE_MESSAGE =
  'Web is a browser bundle (AD-3): import only @hivly/shared/schemas or @hivly/shared/types/events. The root barrel and /db pull in `pg`; /config needs Node.';

const banNonBrowserSafeSharedInWeb = {
  files: ['packages/web/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        // `paths` = exact module id; the root barrel re-exports the Drizzle client (pg).
        // gitignore-style `patterns` would also swallow /schemas, so ban root here precisely.
        paths: [{ name: '@hivly/shared', message: WEB_BROWSER_SAFE_MESSAGE }],
        // `patterns` = gitignore-style; `/db` + `/config` (and their descendants) are Node-only.
        patterns: [
          SIBLING_IMPORT_BAN,
          {
            group: ['@hivly/shared/db', '@hivly/shared/config', '@hivly/shared/providers'],
            message: WEB_BROWSER_SAFE_MESSAGE,
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '_bmad/**',
      '_bmad-output/**',
      'docs/**',
      '.claude/**',
      '.agents/**',
      '.opencode/**',
    ],
  },
  ...tseslint.configs.recommended,
  banSiblingServices('bot'),
  banSiblingServices('backend'),
  banSiblingServices('workers'),
  banNonBrowserSafeSharedInWeb,
);
