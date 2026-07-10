// Integration test for the Sync worker's link-diff processUpdate/processDelete
// against a REAL Postgres (Story 7.3, AC-9). A FAKE embedder produces
// deterministic DIMENSIONS-length vectors — a real embeddings API is NEVER
// called in tests. `fetchUrl`/the SSRF guard run for REAL against an ephemeral
// local HTTP server (loopback, `block_private_ips: false` — the documented
// dev-only escape hatch); only the LLM is faked via an injected
// `EnrichmentChatModel`. Covers what unit tests can't: the real pgvector
// wipe-and-reinsert, the FK-safe read-status cascade (note #5), the exact
// vector round-trip for a reused (kept) link, UPSERT/redelivery convergence,
// and the soft-vs-hard delete branch.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HivlyConfig } from '@hivly/shared';
import { sql } from '@hivly/shared/db';
import type { MessageDeletedEvent, MessageUpdatedEvent } from '@hivly/shared/types/events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnrichmentChatModel } from '../enrichment/enrich.js';
import { createGuardedDispatcher, type GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Embedder } from '../indexer/types.js';
import type { Logger } from '../logger.js';
import { openTestClients, type TestClients } from '../test-helpers.js';
import { processDelete as processDeleteImpl, type ProcessDeleteDeps } from './processDelete.js';
import { processUpdate as processUpdateImpl, type ProcessUpdateDeps } from './processUpdate.js';

// The consumer always supplies streamId/stream (AC-4); inject fixed values so
// these state-focused integration calls stay unchanged.
function processUpdate(deps: Omit<ProcessUpdateDeps, 'streamId' | 'stream'>) {
  return processUpdateImpl({ ...deps, streamId: 's-itest', stream: 'hivly:discord:messages:updated' });
}
function processDelete(deps: Omit<ProcessDeleteDeps, 'streamId' | 'stream'>) {
  return processDeleteImpl({ ...deps, streamId: 's-itest', stream: 'hivly:discord:messages:deleted' });
}

const DIMENSIONS = 1536;

const enrichmentConfig = {
  language: 'en',
  fetch: {
    timeout_ms: 5_000,
    max_bytes: 2_000_000,
    max_redirects: 3,
    user_agent: 'HivlyIntegrationTest/1.0',
    allowed_schemes: ['http', 'https'] as Array<'http' | 'https'>,
    block_private_ips: false,
  },
};

const softConfig = {
  embeddings: { dimensions: DIMENSIONS },
  enrichment: enrichmentConfig,
  sync: { enabled: true, sync_on_start: false, delete_policy: 'soft' },
} as unknown as HivlyConfig;

const hardConfig = {
  ...softConfig,
  sync: { enabled: true, sync_on_start: false, delete_policy: 'hard' },
} as unknown as HivlyConfig;

// Silent logger — these tests assert on state, not logs.
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const guard: GuardedDispatcher = createGuardedDispatcher(enrichmentConfig.fetch);
const signal = new AbortController().signal;

const goodEmbedder: Embedder = {
  embedDocuments: (texts) => Promise.resolve(texts.map(() => new Array(DIMENSIONS).fill(0.02))),
};

/** A fake chat model whose structured-output path always succeeds with a
 *  fixed title/description — exercises the REAL `enrich.ts` prompt/normalize
 *  logic without ever calling a real LLM. `invokeCount` lets tests assert
 *  "zero LLM calls" for a fully-kept edit (F2). */
function makeGoodModel(): { model: EnrichmentChatModel; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => ({
    title: 'Integration Test Title',
    description: 'Integration Test Description',
  }));
  const model: EnrichmentChatModel = {
    withStructuredOutput: () => ({ invoke }),
    invoke: async () => ({
      content: '{"title": "Integration Test Title", "description": "Integration Test Description"}',
    }),
  };
  return { model, invoke };
}

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
  return `itest-7-3-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

describe('Sync worker (integration)', () => {
  let clients: TestClients;
  let localServer: http.Server;
  let localServerUrl: string;
  let localServerHits = 0;
  const createdMessageIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    clients = await openTestClients();
    localServer = http.createServer((_req, res) => {
      localServerHits++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Integration Fixture Page</title></head><body>hello</body></html>');
    });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (localServer.address() as AddressInfo).port;
    localServerUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    const { db } = clients;
    for (const userId of createdUserIds) {
      await db.execute(sql`delete from user_read_status where user_id = ${userId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
    for (const id of createdMessageIds) {
      await db.execute(sql`delete from embeddings where ${id} = ANY(message_ids)`);
      await db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    await clients.close();
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });

  async function seedMessage(
    id: string,
    channelId: string,
    content: string,
    opts: { indexedAt?: boolean; authorName?: string } = {},
  ): Promise<void> {
    createdMessageIds.push(id);
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, author_name, content, created_at, updated_at, indexed_at)
      values (${id}, ${channelId}, 'itest-guild', 'itest-author', ${opts.authorName ?? null}, ${content}, now(), now(),
              ${opts.indexedAt ? sql`now()` : sql`null`})
    `);
  }

  async function seedEmbedding(
    chunkKey: string,
    channelId: string,
    messageIds: string[],
    fields: { title: string; description: string; link: string; embedding: number[] },
  ): Promise<string> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    const result = await clients.db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, ${fields.title}, ${fields.description}, ${fields.link},
              ${JSON.stringify(fields.embedding)}::vector, ${channelId}, ${messageIdsLiteral}::text[], now())
      returning id
    `);
    return String((result.rows[0] as Record<string, unknown>).id);
  }

  async function seedUser(suffix: string): Promise<string> {
    const result = await clients.db.execute(sql`
      insert into users (discord_id, username) values (${`itest-user-${suffix}`}, 'Itest User')
      returning id
    `);
    const id = String((result.rows[0] as Record<string, unknown>).id);
    createdUserIds.push(id);
    return id;
  }

  async function seedReadStatus(userId: string, embeddingId: string): Promise<void> {
    await clients.db.execute(sql`
      insert into user_read_status (user_id, embedding_id) values (${userId}, ${embeddingId})
    `);
  }

  /** Raw `db.execute` returns the pgvector column as its driver string
   *  representation (`"[0.1,0.2,...]"`), not `number[]` — that mapping only
   *  happens through the drizzle query builder (which `processUpdate` itself
   *  uses for the diff select). Parse it here so tests can assert equality
   *  against a plain `number[]` fixture. */
  async function fetchEmbeddingRows(messageId: string): Promise<Record<string, unknown>[]> {
    const result = await clients.db.execute(
      sql`select id, chunk_key, title, description, link, message_ids, embedding
          from embeddings where ${messageId} = ANY(message_ids) order by chunk_key`,
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      ...row,
      embedding: JSON.parse(row.embedding as string) as number[],
    }));
  }

  async function fetchMessage(id: string): Promise<Record<string, unknown>> {
    const result = await clients.db.execute(
      sql`select content, updated_at, indexed_at, deleted_at, author_name from discord_messages where id = ${id}`,
    );
    return result.rows[0] as Record<string, unknown>;
  }

  it('should add a new link on edit: enrich the new link, reuse the kept link exactly (no re-fetch/re-enrich)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-a`;
    const channelId = `chan-${suffix}`;
    const keptLink = `${localServerUrl}/kept-${suffix}`;
    const keptEmbedding = new Array(DIMENSIONS).fill(0.03);
    await seedMessage(id, channelId, `see ${keptLink}`, { indexedAt: true });
    await seedEmbedding(`${id}:0`, channelId, [id], {
      title: 'Kept Title',
      description: 'Kept Description',
      link: keptLink,
      embedding: keptEmbedding,
    });

    // The pgvector column's driver text representation may reformat a JS
    // float64 literal on write (float4 precision) — fetch the PRE-update
    // stored value (through the same read path as the post-update assertion)
    // so the round-trip check below isolates "does the wipe+reinsert perturb
    // it" from "does Postgres's float4 storage perturb it".
    const beforeRows = await fetchEmbeddingRows(id);
    const keptEmbeddingAsStored = beforeRows[0].embedding;

    const { model, invoke } = makeGoodModel();
    const hitsBefore = localServerHits;

    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: `keep ${keptLink} and add ${localServerUrl}/new-${suffix}`,
        authorName: 'Edited By Alice',
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    expect(invoke).toHaveBeenCalledTimes(1); // only the NEW link was enriched
    expect(localServerHits - hitsBefore).toBe(1); // only the NEW link was fetched

    const rows = await fetchEmbeddingRows(id);
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.link === keptLink);
    expect(kept).toMatchObject({ title: 'Kept Title', description: 'Kept Description' });
    expect(kept?.embedding).toEqual(keptEmbeddingAsStored); // exact round-trip, not recomputed

    const fresh = rows.find((r) => r.link === `${localServerUrl}/new-${suffix}`);
    expect(fresh).toMatchObject({ title: 'Integration Test Title', description: 'Integration Test Description' });

    const dm = await fetchMessage(id);
    expect(dm.author_name).toBe('Edited By Alice'); // edits DO refresh author_name (D4)
  });

  it('should treat a previously-discarded message (no old rows) whose edit adds a URL as a late index entry', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-late`;
    const channelId = `chan-${suffix}`;
    // Simulates the Indexer's discard path: indexed_at stamped, zero embedding rows.
    await seedMessage(id, channelId, 'no links here', { indexedAt: true });

    const { model } = makeGoodModel();
    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: `edited in a link ${localServerUrl}/late-${suffix}`,
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    const rows = await fetchEmbeddingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].link).toBe(`${localServerUrl}/late-${suffix}`);
  });

  it('should purge a removed link and cascade its read-status (FK-safe)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-removed`;
    const channelId = `chan-${suffix}`;
    const oldLink = `${localServerUrl}/removed-${suffix}`;
    await seedMessage(id, channelId, `see ${oldLink}`, { indexedAt: true });
    const oldEmbeddingId = await seedEmbedding(`${id}:0`, channelId, [id], {
      title: 'Old Title',
      description: 'Old Description',
      link: oldLink,
      embedding: new Array(DIMENSIONS).fill(0.01),
    });
    const userId = await seedUser(suffix);
    await seedReadStatus(userId, oldEmbeddingId);

    const { model } = makeGoodModel();
    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: 'no more links in this edit',
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(0);

    const staleReadStatus = await clients.db.execute(
      sql`select 1 from user_read_status where embedding_id = ${oldEmbeddingId}`,
    );
    expect(staleReadStatus.rows).toHaveLength(0);

    const dm = await fetchMessage(id);
    expect(dm.content).toBe('no more links in this edit');
    expect(dm.indexed_at).not.toBeNull();
  });

  it('should make zero LLM/fetch calls on a text-only edit that keeps the same link', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-unchanged`;
    const channelId = `chan-${suffix}`;
    const link = `${localServerUrl}/unchanged-${suffix}`;
    await seedMessage(id, channelId, `see ${link}`, { indexedAt: true, authorName: 'Original Author' });
    const embedding = new Array(DIMENSIONS).fill(0.04);
    await seedEmbedding(`${id}:0`, channelId, [id], {
      title: 'Unchanged Title',
      description: 'Unchanged Description',
      link,
      embedding,
    });

    const beforeRows = await fetchEmbeddingRows(id);
    const embeddingAsStored = beforeRows[0].embedding;

    const { model, invoke } = makeGoodModel();
    const hitsBefore = localServerHits;

    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: `some extra surrounding text but same link ${link}`,
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(localServerHits).toBe(hitsBefore);

    const rows = await fetchEmbeddingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Unchanged Title', description: 'Unchanged Description' });
    expect(rows[0].embedding).toEqual(embeddingAsStored);

    const dm = await fetchMessage(id);
    expect(dm.author_name).toBe('Original Author'); // absent authorName never blanks the stored name
  });

  it('should purge every row on a zero-URL edit and stamp indexed_at (F3)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-zerourl`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, `see ${localServerUrl}/gone-${suffix}`, { indexedAt: true });
    await seedEmbedding(`${id}:0`, channelId, [id], {
      title: 'Gone Title',
      description: 'Gone Description',
      link: `${localServerUrl}/gone-${suffix}`,
      embedding: new Array(DIMENSIONS).fill(0.05),
    });

    const { model } = makeGoodModel();
    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: '',
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(0);
    const dm = await fetchMessage(id);
    expect(dm.content).toBe('');
    expect(dm.indexed_at).not.toBeNull();
  });

  it('should converge to the same single row on redelivery of the same update event (idempotency, AD-13)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-redelivery`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'ORIGINAL', { indexedAt: true });

    const event: MessageUpdatedEvent = {
      type: 'discord.message.updated',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
      newContent: `redelivered link ${localServerUrl}/redeliver-${suffix}`,
    };

    const { model: model1 } = makeGoodModel();
    const result1 = await processUpdate({
      event,
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model1,
      guard,
      signal,
    });
    expect(result1).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(1);

    // Redeliver the SAME event — converges (still exactly one row), reusing
    // the row it just wrote as the diff's kept link (F1/F2), zero re-enrich.
    const { model: model2, invoke: invoke2 } = makeGoodModel();
    const result2 = await processUpdate({
      event,
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model2,
      guard,
      signal,
    });
    expect(result2).toEqual({ ack: true });
    expect(invoke2).not.toHaveBeenCalled();
    expect(await fetchEmbeddingRows(id)).toHaveLength(1);
  });

  it('should skip a tombstoned message (deleted_at set) with no writes (D2)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-tombstoned`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'will be soft-deleted', { indexedAt: true });
    await processDelete({
      event: { type: 'discord.message.deleted', messageId: id, channelId, guildId: 'itest-guild', timestamp: '' },
      db: clients.db,
      config: softConfig,
      logger,
    });

    const { model } = makeGoodModel();
    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: `should never be indexed ${localServerUrl}/tombstoned-${suffix}`,
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(0);
  });

  it('should skip an update for an unknown message (no discord_messages row) with no writes', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-unknown`; // deliberately never seeded
    const { model } = makeGoodModel();

    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId: `chan-${suffix}`,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: 'should never be written',
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: model,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(0);
  });

  it('should leave the entry pending (un-acked) and write nothing when LLM enrichment fails (D1, PEL)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-llmfail`;
    const channelId = `chan-${suffix}`;
    const oldLink = `${localServerUrl}/stays-${suffix}`;
    await seedMessage(id, channelId, `see ${oldLink}`, { indexedAt: true });
    await seedEmbedding(`${id}:0`, channelId, [id], {
      title: 'Stays Title',
      description: 'Stays Description',
      link: oldLink,
      embedding: new Array(DIMENSIONS).fill(0.06),
    });

    const result = await processUpdate({
      event: {
        type: 'discord.message.updated',
        messageId: id,
        channelId,
        guildId: 'itest-guild',
        timestamp: new Date().toISOString(),
        newContent: `add a link that fails enrichment ${localServerUrl}/willfail-${suffix}`,
      },
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
      enrichModel: failingModel,
      guard,
      signal,
    });

    expect(result).toEqual({ ack: false });
    // Nothing committed — the OLD row (and old content) survive untouched.
    const rows = await fetchEmbeddingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].link).toBe(oldLink);
    const dm = await fetchMessage(id);
    expect(dm.content).toBe(`see ${oldLink}`);
  });

  it('should soft-delete: set deleted_at, keep embeddings intact, and exclude the chunk from the D1 anti-join', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-b`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'content b');
    const embeddingId = await seedEmbedding(`${id}:0`, channelId, [id], {
      title: '',
      description: 'chunk b content',
      link: '',
      embedding: new Array(DIMENSIONS).fill(0.01),
    });

    const event: MessageDeletedEvent = {
      type: 'discord.message.deleted',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
    };

    const result = await processDelete({ event, db: clients.db, config: softConfig, logger });
    expect(result).toEqual({ ack: true });

    const dm = await fetchMessage(id);
    expect(dm.deleted_at).not.toBeNull();
    expect(await fetchEmbeddingRows(id)).toHaveLength(1); // embeddings row untouched (AC-5)

    // D1 exclude-if-any anti-join (mirrors embeddingSearchRepository.drizzle.ts) —
    // the chunk is invisible to every read path the moment the message is soft-deleted.
    const visible = await clients.db.execute(sql`
      select e.id from embeddings e
      where e.id = ${embeddingId}
        and not exists (
          select 1 from discord_messages d
          where d.id = any(e.message_ids) and d.deleted_at is not null
        )
    `);
    expect(visible.rows).toHaveLength(0);

    // Idempotent: a second soft delete affects 0 rows, no throw, still acked.
    const result2 = await processDelete({ event, db: clients.db, config: softConfig, logger });
    expect(result2).toEqual({ ack: true });
  });

  it('should hard-delete: purge embeddings + read-status (FK-safe) and set deleted_at', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-c`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'content c');
    const embeddingId = await seedEmbedding(`${id}:0`, channelId, [id], {
      title: '',
      description: 'chunk c content',
      link: '',
      embedding: new Array(DIMENSIONS).fill(0.01),
    });
    const userId = await seedUser(suffix);
    await seedReadStatus(userId, embeddingId);

    const event: MessageDeletedEvent = {
      type: 'discord.message.deleted',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
    };

    const result = await processDelete({ event, db: clients.db, config: hardConfig, logger });
    expect(result).toEqual({ ack: true });

    expect(await fetchEmbeddingRows(id)).toHaveLength(0); // embeddings purged (AC-5)

    const readStatus = await clients.db.execute(
      sql`select 1 from user_read_status where embedding_id = ${embeddingId}`,
    );
    expect(readStatus.rows).toHaveLength(0); // note #5: FK-safe cascade — no violation

    const dm = await fetchMessage(id);
    expect(dm.deleted_at).not.toBeNull(); // hard delete is a superset of soft (DECISION 3)

    // Idempotent: a second hard delete affects 0 rows, no throw, still acked.
    const result2 = await processDelete({ event, db: clients.db, config: hardConfig, logger });
    expect(result2).toEqual({ ack: true });
  });
});
