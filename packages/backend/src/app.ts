// Express app factory + composition root (AD-1). Kept separate from main.ts so
// integration tests build the same app against real DB/Redis (and an injectable
// Discord client) without triggering main()'s import-time side effects. This is
// where the DDD layers are wired: infrastructure adapters → application service →
// presentation controller → routes.
import { type Database } from '@hivly/shared/db';
import cors from 'cors';
import express, { type Express } from 'express';

import { createAuthService } from './application/services/authService.js';
import { createDocumentService } from './application/services/documentService.js';
import { createRbacService } from './application/services/rbacService.js';
import { createReadStatusService } from './application/services/readStatusService.js';
import { createSearchService } from './application/services/searchService.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import type { QueryEmbedder } from './domain/repositories/queryEmbedder.js';
import { createHealthHandler } from './health.js';
import { createDrizzleChannelPermissionRepository } from './infrastructure/channelPermissionRepository.drizzle.js';
import { createDrizzleDocumentRepository } from './infrastructure/documentRepository.drizzle.js';
import { createDrizzleEmbeddingSearchRepository } from './infrastructure/embeddingSearchRepository.drizzle.js';
import { createFetchDiscordOAuthClient } from './infrastructure/discordOAuthClient.fetch.js';
import { createDrizzleReadStatusRepository } from './infrastructure/readStatusRepository.drizzle.js';
import type { RedisClient } from '@hivly/shared/redis';
import { createSessionMiddleware } from './infrastructure/sessionStore.js';
import { createDrizzleUserRepository } from './infrastructure/userRepository.drizzle.js';
import { createRbacMiddleware } from './middleware/rbac.js';
import { requireAuth } from './middleware/requireAuth.js';
import { createAuthController } from './presentation/controllers/authController.js';
import { createDocumentController } from './presentation/controllers/documentController.js';
import { createReadStatusController } from './presentation/controllers/readStatusController.js';
import { createSearchController } from './presentation/controllers/searchController.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createDocumentRouter } from './routes/documentRoutes.js';
import { createReadStatusRouter } from './routes/readStatusRoutes.js';
import { createSearchRouter } from './routes/searchRoutes.js';

export interface AppOptions {
  sessionSecret: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
  discord: { clientId: string; clientSecret: string; redirectUri: string; guildId: string };
  frontendUrl: string;
  allowedOrigins: string[];
  /** Injectable Discord client for tests; defaults to the real fetch-based adapter. */
  oauth?: DiscordOAuthClient;
  /**
   * Query embedder for GET /api/search. Required at runtime: createApp has no config
   * to build a default, so main.ts builds it from `config.embeddings` and injects it
   * (tests inject a deterministic fake via buildTestAppOptions). Follows the `oauth?`
   * injection precedent.
   */
  queryEmbedder?: QueryEmbedder;
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

  // Compose the auth + RBAC layers.
  const oauth = opts.oauth ?? createFetchDiscordOAuthClient(opts.discord);
  const users = createDrizzleUserRepository(db);
  const authService = createAuthService({ users, oauth, guildId: opts.discord.guildId });
  const channelPermissions = createDrizzleChannelPermissionRepository(db);
  const rbacService = createRbacService({ channelPermissions });
  const authController = createAuthController({
    authService,
    rbacService,
    discord: { clientId: opts.discord.clientId, redirectUri: opts.discord.redirectUri },
    frontendUrl: opts.frontendUrl,
    cookieSecure: opts.cookieSecure,
  });

  // The auth router handles its own auth semantics (public login/callback,
  // session-checked me/roles/logout) and is registered BEFORE the generic gate,
  // so it short-circuits and the gate never runs for /api/auth/* (AC2 exemption).
  app.use('/api/auth', createAuthRouter(authController));

  // Generic gate for every OTHER /api/* request: 401 without a session, then the
  // per-request RBAC expansion attaches req.allowedChannelIds (AC2, AC3). Ordering
  // is load-bearing — this MUST come after the auth router. Future Epic 4/5 routes
  // registered below inherit it.
  app.use('/api', requireAuth, createRbacMiddleware(rbacService));

  // Search (Epic 4). Registered AFTER the /api gate, so it inherits requireAuth +
  // the RBAC middleware (req.allowedChannelIds) — the AD-12 filter is enforced
  // inside the vector query by the adapter. The embedder must be injected (no
  // config in createApp to build a default).
  const queryEmbedder = opts.queryEmbedder;
  if (!queryEmbedder) {
    throw new Error(
      'createApp requires a queryEmbedder — build it from config.embeddings in main.ts ' +
        '(or inject a fake via buildTestAppOptions in tests).',
    );
  }
  const embeddingSearch = createDrizzleEmbeddingSearchRepository(db);
  const searchService = createSearchService({ embedder: queryEmbedder, searchRepo: embeddingSearch });
  const searchController = createSearchController({ searchService });
  app.use('/api/search', createSearchRouter(searchController));

  // Documents + read-status (Epic 4, Story 4.2). Registered AFTER the /api gate,
  // so both inherit requireAuth + the RBAC middleware — the AD-12 filter is
  // enforced inside the SQL by each adapter.
  const documentRepo = createDrizzleDocumentRepository(db);
  const documentService = createDocumentService({ documentRepo });
  const documentController = createDocumentController({ documentService });
  app.use('/api/documents', createDocumentRouter(documentController));

  const readStatusRepo = createDrizzleReadStatusRepository(db);
  const readStatusService = createReadStatusService({ readStatusRepo });
  const readStatusController = createReadStatusController({ readStatusService });
  app.use('/api/read-status', createReadStatusRouter(readStatusController));

  return app;
}
