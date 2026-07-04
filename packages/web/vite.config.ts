// Vite build for the static SPA (AD-3): emits packages/web/dist, served by nginx.
// This is the minimal placeholder build; the design system and router land in
// Story 2.1. No dev proxy is configured here — nginx fronts /api in the stack.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
