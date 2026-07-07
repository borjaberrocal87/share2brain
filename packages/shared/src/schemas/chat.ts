// Chat API contract (AD-6). Request shape for POST /api/chat plus the stable
// error codes the chat endpoint emits. The response is a text/event-stream of
// SSEFrame (see sse.ts) — not modeled here. Mirrors search.ts.
import { z } from 'zod';

/** Upper bound on the raw chat message. Caps the text forwarded to the (paid)
 * chat model, closing a cost/DoS vector on the authenticated endpoint. */
export const CHAT_MESSAGE_MAX_LENGTH = 4000;

/**
 * POST /api/chat body. `message` is trimmed and must be non-blank and no
 * longer than `CHAT_MESSAGE_MAX_LENGTH`. `conversationId` is absent/null for a
 * new conversation, or an existing conversation's UUID to append to (ownership
 * is enforced by the controller, not this schema).
 */
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
  conversationId: z.uuid().nullable().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Stable error `code`s emitted by the chat endpoint (paired with ErrorSchema). */
export const CHAT_ERROR = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const;

export type ChatErrorCode = (typeof CHAT_ERROR)[keyof typeof CHAT_ERROR];
