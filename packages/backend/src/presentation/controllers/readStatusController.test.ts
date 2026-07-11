// Unit tests for the read-status controller's HTTP mapping: 400/403/404/200/500
// mappings without leaking. Uses fake req/res — no Express, no infra.
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { ReadStatusService } from '../../application/services/readStatusService.js';
import { createReadStatusController } from './readStatusController.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

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

function fakeReq(opts: {
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  allowedChannelIds?: string[];
}): Request {
  return {
    params: opts.params ?? {},
    body: opts.body ?? {},
    allowedChannelIds: opts.allowedChannelIds,
    session: { userId: 'user-1' },
  } as unknown as Request;
}

function stubService(overrides: Partial<ReadStatusService> = {}): ReadStatusService {
  return {
    markRead: vi.fn(async () => ({ ok: true }) as const),
    unmarkRead: vi.fn(async () => undefined),
    markAll: vi.fn(async () => ({ ok: true, response: { markedCount: 0 } }) as const),
    unreadCount: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('readStatusController.markRead', () => {
  it('should return 400 on a non-UUID embeddingId', async () => {
    const controller = createReadStatusController({ readStatusService: stubService() });
    const res = fakeRes();

    await controller.markRead(fakeReq({ params: { embeddingId: 'not-a-uuid' } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Identificador de fragmento inválido', code: 'VALIDATION_ERROR' });
  });

  it('should return 404 when the service reports not-found (D5)', async () => {
    const readStatusService = stubService({ markRead: vi.fn(async () => ({ ok: false, reason: 'not-found' }) as const) });
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.markRead(fakeReq({ params: { embeddingId: VALID_UUID }, allowedChannelIds: ['chan-1'] }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Fragmento no encontrado', code: 'NOT_FOUND' });
  });

  it('should return 200 on success', async () => {
    const controller = createReadStatusController({ readStatusService: stubService() });
    const res = fakeRes();

    await controller.markRead(fakeReq({ params: { embeddingId: VALID_UUID }, allowedChannelIds: ['chan-1'] }), res);

    expect(res.statusCode).toBe(200);
  });

  it('should map a service error to 500 INTERNAL without leaking it', async () => {
    const readStatusService = stubService({
      markRead: vi.fn(async () => {
        throw new Error('pg exploded: secret internal detail');
      }),
    });
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.markRead(fakeReq({ params: { embeddingId: VALID_UUID } }), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});

describe('readStatusController.unmarkRead', () => {
  it('should return 400 on a non-UUID embeddingId', async () => {
    const controller = createReadStatusController({ readStatusService: stubService() });
    const res = fakeRes();

    await controller.unmarkRead(fakeReq({ params: { embeddingId: 'nope' } }), res);

    expect(res.statusCode).toBe(400);
  });

  it('should return 200 regardless of whether a row existed (idempotent, AC4)', async () => {
    const readStatusService = stubService();
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.unmarkRead(fakeReq({ params: { embeddingId: VALID_UUID } }), res);

    expect(res.statusCode).toBe(200);
    // Third arg is the guest flag (false for a normal member session).
    expect(readStatusService.unmarkRead).toHaveBeenCalledWith('user-1', VALID_UUID, false);
  });
});

describe('readStatusController.markAll', () => {
  it('should return 403 when the service reports forbidden (D6)', async () => {
    const readStatusService = stubService({ markAll: vi.fn(async () => ({ ok: false, reason: 'forbidden' }) as const) });
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.markAll(fakeReq({ body: { channelId: 'chan-denied' }, allowedChannelIds: ['chan-1'] }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Sin acceso al canal', code: 'FORBIDDEN' });
  });

  it('should return 200 with markedCount on success', async () => {
    const readStatusService = stubService({
      markAll: vi.fn(async () => ({ ok: true, response: { markedCount: 7 } }) as const),
    });
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.markAll(fakeReq({ allowedChannelIds: ['chan-1'] }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ markedCount: 7 });
  });

  it('should return 400 on an invalid body (empty-string channelId)', async () => {
    const controller = createReadStatusController({ readStatusService: stubService() });
    const res = fakeRes();

    await controller.markAll(fakeReq({ body: { channelId: '' } }), res);

    expect(res.statusCode).toBe(400);
  });
});

describe('readStatusController.unreadCount', () => {
  it('should return 200 with the per-channel map (D7)', async () => {
    const readStatusService = stubService({ unreadCount: vi.fn(async () => ({ 'chan-1': 3 })) });
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.unreadCount(fakeReq({ allowedChannelIds: ['chan-1'] }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ 'chan-1': 3 });
  });

  it('should map a service error to 500 INTERNAL without leaking it', async () => {
    const readStatusService = stubService({
      unreadCount: vi.fn(async () => {
        throw new Error('pg exploded: secret internal detail');
      }),
    });
    const controller = createReadStatusController({ readStatusService });
    const res = fakeRes();

    await controller.unreadCount(fakeReq({}), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});
