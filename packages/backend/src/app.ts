// Express app factory + composition root (AD-1). Kept separate from main.ts so
// integration tests build the same app against real DB/Redis (and an injectable
// Discord client) without triggering main()'s import-time side effects. This is
// where the DDD layers are wired: infrastructure adapters → application service →
// presentation controller → routes.
import { type Database } from '@share2brain/shared/db';
import type { Logger } from '@share2brain/shared/logger';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

import { createRagAgent } from './agent/graph.js';
import { createAuthService } from './application/services/authService.js';
import { createChatService } from './application/services/chatService.js';
import { createConversationService } from './application/services/conversationService.js';
import { createDocumentService } from './application/services/documentService.js';
import { createRbacService } from './application/services/rbacService.js';
import { createReadStatusService } from './application/services/readStatusService.js';
import { createSearchService } from './application/services/searchService.js';
import { createStatsService } from './application/services/statsService.js';
import type { ChatModel } from './domain/repositories/chatModel.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import type { QueryEmbedder } from './domain/repositories/queryEmbedder.js';
import { createHealthHandler } from './health.js';
import { createDrizzleChannelPermissionRepository } from './infrastructure/channelPermissionRepository.drizzle.js';
import { createDrizzleConversationRepository } from './infrastructure/conversationRepository.drizzle.js';
import { createDrizzleDocumentRepository } from './infrastructure/documentRepository.drizzle.js';
import { createDrizzleEmbeddingSearchRepository } from './infrastructure/embeddingSearchRepository.drizzle.js';
import { createFetchDiscordOAuthClient } from './infrastructure/discordOAuthClient.fetch.js';
import { createDrizzleRagRetriever } from './infrastructure/ragRetriever.drizzle.js';
import { createDrizzleReadStatusRepository } from './infrastructure/readStatusRepository.drizzle.js';
import { createDrizzleStatsRepository } from './infrastructure/statsRepository.drizzle.js';
import type { RedisClient } from '@share2brain/shared/redis';
import { createSessionMiddleware } from './infrastructure/sessionStore.js';
import { createDrizzleUserRepository } from './infrastructure/userRepository.drizzle.js';
import { createRbacMiddleware } from './middleware/rbac.js';
import { requireAuth } from './middleware/requireAuth.js';
import { createAuthController } from './presentation/controllers/authController.js';
import { createChannelsController } from './presentation/controllers/channelsController.js';
import { createChatController } from './presentation/controllers/chatController.js';
import { createConversationController } from './presentation/controllers/conversationController.js';
import { createDocumentController } from './presentation/controllers/documentController.js';
import { createReadStatusController } from './presentation/controllers/readStatusController.js';
import { createSearchController } from './presentation/controllers/searchController.js';
import { createStatsController } from './presentation/controllers/statsController.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createChannelsRouter } from './routes/channelsRoutes.js';
import { createChatRouter } from './routes/chatRoutes.js';
import { createConversationRouter } from './routes/conversationRoutes.js';
import { createDocumentRouter } from './routes/documentRoutes.js';
import { createReadStatusRouter } from './routes/readStatusRoutes.js';
import { createSearchRouter } from './routes/searchRoutes.js';
import { createStatsRouter } from './routes/statsRoutes.js';

/** Fallback turn-count window when `agentMemoryWindow` isn't injected (tests). */
const DEFAULT_AGENT_MEMORY_WINDOW = 20;

/** One rate-limit tier in express-rate-limit v8's option shape. */
export interface RateLimitTierOptions {
  windowMs: number;
  limit: number;
}

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
  /**
   * Chat model for POST /api/chat (Story 5.1). Required at runtime: createApp has
   * no config to build a default, so main.ts builds it from `config.agent` and
   * injects it (tests inject a deterministic fake via buildTestAppOptions).
   * Follows the `queryEmbedder?` injection precedent.
   */
  chatModel?: ChatModel;
  /** Turn-count window the agent's `reason` node truncates history to
   * (`config.agent.memory_window`). Defaults to DEFAULT_AGENT_MEMORY_WINDOW. */
  agentMemoryWindow?: number;
  /**
   * Three-tier rate limiting (Story 6.4, AC-2). OPTIONAL and OFF by default —
   * `buildTestAppOptions` and the Playwright e2e harness omit it (they build the
   * app via `buildTestAppOptions` and would 429-flake under real limits); only
   * `main.ts` injects it from `config.security.rate_limit`. When absent, no
   * limiter is mounted and no request is ever 429'd.
   */
  rateLimit?: { api: RateLimitTierOptions; auth: RateLimitTierOptions; chat: RateLimitTierOptions };
  /**
   * Logger for the ragRetriever's per-row skip-and-warn (Story 7.4, F2). Only
   * `main.ts` injects the real structured logger; tests/e2e default to a no-op
   * so a malformed fixture row doesn't spam test output.
   */
  logger?: Logger;
}

/** Default logger for createApp callers that don't inject one (tests/e2e). */
const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Build the API app bound to the given startup clients + options. No listen. */
export function createApp(db: Database, redis: RedisClient, opts: AppOptions): Express {
  const app = express();

  // AC-2 (Story 6.4): helmet mounts FIRST, before EVERYTHING — including
  // /health, so probes also carry the security headers ("cualquier request").
  // crossOriginResourcePolicy is relaxed to cross-origin (not helmet's
  // same-origin default) and COEP is left off, so it doesn't fight the SPA's
  // credentialed cross-origin fetch (cors({credentials:true}) below).
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      // AC-2 requires X-Frame-Options: DENY specifically — helmet's own default
      // is the less strict SAMEORIGIN.
      frameguard: { action: 'deny' },
    }),
  );
  // The backend sits behind nginx (AD-7) — a single reverse-proxy hop. Trust it
  // (and only it) so express-rate-limit's per-IP keyGenerator reads the real
  // client IP from X-Forwarded-For instead of nginx's internal address (which
  // would collapse "per-IP" into a single global limit). Gated on the same
  // condition that mounts the limiters (note #6: do NOT trust the proxy in
  // tests/e2e — they connect directly, and trusting a spoofable X-Forwarded-For
  // with no limiter to need it is pure downside).
  if (opts.rateLimit) app.set('trust proxy', 1);

  // Top-level, NOT under /api/ — auth-exempt per the API contract (AD auth
  // table) AND never rate-limited (Compose probes it every few seconds; a
  // limiter would flap it to 429 → a false "degraded"/restart signal).
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

  // Three-tier rate limiting (Story 6.4, AC-2, note #4) — mounted ONLY when
  // `opts.rateLimit` is injected (production `main.ts`). `buildTestAppOptions`
  // and the e2e harness omit it, so this stays an empty array there and no
  // request is ever 429'd in tests. v8 option names: windowMs/limit (not the
  // deprecated `max`), standardHeaders as the IETF draft, legacyHeaders off.
  const limiterOptions = { standardHeaders: 'draft-8' as const, legacyHeaders: false };
  const authLimiters = opts.rateLimit
    ? [rateLimit({ ...limiterOptions, ...opts.rateLimit.auth })]
    : [];
  const apiLimiters = opts.rateLimit
    ? [rateLimit({ ...limiterOptions, ...opts.rateLimit.api })]
    : [];
  const chatLimiters = opts.rateLimit
    ? [rateLimit({ ...limiterOptions, ...opts.rateLimit.chat })]
    : [];

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
  app.use('/api/auth', ...authLimiters, createAuthRouter(authController));

  // Generic gate for every OTHER /api/* request: 401 without a session, then the
  // per-request RBAC expansion attaches req.allowedChannelIds (AC2, AC3). Ordering
  // is load-bearing — this MUST come after the auth router. Future Epic 4/5 routes
  // registered below inherit it.
  app.use('/api', ...apiLimiters, requireAuth, createRbacMiddleware(rbacService));

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

  // Stats (Epic 9, Story 9.1). Registered AFTER the /api gate, so it inherits
  // requireAuth + the RBAC middleware (no extra rate limiter — inherits the
  // `api` tier) — every channel-scoped aggregation embeds allowedChannelIds
  // inside the SQL (AD-12).
  const statsRepo = createDrizzleStatsRepository(db);
  const statsService = createStatsService({ statsRepo });
  const statsController = createStatsController({ statsService });
  app.use('/api/stats', createStatsRouter(statsController));

  // Channels (Epic 4, Story 4.3). Registered AFTER the /api gate, so it inherits
  // requireAuth + the RBAC middleware — reuses the rbacService built above.
  const channelsController = createChannelsController({ rbacService });
  app.use('/api/channels', createChannelsRouter(channelsController));

  // Chat (Epic 5, Story 5.1). Registered AFTER the /api gate, so it inherits
  // requireAuth + the RBAC middleware — the AD-12 filter is enforced inside the
  // vector query by ragRetriever (reuses embeddingSearch built above). The chat
  // model must be injected (no config in createApp to build a default).
  const chatModel = opts.chatModel;
  if (!chatModel) {
    throw new Error(
      'createApp requires a chatModel — build it from config.agent in main.ts ' +
        '(or inject a fake via buildTestAppOptions in tests).',
    );
  }
  const ragRetriever = createDrizzleRagRetriever({
    embedder: queryEmbedder,
    searchRepo: embeddingSearch,
    logger: opts.logger ?? noopLogger,
  });
  const ragAgent = createRagAgent({
    chatModel,
    ragRetriever,
    memoryWindow: opts.agentMemoryWindow ?? DEFAULT_AGENT_MEMORY_WINDOW,
  });
  const conversationRepo = createDrizzleConversationRepository(db);
  const chatService = createChatService({ agent: ragAgent, conversationRepo });
  const chatController = createChatController({ chatService });
  app.use('/api/chat', ...chatLimiters, createChatRouter(chatController));

  // Conversations read side (Epic 5, Story 5.2). Registered AFTER the /api gate, so
  // it inherits requireAuth + the RBAC middleware. Access control is by OWNERSHIP
  // (req.session.userId), not channel scope (D2) — allowedChannelIds is unused here.
  // Reuses the SAME conversationRepo instance built above for chat.
  const conversationService = createConversationService({ conversationRepo });
  const conversationController = createConversationController({ conversationService });
  app.use('/api/conversations', createConversationRouter(conversationController));

  return app;
}
