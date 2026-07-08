// Infrastructure adapter: LangChain-backed ChatModel. The ONLY agent-side file
// that imports the provider factory — LangChain stays behind this boundary and
// never leaks into the graph/service (AD-2 spirit). Mirrors queryEmbedder.langchain.ts.
import type { HivlyConfig } from '@hivly/shared';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createChatModel } from '@hivly/shared/providers';

import type { ChatModel, ChatTurn } from '../domain/repositories/chatModel.js';

/**
 * Structural guard: providers (Anthropic in particular) accept only ONE system
 * message and only as the leading turn — a second system turn, or a system turn at
 * a non-zero index, is rejected with `400 A 'system' message can only appear at
 * index 0`. That contract is invisible to the fake ChatModel used in unit/integration
 * tests, so it slipped through until a real-provider chat hit it. This guard makes the
 * invariant fail loud (unit-tested directly) at the one boundary every caller crosses,
 * regardless of which graph node assembled the messages. Callers must flatten their
 * system turns into a single index-0 message before streaming (see graph.ts reasonNode).
 */
export function assertSingleLeadingSystem(messages: ChatTurn[]): void {
  const systemCount = messages.reduce((n, m) => (m.role === 'system' ? n + 1 : n), 0);
  if (systemCount > 1) {
    throw new Error(
      `ChatModel received ${systemCount} system messages; providers accept only one leading system message. ` +
        'Fold every system turn (grounding + RAG context + any compression summary) into a single index-0 message.',
    );
  }
  if (systemCount === 1 && messages[0]?.role !== 'system') {
    throw new Error(
      'ChatModel received a system message at a non-zero index; the single system message must be at index 0.',
    );
  }
}

function toLangchainMessage(turn: ChatTurn): BaseMessage {
  switch (turn.role) {
    case 'system':
      return new SystemMessage(turn.content);
    case 'assistant':
      return new AIMessage(turn.content);
    case 'user':
      return new HumanMessage(turn.content);
    default: {
      const exhaustive: never = turn.role;
      throw new Error(`Unknown chat turn role: ${String(exhaustive)}`);
    }
  }
}

/** A stream chunk's `.content` may be a plain string or a list of content parts
 * (e.g. some providers emit `{ type: 'text', text: '...' }` blocks). Normalize
 * to the plain text the port contracts for. */
function chunkToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return '';
}

export function createLangchainChatModel(agent: HivlyConfig['agent']): ChatModel {
  // Build once; reuse across requests. No network I/O at construction.
  const model = createChatModel(agent);

  return {
    async *stream(messages: ChatTurn[], signal?: AbortSignal): AsyncIterable<string> {
      // Fail loud before the provider does — surfaces a mis-assembled prompt as a
      // clear error at the boundary instead of an opaque provider 400.
      assertSingleLeadingSystem(messages);
      const langchainMessages = messages.map(toLangchainMessage);
      // Pass the abort signal into the provider request so a client disconnect
      // cancels generation mid-flight (LangChain honors RunnableConfig.signal).
      const stream = await model.stream(langchainMessages, { signal });
      for await (const chunk of stream) {
        const text = chunkToText(chunk.content);
        if (text) yield text;
      }
    },
  };
}
