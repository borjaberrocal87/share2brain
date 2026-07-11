// Infrastructure: guest-access seed + config resolution (Story 2.5). Guest access
// is config-gated and OFF by default; this module owns the boot-time seed of the
// sentinel guest `users` row and the consumer-side default resolution (the config
// schema itself carries NO `.default()` — same convention as resolveStreamsConfig,
// D4). Imports the `users` table only via @share2brain/shared/db (AD-2).
import { users, type Database } from '@share2brain/shared/db';
import type { Share2BrainConfig } from '@share2brain/shared';

/**
 * Fixed, v4-shaped UUID used on the FIRST insert of the guest row (so `z.uuid()`
 * passes). Only the id RETURNED by the upsert is authoritative — a pre-existing
 * guest row keeps its own id (D5). Never hardcode this downstream of the seed.
 */
export const GUEST_USER_ID = '00000000-0000-4000-a000-000000000001';

/**
 * Sentinel `discord_id` for the guest row. Cannot collide with a real Discord
 * snowflake (those are numeric), so the unique index on discord_id makes the
 * seed idempotent without touching real users.
 */
export const GUEST_DISCORD_ID = 'guest';

/** Backend-resolved guest-access settings (defaults filled here, not in the schema). */
export interface ResolvedGuestAccess {
  enabled: boolean;
  role: string;
  username: string;
  sessionTtlMinutes: number;
}

/**
 * Resolve the effective guest-access settings from `config.access_control`,
 * filling per-field defaults the config schema deliberately omits (D4). An
 * absent block resolves to `enabled: false`.
 */
export function resolveGuestAccessConfig(
  accessControl: Share2BrainConfig['access_control'],
): ResolvedGuestAccess {
  const block = accessControl.guest_access;
  return {
    enabled: block?.enabled ?? false,
    role: block?.role ?? 'guest',
    username: block?.username ?? 'Invitado',
    sessionTtlMinutes: block?.session_ttl_minutes ?? 120,
  };
}

/**
 * Upsert the singleton guest `users` row (sentinel discord_id). On conflict the
 * existing row's id is returned, so a pre-existing guest row (possibly with a
 * different UUID) is honored — callers MUST use the returned id, never assume
 * {@link GUEST_USER_ID}. Mirrors materializeChannelPermissions: config-slice in,
 * upsert, no transaction.
 */
export async function seedGuestUser(db: Database, username: string): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({ id: GUEST_USER_ID, discordId: GUEST_DISCORD_ID, username, avatar: null })
    .onConflictDoUpdate({ target: users.discordId, set: { username } })
    .returning({ id: users.id });
  if (!row) throw new Error('Guest user seed returned no row');
  return { id: row.id };
}
