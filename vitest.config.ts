// Root Vitest config. Vitest 4 removed the standalone `vitest.workspace.ts`; the
// current idiom is `test.projects` here (Epic 1 retro action item #1).
//
//   npm run test              → unit project only (pure, no external services)
//   npm run test:integration  → backend-integration (needs postgres + redis up)
//
// Split so `npm run test` stays green in CI without infra; integration tests opt in.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Unit: every *.test.ts across packages, excluding integration specs.
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      // Integration: real Postgres + Redis. Own config in packages/backend.
      './packages/backend/vitest.config.ts',
    ],
  },
});
