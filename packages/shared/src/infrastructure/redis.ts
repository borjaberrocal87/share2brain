// node-redis client factory (project-wide Redis client — sessions in the backend,
// Redis Streams for bot/workers in Epic 3+). node-redis is the maintained client
// for Redis 8 and the one connect-redis@9 supports natively; ioredis was dropped.
// This lives in @share2brain/shared so every service (backend, bot, workers) uses the
// SAME factory without importing another service (AD-2).
//
// Importing this module opens NO connection — the caller decides when to
// connect(). An 'error' handler is attached so a dropped or absent Redis
// surfaces through a degraded probe rather than an unhandled 'error' event that
// crashes the process.
import { createClient } from 'redis';

/** Create a Redis client with a bounded reconnect backoff. Does not connect. */
export function createRedisClient(url: string) {
  const client = createClient({
    url,
    // Retry with linear backoff capped at 2s so a transient outage self-heals
    // without hammering, and a hung connect never blocks the event loop.
    socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 2000) },
  });
  client.on('error', (err: unknown) => {
    console.warn('[redis]', err instanceof Error ? err.message : String(err));
  });
  return client;
}

/** The concrete node-redis client type, inferred from the factory so no generic drift creeps in. */
export type RedisClient = ReturnType<typeof createRedisClient>;
