// The RAG agent's grounding contract: the system prompt instructs the model to
// answer ONLY from retrieved fragments and admit when it has nothing; buildRAGContext
// renders those fragments (channel/author/date) so the model can ground + cite them.
import type { SearchFragment } from '@hivly/shared/schemas';

export const SYSTEM_PROMPT = `You are Hivly, an assistant that answers questions using ONLY the knowledge fragments retrieved from the community's Discord history, provided below as context.

Rules:
- Ground every claim in the provided fragments. Do not use outside knowledge.
- Cite the fragments you rely on by referencing their channel and author inline (e.g. "according to #general, Ada mentioned...").
- If no fragments were retrieved, or none of them answer the question, say plainly that you don't have enough information — do not guess.
- Be concise and direct.`;

/** Render retrieved fragments as grounding context for the `reason` node. */
export function buildRAGContext(fragments: SearchFragment[]): string {
  if (fragments.length === 0) {
    return 'No relevant knowledge fragments were found for this question.';
  }

  const rendered = fragments
    .map(
      (f, i) =>
        `[${i + 1}] #${f.channelName} — ${f.authorName} (${f.createdAt}):\n${f.title} — ${f.description} (${f.link})`,
    )
    .join('\n\n');

  return `Relevant knowledge fragments:\n\n${rendered}`;
}
