// THROWAWAY SPIKE — exercises the Story 3.0 provider factory against the REAL
// embeddings endpoint configured in Hivly.config.yml + .env.
//
// Unlike spike/embeddings.ts (stale: raw fetch + removed knowledge.embedding_model),
// this drives the ACTUAL production code path:
//   loadConfig() → createEmbeddingsModel(config.embeddings) → model.embedQuery()
//                → assertEmbeddingDimensions(vec, config.embeddings.dimensions)
//
// Run:  npx tsx --env-file=.env spike/embeddings-factory.ts

import { loadConfig } from '@hivly/shared';
import { assertEmbeddingDimensions, createEmbeddingsModel } from '@hivly/shared/providers';

const config = loadConfig();
const { provider, model, dimensions, base_url } = config.embeddings;
const input = "Hivly indexes a Discord community's knowledge and answers questions with verifiable sources.";

console.log(`[spike] provider=${provider} · model=${model} · expecting ${dimensions} dims`);
console.log(`[spike] base_url=${base_url ?? '(default OpenAI)'}`);

const embeddings = createEmbeddingsModel(config.embeddings);

const t0 = performance.now();
const vec = await embeddings.embedQuery(input);
const ms = Math.round(performance.now() - t0);

console.log(`✓ embedQuery() returned in ${ms}ms · vector length = ${vec.length}`);
console.log(`  sample: [${vec.slice(0, 3).map((n) => n.toFixed(5)).join(', ')}, …]`);
const maxAbs = Math.max(...vec.map((n) => Math.abs(n)));
const norm = Math.sqrt(vec.reduce((s, n) => s + n * n, 0));
console.log(`  max|component|=${maxAbs.toFixed(5)} · L2 norm=${norm.toFixed(5)}`);

assertEmbeddingDimensions(vec, dimensions);
console.log(`\n✅ Embeddings VALIDATED via factory (auth + model + ${dimensions} dims).`);
