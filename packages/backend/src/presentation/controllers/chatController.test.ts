// Unit tests for the chat controller's HTTP/SSE mapping: 400 on invalid body,
// 404 on an unowned/unknown conversationId (pre-stream), SSE framing + frame
// writes on success, and a terminal error frame on a mid-stream failure. Uses
// fake req/res — no Express, no infra. Mirrors searchController.test.ts.
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { SSEFrame } from '@share2brain/shared/schemas';

import { ChatOwnershipError, type ChatService } from '../../application/services/chatService.js';
import { createChatController } from './chatController.js';

function fakeRes(): Response & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  flushed: boolean;
  writes: string[];
  ended: boolean;
} {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    flushed: false,
    writes: [] as string[],
    ended: false,
    // Mirrors the Node http.ServerResponse fields the controller guards on.
    writableEnded: false,
    destroyed: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    flushHeaders() {
      this.flushed = true;
    },
    on() {
      return this;
    },
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    flushed: boolean;
    writes: string[];
    ended: boolean;
  };
}

function fakeReq(body: Record<string, unknown>, allowedChannelIds?: string[]): Request {
  return {
    body,
    allowedChannelIds,
    session: { userId: 'user-1' },
    on: vi.fn(),
  } as unknown as Request;
}

/** A guest session (Story 2.5) with a stubbed `save` and a mutable allowlist. */
function fakeGuestReq(
  body: Record<string, unknown>,
  opts: { allowedChannelIds?: string[]; guestConversationIds?: string[] } = {},
): { req: Request; session: { guestConversationIds?: string[] }; saveCount: () => number } {
  let saves = 0;
  const session = {
    userId: 'guest-sentinel',
    isGuest: true,
    guestConversationIds: opts.guestConversationIds,
    save(cb: (err?: unknown) => void) {
      saves += 1;
      cb();
    },
  };
  const req = { body, allowedChannelIds: opts.allowedChannelIds, session, on: vi.fn() };
  return { req: req as unknown as Request, session, saveCount: () => saves };
}

const stubService = (impl: Partial<ChatService>): ChatService => ({
  resolveConversation: vi.fn(),
  streamChat: vi.fn(),
  ...impl,
}) as ChatService;

// A resolved conversation as chatService returns it (carries timestamps since 5.2).
const CONV = {
  id: 'conv-1',
  userId: 'user-1',
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
};

describe('chatController.chat', () => {
  it('should return 400 VALIDATION_ERROR with the Spanish message when message is blank', async () => {
    const resolveConversation = vi.fn();
    const controller = createChatController({
      chatService: stubService({ resolveConversation }),
    });
    const res = fakeRes();

    await controller.chat(fakeReq({ message: '   ' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Mensaje inválido', code: 'VALIDATION_ERROR' });
    expect(resolveConversation).not.toHaveBeenCalled();
    expect(res.flushed).toBe(false);
  });

  it('should return 404 NOT_FOUND pre-stream when the conversation is not owned', async () => {
    const resolveConversation = vi.fn(async () => {
      throw new ChatOwnershipError('nope');
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation }),
    });
    const res = fakeRes();

    await controller.chat(fakeReq({ message: 'hi', conversationId: '550e8400-e29b-41d4-a716-446655440000' }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
    expect(res.flushed).toBe(false);
  });

  it('should return 500 INTERNAL pre-stream without leaking a resolveConversation error', async () => {
    const resolveConversation = vi.fn(async () => {
      throw new Error('db exploded: secret detail');
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation }),
    });
    const res = fakeRes();

    await controller.chat(fakeReq({ message: 'hi' }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
    expect(res.flushed).toBe(false);
  });

  it('should stream SSE frames and end the response on success', async () => {
    const frames: SSEFrame[] = [
      { type: 'token', content: 'Hi' },
      { type: 'done', conversationId: 'conv-1' },
    ];
    const resolveConversation = vi.fn(async () => (CONV));
    const streamChat = vi.fn(async function* () {
      for (const frame of frames) yield frame;
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();

    await controller.chat(fakeReq({ message: 'hi' }, ['chan-1']), res);

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.headers['Connection']).toBe('keep-alive');
    expect(res.flushed).toBe(true);
    expect(res.writes).toEqual([
      `data: ${JSON.stringify(frames[0])}\n\n`,
      `data: ${JSON.stringify(frames[1])}\n\n`,
    ]);
    expect(res.ended).toBe(true);
    expect(streamChat).toHaveBeenCalledWith(
      CONV,
      'hi',
      ['chan-1'],
      expect.any(AbortSignal),
    );
  });

  it('should thread the guest session allowlist and record a newly-created conversation id (2.5)', async () => {
    const frames: SSEFrame[] = [{ type: 'done', conversationId: 'conv-1' }];
    const resolveConversation = vi.fn(async () => CONV);
    const streamChat = vi.fn(async function* () {
      for (const frame of frames) yield frame;
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();
    const { req, session, saveCount } = fakeGuestReq(
      { message: 'hola' },
      { allowedChannelIds: ['chan-1'], guestConversationIds: [] },
    );

    await controller.chat(req, res);

    // The guest allowlist is threaded into resolveConversation as guestScope …
    expect(resolveConversation).toHaveBeenCalledWith('guest-sentinel', undefined, {
      allowedConversationIds: [],
    });
    // … and the fresh conversation id is recorded in the session (+ persisted) so a
    // later turn in THIS session can resume it.
    expect(session.guestConversationIds).toContain('conv-1');
    expect(saveCount()).toBe(1);
    expect(res.ended).toBe(true);
  });

  it('should NOT record or re-save when a guest resumes an existing conversationId (2.5)', async () => {
    const frames: SSEFrame[] = [{ type: 'done', conversationId: 'conv-1' }];
    const resolveConversation = vi.fn(async () => CONV);
    const streamChat = vi.fn(async function* () {
      for (const frame of frames) yield frame;
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();
    const RESUME_ID = '550e8400-e29b-41d4-a716-446655440000';
    const { req, session, saveCount } = fakeGuestReq(
      { message: 'again', conversationId: RESUME_ID },
      { allowedChannelIds: ['chan-1'], guestConversationIds: [RESUME_ID] },
    );

    await controller.chat(req, res);

    expect(resolveConversation).toHaveBeenCalledWith('guest-sentinel', RESUME_ID, {
      allowedConversationIds: [RESUME_ID],
    });
    expect(session.guestConversationIds).toEqual([RESUME_ID]); // unchanged
    expect(saveCount()).toBe(0); // no re-save on resume
    expect(res.ended).toBe(true);
  });

  it('should emit a terminal error frame and end the response on a mid-stream failure', async () => {
    const resolveConversation = vi.fn(async () => (CONV));
    const streamChat = vi.fn(async function* (): AsyncGenerator<SSEFrame> {
      throw new Error('llm exploded: secret detail');
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();

    await controller.chat(fakeReq({ message: 'hi' }), res);

    expect(res.flushed).toBe(true);
    expect(res.writes).toHaveLength(1);
    expect(res.writes[0]).toContain('"type":"error"');
    expect(res.writes[0]).toContain('"code":"INTERNAL"');
    expect(res.writes[0]).not.toContain('secret detail');
    expect(res.ended).toBe(true);
  });

  it('should default the RBAC scope to [] when the middleware left it unset', async () => {
    const resolveConversation = vi.fn(async () => (CONV));
    const streamChat = vi.fn(async function* (): AsyncGenerator<SSEFrame> {
      yield { type: 'done', conversationId: 'conv-1' };
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();

    await controller.chat(fakeReq({ message: 'hi' }), res);

    expect(streamChat).toHaveBeenCalledWith(
      CONV,
      'hi',
      [],
      expect.any(AbortSignal),
    );
  });

  it('should skip frame writes once the response socket is destroyed (client gone)', async () => {
    const resolveConversation = vi.fn(async () => (CONV));
    const streamChat = vi.fn(async function* (): AsyncGenerator<SSEFrame> {
      yield { type: 'token', content: 'Hi' };
      yield { type: 'done', conversationId: 'conv-1' };
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();
    // Simulate a socket torn down by a client disconnect before frames flow.
    res.destroyed = true;

    await controller.chat(fakeReq({ message: 'hi' }, ['chan-1']), res);

    // The writeFrame guard short-circuits — nothing is written to the dead socket.
    expect(res.writes).toEqual([]);
  });

  it('should not throw when res.write throws synchronously (EPIPE race)', async () => {
    const resolveConversation = vi.fn(async () => (CONV));
    const streamChat = vi.fn(async function* (): AsyncGenerator<SSEFrame> {
      yield { type: 'token', content: 'Hi' };
      yield { type: 'done', conversationId: 'conv-1' };
    });
    const controller = createChatController({
      chatService: stubService({ resolveConversation, streamChat }),
    });
    const res = fakeRes();
    // Guards are false, so writeFrame attempts the write — which throws synchronously.
    res.write = () => {
      throw new Error('EPIPE');
    };

    // Must not reject (an unguarded throw would become an unhandled rejection).
    await expect(controller.chat(fakeReq({ message: 'hi' }, ['chan-1']), res)).resolves.toBeUndefined();
    expect(res.ended).toBe(true);
  });
});
