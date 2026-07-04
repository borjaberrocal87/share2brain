// @hivly/backend — Express API process (AD-1: standalone Node process).
// This story delivers the runtime skeleton: loadConfig() first (AD-8), one
// pooled DB client and one Redis client at startup, and the auth-exempt
// GET /health endpoint. Auth/session middleware, the RAG agent and SSE chat
// arrive in later epics.
import { loadConfig } from '@hivly/shared';
import { createDatabase, type Database } from '@hivly/shared/db';
import { Redis } from 'ioredis';

import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function main(): void {
  // AD-8: validate behavior config before opening any connection. Invalid YAML
  // throws ConfigError here and aborts the process (caught below).
  loadConfig();

  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');

  // One pooled DB client and one Redis client for the process lifetime; the
  // health probe reuses them rather than opening a connection per request.
  const db: Database = createDatabase(databaseUrl);
  // lazyConnect: don't dial Redis at construction — let the probe connect, so a
  // Redis outage degrades /health instead of crashing startup. maxRetries keeps
  // the probe from hanging on a dead server. Swallow the default 'error' event
  // so a connection failure surfaces through /health, not as an uncaught crash.
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on('error', (err) => {
    console.warn('[redis]', err instanceof Error ? err.message : String(err));
  });

  const app = createApp(db, redis);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[backend] listening on 0.0.0.0:${PORT} — GET /health ready`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[backend] received ${signal}, shutting down`);
    server.close();
    redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[backend] fatal: ${message}`);
  process.exit(1);
}
