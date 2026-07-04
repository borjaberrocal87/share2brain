// Drizzle client factory + schema re-export. Importing this module opens NO
// connection — `new Pool()` is lazy and only dials Postgres on first query, and
// the factory is invoked explicitly by a service that has decided to connect.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

export * from './schema.js';
export { schema };

// Re-exported so services can build raw queries (e.g. the `/health` probe
// `db.execute(sql\`select 1\`)`) without importing drizzle-orm directly — they
// depend only on @hivly/shared (AD-2).
export { sql } from 'drizzle-orm';

/**
 * The typed Drizzle database handle, bound to the full Hivly schema. `$client` is
 * the underlying pg `Pool` — call `db.$client.end()` to close it (integration
 * tests, graceful shutdown). This mirrors exactly what `drizzle(pool)` returns.
 */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * Create a Drizzle client for the given Postgres connection string. Callers own
 * the returned handle's lifecycle. No network I/O happens until the first query.
 */
export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}
