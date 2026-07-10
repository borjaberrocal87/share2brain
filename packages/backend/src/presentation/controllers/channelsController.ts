// Presentation: HTTP handler for GET /api/channels. Owns HTTP concerns and maps
// errors to the unified ErrorSchema shape. Raw DB errors are never leaked to the
// client. Mirrors searchController.ts.
import { CHANNELS_ERROR } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

import type { RbacService } from '../../application/services/rbacService.js';

export interface ChannelsController {
  list(req: Request, res: Response): Promise<void>;
}

export function createChannelsController(deps: { rbacService: RbacService }): ChannelsController {
  const { rbacService } = deps;

  return {
    async list(req, res) {
      const roles = req.session.discordRoles ?? [];

      try {
        const payload = await rbacService.getAllowedChannels(roles);
        res.status(200).json(payload);
      } catch (err) {
        // Never leak the raw DB error (language rule).
        console.error('[channels] failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: CHANNELS_ERROR.INTERNAL });
      }
    },
  };
}
