# Deferred Work

## Deferred from: code review of 1-1-inicializar-el-repositorio-y-la-estructura-del-monorepo (2026-07-03)

- Dev scripts (`node --watch src/main.ts`) won't run .ts files without a TS loader — placeholder scaffold, real tooling (tsx/Vite) lands in later stories
- `noEmit: true` conflicts with `outDir: "dist"` — intentional at scaffold stage; real build artifacts come with domain code
- `SIBLING_SERVICES` array duplicated across ESLint config objects — code style, not a bug
- `"build": "tsc --noEmit"` is misleading — intentional at scaffold; documented in story completion notes
- No `vitest.config.ts` in any package — Vitest defaults work for scaffold; workspace config needed before cross-package tests
- `@hivly/shared` exports raw `.ts` source — intentional decision documented in completion notes (avoids `composite: true` conflict)
- `exports` field blocks future subpath entrypoints — add wildcard when sub-exporters land
- New `@hivly/*` package would not be auto-covered by ESLint cross-service ban — manual registration needed
- No `uncaughtException`/`SIGTERM`/`SIGINT` handlers in any service — scaffold stage, error handling framework lands later
- `--if-present` on root typecheck/build scripts could silently skip packages missing those scripts — all 5 packages currently have them
- `.env.example.*` variants not tracked by `.gitignore` negation — edge case, team can add rules if needed
- No root `tsconfig.json` (only `tsconfig.base.json`) — by design; each package extends base directly
- Multiple scaffold-appropriate omissions: no `.d.ts` generation, no type-aware ESLint rules, no structured logging format, no vitest workspace config
