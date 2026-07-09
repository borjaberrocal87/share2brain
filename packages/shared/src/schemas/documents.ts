// Documents API contract (AD-6). Request/response shapes for GET /api/documents plus the
// stable error codes the endpoint emits. Mirrors search.ts.
import { z } from 'zod';

import { isHttpUrl, LINK_REFINE_MESSAGE } from './linkRefine.js';

/**
 * GET /api/documents query params. Query params arrive as strings, so `page`/`limit`
 * are coerced. `page` defaults to 1 (min 1); `limit` defaults to 20 (min 1, max 100).
 * `page` is capped (max 1_000_000) so a huge value can't overflow the Postgres `bigint`
 * OFFSET (`(page-1)*limit`) into a 500 — an out-of-range page yields a clean 400 instead.
 * `channelId` narrows the page to one channel (AD-12, applied inside the query — never
 * a post-filter); omitted means all allowed channels. `unreadOnly` restricts to fragments
 * the caller has not read; it uses `z.stringbool()` rather than `z.coerce.boolean()`
 * because `Boolean("false") === true` — coerce.boolean would wrongly parse `?unreadOnly=false`
 * as `true`.
 */
export const DocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  channelId: z.string().min(1).optional(),
  unreadOnly: z.stringbool().default(false),
});

export type DocumentsQuery = z.infer<typeof DocumentsQuerySchema>;

/**
 * A single document fragment: `SearchFragment` minus `similarity`, plus `indexedAt`
 * and `isRead` (D3). `title`/`description` are AI-generated (Story 7.2); `title`
 * is non-empty (Story 7.5 — the enrichment pipeline treats an empty result as
 * failure). `link` must be a valid HTTP(S) URL (Story 7.4 — strict, no more
 * empty-string placeholder). `authorName` falls back to the `authorId` string
 * (D2, carried from search). `createdAt` is the anchor message date; `indexedAt`
 * is `embeddings.created_at`.
 */
export const DocumentFragmentSchema = z.object({
  id: z.uuid(),
  // `trim().min(1)`: non-blank guarantee is structural — whitespace-only
  // titles are rejected, not just '' (code-review 7.5).
  title: z.string().trim().min(1),
  description: z.string(),
  link: z.string().refine(isHttpUrl, { message: LINK_REFINE_MESSAGE }),
  channelId: z.string(),
  channelName: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(), // ISO 8601
  indexedAt: z.string(), // ISO 8601
  messageId: z.string(),
  isRead: z.boolean(),
});

export type DocumentFragment = z.infer<typeof DocumentFragmentSchema>;

/** GET /api/documents — a paginated page of document fragments (D4). */
export const DocumentsResponseSchema = z.object({
  results: z.array(DocumentFragmentSchema),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
});

export type DocumentsResponse = z.infer<typeof DocumentsResponseSchema>;

/** Stable error `code`s emitted by the documents endpoint (paired with ErrorSchema). */
export const DOCUMENTS_ERROR = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL: 'INTERNAL',
} as const;

export type DocumentsErrorCode = (typeof DOCUMENTS_ERROR)[keyof typeof DOCUMENTS_ERROR];
