// ESLint 9 flat config — machine-enforces AD-2: services never import each other.
// Only @hivly/shared is a legal cross-package dependency.
import tseslint from 'typescript-eslint';

const SIBLING_SERVICES = ['@hivly/bot', '@hivly/backend', '@hivly/workers', '@hivly/web'];

// Bans importing any sibling service from within `self`'s package. @hivly/shared
// stays allowed everywhere because it is never listed in the banned group.
const banSiblingServices = (self) => ({
  files: [`packages/${self}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: SIBLING_SERVICES.flatMap((s) => [s, `${s}/**`]),
            message:
              'Services must not import each other (AD-2). Only @hivly/shared is shared.',
          },
        ],
      },
    ],
  },
});

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
  banSiblingServices('web'),
);
