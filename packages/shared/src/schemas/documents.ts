// Documents API contract (AD-6). Request/response shapes for GET /api/documents plus the
// stable error codes the endpoint emits. Mirrors search.ts.
import { z } from 'zod';

/**
 * GET /api/documents query params. Query params arrive as strings, so `page`/`limit`
 * are coerced. `page` defaults to 1 (min 1); `limit` defaults to 20 (min 1, max 100).
 * `page` is capped (max 1_000_000) so a huge value can't overflow the Postgres `bigint`
 * OFFSET (`(page-1)*limit`) into a 500 — an out-of-range page yields a clean 400 instead.
 */
export const DocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type DocumentsQuery = z.infer<typeof DocumentsQuerySchema>;

/**
 * A single document fragment: `SearchFragment` minus `similarity`, plus `indexedAt`
 * and `isRead` (D3). `authorName` falls back to the `authorId` string (D2, carried
 * from search). `createdAt` is the anchor message date; `indexedAt` is
 * `embeddings.created_at`.
 */
export const DocumentFragmentSchema = z.object({
  id: z.uuid(),
  content: z.string(),
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
