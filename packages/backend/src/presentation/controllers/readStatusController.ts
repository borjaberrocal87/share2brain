// Presentation: HTTP handlers for the read-status endpoints. Owns HTTP concerns
// (param/body validation, status codes) and maps service results to the unified
// ErrorSchema shape. Raw DB errors are never leaked to the client. Mirrors
// documentController.ts / searchController.ts.
import {
  EmbeddingIdParamSchema,
  MarkAllRequestSchema,
  READ_STATUS_ERROR,
} from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

import type { ReadStatusService } from '../../application/services/readStatusService.js';

export interface ReadStatusController {
  markRead(req: Request, res: Response): Promise<void>;
  unmarkRead(req: Request, res: Response): Promise<void>;
  markAll(req: Request, res: Response): Promise<void>;
  unreadCount(req: Request, res: Response): Promise<void>;
}

export function createReadStatusController(deps: {
  readStatusService: ReadStatusService;
}): ReadStatusController {
  const { readStatusService } = deps;

  return {
    async markRead(req, res) {
      const parsed = EmbeddingIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Identificador de fragmento inválido', code: READ_STATUS_ERROR.VALIDATION_ERROR });
        return;
      }

      const userId = req.session.userId as string;
      const allowedChannelIds = req.allowedChannelIds ?? [];

      try {
        const result = await readStatusService.markRead(userId, parsed.data.embeddingId, allowedChannelIds);
        if (!result.ok) {
          res.status(404).json({ error: 'Fragmento no encontrado', code: READ_STATUS_ERROR.NOT_FOUND });
          return;
        }
        res.status(200).json({});
      } catch (err) {
        console.error('[read-status] markRead failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: READ_STATUS_ERROR.INTERNAL });
      }
    },

    async unmarkRead(req, res) {
      const parsed = EmbeddingIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Identificador de fragmento inválido', code: READ_STATUS_ERROR.VALIDATION_ERROR });
        return;
      }

      const userId = req.session.userId as string;

      try {
        await readStatusService.unmarkRead(userId, parsed.data.embeddingId);
        res.status(200).json({});
      } catch (err) {
        console.error('[read-status] unmarkRead failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: READ_STATUS_ERROR.INTERNAL });
      }
    },

    async markAll(req, res) {
      const parsed = MarkAllRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Parámetros inválidos', code: READ_STATUS_ERROR.VALIDATION_ERROR });
        return;
      }

      const userId = req.session.userId as string;
      const allowedChannelIds = req.allowedChannelIds ?? [];

      try {
        const result = await readStatusService.markAll(userId, parsed.data.channelId, allowedChannelIds);
        if (!result.ok) {
          res.status(403).json({ error: 'Sin acceso al canal', code: READ_STATUS_ERROR.FORBIDDEN });
          return;
        }
        res.status(200).json(result.response);
      } catch (err) {
        console.error('[read-status] markAll failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: READ_STATUS_ERROR.INTERNAL });
      }
    },

    async unreadCount(req, res) {
      const userId = req.session.userId as string;
      const allowedChannelIds = req.allowedChannelIds ?? [];

      try {
        const payload = await readStatusService.unreadCount(userId, allowedChannelIds);
        res.status(200).json(payload);
      } catch (err) {
        console.error('[read-status] unreadCount failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: READ_STATUS_ERROR.INTERNAL });
      }
    },
  };
}
