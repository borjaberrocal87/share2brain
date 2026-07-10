// Middleware: per-request RBAC expansion (AD-12). Reads the session's Discord
// roles, expands them to the allowed channel IDs, and attaches them to the request
// for downstream handlers. Recomputed on EVERY request (never cached in the
// session), so a config/permission change takes effect on the next request (AC3).
import { AUTH_ERROR } from '@share2brain/shared/schemas';
import type { NextFunction, Request, Response } from 'express';

import type { RbacService } from '../application/services/rbacService.js';

export function createRbacMiddleware(rbac: RbacService) {
  return async function attachAllowedChannelIds(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const roles = req.session.discordRoles ?? [];
      req.allowedChannelIds = await rbac.expandAllowedChannelIds(roles);
      next();
    } catch (err) {
      // Never leak the raw DB error inward or to the client (language rule).
      console.error(
        '[rbac] channel expansion failed:',
        err instanceof Error ? err.message : String(err),
      );
      res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.RBAC_EXPANSION_FAILED });
    }
  };
}
