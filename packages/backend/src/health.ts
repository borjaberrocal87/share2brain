// GET /health handler (auth-exempt, top-level — not under /api/). Probes the two
// gating dependencies (Postgres, Redis) concurrently, each time-boxed so a hung
// socket still yields a prompt 503. discord/indexer are "pending" until Bot and
// Workers report readiness (Epic 3). The response is validated against the
// shared Zod contract (AD-6) before it leaves the process.
import { sql, type Database } from '@hivly/shared/db';
import { HealthResponseSchema, type HealthResponse } from '@hivly/shared/schemas';
import type { Request, Response } from 'express';

import type { RedisClient } from './infrastructure/redis.js';

/** Max time a single dependency probe may take before it counts as disconnected. */
const PROBE_TIMEOUT_MS = 2000;

/** Reject if `promise` does not settle within `ms`. The timer is unref'd so it never keeps the event loop alive. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Run a dependency check under a timeout; any hang or error maps to "disconnected". */
async function probe(check: () => Promise<unknown>): Promise<'connected' | 'disconnected'> {
  try {
    await withTimeout(check(), PROBE_TIMEOUT_MS);
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

/** Probe both gating dependencies and derive the overall status + HTTP code. */
export async function computeHealth(
  db: Database,
  redis: RedisClient,
): Promise<{ statusCode: number; body: HealthResponse }> {
  const [database, redis_] = await Promise.all([
    probe(() => db.execute(sql`select 1`)),
    probe(() => redis.ping()),
  ]);

  const status = database === 'connected' && redis_ === 'connected' ? 'healthy' : 'degraded';

  const body = HealthResponseSchema.parse({
    status,
    components: { database, redis: redis_, discord: 'pending', indexer: 'pending' },
  } satisfies HealthResponse);

  return { statusCode: status === 'healthy' ? 200 : 503, body };
}

/** Express handler factory bound to the shared startup db/redis clients. */
export function createHealthHandler(db: Database, redis: RedisClient) {
  return async (_req: Request, res: Response): Promise<void> => {
    const { statusCode, body } = await computeHealth(db, redis);
    res.status(statusCode).json(body);
  };
}
