// Routes: mount the search controller on an Express router. Mounted at
// /api/search by the composition root (app.ts), AFTER the generic /api gate, so it
// inherits requireAuth + the RBAC middleware (req.allowedChannelIds) — do NOT
// re-add them here. Mirrors authRoutes.ts.
import { Router } from 'express';

import type { SearchController } from '../presentation/controllers/searchController.js';

export function createSearchRouter(controller: SearchController): Router {
  const router = Router();
  router.get('/', (req, res) => void controller.search(req, res));
  return router;
}
