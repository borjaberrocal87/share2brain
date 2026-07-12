// @share2brain/web — static React SPA (AD-3: Vite build, no SSR, no Node server).
// Story 2.2 mounts the full app shell: login, sidebar, header, client-side nav,
// and the persistent theme toggle. The theme is applied to <html data-kh> by a
// blocking inline script in index.html BEFORE first paint (FOUC-free, AC6), so
// there is no data-kh assignment here anymore — useTheme reads it back.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { fetchUiLanguage } from './api/uiConfig';
import { App } from './App';
import i18n from './i18n';
import './styles/global.css';

// Story 10.2 (D1): resolve the deployment's UI language BEFORE the first
// render. With bundled resources, changeLanguage() resolves in a microtask —
// no FOUC, no loading state needed.
async function bootstrap(): Promise<void> {
  try {
    const language = await fetchUiLanguage();
    await i18n.changeLanguage(language);
  } catch (err) {
    // fetchUiLanguage never throws (D2), so this only guards an unexpected
    // changeLanguage rejection. Fall through and mount in the default language
    // rather than leaving a silent blank page.
    console.error('i18n boot failed; mounting in the default language.', err);
  }

  const container = document.getElementById('root');
  if (container) {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } else {
    const msg = document.createTextNode('Fatal: #root element not found — cannot mount React app.');
    document.body.prepend(msg);
    console.error('Fatal: #root element not found — cannot mount React app.');
  }
}

void bootstrap();
