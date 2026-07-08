// @hivly/workers — Indexer + Sync consumer process (AD-1: standalone Node
// process). Boot order (AD-8): loadConfig() first, then read the required
// secrets from the environment, then open the DB + Redis clients, then run the
// consumer loops. A config or missing-secret failure aborts BEFORE any network
// I/O.
//
// The Indexer (Story 3.3) drains hivly:discord:messages, embeds and upserts
// into pgvector. The Sync consumer (Story 6.2) drains the updated/deleted
// streams, re-indexing edits and purging deletes — gated by config.sync.enabled.
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { createNotifier } from '@hivly/shared/notifier';
import { createEmbeddingsModel } from '@hivly/shared/providers';
import { createRedisClient, type RedisClient } from '@hivly/shared/redis';

import { runIndexer } from './indexer/consumer.js';
import { MAX_CHUNK_SIZE } from './indexer/chunking.js';
import { MAX_GROUPING_WINDOW } from './indexer/grouping.js';
import { createLogger, type Logger } from './logger.js';
import { runSync } from './sync/consumer.js';

/** Read a required secret from the environment; abort if unset (AD-8, before any I/O). */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

const REDIS_CONNECT_TIMEOUT_MS = 10_000;

/** Quit a Redis client, bounded so a stuck socket can't block shutdown. */
async function quitRedisBounded(client: RedisClient, ms: number): Promise<void> {
  await Promise.race([
    client
      .quit()
      .then(() => undefined)
      .catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * Connect a Redis client with a bounded timeout, fail-fast (exit 1) on
 * failure — mirrors the original single-client boot logic, shared so the
 * Indexer's and Sync's clients connect identically. Returns `false` (without
 * exiting) when a SIGTERM/SIGINT is already racing this same window, so the
 * caller can bail out instead of overwriting shutdown()'s exit path.
 */
async function connectRedisOrExit(
  client: RedisClient,
  logger: Logger,
  label: string,
  isShuttingDown: () => boolean,
): Promise<boolean> {
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Redis connect timed out after ${REDIS_CONNECT_TIMEOUT_MS}ms`)),
          REDIS_CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    return true;
  } catch (err: unknown) {
    if (isShuttingDown()) return false;
    logger.error(`initial ${label} Redis connect failed, aborting`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
    return false; // unreachable — satisfies the return type after process.exit
  }
}

async function main(): Promise<void> {
  // AD-8: validate behavior config before opening ANY connection. Invalid YAML or
  // an unset ${VAR} throws ConfigError here and aborts the process (caught below).
  const config = loadConfig();
  const logger = createLogger(config.observability.log_level);
  // FR21 (Story 6.4): a no-op when notifications.enabled is false/absent — the
  // workers process behaves exactly as before this story (AC-1).
  const notifier = createNotifier(config.notifications, logger);

  // Both caps are silently applied per-batch (grouping.ts / chunking.ts) so a
  // misconfigured value never fails a group; warn once at boot instead so an
  // operator relying on a larger configured value isn't left guessing why.
  if (config.knowledge.grouping_window > MAX_GROUPING_WINDOW) {
    logger.warn('configured grouping_window exceeds the safety cap — will be clamped', {
      configured: config.knowledge.grouping_window,
      cap: MAX_GROUPING_WINDOW,
    });
  }
  if (config.knowledge.chunk_size > MAX_CHUNK_SIZE) {
    logger.warn('configured chunk_size exceeds the safety cap — will be clamped', {
      configured: config.knowledge.chunk_size,
      cap: MAX_CHUNK_SIZE,
    });
  }

  // Shared with the SIGTERM/SIGINT drain below: a fatal handler must not abort an
  // in-flight graceful shutdown (nor fire a spurious crash alert for a clean exit).
  let shuttingDown = false;

  // AC-1: process-level hardening (minimum pulled forward from the Epic 2 retro).
  // An uncaught error/rejection is fatal → exit(1); Compose restarts the container.
  process.on('uncaughtException', (error) => {
    if (shuttingDown) return;
    logger.error('uncaughtException', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'workers', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    if (shuttingDown) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'workers', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => process.exit(1));
  });

  // AC-6: SIGTERM/SIGINT → clean shutdown. Registered BEFORE any long-running boot
  // work (Redis connect, embeddings model creation) — a signal arriving during that
  // window must not fall through to Node's default (immediate, no-cleanup) handler
  // (3.2 deferred finding — don't repeat it). The abort stops the consumer loop at
  // its next iteration boundary; a parked BLOCK read must return first, so bound the
  // wait. Real consumer-group drain stays in Epic 6.
  const shutdownSignal = new AbortController();
  // Assigned once runIndexer/runSync start; shutdown waits for both (bounded)
  // so in-flight work settles before the db/redis connections close underneath
  // them. syncRedis stays undefined when config.sync.enabled is false.
  let indexerPromise: Promise<void> = Promise.resolve();
  let syncPromise: Promise<void> = Promise.resolve();
  // Two dedicated Sync clients — one per blocking loop (updated/deleted). Two
  // concurrent blocking reads cannot share a client (see sync/consumer.ts's
  // header). Both stay undefined when config.sync.enabled is false.
  let syncRedisUpdated: RedisClient | undefined;
  let syncRedisDeleted: RedisClient | undefined;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownSignal.abort();
    logger.info(`received ${signal}, shutting down`);
    void (async () => {
      try {
        // Give both loops a bounded moment to exit at their next boundary. A
        // parked BLOCK 5000 read returns within ~5s, so 7s covers it plus one
        // batch. `.catch` neutralises a late rejection losing the race —
        // `main()`'s own `await` below already ignores it once shutdown started.
        await Promise.race([
          Promise.all([indexerPromise, syncPromise].map((p) => p.catch(() => undefined))),
          new Promise<void>((resolve) => setTimeout(resolve, 7_000)),
        ]);
        // Await quit() so any in-flight command flushes, bounded so a stuck socket
        // can't block exit. quitRedisBounded neutralises a late rejection losing
        // the race — otherwise it surfaces as an unhandledRejection → exit(1).
        await quitRedisBounded(redis, 5_000);
        if (syncRedisUpdated) await quitRedisBounded(syncRedisUpdated, 5_000);
        if (syncRedisDeleted) await quitRedisBounded(syncRedisDeleted, 5_000);
        // pg's Pool.end() takes no timeout arg; bound it so a stuck pool can't
        // block shutdown past 10s (the finally still exits regardless).
        await Promise.race([
          db.$client.end().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('error during shutdown', { reason: message });
        // Best-effort (note #9): notify() is internally bounded (<=5s) and never
        // throws, so awaiting it here can't hang the exit below indefinitely.
        await notifier.notify({ service: 'workers', message, timestamp: new Date().toISOString() });
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Secrets live in .env, never in Hivly.config.yml. A missing URL aborts here,
  // before any network I/O (AC-1).
  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');

  // One pooled DB client (shared, pooled) and one dedicated Redis client per
  // consumer loop for the process lifetime. node-redis retries the initial
  // connect forever (reconnectStrategy always returns a number), so connect()
  // never rejects on a boot outage — it just hangs. Bound it: if Redis is
  // unreachable within the timeout we FAIL FAST (exit 1) and Compose restarts
  // the container (AC-1, same pattern as the bot).
  const db: Database = createDatabase(databaseUrl);
  const redis = createRedisClient(redisUrl);
  if (!(await connectRedisOrExit(redis, logger, 'indexer', () => shuttingDown))) return;

  // Build the embeddings model from validated config (no network I/O until used).
  const embedder = createEmbeddingsModel(config.embeddings);

  // AC-6: the Sync consumer runs concurrently with the Indexer, gated by
  // config.sync.enabled. Its two blocking loops each get their OWN Redis client
  // (two concurrent blocking reads cannot share one — see sync/consumer.ts's
  // header comment).
  if (config.sync.enabled) {
    syncRedisUpdated = createRedisClient(redisUrl);
    if (!(await connectRedisOrExit(syncRedisUpdated, logger, 'sync-updated', () => shuttingDown)))
      return;
    syncRedisDeleted = createRedisClient(redisUrl);
    if (!(await connectRedisOrExit(syncRedisDeleted, logger, 'sync-deleted', () => shuttingDown)))
      return;
  } else {
    logger.info('sync disabled — not starting Sync consumer');
  }

  logger.info('indexer starting — draining hivly:discord:messages');
  indexerPromise = runIndexer({ redis, db, embedder, config, logger, signal: shutdownSignal.signal });

  if (syncRedisUpdated && syncRedisDeleted) {
    logger.info('sync starting — draining updated/deleted streams');
    syncPromise = runSync({
      redisUpdated: syncRedisUpdated,
      redisDeleted: syncRedisDeleted,
      db,
      embedder,
      config,
      logger,
      signal: shutdownSignal.signal,
    });
  }

  try {
    await Promise.all([indexerPromise, syncPromise]);
  } catch (err) {
    // A rejection surfacing after shutdown() already began is expected (a loop
    // was aborted mid-flight) — shutdown() owns the exit path from here. Still
    // log it (rather than swallow silently) in case it's an unrelated real
    // failure that happened to coincide with the shutdown.
    if (shuttingDown) {
      logger.debug('a consumer promise rejected during shutdown — already exiting', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    throw err;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[workers] fatal: ${message}`, stack);
  process.exit(1);
});
