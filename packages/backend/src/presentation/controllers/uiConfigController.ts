// Presentation: HTTP handler for GET /api/ui-config — the SPA's runtime UI
// language (Epic 10). Never reads req.session (D6): it serves the login
// screen BEFORE any session exists, so the endpoint must not create/read one.
import { UiConfigResponseSchema } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

export interface UiConfigController {
  get(req: Request, res: Response): void;
}

export function createUiConfigController(deps: { language: 'es' | 'en' }): UiConfigController {
  const { language } = deps;

  return {
    get(_req, res) {
      res.status(200).json(UiConfigResponseSchema.parse({ language }));
    },
  };
}
