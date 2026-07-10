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

/** Thrown for any configuration failure: missing file, bad YAML, unset ${VAR}, or Zod validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});

const ChannelPermissionSchema = z.object({
  channel_id: z.string(),
  name: z.string(),
  allowed_roles: z.array(z.string()),
});

/** One rate-limit tier: a request budget per rolling window (Story 6.4, AC-2). */
const RateLimitTierSchema = z.object({
  window_ms: z.number().int().positive(),
  max_requests: z.number().int().positive(),
});

export const Share2BrainConfigSchema = z.object({
  version: z.string(),
  discord: z.object({
    guild_id: z.string(),
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
    temperature: z.number(),
    max_iterations: z.number(),
    memory_window: z.number(),
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
  }),
  sync: z.object({
    enabled: z.boolean(),
    sync_on_start: z.boolean(),
    delete_policy: z.enum(['soft', 'hard']),
  }),
  access_control: z.object({
    enabled: z.boolean(),
    default_policy: z.enum(['deny', 'allow']),
    role_cache_ttl: z.number(),
    channel_permissions: z.array(ChannelPermissionSchema),
  }),
  read_tracking: z.object({
    enabled: z.boolean(),
    auto_mark_read_on_click: z.boolean(),
  }),
  observability: z.object({
    sentry_dsn: z.string(),
    log_level: z.enum(['debug', 'info', 'warn', 'error']),
  }),
  security: z.object({
    rate_limit: z.object({
      api: RateLimitTierSchema,
      auth: RateLimitTierSchema,
      chat: RateLimitTierSchema,
    }),
    allowed_origins: z.array(z.string()),
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
      webhook_url: z.string(),
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
      temperature: z.number(),
      base_url: z.string().refine(val => val === '' || /^https?:\/\//.test(val), {
        message: 'enrichment.llm.base_url must be empty or a valid HTTP(S) URL',
      }).optional(),
      api_key: z.string().min(1, 'enrichment.llm.api_key cannot be empty'),
    }),
    fetch: z.object({
      timeout_ms: z.number().int().positive(),
      max_bytes: z.number().int().positive(),
      max_redirects: z.number().int().nonnegative(),
      user_agent: z.string().min(1, 'enrichment.fetch.user_agent cannot be empty'),
      allowed_schemes: z.array(z.enum(['http', 'https'])).nonempty(),
      block_private_ips: z.boolean(),
    }),
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

  const interpolated = interpolateEnv(raw);

  let parsed: unknown;
  try {
    parsed = parseYaml(interpolated);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Malformed YAML in config file "${path}": ${reason}`);
  }

  const result = Share2BrainConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error));
  }

  return result.data;
}
