// @share2brain/web — static React SPA (AD-3: Vite build, no SSR, no Node server).
// Story 2.2 mounts the full app shell: login, sidebar, header, client-side nav,
// and the persistent theme toggle. The theme is applied to <html data-kh> by a
// blocking inline script in index.html BEFORE first paint (FOUC-free, AC6), so
// there is no data-kh assignment here anymore — useTheme reads it back.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/global.css';

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
