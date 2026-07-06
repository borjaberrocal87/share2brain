// Minimal, generate-time-safe reader for `embeddings.dimensions` (AC-5).
//
// schema.ts needs the vector column width, but it is imported at module load in
// several contexts — `drizzle-kit generate` at the repo root, the container
// runtime with a mounted config, and unit tests — where the full loadConfig()
// path would fail: unset `${VAR}` placeholders in unrelated fields would abort
// generate, and a missing file must not crash schema evaluation. So this reader
// deliberately does NOT interpolate env vars and does NOT run Zod validation.
// It reads one key, and on ANY problem falls back to 1536 (the validated default
// for text-embedding-3-small) so it never throws.
import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

const DEFAULT_CONFIG_FILE = 'Hivly.config.yml';
const DEFAULT_DIMENSIONS = 1536;

/**
 * Read `embeddings.dimensions` from the Hivly config for generate-time schema
 * construction. Resolution mirrors {@link loadConfig}: `HIVLY_CONFIG_PATH` env →
 * `Hivly.config.yml` in the cwd. Returns the configured value only when it is a
 * positive integer; otherwise warns once and returns {@link DEFAULT_DIMENSIONS}.
 * Never throws — a missing file or key is a fallback, not an error.
 */
export function readEmbeddingDimensions(): number {
  const path = process.env.HIVLY_CONFIG_PATH ?? DEFAULT_CONFIG_FILE;

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = parseYaml(raw) as { embeddings?: { dimensions?: unknown } } | null;
    const value = parsed?.embeddings?.dimensions;

    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
    console.warn(
      `[embeddingDimensions] config key "embeddings.dimensions" is missing or not a positive integer in "${path}"; ` +
        `falling back to ${DEFAULT_DIMENSIONS}.`,
    );
    return DEFAULT_DIMENSIONS;
  } catch (err) {
    console.warn(
      `[embeddingDimensions] failed to read config file "${path}" (${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to ${DEFAULT_DIMENSIONS}.`,
    );
    return DEFAULT_DIMENSIONS;
  }
}
