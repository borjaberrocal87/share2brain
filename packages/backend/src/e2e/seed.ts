// Deterministic seed for the Playwright E2E harness (Story 4.5). Reset-then-seed
// on every boot so runs are idempotent and coexist with the dev DB + the
// integration suites — everything is scoped to the `e2e-` id prefix and NOTHING
// is ever deleted beyond that prefix (the 4.2 broad-LIKE race lesson).
//
// The dataset backs the retroactive 4.3 (Búsqueda) + 4.4 (Documentos) specs:
//   - `e2e-role-member` sees `e2e-ch-general` (3 embeddings) + `e2e-ch-random`
//     (2 embeddings) → GET /api/search returns a fixed 5-result similarity spread
//     (top result is one-hot(0) in #general → similarity 1.0), GET /api/documents
//     returns a fixed read/unread mix.
//   - `e2e-role-empty` sees only `e2e-ch-void` (0 embeddings) → the search empty
//     state is reachable (search has no similarity threshold; an empty scope is
//     the only way to get 0 results).
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
  content: string;
  createdAt: string;
}

interface EmbeddingSpec {
  chunkKey: string;
  content: string;
  channelId: string;
  anchorMessageId: string;
  vector: number[];
  createdAt: string;
}

// Channels: the two member channels carry embeddings; the void channel (empty
// user's only scope) carries none, so the search empty state is reachable.
const CHANNELS: ChannelSpec[] = [
  { channelId: 'e2e-ch-general', name: 'general', allowedRole: 'e2e-role-member' },
  { channelId: 'e2e-ch-random', name: 'random', allowedRole: 'e2e-role-member' },
  { channelId: 'e2e-ch-void', name: 'sin-datos', allowedRole: 'e2e-role-empty' },
];

// Anchor messages: one per embedding (message_ids[1] MUST be an existing
// discord_messages.id — the search/documents SQL INNER JOINs the anchor, so a
// missing anchor silently drops the chunk). Distinct created_at values give a
// deterministic ORDER BY created_at DESC, id DESC.
const MESSAGES: MessageSpec[] = [
  { id: 'e2e-msg-g1', channelId: 'e2e-ch-general', authorId: 'e2e-author-ada', content: '¿Cómo configuro los canales a indexar en Hivly?', createdAt: '2026-06-01T10:00:00Z' },
  { id: 'e2e-msg-g2', channelId: 'e2e-ch-general', authorId: 'e2e-author-linus', content: 'La indexación corre sobre Redis Streams con workers idempotentes.', createdAt: '2026-06-02T10:00:00Z' },
  { id: 'e2e-msg-g3', channelId: 'e2e-ch-general', authorId: 'e2e-author-ada', content: 'El RBAC vive dentro de la query vectorial, nunca como post-filtro.', createdAt: '2026-06-03T10:00:00Z' },
  { id: 'e2e-msg-r1', channelId: 'e2e-ch-random', authorId: 'e2e-author-linus', content: 'Los embeddings usan pgvector con distancia coseno.', createdAt: '2026-06-04T10:00:00Z' },
  { id: 'e2e-msg-r2', channelId: 'e2e-ch-random', authorId: 'e2e-author-ada', content: 'Las sesiones viven en Redis, no hay tabla de sesiones.', createdAt: '2026-06-05T10:00:00Z' },
];

// embeddings.created_at drives the Documentos ordering (newest first). The vectors
// give a descending similarity spread against one-hot(0): 1.0, 0.8, 0.6, 0.5, 0.3.
const EMBEDDINGS: EmbeddingSpec[] = [
  { chunkKey: 'e2e-msg-g1:0', content: 'Para indexar canales, listalos en Hivly.config.yml y reiniciá el bot.', channelId: 'e2e-ch-general', anchorMessageId: 'e2e-msg-g1', vector: unitVector(1), createdAt: '2026-06-06T10:00:00Z' },
  { chunkKey: 'e2e-msg-g2:0', content: 'El Indexer consume hivly:discord:messages y hace XACK sólo tras éxito.', channelId: 'e2e-ch-general', anchorMessageId: 'e2e-msg-g2', vector: unitVector(0.8), createdAt: '2026-06-05T10:00:00Z' },
  { chunkKey: 'e2e-msg-g3:0', content: 'Cada query pgvector lleva WHERE channel_id = ANY(:allowedChannelIds).', channelId: 'e2e-ch-general', anchorMessageId: 'e2e-msg-g3', vector: unitVector(0.6), createdAt: '2026-06-04T10:00:00Z' },
  { chunkKey: 'e2e-msg-r1:0', content: 'pgvector ordena por distancia coseno ascendente para similitud descendente.', channelId: 'e2e-ch-random', anchorMessageId: 'e2e-msg-r1', vector: unitVector(0.5), createdAt: '2026-06-03T10:00:00Z' },
  { chunkKey: 'e2e-msg-r2:0', content: 'connect-redis respalda express-session; la cookie sólo lleva el sid.', channelId: 'e2e-ch-random', anchorMessageId: 'e2e-msg-r2', vector: unitVector(0.3), createdAt: '2026-06-02T10:00:00Z' },
];

// Which chunks start READ for the member — the rest stay unread (amber dot +
// sidebar badge). Kept < the total so the Documentos view shows a mixed state.
const READ_CHUNK_KEYS = ['e2e-msg-g1:0', 'e2e-msg-r1:0'];

export interface SeedSummary {
  channels: number;
  messages: number;
  embeddings: number;
  read: number;
}

/** Reset every `e2e-`-scoped row, then insert the deterministic dataset. */
export async function resetAndSeed(db: Database): Promise<SeedSummary> {
  // Delete in FK order: user_read_status → embeddings → discord_messages →
  // channel_permissions → users. NEVER widen these predicates beyond `e2e-`.
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
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at, indexed_at)
      values (${m.id}, ${m.channelId}, 'e2e-guild', ${m.authorId}, ${m.content}, ${m.createdAt}, ${m.createdAt}, ${m.createdAt})
    `);
  }

  for (const e of EMBEDDINGS) {
    await db.execute(sql`
      insert into embeddings (chunk_key, content, embedding, channel_id, message_ids, created_at)
      values (
        ${e.chunkKey}, ${e.content}, ${JSON.stringify(e.vector)}::vector,
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

  const summary: SeedSummary = {
    channels: CHANNELS.length,
    messages: MESSAGES.length,
    embeddings: EMBEDDINGS.length,
    read: readResult.rowCount ?? READ_CHUNK_KEYS.length,
  };
  return summary;
}
