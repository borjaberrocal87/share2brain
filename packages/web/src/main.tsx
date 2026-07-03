// @hivly/web — static React SPA (AD-3: Vite build, no SSR, no Node server).
// The full app (design system, router, chat UI) arrives from Epic 2 onward;
// this is a scaffold stub proving JSX + DOM libs + the @hivly/shared dependency.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PACKAGE_NAME } from '@hivly/shared';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <div>Hivly web — shared kernel: {PACKAGE_NAME}</div>
    </StrictMode>,
  );
} else {
  console.error('Fatal: #root element not found — cannot mount React app.');
}
