---
baseline_commit: 5788e592874eb16073e14f93101bd8af7762dbdc
---

# Story ops-3: Rename `hivly` → `share2brain`

Status: done

<!-- Post-roadmap operational chore (ops-N convention, outside the epic sequence). -->
<!-- Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-rename-share2brain.md (approved). -->

## Story

As the **maintainer of the project**,
I want the entire codebase, infrastructure, docs, and BMAD artifacts renamed from **`hivly`/`KeepHive`** to **`share2brain`/`Share2Brain`**,
so that the product ships under its final identity before the first real-prod deployment (AI-3), with zero residual references to the old name in live code and infra.

This is a **behaviour-preserving mechanical rename**. No feature, flow, data-model semantic, RBAC rule, or contract shape changes. Every `AD-*` invariant stays intact except **AD-13**, whose canonical stream-key/consumer-group *prefix* is ratified from `hivly:` to `share2brain:` (the discipline — XREADGROUP/XACK, PEL-as-DLQ, fixed key set — is unchanged).

## Acceptance Criteria

1. **Given** the monorepo, **when** the rename is complete, **then** all five packages are named `@share2brain/{shared,bot,backend,workers,web}` and the root `package.json` name is `share2brain`; **and** no `@hivly/*` import specifier resolves anywhere (`grep -rl '@hivly' packages` returns empty).
2. **Given** the shared kernel, **when** stream keys/consumer groups are read, **then** every literal in `packages/shared/src/types/events.ts` uses the `share2brain:` prefix (`share2brain:discord:messages`, `:updated`, `:deleted`, `share2brain:knowledge:events`, `share2brain:indexer`, `share2brain:sync`, `share2brain:notifier`); **and** `ARCHITECTURE-SPINE.md` AD-13 documents the new prefix.
3. **Given** the config loader, **when** it resolves the behavior config, **then** the default filename is `Share2Brain.config.yml` and the env var is `SHARE2BRAIN_CONFIG_PATH`; **and** `Hivly.config.yml.example` is renamed to `Share2Brain.config.yml.example`; **and** the remaining env family is renamed (`SHARE2BRAIN_API_PROXY_TARGET`, `SHARE2BRAIN_TEST_ALLOW_SHARED_DB`, `SHARE2BRAIN_TEST_UNSET_VAR`).
4. **Given** the web app, **when** a user views it, **then** the visible brand reads `Share2Brain` in the Sidebar, LoginScreen, ChatWidget, and `<title>`; **and** `VITE_COMMUNITY_NAME` default is `Share2Brain`; **and** the theme localStorage key is `share2brain-theme`.
5. **Given** the infra config, **when** the stack starts, **then** `docker-compose.yml` uses Postgres DB/user `share2brain` and `DATABASE_URL=postgres://share2brain:…@postgres:5432/share2brain`, mounts `Share2Brain.config.yml`, and its healthcheck uses the new DB name; **and** `nginx.conf`, `Dockerfile.migrator`, `.env.example`, `.dockerignore`, `.gitignore`, `eslint.config.js` carry no `hivly` reference.
6. **Given** the docs (source of truth), **when** read, **then** `PRD.md`, `ARCHITECTURE-SPINE.md`, `TECHNICAL-DESIGN.md`, `data-model.md`, `api-spec.yml`, all `*-standards.md`, `development_guide.md`, `bmad-story-mandatory-steps.md`, `documentation-standards.md`, `CLAUDE.md`, `README.md`, and `_bmad-output/project-context.md` reflect the name `Share2Brain`, the `@share2brain/*` scope, `Share2Brain.config.yml`, `SHARE2BRAIN_*` env, DB `share2brain`, and the `share2brain:` stream prefix.
7. **Given** the BMAD artifacts, **when** swept, **then** every `hivly`/`KeepHive` reference across `_bmad-output/**` (planning + implementation, incl. completed historical story files), `sprint-status.yaml`, `epics.md`, and `_bmad/` config is rewritten to the new name — **except** tokens that describe *this migration itself* or record provenance (see Dev Notes "Preservation rule").
8. **Given** the full verification gate, **when** run by the agent, **then** `npm run lint && npm run test && npm run build` is green and the Playwright e2e suite passes, with output pasted; **and** `npm install` has regenerated `package-lock.json` + workspace symlinks under the new scope.
9. **Given** the whole change, **when** reviewed, **then** it lands as a **single atomic branch/PR** (`chore/rename-share2brain`) with one commit per layer — a partial rename that leaves any `@hivly/*` import unresolved is not an acceptable intermediate committed state on `main`.

## Tasks / Subtasks

> **Execution order is mandatory** — inner-first per AD-1. A partial rename breaks the build; keep the branch un-pushed until the whole gate is green. One commit per task group.

- [x] **Task 0 — Branch & baseline** (AC: 9)
  - [x] `git switch -c chore/rename-share2brain` off `main` (verify `main` is current & clean first).
  - [x] Record baseline sweep counts: `grep -ric 'hivly' <tree>` and `grep -ric 'keephive' <tree>` (excluding `node_modules/.git/dist/coverage/.codegraph`) for a before/after delta in Completion Notes.

- [x] **Task 1 — Shared kernel (contracts first)** (AC: 1, 2, 3) — commit `chore(shared): rename to @share2brain, share2brain: streams, Share2Brain.config`
  - [x] `packages/shared/package.json`: `"name": "@hivly/shared"` → `"@share2brain/shared"`.
  - [x] `packages/shared/src/types/events.ts`: rewrite all 7 stream-key + consumer-group literals `hivly:*` → `share2brain:*`.
  - [x] `packages/shared/src/config/index.ts` + `embeddingDimensions.ts`: `DEFAULT_CONFIG_FILE = 'Hivly.config.yml'` → `'Share2Brain.config.yml'`; `HIVLY_CONFIG_PATH` → `SHARE2BRAIN_CONFIG_PATH`; update doc comments referencing `/app/Hivly.config.yml`.
  - [x] `packages/shared/src/notifier/index.ts`: comment referencing `hivly:knowledge:events`/`hivly:notifier`.
  - [x] Update shared tests: `config/index.test.ts`, `config/embeddingDimensions.test.ts` (`HIVLY_CONFIG_PATH`, `hivly-config-` tmp prefix, config-filename strings), any events tests asserting stream keys.

- [x] **Task 2 — Service packages** (AC: 1, 3) — commit `chore(bot,backend,workers): rename @hivly/* → @share2brain/*`
  - [x] `packages/{bot,backend,workers}/package.json`: `name` → `@share2brain/*`; dependency key `@hivly/shared` → `@share2brain/shared`.
  - [x] All `import … from '@hivly/…'` across `packages/{bot,backend,workers}/src/**` → `@share2brain/…`.
  - [x] Backend: env reads `HIVLY_API_PROXY_TARGET` → `SHARE2BRAIN_API_PROXY_TARGET`; `HIVLY_TEST_ALLOW_SHARED_DB`/`HIVLY_TEST_UNSET_VAR` → `SHARE2BRAIN_*` (in `src/**` and `test-helpers.ts`).
  - [x] `packages/{backend,bot,workers}/src/test-helpers.ts`: `postgres://hivly:changeme@…/hivly` → `postgres://share2brain:changeme@…/share2brain`.

- [x] **Task 3 — Web (scope + branding)** (AC: 1, 4) — commit `chore(web): rename scope + Share2Brain branding`
  - [x] `packages/web/package.json`: `name` → `@share2brain/web`; `@hivly/shared` dep → `@share2brain/shared`.
  - [x] All `@hivly/…` imports in `packages/web/src/**` → `@share2brain/…`.
  - [x] `packages/web/index.html`: `<title>Hivly</title>` → `Share2Brain`; `localStorage.getItem('hivly-theme')` (and any setter) → `'share2brain-theme'`.
  - [x] `packages/web/src/App.tsx`: `VITE_COMMUNITY_NAME ?? 'Hivly'` → `'Share2Brain'`.
  - [x] Visible brand text → `Share2Brain`: `Sidebar.tsx`, `LoginScreen.tsx`, `ChatWidget.tsx` (both `Hivly` occurrences: NAME_LABEL + line ~502).
  - [x] Comments/mock refs → `Share2Brain`: `Hexagon.tsx` (`Hivly brand hexagon`, `KeepHive Web.dc.html`), `global.css` (`Hivly design-system`, `KeepHive Web.dc.html`), `icons.tsx`.
  - [x] Update web tests: `App.test.tsx` (`getByText('Hivly')` → `'Share2Brain'`), `ChatWidget.test.tsx` (`Hivly.config.yml` strings → `Share2Brain.config.yml`), `conversations.test.ts` (`'How do I configure Hivly?'` → `Share2Brain`).

- [x] **Task 4 — Root config & infra** (AC: 5, 8) — commit `chore(repo): rename root package, compose, config example, infra`
  - [x] Root `package.json`: `"name": "hivly"` → `"share2brain"`.
  - [x] `docker-compose.yml`: `POSTGRES_DB`/`POSTGRES_USER` `hivly` → `share2brain`; every `DATABASE_URL`; `pg_isready -U … -d …` healthcheck; all `Hivly.config.yml` volume mounts → `Share2Brain.config.yml`; header/comments.
  - [x] `git mv Hivly.config.yml.example Share2Brain.config.yml.example`; update its internal comments.
  - [x] `.env.example`: `HIVLY_*` vars, `postgres://hivly:changeme@…/hivly` → `share2brain`, any `hivly` refs.
  - [x] `nginx.conf`, `Dockerfile.migrator`, `.dockerignore`, `.gitignore`: `hivly`/`Hivly` refs.
  - [x] **`eslint.config.js` (CORRECTNESS-CRITICAL, not cosmetic):** rename `SIBLING_SERVICES = ['@hivly/bot','@hivly/backend','@hivly/workers','@hivly/web']` → `@share2brain/*` (AD-2 sibling-import ban) **and** the AD-3 web browser-safe entrypoint rule strings (`@hivly/shared/schemas`, `@hivly/shared/types/events`) → `@share2brain/…`. If these literals aren't renamed, `no-restricted-imports` silently stops matching and the AD-2/AD-3 guards pass green even on a real violation. Add a test/spot-check: after rename, an intentional `@share2brain/bot` import from another service must still trip the lint error.
  - [x] Run `npm install` to regenerate `package-lock.json` + rebuild `node_modules/@share2brain/*` workspace symlinks. **Never hand-edit `package-lock.json`.**

- [x] **Task 5 — Docs (source of truth) + AD-13 ratification** (AC: 2, 6) — commit `docs(repo): rename to share2brain + ratify AD-13 stream prefix`
  - [x] `docs/context/ARCHITECTURE-SPINE.md`: ratify AD-13 — canonical stream-key/consumer-group prefix is `share2brain:`; update all examples; product name.
  - [x] `docs/context/PRD.md` (incl. the two `DATABASE_URL` examples using `Hivly:Hivly`/`Hivly:password` — normalize to `share2brain`), `TECHNICAL-DESIGN.md`, `data-model.md`, `api-spec.yml`, `base-standards.md`, `backend-standards.md`, `frontend-standards.md`, `documentation-standards.md`, `development_guide.md` (`hivly:hivly` DB URL → `share2brain`), `bmad-story-mandatory-steps.md`.
  - [x] `CLAUDE.md`: project name, `@share2brain/*` scope, `Share2Brain.config.yml`, stream keys, `npm run … -w @share2brain/*` commands.
  - [x] `_bmad-output/project-context.md`: tech-stack scope names, config filename, stream keys, DB name.
  - [x] `README.md`.

- [x] **Task 6 — BMAD artifacts full sweep** (AC: 7) — commit `chore(bmad): sweep hivly → share2brain across artifacts`
  - [x] Sweep `_bmad-output/**` (planning + implementation, all completed story files), `epics.md`, `_bmad/` config for `hivly`/`KeepHive`.
  - [x] **`spike/*.ts`** (tracked prototype scripts — `channels.ts`, `embeddings.ts`, `embeddings-factory.ts`, `gateway.ts`) import `@hivly/*`; rename to `@share2brain/*`. Note: `spike/` is not in any tsconfig/build/eslint scope (won't fail the gate), but sweep it for AC1 consistency; `spike/README.md` too.
  - [x] `sprint-status.yaml`: rewrite `@hivly` audit-note refs, `hivly:changeme` DB URLs, `KeepHive` design-mock mentions, and the `project: hivly` field → `share2brain`. Append this chore's status line + set `ops-3-rename-hivly-share2brain: done` at completion (see Task 8).
  - [x] **Apply the Preservation rule** (Dev Notes) — do NOT blind-`sed`. The rename-describing docs keep "hivly" as the old name.

- [x] **Task 7 — Verification gate** (AC: 8) — agent runs, pastes output
  - [x] `npm run lint && npm run test && npm run build` — all green; paste output.
  - [x] Playwright e2e: run the suite (`packages/web/tests`) — green; paste summary.
  - [x] Residual-reference check: `grep -rn '@hivly' packages` empty; `grep -rin 'hivly\|keephive' packages docs CLAUDE.md README.md docker-compose.yml nginx.conf .env.example` returns only intentionally-preserved provenance tokens (justify each in Completion Notes).
  - [~] Smoke the stack: `docker compose down -v` → `docker compose up`. **Substituted** by an equivalent runtime smoke (the full compose smoke is coupled to Borja's untracked config rename + Discord creds — his Task 8 ops step). Provisioned a fresh `share2brain` role+DB in the running Postgres, ran `drizzle-kit migrate` (all 8 tables), then ran the Playwright e2e (23/23 green) which spawns the **real** backend (`e2e:server`) + built web `vite preview` and seeds/reads the new DB. The config loader emitted `failed to read config file "Share2Brain.config.yml" … falling back to 1536` — runtime confirmation the config-filename rename (AC3) is live. Full `docker compose down -v && up` remains Borja's local step (see Task 8).

- [~] **Task 8 — Finalize tracking & handoff** (AC: 7, 9)
  - [~] Set `development_status[ops-3-rename-hivly-share2brain] = done` in `sprint-status.yaml` **after review**; append the status-line note. → Set to `review` now per the dev-story gate; the `done` flip + status-line note is a post-code-review action.
  - [~] Open PR `chore/rename-share2brain` (do not auto-merge; hand to `bmad-code-review`). → Branch committed locally (7 commits); **not pushed** — pushing/PR is Borja's trigger. `gh` command ready in Completion Notes.
  - [x] **Ops steps for Borja (outside the code PR, documented below + in the eventual PR body):** rename GitHub repo `borjaberrocal87/hivly` → `share2brain` (GitHub auto-redirects the old URL), then `git remote set-url origin https://github.com/borjaberrocal87/share2brain.git`; rename local dir `/Users/borjaberrocal/Documents/Webs/hivly` → `…/share2brain`; rename local untracked `Hivly.config.yml` → `Share2Brain.config.yml`; update the stale `DATABASE_URL` entry in `.claude/settings.local.json` (local permission allowlist).

## Dev Notes

### Naming canon (single source of truth — apply consistently)

| Old | New |
|---|---|
| `@hivly/{shared,bot,backend,workers,web}` | `@share2brain/{…}` |
| root `package.json` name `hivly` | `share2brain` |
| Brand `Hivly` / `KeepHive` (user-facing + comments) | `Share2Brain` |
| `VITE_COMMUNITY_NAME` default `Hivly` | `Share2Brain` |
| `hivly-theme` (localStorage) | `share2brain-theme` |
| Redis prefix `hivly:` → `:discord:messages`/`:updated`/`:deleted`/`:knowledge:events`/`:indexer`/`:sync`/`:notifier` | `share2brain:…` |
| `Hivly.config.yml` (+`.example`) | `Share2Brain.config.yml` |
| `HIVLY_CONFIG_PATH` / `HIVLY_API_PROXY_TARGET` / `HIVLY_TEST_ALLOW_SHARED_DB` / `HIVLY_TEST_UNSET_VAR` | `SHARE2BRAIN_…` (same suffix) |
| Postgres DB + user `hivly`; `DATABASE_URL=…hivly…` | `share2brain` |
| repo dir `/Webs/hivly`; git remote `borjaberrocal87/hivly` | `…/share2brain` |

### Preservation rule (CRITICAL — do not blind-`sed`)

Borja approved a **full sweep** of BMAD artifacts, but a naive global `hivly → share2brain` replace corrupts the record of *what was renamed*. Preserve `hivly` where the token names the **old identity as part of describing the migration or provenance**:
- This story file (`ops-3-rename-hivly-share2brain.md`) — its title, story, and tasks legitimately say "rename hivly → share2brain".
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-rename-share2brain.md` — the approved proposal; it is the historical record of the rename.
- The `sprint-status.yaml` status-line note for this chore (e.g. "renamed hivly → share2brain").
- Any "renamed from hivly (2026-07-10)" provenance line you add.

Everywhere else in `_bmad-output/**` (feature stories, retros, other SCPs) rewrite `hivly`/`KeepHive` → the new name for consistency, since those describe the product, not this migration. When in doubt, keep the sentence *true*: if replacing the word makes a sentence claim the product was always called Share2Brain in a context where that matters historically, leave a light-touch "(formerly hivly)" rather than erasing it.

### Why this must be atomic (AC 9)

Package resolution is via **npm workspace symlinks only** — there are **no `@hivly` path aliases** in any `tsconfig`/`vitest.config`/`vite.config` (verified). So the moment a `package.json` `name` changes, every consumer's `@hivly/shared` import is unresolved until (a) all importers are updated to `@share2brain/shared` and (b) `npm install` rebuilds the symlinks. There is no partially-working intermediate state; do the whole rename on one branch, run `npm install` once (Task 4), then verify.

### Surface notes & gotchas (verified against the tree)

- **Real `Hivly.config.yml` is untracked** (only `.example` is in git). The code PR renames the `.example`; the loader default; and compose mounts. Borja renames his local `Hivly.config.yml` himself (Task 8) — it holds his behavior config, not secrets.
- **No data/stream migration** — product never deployed to real prod (memory AI-3). Old-prefixed Redis keys and the `hivly` Postgres DB exist only in local/dev; `docker compose down -v` clears them. Do NOT write any data-migration SQL; drizzle migrations are clean of `hivly` and stay untouched (index names like `idx_embeddings_channel_created` contain no brand token).
- **AD-13 is the only invariant touched** — and only its *prefix literal*, ratified in the SPINE. XREADGROUP/XACK discipline, the fixed key set, PEL-as-DLQ: all unchanged. No other `AD-*` is affected. Note the ratification in this story's Dev Agent Record for traceability.
- **`.opencode/` is out of scope** — its only `hivly` refs live in untracked `.opencode/plans/` scratch; `.opencode/commands/` (tracked mirrors) are grep-clean.
- **ESLint AD-2/AD-3 guards depend on brand-literal strings** — the sibling-import ban and web-entrypoint allowlist match on `@hivly/*` literals. A stale literal doesn't error; it just stops guarding. This is the one place where "missing a rename" degrades an architecture invariant silently rather than breaking the build — hence the post-rename spot-check in Task 4.
- **Subpath specifiers are in scope** — imports include `@hivly/shared/{db,logger,notifier,providers,redis,schemas,types/events}` and direct service specifiers; renaming the package `name` + all import strings covers them (no `exports`-map self-references to the old scope).
- **`.claude/settings.local.json`** has a hardcoded `DATABASE_URL="postgres://hivly:changeme@…/hivly"` permission-allowlist entry — local-only, not shipped; Borja updates it in Task 8 (a stale entry is harmless but tidy to fix).
- **Docs have pre-existing casing inconsistencies** for the DB URL (`hivly:hivly`, `Hivly:Hivly`, `Hivly:password`) — normalize all to `share2brain` (lowercase Postgres identifiers).
- **Tests co-locate with source** and several assert brand/config strings — update them in the same commit as their source (Tasks 1–3) so the gate never goes red mid-branch.
- **`npm run build` produces `dist/`** in each package; the sweep excludes `dist`/`coverage`/`node_modules` — never edit generated output.

### Testing standards

- No new tests required (behaviour-preserving). Update existing assertions that reference the old brand/scope/config strings (enumerated in Tasks 1–3).
- The mandatory gate is `npm run lint && npm run test && npm run build` + Playwright e2e; the agent runs it and pastes output (never the user). Never commit red. The e2e harness (`packages/web/tests`) will catch any missed user-facing brand string or broken import at runtime.

### Project Structure Notes

- Package layout, workspace glob (`packages/*`), and all `AD-*` boundaries are unchanged — this is a pure identifier rename, not a restructure. No files move except `Hivly.config.yml.example` → `Share2Brain.config.yml.example` (a `git mv`, same directory).

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-rename-share2brain.md] — approved proposal, naming canon, §4 layered edits, §5 handoff.
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-13] — stream-key/consumer-group invariant to ratify.
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-1..AD-12] — boundaries preserved; inner-first order.
- [Source: packages/shared/src/types/events.ts] — the 7 stream-key literals.
- [Source: packages/shared/src/config/index.ts, embeddingDimensions.ts] — `DEFAULT_CONFIG_FILE`, `HIVLY_CONFIG_PATH`.
- [Source: docker-compose.yml] — DB name/user, `DATABASE_URL`, config mounts, healthcheck.
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml] — `ops-N` convention (ops-1/ops-2 precedent), development_status + status-line format.
- [Source: _bmad-output/project-context.md] — verification gate, Conventional Commits scopes, AD digest.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8) — bmad-dev-story.

### Debug Log References

- **AD-2 ESLint guard spot-check (Task 4, correctness-critical):** created a throwaway `packages/backend/src/__ad2_spotcheck__.ts` importing `@share2brain/bot`; `npx eslint` flagged it with `no-restricted-imports` ("Services must not import each other (AD-2). Only @share2brain/shared is shared") → the sibling-import guard still matches after the brand-literal rename. File removed.
- **Case-sensitive rename helper:** all bulk edits used a non-cascading 6-pass perl substitution (`KeepHive`→`Share2Brain`, `keephive`/`KEEPHIVE`→`share2brain`/`SHARE2BRAIN`, `HIVLY`→`SHARE2BRAIN`, `Hivly`→`Share2Brain`, `hivly`→`share2brain`). `Share2Brain` contains no `h-i-v-l-y` sequence, so passes never re-touch prior output. This auto-renamed the exported `HivlyConfig`/`HivlyConfigSchema` TS identifiers → `Share2BrainConfig(Schema)` consistently across all consumers.
- **Post-mortem — Task 4 first commit was hollow:** `git add … Hivly.config.yml.example …` aborted on that (already-`git mv`'d) pathspec and staged nothing but the rename, so `cc75bc2` captured only the 0-byte rename. Caught it at the Task 6 status check; the infra content edits were intact in the working tree and landed in a follow-up commit `33c9553`. Net tree is correct; the repo/infra layer is 2 commits instead of 1.
- **DB-URL casing normalization gotcha:** my one hand-written perl (normalizing `Hivly:Hivly`/`Hivly:password` DB URLs to lowercase in PRD) used an *unescaped* `@postgres`/`@localhost` in the replacement string → Perl interpolated them as empty arrays and dropped the host. Fixed both PRD lines with precise edits. (The reusable helper had no `@` in its replacements, so it was unaffected.)

### Completion Notes List

**Outcome:** Behaviour-preserving mechanical rename `hivly`/`KeepHive` → `share2brain`/`Share2Brain` across code, infra, docs, and BMAD artifacts. All 9 ACs satisfied. Single atomic branch `chore/rename-share2brain`, inner-first, one commit per layer (repo/infra = 2, see post-mortem above).

**Baseline → final sweep delta** (excl. `node_modules/.git/dist/coverage/.codegraph`):
- `hivly` (case-insensitive): **281 files / 1728 lines → only intended residuals** (see below).
- `keephive`: **20 files / 71 lines → 0** in live scope.

**Verification gate (AC8) — all green, agent-run:**
- `npm run lint` → clean (0 problems).
- `npm run test` → **892 passed / 1 skipped** (the skip is the pre-existing `enrich.smoke` LLM test).
- `npm run build` → all 5 packages green (`@share2brain/{shared,bot,backend,workers}` tsc + web `vite build`, 132 modules).
- Playwright e2e → **23/23 passed** against a freshly-provisioned+migrated `share2brain` DB (see Task 7 note).
- `npm install` regenerated `package-lock.json` (0 `hivly`) and rebuilt `node_modules/@share2brain/{shared,bot,backend,workers,web}` symlinks; no `@hivly` scope dir.

**Residual `hivly` refs — every one justified (AC7 Preservation rule + out-of-scope):**
- `_bmad-output/implementation-artifacts/ops-3-rename-hivly-share2brain.md` — this story (documents the rename). **Preserved.**
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-rename-share2brain.md` — the approved proposal (historical record). **Preserved.**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — the two ops-3 provenance blocks (`last_updated` note + backlog comment + the `ops-3-rename-hivly-share2brain` key, which maps to the story filename). **Restored verbatim** after the bulk sweep. Everything else in the file (historical audit notes describing the product) was renamed.
- `Hivly.config.yml` (untracked, local) — Borja renames in his Task 8 ops step.
- `.claude/settings.local.json` (untracked, local permission allowlist) — Borja's Task 8 ops step.
- `.opencode/plans/*.md` (untracked scratch) — explicitly out of scope.
- **Dated planning-snapshot directory NAMES** `…/architecture-hivly-2026-06-30/` and `…/prd-hivly-2026-06-30/` — kept as dated provenance (renaming them would falsely claim the artifacts were authored under the `share2brain` name on 2026-06-30). Their *contents* were renamed for consistency. Grep-by-content is clean; only the path segments carry `hivly`. **Flag for review** — trivial `git mv` follow-up if you'd rather rename the dirs too.

**AD-13 ratification (traceability):** the canonical Redis stream-key/consumer-group *prefix* is ratified `hivly:` → `share2brain:` in `ARCHITECTURE-SPINE.md` AD-13 and `events.ts`. XREADGROUP/XACK discipline, PEL-as-DLQ, and the fixed key set are unchanged. No other `AD-*` invariant is touched.

**Next steps for Borja (post-code-review; outside this agent's actions):**
1. `bmad-code-review` on this branch (different LLM recommended).
2. After review passes: flip `sprint-status.yaml` `ops-3-rename-hivly-share2brain: review → done` + append status-line note.
3. Push + open PR: `git push -u origin chore/rename-share2brain` then `gh pr create --title "chore: rename hivly → share2brain" --body "…"` (do NOT auto-merge). Put the ops steps below in the PR body.
4. Ops (local, not in the code PR): rename GitHub repo `borjaberrocal87/hivly` → `share2brain`; `git remote set-url origin https://github.com/borjaberrocal87/share2brain.git`; rename local dir `…/Webs/hivly` → `…/Webs/share2brain`; rename local `Hivly.config.yml` → `Share2Brain.config.yml`; fix the stale `DATABASE_URL` in `.claude/settings.local.json`.
5. Fresh-infra smoke: `docker compose down -v` (drops the old `hivly` DB volume + old-prefix Redis keys) → `docker compose up` → confirm boot with the new DB/config/stream keys and UI brand `Share2Brain`. (I provisioned a transient local `share2brain` DB in the running old `hivly-postgres-1` container to run e2e; `down -v` supersedes it.)

### File List

Rename touched **279 tracked files** across 7 commits. Non-mechanical / notable:
- `Hivly.config.yml.example` → `Share2Brain.config.yml.example` (`git mv` + content).
- `packages/shared/src/types/events.ts` — 7 stream-key/consumer-group literals.
- `packages/shared/src/config/{index,embeddingDimensions}.ts` — `DEFAULT_CONFIG_FILE`, `SHARE2BRAIN_CONFIG_PATH`, exported `Share2BrainConfig(Schema)` types.
- `packages/web/{index.html,src/App.tsx,src/hooks/useTheme.ts,src/components/{Sidebar,LoginScreen,ChatWidget,Hexagon}.tsx}` — brand text, `<title>`, `VITE_COMMUNITY_NAME` default, `share2brain-theme` key.
- `docker-compose.yml`, `.env.example`, `nginx.conf`, `Dockerfile.migrator`, `.dockerignore`, `.gitignore`, `package.json`, `package-lock.json`.
- `eslint.config.js` — `SIBLING_SERVICES` + web-entrypoint `no-restricted-imports` brand literals (AD-2/AD-3 guards).
- `docs/context/ARCHITECTURE-SPINE.md` (AD-13 prefix), `docs/context/PRD.md` (DB-URL casing normalized), all other `docs/**`, `CLAUDE.md`, `README.md`, `_bmad-output/project-context.md`.
- `_bmad-output/**` sweep (incl. `epics.md`, all historical story/retro/SCP files) + `_bmad/{config.toml,core/config.yaml,bmm/config.yaml}` + `spike/*.ts` + `spike/README.md`, with provenance preserved per the Preservation rule.

Full mechanical inventory: `git diff --name-only main...chore/rename-share2brain`.

### Change Log

- 2026-07-10 — Implemented ops-3 rename `hivly` → `share2brain` (bmad-dev-story). 7 commits on `chore/rename-share2brain` (shared → services → web → repo/infra ×2 → docs → bmad). Gate green (lint 0 / test 892+1skip / build 5 pkgs / e2e 23). Status → review.

### Review Findings

<!-- bmad-code-review 2026-07-10 (Opus 4.8): 3 layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 9/9 ACs PASS. All correctness-critical surfaces (eslint AD-2/AD-3 guards, events.ts stream keys, config loader, docker-compose, package-lock symlinks) verified clean at source. 1 decision-needed, 3 patch, 3 defer, 3 dismissed. -->

- [x] [Review][Patch] (resolved from Decision) `git mv` dated planning-snapshot directory NAMES to drop `hivly` path segment for full-sweep consistency (Borja chose rename over keep-as-provenance): `architecture-hivly-2026-06-30/` → `architecture-share2brain-2026-06-30/` and `prd-hivly-2026-06-30/` → `prd-share2brain-2026-06-30/`. **APPLIED** — `git mv`, no internal refs to the old paths. [_bmad-output/planning-artifacts/architecture/, .../prds/]
- [x] [Review][Patch] PRD example Postgres identifiers left capitalized `Share2Brain` while sibling `DATABASE_URL` is lowercase `share2brain` — internally contradictory; a copy-paste of the example fails auth ("role share2brain does not exist"). Contradicts the dev's own "lowercase Postgres identifiers" normalization intent. **APPLIED** — both example blocks lowercased. [docs/context/PRD.md:1055-1057,1062,1124-1126,1132]
- [x] [Review][Patch] Design-mock file not renamed: 4 comments/citations now reference `Share2Brain Web.dc.html` but the tracked file was still `docs/context/design/KeepHive Web.dc.html` — references dangled. **APPLIED** — `git mv` file to `Share2Brain Web.dc.html` (honors AC7 sweep); refs now resolve. [packages/web/src/styles/global.css:6, packages/web/src/components/icons.tsx:4,191, packages/web/src/components/Hexagon.tsx:16]
- [x] [Review][Patch] Clone URL owner segment mechanically capitalized to `Share2Brain/share2brain`; real remote is `borjaberrocal87/share2brain` (Task 8). **APPLIED**. [docs/development_guide.md:20]
- [x] [Review][Defer] Untracked local `Hivly.config.yml` is now un-gitignored (`.gitignore`/`.dockerignore` only ignore `Share2Brain.config.yml`) — AD-8 behavior config exposed to accidental `git add`. Resolved by Borja's Task 8 ops step (rename/delete local file). [.gitignore:7, .dockerignore:17] — deferred, out of code-PR scope (Borja's ops step)
- [x] [Review][Defer] Slack channel `#Share2Brain-alerts` uses invalid casing (Slack channels are lowercase-only). Pre-existing (`#Hivly-alerts` was already capitalized), faithfully carried through. [docs/context/PRD.md:569,1234] — deferred, pre-existing
- [x] [Review][Defer] Story record says "7 commits"; branch has 8 (8th = the story→review tracking commit `0c264ee`). Cosmetic record accuracy; self-corrects on the done-flip commit. [ops-3-rename-hivly-share2brain.md:174,221] — deferred, pre-existing/cosmetic
