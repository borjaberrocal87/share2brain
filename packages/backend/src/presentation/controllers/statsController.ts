// Presentation: HTTP handler for GET /api/stats. Owns HTTP concerns (status
// codes) and maps errors to the unified ErrorSchema shape. Raw DB errors are
// never leaked to the client. No input parsing (D8 — the endpoint takes no
// query params). Mirrors documentController.ts.
import { STATS_ERROR } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

import type { StatsService } from '../../application/services/statsService.js';

export interface StatsController {
  get(req: Request, res: Response): Promise<void>;
}

export function createStatsController(deps: { statsService: StatsService }): StatsController {
  const { statsService } = deps;

  return {
    async get(req, res) {
      // The route is behind requireAuth, so req.session.userId is guaranteed.
      const userId = req.session.userId as string;
      // Populated by the RBAC middleware on every /api/* request (AD-12). Default
      // to an empty scope defensively — the service treats it as deny-by-default.
      const allowedChannelIds = req.allowedChannelIds ?? [];
      // Story 2.5 (review): guests share one sentinel userId — the per-user stats
      // (coverage read-count, "your queries") are zeroed so a guest never sees
      // another guest's activity summed in. Channel figures are RBAC-bounded.
      const isGuest = req.session.isGuest === true;

      try {
        const payload = await statsService.getStats(userId, allowedChannelIds, undefined, isGuest);
        res.status(200).json(payload);
      } catch (err) {
        console.error('[stats] failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: STATS_ERROR.INTERNAL });
      }
    },
  };
}
