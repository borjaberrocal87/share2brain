// Middleware: the generic auth gate. Any request reaching it without a valid
// Redis session (no `userId`) is rejected with 401 AUTH_REQUIRED in the shared
// ErrorSchema shape. Mounted on `/api` (after the auth router) so it guards every
// non-auth API route, and reused route-level on /api/auth/roles (AC2, AC4).
import { AUTH_ERROR } from '@share2brain/shared/schemas';
import type { NextFunction, Request, Response } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Unauthorized', code: AUTH_ERROR.AUTH_REQUIRED });
    return;
  }
  next();
}
