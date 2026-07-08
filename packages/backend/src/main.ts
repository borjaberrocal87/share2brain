// @hivly/backend — Express API process (AD-1: standalone Node process).
// Boots the runtime: loadConfig() first (AD-8), one pooled DB client and one
// node-redis client at startup, then the app (health + Discord OAuth2 auth).
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { createLogger } from '@hivly/shared/logger';
import { createNotifier } from '@hivly/shared/notifier';
import { createRedisClient } from '@hivly/shared/redis';

import { createApp } from './app.js';
import { createDrizzleChannelPermissionRepository } from './infrastructure/channelPermissionRepository.drizzle.js';
import { createLangchainChatModel } from './infrastructure/chatModel.langchain.js';
import { createLangchainQueryEmbedder } from './infrastructure/queryEmbedder.langchain.js';
import { materializeChannelPermissions } from './infrastructure/materializeChannelPermissions.js';
import { createGracefulShutdown } from './lifecycle.js';

const PORT = Number(process.env.PORT) || 3000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

async function main(): Promise<void> {
  // AD-8: validate behavior config before opening any connection. Invalid YAML
  // throws ConfigError here and aborts the process (caught below).
  const config = loadConfig();
  const logger = createLogger(config.observability.log_level, 'backend');
  // FR21 (Story 6.4): a no-op when notifications.enabled is false/absent — every
  // service behaves exactly as before this story (AC-1).
  const notifier = createNotifier(config.notifications, logger);

  // Shared with the graceful drain created after app.listen(): a fatal handler
  // must not abort an in-flight SIGTERM/SIGINT shutdown (nor fire a spurious
  // crash alert for what is actually a clean exit). Reassigned once the drain
  // exists; the handlers only read it at runtime, long after startup wires it up.
  let isShuttingDown = (): boolean => false;

  // AC-4: process-level hardening, mirroring bot/main.ts and workers/main.ts —
  // the backend previously had NEITHER handler. Best-effort alert (bounded
  // internally, never throws) fires before the prompt exit(1) so Compose
  // restarts the container either way.
  process.on('uncaughtException', (error) => {
    if (isShuttingDown()) return;
    logger.error('uncaughtException', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'backend', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    if (isShuttingDown()) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection', { reason: error.message, stack: error.stack });
    void notifier
      .notify({ service: 'backend', message: error.message, timestamp: new Date().toISOString() })
      .finally(() => process.exit(1));
  });

  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');
  const sessionSecret = requireEnv('SESSION_SECRET');
  const discordClientId = requireEnv('DISCORD_CLIENT_ID');
  const discordClientSecret = requireEnv('DISCORD_CLIENT_SECRET');
  const discordRedirectUri = requireEnv('DISCORD_REDIRECT_URI');
  const frontendUrl = requireEnv('FRONTEND_URL');
  const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS) || 7;

  // One pooled DB client and one Redis client for the process lifetime.
  const db: Database = createDatabase(databaseUrl);
  const redis = createRedisClient(redisUrl);
  // Connect in the background: a Redis outage at startup must degrade /health,
  // not crash the process. The reconnectStrategy keeps retrying; meanwhile the
  // health probe's ping() fails and /health reports 503.
  redis.connect().catch((err: unknown) => {
    logger.warn('initial Redis connect failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  });

  // AC1: materialize channel_permissions from config BEFORE accepting requests —
  // no /api/* request may run against an unmaterialized RBAC table. This is the
  // first DB query; if it throws (DB unreachable), abort startup (caught below).
  // Compose gates the backend on migrator success + the postgres healthcheck, so
  // the DB is expected up here. (Redis still connects in the background above.)
  await materializeChannelPermissions(
    createDrizzleChannelPermissionRepository(db),
    config.access_control.channel_permissions,
  );

  // Build the query embedder from validated config (the LangChain provider stays
  // behind this adapter). No network I/O at construction. GET /api/search uses it.
  const queryEmbedder = createLangchainQueryEmbedder(config.embeddings);

  // Build the RAG agent's chat model from validated config (same LangChain
  // boundary as the query embedder). No network I/O at construction. POST
  // /api/chat uses it.
  const chatModel = createLangchainChatModel(config.agent);

  const app = createApp(db, redis, {
    sessionSecret,
    sessionTtlDays,
    cookieSecure: process.env.NODE_ENV === 'production',
    discord: {
      clientId: discordClientId,
      clientSecret: discordClientSecret,
      redirectUri: discordRedirectUri,
      guildId: config.discord.guild_id,
    },
    frontendUrl,
    allowedOrigins: config.security.allowed_origins,
    queryEmbedder,
    chatModel,
    agentMemoryWindow: config.agent.memory_window,
    // AC-2 (Story 6.4, note #4): only main.ts injects this — buildTestAppOptions
    // and the e2e harness omit it, so tests/e2e never see a 429.
    rateLimit: {
      api: {
        windowMs: config.security.rate_limit.api.window_ms,
        limit: config.security.rate_limit.api.max_requests,
      },
      auth: {
        windowMs: config.security.rate_limit.auth.window_ms,
        limit: config.security.rate_limit.auth.max_requests,
      },
      chat: {
        windowMs: config.security.rate_limit.chat.window_ms,
        limit: config.security.rate_limit.chat.max_requests,
      },
    },
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`listening on 0.0.0.0:${PORT} — GET /health ready`);
  });

  // AC-3: real bounded drain (replaces the previous stub), extracted to
  // lifecycle.ts for unit testability. Switched off redis.destroy() (no flush)
  // onto bounded redis.quit() (note #7).
  const shutdown = createGracefulShutdown({ server, redis, db, logger, notifier });
  isShuttingDown = shutdown.isShuttingDown;
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// main() is async now (it awaits the channel_permissions materialization), so a
// rejected startup surfaces here via .catch — a synchronous throw (e.g. loadConfig)
// rejects the returned promise all the same. Either way: log and exit(1).
//
// Asymmetry (note #9): this catch may run BEFORE logger/notifier exist (e.g.
// loadConfig() itself threw), so it can't notify — a missing/invalid config
// means there are no credentials to notify with anyway. Fall back to console.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[backend] fatal: ${message}`);
  process.exit(1);
});
