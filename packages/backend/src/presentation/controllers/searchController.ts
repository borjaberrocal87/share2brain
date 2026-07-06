// Presentation: HTTP handler for GET /api/search. Owns HTTP concerns (query
// validation, status codes) and maps errors to the unified ErrorSchema shape.
// Raw DB/LLM errors are never leaked to the client. Mirrors authController.
import { SEARCH_ERROR, SearchQuerySchema } from '@hivly/shared/schemas';
import type { Request, Response } from 'express';

import type { SearchService } from '../../application/services/searchService.js';

export interface SearchController {
  search(req: Request, res: Response): Promise<void>;
}

export function createSearchController(deps: {
  searchService: SearchService;
}): SearchController {
  const { searchService } = deps;

  return {
    async search(req, res) {
      // Validate query params at the edge (AD-6). A missing/blank `q` is a 400 with
      // the AC4-mandated Spanish user message + stable English code. The message is
      // attributed to the field that actually failed — `q` failures keep "Query
      // requerida" (AC4), while a bad `limit` gets its own message instead of
      // misdirecting the client to a non-existent problem with `q`.
      const parsed = SearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const qIssue = parsed.error.issues.find((issue) => issue.path[0] === 'q');
        const error = qIssue
          ? qIssue.code === 'too_big'
            ? 'Query demasiado larga'
            : 'Query requerida'
          : 'Parámetro limit inválido';
        res.status(400).json({ error, code: SEARCH_ERROR.VALIDATION_ERROR });
        return;
      }

      // Populated by the RBAC middleware on every /api/* request (AD-12). Default to
      // an empty scope defensively — the service treats it as deny-by-default (AC3).
      const allowedChannelIds = req.allowedChannelIds ?? [];

      try {
        const payload = await searchService.search(parsed.data.q, parsed.data.limit, allowedChannelIds);
        res.status(200).json(payload);
      } catch (err) {
        // Never leak the raw DB/LLM error (language rule).
        console.error('[search] failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: SEARCH_ERROR.INTERNAL });
      }
    },
  };
}
