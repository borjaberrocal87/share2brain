// Unit tests for the read-status application service — RBAC/visibility branches
// (D5, D6) and pass-through of repo results. Uses a plain fake (no Drizzle, no
// Express): the service depends only on the domain port.
import { describe, expect, it, vi } from 'vitest';

import type { ReadStatusRepository } from '../../domain/repositories/readStatusRepository.js';
import { createReadStatusService } from './readStatusService.js';

function fakeRepo(overrides: Partial<ReadStatusRepository> = {}): ReadStatusRepository {
  return {
    findVisibleEmbeddingChannel: vi.fn(async () => null),
    markRead: vi.fn(async () => undefined),
    unmarkRead: vi.fn(async () => undefined),
    markAllInChannels: vi.fn(async () => 0),
    unreadCountByChannel: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('readStatusService.markRead', () => {
  it('should return not-found when the fragment is not visible (D5)', async () => {
    const readStatusRepo = fakeRepo({ findVisibleEmbeddingChannel: vi.fn(async () => null) });
    const service = createReadStatusService({ readStatusRepo });

    const result = await service.markRead('user-1', 'emb-1', ['chan-1']);

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(readStatusRepo.markRead).not.toHaveBeenCalled();
  });

  it('should mark read when the fragment is visible', async () => {
    const readStatusRepo = fakeRepo({ findVisibleEmbeddingChannel: vi.fn(async () => 'chan-1') });
    const service = createReadStatusService({ readStatusRepo });

    const result = await service.markRead('user-1', 'emb-1', ['chan-1']);

    expect(result).toEqual({ ok: true });
    expect(readStatusRepo.markRead).toHaveBeenCalledWith('user-1', 'emb-1');
  });
});

describe('readStatusService.unmarkRead', () => {
  it('should always call the repo — idempotent, no visibility check (AC4)', async () => {
    const readStatusRepo = fakeRepo();
    const service = createReadStatusService({ readStatusRepo });

    await service.unmarkRead('user-1', 'emb-1');

    expect(readStatusRepo.unmarkRead).toHaveBeenCalledWith('user-1', 'emb-1');
  });
});

describe('readStatusService.markAll', () => {
  it('should return forbidden when channelId is outside allowedChannelIds (D6)', async () => {
    const readStatusRepo = fakeRepo();
    const service = createReadStatusService({ readStatusRepo });

    const result = await service.markAll('user-1', 'chan-denied', ['chan-1', 'chan-2']);

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(readStatusRepo.markAllInChannels).not.toHaveBeenCalled();
  });

  it('should target only [channelId] when provided and in scope', async () => {
    const readStatusRepo = fakeRepo({ markAllInChannels: vi.fn(async () => 3) });
    const service = createReadStatusService({ readStatusRepo });

    const result = await service.markAll('user-1', 'chan-1', ['chan-1', 'chan-2']);

    expect(readStatusRepo.markAllInChannels).toHaveBeenCalledWith('user-1', ['chan-1']);
    expect(result).toEqual({ ok: true, response: { markedCount: 3 } });
  });

  it('should target all allowedChannelIds when channelId is absent (D6)', async () => {
    const readStatusRepo = fakeRepo({ markAllInChannels: vi.fn(async () => 5) });
    const service = createReadStatusService({ readStatusRepo });

    const result = await service.markAll('user-1', undefined, ['chan-1', 'chan-2']);

    expect(readStatusRepo.markAllInChannels).toHaveBeenCalledWith('user-1', ['chan-1', 'chan-2']);
    expect(result).toEqual({ ok: true, response: { markedCount: 5 } });
  });
});

describe('readStatusService.unreadCount', () => {
  it('should pass allowedChannelIds through and return the repo map (D7)', async () => {
    const readStatusRepo = fakeRepo({
      unreadCountByChannel: vi.fn(async () => ({ 'chan-1': 4 })),
    });
    const service = createReadStatusService({ readStatusRepo });

    const result = await service.unreadCount('user-1', ['chan-1']);

    expect(readStatusRepo.unreadCountByChannel).toHaveBeenCalledWith('user-1', ['chan-1']);
    expect(result).toEqual({ 'chan-1': 4 });
  });
});
