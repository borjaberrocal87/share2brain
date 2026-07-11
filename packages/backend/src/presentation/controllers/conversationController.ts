// Presentation: HTTP handlers for GET /api/conversations (list) and
// GET /api/conversations/:conversationId (detail). Owns HTTP concerns (query/param
// validation, status codes) and maps errors to the unified ErrorSchema shape. Raw
// DB errors are never leaked to the client. Mirrors documentController.ts.
import { z } from 'zod';

import { CONVERSATIONS_ERROR, ConversationsQuerySchema } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

import type { ConversationService } from '../../application/services/conversationService.js';

/** A conversationId must be a UUID. A malformed id is treated as NOT_FOUND, not a
 * 400 (D9): "not a real id" and "not your id" must be indistinguishable so the
 * endpoint never signals whether a conversation exists. */
const ConversationIdParamSchema = z.object({ conversationId: z.uuid() });

export interface ConversationController {
  list(req: Request, res: Response): Promise<void>;
  getById(req: Request, res: Response): Promise<void>;
}

export function createConversationController(deps: {
  conversationService: ConversationService;
}): ConversationController {
  const { conversationService } = deps;

  return {
    async list(req, res) {
      const parsed = ConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Parámetros inválidos', code: CONVERSATIONS_ERROR.VALIDATION_ERROR });
        return;
      }

      // The route is behind requireAuth, so req.session.userId is guaranteed.
      const userId = req.session.userId as string;

      // Story 2.5: every guest shares the single sentinel user id, so listing
      // conversations by user_id would leak one guest's history to another. Guest
      // chat stays ephemeral — it persists (FK) but is not listable. Return an empty
      // page instead of querying the shared history.
      if (req.session.isGuest === true) {
        res.status(200).json({ results: [], page: parsed.data.page, limit: parsed.data.limit, total: 0 });
        return;
      }

      try {
        const payload = await conversationService.listConversations(
          userId,
          parsed.data.page,
          parsed.data.limit,
        );
        res.status(200).json(payload);
      } catch (err) {
        console.error('[conversations] list failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: CONVERSATIONS_ERROR.INTERNAL });
      }
    },

    async getById(req, res) {
      const parsed = ConversationIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        // Malformed id → 404, not 400 (D9): no existence signal.
        res.status(404).json({ error: 'Conversación no encontrada', code: CONVERSATIONS_ERROR.NOT_FOUND });
        return;
      }

      const userId = req.session.userId as string;

      // Story 2.5: guests cannot retrieve a conversation by id either — the shared
      // sentinel identity means "owned by the guest user" is not "owned by THIS
      // guest". 404 (existence-hiding, D9) keeps guest chat ephemeral per session.
      if (req.session.isGuest === true) {
        res.status(404).json({ error: 'Conversación no encontrada', code: CONVERSATIONS_ERROR.NOT_FOUND });
        return;
      }

      try {
        const detail = await conversationService.getConversation(userId, parsed.data.conversationId);
        if (!detail) {
          res.status(404).json({ error: 'Conversación no encontrada', code: CONVERSATIONS_ERROR.NOT_FOUND });
          return;
        }
        res.status(200).json(detail);
      } catch (err) {
        console.error('[conversations] getById failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: CONVERSATIONS_ERROR.INTERNAL });
      }
    },
  };
}
