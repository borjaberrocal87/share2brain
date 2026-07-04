// Routes: mount the auth controller handlers on an Express router. Mounted at
// /api/auth by the composition root (app.ts).
import { Router } from 'express';

import type { AuthController } from '../presentation/controllers/authController.js';

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();
  router.get('/login', (req, res) => controller.login(req, res));
  router.get('/callback', (req, res) => void controller.callback(req, res));
  router.get('/me', (req, res) => void controller.me(req, res));
  router.post('/logout', (req, res) => controller.logout(req, res));
  return router;
}
