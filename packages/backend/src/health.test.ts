import type { Database } from '@hivly/shared/db';
import type { RedisClient } from './infrastructure/redis.js';
import { describe, expect, it, vi } from 'vitest';

import { computeHealth } from './health.js';

/** Minimal db double: only `execute` is exercised by the probe. */
function fakeDb(execute: () => Promise<unknown>): Database {
  return { execute: vi.fn(execute) } as unknown as Database;
}

/** Minimal redis double: only `ping` is exercised by the probe. */
function fakeRedis(ping: () => Promise<unknown>): RedisClient {
  return { ping: vi.fn(ping) } as unknown as RedisClient;
}

describe('computeHealth', () => {
  it('should return 200 healthy when database and redis are both up', async () => {
    const result = await computeHealth(
      fakeDb(() => Promise.resolve([{ '?column?': 1 }])),
      fakeRedis(() => Promise.resolve('PONG')),
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('healthy');
    expect(result.body.components).toEqual({
      database: 'connected',
      redis: 'connected',
      discord: 'pending',
      indexer: 'pending',
    });
  });

  it('should return 503 degraded with database disconnected when the DB check throws', async () => {
    const result = await computeHealth(
      fakeDb(() => Promise.reject(new Error('ECONNREFUSED'))),
      fakeRedis(() => Promise.resolve('PONG')),
    );

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('degraded');
    expect(result.body.components.database).toBe('disconnected');
    expect(result.body.components.redis).toBe('connected');
  });

  it('should return 503 degraded with redis disconnected when the redis check throws', async () => {
    const result = await computeHealth(
      fakeDb(() => Promise.resolve([{ '?column?': 1 }])),
      fakeRedis(() => Promise.reject(new Error('connection lost'))),
    );

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('degraded');
    expect(result.body.components.redis).toBe('disconnected');
    expect(result.body.components.database).toBe('connected');
  });

  it('should keep discord and indexer pending regardless of gating state', async () => {
    const result = await computeHealth(
      fakeDb(() => Promise.resolve([])),
      fakeRedis(() => Promise.resolve('PONG')),
    );

    expect(result.body.components.discord).toBe('pending');
    expect(result.body.components.indexer).toBe('pending');
  });
});
