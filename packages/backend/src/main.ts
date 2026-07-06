// @hivly/backend — Express API process (AD-1: standalone Node process).
// Boots the runtime: loadConfig() first (AD-8), one pooled DB client and one
// node-redis client at startup, then the app (health + Discord OAuth2 auth).
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { createRedisClient } from '@hivly/shared/redis';

import { createApp } from './app.js';
import { createDrizzleChannelPermissionRepository } from './infrastructure/channelPermissionRepository.drizzle.js';
import { createLangchainQueryEmbedder } from './infrastructure/queryEmbedder.langchain.js';
import { materializeChannelPermissions } from './infrastructure/materializeChannelPermissions.js';

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
    console.warn(
      '[redis] initial connect failed:',
      err instanceof Error ? err.message : String(err),
    );
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
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[backend] listening on 0.0.0.0:${PORT} — GET /health ready`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[backend] received ${signal}, shutting down`);
    server.close();
    redis.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// main() is async now (it awaits the channel_permissions materialization), so a
// rejected startup surfaces here via .catch — a synchronous throw (e.g. loadConfig)
// rejects the returned promise all the same. Either way: log and exit(1).
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[backend] fatal: ${message}`);
  process.exit(1);
});
