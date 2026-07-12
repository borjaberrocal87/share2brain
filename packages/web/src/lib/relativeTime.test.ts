// Unit tests for relativeTime (Story 5.3 + 10.2 D6 locale parameterization).
// Pure — `now` is injected so the assertions are deterministic and independent
// of the clock.
import { describe, expect, it } from 'vitest';

import { relativeTime } from './relativeTime';

const NOW = new Date('2026-07-07T12:00:00.000Z');

describe('relativeTime', () => {
  it('should render seconds ago', () => {
    expect(relativeTime('2026-07-07T11:59:30.000Z', 'es', NOW)).toBe('hace 30 segundos');
  });

  it('should render minutes ago', () => {
    expect(relativeTime('2026-07-07T11:45:00.000Z', 'es', NOW)).toBe('hace 15 minutos');
  });

  it('should render hours ago', () => {
    expect(relativeTime('2026-07-07T10:00:00.000Z', 'es', NOW)).toBe('hace 2 horas');
  });

  it('should render "ayer" for one day ago (numeric: auto)', () => {
    expect(relativeTime('2026-07-06T12:00:00.000Z', 'es', NOW)).toBe('ayer');
  });

  it('should render days ago', () => {
    expect(relativeTime('2026-07-02T12:00:00.000Z', 'es', NOW)).toBe('hace 5 días');
  });

  it('should render months ago', () => {
    expect(relativeTime('2026-05-07T12:00:00.000Z', 'es', NOW)).toBe('hace 2 meses');
  });

  it('should render weeks ago', () => {
    expect(relativeTime('2026-06-23T12:00:00.000Z', 'es', NOW)).toBe('hace 2 semanas');
  });

  it('should render a future timestamp ("en ...") when iso is after now', () => {
    expect(relativeTime('2026-07-07T14:00:00.000Z', 'es', NOW)).toBe('dentro de 2 horas');
  });

  it('should return an empty string for an unparseable iso instead of throwing', () => {
    expect(relativeTime('not-a-date', 'es', NOW)).toBe('');
  });

  // English cases (Story 10.2, D6): same divisions, en-locale Intl output.
  it('should render seconds ago in English', () => {
    expect(relativeTime('2026-07-07T11:59:30.000Z', 'en', NOW)).toBe('30 seconds ago');
  });

  it('should render minutes ago in English', () => {
    expect(relativeTime('2026-07-07T11:45:00.000Z', 'en', NOW)).toBe('15 minutes ago');
  });

  it('should render hours ago in English', () => {
    expect(relativeTime('2026-07-07T10:00:00.000Z', 'en', NOW)).toBe('2 hours ago');
  });

  it('should render "yesterday" for one day ago in English (numeric: auto)', () => {
    expect(relativeTime('2026-07-06T12:00:00.000Z', 'en', NOW)).toBe('yesterday');
  });

  it('should render days ago in English', () => {
    expect(relativeTime('2026-07-02T12:00:00.000Z', 'en', NOW)).toBe('5 days ago');
  });

  it('should render months ago in English', () => {
    expect(relativeTime('2026-05-07T12:00:00.000Z', 'en', NOW)).toBe('2 months ago');
  });

  it('should render weeks ago in English', () => {
    expect(relativeTime('2026-06-23T12:00:00.000Z', 'en', NOW)).toBe('2 weeks ago');
  });

  it('should render a future timestamp ("in ...") when iso is after now in English', () => {
    expect(relativeTime('2026-07-07T14:00:00.000Z', 'en', NOW)).toBe('in 2 hours');
  });
});
