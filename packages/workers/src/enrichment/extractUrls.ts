// URL extraction from Discord message content (AC-1, FR5). Purely deterministic —
// re-processing the SAME content on redelivery must yield the SAME ordered list,
// since `chunk_key` (`${messageId}:${urlIndex}`) derives from position in this
// output (AD-13).
//
// Two Discord-specific delimiter forms are unwrapped BEFORE the bare-URL regex
// runs, so their surrounding syntax (`<>`, `[text](...)`) never leaks into the
// extracted URL:
// - suppressed-embed angle brackets: `<https://example.com>`
// - markdown links: `[text](https://example.com)`
const ANGLE_BRACKET_URL = /<(https?:\/\/[^\s<>]+)>/gi;
const MARKDOWN_LINK_URL = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

/** Candidate baseline (AC-1): parens are deliberately allowed inside the match —
 *  the trailing-punctuation pass below owns the paren-balance decision. A class
 *  that excludes `()` would truncate a URL like `…/Foo_(bar)` before that pass
 *  ever runs. */
const BARE_URL = /\bhttps?:\/\/[^\s<>]+/gi;

/** A trailing run of these characters is prose punctuation, not URL content. */
const TRAILING_PUNCTUATION = new Set([...'.,;:!?\'")]>']);

/**
 * Iteratively strip a trailing run of sentence/markdown punctuation from a
 * candidate match. A trailing `)` is kept only while the candidate still
 * contains more `(` than `)` — the Wikipedia-disambiguation case
 * (`…/Foo_(bar)`) — otherwise it is prose closing a parenthetical
 * (`(see https://x.com/b)`) and gets stripped like any other trailing mark.
 */
function stripTrailingPunctuation(candidate: string): string {
  let result = candidate;
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (!TRAILING_PUNCTUATION.has(last)) break;
    if (last === ')') {
      const opens = (result.match(/\(/g) ?? []).length;
      const closes = (result.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
    }
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Extract, validate, dedupe, and normalize the URLs in `content`.
 *
 * Returns each URL's normalized `href` (lowercased scheme/host, resolved default
 * port, percent-normalized) — this is what gets persisted as `link` and what
 * dedup keys on. Order is first-occurrence in `content`; the same URL appearing
 * more than once collapses to a single entry at its first position.
 */
export function extractUrls(content: string, allowedSchemes: ('http' | 'https')[]): string[] {
  const unwrapped = content
    .replace(ANGLE_BRACKET_URL, '$1')
    .replace(MARKDOWN_LINK_URL, '$1');

  const candidates = unwrapped.match(BARE_URL) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const stripped = stripTrailingPunctuation(candidate);
    if (!URL.canParse(stripped)) continue;

    const url = new URL(stripped);
    const scheme = url.protocol.slice(0, -1);
    if (!allowedSchemes.includes(scheme as 'http' | 'https')) continue;
    if (url.username || url.password) continue;

    if (seen.has(url.href)) continue;
    seen.add(url.href);
    result.push(url.href);
  }

  return result;
}
