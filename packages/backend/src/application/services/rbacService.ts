// Application service: RBAC expansion. Turns a user's Discord roles into the set
// of channel IDs they may access, and builds the GET /api/auth/roles response.
// Depends only on the domain port (ChannelPermissionRepository) — never on Drizzle
// or express — so it is unit-testable with a plain fake. Mirrors authService.ts.
//
// This is the AD-12 RBAC *expansion* (roles → allowedChannelIds), NOT the vector-
// query filter itself. Epic 4/5 handlers apply `req.allowedChannelIds` inside the
// pgvector query; this story only produces it.
import {
  AuthRolesResponseSchema,
  ChannelsResponseSchema,
  type AuthRolesResponse,
  type ChannelsResponse,
} from '@share2brain/shared/schemas';

import type { ChannelPermissionRepository } from '../../domain/repositories/channelPermissionRepository.js';

export interface RbacService {
  /** Expand Discord roles to the channel IDs the user may access (deny-by-default). */
  expandAllowedChannelIds(discordRoles: string[]): Promise<string[]>;

  /** Build the GET /api/auth/roles payload, validated against the shared contract. */
  getRolesResponse(discordRoles: string[]): Promise<AuthRolesResponse>;

  /** Build the GET /api/channels payload, validated against the shared contract. */
  getAllowedChannels(discordRoles: string[]): Promise<ChannelsResponse>;
}

export function createRbacService(deps: {
  channelPermissions: ChannelPermissionRepository;
}): RbacService {
  const { channelPermissions } = deps;

  return {
    expandAllowedChannelIds(discordRoles: string[]): Promise<string[]> {
      return channelPermissions.findAllowedChannelIds(discordRoles);
    },

    async getRolesResponse(discordRoles: string[]): Promise<AuthRolesResponse> {
      const allowedChannels = await channelPermissions.findAllowedChannelIds(discordRoles);
      // Validate against the shared contract before it leaves the service (AD-6).
      return AuthRolesResponseSchema.parse({ roles: discordRoles, allowedChannels });
    },

    async getAllowedChannels(discordRoles: string[]): Promise<ChannelsResponse> {
      const channels = await channelPermissions.findAllowedChannels(discordRoles);
      // Validate against the shared contract before it leaves the service (AD-6).
      return ChannelsResponseSchema.parse({ channels });
    },
  };
}
