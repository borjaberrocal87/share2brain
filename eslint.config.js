// ESLint 9 flat config — machine-enforces AD-2: services never import each other.
// Only @share2brain/shared is a legal cross-package dependency.
import tseslint from 'typescript-eslint';

const SIBLING_SERVICES = ['@share2brain/bot', '@share2brain/backend', '@share2brain/workers', '@share2brain/web'];

// Bans importing any sibling service from within `self`'s package. @share2brain/shared
// stays allowed everywhere because it is never listed in the banned group.
const SIBLING_IMPORT_BAN = {
  group: SIBLING_SERVICES.flatMap((s) => [s, `${s}/**`]),
  message: 'Services must not import each other (AD-2). Only @share2brain/shared is shared.',
};

const banSiblingServices = (self) => ({
  files: [`packages/${self}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': ['error', { patterns: [SIBLING_IMPORT_BAN] }],
  },
});

// AD-11: no legacy LangChain APIs — the RAG agent is a LangGraph StateGraph.
// Folded into the same object as the sibling-service ban (not a separate flat-config
// entry) because a later object setting `no-restricted-imports` for backend files
// would clobber this whole option, silently dropping the sibling-import ban.
const LANGCHAIN_LEGACY_BAN = {
  group: ['langchain/chains', 'langchain/chains/**', 'langchain/memory', 'langchain/memory/**'],
  message:
    'Legacy LangChain APIs are banned (AD-11): use the LangGraph StateGraph, not langchain/chains or langchain/memory.',
};

const banBackendLegacyImports = {
  files: ['packages/backend/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [SIBLING_IMPORT_BAN, LANGCHAIN_LEGACY_BAN] }],
  },
};

// @share2brain/web is a browser bundle (AD-3). It must import ONLY browser-safe
// @share2brain/shared entrypoints: `/schemas` (zod only) and `/types/events` (pure types).
// The root barrel and `/db` re-export the Drizzle client and pull `pg` + Node
// built-ins into the bundle; `/config` needs `node:fs`. Banning them keeps the SPA
// free of server-only deps (Epic 1 retrospective action item #3). This block
// REPLACES banSiblingServices('web') — a later flat-config object wins the whole
// `no-restricted-imports` option, so the sibling ban is folded back in here.
const WEB_BROWSER_SAFE_MESSAGE =
  'Web is a browser bundle (AD-3): import only @share2brain/shared/schemas or @share2brain/shared/types/events. The root barrel and /db pull in `pg`; /config needs Node.';

const banNonBrowserSafeSharedInWeb = {
  files: ['packages/web/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        // `paths` = exact module id; the root barrel re-exports the Drizzle client (pg).
        // gitignore-style `patterns` would also swallow /schemas, so ban root here precisely.
        paths: [{ name: '@share2brain/shared', message: WEB_BROWSER_SAFE_MESSAGE }],
        // `patterns` = gitignore-style; `/db` + `/config` (and their descendants) are Node-only.
        patterns: [
          SIBLING_IMPORT_BAN,
          {
            group: ['@share2brain/shared/db', '@share2brain/shared/config', '@share2brain/shared/providers'],
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
  banBackendLegacyImports,
  banSiblingServices('workers'),
  banNonBrowserSafeSharedInWeb,
);
