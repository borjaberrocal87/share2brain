// Startup task: materialize the RBAC policy table from behavior config (AD-8).
// Maps `config.access_control.channel_permissions` (snake_case, from YAML) to the
// domain's ChannelPermissionInput and upserts them via the repository. Called from
// main.ts BEFORE the server listens (AC1) — no /api/* request may run against an
// unmaterialized table. The config schema has no `category_id`, so it maps to null.
import type { Share2BrainConfig } from '@share2brain/shared';

import type { ChannelPermissionRepository } from '../domain/repositories/channelPermissionRepository.js';

type ConfigChannelPermissions = Share2BrainConfig['access_control']['channel_permissions'];

export function materializeChannelPermissions(
  repo: ChannelPermissionRepository,
  permissions: ConfigChannelPermissions,
): Promise<void> {
  return repo.upsertMany(
    permissions.map((p) => ({
      channelId: p.channel_id,
      name: p.name,
      allowedRoles: p.allowed_roles,
      categoryId: null, // config has no category_id (see story Dev Notes)
    })),
  );
}
