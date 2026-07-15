# Share2Brain

Self-hosted AI agent that indexes a Discord community's knowledge and answers questions
with verifiable sources. **npm-workspaces monorepo**; hexagonal shared kernel + event-driven
ingestion over Redis Streams.

> Application code is not implemented yet; the paths and commands below reflect the design in
> `docs/context/`. Verify the actual `package.json` before relying on any specific script.

# Docs are the source of truth

`docs/` is authoritative — do not duplicate it here. Read **only** what the task needs:

| Need | Read |
|---|---|
| Way of working, standards, language rules | `docs/base-standards.md` (+ `backend-standards.md` / `frontend-standards.md`) |
| Story execution checklist + verification gate | `docs/bmad-story-mandatory-steps.md` |
| What to build / why | `docs/context/PRD.md` |
| Invariants you can't break (AD-1…AD-13) | `docs/context/ARCHITECTURE-SPINE.md` |
| Concrete design (services, data, pipeline, RAG, auth, API) | `docs/context/TECHNICAL-DESIGN.md` |
| Data model / indexes | `docs/data-model.md` |
| REST + SSE endpoints | `docs/api-spec.yml` |
| Setup / run / test | `docs/development_guide.md` |
| Past audit reports (CODE-AUDIT-*) | `docs/audits/` |

# Non-negotiables (details in ARCHITECTURE-SPINE.md)

- Code lives under `packages/<service>/src/` — never a root `src/`. Services depend on
  `@share2brain/shared` but **never on each other** (AD-2).
- Only `packages/shared` does DDL; the Drizzle schema is the source of truth (AD-5). API
  contracts are Zod schemas in `packages/shared/src/schemas/` (AD-6).
- RBAC lives **inside** the vector query, not as a post-filter (AD-12). Workers are idempotent
  (`XACK` only after success, AD-13). Sessions live in Redis — no `sessions` table (AD-10).
- Secrets only in `.env`; behavior only in `Share2Brain.config.yml`. Never mix the two.

# Way of working — BMAD Method

Installed under `_bmad/` (config: `_bmad/core/config.yaml`, `_bmad/bmm/config.yaml`). Plan with
`bmad-prd` / `bmad-architecture` / `bmad-ux` → `bmad-create-epics-and-stories`; implement one
story at a time with `bmad-dev-story`; review with `bmad-code-review` → `bmad-checkpoint-preview`.
Full detail in `docs/base-standards.md` §4 and `docs/bmad-story-mandatory-steps.md`.

# Useful commands

```bash
npm install                          # install the whole monorepo (npm workspaces)
docker compose up -d                 # start the full stack (7 services)
docker compose up -d postgres redis  # infra only, for local dev outside Docker

npm run dev -w @share2brain/backend        # API + RAG agent on :3000
npm run dev -w @share2brain/web            # Vite dev server (SPA) on :5173
npm run dev -w @share2brain/bot            # Discord Bot (ingestion)
npm run dev -w @share2brain/workers        # Indexer + Sync consumers

npm run lint                         # ESLint across all packages
npm run test                         # Vitest (unit/integration)
npm run build                        # build all packages

npx drizzle-kit generate             # generate SQL migration from schema.ts
npx drizzle-kit migrate              # apply migrations (done by the `migrator` service)
```
