// Pure chunking stage (AC-2). Wraps LangChain's RecursiveCharacterTextSplitter so
// `chunk_size`/`chunk_overlap` keep their configured meaning approximately.
//
// There is no tokenizer for qwen3-embedding, so we approximate tokens with the
// standard ~4-chars-per-token heuristic via `lengthFunction` (OQ#4): `chunk_size:
// 500` then means ≈500 tokens. Discord messages are short, so most groups collapse
// to exactly one chunk.
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface ChunkOptions {
  /** Approx tokens per chunk (`knowledge.chunk_size`). */
  chunkSize: number;
  /** Approx tokens of overlap between adjacent chunks (`knowledge.chunk_overlap`). */
  chunkOverlap: number;
}

/** ~4 characters per token — the standard heuristic used as the splitter's length. */
function approxTokenLength(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Defensive ceiling on `chunk_size` (approx tokens) — a fat-fingered config value
 *  should not build one enormous chunk per group; mirrors `groupByChannel`'s cap
 *  on `grouping_window`. */
export const MAX_CHUNK_SIZE = 8000;

/**
 * Join a group's message `content`s with `'\n'` and split into chunks.
 *
 * Returns `[]` for empty/whitespace-only input (nothing to embed) and ≥1 chunk for
 * any non-empty input. Length is measured in approximate tokens so `chunkSize`
 * compares against a token-ish budget rather than raw characters.
 */
export async function chunkContents(
  contents: string[],
  options: ChunkOptions,
): Promise<string[]> {
  const text = contents.join('\n');
  if (text.trim() === '') return [];

  // The splitter throws synchronously if chunkOverlap >= chunkSize (or chunkSize
  // <= 0), which would fail every group forever for a single bad config value.
  // Clamp the same way `groupByChannel` clamps `grouping_window` — a positive
  // chunkSize, with overlap capped strictly below it.
  const chunkSize = Math.min(MAX_CHUNK_SIZE, Math.max(1, Math.floor(options.chunkSize)));
  const chunkOverlap = Math.min(Math.max(0, Math.floor(options.chunkOverlap)), chunkSize - 1);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    lengthFunction: approxTokenLength,
  });

  return splitter.splitText(text);
}
