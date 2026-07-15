// Centralized behavior configuration (AD-8). loadConfig() reads Share2Brain.config.yml,
// interpolates ${ENV_VAR} references from process.env, and validates the result
// with Zod. On ANY failure it throws a descriptive ConfigError — the caller's
// main.ts is expected to abort BEFORE opening any DB/Redis/Discord connection.
// This module opens no network connections itself.
//
// Keys are snake_case to mirror the operator-authored YAML exactly. Secrets stay
// in .env and are referenced here as ${VAR}; behavior stays in YAML. Never mix.
import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { isHttpUrl } from '../schemas/linkRefine.js';

/** Thrown for any configuration failure: missing file, bad YAML, unset ${VAR}, or Zod validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** A Discord snowflake is a numeric id — reject empty/non-numeric at load time
 *  (S-6) so a typo fails loud instead of silently never matching in the RBAC filter. */
const Snowflake = z.string().regex(/^\d+$/, 'must be a numeric Discord snowflake id');

const ChannelSchema = z.object({
  id: Snowflake,
  name: z.string(),
  enabled: z.boolean(),
});

const ChannelPermissionSchema = z.object({
  channel_id: Snowflake,
  name: z.string(),
  allowed_roles: z.array(z.string()),
});

/** An exact web origin (scheme://host[:port], no path/trailing slash) and never
 *  the "*" wildcard — a "*" with credentialed session cookies (AD-10) would be a
 *  severe CORS misconfig, so the loader rejects it (S-8, fail loud per AD-8). */
const ExactOrigin = z
  .string()
  .refine((v) => v !== '*' && URL.canParse(v) && new URL(v).origin === v, {
    message: 'must be an exact origin like "https://app.example.com" — no path, and "*" is not allowed',
  });

/** One rate-limit tier: a request budget per rolling window (Story 6.4, AC-2). */
const RateLimitTierSchema = z.object({
  window_ms: z.number().int().positive(),
  max_requests: z.number().int().positive(),
});

export const Share2BrainConfigSchema = z.object({
  version: z.string(),
  discord: z.object({
    guild_id: Snowflake,
    channels: z.array(ChannelSchema),
    backfill: z.object({
      enabled: z.boolean(),
      limit: z.number().int().positive().max(100_000),
      ignore_bots: z.boolean(),
    }),
  }),
  // RAG agent (LLM) provider. All three providers are OpenAI-compatible via a
  // base_url except Anthropic, which uses its native API. Secrets (api_key) come
  // from .env via ${VAR}; base_url is required only for the "custom" provider
  // (enforced by the superRefine below).
  agent: z.object({
    provider: z.enum(['anthropic', 'openai', 'custom']),
    model: z.string().min(1, 'agent.model cannot be empty'),
    // Bounded so a typo (e.g. max_iterations: 1e9) can't drive an unbounded
    // agentic loop or a nonsensical sampling temperature straight into LLM cost.
    temperature: z.number().min(0).max(2),
    max_iterations: z.number().int().positive().max(50),
    memory_window: z.number().int().nonnegative().max(1000),
    base_url: z.string().refine(val => val === '' || /^https?:\/\//.test(val), {
      message: 'agent.base_url must be empty or a valid HTTP(S) URL',
    }).optional(),
    api_key: z.string().min(1, 'agent.api_key cannot be empty'),
  }),
  // Embeddings provider. Anthropic offers NO embeddings API, so it is structurally
  // excluded from the enum; the custom message makes that explicit (AC-2). The
  // embedding_model that used to live under `knowledge` now lives here as `model`.
  embeddings: z.object({
    provider: z.enum(['openai', 'custom'], {
      message: 'embeddings.provider must be "openai" or "custom" — Anthropic offers no embeddings API',
    }),
    model: z.string().min(1, 'embeddings.model cannot be empty'),
    dimensions: z.number().int().positive(),
    base_url: z.string().refine(val => val === '' || /^https?:\/\//.test(val), {
      message: 'embeddings.base_url must be empty or a valid HTTP(S) URL',
    }).optional(),
    api_key: z.string().min(1, 'embeddings.api_key cannot be empty'),
    // AUDIT M4: per-request timeout (ms) on the embeddings client, so a provider
    // that opens a connection then stalls can't wedge the strictly-sequential
    // Indexer/Sync loop forever. Optional with a default so existing configs stay
    // valid; capped so a typo can't disable the guard with an absurd value.
    timeout_ms: z.number().int().positive().max(600_000).default(60_000),
  }),
  sync: z.object({
    enabled: z.boolean(),
    sync_on_start: z.boolean(),
    delete_policy: z.enum(['soft', 'hard']),
  }),
  access_control: z.object({
    enabled: z.boolean(),
    default_policy: z.enum(['deny', 'allow']),
    role_cache_ttl: z.number().int().positive(),
    channel_permissions: z.array(ChannelPermissionSchema),
    // Guest access for demos (Historia 2.5). The whole block is OPTIONAL and OFF
    // by default — a config omitting it stays valid (same rationale as `streams`/
    // `notifications`). NO `.default()` anywhere: the backend consumer
    // (resolveGuestAccessConfig) supplies per-field defaults (role/username/TTL),
    // so only `enabled` is required WHEN the block is present (an explicit block
    // without `enabled` is a config error — fail loud per AD-8). Never mixes
    // secrets: guest access needs none.
    guest_access: z.object({
      enabled: z.boolean(),
      role: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      session_ttl_minutes: z.number().int().positive().optional(),
      // Story 2.6: demo Discord invite shown on the login screen. Optional and
      // NO `.default()` (D4) — the backend resolves absence to "no URL" (link
      // hidden). Behavior, not a secret, so it belongs here in YAML.
      // Review 2026-07-15: a blank value ("") coerces to undefined so blanking
      // the field means "off" (not a boot-aborting ConfigError); a non-empty value
      // must be an http(s) URL (shared `isHttpUrl`, the project's URL.canParse
      // convention — not the deprecated `z.string().url()`) so a `javascript:`/
      // `data:` URL can never reach the login-screen `href`.
      invite_url: z
        .string()
        .refine((v) => v === '' || isHttpUrl(v), 'invite_url must be a valid HTTP(S) URL')
        .transform((v) => (v === '' ? undefined : v))
        .optional(),
    }).optional(),
  }),
  read_tracking: z.object({
    enabled: z.boolean(),
    auto_mark_read_on_click: z.boolean(),
  }),
  observability: z.object({
    // Empty disables Sentry; otherwise it must be a valid URL (S-5) — a typo'd DSN
    // should fail at load, not silently drop crash reports.
    sentry_dsn: z.string().refine((v) => v === '' || URL.canParse(v), {
      message: 'observability.sentry_dsn must be empty or a valid URL',
    }),
    log_level: z.enum(['debug', 'info', 'warn', 'error']),
  }),
  security: z.object({
    rate_limit: z.object({
      api: RateLimitTierSchema,
      auth: RateLimitTierSchema,
      chat: RateLimitTierSchema,
    }),
    allowed_origins: z.array(ExactOrigin),
    // Whether the session cookie carries the Secure flag. OPTIONAL and FAIL-CLOSED:
    // the backend treats an omitted value as `true` (secure), so a misconfigured
    // deploy can never silently ship the sid over plaintext HTTP. Dev sets it to
    // `false` explicitly to allow http://localhost. Replaces the old
    // NODE_ENV-derived default, which failed OPEN when NODE_ENV was unset.
    cookie_secure: z.boolean().optional(),
  }),
  // External crash alerts (FR21, Story 6.4). Optional and defaults to disabled so
  // existing configs/fixtures without it remain valid. Behavior (enabled,
  // provider) lives here; secrets (bot_token, chat_id, webhook_url) are always
  // ${VAR} references resolved from .env by interpolateEnv — never raw values.
  notifications: z.object({
    enabled: z.boolean(),
    provider: z.enum(['telegram', 'slack']),
    telegram: z.object({
      bot_token: z.string(),
      chat_id: z.string(),
    }).optional(),
    slack: z.object({
      // Sent to via fetch() on a crash alert — validate it's HTTPS at load (S-5),
      // not at the moment of the crash when failing is worst.
      webhook_url: z.string().refine((v) => /^https:\/\//.test(v), {
        message: 'notifications.slack.webhook_url must be an HTTPS URL',
      }),
    }).optional(),
  }).optional(),
  // Enrichment pipeline (Epic 7 pivot). REQUIRED — unlike `notifications`/`streams`,
  // this is the core of the resource-index pivot; the Story 7.2 Indexer cannot run
  // without it. `language` is the AI output language (behavior, so it lives here in
  // YAML, not `.env`). `llm` mirrors the `agent` block's shape (minus max_iterations/
  // memory_window, which are agent-only); `fetch` bounds the outbound URL fetch the
  // Indexer performs (SSRF mitigations land in Story 7.2 — this just validates config).
  enrichment: z.object({
    language: z.string().min(1, 'enrichment.language cannot be empty'),
    llm: z.object({
      provider: z.enum(['anthropic', 'openai', 'custom']),
      model: z.string().min(1, 'enrichment.llm.model cannot be empty'),
      temperature: z.number().min(0).max(2),
      base_url: z.string().refine(val => val === '' || /^https?:\/\//.test(val), {
        message: 'enrichment.llm.base_url must be empty or a valid HTTP(S) URL',
      }).optional(),
      api_key: z.string().min(1, 'enrichment.llm.api_key cannot be empty'),
      // AUDIT M4: wall-clock timeout (ms) for each enrichment LLM call. Enforced
      // by buildResourceRows via a combined abort signal, so a hung provider
      // becomes a normal D1 enrichment failure (entry stays pending → eventually
      // dead-lettered) instead of stalling the whole Indexer. Optional+default so
      // existing configs stay valid; capped against an absurd typo.
      timeout_ms: z.number().int().positive().max(600_000).default(60_000),
    }),
    fetch: z.object({
      timeout_ms: z.number().int().positive(),
      max_bytes: z.number().int().positive(),
      max_redirects: z.number().int().nonnegative(),
      user_agent: z.string().min(1, 'enrichment.fetch.user_agent cannot be empty'),
      allowed_schemes: z.array(z.enum(['http', 'https'])).nonempty(),
      block_private_ips: z.boolean(),
    }),
    // Per-author + global spend caps on the outbound fetch/LLM/embeddings fan-out
    // the Indexer performs (audit M-5: without this any Discord member can burn
    // paid LLM quota by posting many URL-heavy messages). OPTIONAL with in-code
    // defaults resolved by @share2brain/workers (resolveEnrichmentRateLimit), so a
    // config omitting the block stays valid. Behavior only — no secrets. When a
    // cap is hit the Indexer degrades to message-text-only enrichment (never drops
    // the entry — at-least-once, AD-13).
    rate_limit: z
      .object({
        enabled: z.boolean(),
        // Max full (URL-fetching) enrichments per author per rolling hour.
        per_author_hourly: z.number().int().positive(),
        // Max full enrichments across all authors per rolling day (global ceiling).
        global_daily: z.number().int().positive(),
      })
      .optional(),
  }),
  // Redis Streams retention (Story OPS-1). The whole block AND each field are
  // optional; resolveStreamsConfig (in @share2brain/workers) supplies per-field defaults
  // (enabled / 5-min / no-ceiling), so a config omitting the block OR setting only
  // some fields (e.g. just `trim_enabled: false`) remains valid. Behavior only — no
  // secrets. `max_len` is an OPTIONAL APPROXIMATE (~) ceiling backstop (null = off);
  // the PEL-safe MINID trim is always the primary bound and never drops unacked
  // entries.
  streams: z.object({
    trim_enabled: z.boolean().optional(),
    trim_interval_ms: z.number().int().positive().optional(),
    max_len: z.number().int().positive().nullable().optional(),
  }).optional(),
  // UI language for the SPA (Epic 10). The whole block is OPTIONAL — an absent
  // `ui:` key stays valid (same rationale as `notifications`/`streams`). NO
  // `.default()` here (repo-wide convention): the consumer (`createApp`)
  // resolves the "es" default. A PRESENT block requires `language` — fail loud
  // per AD-8, same as an explicit block without `enabled` elsewhere. Governs
  // ONLY the SPA (literals, date/number formatting, client-side error
  // messages); the AI-generated content language remains `enrichment.language`,
  // a separate concern.
  ui: z.object({
    language: z.enum(['es', 'en'], { message: 'ui.language must be "es" or "en"' }),
  }).optional(),
}).superRefine((config, ctx) => {
  // A "custom" provider is an arbitrary OpenAI-compatible endpoint, so it is
  // meaningless without a base_url. Enforce a non-empty base_url for both the
  // agent (LLM) and the embeddings blocks (AC-3).
  for (const block of ['agent', 'embeddings'] as const) {
    const { provider, base_url } = config[block];
    if (provider === 'custom' && !base_url?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: [block, 'base_url'],
        message: `${block}.base_url is required when provider is "custom"`,
      });
    }
  }
  if (config.enrichment.llm.provider === 'custom' && !config.enrichment.llm.base_url?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['enrichment', 'llm', 'base_url'],
      message: 'enrichment.llm.base_url is required when provider is "custom"',
    });
  }

  // A duplicated ENABLED channel id (copy-paste error) would backfill the same
  // channel twice per boot; onConflictDoNothing absorbs the duplicate rows/events,
  // but channelsProcessed in the completed event would still double-count. Two
  // DISABLED entries sharing an id are harmless — both the cursor-resolution loop
  // and runBackfill already skip disabled channels — so don't reject those.
  const seenChannelIds = new Set<string>();
  config.discord.channels.forEach((channel, index) => {
    if (!channel.enabled) return;
    if (seenChannelIds.has(channel.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['discord', 'channels', index, 'id'],
        message: `discord.channels contains a duplicate ENABLED id "${channel.id}"`,
      });
    }
    seenChannelIds.add(channel.id);
  });

  // A notifier enabled without its provider's credentials would silently no-op
  // (createNotifier degrades rather than crashes) — catch the misconfiguration
  // at load time instead, mirroring the agent/embeddings custom-base_url check.
  if (config.notifications?.enabled) {
    const { provider, telegram, slack } = config.notifications;
    if (provider === 'telegram' && (!telegram?.bot_token?.trim() || !telegram?.chat_id?.trim())) {
      ctx.addIssue({
        code: 'custom',
        path: ['notifications', 'telegram'],
        message:
          'notifications.telegram.bot_token and chat_id are required when notifications.enabled is true and provider is "telegram"',
      });
    }
    if (provider === 'slack' && !slack?.webhook_url?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['notifications', 'slack', 'webhook_url'],
        message:
          'notifications.slack.webhook_url is required when notifications.enabled is true and provider is "slack"',
      });
    }
  }
});

export type Share2BrainConfig = z.infer<typeof Share2BrainConfigSchema>;
export type NotificationsConfig = NonNullable<Share2BrainConfig['notifications']>;
export type EnrichmentConfig = Share2BrainConfig['enrichment'];

const DEFAULT_CONFIG_FILE = 'Share2Brain.config.yml';
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Substitute ${ENV_VAR} placeholders from process.env; an unset var is a failure. */
function interpolateEnv(raw: string): string {
  return raw.replace(ENV_PLACEHOLDER, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      throw new ConfigError(
        `Environment variable \${${name}} referenced in config is not set. ` +
          `Add ${name} to your .env before starting.`,
      );
    }
    return value;
  });
}

/**
 * Interpolate ${VAR} references over the PARSED tree's string leaves only, never
 * the raw YAML text. Interpolating raw text (the previous approach) let a secret
 * containing YAML metacharacters (newlines, `:`, `"`, `#`) corrupt the document
 * or inject sibling keys, and also substituted inside comments. Walking the
 * parsed tree confines each substitution to the string value it belongs to;
 * numbers, booleans, and keys are left untouched.
 */
function interpolateTree(node: unknown): unknown {
  if (typeof node === 'string') return interpolateEnv(node);
  if (Array.isArray(node)) return node.map(interpolateTree);
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, interpolateTree(value)]));
  }
  return node;
}

/** Turn a ZodError into a single readable "path: message" list. */
function formatZodError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
  return `Invalid Share2Brain configuration:\n${details}`;
}

/**
 * Load, interpolate, and validate the Share2Brain behavior configuration.
 *
 * Path resolution: `configPath` arg → `SHARE2BRAIN_CONFIG_PATH` env →
 * `Share2Brain.config.yml` in the current working directory (Compose mounts it at
 * `/app/Share2Brain.config.yml`).
 *
 * @throws {ConfigError} on a missing file, malformed YAML, an unset referenced
 *   env var, or a schema validation failure. Never opens a network connection.
 */
export function loadConfig(configPath?: string): Share2BrainConfig {
  const path = configPath ?? process.env.SHARE2BRAIN_CONFIG_PATH ?? DEFAULT_CONFIG_FILE;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Could not read config file at "${path}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Malformed YAML in config file "${path}": ${reason}`);
  }

  // Interpolate ${VAR} AFTER parsing, over string leaves only (see interpolateTree).
  const interpolated = interpolateTree(parsed);

  const result = Share2BrainConfigSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error));
  }

  return result.data;
}
