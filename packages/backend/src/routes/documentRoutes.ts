// Routes: mount the document controller on an Express router. Mounted at
// /api/documents by the composition root (app.ts), AFTER the generic /api gate,
// so it inherits requireAuth + the RBAC middleware — do NOT re-add them here.
// Mirrors searchRoutes.ts.
import { Router } from 'express';

import type { DocumentController } from '../presentation/controllers/documentController.js';

export function createDocumentRouter(controller: DocumentController): Router {
  const router = Router();
  router.get('/', (req, res) => void controller.list(req, res));
  return router;
}
