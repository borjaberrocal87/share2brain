import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './index.js';

const VALID_YAML = `
version: "1.0"
discord:
  guild_id: "111111111111111111"
  channels:
    - id: "1234567890"
      name: "general"
      enabled: true
  backfill:
    enabled: true
    limit: 1000
    ignore_bots: true
agent:
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  temperature: 0.7
  max_iterations: 10
  memory_window: 20
  api_key: "sk-ant-test"
embeddings:
  provider: "openai"
  model: "text-embedding-3-small"
  dimensions: 1536
  api_key: "sk-openai-test"
sync:
  enabled: true
  sync_on_start: true
  delete_policy: "soft"
access_control:
  enabled: true
  default_policy: "deny"
  role_cache_ttl: 300
  channel_permissions:
    - channel_id: "1234567890"
      name: "general"
      allowed_roles: ["admin", "member"]
read_tracking:
  enabled: true
  auto_mark_read_on_click: true
observability:
  sentry_dsn: ""
  log_level: "info"
security:
  rate_limit:
    api:
      window_ms: 900000
      max_requests: 100
    auth:
      window_ms: 900000
      max_requests: 10
    chat:
      window_ms: 60000
      max_requests: 20
  allowed_origins:
    - "http://localhost:5173"
enrichment:
  language: "en"
  llm:
    provider: "anthropic"
    model: "claude-sonnet-4-6"
    temperature: 0.3
    api_key: "sk-ant-enrichment-test"
  fetch:
    timeout_ms: 5000
    max_bytes: 2000000
    max_redirects: 3
    user_agent: "Share2BrainBot/1.0"
    allowed_schemes:
      - "https"
    block_private_ips: true
`;

describe('loadConfig', () => {
  let dir: string;

  const writeFixture = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share2brain-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should return a typed, validated config when the YAML is valid', () => {
    const path = writeFixture('valid.yml', VALID_YAML);

    const config = loadConfig(path);

    expect(config.version).toBe('1.0');
    expect(config.discord.guild_id).toBe('111111111111111111');
    expect(config.discord.channels).toHaveLength(1);
    expect(config.agent.provider).toBe('anthropic');
    expect(config.agent.temperature).toBe(0.7);
    expect(config.agent.api_key).toBe('sk-ant-test');
    expect(config.embeddings.provider).toBe('openai');
    expect(config.embeddings.dimensions).toBe(1536);
    expect(config.embeddings.api_key).toBe('sk-openai-test');
    expect(config.sync.delete_policy).toBe('soft');
    expect(config.access_control.default_policy).toBe('deny');
    expect(config.observability.log_level).toBe('info');
    expect(config.security.rate_limit.api.max_requests).toBe(100);
    expect(config.security.rate_limit.auth.max_requests).toBe(10);
    expect(config.security.rate_limit.chat.max_requests).toBe(20);
    expect(config.notifications).toBeUndefined();
    expect(config.streams).toBeUndefined();
    expect(config.ui).toBeUndefined();
    expect(config.enrichment.language).toBe('en');
    expect(config.enrichment.llm.provider).toBe('anthropic');
    expect(config.enrichment.llm.api_key).toBe('sk-ant-enrichment-test');
    expect(config.enrichment.fetch.timeout_ms).toBe(5000);
    expect(config.enrichment.fetch.allowed_schemes).toEqual(['https']);
    expect(config.enrichment.fetch.block_private_ips).toBe(true);
  });

  it('should parse an optional streams block when present', () => {
    const yaml = `${VALID_YAML}streams:\n  trim_enabled: true\n  trim_interval_ms: 300000\n  max_len: null\n`;
    const path = writeFixture('streams.yml', yaml);

    const config = loadConfig(path);

    expect(config.streams).toEqual({ trim_enabled: true, trim_interval_ms: 300000, max_len: null });
  });

  it('should accept a numeric streams.max_len ceiling', () => {
    const yaml = `${VALID_YAML}streams:\n  trim_enabled: false\n  trim_interval_ms: 60000\n  max_len: 500000\n`;
    const path = writeFixture('streams-maxlen.yml', yaml);

    const config = loadConfig(path);

    expect(config.streams?.max_len).toBe(500000);
    expect(config.streams?.trim_enabled).toBe(false);
  });

  it('should accept a PARTIAL streams block (per-field optional; defaults filled in code)', () => {
    const yaml = `${VALID_YAML}streams:\n  trim_enabled: false\n`;
    const path = writeFixture('streams-partial.yml', yaml);

    const config = loadConfig(path);

    expect(config.streams).toEqual({ trim_enabled: false });
    expect(config.streams?.trim_interval_ms).toBeUndefined();
    expect(config.streams?.max_len).toBeUndefined();
  });

  it('should reject a non-positive streams.trim_interval_ms', () => {
    const yaml = `${VALID_YAML}streams:\n  trim_enabled: true\n  trim_interval_ms: 0\n  max_len: null\n`;
    const path = writeFixture('streams-bad.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/trim_interval_ms|streams/);
  });

  // Epic 10 — `ui` is an OPTIONAL top-level block (absent ⇒ config.ui undefined;
  // the "es" default is resolved by the consumer, D1). A PRESENT block requires
  // `language` (fail loud per AD-8). VALID_YAML stays WITHOUT a `ui:` block — it
  // is the "absent" fixture (see the assertion above).
  it('should parse ui.language "en" when present', () => {
    const yaml = `${VALID_YAML}ui:\n  language: "en"\n`;
    const path = writeFixture('ui-en.yml', yaml);

    const config = loadConfig(path);

    expect(config.ui).toEqual({ language: 'en' });
  });

  it('should parse ui.language "es" when present', () => {
    const yaml = `${VALID_YAML}ui:\n  language: "es"\n`;
    const path = writeFixture('ui-es.yml', yaml);

    const config = loadConfig(path);

    expect(config.ui).toEqual({ language: 'es' });
  });

  it('should reject an unsupported ui.language', () => {
    const yaml = `${VALID_YAML}ui:\n  language: "fr"\n`;
    const path = writeFixture('ui-bad-language.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/ui|language/);
  });

  it('should reject an empty ui block missing language', () => {
    // A bare `ui:` key with no value parses as YAML null, not `{}` — the Zod
    // issue path is `['ui']`, not `['ui', 'language']`.
    const yaml = `${VALID_YAML}ui:\n`;
    const path = writeFixture('ui-empty.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/ui/);
  });

  // Story 2.5 — access_control.guest_access is an OPTIONAL block, OFF by default;
  // per-field defaults (role/username/TTL) are resolved by the backend consumer,
  // never here (no `.default()`). It nests under access_control (2-space indent).
  const withGuestBlock = (guestYaml: string): string =>
    VALID_YAML.replace('  role_cache_ttl: 300\n', `  role_cache_ttl: 300\n${guestYaml}`);

  it('should leave access_control.guest_access undefined when the block is absent', () => {
    const path = writeFixture('guest-absent.yml', VALID_YAML);

    const config = loadConfig(path);

    expect(config.access_control.guest_access).toBeUndefined();
  });

  it('should parse a minimal guest_access block (only enabled) with optional fields undefined', () => {
    const yaml = withGuestBlock('  guest_access:\n    enabled: true\n');
    const path = writeFixture('guest-minimal.yml', yaml);

    const config = loadConfig(path);

    expect(config.access_control.guest_access).toEqual({ enabled: true });
    expect(config.access_control.guest_access?.role).toBeUndefined();
    expect(config.access_control.guest_access?.username).toBeUndefined();
    expect(config.access_control.guest_access?.session_ttl_minutes).toBeUndefined();
  });

  it('should parse a full guest_access block', () => {
    const yaml = withGuestBlock(
      '  guest_access:\n    enabled: true\n    role: "guest"\n    username: "Invitado"\n    session_ttl_minutes: 120\n',
    );
    const path = writeFixture('guest-full.yml', yaml);

    const config = loadConfig(path);

    expect(config.access_control.guest_access).toEqual({
      enabled: true,
      role: 'guest',
      username: 'Invitado',
      session_ttl_minutes: 120,
    });
  });

  it('should reject a non-boolean guest_access.enabled', () => {
    const yaml = withGuestBlock('  guest_access:\n    enabled: "yes"\n');
    const path = writeFixture('guest-bad-enabled.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/guest_access|enabled/);
  });

  it('should reject a non-positive guest_access.session_ttl_minutes', () => {
    const yaml = withGuestBlock('  guest_access:\n    enabled: true\n    session_ttl_minutes: 0\n');
    const path = writeFixture('guest-bad-ttl.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/session_ttl_minutes|guest_access/);
  });

  // Story 2.6 — guest_access.invite_url (review 2026-07-15).
  it('should parse an http(s) guest_access.invite_url', () => {
    const yaml = withGuestBlock('  guest_access:\n    enabled: true\n    invite_url: "https://discord.gg/x"\n');
    const path = writeFixture('guest-invite.yml', yaml);

    const config = loadConfig(path);

    expect(config.access_control.guest_access?.invite_url).toBe('https://discord.gg/x');
  });

  it('should coerce a blank guest_access.invite_url to undefined instead of aborting boot', () => {
    const yaml = withGuestBlock('  guest_access:\n    enabled: true\n    invite_url: ""\n');
    const path = writeFixture('guest-invite-blank.yml', yaml);

    const config = loadConfig(path);

    expect(config.access_control.guest_access?.enabled).toBe(true);
    expect(config.access_control.guest_access?.invite_url).toBeUndefined();
  });

  it('should reject a non-http(s) guest_access.invite_url scheme', () => {
    const yaml = withGuestBlock('  guest_access:\n    enabled: true\n    invite_url: "javascript:alert(1)"\n');
    const path = writeFixture('guest-invite-bad-scheme.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/invite_url|guest_access/);
  });

  it('should interpolate ${ENV_VAR} placeholders from process.env', () => {
    const previous = process.env.DISCORD_GUILD_ID;
    process.env.DISCORD_GUILD_ID = '999999999999999999';
    try {
      const yaml = VALID_YAML.replace('"111111111111111111"', '"${DISCORD_GUILD_ID}"');
      const path = writeFixture('interp.yml', yaml);

      const config = loadConfig(path);

      expect(config.discord.guild_id).toBe('999999999999999999');
    } finally {
      if (previous === undefined) delete process.env.DISCORD_GUILD_ID;
      else process.env.DISCORD_GUILD_ID = previous;
    }
  });

  it('should throw a descriptive error when a referenced env var is unset', () => {
    delete process.env.SHARE2BRAIN_TEST_UNSET_VAR;
    const yaml = VALID_YAML.replace('"111111111111111111"', '"${SHARE2BRAIN_TEST_UNSET_VAR}"');
    const path = writeFixture('unset.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/SHARE2BRAIN_TEST_UNSET_VAR/);
  });

  it('should confine ${VAR} interpolation to the string value, not inject YAML structure (M-6)', () => {
    const previous = process.env.SHARE2BRAIN_TEST_EVIL;
    // A secret whose value contains YAML metacharacters (newline + a sibling key).
    // Interpolating the RAW text (the old approach) would have injected a new
    // top-level key; interpolating the parsed tree keeps it a literal string.
    process.env.SHARE2BRAIN_TEST_EVIL = 'sk-real\nallowed_origins: ["*"]';
    try {
      const yaml = VALID_YAML.replace('"sk-ant-test"', '"${SHARE2BRAIN_TEST_EVIL}"');
      const path = writeFixture('evil.yml', yaml);

      const config = loadConfig(path);

      expect(config.agent.api_key).toBe('sk-real\nallowed_origins: ["*"]');
      // The injected key did NOT leak into the real allowed_origins.
      expect(config.security.allowed_origins).toEqual(['http://localhost:5173']);
    } finally {
      if (previous === undefined) delete process.env.SHARE2BRAIN_TEST_EVIL;
      else process.env.SHARE2BRAIN_TEST_EVIL = previous;
    }
  });

  it('should reject out-of-bounds numeric behavior fields (M-8)', () => {
    const overIter = writeFixture('iter.yml', VALID_YAML.replace('max_iterations: 10', 'max_iterations: 1000000000'));
    expect(() => loadConfig(overIter)).toThrow(/max_iterations/);

    const badTemp = writeFixture('temp.yml', VALID_YAML.replace('temperature: 0.7', 'temperature: 99'));
    expect(() => loadConfig(badTemp)).toThrow(/temperature/);

    const badTtl = writeFixture('ttl.yml', VALID_YAML.replace('role_cache_ttl: 300', 'role_cache_ttl: -1'));
    expect(() => loadConfig(badTtl)).toThrow(/role_cache_ttl/);
  });

  it('should default security.cookie_secure to undefined and parse it when present (M-2)', () => {
    expect(loadConfig(writeFixture('nocookie.yml', VALID_YAML)).security.cookie_secure).toBeUndefined();

    const yaml = VALID_YAML.replace(
      '  allowed_origins:\n    - "http://localhost:5173"',
      '  cookie_secure: false\n  allowed_origins:\n    - "http://localhost:5173"',
    );
    expect(loadConfig(writeFixture('cookie.yml', yaml)).security.cookie_secure).toBe(false);
  });

  it('should parse an optional enrichment.rate_limit block and validate it (M-5)', () => {
    expect(loadConfig(writeFixture('norl.yml', VALID_YAML)).enrichment.rate_limit).toBeUndefined();

    // Appended under the existing enrichment block (block_private_ips is its last field).
    const withRl = VALID_YAML.replace(
      '    block_private_ips: true\n',
      '    block_private_ips: true\n  rate_limit:\n    enabled: true\n    per_author_hourly: 5\n    global_daily: 500\n',
    );
    expect(loadConfig(writeFixture('rl.yml', withRl)).enrichment.rate_limit).toEqual({
      enabled: true,
      per_author_hourly: 5,
      global_daily: 500,
    });

    const badRl = VALID_YAML.replace(
      '    block_private_ips: true\n',
      '    block_private_ips: true\n  rate_limit:\n    enabled: true\n    per_author_hourly: 0\n    global_daily: 500\n',
    );
    expect(() => loadConfig(writeFixture('rlbad.yml', badRl))).toThrow(/per_author_hourly|rate_limit/);
  });

  it('should throw a descriptive error when a required key is missing', () => {
    const yaml = VALID_YAML.replace(/agent:[\s\S]*?api_key: "sk-ant-test"\n/, '');
    const path = writeFixture('missing-key.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/agent/);
  });

  it('should reject a non-numeric or empty Discord snowflake id (S-6)', () => {
    const empty = writeFixture('gid-empty.yml', VALID_YAML.replace('"111111111111111111"', '""'));
    expect(() => loadConfig(empty)).toThrow(/guild_id|snowflake/i);

    const nonNumeric = writeFixture('cid-nan.yml', VALID_YAML.replace('id: "1234567890"', 'id: "not-a-snowflake"'));
    expect(() => loadConfig(nonNumeric)).toThrow(/snowflake|channels/i);
  });

  it('should reject a "*" or path-bearing allowed_origin (S-8)', () => {
    const wild = writeFixture('cors-star.yml', VALID_YAML.replace('"http://localhost:5173"', '"*"'));
    expect(() => loadConfig(wild)).toThrow(/allowed_origins|origin/i);

    const withPath = writeFixture('cors-path.yml', VALID_YAML.replace('"http://localhost:5173"', '"http://localhost:5173/app"'));
    expect(() => loadConfig(withPath)).toThrow(/allowed_origins|origin/i);
  });

  it('should accept an empty sentry_dsn but reject a malformed one (S-5)', () => {
    expect(loadConfig(writeFixture('sentry-empty.yml', VALID_YAML)).observability.sentry_dsn).toBe('');

    const bad = writeFixture('sentry-bad.yml', VALID_YAML.replace('sentry_dsn: ""', 'sentry_dsn: "not a url"'));
    expect(() => loadConfig(bad)).toThrow(/sentry_dsn/i);
  });

  // Story ops-6: the optional observability.tracing sub-block (AC6). Absent ⇒ Noop
  // (consumers resolve endpoint ''); empty endpoint OK (S-5 feature flag); a
  // malformed endpoint fails loud at load; provider defaults to 'phoenix'.
  it('should accept an ABSENT tracing block (VALID_YAML has none) — resolves to undefined', () => {
    const config = loadConfig(writeFixture('tracing-absent.yml', VALID_YAML));
    expect(config.observability.tracing).toBeUndefined();
  });

  it('should accept an empty tracing endpoint and default the provider to "phoenix" (S-5)', () => {
    const yaml = VALID_YAML.replace(
      'observability:\n  sentry_dsn: ""',
      'observability:\n  tracing:\n    endpoint: ""\n  sentry_dsn: ""',
    );
    const config = loadConfig(writeFixture('tracing-empty.yml', yaml));
    expect(config.observability.tracing?.endpoint).toBe('');
    expect(config.observability.tracing?.provider).toBe('phoenix');
  });

  it('should reject a malformed tracing endpoint, naming the field', () => {
    const yaml = VALID_YAML.replace(
      'observability:\n  sentry_dsn: ""',
      'observability:\n  tracing:\n    endpoint: "not a url"\n  sentry_dsn: ""',
    );
    expect(() => loadConfig(writeFixture('tracing-bad.yml', yaml))).toThrow(/tracing\.endpoint/i);
  });

  it('should accept a valid tracing endpoint with an explicit provider', () => {
    const yaml = VALID_YAML.replace(
      'observability:\n  sentry_dsn: ""',
      'observability:\n  tracing:\n    provider: "phoenix"\n    endpoint: "http://phoenix:6006"\n  sentry_dsn: ""',
    );
    const config = loadConfig(writeFixture('tracing-valid.yml', yaml));
    expect(config.observability.tracing?.endpoint).toBe('http://phoenix:6006');
    expect(config.observability.tracing?.provider).toBe('phoenix');
  });

  it('should reject a non-HTTPS slack webhook_url when notifications are enabled (S-5)', () => {
    const yaml = `${VALID_YAML}notifications:\n  enabled: true\n  provider: "slack"\n  slack:\n    webhook_url: "http://hooks.example.com/x"\n`;
    expect(() => loadConfig(writeFixture('slack-http.yml', yaml))).toThrow(/webhook_url|HTTPS/i);
  });

  it('should throw when the YAML is malformed', () => {
    const path = writeFixture('bad.yml', 'version: "1.0"\n  : : : not valid yaml :');

    expect(() => loadConfig(path)).toThrow();
  });

  it('should throw when the config file does not exist', () => {
    expect(() => loadConfig(join(dir, 'does-not-exist.yml'))).toThrow();
  });

  it('should reject embeddings.provider "anthropic" with an embeddings-specific message', () => {
    const yaml = VALID_YAML.replace('provider: "openai"', 'provider: "anthropic"');
    const path = writeFixture('emb-anthropic.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/embeddings.*[Aa]nthropic|[Aa]nthropic.*embeddings/);
  });

  it('should reject agent.provider "custom" without a base_url, naming base_url', () => {
    const yaml = VALID_YAML.replace('provider: "anthropic"', 'provider: "custom"');
    const path = writeFixture('agent-custom-no-url.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/agent.*base_url|base_url.*agent/);
  });

  it('should reject embeddings.provider "custom" without a base_url, naming base_url', () => {
    const yaml = VALID_YAML.replace('provider: "openai"', 'provider: "custom"');
    const path = writeFixture('emb-custom-no-url.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/embeddings.*base_url|base_url.*embeddings/);
  });

  it('should reject two ENABLED channels sharing the same id', () => {
    const yaml = VALID_YAML.replace(
      '  channels:\n    - id: "1234567890"\n      name: "general"\n      enabled: true\n',
      '  channels:\n    - id: "1234567890"\n      name: "general"\n      enabled: true\n' +
        '    - id: "1234567890"\n      name: "general-2"\n      enabled: true\n',
    );
    const path = writeFixture('dup-channel-enabled.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/duplicate.*id|id.*duplicate/i);
  });

  it('should accept two DISABLED channels sharing the same id (no runtime effect)', () => {
    const yaml = VALID_YAML.replace(
      '  channels:\n    - id: "1234567890"\n      name: "general"\n      enabled: true\n',
      '  channels:\n    - id: "1234567890"\n      name: "general"\n      enabled: false\n' +
        '    - id: "1234567890"\n      name: "general-2"\n      enabled: false\n',
    );
    const path = writeFixture('dup-channel-disabled.yml', yaml);

    expect(() => loadConfig(path)).not.toThrow();
  });

  it('should accept provider "custom" when base_url is present', () => {
    const yaml = VALID_YAML.replace(
      'provider: "openai"\n  model: "text-embedding-3-small"',
      'provider: "custom"\n  base_url: "https://llm.internal/v1"\n  model: "text-embedding-3-small"',
    );
    const path = writeFixture('emb-custom-ok.yml', yaml);

    const config = loadConfig(path);

    expect(config.embeddings.provider).toBe('custom');
    expect(config.embeddings.base_url).toBe('https://llm.internal/v1');
  });

  it('should accept an empty base_url for non-custom providers (shipped-config pattern)', () => {
    // Mirrors Share2Brain.config.yml: base_url references ${LLM_BASE_URL}/${EMBEDDINGS_BASE_URL},
    // which interpolate to "" when the operator leaves them blank (non-custom).
    const yaml = VALID_YAML.replace(
      '  api_key: "sk-ant-test"',
      '  api_key: "sk-ant-test"\n  base_url: ""',
    ).replace('  api_key: "sk-openai-test"', '  api_key: "sk-openai-test"\n  base_url: ""');
    const path = writeFixture('empty-base-url.yml', yaml);

    const config = loadConfig(path);

    expect(config.agent.base_url).toBe('');
    expect(config.embeddings.base_url).toBe('');
  });

  it('should reject a non-positive embeddings.dimensions', () => {
    const yaml = VALID_YAML.replace('dimensions: 1536', 'dimensions: 0');
    const path = writeFixture('dim-zero.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/dimensions/);
  });

  it('should reject a non-integer embeddings.dimensions', () => {
    const yaml = VALID_YAML.replace('dimensions: 1536', 'dimensions: 15.5');
    const path = writeFixture('dim-float.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/dimensions/);
  });

  it('should reject a malformed rate_limit tier (non-positive window_ms)', () => {
    const yaml = VALID_YAML.replace('window_ms: 900000\n      max_requests: 100', 'window_ms: 0\n      max_requests: 100');
    const path = writeFixture('rate-limit-bad-tier.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/rate_limit/);
  });

  it('should accept a config with notifications enabled and valid telegram credentials', () => {
    const yaml =
      VALID_YAML +
      `notifications:
  enabled: true
  provider: "telegram"
  telegram:
    bot_token: "test-bot-token"
    chat_id: "123456789"
`;
    const path = writeFixture('notifications-telegram-ok.yml', yaml);

    const config = loadConfig(path);

    expect(config.notifications).toEqual({
      enabled: true,
      provider: 'telegram',
      telegram: { bot_token: 'test-bot-token', chat_id: '123456789' },
    });
  });

  it('should accept a config with notifications enabled and valid slack credentials', () => {
    const yaml =
      VALID_YAML +
      `notifications:
  enabled: true
  provider: "slack"
  slack:
    webhook_url: "https://hooks.slack.com/services/test"
`;
    const path = writeFixture('notifications-slack-ok.yml', yaml);

    const config = loadConfig(path);

    expect(config.notifications?.provider).toBe('slack');
    expect(config.notifications?.slack?.webhook_url).toBe('https://hooks.slack.com/services/test');
  });

  it('should reject notifications enabled with provider "telegram" but no bot_token', () => {
    const yaml =
      VALID_YAML +
      `notifications:
  enabled: true
  provider: "telegram"
`;
    const path = writeFixture('notifications-telegram-missing-creds.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/notifications.*telegram|telegram.*notifications/i);
  });

  it('should reject notifications enabled with provider "slack" but no webhook_url', () => {
    const yaml =
      VALID_YAML +
      `notifications:
  enabled: true
  provider: "slack"
`;
    const path = writeFixture('notifications-slack-missing-creds.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/notifications.*slack|slack.*notifications/i);
  });

  it('should accept notifications disabled without any provider credentials', () => {
    const yaml =
      VALID_YAML +
      `notifications:
  enabled: false
  provider: "telegram"
`;
    const path = writeFixture('notifications-disabled.yml', yaml);

    expect(() => loadConfig(path)).not.toThrow();
  });

  it('should accept a config with no notifications block at all (backward-compat)', () => {
    const path = writeFixture('no-notifications.yml', VALID_YAML);

    const config = loadConfig(path);

    expect(config.notifications).toBeUndefined();
  });

  it('should reject a config missing the enrichment block (required, Epic 7)', () => {
    const yaml = VALID_YAML.replace(
      /enrichment:[\s\S]*?block_private_ips: true\n/,
      '',
    );
    const path = writeFixture('missing-enrichment.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/enrichment/);
  });

  it('should reject enrichment.llm.provider "custom" without a base_url, naming base_url', () => {
    const yaml = VALID_YAML.replace(
      'llm:\n    provider: "anthropic"',
      'llm:\n    provider: "custom"',
    );
    const path = writeFixture('enrichment-custom-no-url.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/enrichment.*base_url|base_url.*enrichment/);
  });

  it('should accept enrichment.llm.provider "custom" when base_url is present', () => {
    const yaml = VALID_YAML.replace(
      'llm:\n    provider: "anthropic"\n    model: "claude-sonnet-4-6"',
      'llm:\n    provider: "custom"\n    base_url: "https://llm.internal/v1"\n    model: "claude-sonnet-4-6"',
    );
    const path = writeFixture('enrichment-custom-ok.yml', yaml);

    const config = loadConfig(path);

    expect(config.enrichment.llm.provider).toBe('custom');
    expect(config.enrichment.llm.base_url).toBe('https://llm.internal/v1');
  });

  it('should reject an empty enrichment.language', () => {
    const yaml = VALID_YAML.replace('language: "en"', 'language: ""');
    const path = writeFixture('enrichment-empty-language.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/language/);
  });

  it('should reject an invalid enrichment.fetch.allowed_schemes entry', () => {
    const yaml = VALID_YAML.replace(
      'allowed_schemes:\n      - "https"',
      'allowed_schemes:\n      - "ftp"',
    );
    const path = writeFixture('enrichment-bad-scheme.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/allowed_schemes/);
  });

  it('should reject a non-positive enrichment.fetch.timeout_ms', () => {
    const yaml = VALID_YAML.replace('timeout_ms: 5000', 'timeout_ms: 0');
    const path = writeFixture('enrichment-bad-timeout.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/timeout_ms/);
  });

  it('should reject a non-positive enrichment.fetch.max_bytes', () => {
    const yaml = VALID_YAML.replace('max_bytes: 2000000', 'max_bytes: 0');
    const path = writeFixture('enrichment-bad-max-bytes.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/max_bytes/);
  });

  it('should reject a non-empty invalid enrichment.llm.base_url', () => {
    const yaml = VALID_YAML.replace(
      'api_key: "sk-ant-enrichment-test"',
      'api_key: "sk-ant-enrichment-test"\n    base_url: "not-a-url"',
    );
    const path = writeFixture('enrichment-bad-base-url.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/base_url/);
  });

  it('should reject an empty enrichment.fetch.allowed_schemes list', () => {
    const yaml = VALID_YAML.replace(
      'allowed_schemes:\n      - "https"',
      'allowed_schemes: []',
    );
    const path = writeFixture('enrichment-empty-schemes.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/allowed_schemes/);
  });

  it('should reject a negative enrichment.fetch.max_redirects', () => {
    const yaml = VALID_YAML.replace('max_redirects: 3', 'max_redirects: -1');
    const path = writeFixture('enrichment-bad-max-redirects.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/max_redirects/);
  });
});
