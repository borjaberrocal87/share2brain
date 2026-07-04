// Express app factory (AD-1). Kept separate from main.ts so integration tests can
// build the same app against real DB/Redis clients without triggering main()'s
// import-time side effects (loadConfig + listen). main.ts wires the process; this
// wires the routes.
import { type Database } from '@hivly/shared/db';
import express, { type Express } from 'express';
import type { Redis } from 'ioredis';

import { createHealthHandler } from './health.js';

/** Build the API app bound to the given startup clients. Routes only — no listen. */
export function createApp(db: Database, redis: Redis): Express {
  const app = express();
  // Top-level, NOT under /api/ — auth-exempt per the API contract (AD auth table).
  app.get('/health', createHealthHandler(db, redis));
  return app;
}
