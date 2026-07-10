// Integration test for the PEL-safe trimmer against a REAL Redis (Story OPS-1
// AC-7). Proves what unit tests with fakes cannot: that the real XINFO GROUPS /
// XPENDING / XTRIM MINID path (a) removes an entry already acked by every group
// but (b) NEVER removes an entry that is still pending (unacked) in any group,
// even when it is the oldest one in the stream.
//
// Requires infra:  docker compose up -d redis   (or Homebrew redis on :6379)
// Run:             npm run test:integration
import type { RedisClient } from '@share2brain/shared/redis';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Logger } from '../logger.js';
import { openTestClients, type TestClients } from '../test-helpers.js';
import { trimStream } from './streamTrimmer.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// Run-unique key so parallel suites / crashed-run leftovers can't collide
// (Epic 4 run-unique-isolation rule; Story 6.3 salt pattern).
function runKey(): string {
  return `itest-ops1-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

async function idsIn(redis: RedisClient, stream: string): Promise<string[]> {
  const entries = await redis.xRange(stream, '-', '+');
  return entries.map((e) => e.id);
}

describe('stream trimmer (integration, real Redis)', () => {
  let clients: TestClients;
  const createdStreams: string[] = [];

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterEach(async () => {
    for (const stream of createdStreams.splice(0)) {
      await clients.redis.del(stream);
    }
  });

  it('trims an acked old entry but keeps an oldest-but-pending entry (single group)', async () => {
    const { redis } = clients;
    const stream = runKey();
    createdStreams.push(stream);
    const group = 'g1';

    await redis.xGroupCreate(stream, group, '0', { MKSTREAM: true });
    const e1 = await redis.xAdd(stream, '*', { v: '1' });
    const e2 = await redis.xAdd(stream, '*', { v: '2' });
    const e3 = await redis.xAdd(stream, '*', { v: '3' });

    // Deliver e1 + e2 to the group; ack only e1 → e2 stays pending (oldest unacked).
    await redis.xReadGroup(group, 'c1', { key: stream, id: '>' }, { COUNT: 2 });
    await redis.xAck(stream, group, e1);

    await trimStream({ redis, stream, maxLen: null, logger });

    const remaining = await idsIn(redis, stream);
    expect(remaining).not.toContain(e1); // acked + old → trimmed
    expect(remaining).toContain(e2); // pending (unacked) → survives even though oldest-remaining
    expect(remaining).toContain(e3); // undelivered → survives
  });

  it('keeps a pending entry OLDER than last-delivered (out-of-order ack) — discriminates firstId vs last-delivered', async () => {
    const { redis } = clients;
    const stream = runKey();
    createdStreams.push(stream);
    const group = 'g1';

    await redis.xGroupCreate(stream, group, '0', { MKSTREAM: true });
    const e1 = await redis.xAdd(stream, '*', { v: '1' });
    const e2 = await redis.xAdd(stream, '*', { v: '2' });
    const e3 = await redis.xAdd(stream, '*', { v: '3' });
    const e4 = await redis.xAdd(stream, '*', { v: '4' });

    // Deliver all four (last-delivered-id = e4), then ack OUT OF ORDER: e1, e3, e4
    // — leaving e2 pending. The oldest pending id (e2) is BELOW last-delivered (e4).
    await redis.xReadGroup(group, 'c1', { key: stream, id: '>' }, { COUNT: 4 });
    await redis.xAck(stream, group, e1);
    await redis.xAck(stream, group, e3);
    await redis.xAck(stream, group, e4);

    await trimStream({ redis, stream, maxLen: null, logger });

    const remaining = await idsIn(redis, stream);
    // Correct (firstId=e2) floor → trims only e1, keeps [e2,e3,e4]. A last-delivered
    // (e4) implementation would trim e1,e2,e3 and DROP the pending e2 → this asserts
    // the real PEL-safe behavior, not just MINID-vs-MAXLEN.
    expect(remaining).not.toContain(e1); // acked + oldest → trimmed
    expect(remaining).toContain(e2); // PENDING though older than last-delivered → survives
    expect(remaining).toEqual([e2, e3, e4]);
  });

  it('honors the laggier of two groups as the floor', async () => {
    const { redis } = clients;
    const stream = runKey();
    createdStreams.push(stream);

    await redis.xGroupCreate(stream, 'gA', '0', { MKSTREAM: true });
    await redis.xGroupCreate(stream, 'gB', '0');
    const e1 = await redis.xAdd(stream, '*', { v: '1' });
    const e2 = await redis.xAdd(stream, '*', { v: '2' });
    const e3 = await redis.xAdd(stream, '*', { v: '3' });
    const e4 = await redis.xAdd(stream, '*', { v: '4' });

    // gA fully caught up (reads all four, acks all) → pending 0, last-delivered e4.
    await redis.xReadGroup('gA', 'c', { key: stream, id: '>' }, { COUNT: 10 });
    for (const id of [e1, e2, e3, e4]) await redis.xAck(stream, 'gA', id);

    // gB lags: reads e1 + e2, acks only e1 → e2 pending (the laggier floor).
    await redis.xReadGroup('gB', 'c', { key: stream, id: '>' }, { COUNT: 2 });
    await redis.xAck(stream, 'gB', e1);

    await trimStream({ redis, stream, maxLen: null, logger });

    const remaining = await idsIn(redis, stream);
    expect(remaining).not.toContain(e1); // acked by both → trimmed
    expect(remaining).toEqual([e2, e3, e4]); // floor = gB's pending e2; nothing newer trimmed
  });

  it('is a no-op on a stream that does not exist', async () => {
    const { redis } = clients;
    const stream = runKey(); // never created
    createdStreams.push(stream);

    await expect(trimStream({ redis, stream, maxLen: null, logger })).resolves.toBeUndefined();
    expect(await redis.exists(stream)).toBe(0);
  });
});
