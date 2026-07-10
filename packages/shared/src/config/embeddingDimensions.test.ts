import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEmbeddingDimensions } from './embeddingDimensions.js';

describe('readEmbeddingDimensions', () => {
  let dir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share2brain-dims-'));
    previousPath = process.env.SHARE2BRAIN_CONFIG_PATH;
    // Silence the intentional fallback warning noise in the tests that assert it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.SHARE2BRAIN_CONFIG_PATH;
    else process.env.SHARE2BRAIN_CONFIG_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should return the configured dimensions when the YAML provides a positive integer', () => {
    const path = join(dir, 'config.yml');
    writeFileSync(path, 'embeddings:\n  dimensions: 3072\n', 'utf8');
    process.env.SHARE2BRAIN_CONFIG_PATH = path;

    expect(readEmbeddingDimensions()).toBe(3072);
  });

  it('should fall back to 1536 when the config file does not exist', () => {
    process.env.SHARE2BRAIN_CONFIG_PATH = join(dir, 'missing.yml');

    expect(readEmbeddingDimensions()).toBe(1536);
  });

  it('should fall back to 1536 when embeddings.dimensions is absent', () => {
    const path = join(dir, 'no-key.yml');
    writeFileSync(path, 'embeddings:\n  provider: "openai"\n', 'utf8');
    process.env.SHARE2BRAIN_CONFIG_PATH = path;

    expect(readEmbeddingDimensions()).toBe(1536);
  });

  it('should fall back to 1536 when dimensions is not a positive integer', () => {
    const path = join(dir, 'bad-dim.yml');
    writeFileSync(path, 'embeddings:\n  dimensions: -8\n', 'utf8');
    process.env.SHARE2BRAIN_CONFIG_PATH = path;

    expect(readEmbeddingDimensions()).toBe(1536);
  });

  it('should read the value without failing on unset ${VAR} placeholders elsewhere', () => {
    const path = join(dir, 'with-placeholders.yml');
    writeFileSync(
      path,
      'discord:\n  guild_id: "${DISCORD_GUILD_ID}"\nembeddings:\n  dimensions: 1024\n  api_key: "${EMBEDDINGS_API_KEY}"\n',
      'utf8',
    );
    process.env.SHARE2BRAIN_CONFIG_PATH = path;

    // No interpolation, no Zod — the unset ${VAR}s must not abort the read.
    expect(readEmbeddingDimensions()).toBe(1024);
  });
});
