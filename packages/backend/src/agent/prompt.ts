// The RAG agent's grounding contract: the system prompt instructs the model to
// answer ONLY from the curated community resources retrieved and admit when it
// has nothing; buildRAGContext renders those resources (title/description/link,
// channel/author/date) so the model can ground, cite, and link them.
import type { SearchFragment } from '@share2brain/shared/schemas';

export const SYSTEM_PROMPT = `You are Share2Brain, an assistant that answers questions using ONLY the curated community resources retrieved from the server's knowledge index, provided below as context.

Rules:
- Ground every claim in the provided resources. Do not use outside knowledge.
- Cite the resources you rely on by referencing their channel and author inline (e.g. "according to #general, Ada mentioned...").
- When you recommend a resource, include its link in your answer so the user can open it.
- If no resources were retrieved, or none of them answer the question, say plainly that you don't have enough information — do not guess.
- Be concise and direct.`;

/** Render retrieved resources as grounding context for the `reason` node. */
export function buildRAGContext(fragments: SearchFragment[]): string {
  if (fragments.length === 0) {
    return 'No relevant resources were found for this question.';
  }

  const rendered = fragments
    .map(
      (f, i) =>
        `[${i + 1}] #${f.channelName} — ${f.authorName} (${f.createdAt}):\n${f.title} — ${f.description} (${f.link})`,
    )
    .join('\n\n');

  return `Relevant resources:\n\n${rendered}`;
}
