// Root Vitest config. Vitest 4 removed the standalone `vitest.workspace.ts`; the
// current idiom is `test.projects` here (Epic 1 retro action item #1).
//
//   npm run test              → unit + web projects (pure, no external services)
//   npm run test:integration  → backend-integration (needs postgres + redis up)
//
// Split so `npm run test` stays green in CI without infra; integration tests opt in.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Unit: every *.test.ts across packages (node env), excluding integration
        // specs. The web project owns .tsx component tests (jsdom) separately.
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      // Web: React component tests in jsdom. Own config in packages/web.
      './packages/web/vitest.config.ts',
      // Integration: real Postgres + Redis. Own config per producer service.
      './packages/backend/vitest.config.ts',
      './packages/bot/vitest.config.ts',
      './packages/workers/vitest.config.ts',
    ],
  },
});
