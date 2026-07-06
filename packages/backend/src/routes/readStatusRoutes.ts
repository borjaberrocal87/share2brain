// Routes: mount the read-status controller on an Express router. Mounted at
// /api/read-status by the composition root (app.ts), AFTER the generic /api
// gate, so it inherits requireAuth + the RBAC middleware — do NOT re-add them
// here. Mirrors searchRoutes.ts.
//
// GOTCHA: `/unread-count` and `/mark-all` MUST be registered BEFORE the
// `/:embeddingId` param routes. Express matches in registration order; a
// `:embeddingId` route registered first would capture these literal paths as an
// embedding id, and EmbeddingIdParamSchema's UUID validation would then 400 them.
import { Router } from 'express';

import type { ReadStatusController } from '../presentation/controllers/readStatusController.js';

export function createReadStatusRouter(controller: ReadStatusController): Router {
  const router = Router();
  router.get('/unread-count', (req, res) => void controller.unreadCount(req, res));
  router.post('/mark-all', (req, res) => void controller.markAll(req, res));
  router.post('/:embeddingId', (req, res) => void controller.markRead(req, res));
  router.delete('/:embeddingId', (req, res) => void controller.unmarkRead(req, res));
  return router;
}
