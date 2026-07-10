// Persistent theme hook (Story 2.2, AC6). The blocking inline script in
// index.html already set <html data-kh> before first paint (FOUC-free), so this
// hook just reads that back as its initial state and owns the runtime toggle.
// toggleTheme flips dark<->light, writes the attribute, and persists the choice
// to localStorage('share2brain-theme'). localStorage access is wrapped in try/catch
// because private-mode Safari throws.
import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'share2brain-theme';

function readInitialTheme(): Theme {
  // The inline script has already stamped data-kh; trust it. Default to dark if
  // somehow absent (e.g. a test rendering without index.html).
  return document.documentElement.dataset.kh === 'light' ? 'light' : 'dark';
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-kh', next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private-mode Safari throws on localStorage writes — ignore. */
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
