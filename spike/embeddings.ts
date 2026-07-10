// THROWAWAY SPIKE — Epic 3 external-integration validation (Story 3.3, embeddings API).
//
// Confirms, against the REAL embeddings service, before we build the Indexer:
//   1. OPENAI_API_KEY is valid,
//   2. the configured model (Share2Brain.config.yml → knowledge.embedding_model) returns a
//      vector of exactly 1536 dimensions — the pgvector column is vector(1536), so a
//      different model would silently break the schema,
//   3. round-trip latency (informs NFR budgets later).
//
// Raw fetch, no SDK — mirrors the Epic-2 (Story 2.3) "no heavy libs on the boundary"
// pattern. NOT production code — delete `spike/` once both integrations are green.
//
// Run:  npx tsx --env-file=.env spike/embeddings.ts

import { loadConfig } from '@share2brain/shared';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY || KEY.startsWith('sk-xxxx')) {
  console.error('✗ OPENAI_API_KEY is unset or still the placeholder. Put a real key in .env first.');
  process.exit(1);
}

const config = loadConfig();
const model = config.knowledge.embedding_model; // expected: text-embedding-3-small
const EXPECTED_DIMS = 1536;
const input = "Share2Brain indexes a Discord community's knowledge and answers questions with verifiable sources.";

console.log(`[spike] model=${model} · expecting ${EXPECTED_DIMS} dims`);

const t0 = performance.now();
const res = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model, input }),
  signal: AbortSignal.timeout(30_000),
});
const ms = Math.round(performance.now() - t0);

if (!res.ok) {
  const body = await res.text();
  console.error(`✗ Embeddings API ${res.status} ${res.statusText} (${ms}ms):`, body.slice(0, 400));
  process.exit(1);
}

const json = (await res.json()) as {
  model: string;
  data: { embedding: number[] }[];
  usage?: { total_tokens: number };
};
const vec = json.data?.[0]?.embedding;
if (!Array.isArray(vec)) {
  console.error('✗ No embedding array in the response:', JSON.stringify(json).slice(0, 400));
  process.exit(1);
}

console.log(`✓ HTTP 200 in ${ms}ms · returned model=${json.model} · tokens=${json.usage?.total_tokens ?? '?'}`);
console.log(
  `✓ vector length = ${vec.length} ` +
    (vec.length === EXPECTED_DIMS ? '(matches 1536 ✓)' : `⚠️  EXPECTED ${EXPECTED_DIMS}`),
);
console.log(`  sample: [${vec.slice(0, 3).map((n) => n.toFixed(5)).join(', ')}, …]`);

if (vec.length !== EXPECTED_DIMS) {
  console.error(`\n✗ Dimension mismatch — the pgvector column is vector(${EXPECTED_DIMS}); this model would break the schema.`);
  process.exit(1);
}

console.log('\n✅ Embeddings integration VALIDATED (auth + model + 1536 dims).');
