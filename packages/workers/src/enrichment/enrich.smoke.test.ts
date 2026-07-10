// Env-gated real-LLM smoke test (standing DoD for any new LLM path — OPS-2).
// NOT part of CI: `describe.skipIf` keeps this a no-op in the normal `npm run
// test` run. Run it once locally against the real configured provider:
//
//   ENRICHMENT_SMOKE=1 npx vitest run packages/workers/src/enrichment/enrich.smoke.test.ts
//
// Loads `.env` itself (Node's built-in `process.loadEnvFile`) since local runs
// outside Docker Compose don't get it for free — falls back to whatever the
// shell already exported if the file load fails.
import { loadConfig } from '@share2brain/shared';
import { createChatModel } from '@share2brain/shared/providers';
import { describe, expect, it } from 'vitest';

import { enrich } from './enrich.js';

const RUN_SMOKE = process.env.ENRICHMENT_SMOKE === '1';

describe.skipIf(!RUN_SMOKE)('enrich — real LLM smoke', () => {
  it(
    'should produce a non-empty title/description in enrichment.language from the real configured provider',
    async () => {
      try {
        process.loadEnvFile('.env');
      } catch {
        // Already exported by the shell, or no .env present locally — proceed
        // with whatever is in process.env.
      }

      const config = loadConfig();
      const model = createChatModel(config.enrichment.llm);

      const result = await enrich(model, {
        messageText: 'Check out this great resource for learning TypeScript!',
        pageHints: null,
        language: config.enrichment.language,
      });

      expect(result.title.length).toBeGreaterThan(0);
      expect(result.description.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
