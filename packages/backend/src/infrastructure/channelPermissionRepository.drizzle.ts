// Infrastructure adapter: Drizzle-backed implementation of the
// ChannelPermissionRepository domain port. The only channel-RBAC file that knows
// about the DB. Uses `arrayOverlaps` re-exported by @share2brain/shared/db so the backend
// never imports drizzle-orm directly (AD-2). Mirrors userRepository.drizzle.ts.
import { arrayOverlaps, channelPermissions, sql, type Database } from '@share2brain/shared/db';

import type {
  ChannelPermissionInput,
  ChannelPermissionRepository,
} from '../domain/repositories/channelPermissionRepository.js';

export function createDrizzleChannelPermissionRepository(
  db: Database,
): ChannelPermissionRepository {
  return {
    async upsertMany(perms: ChannelPermissionInput[]): Promise<void> {
      if (perms.length === 0) return; // no-op: nothing to materialize

      const rows = perms.map((p) => ({
        channelId: p.channelId,
        name: p.name,
        allowedRoles: p.allowedRoles,
        categoryId: p.categoryId ?? null,
      }));

      // channelId is the PK, so it is the conflict target. A repeated startup
      // updates name/allowedRoles/categoryId instead of inserting duplicates.
      await db
        .insert(channelPermissions)
        .values(rows)
        .onConflictDoUpdate({
          target: channelPermissions.channelId,
          set: {
            name: sql`excluded.name`,
            allowedRoles: sql`excluded.allowed_roles`,
            categoryId: sql`excluded.category_id`,
          },
        });
    },

    async findAllowedChannelIds(discordRoles: string[]): Promise<string[]> {
      // Short-circuit: an empty JS array in the `&&` overlap operator risks a
      // Postgres cast ambiguity, and the deny-by-default result is trivially [].
      if (discordRoles.length === 0) return [];

      const rows = await db
        .select({ channelId: channelPermissions.channelId })
        .from(channelPermissions)
        // AD-12 expansion: WHERE allowed_roles && :discordRoles (array overlap).
        .where(arrayOverlaps(channelPermissions.allowedRoles, discordRoles));

      return rows.map((r) => r.channelId);
    },

    async findAllowedChannels(discordRoles: string[]): Promise<{ id: string; name: string }[]> {
      // Short-circuit: an empty JS array in the `&&` overlap operator risks a
      // Postgres cast ambiguity, and the deny-by-default result is trivially [].
      if (discordRoles.length === 0) return [];

      const rows = await db
        .select({ id: channelPermissions.channelId, name: channelPermissions.name })
        .from(channelPermissions)
        // AD-12 expansion: WHERE allowed_roles && :discordRoles (array overlap).
        .where(arrayOverlaps(channelPermissions.allowedRoles, discordRoles))
        // Deterministic chip order across requests/deploys (bare column = ascending).
        .orderBy(channelPermissions.name);

      return rows;
    },
  };
}
