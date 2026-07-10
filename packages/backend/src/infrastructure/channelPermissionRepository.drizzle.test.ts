// Unit tests for the Drizzle channel-permission repo — the branches that need no
// real DB: the empty-roles short-circuit and the empty-upsert no-op. The overlap
// query shape itself is asserted by the integration test against real Postgres
// (adapter glue may test after; see backend-standards §Testing). Uses the
// health.test.ts double pattern (`vi.fn()` cast `as unknown as Database`).
import type { Database } from '@share2brain/shared/db';
import { describe, expect, it, vi } from 'vitest';

import { createDrizzleChannelPermissionRepository } from './channelPermissionRepository.drizzle.js';

describe('createDrizzleChannelPermissionRepository', () => {
  it('should short-circuit to [] for empty roles WITHOUT touching the db', async () => {
    const select = vi.fn();
    const repo = createDrizzleChannelPermissionRepository({ select } as unknown as Database);

    const result = await repo.findAllowedChannelIds([]);

    expect(result).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('should be a no-op for an empty upsert WITHOUT touching the db', async () => {
    const insert = vi.fn();
    const repo = createDrizzleChannelPermissionRepository({ insert } as unknown as Database);

    await repo.upsertMany([]);

    expect(insert).not.toHaveBeenCalled();
  });

  it('should short-circuit findAllowedChannels to [] for empty roles WITHOUT touching the db', async () => {
    const select = vi.fn();
    const repo = createDrizzleChannelPermissionRepository({ select } as unknown as Database);

    const result = await repo.findAllowedChannels([]);

    expect(result).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
