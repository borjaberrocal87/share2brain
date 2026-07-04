// Infrastructure adapter: Drizzle-backed implementation of the UserRepository
// domain port. This is the only auth file that knows about the DB. Uses the
// `sql` helper re-exported by @hivly/shared/db so the backend never imports
// drizzle-orm directly (AD-2 spirit).
import { sql, users, type Database } from '@hivly/shared/db';

import type { UserProfile, UserRepository } from '../domain/repositories/userRepository.js';

export function createDrizzleUserRepository(db: Database): UserRepository {
  return {
    async upsertByDiscordId({ discordId, username, avatar }): Promise<{ id: string }> {
      // ON CONFLICT (discord_id) is backed by the unique index idx_users_discord_id,
      // so a repeated login updates the profile instead of creating a duplicate.
      const [row] = await db
        .insert(users)
        .values({ discordId, username, avatar })
        .onConflictDoUpdate({ target: users.discordId, set: { username, avatar } })
        .returning({ id: users.id });
      if (!row) throw new Error('User upsert returned no row');
      return { id: row.id };
    },

    async findById(id: string): Promise<UserProfile | null> {
      const rows = await db
        .select({
          id: users.id,
          discordId: users.discordId,
          username: users.username,
          avatar: users.avatar,
        })
        .from(users)
        .where(sql`${users.id} = ${id}`)
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
