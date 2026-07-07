---
description: Frontend development standards, best practices, and conventions for the Hivly Web App — a static Vite + React SPA with Zod-inferred API types, an SSE chat client, and Playwright E2E.
globs: ["packages/web/src/**/*.{ts,tsx}", "packages/web/vite.config.ts", "packages/web/tsconfig.json", "packages/web/package.json", "packages/web/tests/**/*.{ts,tsx}"]
alwaysApply: true
---

# Frontend Project Configuration and Best Practices

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [The Shared Contract (Zod)](#the-shared-contract-zod)
- [Coding Standards](#coding-standards)
- [Views & Components](#views--components)
- [State Management & Data Fetching](#state-management--data-fetching)
- [The Chat SSE Client](#the-chat-sse-client)
- [UI/UX Standards](#uiux-standards)
- [Testing Standards](#testing-standards)
- [Configuration Standards](#configuration-standards)
- [Performance Best Practices](#performance-best-practices)
- [Development Workflow](#development-workflow)

---

## Overview

The Hivly Web App (`@hivly/web`) is a **static SPA** for semantic search, document listing, chat with the RAG agent, and read-status management. It has **no Node server**: Vite builds `dist/`, which nginx serves directly; nginx reverse-proxies `/api/*` to the Backend (AD-3, AD-7). All logic runs in the browser.

Architecture invariants are in `docs/context/ARCHITECTURE-SPINE.md`; the Web App design is in `docs/context/TECHNICAL-DESIGN.md` §5.5 and mockups in `docs/context/design/`.

## Technology Stack

### Core

- **React 19.2** — functional components + hooks.
- **TypeScript 6.0** (strict).
- **Vite 8.1** — build tool and dev server (`:5173`), static output to `dist/`.
- **zod 4.4** — API types are inferred from the shared schemas (`@hivly/shared`), not hand-written.

### Deferred choices (builder's discretion — keep the contract)

These are intentionally not fixed by the architecture spine; pick per the Web App builder, but respect AD-6 (types inferred from Zod):

- **CSS / UI components**: Tailwind + shadcn/ui vs CSS Modules.
- **Server state / data fetching**: TanStack Query vs SWR.

Do not add a routing/SSR server — the app is a static SPA behind nginx.

### Testing

- **Vitest** + React Testing Library for unit/component tests.
- **Playwright** for end-to-end user workflows.

## Project Structure

```
packages/web/
├── src/
│   ├── main.tsx            # entry point
│   ├── views/              # Search, Documents, Chat, ReadStatus
│   ├── components/         # reusable UI components
│   └── api/                # typed fetch wrappers (z.infer<> from @hivly/shared)
├── tests/                  # Playwright E2E (and component tests)
├── index.html
├── vite.config.ts          # dev proxy for /api/* → backend :3000
├── tsconfig.json
└── Dockerfile              # multi-stage build → dist/ (served by nginx)
```

## The Shared Contract (Zod)

The contract between frontend and backend is `packages/shared/src/schemas/`. The frontend **infers** types with `z.infer<>` and validates responses with `.parse()`. If the Backend changes an endpoint shape and updates the schema, the TypeScript compiler breaks the frontend before it ships (AD-6).

```typescript
// packages/web/src/api/search.ts
import type { z } from 'zod'
import { SearchResponseSchema } from '@hivly/shared/schemas'

type SearchResponse = z.infer<typeof SearchResponseSchema>

export async function search(query: string, channelIds?: string[]): Promise<SearchResponse> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
  return SearchResponseSchema.parse(await res.json())
}
```

- **Never** hand-declare request/response types locally — import/infer from `@hivly/shared`.
- The Web App imports from `@hivly/shared` **only** (types + schemas); never from other services (AD-2).

## Coding Standards

### Naming Conventions

- **Components**: `PascalCase` files and names (`ChatView.tsx`, `CitationBadge.tsx`).
- **Utilities / API modules**: `camelCase.ts` (`search.ts`, `sseClient.ts`).
- **Variables/functions**: `camelCase` (`unreadCount`, `handleSubmit`).
- **Constants**: `UPPER_SNAKE_CASE`.
- **Types/interfaces**: `PascalCase` — but prefer inferred types over new interfaces for API shapes.
- **Hooks**: `use` prefix (`useConversation`, `useUnreadCount`).
- **CSS classes** (if using plain CSS/Modules): `kebab-case`.

All code, comments, and user-facing strings in **English** (see `base-standards.md` for language precedence). No hardcoded strings that should be centralized — follow the chosen i18n/copy convention.

```tsx
type CitationBadgeProps = {
  channel: string
  author: string
  date: string
}

const CitationBadge: React.FC<CitationBadgeProps> = ({ channel, author, date }) => {
  return <span className="citation-badge">{channel} · {author} · {date}</span>
}
```

### TypeScript Usage

- Strict mode on; avoid `any`.
- Define prop types per component; destructure props; provide sensible defaults.
- Prefer inferred API types over duplicated interfaces.

## Views & Components

Four primary views (TECHNICAL-DESIGN §5.5):

| View | Description |
|---|---|
| **Search** | Semantic search with channel and read-status filters |
| **Documents** | Paginated list of indexed fragments |
| **Chat** | Streaming conversation with the RAG agent (SSE) |
| **ReadStatus** | Read management: badges, mark-all, sidebar counts |

- Use functional components with hooks; keep components small and focused.
- Handle loading and error states for every async operation; show user-friendly messages.

## State Management & Data Fetching

- Local UI state with `useState`/`useReducer`; extract reusable stateful logic into custom hooks.
- Server state via the chosen library (TanStack Query or SWR) wrapping the typed `src/api/` functions — do not call `fetch` directly from components.
- Always model `loading` / `error` / `success`; disable submit controls while in flight.

```tsx
const { data, isLoading, error } = useQuery({
  queryKey: ['search', query],
  queryFn: () => search(query, channelIds),
})
```

## The Chat SSE Client

`POST /api/chat` streams Server-Sent Events. Use `fetch` streaming (NOT `EventSource`) so the request can carry a JSON body; the session cookie authenticates it (AD-4). Frame types are the `SSEFrame` union from `@hivly/shared/schemas/sse.ts`.

```typescript
// packages/web/src/api/sseClient.ts
import type { SSEFrame } from '@hivly/shared/schemas'

export async function* streamChat(message: string, conversationId?: string) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId }),
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  for await (const line of readLines(reader, decoder)) {
    if (line.startsWith('data: ')) {
      yield JSON.parse(line.slice(6)) as SSEFrame
    }
  }
}
```

Render `token` frames incrementally, `citation` frames as sources, close on `done`, and surface `error` frames to the user.

## UI/UX Standards

- **Responsive** layouts; relative units; images `max-width: 100%`.
- **Forms**: controlled inputs; real-time validation where useful; disable submit during submission; clear state after success.
- **Navigation**: client-side routing; `try_files … /index.html` on nginx means all non-`/api` routes resolve to the SPA.
- **Accessibility**: semantic HTML, `aria-label` on interactive elements, keyboard navigation, alt text for images.

## Testing Standards

- **Component/unit** (Vitest + RTL): test behavior, not implementation; test success and error states.
- **E2E** (Playwright): test complete user workflows — search → results, chat streaming renders tokens/citations, read-status mark-all updates counts. Prefer `data-testid` for stable selection; test both success and error/validation paths. The SPA gates on a Discord OAuth session, so the harness boots `createApp` with an **injected fake `DiscordOAuthClient`** (`opts.oauth`, same as `*.integration.test.ts`) over a seeded test DB and acquires the session cookie via the fake-OAuth callback — **no real Discord credentials, no production auth-bypass route**.
- **Visual/CSS ACs** (fonts, box-shadow, token colors, grid templates) are verified with `getComputedStyle` in the Playwright run — jsdom cannot. Use the real token names (`--text-primary/-muted/-subtle`). The harness (`playwright.config.ts` + `tests/`) lands with Story 4.5; see `bmad-story-mandatory-steps.md` §3.4 for the mandatory flow and the explicit fallback when browser automation is unavailable.
- Part of the verification gate: type-check + tests + build green before committing (see `bmad-story-mandatory-steps.md`).

```typescript
import { test, expect } from '@playwright/test'

test('chat streams a response with citations', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('chat-input').fill('How do I deploy?')
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('chat-response')).not.toBeEmpty()
  await expect(page.getByTestId('citation-badge').first()).toBeVisible()
})
```

## Configuration Standards

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "moduleResolution": "bundler",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
```

### Vite Dev Proxy

In dev the SPA (`:5173`) and Backend (`:3000`) are different origins; proxy `/api/*` so the browser sees a single origin:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
})
```

### Environment

- No secrets in the frontend bundle. Runtime config the SPA needs comes from the API, not from build-time env with sensitive values.
- Production origin is served by nginx; there is no separate frontend server.

## Performance Best Practices

- **Code-split** at route/view level; lazy-load heavy views.
- **Memoize** expensive computations (`useMemo`) and stable callbacks (`useCallback`) to avoid needless re-renders.
- **Stream** the chat incrementally rather than waiting for the full response.
- **Cache** server state via the data-fetching library; show loading states for perceived performance.
- Keep the bundle lean; optimize images/static assets.

## Development Workflow

Follow the BMAD Method way of working (see `base-standards.md`):

- **Branch** per story (`feat/<epic>-<story-slug>`), verify branch first, run the gate before committing, one conventional commit per meaningful slice (`base-standards.md` §8).
- **PR at story end**; mandatory `bmad-code-review` hand-off before merge; `bmad-checkpoint-preview` surfaces the change for human review. Use the adversarial `bmad-review-*` lenses (`bmad-review-edge-case-hunter`, `bmad-editorial-review-*`) for focused UI/content review.

### Scripts

```bash
npm run dev -w @hivly/web       # Vite dev server on :5173
npm run build -w @hivly/web     # production build → dist/
npm run test -w @hivly/web      # Vitest component/unit tests
npm run test:e2e -w @hivly/web  # Playwright E2E (harness from Story 4.5; needs test Postgres+Redis + fake-OAuth session)
npm run lint                    # ESLint
```

This document is the foundation for a maintainable, accessible, and performant Hivly Web App. When a choice isn't fixed here, keep the AD-6 contract (types inferred from Zod) and stay a static SPA.
