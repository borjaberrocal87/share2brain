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

// Story 2.5 (review): the shared sentinel userId means persisting guest read-status
// would bleed across guests. Guest writes are no-ops (isolation) while the read
// contract (visibility 404 / forbidden) is preserved; the sentinel then holds no
// read rows, so unreadCount is all-unread for guests with no branch.
describe('readStatusService — guest ephemerality (2.5)', () => {
  it('should NOT persist markRead for a guest, but still honor the visibility 404', async () => {
    const visible = fakeRepo({ findVisibleEmbeddingChannel: vi.fn(async () => 'chan-1') });
    const svcVisible = createReadStatusService({ readStatusRepo: visible });
    const okResult = await svcVisible.markRead('guest-sentinel', 'emb-1', ['chan-1'], true);
    expect(okResult).toEqual({ ok: true });
    expect(visible.markRead).not.toHaveBeenCalled();

    const invisible = fakeRepo({ findVisibleEmbeddingChannel: vi.fn(async () => null) });
    const svcInvisible = createReadStatusService({ readStatusRepo: invisible });
    const notFound = await svcInvisible.markRead('guest-sentinel', 'emb-x', ['chan-1'], true);
    expect(notFound).toEqual({ ok: false, reason: 'not-found' });
    expect(invisible.markRead).not.toHaveBeenCalled();
  });

  it('should no-op unmarkRead for a guest', async () => {
    const readStatusRepo = fakeRepo();
    const service = createReadStatusService({ readStatusRepo });

    await service.unmarkRead('guest-sentinel', 'emb-1', true);

    expect(readStatusRepo.unmarkRead).not.toHaveBeenCalled();
  });

  it('should return markedCount 0 and persist nothing for a guest markAll, but keep the forbidden check', async () => {
    const repo = fakeRepo({ markAllInChannels: vi.fn(async () => 7) });
    const service = createReadStatusService({ readStatusRepo: repo });

    const ok = await service.markAll('guest-sentinel', undefined, ['chan-1', 'chan-2'], true);
    expect(ok).toEqual({ ok: true, response: { markedCount: 0 } });
    expect(repo.markAllInChannels).not.toHaveBeenCalled();

    const forbidden = await service.markAll('guest-sentinel', 'chan-denied', ['chan-1'], true);
    expect(forbidden).toEqual({ ok: false, reason: 'forbidden' });
    expect(repo.markAllInChannels).not.toHaveBeenCalled();
  });
});
