// Application service: chat turn orchestration. Split into two steps so the
// controller can satisfy D8 (two-phase error handling): `resolveConversation`
// runs BEFORE any SSE header is sent (ownership failures are a pre-stream 404),
// `streamChat` runs the turn against an already-resolved conversation. Depends
// only on the agent + ConversationRepository port — no Drizzle, no Express, no
// LangChain — so it is unit-testable with fakes. Mirrors searchService.ts.
import type { Citation } from '@share2brain/shared/db';
import type { SSEFrame } from '@share2brain/shared/schemas';

import type { RagAgent } from '../../agent/graph.js';
import type { ChatTurn } from '../../domain/repositories/chatModel.js';
import type {
  Conversation,
  ConversationRepository,
} from '../../domain/repositories/conversationRepository.js';

/** Thrown by resolveConversation when a client-supplied conversationId is
 * unknown or not owned by the caller — the controller maps this to a
 * pre-stream 404 (D8). */
export class ChatOwnershipError extends Error {}

export interface ChatService {
  /**
   * Resolve the conversation for this turn BEFORE any SSE header is sent
   * (D8): create a new one when `conversationId` is absent/null, or return the
   * existing one when it is owned by `userId`. Throws {@link ChatOwnershipError}
   * when `conversationId` is given but unknown/not owned.
   *
   * `guestScope` (Story 2.5 review): present only for guest sessions. All guests
   * share one sentinel `userId`, so `getOwnedConversation` cannot distinguish one
   * guest's conversation from another's — resume is instead gated on the caller's
   * per-session allowlist. A `conversationId` outside it throws
   * {@link ChatOwnershipError} (→ pre-stream 404), keeping guest chat ephemeral.
   */
  resolveConversation(
    userId: string,
    conversationId: string | null | undefined,
    guestScope?: { allowedConversationIds: readonly string[] },
  ): Promise<Conversation>;

  /**
   * Run one chat turn against an already-resolved conversation: persists the
   * user message, streams the agent's frames (forwarded as-is to the caller),
   * accumulates the answer + citations to persist the assistant message, and
   * bumps `conversations.updated_at`. The `done` frame the agent yields already
   * carries `conversation.id` (AC9).
   */
  streamChat(
    conversation: Conversation,
    message: string,
    allowedChannelIds: string[],
    signal?: AbortSignal,
  ): AsyncIterable<SSEFrame>;
}

export function createChatService(deps: {
  agent: RagAgent;
  conversationRepo: ConversationRepository;
}): ChatService {
  const { agent, conversationRepo } = deps;

  return {
    async resolveConversation(userId, conversationId, guestScope): Promise<Conversation> {
      if (!conversationId) {
        return conversationRepo.createConversation(userId);
      }
      // Story 2.5 (review): for a guest, DB ownership is not a per-session boundary
      // (shared sentinel userId) — the session allowlist is. A conversationId that
      // this guest session didn't create is out of scope, even though the row is
      // "owned" by the guest user. Same 404 as an unknown/unowned id (no signal).
      if (guestScope && !guestScope.allowedConversationIds.includes(conversationId)) {
        throw new ChatOwnershipError('Conversation not in the guest session scope');
      }
      const conversation = await conversationRepo.getOwnedConversation(conversationId, userId);
      if (!conversation) {
        throw new ChatOwnershipError('Conversation not found or not owned by user');
      }
      return conversation;
    },

    async *streamChat(conversation, message, allowedChannelIds, signal): AsyncIterable<SSEFrame> {
      // AC4 (closes 5.1 D13): load the conversation's PRIOR turns so the agent
      // reasons over the whole history, not just the new message. Compression of an
      // over-long history happens downstream in the agent's `reason` node (D5), not
      // here — this service just supplies the turns.
      //
      // ORDERING IS LOAD-BEARING (D4 — the double-append trap): runChat appends the
      // current user message itself (agent/graph.ts). So getMessages MUST run BEFORE
      // the appendMessage(user) below — that way it returns ONLY prior turns and the
      // current message is added exactly once (by runChat). Do NOT reorder these two
      // DB calls: loading after the insert would put the current message in `history`
      // AND have runChat append it again → a duplicated turn in the prompt.
      const priorMessages = await conversationRepo.getMessages(conversation.id);
      // No `system` rows are persisted today (compression is ephemeral, D8); drop
      // any defensively so the prompt only ever carries user/assistant turns.
      const history: ChatTurn[] = priorMessages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      await conversationRepo.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        content: message,
        citations: [],
      });

      let answer = '';
      const citations: Citation[] = [];

      // Persist the assistant turn exactly once. Called on the `done` path
      // BEFORE the frame is forwarded (so the client never sees `done` before
      // the answer is committed), and again in `finally` so an interrupted turn
      // (LLM error or client disconnect via the abort signal) still persists the
      // partial answer + bumps updated_at instead of orphaning the user message.
      let persisted = false;
      const persistAssistant = async (): Promise<void> => {
        if (persisted) return;
        persisted = true;
        // Don't persist an empty turn (an abort before the first token, or a
        // model that returned nothing) — it would orphan a blank assistant
        // bubble next to the user message. Nothing streamed → nothing to save.
        if (answer.length === 0 && citations.length === 0) return;
        await conversationRepo.appendMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: answer,
          citations,
        });
        // The updated_at bump is best-effort: once the answer is committed, a
        // failed timestamp write must NOT propagate — otherwise a fully-saved
        // turn would surface to the client as an `error` (suppressing `done`)
        // and trigger a retry that duplicates the assistant message.
        try {
          await conversationRepo.touchConversation(conversation.id);
        } catch (err) {
          console.error(
            '[chat] touchConversation failed (answer already persisted):',
            err instanceof Error ? err.message : String(err),
          );
        }
      };

      try {
        for await (const frame of agent.runChat(
          { message, history, allowedChannelIds, conversationId: conversation.id },
          signal,
        )) {
          if (frame.type === 'token') {
            answer += frame.content;
          } else if (frame.type === 'citation') {
            citations.push({
              title: frame.title,
              channel: frame.channel,
              author: frame.author,
              date: frame.date,
              link: frame.link,
            });
          } else if (frame.type === 'done') {
            // Commit the answer BEFORE emitting `done` — a persistence failure
            // here throws to the controller, which emits an `error` frame
            // instead of a `done` the client would trust.
            await persistAssistant();
          }
          yield frame;
        }
      } finally {
        // Interrupted before `done` (error/abort): persist whatever streamed so
        // far. No-op if the `done` branch already committed. Swallow persistence
        // errors here so they don't mask the original interruption cause.
        try {
          await persistAssistant();
        } catch (err) {
          console.error(
            '[chat] failed to persist interrupted turn:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    },
  };
}
