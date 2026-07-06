// @hivly/workers — Indexer consumer process (AD-1: standalone Node process).
// Boot order (AD-8): loadConfig() first, then read the required secrets from the
// environment, then open the DB + Redis clients, then run the consumer loop. A
// config or missing-secret failure aborts BEFORE any network I/O.
//
// This is the Indexer (Story 3.3): it drains hivly:discord:messages, embeds and
// upserts into pgvector. The Sync consumer (edits/deletes) lands in Epic 6.
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { createEmbeddingsModel } from '@hivly/shared/providers';
import { createRedisClient } from '@hivly/shared/redis';

import { runIndexer } from './indexer/consumer.js';
import { createLogger } from './logger.js';

/** Read a required secret from the environment; abort if unset (AD-8, before any I/O). */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

async function main(): Promise<void> {
  // AD-8: validate behavior config before opening ANY connection. Invalid YAML or
  // an unset ${VAR} throws ConfigError here and aborts the process (caught below).
  const config = loadConfig();
  const logger = createLogger(config.observability.log_level);

  // Secrets live in .env, never in Hivly.config.yml. A missing URL aborts here,
  // before any network I/O (AC-1).
  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');

  // One pooled DB client and one dedicated Redis client for the process lifetime.
  const db: Database = createDatabase(databaseUrl);
  const redis = createRedisClient(redisUrl);
  // node-redis retries the initial connect forever (reconnectStrategy always
  // returns a number), so connect() never rejects on a boot outage — it just
  // hangs. Bound it: if Redis is unreachable within the timeout we FAIL FAST
  // (exit 1) and Compose restarts the container (AC-1, same pattern as the bot).
  const REDIS_CONNECT_TIMEOUT_MS = 10_000;
  try {
    await Promise.race([
      redis.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Redis connect timed out after ${REDIS_CONNECT_TIMEOUT_MS}ms`)),
          REDIS_CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err: unknown) {
    logger.error('initial Redis connect failed, aborting', {
      reason: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Build the embeddings model from validated config (no network I/O until used).
  const embedder = createEmbeddingsModel(config.embeddings);

  // AC-1: process-level hardening (minimum pulled forward from the Epic 2 retro).
  // An uncaught error/rejection is fatal → exit(1); Compose restarts the container.
  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException', { reason: error.message, stack: error.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection', { reason: error.message, stack: error.stack });
    process.exit(1);
  });

  // AC-6: SIGTERM/SIGINT → clean shutdown. Registered BEFORE the consumer loop
  // starts (learn from the 3.2 late-registration finding). The abort stops the
  // loop at its next iteration boundary; a parked BLOCK read must return first,
  // so bound the wait. Real consumer-group drain stays in Epic 6.
  const shutdownSignal = new AbortController();
  let shuttingDown = false;
  // Assigned once runIndexer starts; shutdown waits for it (bounded) so the
  // in-flight batch settles before the db/redis connections close underneath it.
  let indexerPromise: Promise<void> = Promise.resolve();
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownSignal.abort();
    logger.info(`received ${signal}, shutting down`);
    void (async () => {
      try {
        // Give the loop a bounded moment to exit at its next boundary. A parked
        // BLOCK 5000 read returns within ~5s, so 7s covers it plus one batch.
        await Promise.race([
          indexerPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 7_000)),
        ]);
        // Await quit() so any in-flight command flushes, bounded so a stuck socket
        // can't block exit. `.catch` neutralises a late rejection losing the race —
        // otherwise it surfaces as an unhandledRejection → exit(1).
        await Promise.race([
          redis
            .quit()
            .then(() => undefined)
            .catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
        // pg's Pool.end() takes no timeout arg; bound it so a stuck pool can't
        // block shutdown past 10s (the finally still exits regardless).
        await Promise.race([
          db.$client.end().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
      } catch (err) {
        logger.error('error during shutdown', {
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('indexer starting — draining hivly:discord:messages');
  indexerPromise = runIndexer({ redis, db, embedder, config, logger, signal: shutdownSignal.signal });
  await indexerPromise;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[workers] fatal: ${message}`, stack);
  process.exit(1);
});
