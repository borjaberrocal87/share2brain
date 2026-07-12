// Backend error-code → translated message mapping (Story 10.2, D4). Only
// ChatWidget wires this today (the sole surface receiving a `code` from the
// backend); the other API clients throw generic Errors and are out of scope.
import i18n from '../i18n';

/** Resolve a backend error `code` to a translated message, falling back to
 * `fallback` (typically the caller-provided message) for an unknown code. */
export function translateErrorCode(code: string, fallback: string): string {
  const key = `errors.${code}`;
  // The 11-code vocabulary is a closed set validated at the schema layer, not
  // statically known here — one sanctioned dynamic-key cast (D8).
  return i18n.exists(key as never) ? i18n.t(key as never) : fallback;
}
