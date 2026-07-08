import { describe, expect, it, vi } from 'vitest';

import type { SearchFragment, SSEFrame } from '@hivly/shared/schemas';

import type { ChatModel, ChatTurn } from '../domain/repositories/chatModel.js';
import type { RagRetriever } from '../domain/repositories/ragRetriever.js';
import { createRagAgent } from './graph.js';
import { SYSTEM_PROMPT } from './prompt.js';

function fakeChatModel(chunks: string[]): ChatModel {
  return {
    async *stream(): AsyncIterable<string> {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Records the prepared messages the `reason` node hands to the model, so tests
 * can assert history-truncation behavior (the `memory_window` guard). */
function recordingChatModel(): ChatModel & { received: ChatTurn[][] } {
  const received: ChatTurn[][] = [];
  return {
    received,
    async *stream(messages: ChatTurn[]): AsyncIterable<string> {
      received.push(messages);
      yield 'ok';
    },
  };
}

function fakeFragment(overrides: Partial<SearchFragment> = {}): SearchFragment {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    content: 'the answer is 42',
    channelId: 'chan-1',
    channelName: 'general',
    authorId: 'author-1',
    authorName: 'ada',
    createdAt: '2026-07-06T00:00:00.000Z',
    similarity: 0.9,
    messageId: 'msg-1',
    ...overrides,
  };
}

function fakeRagRetriever(fragments: SearchFragment[]): RagRetriever {
  return {
    async retrieve(_query, allowedChannelIds) {
      return allowedChannelIds.length === 0 ? [] : fragments;
    },
  };
}

async function collect(frames: AsyncIterable<SSEFrame>): Promise<SSEFrame[]> {
  const out: SSEFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

describe('createRagAgent().runChat', () => {
  it('should yield token frames, then citation frames, then a terminal done frame', async () => {
    const agent = createRagAgent({
      chatModel: fakeChatModel(['Hello', ' world']),
      ragRetriever: fakeRagRetriever([fakeFragment()]),
      memoryWindow: 20,
    });

    const frames = await collect(
      agent.runChat({
        message: 'what is the answer?',
        history: [],
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-1',
      }),
    );

    expect(frames).toEqual([
      { type: 'token', content: 'Hello' },
      { type: 'token', content: ' world' },
      { type: 'citation', channel: 'general', author: 'ada', date: '2026-07-06T00:00:00.000Z' },
      { type: 'done', conversationId: 'conv-1' },
    ]);
  });

  it('should emit no citation frames when the RBAC scope is empty', async () => {
    const agent = createRagAgent({
      chatModel: fakeChatModel(['ok']),
      ragRetriever: fakeRagRetriever([fakeFragment()]),
      memoryWindow: 20,
    });

    const frames = await collect(
      agent.runChat({
        message: 'anything?',
        history: [],
        allowedChannelIds: [],
        conversationId: 'conv-2',
      }),
    );

    expect(frames.filter((f) => f.type === 'citation')).toHaveLength(0);
    expect(frames.at(-1)).toEqual({ type: 'done', conversationId: 'conv-2' });
  });

  it('should map fragment fields to the citation frame correctly', async () => {
    const agent = createRagAgent({
      chatModel: fakeChatModel(['x']),
      ragRetriever: fakeRagRetriever([
        fakeFragment({ channelName: 'random', authorName: 'grace', createdAt: '2026-01-01T00:00:00.000Z' }),
      ]),
      memoryWindow: 20,
    });

    const frames = await collect(
      agent.runChat({
        message: 'q',
        history: [],
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-3',
      }),
    );

    expect(frames).toContainEqual({
      type: 'citation',
      channel: 'random',
      author: 'grace',
      date: '2026-01-01T00:00:00.000Z',
    });
  });

  it('should carry the conversationId from the input in the done frame', async () => {
    const agent = createRagAgent({
      chatModel: fakeChatModel([]),
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 20,
    });

    const frames = await collect(
      agent.runChat({
        message: 'q',
        history: [],
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-4',
      }),
    );

    expect(frames.at(-1)).toEqual({ type: 'done', conversationId: 'conv-4' });
  });

  it('should include the current turn in the prompt when memoryWindow >= 1', async () => {
    const model = recordingChatModel();
    const agent = createRagAgent({
      chatModel: model,
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 1,
    });

    await collect(
      agent.runChat({
        message: 'the question',
        history: [],
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-5',
      }),
    );

    const prepared = model.received[0];
    expect(prepared.some((t) => t.role === 'user' && t.content === 'the question')).toBe(true);
    // UNCOMPRESSED PATH: exactly ONE system turn, at index 0 (grounding + RAG context
    // merged). The counterpart of the compression-path assertion — the single-leading-
    // system invariant must hold whether or not compression fired.
    expect(prepared.filter((t) => t.role === 'system')).toHaveLength(1);
    expect(prepared[0].role).toBe('system');
    expect(prepared[0].content).toContain(SYSTEM_PROMPT);
  });

  it('should compress an over-budget history into a system summary before the model reasons (AC3)', async () => {
    const model = recordingChatModel();
    const agent = createRagAgent({
      chatModel: model,
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 20,
    });

    // A long prior history (≈6000 tokens) that exceeds the 4000-token budget, so the
    // reason node summarizes the oldest turns before building the model prompt.
    const history: ChatTurn[] = [
      { role: 'user', content: 'a'.repeat(4000) },
      { role: 'assistant', content: 'b'.repeat(4000) },
      { role: 'user', content: 'c'.repeat(4000) },
      { role: 'assistant', content: 'd'.repeat(4000) },
    ];

    await collect(
      agent.runChat({
        message: 'the follow-up',
        history,
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-compress',
      }),
    );

    // The model is streamed twice: once to summarize (reason), once to respond.
    expect(model.received.length).toBe(2);
    const respondPrompt = model.received.at(-1) as ChatTurn[];
    // COMPRESSION PATH: exactly ONE system turn, at index 0 — the compression summary
    // is FOLDED INTO the single grounding system message, never emitted as a second
    // system turn (which Anthropic rejects with "a 'system' message can only appear at
    // index 0"). This is the regression the multi-system fix closes.
    expect(respondPrompt.filter((t) => t.role === 'system')).toHaveLength(1);
    expect(respondPrompt[0].role).toBe('system');
    // The ephemeral summary is present, but as part of that single system message.
    expect(respondPrompt[0].content).toContain('<conversation summary>');
    // The current turn is still present verbatim (recent tail preserved).
    expect(respondPrompt.some((t) => t.role === 'user' && t.content === 'the follow-up')).toBe(true);
  });

  it('should fall back to the VERBATIM uncompressed window when summarization fails (code-review patch)', async () => {
    let calls = 0;
    const received: ChatTurn[][] = [];
    const model: ChatModel = {
      async *stream(messages: ChatTurn[]): AsyncIterable<string> {
        calls += 1;
        if (calls === 1) throw new Error('summarization provider blip');
        received.push(messages);
        yield 'ok';
      },
    };
    const agent = createRagAgent({
      chatModel: model,
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 20,
    });
    const history: ChatTurn[] = [
      { role: 'user', content: 'a'.repeat(4000) },
      { role: 'assistant', content: 'b'.repeat(4000) },
      { role: 'user', content: 'c'.repeat(4000) },
      { role: 'assistant', content: 'd'.repeat(4000) },
    ];

    const frames = await collect(
      agent.runChat({
        message: 'the follow-up',
        history,
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-compress-fail',
      }),
    );

    // The turn still completes — a transient summarization failure does not abort
    // the whole turn; reasonNode falls back to the memory_window-truncated history.
    expect(frames.at(-1)).toEqual({ type: 'done', conversationId: 'conv-compress-fail' });
    // The respond prompt carries the RAW windowed history, NOT a compressed summary —
    // proving the fallback actually used `windowed`, not an empty/partial substitute.
    const respondPrompt = received.at(-1) as ChatTurn[];
    expect(respondPrompt.some((t) => t.content.startsWith('<conversation summary>'))).toBe(false);
    expect(respondPrompt.some((t) => t.role === 'user' && t.content === 'a'.repeat(4000))).toBe(true);
    expect(respondPrompt.some((t) => t.role === 'assistant' && t.content === 'd'.repeat(4000))).toBe(true);
  });

  it('should propagate (not swallow) an abort that occurs during summarization (code-review patch)', async () => {
    // NOTE on what this test can and can't prove: LangGraph itself checks the
    // abort signal between super-steps, so `graph.stream` rejects once the signal
    // is aborted regardless of whether reasonNode's own catch rethrows or falls
    // back — a bare `.rejects.toThrow()` (or a respond-call count) can't tell the
    // two branches apart (verified empirically: temporarily removing the guard
    // still left this assertion passing). The one thing the guard's PLACEMENT
    // actually changes is whether the misleading "history compression failed"
    // error gets logged for a plain client disconnect — that's what we assert.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new AbortController();
    const model: ChatModel = {
      async *stream(): AsyncIterable<string> {
        // Simulate the client disconnecting WHILE the summarization request is
        // in flight, then the provider call rejecting with an abort error.
        controller.abort();
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    };
    const agent = createRagAgent({
      chatModel: model,
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 20,
    });
    const history: ChatTurn[] = [
      { role: 'user', content: 'a'.repeat(4000) },
      { role: 'assistant', content: 'b'.repeat(4000) },
      { role: 'user', content: 'c'.repeat(4000) },
      { role: 'assistant', content: 'd'.repeat(4000) },
    ];

    await expect(
      collect(
        agent.runChat(
          {
            message: 'the follow-up',
            history,
            allowedChannelIds: ['chan-1'],
            conversationId: 'conv-compress-abort',
          },
          controller.signal,
        ),
      ),
    ).rejects.toThrow();
    // The abort guard runs BEFORE the fallback's console.error — an aborted
    // signal must never be logged as a "history compression failed" error.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('should thread the abort signal into the summarization call (code-review patch)', async () => {
    const receivedSignals: (AbortSignal | undefined)[] = [];
    const model: ChatModel = {
      async *stream(_messages: ChatTurn[], signal?: AbortSignal): AsyncIterable<string> {
        receivedSignals.push(signal);
        yield 'ok';
      },
    };
    const agent = createRagAgent({
      chatModel: model,
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 20,
    });
    const controller = new AbortController();
    const history: ChatTurn[] = [
      { role: 'user', content: 'a'.repeat(4000) },
      { role: 'assistant', content: 'b'.repeat(4000) },
      { role: 'user', content: 'c'.repeat(4000) },
      { role: 'assistant', content: 'd'.repeat(4000) },
    ];

    await collect(
      agent.runChat(
        {
          message: 'the follow-up',
          history,
          allowedChannelIds: ['chan-1'],
          conversationId: 'conv-compress-signal',
        },
        controller.signal,
      ),
    );

    // Both the summarization call (reason) and the respond call are handed a real
    // signal (not undefined) — proving graph.stream's signal is threaded through
    // reasonNode -> compressIfNeeded -> summarize -> chatModel.stream, not just into
    // respondNode as before this patch. LangGraph's own signal-honoring guarantee
    // (that graph.stream({signal}) actually cancels an in-flight run) is already
    // exercised end-to-end for respondNode elsewhere (5.1 review); this test only
    // guards THIS diff's new plumbing.
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('should truncate history to [] when memoryWindow <= 0 (guards slice(-0) === full history)', async () => {
    const model = recordingChatModel();
    const agent = createRagAgent({
      chatModel: model,
      ragRetriever: fakeRagRetriever([]),
      memoryWindow: 0,
    });

    await collect(
      agent.runChat({
        message: 'the question',
        history: [],
        allowedChannelIds: ['chan-1'],
        conversationId: 'conv-6',
      }),
    );

    // With the guard, memoryWindow 0 keeps zero turns — only the single merged
    // system + RAG context message remains (no user turn). Without the guard,
    // slice(-0) would have returned the FULL history instead.
    const prepared = model.received[0];
    expect(prepared.every((t) => t.role === 'system')).toBe(true);
    // Still exactly one system turn — an empty window must not drop the invariant.
    expect(prepared).toHaveLength(1);
  });
});
