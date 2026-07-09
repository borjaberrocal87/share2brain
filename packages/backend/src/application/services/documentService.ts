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
   * `channelId`, when given, narrows the scope to `[channelId]` (AD-12 —
   * the RBAC scope is narrowed, never post-filtered); an out-of-scope or
   * unknown `channelId` narrows to `[]`, hitting the same fast path (no
   * existence leak). `unreadOnly` is forwarded to the repo unchanged.
   */
  listDocuments(
    userId: string,
    page: number,
    limit: number,
    allowedChannelIds: string[],
    channelId: string | undefined,
    unreadOnly: boolean,
  ): Promise<DocumentsResponse>;
}

export function createDocumentService(deps: { documentRepo: DocumentRepository }): DocumentService {
  const { documentRepo } = deps;

  return {
    async listDocuments(
      userId,
      page,
      limit,
      allowedChannelIds,
      channelId,
      unreadOnly,
    ): Promise<DocumentsResponse> {
      const scope = channelId
        ? allowedChannelIds.includes(channelId)
          ? [channelId]
          : []
        : allowedChannelIds;

      // Deny-by-default scope can only yield nothing — skip the DB round-trip
      // entirely (the repo also short-circuits defensively).
      if (scope.length === 0) {
        return { results: [], page, limit, total: 0 };
      }

      const offset = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        documentRepo.listDocuments(userId, scope, limit, offset, unreadOnly),
        documentRepo.countDocuments(userId, scope, unreadOnly),
      ]);

      const results = rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        link: r.link,
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
