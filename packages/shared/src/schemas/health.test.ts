import { describe, expect, it } from 'vitest';

import { HealthResponseSchema } from './health.js';

describe('HealthResponseSchema', () => {
  it('should parse a healthy response when both gating components are connected', () => {
    const result = HealthResponseSchema.safeParse({
      status: 'healthy',
      components: {
        database: 'connected',
        redis: 'connected',
        discord: 'pending',
        indexer: 'pending',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should parse a degraded response when the database is disconnected', () => {
    const result = HealthResponseSchema.safeParse({
      status: 'degraded',
      components: {
        database: 'disconnected',
        redis: 'connected',
        discord: 'pending',
        indexer: 'pending',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject a status outside healthy | degraded', () => {
    const result = HealthResponseSchema.safeParse({
      status: 'ok',
      components: {
        database: 'connected',
        redis: 'connected',
        discord: 'pending',
        indexer: 'pending',
      },
    });
    expect(result.success).toBe(false);
  });

  it('should reject when a gating component uses the pending status', () => {
    const result = HealthResponseSchema.safeParse({
      status: 'healthy',
      components: {
        database: 'pending',
        redis: 'connected',
        discord: 'pending',
        indexer: 'pending',
      },
    });
    expect(result.success).toBe(false);
  });

  it('should reject when a component field is missing', () => {
    const result = HealthResponseSchema.safeParse({
      status: 'healthy',
      components: { database: 'connected', redis: 'connected', discord: 'pending' },
    });
    expect(result.success).toBe(false);
  });
});
