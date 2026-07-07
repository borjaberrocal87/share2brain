// Unit tests for relativeTimeEs (Story 5.3). Pure — `now` is injected so the
// assertions are deterministic and independent of the clock.
import { describe, expect, it } from 'vitest';

import { relativeTimeEs } from './relativeTime';

const NOW = new Date('2026-07-07T12:00:00.000Z');

describe('relativeTimeEs', () => {
  it('should render seconds ago', () => {
    expect(relativeTimeEs('2026-07-07T11:59:30.000Z', NOW)).toBe('hace 30 segundos');
  });

  it('should render minutes ago', () => {
    expect(relativeTimeEs('2026-07-07T11:45:00.000Z', NOW)).toBe('hace 15 minutos');
  });

  it('should render hours ago', () => {
    expect(relativeTimeEs('2026-07-07T10:00:00.000Z', NOW)).toBe('hace 2 horas');
  });

  it('should render "ayer" for one day ago (numeric: auto)', () => {
    expect(relativeTimeEs('2026-07-06T12:00:00.000Z', NOW)).toBe('ayer');
  });

  it('should render days ago', () => {
    expect(relativeTimeEs('2026-07-02T12:00:00.000Z', NOW)).toBe('hace 5 días');
  });

  it('should render months ago', () => {
    expect(relativeTimeEs('2026-05-07T12:00:00.000Z', NOW)).toBe('hace 2 meses');
  });

  it('should render weeks ago', () => {
    expect(relativeTimeEs('2026-06-23T12:00:00.000Z', NOW)).toBe('hace 2 semanas');
  });

  it('should render a future timestamp ("en ...") when iso is after now', () => {
    expect(relativeTimeEs('2026-07-07T14:00:00.000Z', NOW)).toBe('dentro de 2 horas');
  });

  it('should return an empty string for an unparseable iso instead of throwing', () => {
    expect(relativeTimeEs('not-a-date', NOW)).toBe('');
  });
});
