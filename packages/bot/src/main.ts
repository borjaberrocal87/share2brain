// @hivly/bot — Discord ingestion process (AD-1: standalone Node process).
// Boot order (AD-8): loadConfig() first, then read the required secrets from the
// environment, then open the DB + Redis clients, then connect to the Gateway. A
// config or missing-secret failure aborts BEFORE any network I/O.
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { createNotifier } from '@hivly/shared/notifier';
import { createRedisClient } from '@hivly/shared/redis';
import { Events } from 'discord.js';

import { runBackfill } from './backfill/backfiller.js';
import { getChannelCursor } from './backfill/cursor.js';
import { createDiscordClient, login } from './discord/client.js';
import { handleMessageCreate } from './discord/handlers/messageCreate.js';
import { handleMessageDelete } from './discord/handlers/messageDelete.js';
import { handleMessageUpdate } from './discord/handlers/messageUpdate.js';
import { bindGatewayEvents, connectWithRetry } from './discord/reconnect.js';
import { createLogger } from './logger.js';
import { runOfflineSync } from './sync/offlineSync.js';

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
  // FR21 (Story 6.4): a no-op when notifications.enabled is false/absent — the
  // bot behaves exactly as before this story (AC-1).
  const notifier = createNotifier(config.notifications, logger);

  // Secrets live in .env, never in Hivly.config.yml. A missing token aborts here,
  // before any network I/O (AC-1).
  const token = requireEnv('DISCORD_BOT_TOKEN');
  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');

  // One pooled DB client and one Redis client for the process lifetime.
  const db: Database = createDatabase(databaseUrl);
  const redis = createRedisClient(redisUrl);
  // Connect Redis before touching the Gateway so the client is ready before the first
  // messageCreate arrives — otherwise the XADD fails, rolls back the INSERT, and the
  // message is lost. node-redis retries the initial connect forever (reconnectStrategy
  // always returns a number), so connect() never rejects on a boot outage — it just
  // hangs. Bound it: if Redis is unreachable within the timeout we FAIL FAST (exit 1)
  // and Compose restarts the container, rather than hanging with a dead Gateway.
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

  // AC-1 (Story 3.2): resolve every per-channel backfill cursor BEFORE any Gateway
  // I/O. Once login() succeeds the live listener starts inserting, and a live row
  // would advance a channel's newest message past the offline gap — the cursor
  // must reflect only what a PREVIOUS process persisted.
  const backfillCursors = new Map<string, string | null>();
  if (config.discord.backfill.enabled) {
    for (const channel of config.discord.channels) {
      if (!channel.enabled) continue;
      try {
        backfillCursors.set(channel.id, await getChannelCursor(db, channel.id));
      } catch (error) {
        // A transient DB blip (or a driver contract break — getChannelCursor
        // throws rather than returning null for that) must not crash the process
        // before the Gateway connects, but must NOT be treated as "first run"
        // either: that would silently downgrade this channel's unbounded gap
        // fetch to the bounded `limit` path. Leave it unset — the backfiller
        // treats a missing cursor entry as a per-channel failure and skips this
        // channel this run; cursor resolution is retried fresh next boot.
        logger.error('failed to resolve backfill cursor, skipping this channel this run', {
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    logger.info('backfill disabled — skipping historical backfill');
  }

  logger.info(
    'MessageContent is a privileged intent — it must be enabled in the Discord Developer Portal',
  );

  const client = createDiscordClient(logger, config.discord.guild_id);
  // AC-4 (Story 3.2): observability for REST 429s. discord.js itself queues and
  // waits out rate limits (Retry-After honored by default) — this is a log, not
  // a recovery mechanism. Bound once per process, here only.
  client.rest.on('rateLimited', (info) => {
    logger.warn('Discord REST rate limited', {
      route: info.route,
      timeToReset: info.timeToReset,
    });
  });
  bindGatewayEvents(client, logger);
  client.on(Events.MessageCreate, (message) => {
    // handleMessageCreate never rejects (it catches persistence errors), but guard
    // the promise anyway so a future change can't leak an unhandled rejection.
    void handleMessageCreate(message, { config, db, redis, logger });
  });
  // Story 6.1: publish-only edit/delete detection for the Sync worker (6.2).
  // Neither handler ever rejects (both catch internally), but `void` the
  // promise anyway — same rationale as MessageCreate above.
  client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
    void handleMessageUpdate(newMessage, { config, redis, logger });
  });
  client.on(Events.MessageDelete, (message) => {
    void handleMessageDelete(message, { config, redis, logger });
  });

  // Shared with the SIGTERM/SIGINT drain below: a fatal handler must not abort an
  // in-flight graceful shutdown (nor fire a spurious crash alert for a clean exit).
  let shuttingDown = false;

  // AC-5: process-level hardening (minimum pulled forward from the Epic 2 retro).
  // An uncaught error/rejection is fatal → exit(1); Compose restarts the container.
  process.on('uncaughtException', (error) => {
    if (shuttingDown) return;
    logger.error('uncaughtException', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'bot', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    if (shuttingDown) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'bot', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => process.exit(1));
  });

  // AC-5: SIGTERM/SIGINT → clean shutdown. Real consumer-group drain stays in Epic 6.
  const shutdownSignal = new AbortController();
  // Tracks the in-flight backfill (if any) so shutdown can wait for it — bounded —
  // BEFORE tearing down the db/redis/client connections it may still be using.
  let backfillPromise: Promise<void> = Promise.resolve();
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownSignal.abort();
    logger.info(`received ${signal}, shutting down`);
    void (async () => {
      try {
        // Give the aborted backfill a bounded moment to stop touching db/redis/client
        // before those connections start closing underneath it.
        await Promise.race([
          backfillPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
        // Bound destroy() too — a hung/half-open Gateway socket must not block the exit.
        await Promise.race([
          client.destroy(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
        // Await quit() so a pending XADD flushes before exit, but bound it so a stuck
        // Redis socket can't block shutdown. `.catch` neutralises a late rejection that
        // loses the race — otherwise it would surface as an unhandledRejection → exit(1).
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
        const message = err instanceof Error ? err.message : String(err);
        logger.error('error during shutdown', { reason: message });
        // Best-effort (note #9): notify() is internally bounded (<=5s) and never
        // throws, so awaiting it here can't hang the exit below indefinitely.
        await notifier.notify({ service: 'bot', message, timestamp: new Date().toISOString() });
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // AC-4: drive login with exponential backoff. discord.js manages transient socket
  // drops after the first success; this loop is the recovery path for a rejected login.
  await connectWithRetry({
    login: () => login(client, token),
    logger,
    signal: shutdownSignal.signal,
  });

  // Story 3.2: historical backfill, fired once per process after the FIRST
  // successful login (connectWithRetry resolves exactly once; later Gateway
  // reconnects are discord.js-internal and never re-run this). Non-blocking —
  // live ingestion runs concurrently and overlaps are absorbed by the idempotent
  // persistMessage. A whole-run failure is logged, never an unhandledRejection.
  // NOTE: per-channel and completed-event XADD errors are handled inside
  // runBackfill itself; this catch is for unexpected structural failures only.
  if (config.discord.backfill.enabled) {
    backfillPromise = runBackfill({
      client,
      config,
      db,
      redis,
      logger,
      cursors: backfillCursors,
      signal: shutdownSignal.signal,
    }).catch((error: unknown) => {
      logger.error('unexpected backfill failure', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Story 6.3: after the historical backfill settles, reconcile edits/deletes
  // that happened on Discord while the bot was offline — publish-only (no bot
  // DB write). Chained onto backfillPromise (not a separate promise) so it is
  // covered by the SAME bounded shutdown drain above, and runs after backfill
  // regardless of whether backfill itself succeeded (per-channel failures
  // there don't reject backfillPromise; a structural one is already caught).
  if (config.sync.enabled && config.sync.sync_on_start) {
    backfillPromise = backfillPromise
      .then(() =>
        runOfflineSync({
          client,
          config,
          db,
          redis,
          logger,
          signal: shutdownSignal.signal,
        }),
      )
      .catch((error: unknown) => {
        logger.error('unexpected offline sync failure', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } else {
    logger.info('offline sync disabled — skipping startup reconciliation');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[bot] fatal: ${message}`, stack);
  process.exit(1);
});
