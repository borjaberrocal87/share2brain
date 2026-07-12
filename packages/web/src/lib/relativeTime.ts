// Relative-time formatter for the chat history overlay (Story 5.3). Renders an
// ISO 8601 timestamp as locale-aware relative time ("hace 5 días"/"5 days ago",
// "ayer"/"yesterday") using Intl.RelativeTimeFormat — no dependency, locale-
// correct. `now` is injectable so callers/tests stay deterministic.

// Largest-first cutoffs: each `amount` is how many of the CURRENT unit fit in the
// NEXT one. We walk down until the remaining duration is smaller than the cutoff.
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

// Story 10.2 (D6): the formatter is now parameterized by locale, so a cache
// avoids re-constructing an Intl.RelativeTimeFormat on every call per locale.
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

function rtfFor(locale: string): Intl.RelativeTimeFormat {
  let rtf = rtfCache.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    rtfCache.set(locale, rtf);
  }
  return rtf;
}

/** ISO 8601 → locale-aware relative time relative to `now` (default: current
 * clock). Negative for the past ("hace .../... ago") — the only case the
 * history list produces. Returns `''` for an unparseable `iso` instead of
 * throwing. */
export function relativeTime(iso: string, locale: string, now: Date = new Date()): string {
  const target = new Date(iso).getTime();
  // Intl.RelativeTimeFormat.format requires a finite number — a malformed/
  // unparseable `iso` would otherwise throw a RangeError and crash the caller.
  if (Number.isNaN(target)) return '';
  const rtf = rtfFor(locale);
  // Seconds since `iso` relative to `now`; negative because history is in the past.
  let duration = (target - now.getTime()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  // Unreachable: the final division's amount is Infinity, so the loop always
  // returns. Kept for a total return type.
  return rtf.format(Math.round(duration), 'year');
}
