// Unit tests for the conversations controller's HTTP mapping: 400 on invalid
// query, 404 on a malformed/unknown/unowned conversationId (D9 — no existence
// leak), 200 with the service payload, 500 mapped to ErrorSchema without leaking
// the underlying error. Uses fake req/res — no Express, no infra. Mirrors
// documentController.test.ts.
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationDetail, ConversationsResponse } from '@share2brain/shared/schemas';

import type { ConversationService } from '../../application/services/conversationService.js';
import { createConversationController } from './conversationController.js';

const VALID_ID = '550e8400-e29b-41d4-a716-446655440000';

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

function fakeReq(query: Record<string, unknown>, params: Record<string, unknown> = {}): Request {
  return { query, params, session: { userId: 'user-1' } } as unknown as Request;
}

const stubService = (impl: Partial<ConversationService>): ConversationService => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  ...impl,
}) as ConversationService;

describe('conversationController.list', () => {
  it('should return 400 VALIDATION_ERROR when page is invalid', async () => {
    const listConversations = vi.fn();
    const controller = createConversationController({ conversationService: stubService({ listConversations }) });
    const res = fakeRes();

    await controller.list(fakeReq({ page: '0' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Parámetros inválidos', code: 'VALIDATION_ERROR' });
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('should return 200 with the service payload, defaulting page/limit', async () => {
    const payload: ConversationsResponse = { results: [], page: 1, limit: 20, total: 0 };
    const listConversations = vi.fn(async () => payload);
    const controller = createConversationController({ conversationService: stubService({ listConversations }) });
    const res = fakeRes();

    await controller.list(fakeReq({}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(payload);
    expect(listConversations).toHaveBeenCalledWith('user-1', 1, 20);
  });

  it('should map a service error to 500 INTERNAL without leaking it', async () => {
    const listConversations = vi.fn(async () => {
      throw new Error('pg exploded: secret internal detail');
    });
    const controller = createConversationController({ conversationService: stubService({ listConversations }) });
    const res = fakeRes();

    await controller.list(fakeReq({}), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});

describe('conversationController.getById', () => {
  it('should return 404 NOT_FOUND on a malformed (non-UUID) conversationId (D9)', async () => {
    const getConversation = vi.fn();
    const controller = createConversationController({ conversationService: stubService({ getConversation }) });
    const res = fakeRes();

    await controller.getById(fakeReq({}, { conversationId: 'not-a-uuid' }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
    // Never even reach the service for a malformed id.
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('should return 404 NOT_FOUND when the service returns null (unknown/unowned)', async () => {
    const getConversation = vi.fn(async () => null);
    const controller = createConversationController({ conversationService: stubService({ getConversation }) });
    const res = fakeRes();

    await controller.getById(fakeReq({}, { conversationId: VALID_ID }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
    expect(getConversation).toHaveBeenCalledWith('user-1', VALID_ID);
  });

  it('should return 200 with the detail when owned', async () => {
    const detail: ConversationDetail = {
      id: VALID_ID,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T01:00:00.000Z',
      messages: [],
    };
    const getConversation = vi.fn(async () => detail);
    const controller = createConversationController({ conversationService: stubService({ getConversation }) });
    const res = fakeRes();

    await controller.getById(fakeReq({}, { conversationId: VALID_ID }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(detail);
  });

  it('should map a service error to 500 INTERNAL without leaking it', async () => {
    const getConversation = vi.fn(async () => {
      throw new Error('pg exploded: secret internal detail');
    });
    const controller = createConversationController({ conversationService: stubService({ getConversation }) });
    const res = fakeRes();

    await controller.getById(fakeReq({}, { conversationId: VALID_ID }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});
