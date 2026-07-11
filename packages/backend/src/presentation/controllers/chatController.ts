// Presentation: HTTP handler for POST /api/chat. Owns HTTP/SSE concerns — edge
// validation, the pre-stream ownership check, header framing — and maps errors
// to the unified ErrorSchema shape pre-stream, or a terminal `error` SSE frame
// mid-stream (D8). Raw LLM/DB errors are never leaked to the client.
import { CHAT_ERROR, ChatRequestSchema, type SSEFrame } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

import { ChatOwnershipError, type ChatService } from '../../application/services/chatService.js';

export interface ChatController {
  chat(req: Request, res: Response): Promise<void>;
}

export function createChatController(deps: { chatService: ChatService }): ChatController {
  const { chatService } = deps;

  return {
    async chat(req, res) {
      // Validate the body at the edge (AD-6) BEFORE any header is sent.
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Mensaje inválido', code: CHAT_ERROR.VALIDATION_ERROR });
        return;
      }

      // The route is behind requireAuth, so req.session.userId is guaranteed.
      const userId = req.session.userId as string;
      // Populated by the RBAC middleware on every /api/* request (AD-12). Default
      // to an empty scope defensively — the agent treats it as deny-by-default.
      const allowedChannelIds = req.allowedChannelIds ?? [];

      // Story 2.5 (review): guests share one sentinel userId, so pass the per-session
      // conversation allowlist — a guest may only resume conversations THIS session
      // created (ephemeral; no cross-guest/cross-session resume). Absent for OAuth.
      const isGuest = req.session.isGuest === true;
      const guestScope = isGuest
        ? { allowedConversationIds: req.session.guestConversationIds ?? [] }
        : undefined;

      let conversation;
      try {
        conversation = await chatService.resolveConversation(
          userId,
          parsed.data.conversationId,
          guestScope,
        );
      } catch (err) {
        if (err instanceof ChatOwnershipError) {
          res.status(404).json({ error: 'Conversación no encontrada', code: CHAT_ERROR.NOT_FOUND });
          return;
        }
        console.error(
          '[chat] failed to resolve conversation:',
          err instanceof Error ? err.message : String(err),
        );
        res.status(500).json({ error: 'Internal error', code: CHAT_ERROR.INTERNAL });
        return;
      }

      // A guest that just STARTED a conversation (no client id) must have it recorded
      // in the session so a later turn in this session can resume it. Persist before
      // any SSE header is sent (still the pre-stream phase, D8); a save failure only
      // costs this conversation's resumability, never the current turn — log and go on.
      if (isGuest && !parsed.data.conversationId) {
        // Fresh array (never mutate the one handed to resolveConversation as
        // guestScope) so the allowlist snapshot and the session state stay distinct.
        req.session.guestConversationIds = [
          ...(req.session.guestConversationIds ?? []),
          conversation.id,
        ];
        await new Promise<void>((resolve) => {
          req.session.save((err: unknown) => {
            if (err) {
              console.error(
                '[chat] guest session save failed:',
                err instanceof Error ? err.message : String(err),
              );
            }
            resolve();
          });
        });
      }

      // Nothing above sends a header — every earlier branch returns JSON. From
      // here on, a failure can only become a mid-stream `error` frame (D8).
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());
      // A write to a socket the client already closed can emit an async 'error'
      // on the response; with no listener that would crash the process (the route
      // invokes this handler as `void controller.chat(...)`). Log and move on —
      // the stream is already being torn down.
      res.on('error', (err) => {
        console.error(
          '[chat] response stream error:',
          err instanceof Error ? err.message : String(err),
        );
      });

      // Once the client is gone, stop writing to a dead socket. `res.write` can
      // ALSO throw synchronously (EPIPE / write-after-FIN) in the window before
      // `destroyed` flips — that throw is not covered by the 'error' listener
      // above, so catch it here too (an unguarded throw would become an unhandled
      // rejection via `void controller.chat(...)`).
      const writeFrame = (frame: SSEFrame): void => {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        } catch (err) {
          console.error(
            '[chat] frame write failed (client likely disconnected):',
            err instanceof Error ? err.message : String(err),
          );
        }
      };

      try {
        for await (const frame of chatService.streamChat(
          conversation,
          parsed.data.message,
          allowedChannelIds,
          abortController.signal,
        )) {
          writeFrame(frame);
        }
      } catch (err) {
        console.error('[chat] stream failed:', err instanceof Error ? err.message : String(err));
        writeFrame({ type: 'error', code: CHAT_ERROR.INTERNAL, message: 'Internal error' });
      } finally {
        // Symmetric with writeFrame's guard: don't end a socket that is already
        // ended or destroyed.
        if (!res.writableEnded && !res.destroyed) res.end();
      }
    },
  };
}
