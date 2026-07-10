---
baseline_commit: 2f2f240e782c476e33f27c60e43587b242776865
---

# Story 1.1: Inicializar el repositorio y la estructura del monorepo

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want the repository to have the npm-workspaces structure with TypeScript and ESLint configured,
so that every service shares the development environment and the ban on cross-service imports is enforced from day one.

## Acceptance Criteria

**AC1 — Workspaces resolve and typecheck clean**
- **Given** an empty repository with a root `package.json` configured with workspaces
- **When** the developer runs `npm install` at the root
- **Then** npm resolves the 5 workspaces `packages/{shared,bot,backend,workers,web}` and installs all dependencies
- **And** `tsc --noEmit` (via `npm run build` / the typecheck script) passes with **zero errors across every package**

**AC2 — Cross-service imports are blocked by ESLint, shared imports pass**
- **Given** a file in `packages/bot` that tries to import from `@share2brain/backend`
- **When** ESLint runs on that file
- **Then** the `no-restricted-imports` rule reports an error flagging the forbidden cross-service import
- **And** an import of `@share2brain/shared` in the same file produces **no error**

**AC3 — Config example files are complete**
- **Given** the files `Share2Brain.config.yml.example` and `.env.example`
- **When** the developer reviews them
- **Then** they contain every field documented in the PRD/TECHNICAL-DESIGN with clear example values
- **And** `.env.example` is tracked by git (not swallowed by the existing `.env.*` ignore rule)

## Tasks / Subtasks

- [x] **Task 1 — Root workspace scaffold** (AC: 1)
  - [x] Create root `package.json` with `"private": true`, `"workspaces": ["packages/*"]`, `"type": "module"`, and `"engines": { "node": ">=24" }`.
  - [x] Add root scripts that fan out over workspaces: `lint` (ESLint), `lint:fix`, `test` (Vitest), `build`, `typecheck` (`tsc --build` or per-workspace `tsc --noEmit`), plus the `dev -w @share2brain/<svc>` pattern documented in `development_guide.md`.
  - [x] Create the 5 package directories `packages/{shared,bot,backend,workers,web}`, each with its own `package.json` named `@share2brain/{shared,bot,backend,workers,web}` and `"type": "module"`.
  - [x] `bot`, `backend`, `workers`, `web` declare `"@share2brain/shared": "*"` as a dependency (workspace protocol). `shared` depends on no other `@share2brain/*` package (AD-2: it is the leaf everyone else points at).
- [x] **Task 2 — TypeScript strict config across the monorepo** (AC: 1)
  - [x] Create a root `tsconfig.base.json` with `"strict": true`, TS 6.0-appropriate `target`/`module` (`ES2023`+, `NodeNext`/`Bundler` resolution), `"noEmit"` semantics for typecheck, and shared compiler options.
  - [x] Each package extends the base with its own `tsconfig.json`. `web` additionally enables `"jsx": "react-jsx"` and DOM libs; the Node services (`shared`, `bot`, `backend`, `workers`) use Node libs only.
  - [x] Wire TypeScript **project references** (or a `tsconfig.json` `references` array) so `tsc --build` resolves `@share2brain/shared` across packages without a prior `npm run build`.
  - [x] Add a minimal placeholder source file to every package (e.g. `packages/shared/src/index.ts` exporting a constant, `packages/*/src/main.ts` / `main.tsx` stubs) so `tsc --noEmit` has inputs and passes clean. **`tsc` errors with "No inputs were found" if a package has an empty `src/` — do not leave any package without at least one `.ts`/`.tsx` file.**
- [x] **Task 3 — ESLint flat config with cross-service import ban** (AC: 2)
  - [x] Create a root `eslint.config.js` (ESLint 9 **flat config**) using `typescript-eslint`.
  - [x] Add a `no-restricted-imports` rule, **scoped per service package via `files` globs**, that bans importing any sibling service (`@share2brain/bot`, `@share2brain/backend`, `@share2brain/workers`, `@share2brain/web`) while leaving `@share2brain/shared` allowed. Use a clear message citing AD-2.
  - [x] Verify the rule with a quick manual check: a temporary `import ... from '@share2brain/backend'` inside `packages/bot/src` must error; `import ... from '@share2brain/shared'` must not. Remove the temporary import after verifying.
  - [x] Do **not** add the LangChain `no-restricted-imports` ban here — that rule is scoped to `packages/backend` and belongs to a later backend story (AD-11). This story only enforces the cross-service ban (AD-2).
- [x] **Task 4 — Config & secrets example files** (AC: 3)
  - [x] Verify `Share2Brain.config.yml.example` (already present at repo root) covers every documented behavior field — it currently does; adjust only if a PRD field is missing.
  - [x] Create `.env.example` at repo root listing every secret referenced as `${VAR}` across the docs (see Dev Notes for the full list), each with a clear placeholder value and a one-line comment.
  - [x] **Fix the `.gitignore` gotcha:** the current `.gitignore` has `.env.*`, which would ignore `.env.example`. Add a negation `!.env.example` (after the `.env.*` line) so the example is tracked. Confirm with `git status` / `git check-ignore .env.example`.
- [x] **Task 5 — Verification gate** (AC: 1, 2, 3)
  - [x] Run and paste output for: `npm install`, `npm run lint`, `npm run test`, `npm run build` (all green). Test may be a no-op/placeholder at this stage but the script must exist and exit 0.
  - [x] Confirm `git check-ignore -v .env.example` returns nothing (file is tracked) and `git status` shows `.env.example` as a new tracked file.

## Dev Notes

### What this story is (and is NOT)
This is the **foundation** story — pure scaffolding. There is **no application logic** yet: no Drizzle schema, no Zod API schemas, no `loadConfig()`, no Docker Compose. Those come in **Story 1.2** (`packages/shared` kernel) and **Story 1.3** (Docker Compose + `/health`). Keep placeholder source files trivial; do not pre-build domain code. [Source: epics.md#Historia 1.2 / 1.3]

### Current repo state (verified)
- Git repo initialized; single commit `Initial commit`. Current branch is `main` — **branch first** before committing (`feat/1-inicializar-monorepo` or similar); never commit on `main`. [Source: base-standards.md#Development Workflow]
- `packages/` does **not** exist yet; there is **no root `package.json`**. You are creating both.
- `Share2Brain.config.yml.example` **already exists** at the repo root and is complete — verify, don't recreate. `.env.example` does **not** exist — create it.
- `.gitignore` currently contains: `node_modules/`, `dist/`, `.env`, `.env.*`, `*.log`, `.DS_Store`, `*.tsbuildinfo`. The `.env.*` line is the gotcha for AC3 (see Task 4).

### Non-negotiable architecture rules touched by this story
- **AD-2 — Monorepo npm workspaces, shared kernel:** structure is exactly `packages/{bot,backend,workers,web,shared}`. Services import `@share2brain/shared`; **never** each other. This story's ESLint rule is the machine-enforcement of AD-2. [Source: ARCHITECTURE-SPINE.md#AD-2]
- **AD-1 — Three independent processes:** `bot`, `backend`, `workers` each get their own `package.json` (and later Dockerfile + Compose entry). Reflect this by giving each a standalone `package.json`. [Source: ARCHITECTURE-SPINE.md#AD-1]
- Code lives under `packages/<service>/src/` — **never a root `src/`**. [Source: project-context.md; ARCHITECTURE-SPINE.md#AD-2]
- **English only** in all code, comments, config, commits. [Source: project-context.md#Code quality & naming]

### Monorepo layout to create
```
share2brain/
├── package.json              # NEW — root, private, workspaces: ["packages/*"]
├── tsconfig.base.json        # NEW — strict TS 6.0 base config
├── tsconfig.json             # NEW (optional) — solution file with project references
├── eslint.config.js          # NEW — ESLint 9 flat config + typescript-eslint
├── .env.example              # NEW — all ${VAR} secrets with placeholders
├── Share2Brain.config.yml.example  # EXISTS — verify only
├── .gitignore                # UPDATE — add !.env.example
└── packages/
    ├── shared/   (@share2brain/shared)   src/index.ts     tsconfig.json  package.json
    ├── bot/      (@share2brain/bot)      src/main.ts       tsconfig.json  package.json
    ├── backend/  (@share2brain/backend)  src/main.ts       tsconfig.json  package.json
    ├── workers/  (@share2brain/workers)  src/main.ts       tsconfig.json  package.json
    └── web/      (@share2brain/web)      src/main.tsx      tsconfig.json  package.json
```
[Source: TECHNICAL-DESIGN.md#4. Estructura del monorepo; ARCHITECTURE-SPINE.md#Árbol de fuentes; backend-standards.md#Monorepo Structure]

### ESLint cross-service ban — reference shape
Flat config, scoped per service so `@share2brain/shared` stays allowed everywhere. Example pattern:
```js
// eslint.config.js (ESLint 9 flat config)
import tseslint from 'typescript-eslint';

const banSiblingServices = (self) => ({
  files: [`packages/${self}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['@share2brain/bot', '@share2brain/backend', '@share2brain/workers', '@share2brain/web'],
        message: 'Services must not import each other (AD-2). Only @share2brain/shared is shared.',
      }],
    }],
  },
});

export default tseslint.config(
  ...tseslint.configs.recommended,
  banSiblingServices('bot'),
  banSiblingServices('backend'),
  banSiblingServices('workers'),
  banSiblingServices('web'),
  // shared imports nothing @share2brain/* — no ban needed there
);
```
(A package listing itself in its own `group` is harmless — a package importing itself by name is a non-case.) [Source: ARCHITECTURE-SPINE.md#AD-2; project-context.md#Architecture boundaries]

### `.env.example` — full field list (from docs)
Create with clear placeholder values + a short comment each. These are the `${VAR}` references found across `Share2Brain.config.yml.example` and the design docs:
- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID` — Discord app/bot credentials.
- `ANTHROPIC_API_KEY` — LLM provider (agent default is `anthropic` / `claude-sonnet-4-6`).
- `OPENAI_API_KEY` — embeddings (`text-embedding-3-small`).
- `DATABASE_URL`, `POSTGRES_PASSWORD` — PostgreSQL + pgvector.
- `REDIS_URL` — Redis (sessions + streams).
- `SESSION_SECRET` — express-session signing secret.
- `FRONTEND_URL` — allowed CORS origin / SPA origin.
- `SENTRY_DSN` — observability (optional).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SLACK_BOT_TOKEN` — external notifications (used in Epic 6; include as commented/optional).

Never put behavior config in `.env`, and never put secrets in `Share2Brain.config.yml` — the YAML references secrets as `${VAR}` only. [Source: TECHNICAL-DESIGN.md#13. Configuración; Share2Brain.config.yml.example; project-context.md]

### Stack / versions (pin per these)
Node.js **24 LTS** · npm **10+** (workspaces) · TypeScript **6.0** (strict) · ESLint **9** (flat config) + `typescript-eslint` · Vitest for tests · React **19.2** + Vite **8.1** for `web` (dev tooling can be added minimally now; full Vite app is Epic 2, Story 2.1). Do not use `:latest` anywhere. [Source: ARCHITECTURE-SPINE.md#Stack; project-context.md#Technology Stack]

### Testing standards
- Vitest, tests co-located as `*.test.ts` (or `__tests__/`), AAA pattern, behavior-driven names. At this scaffolding stage a placeholder/no-op test suite that exits 0 is acceptable — the goal is that `npm run test` exists and passes across workspaces. Real tests-first discipline kicks in once domain code lands in Story 1.2. [Source: project-context.md#Testing rules; backend-standards.md#Testing Standards]

### Project Structure Notes
- Aligns exactly with the source tree in `ARCHITECTURE-SPINE.md#Árbol de fuentes` and `TECHNICAL-DESIGN.md#4`. No variances.
- The only pre-existing artifact that interacts with this story is `.gitignore` (needs the `!.env.example` negation) and `Share2Brain.config.yml.example` (verify-only).
- Do not create a root `src/` (anti-pattern). Do not add Dockerfiles or `docker-compose.yml` (Story 1.3).

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 1.1: Inicializar el repositorio y la estructura del monorepo]
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-1, #AD-2, #Stack, #Árbol de fuentes (seed), #Consistency Conventions]
- [Source: docs/context/TECHNICAL-DESIGN.md#4. Estructura del monorepo, #13. Configuración]
- [Source: docs/backend-standards.md#Monorepo Structure, #TypeScript Usage, #Development Scripts]
- [Source: docs/development_guide.md#Prerequisites (Node 24 LTS, npm 10+)]
- [Source: _bmad-output/project-context.md — Architecture boundaries, Code quality & naming, Development workflow]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Amelia / bmad-dev-story)

### Debug Log References

Verification gate (2026-07-03), all green on branch `feat/1-inicializar-monorepo`:
- `npm install` → added 162 packages, 0 vulnerabilities; 5 workspace symlinks created under `node_modules/@share2brain/{shared,bot,backend,workers,web}`.
- `npm run build` (fans out to `tsc --noEmit` per workspace) → zero type errors across all 5 packages; cross-package `@share2brain/shared` resolves with no prior build (types sourced from `packages/shared/src/index.ts` via the package `exports`/`types` fields + workspace symlink).
- `npm run lint` (`eslint .`) → 0 problems.
- `npm run test` (`vitest run`) → 1 file, 2 tests passed.
- AC2 manual check: a temporary `packages/bot/src/__ad2_check__.ts` importing `@share2brain/backend` produced exactly 1 `no-restricted-imports` error citing AD-2, while its `@share2brain/shared` import produced none; temp file removed.
- AC3: `git check-ignore .env.example` → exit 1 (not ignored); `git status` lists `.env.example` as an untracked (tracked-able) file.

### Completion Notes List

- Story created via bmad-create-story context engine. First story of Epic 1 — no previous story to inherit learnings from; git history is a single initial commit.
- **Implemented**: root npm-workspaces scaffold (`package.json`, `tsconfig.base.json`, `eslint.config.js`, `.env.example`, `.gitignore` negation) + 5 packages `@share2brain/{shared,bot,backend,workers,web}`, each with `package.json`, `tsconfig.json`, and a placeholder source file.
- **Decision — TS cross-package resolution without `tsc --build`**: chose per-workspace `tsc --noEmit` with `@share2brain/shared` exposing its types directly from source (`"exports"`/`"types"` → `./src/index.ts`) instead of TypeScript project references. Rationale: project references require `composite: true`, which mandates declaration emit and conflicts with the `noEmit: true` that AC1 asks for. The source-exports pattern resolves `@share2brain/shared` across packages with zero prior build and keeps the typecheck truly emit-free. `build` == `typecheck` (both `tsc --noEmit`) at this scaffold stage; real build artifacts arrive with domain code.
- **Version note**: latest ESLint on the registry is 10.x, but `typescript-eslint@8` targets ESLint 9 and the design specifies ESLint 9 flat config, so ESLint is pinned `^9`. TypeScript `^6.0.3`, Vitest `^4.1.9`, React/`@types/react` `^19.2`, Vite `^8.1` — all match the design stack and installed clean (`typescript-eslint@8` peer allows TS `<6.1.0`).
- **Scope guard**: no LangChain import ban (backend-scoped, later story AD-11), no Drizzle schema / Zod schemas / `loadConfig()` / Docker Compose (Stories 1.2, 1.3). Placeholder sources kept trivial.
- `Share2Brain.config.yml.example` verified complete against the PRD/TECHNICAL-DESIGN behavior fields — left unchanged.

### File List

**New — root:**
- `package.json`
- `tsconfig.base.json`
- `eslint.config.js`
- `.env.example`
- `package-lock.json` (generated by `npm install`)

**New — packages:**
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/index.test.ts`
- `packages/bot/package.json`
- `packages/bot/tsconfig.json`
- `packages/bot/src/main.ts`
- `packages/backend/package.json`
- `packages/backend/tsconfig.json`
- `packages/backend/src/main.ts`
- `packages/workers/package.json`
- `packages/workers/tsconfig.json`
- `packages/workers/src/main.ts`
- `packages/web/package.json`
- `packages/web/tsconfig.json`
- `packages/web/src/main.tsx`

**Modified:**
- `.gitignore` (added `!.env.example` negation)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (story 1-1 → in-progress → review)

## Review Findings

### Decision Needed

- [x] [Review][Decision→Defer] `--passWithNoTests` flag in root test script — deferred; keep for scaffold, remove when real tests land across all packages.

### Patch

- [x] [Review][Patch→Dismiss] ~~Use `workspace:*` protocol~~ — npm workspaces use bare `*`; `workspace:*` is pnpm/yarn only. Current `"*"` is correct for npm.
- [x] [Review][Patch] `web/src/main.tsx` silently renders nothing when `#root` is missing — added `console.error` in else branch [packages/web/src/main.tsx:9]
- [x] [Review][Patch] ESLint `no-restricted-imports` patterns miss subpath imports — added `/**` suffix via `.map()` [eslint.config.js:17]
- [x] [Review][Patch] `.gitignore` `dist/` only ignores root-level — changed to `**/dist/` [.gitignore:2]
- [x] [Review][Patch] Missing `.npmrc` with `engine-strict=true` — created [root/.npmrc]
- [x] [Review][Patch] `package-lock.json` is untracked — will be committed alongside all other new files in this story [package-lock.json]
- [x] [Review][Patch] Semver test regex too restrictive — extended to allow pre-release and build metadata tags, including hyphens in identifiers [packages/shared/src/index.test.ts:10]

### Deferred

- [x] [Review][Defer] Dev scripts (`node --watch src/main.ts`) won't run .ts files without a TS loader — placeholder scaffold, real tooling (tsx/Vite) lands in later stories [packages/bot/package.json:7, packages/backend/package.json:7, packages/workers/package.json:7]
- [x] [Review][Defer] `noEmit: true` conflicts with `outDir: "dist"` — intentional at scaffold stage; real build artifacts come with domain code [tsconfig.base.json:19, packages/*/tsconfig.json:5]
- [x] [Review][Defer] `SIBLING_SERVICES` array duplicated across ESLint config objects — code style, not a bug [eslint.config.js:3,23-26]
- [x] [Review][Defer] `"build": "tsc --noEmit"` is misleading — intentional at scaffold; documented in story completion notes [packages/*/package.json]
- [x] [Review][Defer] No `vitest.config.ts` in any package — Vitest defaults work for scaffold; workspace config needed before cross-package tests [packages/*]
- [x] [Review][Defer] `@share2brain/shared` exports raw `.ts` source — intentional decision documented in completion notes (avoids `composite: true` conflict) [packages/shared/package.json:7-9]
- [x] [Review][Defer] `exports` field blocks future subpath entrypoints — add wildcard when sub-exporters land [packages/shared/package.json:4-8]
- [x] [Review][Defer] New `@share2brain/*` package would not be auto-covered by ESLint cross-service ban — manual registration needed [eslint.config.js:23-26]
- [x] [Review][Defer] No `uncaughtException`/`SIGTERM`/`SIGINT` handlers in any service — scaffold stage, error handling framework lands later [packages/*/src/main.ts]
- [x] [Review][Defer] `--if-present` on root typecheck/build scripts could silently skip packages missing those scripts — all 5 packages currently have them [package.json:15-16]
- [x] [Review][Defer] `.env.example.*` variants not tracked by `.gitignore` negation — edge case, team can add rules if needed [.gitignore:4-5]
- [x] [Review][Defer] No root `tsconfig.json` (only `tsconfig.base.json`) — by design; each package extends base directly [root]
- [x] [Review][Defer] Multiple scaffold-appropriate omissions: no `.d.ts` generation, no type-aware ESLint rules, no structured logging format, no vitest workspace config [various]

## Change Log

| Date | Change |
|---|---|
| 2026-07-03 | Implemented Story 1.1 — npm-workspaces monorepo scaffold: root config, 5 `@share2brain/*` packages, strict TypeScript base, ESLint 9 flat config enforcing the AD-2 cross-service import ban, and `.env.example`. Verification gate green (lint + test + build). Status → review. |
| 2026-07-03 | Code review (bmad-code-review) — 3-layer adversarial review. 1 decision-needed, 7 patch, 13 deferred, 10 dismissed. |
