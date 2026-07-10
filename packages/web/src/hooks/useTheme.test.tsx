import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTheme } from './useTheme';

// jsdom 29 under Node 24 does not expose Web Storage (Node claims the global
// `localStorage` and leaves it undefined without --localstorage-file), so the
// persistence path in useTheme silently no-ops here. Stub an in-memory Storage
// so the AC6 persistence behavior is actually exercised. The real browser has a
// working localStorage — Task 10's browser check confirms persistence end-to-end.
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-kh');
  vi.stubGlobal('localStorage', createMemoryStorage());
});

afterEach(() => {
  document.documentElement.removeAttribute('data-kh');
  vi.unstubAllGlobals();
});

describe('useTheme', () => {
  it('should default to dark when data-kh is absent', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
  });

  it('should read the initial theme from data-kh set by the inline script', () => {
    document.documentElement.setAttribute('data-kh', 'light');

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('light');
  });

  it('should flip data-kh and persist to localStorage when toggled', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.toggleTheme();
    });

    expect(document.documentElement.getAttribute('data-kh')).toBe('light');
    expect(localStorage.getItem('share2brain-theme')).toBe('light');
    expect(result.current.theme).toBe('light');

    act(() => {
      result.current.toggleTheme();
    });

    expect(document.documentElement.getAttribute('data-kh')).toBe('dark');
    expect(localStorage.getItem('share2brain-theme')).toBe('dark');
    expect(result.current.theme).toBe('dark');
  });
});
