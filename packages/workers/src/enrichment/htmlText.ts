// Zero-dep HTML→text hints for AI enrichment (AC-4). Regex-tier is sufficient
// for title/description generation — no cheerio/jsdom/html-to-text, per the
// ratified "no extractors in v1" decision.
//
// `text/html` content yields the high-signal `<title>`/meta/OG hints plus a
// stripped, truncated body text. Non-HTML `text/*` content passes through as
// truncated raw text with empty hints. Any other content type (PDF, image,
// binary) is unusable — `extractPageHints` returns `null` and the caller falls
// back to message-text-only enrichment.
export const MAX_BODY_TEXT_LENGTH = 8_000;

export interface PageHints {
  title: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  bodyText: string;
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&#39;|&nbsp;|&#(\d+);/g, (match, code) => {
    if (code) return String.fromCharCode(Number(code));
    return ENTITY_MAP[match] ?? match;
  });
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string): string {
  return text.length > MAX_BODY_TEXT_LENGTH ? text.slice(0, MAX_BODY_TEXT_LENGTH) : text;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(collapseWhitespace(match[1])) : '';
}

/** Extract a `<meta>` tag's `content` attribute by `name` or `property`
 *  (Open Graph tags use `property`), independent of attribute order. */
function extractMeta(html: string, key: string, attribute: 'name' | 'property'): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRegex = new RegExp(`<meta[^>]*${attribute}=["']${escapedKey}["'][^>]*>`, 'i');
  const tagMatch = html.match(tagRegex);
  if (!tagMatch) return '';
  const contentMatch = tagMatch[0].match(/content=["']([^"']*)["']/i);
  return contentMatch ? decodeEntities(contentMatch[1].trim()) : '';
}

function extractHtmlHints(html: string): PageHints {
  const bodyText = truncate(
    collapseWhitespace(
      decodeEntities(
        html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' '),
      ),
    ),
  );

  return {
    title: extractTitle(html),
    metaDescription: extractMeta(html, 'description', 'name'),
    ogTitle: extractMeta(html, 'og:title', 'property'),
    ogDescription: extractMeta(html, 'og:description', 'property'),
    bodyText,
  };
}

/**
 * Extract enrichment hints from a fetched page body given its content type.
 * Returns `null` when the content is not text-based (PDF, image, binary) —
 * the caller must fall back to message-text-only enrichment.
 */
export function extractPageHints(body: string, contentType: string): PageHints | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();

  if (mime === 'text/html') return extractHtmlHints(body);

  if (mime.startsWith('text/')) {
    return {
      title: '',
      metaDescription: '',
      ogTitle: '',
      ogDescription: '',
      bodyText: truncate(collapseWhitespace(body)),
    };
  }

  return null;
}
