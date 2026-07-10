/// <reference types="vite/client" />

// Build-time env vars exposed to the SPA (AD-3: the static bundle can't read
// Share2Brain.config.yml). VITE_COMMUNITY_NAME supplies the header community name.
interface ImportMetaEnv {
  readonly VITE_COMMUNITY_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
