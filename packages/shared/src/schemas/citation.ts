// Citation contract (AD-6). The `{channel, author, date}` shape rendered alongside
// an assistant answer. Extracted here (Story 5.2, D11) so it exists as ONE reusable
// Zod schema instead of being duplicated: it was the `Citation` TS interface in
// db/schema.ts AND inlined in the SSE `citation` frame. The wire shape is unchanged
// — this is a DRY refactor, reused by sse.ts and conversations.ts.
import { z } from 'zod';

import type { Citation } from '../db/schema.js';
import { isHttpUrl, LINK_REFINE_MESSAGE } from './linkRefine.js';

/** A single cited source: the resource's title, which channel, which author,
 * when, and its link. `link` must be a valid HTTP(S) URL (Story 7.4 — strict,
 * no more empty-string placeholder). `title` was added in Story 7.4 (F3) so
 * the sources chip can show the resource title. */
export const CitationSchema = z.object({
  title: z.string(),
  channel: z.string(),
  author: z.string(),
  date: z.string(),
  link: z.string().refine(isHttpUrl, { message: LINK_REFINE_MESSAGE }),
});

export type CitationType = z.infer<typeof CitationSchema>;

// Compile-time guard (erased at build, no runtime cost): the Zod-inferred citation
// MUST stay structurally identical to the `Citation` interface in db/schema.ts —
// the shape actually stored in `messages.citations`. Each `satisfies` fails to
// compile if one side drifts from the other; `void` discards the expression so
// no-unused-vars is satisfied. Together they assert bidirectional equality.
void (null as unknown as CitationType satisfies Citation);
void (null as unknown as Citation satisfies CitationType);
