// History compression for the RAG agent's `reason` node (AD-11 — explicit graph
// state work, NOT a langchain/memory object). When a conversation's accumulated
// history exceeds a token budget, the oldest turns are summarized into one compact
// `system` message while the most-recent turns are kept verbatim, so the model gets
// context without blowing the token budget. Compression is EPHEMERAL (D8): the
// summary lives only in this turn's prompt — it is never persisted to `messages`.
//
// Design (Story 5.2, D5/D6):
//  - Local COMPRESSION_TOKEN_BUDGET = 4000; there is NO `agent.memoryBudget` in
//    Share2BrainConfigSchema (5.1 D3 corrected TECHNICAL-DESIGN's naming error).
//  - estimateTokens is a deterministic char/4 heuristic — no tokenizer dependency,
//    fully unit-testable. It is an ESTIMATE, not exact provider tokenization.
//  - summarize drains ChatModel.stream() into a string (the port only exposes
//    stream(); do NOT widen it to invoke() — the deterministic fakeChatModel then
//    works unchanged).
import type { ChatModel, ChatTurn } from '../domain/repositories/chatModel.js';

/** Token budget above which history gets compressed (D5). Matches the epic AC and
 * CHAT_MESSAGE_MAX_LENGTH; a local constant since config has no `agent.memoryBudget`. */
export const COMPRESSION_TOKEN_BUDGET = 4000;

/**
 * Deterministic, provider-neutral token ESTIMATE (~4 chars/token). Not exact
 * tokenization — chosen so compression is testable without adding a tokenizer dep.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sum the estimated tokens across a set of turns. */
function totalTokens(messages: ChatTurn[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * Summarize `turns` into a single compact string by draining the ChatModel's stream
 * (D6 — the port is stream-only). English instruction prompt; preserves key facts,
 * decisions, and open questions.
 */
async function summarize(
  turns: ChatTurn[],
  chatModel: ChatModel,
  signal?: AbortSignal,
): Promise<string> {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  const prompt: ChatTurn[] = [
    {
      role: 'system',
      content:
        'Summarize the following conversation excerpt as concisely as possible, ' +
        'preserving key facts, decisions, and open questions. Output only the summary.',
    },
    { role: 'user', content: transcript },
  ];

  let summary = '';
  // Thread the graph's abort signal (mirrors respondNode) so a client disconnect
  // cancels this paid summarization call instead of draining to completion.
  for await (const chunk of chatModel.stream(prompt, signal)) {
    summary += chunk;
  }
  return summary.trim();
}

/**
 * If the summed estimated tokens over `messages` are within `maxTokens`, return
 * `messages` unchanged (the 5.1 pass-through behavior — a pure superset, no
 * regression). Otherwise summarize the oldest turns into one `system` message and
 * keep the most-recent turns (the tail that fits under a reserved slice of the
 * budget) verbatim, returning `[summary, ...recent]`.
 */
export async function compressIfNeeded(
  messages: ChatTurn[],
  chatModel: ChatModel,
  maxTokens = COMPRESSION_TOKEN_BUDGET,
  signal?: AbortSignal,
): Promise<ChatTurn[]> {
  if (totalTokens(messages) <= maxTokens) return messages;

  // Reserve part of the budget for the verbatim recent tail; summarize the rest.
  const recentBudget = Math.floor(maxTokens / 2);
  const recent: ChatTurn[] = [];
  let recentTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(messages[i].content);
    // Always keep at least the last turn, even if it alone exceeds the reserve.
    if (recent.length > 0 && recentTokens + cost > recentBudget) break;
    recent.unshift(messages[i]);
    recentTokens += cost;
  }

  const older = messages.slice(0, messages.length - recent.length);
  // A single oversized turn leaves nothing older to summarize — pass through
  // unchanged rather than prepend an empty summary.
  if (older.length === 0) return messages;

  const summary = await summarize(older, chatModel, signal);
  return [{ role: 'system', content: `<conversation summary> ${summary}` }, ...recent];
}
