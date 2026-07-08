// Browser-safe SSE chat client for the SPA (Story 5.4). POSTs to /api/chat and
// consumes the text/event-stream response with `fetch` streaming (AD-4 — NOT
// EventSource, which cannot POST a body and is banned by convention). The wire
// format is `data: <json>\n\n` frames with NO `event:` line (chatController.ts:76);
// the discriminator is the JSON `type` field, validated by SSEFrameSchema.
//
// Imports types/schemas ONLY from @hivly/shared/schemas — never the root barrel
// or /db, which pull `pg` into the bundle (ESLint no-restricted-imports, AD-3).
import { SSEFrameSchema, type SSEFrame, type ChatRequest } from '@hivly/shared/schemas';

/** Thrown on a PRE-stream failure: the endpoint returned `{ error, code }` JSON
 * (400/404/500) instead of a stream. Carries the stable `code` + HTTP status so
 * the caller can render an inline error without re-reading the body as a stream. */
export class ChatStreamError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`chat request failed: ${code} (${status})`);
    this.name = 'ChatStreamError';
  }
}

/**
 * Stream the agent's answer for one turn. Yields each parsed `SSEFrame` in wire
 * order (`token*` → `citation*` → `done`, or a single `error`). Throws
 * `ChatStreamError` on a pre-stream non-OK response, and propagates an
 * `AbortError` when `signal` aborts (caller distinguishes it from a real error).
 */
export async function* streamChat(
  body: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    // Pre-stream failure: the endpoint sent { error, code } JSON, not a stream.
    let code = 'INTERNAL';
    try {
      code = ((await res.json()) as { code?: string })?.code ?? code;
    } catch {
      /* non-JSON body — keep the default code */
    }
    throw new ChatStreamError(code, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      // The backend always terminates with a `done`/`error` frame + res.end() (D9),
      // so a non-empty leftover here means the connection was cut mid-frame — throw
      // instead of silently dropping it, so the caller marks the bubble errored
      // rather than leaving a cursor blinking forever (review fix, AC7).
      if (buffer.trim()) throw new Error('chat stream ended with an incomplete frame');
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line. A partial frame can straddle a chunk
    // boundary, so only consume up to the last complete `\n\n` and keep the rest.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep).trim(); // "data: {...}"
      buffer = buffer.slice(sep + 2);
      if (!raw.startsWith('data:')) continue;
      const json: unknown = JSON.parse(raw.slice(raw.indexOf(':') + 1).trim());
      yield SSEFrameSchema.parse(json);
    }
  }
}
