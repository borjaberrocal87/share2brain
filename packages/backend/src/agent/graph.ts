// The RAG agent: a real LangGraph StateGraph (AD-11) with explicit nodes
// `retrieve → reason → respond`. No Express here (D1) — the agent is exposed as
// an async generator (`runChat`) so it stays unit-testable with fakes, mirroring
// searchService's no-Express rule. Token streaming does NOT wait for the graph
// to finish: `respond` emits `token` frames through LangGraph's custom stream
// channel (`getWriter`) as the model streams, and `runChat` forwards them live;
// citation + done frames are appended once the graph settles.
import {
  Annotation,
  END,
  START,
  StateGraph,
  getWriter,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';

import type { SearchFragment, SSEFrame } from '@share2brain/shared/schemas';

import type { ChatModel, ChatTurn } from '../domain/repositories/chatModel.js';
import type { RagRetriever } from '../domain/repositories/ragRetriever.js';
import { COMPRESSION_TOKEN_BUDGET, compressIfNeeded } from './compress.js';
import { buildRAGContext, SYSTEM_PROMPT } from './prompt.js';

/** Local cap on retrieved fragments — there is no `knowledge.topK` in config (D3). */
const RETRIEVE_TOP_K = 5;

const AgentState = Annotation.Root({
  /** The conversation so far, ending with the new user turn. */
  messages: Annotation<ChatTurn[]>(),
  allowedChannelIds: Annotation<string[]>(),
  retrievedFragments: Annotation<SearchFragment[]>(),
  conversationId: Annotation<string>(),
  /** Built by `reason`: [systemPrompt, ragContext, ...truncated history] fed to the model. */
  preparedMessages: Annotation<ChatTurn[]>(),
});

type AgentStateType = typeof AgentState.State;

function lastUserMessage(messages: ChatTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i].content;
  }
  return '';
}

function buildGraph(deps: { chatModel: ChatModel; ragRetriever: RagRetriever; memoryWindow: number }) {
  const { chatModel, ragRetriever, memoryWindow } = deps;

  async function retrieveNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const query = lastUserMessage(state.messages);
    const retrievedFragments = await ragRetriever.retrieve(
      query,
      state.allowedChannelIds,
      RETRIEVE_TOP_K,
    );
    return { retrievedFragments };
  }

  async function reasonNode(
    state: AgentStateType,
    config?: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    // Two-stage history preparation (D7 — memory_window and the token budget coexist):
    // 1) memory_window is a coarse turn-COUNT cap (5.1). Guard `<= 0`: `slice(-0)` ===
    //    `slice(0)` would return the FULL history (the opposite of "keep zero turns").
    const windowed = memoryWindow > 0 ? state.messages.slice(-memoryWindow) : [];
    // 2) compressIfNeeded (5.2, AC3) summarizes the oldest turns when the windowed
    //    history still exceeds the token budget; under budget it passes through
    //    unchanged (identical to 5.1 — no regression). Ephemeral (D8): the summary is
    //    only in this prompt, never persisted. A transient summarization failure
    //    (rate limit, network blip) must not fail the whole turn — fall back to the
    //    coarse memory_window-truncated history instead (code-review patch).
    let prepared: ChatTurn[];
    try {
      prepared = await compressIfNeeded(windowed, chatModel, COMPRESSION_TOKEN_BUDGET, config?.signal);
    } catch (err) {
      // A client-disconnect abort is NOT a transient failure to fall back from —
      // rethrow it so it propagates the same way an abort during respondNode does
      // (graph.stream rejects, the turn ends). Swallowing it here would silently
      // continue the turn with paid downstream work for a caller that already left.
      if (config?.signal?.aborted) throw err;
      console.error('[agent] history compression failed, falling back to uncompressed window:', err);
      prepared = windowed;
    }
    // Anthropic only accepts a single leading system message (LangChain extracts
    // just messages[0] into the top-level `system` param; a second system turn
    // stays in the messages array and the API rejects it: "A 'system' message can
    // only appear at index 0"). `prepared` may ALSO begin with a `system` turn —
    // compressIfNeeded (compress.ts) prepends a `<conversation summary>` system
    // message when history is over budget. So fold EVERY system turn (grounding +
    // RAG context + any compression summary) into one index-0 message and keep only
    // the non-system conversation turns after it — never emit two system turns.
    const systemContext = prepared.filter((t) => t.role === 'system').map((t) => t.content);
    const conversation = prepared.filter((t) => t.role !== 'system');
    const preparedMessages: ChatTurn[] = [
      {
        role: 'system',
        content: [SYSTEM_PROMPT, buildRAGContext(state.retrievedFragments), ...systemContext].join(
          '\n\n',
        ),
      },
      ...conversation,
    ];
    return { preparedMessages };
  }

  async function respondNode(
    state: AgentStateType,
    config?: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    const emit = getWriter(config);
    // Thread the graph's abort signal (from graph.stream({ signal })) into the
    // leaf model call — LangGraph only checks the signal between super-steps, so
    // without this the `respond` node would drain the whole LLM stream even after
    // a client disconnect. config.signal cancels the in-flight provider request.
    for await (const chunk of chatModel.stream(state.preparedMessages, config?.signal)) {
      emit?.({ type: 'token', content: chunk } satisfies SSEFrame);
    }
    // Nothing to update in state — tokens were emitted through the writer, not
    // accumulated here; the controller only needs the frames, not the full text.
    return {};
  }

  // Open for extension (AD-11's optional tool_exec loop), closed for modification:
  // a future tool-call node would be added here, not folded into `reason`/`respond`.
  return new StateGraph(AgentState)
    .addNode('retrieve', retrieveNode)
    .addNode('reason', reasonNode)
    .addNode('respond', respondNode)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'reason')
    .addEdge('reason', 'respond')
    .addEdge('respond', END)
    .compile();
}

export interface RunChatInput {
  message: string;
  /** Prior turns already truncated/validated by the caller; new turn is appended here. */
  history: ChatTurn[];
  allowedChannelIds: string[];
  /** Resolved by chatService BEFORE the agent runs (creation/ownership already settled). */
  conversationId: string;
}

export interface RagAgent {
  runChat(input: RunChatInput, signal?: AbortSignal): AsyncIterable<SSEFrame>;
}

export function createRagAgent(deps: {
  chatModel: ChatModel;
  ragRetriever: RagRetriever;
  memoryWindow: number;
}): RagAgent {
  const graph = buildGraph(deps);

  return {
    async *runChat(input, signal): AsyncIterable<SSEFrame> {
      const messages: ChatTurn[] = [...input.history, { role: 'user', content: input.message }];

      const stream = await graph.stream(
        {
          messages,
          allowedChannelIds: input.allowedChannelIds,
          conversationId: input.conversationId,
        },
        { streamMode: ['custom', 'values'], signal },
      );

      let retrievedFragments: SearchFragment[] = [];
      for await (const [mode, chunk] of stream) {
        if (mode === 'custom') {
          yield chunk as SSEFrame;
        } else if (mode === 'values') {
          const values = chunk as AgentStateType;
          if (values.retrievedFragments) retrievedFragments = values.retrievedFragments;
        }
      }

      for (const fragment of retrievedFragments) {
        yield {
          type: 'citation',
          title: fragment.title,
          channel: fragment.channelName,
          author: fragment.authorName,
          date: fragment.createdAt,
          link: fragment.link,
        };
      }

      yield { type: 'done', conversationId: input.conversationId };
    },
  };
}
