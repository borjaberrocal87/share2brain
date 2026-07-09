// Shared `link` validation for SearchFragmentSchema, DocumentFragmentSchema, and
// CitationSchema (AD-6). A `link` must be a well-formed http(s) URL — strict since
// Story 7.4 (pre-7.4 placeholder `''` values are covered by the Epic 7 clean-slate
// runbook). Parse-based (not a prefix regex) so it is case-insensitive by
// construction and rejects a host-less `https://`, embedded whitespace, and
// trailing garbage. Deliberately not `z.string().url()` (deprecated) or strict
// `z.url()` (both differ subtly from this project's URL.canParse convention).
const HTTP_SCHEMES = new Set(['http:', 'https:']);

export function isHttpUrl(value: string): boolean {
  if (value === '') return false;
  if (/\s/.test(value)) return false;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return HTTP_SCHEMES.has(url.protocol) && url.hostname !== '';
}

export const LINK_REFINE_MESSAGE = 'link must be a valid HTTP(S) URL';
