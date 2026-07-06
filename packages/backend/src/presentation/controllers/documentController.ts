// Presentation: HTTP handler for GET /api/documents. Owns HTTP concerns (query
// validation, status codes) and maps errors to the unified ErrorSchema shape.
// Raw DB errors are never leaked to the client. Mirrors searchController.ts.
import { DOCUMENTS_ERROR, DocumentsQuerySchema } from '@hivly/shared/schemas';
import type { Request, Response } from 'express';

import type { DocumentService } from '../../application/services/documentService.js';

export interface DocumentController {
  list(req: Request, res: Response): Promise<void>;
}

export function createDocumentController(deps: { documentService: DocumentService }): DocumentController {
  const { documentService } = deps;

  return {
    async list(req, res) {
      const parsed = DocumentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Parámetros inválidos', code: DOCUMENTS_ERROR.VALIDATION_ERROR });
        return;
      }

      // The route is behind requireAuth, so req.session.userId is guaranteed.
      const userId = req.session.userId as string;
      // Populated by the RBAC middleware on every /api/* request (AD-12). Default
      // to an empty scope defensively — the service treats it as deny-by-default.
      const allowedChannelIds = req.allowedChannelIds ?? [];

      try {
        const payload = await documentService.listDocuments(
          userId,
          parsed.data.page,
          parsed.data.limit,
          allowedChannelIds,
        );
        res.status(200).json(payload);
      } catch (err) {
        console.error('[documents] failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: DOCUMENTS_ERROR.INTERNAL });
      }
    },
  };
}
