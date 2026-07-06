// Unit tests for the documents controller's HTTP mapping: 400 on invalid query,
// 200 with the service payload, 500 mapped to ErrorSchema without leaking the
// underlying error. Uses fake req/res — no Express, no infra. Mirrors
// searchController.test.ts.
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { DocumentService } from '../../application/services/documentService.js';
import { createDocumentController } from './documentController.js';

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function fakeReq(query: Record<string, unknown>, allowedChannelIds?: string[]): Request {
  return { query, allowedChannelIds, session: { userId: 'user-1' } } as unknown as Request;
}

const stubService = (impl: DocumentService['listDocuments']): DocumentService => ({
  listDocuments: impl,
});

describe('documentController.list', () => {
  it('should return 400 VALIDATION_ERROR when page is invalid', async () => {
    const controller = createDocumentController({ documentService: stubService(vi.fn()) });
    const res = fakeRes();

    await controller.list(fakeReq({ page: '0' }, ['chan-1']), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Parámetros inválidos', code: 'VALIDATION_ERROR' });
  });

  it('should return 400 VALIDATION_ERROR when limit exceeds the cap', async () => {
    const search = vi.fn();
    const controller = createDocumentController({ documentService: stubService(search) });
    const res = fakeRes();

    await controller.list(fakeReq({ limit: '999' }, ['chan-1']), res);

    expect(res.statusCode).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('should return 200 with the service payload on success, defaulting page/limit', async () => {
    const payload = { results: [], page: 1, limit: 20, total: 0 };
    const listDocuments = vi.fn(async () => payload);
    const controller = createDocumentController({ documentService: stubService(listDocuments) });
    const res = fakeRes();

    await controller.list(fakeReq({}, ['chan-1']), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(payload);
    expect(listDocuments).toHaveBeenCalledWith('user-1', 1, 20, ['chan-1']);
  });

  it('should default the scope to [] when the RBAC middleware left it unset', async () => {
    const listDocuments = vi.fn(async () => ({ results: [], page: 1, limit: 20, total: 0 }));
    const controller = createDocumentController({ documentService: stubService(listDocuments) });
    const res = fakeRes();

    await controller.list(fakeReq({}), res);

    expect(listDocuments).toHaveBeenCalledWith('user-1', 1, 20, []);
  });

  it('should map a service error to 500 INTERNAL without leaking it', async () => {
    const listDocuments = vi.fn(async () => {
      throw new Error('pg exploded: secret internal detail');
    });
    const controller = createDocumentController({ documentService: stubService(listDocuments) });
    const res = fakeRes();

    await controller.list(fakeReq({}, ['chan-1']), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});
