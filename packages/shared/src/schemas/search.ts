// Search API contract (AD-6). Request/response shapes for GET /api/search plus the
// stable error codes the search endpoint emits. Kept in shared so the web app can
// reference them via z.infer / the SEARCH_ERROR map instead of hardcoding strings.
// Mirrors auth.ts.
import { z } from 'zod';

import { isHttpUrl, LINK_REFINE_MESSAGE } from './linkRefine.js';

/** Upper bound on the raw query string. A search query is natural language; this
 * caps the text forwarded to the (paid) embeddings provider, closing a cost/DoS
 * vector on the authenticated endpoint while staying well above any real query. */
export const SEARCH_QUERY_MAX_LENGTH = 1000;

/**
 * GET /api/search query params. Query params arrive as strings, so `limit` is
 * coerced. `q` is trimmed and must be non-blank (a blank/whitespace-only query is
 * a 400, AC4) and no longer than `SEARCH_QUERY_MAX_LENGTH`. `limit` defaults to 5
 * (api-spec) and is hard-capped at 50 — there is no `knowledge.topK` in config,
 * so the cap lives here (Dev Notes: Config).
 */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * A single search result fragment: one curated resource link projected to its
 * anchor message (`message_ids[0]`). `title`/`description` are AI-generated
 * (Story 7.2); `title` is non-empty (Story 7.5 — the enrichment pipeline
 * treats an empty result as failure). `link` must be a valid HTTP(S) URL
 * (Story 7.4 — strict, no more empty-string placeholder). `authorName` falls
 * back to the `authorId` string — no display name is persisted yet (D2
 * follow-up). `similarity` is cosine similarity clamped to [0,1] (1 = identical).
 */
export const SearchFragmentSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  description: z.string(),
  link: z.string().refine(isHttpUrl, { message: LINK_REFINE_MESSAGE }),
  channelId: z.string(),
  channelName: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(), // ISO 8601
  similarity: z.number().min(0).max(1),
  messageId: z.string(),
});

export type SearchFragment = z.infer<typeof SearchFragmentSchema>;

/** GET /api/search — the ordered list of matching fragments (may be empty). */
export const SearchResponseSchema = z.object({
  results: z.array(SearchFragmentSchema),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** Stable error `code`s emitted by the search endpoint (paired with ErrorSchema). */
export const SEARCH_ERROR = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL: 'INTERNAL',
} as const;

export type SearchErrorCode = (typeof SEARCH_ERROR)[keyof typeof SEARCH_ERROR];
