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
knowledge:
  chunk_size: 500
  chunk_overlap: 50
  grouping_window: 10
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
    window_ms: 60000
    max_requests: 20
  allowed_origins:
    - "http://localhost:5173"
`;

describe('loadConfig', () => {
  let dir: string;

  const writeFixture = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hivly-config-'));
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
    expect(config.security.rate_limit.max_requests).toBe(20);
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
    delete process.env.HIVLY_TEST_UNSET_VAR;
    const yaml = VALID_YAML.replace('"111111111111111111"', '"${HIVLY_TEST_UNSET_VAR}"');
    const path = writeFixture('unset.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/HIVLY_TEST_UNSET_VAR/);
  });

  it('should throw a descriptive error when a required key is missing', () => {
    const yaml = VALID_YAML.replace(/agent:[\s\S]*?api_key: "sk-ant-test"\n/, '');
    const path = writeFixture('missing-key.yml', yaml);

    expect(() => loadConfig(path)).toThrow(/agent/);
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
    // Mirrors Hivly.config.yml: base_url references ${LLM_BASE_URL}/${EMBEDDINGS_BASE_URL},
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
});
