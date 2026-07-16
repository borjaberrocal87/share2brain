// @share2brain/workers — Indexer + Sync consumer process (AD-1: standalone Node
// process). Boot order (AD-8): loadConfig() first, then read the required
// secrets from the environment, then open the DB + Redis clients, then run the
// consumer loops. A config or missing-secret failure aborts BEFORE any network
// I/O.
//
// The Indexer (Story 7.2) drains share2brain:discord:messages, extracts+enriches
// resource links and upserts into pgvector. The Sync consumer (Story 7.3)
// drains the updated/deleted streams, re-indexing edits by link-diff and
// purging deletes — gated by config.sync.enabled.
import { loadConfig } from '@share2brain/shared';
import { createDatabase, type Database } from '@share2brain/shared/db';
import { createLogger, type Logger } from '@share2brain/shared/logger';
import { createNotifier } from '@share2brain/shared/notifier';
import { createObservability } from '@share2brain/shared/observability';
import { createChatModel, createEmbeddingsModel } from '@share2brain/shared/providers';
import { createRedisClient, type RedisClient } from '@share2brain/shared/redis';
import { createLlmTracing } from '@share2brain/shared/tracing';

import { createGuardedDispatcher } from './enrichment/ssrfGuard.js';
import type { Embedder } from './indexer/types.js';
import { runIndexer } from './indexer/consumer.js';
import { runSync } from './sync/consumer.js';
import { resolveStreamsConfig, runStreamTrimmer } from './trim/streamTrimmer.js';

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
  // Story ops-5: build the Observability port immediately after loadConfig() and
  // before any network I/O (AD-8). A NoopObservability when observability.sentry_dsn
  // is empty (S-5). Built before createLogger so its structured-log sink can forward
  // from the very first line. config.observability.provider selects the adapter.
  const observability = createObservability({
    dsn: config.observability.sentry_dsn,
    service: 'workers',
    provider: config.observability.provider,
  });
  const logger = createLogger(
    config.observability.log_level,
    'workers',
    undefined,
    observability.logSink,
  );
  // Story ops-6: build the LlmTracing port in the AD-8 slot — right after
  // createObservability/createLogger, before any network I/O AND before the LangChain
  // embeddings/chat models are constructed below, so the OpenInference CallbackManager
  // patch is in place before any model object exists. A NoopLlmTracing when
  // observability.tracing.endpoint is empty/absent (S-5). A SEPARATE seam from the
  // Sentry `observability` above (D1).
  const llmTracing = createLlmTracing({
    endpoint: config.observability.tracing?.endpoint ?? '',
    service: 'workers',
    provider: config.observability.tracing?.provider,
  });
  // Story ops-6 (review): bound the crash-path tracing flush with an OUTER timeout, the
  // same hardening the graceful shutdown applies to shutdown() below. The port guarantees
  // flush() never rejects, not that it never hangs — a future adapter whose flush wedges
  // must not block the process.exit(1) in the fatal handlers.
  const boundedTracingFlush = (): Promise<void> =>
    Promise.race([
      llmTracing.flush().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  // FR21 (Story 6.4): a no-op when notifications.enabled is false/absent — the
  // workers process behaves exactly as before this story (AC-1).
  const notifier = createNotifier(config.notifications, logger);

  // Shared with the SIGTERM/SIGINT drain below: a fatal handler must not abort an
  // in-flight graceful shutdown (nor fire a spurious crash alert for a clean exit).
  let shuttingDown = false;

  // AC-1: process-level hardening (minimum pulled forward from the Epic 2 retro).
  // An uncaught error/rejection is fatal → exit(1); Compose restarts the container.
  process.on('uncaughtException', (error) => {
    if (shuttingDown) return;
    // Story ops-4: capture the real Error (stack preserved) via the port alongside
    // the existing structured log + crash notifier.
    observability.captureException(error);
    logger.error('uncaughtException', { reason: error.message, stack: error.stack });
    // Story ops-4: drain the transport queue before the hard exit so the captured
    // Error + buffered logs actually ship (the transport sends asynchronously).
    void notifier
      .notify({ service: 'workers', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => observability.flush())
      .finally(() => boundedTracingFlush())
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    if (shuttingDown) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    observability.captureException(error);
    logger.error('unhandledRejection', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'workers', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => observability.flush())
      .finally(() => boundedTracingFlush())
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
  // Stream trimmer (Story OPS-1) — its own client (must not share a blocking
  // consumer loop's connection). Stays undefined when streams.trim_enabled is false.
  let trimmerPromise: Promise<void> = Promise.resolve();
  let trimRedis: RedisClient | undefined;
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
          Promise.all(
            [indexerPromise, syncPromise, trimmerPromise].map((p) => p.catch(() => undefined)),
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 7_000)),
        ]);
        // Await quit() so any in-flight command flushes, bounded so a stuck socket
        // can't block exit. quitRedisBounded neutralises a late rejection losing
        // the race — otherwise it surfaces as an unhandledRejection → exit(1).
        await quitRedisBounded(redis, 5_000);
        if (syncRedisUpdated) await quitRedisBounded(syncRedisUpdated, 5_000);
        if (syncRedisDeleted) await quitRedisBounded(syncRedisDeleted, 5_000);
        if (trimRedis) await quitRedisBounded(trimRedis, 5_000);
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
        // Story ops-4: drain the transport queue so the shutdown's tail logs ship
        // before exit (background transport; a no-op under NoopObservability).
        await observability.flush();
        // Story ops-6: tear down the tracing exporter so buffered spans ship before
        // exit (a no-op under NoopLlmTracing). Outer-bounded like the redis.quit/db.end
        // above — the port only guarantees never-reject, not never-hang, so a future
        // adapter that wedges can never block the exit below. `.catch` neutralises a late
        // rejection losing the race.
        await Promise.race([
          llmTracing.shutdown().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Secrets live in .env, never in Share2Brain.config.yml. A missing URL aborts here,
  // before any network I/O (AC-1).
  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');

  // One pooled DB client (shared, pooled) and one dedicated Redis client per
  // consumer loop for the process lifetime. node-redis retries the initial
  // connect forever (reconnectStrategy always returns a number), so connect()
  // never rejects on a boot outage — it just hangs. Bound it: if Redis is
  // unreachable within the timeout we FAIL FAST (exit 1) and Compose restarts
  // the container (AC-1, same pattern as the bot).
  const db: Database = createDatabase(databaseUrl, logger);
  const redis = createRedisClient(redisUrl);
  if (!(await connectRedisOrExit(redis, logger, 'indexer', () => shuttingDown))) return;

  // Build the embeddings model from validated config (no network I/O until used).
  const embedder = createEmbeddingsModel(config.embeddings);

  // Story ops-6 (AC9): wrap the embedder so each batch embedding shows up as a span
  // nested under the enrichment/indexing trace. DI decorator at the composition root
  // — ZERO edits to indexBatch.ts. Counts only in attributes (batch size), never
  // document content (SNF-18). Injected into runIndexer/runSync in place of the raw
  // embedder; the real Embeddings is assignable to the Embedder slice this wraps.
  const tracedEmbedder: Embedder = {
    embedDocuments: (texts: string[]) =>
      llmTracing.withSpan(
        'embeddings.embed_documents',
        { 'embedding.batch_size': texts.length },
        () => embedder.embedDocuments(texts),
      ),
  };

  // AC-6: the enrichment chat model and the SSRF-guarded dispatcher are built
  // ONCE here and injected through the pipeline — never a module-level
  // singleton `Agent` (AC-2), mirroring the embedder injection pattern.
  const enrichModel = createChatModel(config.enrichment.llm);
  const guard = createGuardedDispatcher(config.enrichment.fetch, undefined, logger);

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

  logger.info('indexer starting — draining share2brain:discord:messages');
  indexerPromise = runIndexer({
    redis,
    db,
    embedder: tracedEmbedder,
    config,
    logger,
    enrichModel,
    guard,
    signal: shutdownSignal.signal,
  });

  if (syncRedisUpdated && syncRedisDeleted) {
    logger.info('sync starting — draining updated/deleted streams');
    syncPromise = runSync({
      redisUpdated: syncRedisUpdated,
      redisDeleted: syncRedisDeleted,
      db,
      embedder: tracedEmbedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: shutdownSignal.signal,
    });
  }

  // Story OPS-1: the stream trimmer runs concurrently, gated by
  // streams.trim_enabled (default on). Its own Redis client — a blocking consumer
  // loop's connection cannot be shared (see streamTrimmer.ts's header).
  if (resolveStreamsConfig(config).enabled) {
    trimRedis = createRedisClient(redisUrl);
    if (!(await connectRedisOrExit(trimRedis, logger, 'trimmer', () => shuttingDown))) return;
    trimmerPromise = runStreamTrimmer({ redis: trimRedis, config, logger, signal: shutdownSignal.signal });
  } else {
    logger.info('stream trimming disabled — not starting trimmer');
  }

  try {
    await Promise.all([indexerPromise, syncPromise, trimmerPromise]);
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
