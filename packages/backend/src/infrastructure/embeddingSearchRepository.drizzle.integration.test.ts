// Integration test for the pgvector search adapter against a REAL Postgres +
// pgvector — this is where the value lives (AD-12 RBAC-in-query, cosine ordering,
// D1 deleted_at exclusion). A deterministic one-hot vector scheme makes similarity
// exact and assertable; no real embeddings API is involved.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDrizzleEmbeddingSearchRepository } from './embeddingSearchRepository.drizzle.js';
import { openTestClients, type TestClients } from '../test-helpers.js';

const DIMENSIONS = 1536;

/** A one-hot vector of width DIMENSIONS with `value` at `index` (default 1). */
function oneHot(index: number, value = 1): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[index] = value;
  return v;
}

/** pgvector text literal for a number[] (exactly `[a,b,c]`). */
function vecLiteral(v: number[]): string {
  return JSON.stringify(v);
}

describe('EmbeddingSearchRepository (integration, real pgvector)', () => {
  let clients: TestClients;
  const suffix = `itest-4-1-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
  const CH_ALLOWED = `chan-allowed-${suffix}`;
  const CH_DENIED = `chan-denied-${suffix}`;

  async function seedMessage(id: string, channelId: string, deleted = false): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at, deleted_at)
      values (${id}, ${channelId}, 'itest-guild', ${`author-${id}`}, 'msg content', now(), now(),
              ${deleted ? sql`now()` : sql`null`})
    `);
  }

  async function seedEmbedding(
    chunkKey: string,
    channelId: string,
    messageIds: string[],
    vec: number[],
  ): Promise<void> {
    // Pass message_ids as a single Postgres array-literal string (`{a,b}`) — a raw
    // JS array in a drizzle `sql` template is expanded into comma-separated params.
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    await clients.db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, '', ${`description ${chunkKey}`}, '', ${vecLiteral(vec)}::vector, ${channelId},
              ${messageIdsLiteral}::text[], now())
    `);
  }

  beforeAll(async () => {
    clients = await openTestClients();

    // channel_permissions rows exist only so the INNER JOIN resolves channelName;
    // the adapter takes allowedChannelIds directly, so allowedRoles are irrelevant here.
    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY['member']::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    // Anchor messages (message_ids[0]) for each chunk.
    await seedMessage(`${suffix}-a`, CH_ALLOWED);
    await seedMessage(`${suffix}-b`, CH_ALLOWED);
    await seedMessage(`${suffix}-c`, CH_DENIED);
    // fragD's group: a clean anchor + a soft-deleted sibling (proves exclude-if-ANY
    // even when the anchor itself is not deleted).
    await seedMessage(`${suffix}-d`, CH_ALLOWED);
    await seedMessage(`${suffix}-d-del`, CH_ALLOWED, true);

    // Query is one-hot at index 0. Similarities against it:
    //  A: identical            → 1.0   (allowed)
    //  B: 0.5·e0 + 0.5·e1      → ~0.707 (allowed, less similar)
    //  C: identical            → 1.0   (DENIED channel — must never surface, proving RBAC beats similarity)
    //  D: identical            → 1.0   (allowed, but a group member is deleted — must be excluded)
    await seedEmbedding(`${suffix}-a:0`, CH_ALLOWED, [`${suffix}-a`], oneHot(0));
    const half = new Array<number>(DIMENSIONS).fill(0);
    half[0] = 0.5;
    half[1] = 0.5;
    await seedEmbedding(`${suffix}-b:0`, CH_ALLOWED, [`${suffix}-b`], half);
    await seedEmbedding(`${suffix}-c:0`, CH_DENIED, [`${suffix}-c`], oneHot(0));
    await seedEmbedding(`${suffix}-d:0`, CH_ALLOWED, [`${suffix}-d`, `${suffix}-d-del`], oneHot(0));
    // fragE: allowed channel, identical vector, but its anchor (message_ids[0])
    // has NO discord_messages row — documents the intentional INNER-JOIN drop.
    await seedEmbedding(`${suffix}-e:0`, CH_ALLOWED, [`${suffix}-ghost`], oneHot(0));
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`delete from embeddings where chunk_key like ${`${suffix}%`}`);
    await db.execute(sql`delete from discord_messages where id like ${`${suffix}%`}`);
    await db.execute(sql`delete from channel_permissions where channel_id like ${`%${suffix}`}`);
    await clients.close();
  });

  it('should return only fragments inside allowedChannelIds — RBAC beats similarity (AC5)', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [CH_ALLOWED], 10);

    const channelIds = rows.map((r) => r.channelId);
    expect(channelIds).not.toContain(CH_DENIED);
    // The denied fragment (C) is IDENTICAL to the query — its absence proves the
    // filter is inside the query, not a post-filter over top-k.
    expect(rows.map((r) => r.messageId)).not.toContain(`${suffix}-c`);
  });

  it('should exclude a chunk whose group contains any soft-deleted message (D1)', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [CH_ALLOWED], 10);

    expect(rows.map((r) => r.messageId)).not.toContain(`${suffix}-d`);
  });

  it('should drop a chunk whose anchor message row is absent (intentional INNER JOIN)', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [CH_ALLOWED], 10);

    // fragE is identical to the query (similarity 1.0) and in an allowed channel,
    // but its anchor message does not exist — it must neither surface nor error.
    expect(rows.map((r) => r.messageId)).not.toContain(`${suffix}-ghost`);
    // Surviving set is unchanged: only A and B (D dropped by D1, C by RBAC, E anchorless).
    expect(rows.map((r) => r.messageId)).toEqual([`${suffix}-a`, `${suffix}-b`]);
  });

  it('should order results by descending cosine similarity (AC1.4)', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [CH_ALLOWED], 10);

    // Only A (1.0) and B (~0.707) survive RBAC + delete filters.
    expect(rows.map((r) => r.messageId)).toEqual([`${suffix}-a`, `${suffix}-b`]);
    expect(rows[0].similarity).toBeGreaterThan(rows[1].similarity);
    expect(rows[0].similarity).toBeCloseTo(1, 3);
    // Similarities are clamped to [0,1].
    for (const r of rows) {
      expect(r.similarity).toBeGreaterThanOrEqual(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
  });

  it('should project the anchor fields and channelName (D2)', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [CH_ALLOWED], 10);
    const top = rows[0];

    expect(top.messageId).toBe(`${suffix}-a`);
    expect(top.channelId).toBe(CH_ALLOWED);
    expect(top.channelName).toBe('Allowed Channel');
    expect(top.authorId).toBe(`author-${suffix}-a`);
    expect(top.authorName).toBe(top.authorId); // D2: no display name yet
    expect(typeof top.createdAt).toBe('string');
    expect(() => new Date(top.createdAt).toISOString()).not.toThrow();
  });

  it('should respect the limit', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [CH_ALLOWED], 1);

    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(`${suffix}-a`); // the most similar
  });

  it('should return [] without touching the DB when the scope is empty (AC3)', async () => {
    const repo = createDrizzleEmbeddingSearchRepository(clients.db);

    const rows = await repo.searchByEmbedding(oneHot(0), [], 10);

    expect(rows).toEqual([]);
  });
});
