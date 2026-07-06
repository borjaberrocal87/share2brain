// @hivly/bot — Discord ingestion process (AD-1: standalone Node process).
// Boot order (AD-8): loadConfig() first, then read the required secrets from the
// environment, then open the DB + Redis clients, then connect to the Gateway. A
// config or missing-secret failure aborts BEFORE any network I/O.
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { createRedisClient } from '@hivly/shared/redis';
import { Events } from 'discord.js';

import { createDiscordClient, login } from './discord/client.js';
import { handleMessageCreate } from './discord/handlers/messageCreate.js';
import { bindGatewayEvents, connectWithRetry } from './discord/reconnect.js';
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

  logger.info(
    'MessageContent is a privileged intent — it must be enabled in the Discord Developer Portal',
  );

  const client = createDiscordClient(logger, config.discord.guild_id);
  bindGatewayEvents(client, logger);
  client.on(Events.MessageCreate, (message) => {
    // handleMessageCreate never rejects (it catches persistence errors), but guard
    // the promise anyway so a future change can't leak an unhandled rejection.
    void handleMessageCreate(message, { config, db, redis, logger });
  });

  // AC-5: process-level hardening (minimum pulled forward from the Epic 2 retro).
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

  // AC-5: SIGTERM/SIGINT → clean shutdown. Real consumer-group drain stays in Epic 6.
  const shutdownSignal = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownSignal.abort();
    logger.info(`received ${signal}, shutting down`);
    void (async () => {
      try {
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

  // AC-4: drive login with exponential backoff. discord.js manages transient socket
  // drops after the first success; this loop is the recovery path for a rejected login.
  await connectWithRetry({
    login: () => login(client, token),
    logger,
    signal: shutdownSignal.signal,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[bot] fatal: ${message}`, stack);
  process.exit(1);
});
