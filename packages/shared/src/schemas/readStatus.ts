// Read-status API contract (AD-6). Request/response shapes for the
// POST/DELETE /api/read-status/:embeddingId, POST /api/read-status/mark-all, and
// GET /api/read-status/unread-count endpoints, plus the stable error codes they emit.
import { z } from 'zod';

/** Route param validation for the per-embedding read-status endpoints (D5). */
export const EmbeddingIdParamSchema = z.object({
  embeddingId: z.uuid(),
});

export type EmbeddingIdParam = z.infer<typeof EmbeddingIdParamSchema>;

/**
 * POST /api/read-status/mark-all body. `channelId` is optional (D6): present ⇒
 * mark that channel (must be in `allowedChannelIds`, else 403); absent (omitted) ⇒
 * mark every visible fragment across all `allowedChannelIds`. Only `string` or
 * omitted is accepted — an explicit `null` is a validation error (not a wire value).
 */
export const MarkAllRequestSchema = z.object({
  // max(32): a Discord snowflake is ≤20 digits; cap the only otherwise-unbounded
  // string input so an oversized body can't reach the SQL comparison (S-7).
  channelId: z.string().min(1).max(32).optional(),
});

export type MarkAllRequest = z.infer<typeof MarkAllRequestSchema>;

/** POST /api/read-status/mark-all response — count of newly inserted rows. */
export const MarkAllResponseSchema = z.object({
  markedCount: z.number().int().nonnegative(),
});

export type MarkAllResponse = z.infer<typeof MarkAllResponseSchema>;

/** GET /api/read-status/unread-count response — a bare per-channel map (D7). */
export const UnreadCountResponseSchema = z.record(z.string(), z.number().int().nonnegative());

export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

/** Stable error `code`s emitted by the read-status endpoints (paired with ErrorSchema). */
export const READ_STATUS_ERROR = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL: 'INTERNAL',
} as const;

export type ReadStatusErrorCode = (typeof READ_STATUS_ERROR)[keyof typeof READ_STATUS_ERROR];
