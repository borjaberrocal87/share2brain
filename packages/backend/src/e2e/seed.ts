// Deterministic seed for the Playwright E2E harness (Story 4.5). Reset-then-seed
// on every boot so runs are idempotent and coexist with the dev DB + the
// integration suites — everything is scoped to the `e2e-` id prefix and NOTHING
// is ever deleted beyond that prefix (the 4.2 broad-LIKE race lesson).
//
// The dataset backs the retroactive 4.3 (Búsqueda) + 4.4 (Documentos) specs, and
// (Story 9.3) the Estadísticas visual harness:
//   - `e2e-role-member` sees `e2e-ch-general` (3 embeddings) + `e2e-ch-random`
//     (2 embeddings) → GET /api/search returns a fixed 5-result similarity spread
//     (top result is one-hot(0) in #general → similarity 1.0), GET /api/documents
//     returns a fixed read/unread mix, GET /api/stats returns kpis 5/2/2/1,
//     coverage 2/5/40%, topUsers Ada Lovelace(3)/Linus Torvalds(2).
//   - `e2e-role-empty` sees only `e2e-ch-void` (0 embeddings) → the search empty
//     state is reachable (search has no similarity threshold; an empty scope is
//     the only way to get 0 results) and /api/stats returns all-zero figures.
//   - `e2e-role-none` (Story 9.3 D3 RBAC canary) owns `e2e-ch-secreto`, held by
//     NO fake-OAuth identity — its message/embedding must NEVER surface in any
//     member-scoped figure (AD-12 in-SQL RBAC). Only `e2e-msg-r1`/`e2e-msg-r2`
//     carry `author_name` (D2, mirrors the post-9.4 no-backfill reality); the
//     rest resolve via COALESCE fallback to the raw `author_id`.
import { sql, type Database } from '@hivly/shared/db';

// Must match the migrated column width `vector(1536)` and the fake query embedder
// (one-hot at index 0), so `<=>` accepts the seeded vectors.
const DIMENSIONS = 1536;

export const E2E_MEMBER_DISCORD_ID = 'e2e-user-member';
export const E2E_EMPTY_DISCORD_ID = 'e2e-user-empty';

/**
 * A unit vector whose cosine similarity against the query one-hot(0) equals
 * `first` (the first component of a unit vector). `first=1` → similarity 1.0.
 */
function unitVector(first: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = first;
  v[1] = Math.sqrt(Math.max(0, 1 - first * first));
  return v;
}

interface ChannelSpec {
  channelId: string;
  name: string;
  allowedRole: string;
}

interface MessageSpec {
  id: string;
  channelId: string;
  authorId: string;
  authorName?: string;
  content: string;
  createdAt: string;
}

interface EmbeddingSpec {
  chunkKey: string;
  title: string;
  description: string;
  link: string;
  channelId: string;
  anchorMessageId: string;
  vector: number[];
  createdAt: string;
}

// Channels: the two member channels carry embeddings; the void channel (empty
// user's only scope) carries none, so the search empty state is reachable.
// `e2e-ch-secreto` (Story 9.3 D3) is a RBAC canary: allowed_roles holds a role
// no fake-OAuth identity ever carries, so the member must NEVER see it or its
// content in any /api/stats figure (AD-12 in-SQL scoping).
const CHANNELS: ChannelSpec[] = [
  { channelId: 'e2e-ch-general', name: 'general', allowedRole: 'e2e-role-member' },
  { channelId: 'e2e-ch-random', name: 'random', allowedRole: 'e2e-role-member' },
  { channelId: 'e2e-ch-void', name: 'sin-datos', allowedRole: 'e2e-role-empty' },
  { channelId: 'e2e-ch-secreto', name: 'secreto', allowedRole: 'e2e-role-none' },
];

// Story 9.3 D3: one clock shared by the canary message + its embedding, so
// "today" is consistent regardless of when the seed actually boots.
const SEED_NOW = new Date();

// Anchor messages: one per embedding (message_ids[1] MUST be an existing
// discord_messages.id — the search/documents SQL INNER JOINs the anchor, so a
// missing anchor silently drops the chunk). Distinct created_at values give a
// deterministic ORDER BY created_at DESC, id DESC.
//
// Story 9.3 D2: `author_name` is set ONLY on each author's LATEST message
// (r1/r2) — g1/g2/g3 stay NULL. This mirrors the post-9.4 no-backfill reality
// and lets one seed exercise both COALESCE tiers: search.spec's raw-author-id
// initials assert (g1, tier 3) keeps passing, while the 9.5 topUsers name pick
// (latest scoped non-blank author_name per author) surfaces real names for
// both r1 (linus) and r2 (ada).
//
// Story 9.3 D3: `e2e-msg-s1` is the RBAC canary message — authored in the
// denied `e2e-ch-secreto` channel, dated `SEED_NOW` ("today") so a leak would
// also show up as a tall activity bar on the last day of the 14-day window.
const MESSAGES: MessageSpec[] = [
  { id: 'e2e-msg-g1', channelId: 'e2e-ch-general', authorId: 'e2e-author-ada', content: '¿Cómo configuro los canales a indexar en Hivly?', createdAt: '2026-06-01T10:00:00Z' },
  { id: 'e2e-msg-g2', channelId: 'e2e-ch-general', authorId: 'e2e-author-linus', content: 'La indexación corre sobre Redis Streams con workers idempotentes.', createdAt: '2026-06-02T10:00:00Z' },
  { id: 'e2e-msg-g3', channelId: 'e2e-ch-general', authorId: 'e2e-author-ada', content: 'El RBAC vive dentro de la query vectorial, nunca como post-filtro.', createdAt: '2026-06-03T10:00:00Z' },
  { id: 'e2e-msg-r1', channelId: 'e2e-ch-random', authorId: 'e2e-author-linus', authorName: 'Linus Torvalds', content: 'Los embeddings usan pgvector con distancia coseno.', createdAt: '2026-06-04T10:00:00Z' },
  { id: 'e2e-msg-r2', channelId: 'e2e-ch-random', authorId: 'e2e-author-ada', authorName: 'Ada Lovelace', content: 'Las sesiones viven en Redis, no hay tabla de sesiones.', createdAt: '2026-06-05T10:00:00Z' },
  { id: 'e2e-msg-s1', channelId: 'e2e-ch-secreto', authorId: 'e2e-author-eve', authorName: 'Eve Intrusa', content: 'Mensaje en canal privado fuera de tu alcance.', createdAt: SEED_NOW.toISOString() },
];

// embeddings.created_at drives the Documentos ordering (newest first). The vectors
// give a descending similarity spread against one-hot(0): 1.0, 0.8, 0.6, 0.5, 0.3.
const EMBEDDINGS: EmbeddingSpec[] = [
  { chunkKey: 'e2e-msg-g1:0', title: 'Cómo configurar los canales a indexar', description: 'Para indexar canales, listalos en Hivly.config.yml y reiniciá el bot.', link: 'https://example.com/e2e/configurar-canales-indexados', channelId: 'e2e-ch-general', anchorMessageId: 'e2e-msg-g1', vector: unitVector(1), createdAt: '2026-06-06T10:00:00Z' },
  { chunkKey: 'e2e-msg-g2:0', title: 'Indexación con Redis Streams', description: 'El Indexer consume hivly:discord:messages y hace XACK sólo tras éxito.', link: 'https://example.com/e2e/indexacion-redis-streams', channelId: 'e2e-ch-general', anchorMessageId: 'e2e-msg-g2', vector: unitVector(0.8), createdAt: '2026-06-05T10:00:00Z' },
  { chunkKey: 'e2e-msg-g3:0', title: 'RBAC dentro de la query vectorial', description: 'Cada query pgvector lleva WHERE channel_id = ANY(:allowedChannelIds).', link: 'https://example.com/e2e/rbac-query-vectorial', channelId: 'e2e-ch-general', anchorMessageId: 'e2e-msg-g3', vector: unitVector(0.6), createdAt: '2026-06-04T10:00:00Z' },
  { chunkKey: 'e2e-msg-r1:0', title: 'Similitud coseno con pgvector', description: 'pgvector ordena por distancia coseno ascendente para similitud descendente.', link: 'https://example.com/e2e/similitud-coseno-pgvector', channelId: 'e2e-ch-random', anchorMessageId: 'e2e-msg-r1', vector: unitVector(0.5), createdAt: '2026-06-03T10:00:00Z' },
  { chunkKey: 'e2e-msg-r2:0', title: 'Sesiones en Redis, sin tabla propia', description: 'connect-redis respalda express-session; la cookie sólo lleva el sid.', link: 'https://example.com/e2e/sesiones-en-redis', channelId: 'e2e-ch-random', anchorMessageId: 'e2e-msg-r2', vector: unitVector(0.3), createdAt: '2026-06-02T10:00:00Z' },
  // Story 9.3 D3 canary: denied-channel embedding dated `SEED_NOW`. Never
  // reachable by the member — its mere existence is the AC6 leak detector.
  { chunkKey: 'e2e-msg-s1:0', title: 'Notas del canal secreto', description: 'Contenido de un canal fuera de tu alcance — no deberías verlo.', link: 'https://example.com/e2e/canal-secreto', channelId: 'e2e-ch-secreto', anchorMessageId: 'e2e-msg-s1', vector: unitVector(0.9), createdAt: SEED_NOW.toISOString() },
];

// Which chunks start READ for the member — the rest stay unread (amber dot +
// sidebar badge). Kept < the total so the Documentos view shows a mixed state.
const READ_CHUNK_KEYS = ['e2e-msg-g1:0', 'e2e-msg-r1:0'];

// One seeded conversation for the member (Story 5.3), so the chat history overlay
// is populated & assertable. Title is DERIVED server-side from the first USER
// message (Story 5.2 D1 — no title column), so CONVERSATION_TITLE is the exact
// text the history row must show. The assistant reply carries a citation to prove
// the persisted `citations` jsonb round-trips (unused by the 5.3 shell, but the
// column is NOT NULL and 5.4 will render it).
// Story 9.3 D4: seed-boot-relative (was hardcoded 2026-07-01, a time bomb —
// the `queries` KPI counts user messages within the last 30 days, so a fixed
// date would silently drop this conversation out of the window after
// 2026-07-31). chat.spec never asserts dates, only derived title/content.
const CONVERSATION_TITLE = '¿Cómo configuro las notificaciones externas?';
const CONVERSATION_CREATED_AT = new Date(SEED_NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
const CONVERSATION_UPDATED_AT = new Date(SEED_NOW.getTime() - 5 * 24 * 60 * 60 * 1000 + 5_000).toISOString();
const CONVERSATION_ANSWER =
  'Las notificaciones externas se configuran en Hivly.config.yml bajo la sección notifications.';
const CONVERSATION_CITATIONS = [
  {
    title: 'Cómo configurar los canales a indexar',
    channel: 'general',
    author: 'e2e-author-ada',
    date: '2026-06-01T10:00:00Z',
    link: 'https://example.com/e2e/configurar-canales-indexados',
  },
];

export interface SeedSummary {
  channels: number;
  messages: number;
  embeddings: number;
  read: number;
  conversations: number;
}

/** Reset every `e2e-`-scoped row, then insert the deterministic dataset. */
export async function resetAndSeed(db: Database): Promise<SeedSummary> {
  // Delete in FK order: messages → conversations → user_read_status → embeddings
  // → discord_messages → channel_permissions → users (messages/conversations
  // reference users, so they must go before the users delete). NEVER widen these
  // predicates beyond `e2e-` (scoped to the e2e member user, the 4.2 broad-LIKE
  // race lesson).
  await db.execute(sql`
    delete from messages m
    using conversations c, users u
    where m.conversation_id = c.id and c.user_id = u.id and u.discord_id like 'e2e-user-%'
  `);
  await db.execute(sql`
    delete from conversations c
    using users u
    where c.user_id = u.id and u.discord_id like 'e2e-user-%'
  `);
  await db.execute(sql`
    delete from user_read_status urs
    using users u
    where urs.user_id = u.id and u.discord_id like 'e2e-user-%'
  `);
  await db.execute(sql`delete from embeddings where chunk_key like 'e2e-%'`);
  await db.execute(sql`delete from discord_messages where id like 'e2e-%'`);
  await db.execute(sql`delete from channel_permissions where channel_id like 'e2e-%'`);
  await db.execute(sql`delete from users where discord_id like 'e2e-user-%'`);

  for (const c of CHANNELS) {
    await db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${c.channelId}, ${c.name}, ARRAY[${c.allowedRole}]::text[])
    `);
  }

  for (const m of MESSAGES) {
    await db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, author_name, content, created_at, updated_at, indexed_at)
      values (${m.id}, ${m.channelId}, 'e2e-guild', ${m.authorId}, ${m.authorName ?? null}, ${m.content}, ${m.createdAt}, ${m.createdAt}, ${m.createdAt})
    `);
  }

  for (const e of EMBEDDINGS) {
    await db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (
        ${e.chunkKey}, ${e.title}, ${e.description}, ${e.link}, ${JSON.stringify(e.vector)}::vector,
        ${e.channelId}, ${`{${e.anchorMessageId}}`}::text[], ${e.createdAt}
      )
    `);
  }

  // Pre-create the member user with a known id so its user_read_status rows can
  // be seeded. handleCallback upserts ON CONFLICT (discord_id) DO UPDATE, so a
  // login reuses THIS row (same id) — the seeded read-status stays valid.
  const memberResult = await db.execute(sql`
    insert into users (discord_id, username) values (${E2E_MEMBER_DISCORD_ID}, 'e2e-member')
    returning id
  `);
  const memberId = String((memberResult.rows[0] as { id: string }).id);

  // Mark a subset read for the member — join by chunk_key so we needn't know the
  // generated embedding ids.
  const readResult = await db.execute(sql`
    insert into user_read_status (user_id, embedding_id, read_at)
    select ${memberId}, e.id, now()
    from embeddings e
    where e.chunk_key in (${sql.join(READ_CHUNK_KEYS.map((k) => sql`${k}`), sql`, `)})
  `);

  // One conversation for the member: a first USER message (becomes the derived
  // title) + an assistant reply with a citation. Story 5.3's history overlay lists
  // it; 5.4 will render the messages.
  const conversationResult = await db.execute(sql`
    insert into conversations (user_id, created_at, updated_at)
    values (${memberId}, ${CONVERSATION_CREATED_AT}, ${CONVERSATION_UPDATED_AT})
    returning id
  `);
  const conversationId = String((conversationResult.rows[0] as { id: string }).id);
  await db.execute(sql`
    insert into messages (conversation_id, role, content, citations, created_at)
    values (${conversationId}, 'user', ${CONVERSATION_TITLE}, '[]'::jsonb, ${CONVERSATION_CREATED_AT})
  `);
  await db.execute(sql`
    insert into messages (conversation_id, role, content, citations, created_at)
    values (
      ${conversationId}, 'assistant', ${CONVERSATION_ANSWER},
      ${JSON.stringify(CONVERSATION_CITATIONS)}::jsonb, ${CONVERSATION_UPDATED_AT}
    )
  `);

  const summary: SeedSummary = {
    channels: CHANNELS.length,
    messages: MESSAGES.length,
    embeddings: EMBEDDINGS.length,
    read: readResult.rowCount ?? READ_CHUNK_KEYS.length,
    conversations: 1,
  };
  return summary;
}
