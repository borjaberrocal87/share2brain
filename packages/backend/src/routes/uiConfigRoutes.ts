// Routes: mount the UI config controller on an Express router. Mounted at
// /api/ui-config by the composition root (app.ts) BEFORE the generic /api
// gate (D4) — this router must terminate the request itself; it is never
// reached by requireAuth.
import { Router } from 'express';

import type { UiConfigController } from '../presentation/controllers/uiConfigController.js';

export function createUiConfigRouter(controller: UiConfigController): Router {
  const router = Router();
  router.get('/', (req, res) => controller.get(req, res));
  // Terminate here for any other method/subpath so the request never falls
  // through to the generic /api gate, where the SAME apiLimiters instance
  // would count it a second time (express-rate-limit ERR_ERL_DOUBLE_COUNT).
  // Path-less middleware — Express 5 / path-to-regexp v8 rejects a bare '*'.
  // Body follows the unified ErrorSchema shape ({ error, code }) like every
  // other /api error — this is a routing terminator, not an endpoint error
  // branch, so no per-endpoint error-code map is introduced (D7 intact).
  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });
  return router;
}
