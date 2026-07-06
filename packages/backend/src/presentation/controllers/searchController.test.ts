// Unit tests for the search controller's HTTP mapping: 400 on invalid query,
// 200 with the service payload, 500 mapped to ErrorSchema without leaking the
// underlying error. Uses fake req/res — no Express, no infra.
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { SearchService } from '../../application/services/searchService.js';
import { createSearchController } from './searchController.js';

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
  return { query, allowedChannelIds } as unknown as Request;
}

const stubService = (impl: SearchService['search']): SearchService => ({ search: impl });

describe('searchController.search', () => {
  it('should return 400 VALIDATION_ERROR with the Spanish message when q is missing', async () => {
    const controller = createSearchController({
      searchService: stubService(vi.fn()),
    });
    const res = fakeRes();

    await controller.search(fakeReq({}, ['chan-1']), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query requerida', code: 'VALIDATION_ERROR' });
  });

  it('should return 400 with a limit-specific message when only limit is invalid', async () => {
    const search = vi.fn();
    const controller = createSearchController({ searchService: stubService(search) });
    const res = fakeRes();

    // q is valid; limit is over the cap — the message must NOT misattribute to q.
    await controller.search(fakeReq({ q: 'hello', limit: '999' }, ['chan-1']), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Parámetro limit inválido', code: 'VALIDATION_ERROR' });
    expect(search).not.toHaveBeenCalled();
  });

  it('should return 400 with an over-length message when q is too long', async () => {
    const search = vi.fn();
    const controller = createSearchController({ searchService: stubService(search) });
    const res = fakeRes();

    await controller.search(fakeReq({ q: 'a'.repeat(1001) }, ['chan-1']), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query demasiado larga', code: 'VALIDATION_ERROR' });
    expect(search).not.toHaveBeenCalled();
  });

  it('should return 400 when q is whitespace-only', async () => {
    const search = vi.fn();
    const controller = createSearchController({ searchService: stubService(search) });
    const res = fakeRes();

    await controller.search(fakeReq({ q: '   ' }, ['chan-1']), res);

    expect(res.statusCode).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('should return 200 with the service payload on success', async () => {
    const payload = { results: [] };
    const search = vi.fn(async () => payload);
    const controller = createSearchController({ searchService: stubService(search) });
    const res = fakeRes();

    await controller.search(fakeReq({ q: 'hello' }, ['chan-1']), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(payload);
    // limit defaults to 5; scope is passed through from req.allowedChannelIds.
    expect(search).toHaveBeenCalledWith('hello', 5, ['chan-1']);
  });

  it('should default the scope to [] when the RBAC middleware left it unset', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const controller = createSearchController({ searchService: stubService(search) });
    const res = fakeRes();

    await controller.search(fakeReq({ q: 'hello' }), res);

    expect(search).toHaveBeenCalledWith('hello', 5, []);
  });

  it('should map a service error to 500 INTERNAL without leaking it', async () => {
    const search = vi.fn(async () => {
      throw new Error('pgvector exploded: secret internal detail');
    });
    const controller = createSearchController({ searchService: stubService(search) });
    const res = fakeRes();

    await controller.search(fakeReq({ q: 'hello' }, ['chan-1']), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});
