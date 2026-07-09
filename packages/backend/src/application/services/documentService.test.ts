// Unit tests for the documents application service — the orchestration + empty
// scope fast path. Uses a plain fake (no Drizzle, no Express): the service
// depends only on the domain port. Mirrors searchService.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type { DocumentFragmentRow, DocumentRepository } from '../../domain/repositories/documentRepository.js';
import { createDocumentService } from './documentService.js';

function fakeRepo(rows: DocumentFragmentRow[], total: number): DocumentRepository {
  return {
    listDocuments: vi.fn(async () => rows),
    countDocuments: vi.fn(async () => total),
  };
}

const ROW: DocumentFragmentRow = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  title: 'The Answer to Everything',
  description: 'the answer is 42',
  link: '',
  channelId: 'chan-1',
  channelName: 'general',
  authorId: 'author-anchor',
  authorName: 'author-anchor',
  createdAt: '2026-07-06T00:00:00.000Z',
  indexedAt: '2026-07-06T01:00:00.000Z',
  messageId: 'anchor-msg',
  isRead: true,
};

describe('documentService.listDocuments', () => {
  it('should return an empty page WITHOUT calling the repo when the scope is empty (AC7)', async () => {
    const documentRepo = fakeRepo([], 0);
    const service = createDocumentService({ documentRepo });

    const result = await service.listDocuments('user-1', 1, 20, [], undefined, false);

    expect(result).toEqual({ results: [], page: 1, limit: 20, total: 0 });
    expect(documentRepo.listDocuments).not.toHaveBeenCalled();
    expect(documentRepo.countDocuments).not.toHaveBeenCalled();
  });

  it('should compute the offset from page/limit and pass the scope + unreadOnly through', async () => {
    const documentRepo = fakeRepo([ROW], 1);
    const service = createDocumentService({ documentRepo });

    await service.listDocuments('user-1', 3, 10, ['chan-1'], undefined, false);

    expect(documentRepo.listDocuments).toHaveBeenCalledWith('user-1', ['chan-1'], 10, 20, false);
    expect(documentRepo.countDocuments).toHaveBeenCalledWith('user-1', ['chan-1'], false);
  });

  it('should map rows to fragments preserving isRead and indexedAt (D3)', async () => {
    const service = createDocumentService({ documentRepo: fakeRepo([ROW], 1) });

    const { results } = await service.listDocuments('user-1', 1, 20, ['chan-1'], undefined, false);

    expect(results[0]).toEqual({
      id: ROW.id,
      title: ROW.title,
      description: ROW.description,
      link: ROW.link,
      channelId: ROW.channelId,
      channelName: ROW.channelName,
      authorId: ROW.authorId,
      authorName: ROW.authorName,
      createdAt: ROW.createdAt,
      indexedAt: ROW.indexedAt,
      messageId: ROW.messageId,
      isRead: ROW.isRead,
    });
  });

  it('should return the total from the repo (D4)', async () => {
    const service = createDocumentService({ documentRepo: fakeRepo([ROW], 42) });

    const { total } = await service.listDocuments('user-1', 1, 20, ['chan-1'], undefined, false);

    expect(total).toBe(42);
  });

  it('should validate the response against the shared contract (rejects a bad row)', async () => {
    const badRow = { ...ROW, id: 'not-a-uuid' };
    const service = createDocumentService({ documentRepo: fakeRepo([badRow], 1) });

    await expect(
      service.listDocuments('user-1', 1, 20, ['chan-1'], undefined, false),
    ).rejects.toThrow();
  });

  it('should narrow the scope to [channelId] when channelId is inside allowedChannelIds (AD-12)', async () => {
    const documentRepo = fakeRepo([ROW], 1);
    const service = createDocumentService({ documentRepo });

    await service.listDocuments('user-1', 1, 20, ['chan-1', 'chan-2'], 'chan-1', false);

    expect(documentRepo.listDocuments).toHaveBeenCalledWith('user-1', ['chan-1'], 20, 0, false);
    expect(documentRepo.countDocuments).toHaveBeenCalledWith('user-1', ['chan-1'], false);
  });

  it('should return an empty page WITHOUT calling the repo when channelId is out of scope (no existence leak)', async () => {
    const documentRepo = fakeRepo([ROW], 1);
    const service = createDocumentService({ documentRepo });

    const result = await service.listDocuments('user-1', 1, 20, ['chan-1'], 'chan-unknown', false);

    expect(result).toEqual({ results: [], page: 1, limit: 20, total: 0 });
    expect(documentRepo.listDocuments).not.toHaveBeenCalled();
    expect(documentRepo.countDocuments).not.toHaveBeenCalled();
  });

  it('should forward unreadOnly=true to both repo methods', async () => {
    const documentRepo = fakeRepo([ROW], 1);
    const service = createDocumentService({ documentRepo });

    await service.listDocuments('user-1', 1, 20, ['chan-1'], undefined, true);

    expect(documentRepo.listDocuments).toHaveBeenCalledWith('user-1', ['chan-1'], 20, 0, true);
    expect(documentRepo.countDocuments).toHaveBeenCalledWith('user-1', ['chan-1'], true);
  });
});
