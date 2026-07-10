// Integration test for the Indexer resource pipeline against a REAL Postgres +
// Redis (FR5, AD-13). Covers what unit tests can't: the real pgvector UPSERT,
// the RETURNING-gated stamp, and the real consumer-group PEL/XACK semantics
// (idempotent redelivery, failure-leaves-entry-pending). The SSRF guard and
// `fetchUrl` run for REAL against an ephemeral local HTTP server (loopback,
// `block_private_ips: false` — the documented dev-only escape hatch, apt for a
// test hitting our own server); only the LLM is faked via an injected
// `EnrichmentChatModel` — never a real embeddings/LLM call.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Share2BrainConfig } from '@share2brain/shared';
import { sql } from '@share2brain/shared/db';
import { STREAM_KEYS } from '@share2brain/shared/types/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EnrichmentChatModel } from '../enrichment/enrich.js';
import { createGuardedDispatcher, type GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Logger } from '../logger.js';
import { openTestClients, type TestClients } from '../test-helpers.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder, RawStreamEntry } from './types.js';

const STREAM = STREAM_KEYS.DISCORD_MESSAGES;
const DIMENSIONS = 1536;

const config = {
  embeddings: { dimensions: DIMENSIONS },
  enrichment: {
    language: 'en',
    fetch: {
      timeout_ms: 5_000,
      max_bytes: 2_000_000,
      max_redirects: 3,
      user_agent: 'Share2BrainIntegrationTest/1.0',
      allowed_schemes: ['http', 'https'],
      block_private_ips: false,
    },
  },
} as unknown as Share2BrainConfig;

// Silent logger — these tests assert on state, not logs.
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const guard: GuardedDispatcher = createGuardedDispatcher(config.enrichment.fetch);

const goodEmbedder: Embedder = {
  embedDocuments: (texts) => Promise.resolve(texts.map(() => new Array(DIMENSIONS).fill(0.01))),
};

/** A fake chat model whose structured-output path always succeeds with a fixed
 *  title/description — exercises the REAL `enrich.ts` prompt/normalize logic
 *  without ever calling a real LLM. */
const goodModel: EnrichmentChatModel = {
  withStructuredOutput: () => ({
    invoke: async () => ({ title: 'Integration Test Title', description: 'Integration Test Description' }),
  }),
  invoke: async () => ({ content: '{"title": "Integration Test Title", "description": "Integration Test Description"}' }),
};

/** Fails BOTH the structured-output and JSON-fallback paths — `enrich.ts`
 *  throws `EnrichmentError` after the one permitted fallback attempt (D1). */
const failingModel: EnrichmentChatModel = {
  withStructuredOutput: () => ({
    invoke: async () => {
      throw new Error('LLM provider down');
    },
  }),
  invoke: async () => {
    throw new Error('LLM provider down');
  },
};

function runSuffix(): string {
  return `itest-7-2-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

describe('Indexer resource pipeline (integration)', () => {
  let clients: TestClients;
  let localServer: http.Server;
  let localServerUrl: string;
  const createdIds: string[] = [];
  const createdStreamIds: string[] = [];
  const createdGroups: string[] = [];

  beforeAll(async () => {
    clients = await openTestClients();
    localServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Integration Fixture Page</title></head><body>hello</body></html>');
    });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (localServer.address() as AddressInfo).port;
    localServerUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    const { db, redis } = clients;
    for (const group of createdGroups) {
      await redis.xGroupDestroy(STREAM, group).catch(() => undefined);
    }
    if (createdStreamIds.length > 0) {
      await redis.xDel(STREAM, createdStreamIds).catch(() => undefined);
    }
    for (const id of createdIds) {
      await db.execute(sql`delete from embeddings where chunk_key like ${`${id}:%`}`);
      await db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    await clients.close();
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });

  /** Seed a discord_messages row (indexed_at NULL). */
  async function seedMessage(id: string, channelId: string): Promise<void> {
    createdIds.push(id);
    await clients.db.execute(
      sql`insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
          values (${id}, ${channelId}, 'itest-guild', 'itest-author', 'DB-CONTENT-MUST-NOT-BE-EMBEDDED', now(), now())`,
    );
  }

  async function xaddEvent(id: string, channelId: string, content: string): Promise<string> {
    const streamId = await clients.redis.xAdd(STREAM, '*', {
      type: 'discord.message.created',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
      content,
      authorId: 'itest-author',
    });
    createdStreamIds.push(streamId);
    return streamId;
  }

  /** Create a fresh test consumer group at the CURRENT tail so a following read of
   *  '>' delivers only the entries this test XADDs — isolating from other entries. */
  async function freshGroup(suffix: string): Promise<string> {
    const group = `share2brain:indexer:${suffix}`;
    createdGroups.push(group);
    await clients.redis.xGroupCreate(STREAM, group, '$', { MKSTREAM: true });
    return group;
  }

  async function readAsGroup(group: string): Promise<RawStreamEntry[]> {
    const res = await clients.redis.xReadGroup(
      group,
      'consumer-itest',
      { key: STREAM, id: '>' },
      { COUNT: 100 },
    );
    return (res?.[0]?.messages ?? []) as RawStreamEntry[];
  }

  it('should fetch a URL message, persist a real title/description/link row, stamp indexed_at, and drain the PEL', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-a`;
    const channelId = `chan-${suffix}`;
    const group = await freshGroup(suffix);
    await seedMessage(id, channelId);
    await xaddEvent(id, channelId, `check out ${localServerUrl}/resource please`);

    const entries = await readAsGroup(group);
    expect(entries.map((e) => e.message?.messageId)).toContain(id);

    const controller = new AbortController();
    const { ackIds } = await indexBatch({
      entries,
      db: clients.db,
      embedder: goodEmbedder,
      config,
      logger,
      enrichModel: goodModel,
      guard,
      signal: controller.signal,
    });
    for (const aid of ackIds) await clients.redis.xAck(STREAM, group, aid);

    const rows = await clients.db.execute(
      sql`select chunk_key, title, description, link, channel_id, message_ids, vector_dims(embedding) as dims
          from embeddings where chunk_key = ${`${id}:0`}`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as Record<string, unknown>;
    expect(row.title).toBe('Integration Test Title');
    expect(row.description).toBe('Integration Test Description');
    expect(row.link).toBe(`${localServerUrl}/resource`);
    expect(row.channel_id).toBe(channelId);
    expect(row.dims).toBe(DIMENSIONS);
    expect(row.message_ids).toEqual([id]);

    const dm = await clients.db.execute(sql`select indexed_at from discord_messages where id = ${id}`);
    expect((dm.rows[0] as Record<string, unknown>).indexed_at).not.toBeNull();

    const pending = await clients.redis.xPending(STREAM, group);
    expect(pending.pending).toBe(0);
  });

  it('should discard a no-URL message: stamp indexed_at, ack, and persist zero rows', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-nourl`;
    const channelId = `chan-${suffix}`;
    const group = await freshGroup(suffix);
    await seedMessage(id, channelId);
    await xaddEvent(id, channelId, 'just chatting here, no links at all');

    const entries = await readAsGroup(group);
    const controller = new AbortController();
    const { ackIds } = await indexBatch({
      entries,
      db: clients.db,
      embedder: goodEmbedder,
      config,
      logger,
      enrichModel: goodModel,
      guard,
      signal: controller.signal,
    });
    for (const aid of ackIds) await clients.redis.xAck(STREAM, group, aid);

    expect(ackIds).toHaveLength(entries.length);

    const count = await clients.db.execute(
      sql`select count(*)::int as n from embeddings where message_ids @> array[${id}]::text[]`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(0);

    const dm = await clients.db.execute(sql`select indexed_at from discord_messages where id = ${id}`);
    expect((dm.rows[0] as Record<string, unknown>).indexed_at).not.toBeNull();

    const pending = await clients.redis.xPending(STREAM, group);
    expect(pending.pending).toBe(0);
  });

  it('should converge to a single row on redelivery (chunk_key UPSERT) — idempotency (AD-13)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-b`;
    const channelId = `chan-${suffix}`;
    const content = `see ${localServerUrl}/resource`;
    await seedMessage(id, channelId);

    // First pass → one row, indexed_at stamped.
    const group1 = await freshGroup(`${suffix}-1`);
    await xaddEvent(id, channelId, content);
    const first = await readAsGroup(group1);
    const controller = new AbortController();
    const r1 = await indexBatch({
      entries: first,
      db: clients.db,
      embedder: goodEmbedder,
      config,
      logger,
      enrichModel: goodModel,
      guard,
      signal: controller.signal,
    });
    for (const aid of r1.ackIds) await clients.redis.xAck(STREAM, group1, aid);

    // Second pass, same message — now indexed_at is set, so dedup ackNow skips it
    // (redelivery is a no-op ack, not a re-insert).
    const group2 = await freshGroup(`${suffix}-2`);
    await xaddEvent(id, channelId, content);
    const second = await readAsGroup(group2);
    const r2 = await indexBatch({
      entries: second,
      db: clients.db,
      embedder: goodEmbedder,
      config,
      logger,
      enrichModel: goodModel,
      guard,
      signal: controller.signal,
    });
    expect(r2.ackIds).toHaveLength(second.length);

    // Force the chunk_key UPSERT path too: clear indexed_at and reprocess.
    await clients.db.execute(sql`update discord_messages set indexed_at = null where id = ${id}`);
    const group3 = await freshGroup(`${suffix}-3`);
    await xaddEvent(id, channelId, content);
    const third = await readAsGroup(group3);
    const r3 = await indexBatch({
      entries: third,
      db: clients.db,
      embedder: goodEmbedder,
      config,
      logger,
      enrichModel: goodModel,
      guard,
      signal: controller.signal,
    });
    for (const aid of r3.ackIds) await clients.redis.xAck(STREAM, group3, aid);

    const count = await clients.db.execute(
      sql`select count(*)::int as n from embeddings where message_ids @> array[${id}]::text[]`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('should leave the entry pending (un-acked, indexed_at NULL) when enrichment fails (D1)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-c`;
    const channelId = `chan-${suffix}`;
    const group = await freshGroup(suffix);
    await seedMessage(id, channelId);
    await xaddEvent(id, channelId, `see ${localServerUrl}/resource — this one will fail enrichment`);

    const entries = await readAsGroup(group);
    const controller = new AbortController();
    const { ackIds } = await indexBatch({
      entries,
      db: clients.db,
      embedder: goodEmbedder,
      config,
      logger,
      enrichModel: failingModel,
      guard,
      signal: controller.signal,
    });
    for (const aid of ackIds) await clients.redis.xAck(STREAM, group, aid);

    expect(ackIds).toHaveLength(0);

    const pending = await clients.redis.xPending(STREAM, group);
    expect(pending.pending).toBe(1);

    const dm = await clients.db.execute(sql`select indexed_at from discord_messages where id = ${id}`);
    expect((dm.rows[0] as Record<string, unknown>).indexed_at).toBeNull();

    const count = await clients.db.execute(
      sql`select count(*)::int as n from embeddings where chunk_key = ${`${id}:0`}`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(0);
  });

  it('should reject a duplicate consumer-group creation with BUSYGROUP (AC-1 tolerance basis)', async () => {
    const suffix = runSuffix();
    const group = `share2brain:indexer:${suffix}-busy`;
    createdGroups.push(group);

    await clients.redis.xGroupCreate(STREAM, group, '$', { MKSTREAM: true });

    await expect(clients.redis.xGroupCreate(STREAM, group, '$', { MKSTREAM: true })).rejects.toThrow(
      /^BUSYGROUP/,
    );
  });
});
