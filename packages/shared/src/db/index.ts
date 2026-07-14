// Drizzle client factory + schema re-export. Importing this module opens NO
// connection — `new Pool()` is lazy and only dials Postgres on first query, and
// the factory is invoked explicitly by a service that has decided to connect.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { redactSecrets, type Logger } from '../logger.js';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

// Re-exported so services can build raw queries (e.g. the `/health` probe
// `db.execute(sql\`select 1\`)`) without importing drizzle-orm directly — they
// depend only on @share2brain/shared (AD-2).
export { sql } from 'drizzle-orm';

// Re-exported for the RBAC expansion query (AD-12): `WHERE allowed_roles && :roles`
// (Postgres array-overlap `&&`). Same rationale as `sql` — the backend depends
// only on @share2brain/shared and must not import drizzle-orm directly (AD-2).
export { arrayOverlaps } from 'drizzle-orm';

// Re-exported for the Indexer's dedup query (Story 3.3): `WHERE id IN (:ids)`
// (`inArray`). Same rationale as `sql`/`arrayOverlaps` — workers depend only on
// @share2brain/shared and must not import drizzle-orm directly (AD-2). NOTE: `inArray`
// throws on an empty array; guard the caller with `ids.length > 0`.
export { inArray } from 'drizzle-orm';

/**
 * The typed Drizzle database handle, bound to the full Share2Brain schema. `$client` is
 * the underlying pg `Pool` — call `db.$client.end()` to close it (integration
 * tests, graceful shutdown). This mirrors exactly what `drizzle(pool)` returns.
 */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * Create a Drizzle client for the given Postgres connection string. Callers own
 * the returned handle's lifecycle. No network I/O happens until the first query.
 *
 * The pg `Pool` emits `'error'` when a network/backend failure hits an *idle*
 * client (Postgres restart/failover, connection blip). Without a listener that
 * becomes an `uncaughtException` and crashes the whole service, dropping every
 * in-flight request. We attach one so an idle-client failure is logged, not
 * fatal — the pool discards the dead client and recovers on the next query.
 * Pass `logger` so the message is credential-redacted (some pg errors
 * interpolate the connection URL, password included); without one we fall back
 * to `console.error` with the same redaction applied.
 */
export function createDatabase(connectionString: string, logger?: Logger): Database {
  const pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    if (logger) {
      logger.error('idle pg client error', { reason: err.message, stack: err.stack });
    } else {
      console.error('idle pg client error:', redactSecrets(String(err)));
    }
  });
  return drizzle(pool, { schema });
}
