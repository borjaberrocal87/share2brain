// Structural parity between es.json and en.json (Story 10.2, AC2): both
// directions checked so a key added to one locale and forgotten in the other
// fails loudly, instead of silently falling back at runtime.
import { describe, expect, it } from 'vitest';

import en from './en.json';
import es from './es.json';

function keyPaths(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    keyPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('locale key-tree parity', () => {
  it('should have no keys present in es.json but missing from en.json', () => {
    const esKeys = new Set(keyPaths(es));
    const enKeys = new Set(keyPaths(en));
    const missing = [...esKeys].filter((k) => !enKeys.has(k));

    expect(missing).toEqual([]);
  });

  it('should have no keys present in en.json but missing from es.json', () => {
    const esKeys = new Set(keyPaths(es));
    const enKeys = new Set(keyPaths(en));
    const extra = [...enKeys].filter((k) => !esKeys.has(k));

    expect(extra).toEqual([]);
  });
});
