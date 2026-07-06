// Infrastructure adapter: LangChain-backed QueryEmbedder. The ONLY search file
// that imports the provider factory — LangChain stays behind this boundary and
// never leaks into the service/controller (AD-2 spirit). Uses the SAME factory
// Story 3.3 used for `.embedDocuments()`, which forces `encodingFormat: 'float'`
// to avoid the corrupt all-zero-vector bug found in Story 3.0.
import type { HivlyConfig } from '@hivly/shared';
import { assertEmbeddingDimensions, createEmbeddingsModel } from '@hivly/shared/providers';

import type { QueryEmbedder } from '../domain/repositories/queryEmbedder.js';

/**
 * Guard against degenerate query embeddings that pass the width check but poison
 * the pgvector query. `assertEmbeddingDimensions` only validates length, so:
 *  - a NON-FINITE component (NaN/Infinity) serializes to `null` via JSON.stringify,
 *    producing a malformed `::vector` literal → an opaque 500 on every search;
 *  - an ALL-ZERO vector yields a NaN cosine distance (`<=>`), so every row reports
 *    `similarity = 1.0` in arbitrary order — a silent garbage search, exactly the
 *    Story 3.0 corruption this adapter claims to guard against.
 * Fail loudly here instead. @throws {Error} on a non-finite or zero-magnitude vector.
 */
function assertUsableQueryVector(vector: number[]): void {
  // Exact any-non-zero test — NOT a summed magnitude. Summing squares would
  // underflow to 0 for a genuinely non-zero but tiny-magnitude vector
  // (e.g. [1e-200, 0, ...]) and falsely reject it as all-zero.
  let hasNonZero = false;
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new Error('Query embedding contains a non-finite component (NaN/Infinity) — refusing to search');
    }
    if (component !== 0) hasNonZero = true;
  }
  if (!hasNonZero) {
    throw new Error('Query embedding is an all-zero (degenerate) vector — refusing to search');
  }
}

export function createLangchainQueryEmbedder(
  embeddingsConfig: HivlyConfig['embeddings'],
): QueryEmbedder {
  // Build the model once; reuse across requests. No network I/O at construction.
  const model = createEmbeddingsModel(embeddingsConfig);
  const expectedDimensions = embeddingsConfig.dimensions;

  return {
    async embedQuery(text: string): Promise<number[]> {
      const vector = await model.embedQuery(text);
      // Fail loudly on a width mismatch instead of running a garbage search
      // against the fixed `vector(dimensions)` column (Story 3.0 safety net).
      assertEmbeddingDimensions(vector, expectedDimensions);
      // Length alone is not enough — also reject non-finite/all-zero vectors.
      assertUsableQueryVector(vector);
      return vector;
    },
  };
}
