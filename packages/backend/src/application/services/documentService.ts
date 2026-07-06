// Application service: documents-list orchestration. Turns a page request + the
// caller's RBAC scope into a validated DocumentsResponse. Depends ONLY on the
// domain port (DocumentRepository) — no Drizzle, no Express — so it is
// unit-testable with plain fakes. Mirrors searchService.ts.
import { DocumentsResponseSchema, type DocumentsResponse } from '@hivly/shared/schemas';

import type { DocumentRepository } from '../../domain/repositories/documentRepository.js';

export interface DocumentService {
  /**
   * List a page of document fragments for `userId`, restricted to
   * `allowedChannelIds` (AD-12, enforced inside the SQL). An empty scope
   * returns an empty page without a DB round-trip (deny-by-default fast path).
   */
  listDocuments(
    userId: string,
    page: number,
    limit: number,
    allowedChannelIds: string[],
  ): Promise<DocumentsResponse>;
}

export function createDocumentService(deps: { documentRepo: DocumentRepository }): DocumentService {
  const { documentRepo } = deps;

  return {
    async listDocuments(userId, page, limit, allowedChannelIds): Promise<DocumentsResponse> {
      // Deny-by-default scope can only yield nothing — skip the DB round-trip
      // entirely (the repo also short-circuits defensively).
      if (allowedChannelIds.length === 0) {
        return { results: [], page, limit, total: 0 };
      }

      const offset = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        documentRepo.listDocuments(userId, allowedChannelIds, limit, offset),
        documentRepo.countDocuments(allowedChannelIds),
      ]);

      const results = rows.map((r) => ({
        id: r.id,
        content: r.content,
        channelId: r.channelId,
        channelName: r.channelName,
        authorId: r.authorId,
        authorName: r.authorName,
        createdAt: r.createdAt,
        indexedAt: r.indexedAt,
        messageId: r.messageId,
        isRead: r.isRead,
      }));

      // Validate against the shared contract before it leaves the service (AD-6).
      return DocumentsResponseSchema.parse({ results, page, limit, total });
    },
  };
}
