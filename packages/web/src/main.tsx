// @hivly/web — static React SPA (AD-3: Vite build, no SSR, no Node server).
// The full app (design system, router, chat UI) arrives from Epic 2 onward;
// this is a scaffold stub proving JSX + DOM libs + the @hivly/shared dependency.
//
// Import ONLY from browser-safe @hivly/shared subpaths (`/schemas`, `/types/events`).
// The root barrel and `/db` pull in `pg` + Node built-ins; `/config` needs Node fs.
// A lint guard (eslint.config.js) enforces this — see Epic 1 retro action item #3.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HealthResponseSchema } from '@hivly/shared/schemas';

// Proves the shared Zod contract resolves in the browser bundle without dragging
// in `pg`: the health response has exactly `status` + `components`.
const contractFields = Object.keys(HealthResponseSchema.shape).join(', ');

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <div>Hivly web — shared contract fields: {contractFields}</div>
    </StrictMode>,
  );
} else {
  console.error('Fatal: #root element not found — cannot mount React app.');
}
