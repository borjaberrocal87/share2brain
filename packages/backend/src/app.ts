// Express app factory + composition root (AD-1). Kept separate from main.ts so
// integration tests build the same app against real DB/Redis (and an injectable
// Discord client) without triggering main()'s import-time side effects. This is
// where the DDD layers are wired: infrastructure adapters → application service →
// presentation controller → routes.
import { type Database } from '@hivly/shared/db';
import cors from 'cors';
import express, { type Express } from 'express';

import { createAuthService } from './application/services/authService.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { createHealthHandler } from './health.js';
import { createFetchDiscordOAuthClient } from './infrastructure/discordOAuthClient.fetch.js';
import type { RedisClient } from './infrastructure/redis.js';
import { createSessionMiddleware } from './infrastructure/sessionStore.js';
import { createDrizzleUserRepository } from './infrastructure/userRepository.drizzle.js';
import { createAuthController } from './presentation/controllers/authController.js';
import { createAuthRouter } from './routes/authRoutes.js';

export interface AppOptions {
  sessionSecret: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
  discord: { clientId: string; clientSecret: string; redirectUri: string; guildId: string };
  frontendUrl: string;
  allowedOrigins: string[];
  /** Injectable Discord client for tests; defaults to the real fetch-based adapter. */
  oauth?: DiscordOAuthClient;
}

/** Build the API app bound to the given startup clients + options. No listen. */
export function createApp(db: Database, redis: RedisClient, opts: AppOptions): Express {
  const app = express();

  // Top-level, NOT under /api/ — auth-exempt per the API contract (AD auth table).
  app.get('/health', createHealthHandler(db, redis));

  app.use(cors({ origin: opts.allowedOrigins, credentials: true }));
  app.use(express.json());
  app.use(
    createSessionMiddleware(redis, {
      secret: opts.sessionSecret,
      ttlDays: opts.sessionTtlDays,
      cookieSecure: opts.cookieSecure,
    }),
  );

  // Compose the auth layers.
  const oauth = opts.oauth ?? createFetchDiscordOAuthClient(opts.discord);
  const users = createDrizzleUserRepository(db);
  const authService = createAuthService({ users, oauth, guildId: opts.discord.guildId });
  const authController = createAuthController({
    authService,
    discord: { clientId: opts.discord.clientId, redirectUri: opts.discord.redirectUri },
    frontendUrl: opts.frontendUrl,
    cookieSecure: opts.cookieSecure,
  });
  app.use('/api/auth', createAuthRouter(authController));

  return app;
}
