# Sprint Change Proposal — Rename `hivly` → `share2brain`

- **Date:** 2026-07-10
- **Author:** Borja (via Correct Course workflow)
- **Mode:** Incremental
- **Change scope classification:** Moderate (touches AD-13 invariant → requires ARCHITECTURE-SPINE ratification; otherwise mechanical)

---

## Section 1 — Issue Summary

**Problem statement.** The product/application is being renamed from **`hivly`** (with the legacy design-mock brand **`KeepHive`**) to **`Share2Brain`**. This is a strategic branding pivot, not a functional change: no feature behaviour, data model semantics, or user flow changes.

**Discovery context.** Raised by the product owner (Borja) after the feature roadmap closed (Epic 9 retro done, project in operational-hardening mode). It is orthogonal to the operational backlog but should land before real-prod deployment (AI-3) so the deployed identity is correct from day one.

**Evidence.** A full-tree scan (excluding `node_modules/.git/dist/coverage/.codegraph`) found:
- **1920 occurrences** of `hivly` across **279 files**; **18 files** contain the legacy `KeepHive` brand.
- Breakdown by area: `packages/` 175 files, `_bmad-output/` 63, `docs/` 11, `.opencode/` 9, `spike/` 5, `_bmad/` 3, plus root config/infra files.
- Dominant forms: `@hivly/*` package scope (~800 refs), `Hivly.config` (~315), Redis stream keys `hivly:*` (~250), `HIVLY_*` env vars (~46).

---

## Section 2 — Impact Analysis

### Epic Impact
- **No functional epic is modified, reordered, deferred, or invalidated.** The rename is orthogonal to all delivered features (Epics 1–9).
- One **new dedicated chore story** enters the operational backlog: `chore(repo): rename hivly → share2brain`.

### Story Impact
- No in-flight story (sprint is idle; roadmap closed).
- Historical story artifacts under `_bmad-output/implementation-artifacts/` (63 files) contain `hivly`/`KeepHive` references. These are **historical records** — see §3 decision on doc-rewrite depth.

### Artifact Conflicts
| Artifact | Impact | Authority |
|---|---|---|
| `docs/context/ARCHITECTURE-SPINE.md` | **AD-13 invariant change**: canonical stream-key / consumer-group prefix becomes `share2brain:`. Must be ratified in the SPINE. | AD-13 |
| `docs/context/PRD.md` | Product name + examples | PRD |
| `docs/context/TECHNICAL-DESIGN.md`, `docs/data-model.md`, `docs/api-spec.yml`, `docs/*-standards.md`, `docs/development_guide.md`, `docs/bmad-story-mandatory-steps.md` | Name, config filename, env vars, DB name, examples | docs |
| `CLAUDE.md`, `_bmad-output/project-context.md` | Project name, package scope, config filename, stream keys, useful commands | agent context |
| `packages/shared/src/config/*` | `Hivly.config.yml` default filename + `HIVLY_CONFIG_PATH` env | AD-8 |
| `packages/shared/src/types/events.ts` | Stream keys + consumer groups (AD-13) | AD-13 |
| `packages/web/src/**` | Brand strings, `<title>`, `VITE_COMMUNITY_NAME` default, `hivly-theme` localStorage key | AD-3 |

### Technical Impact
- **npm scope rename** `@hivly/*` → `@share2brain/*` across 5 packages + root package name; touches every cross-package import + `package-lock.json`.
- **Redis stream keys / consumer groups** change (AD-13). Because the product **has never been deployed to real prod** (memory AI-3), there are **no live streams, no consumer-group state, and no data to migrate** — the rename is a clean cut. A running local/dev Redis should be flushed (or start fresh) to drop old-prefixed keys.
- **Postgres DB + user** `hivly` → `share2brain`; **no data migration** for the same reason. Local dev volumes must be recreated (`docker compose down -v`).
- **Config file** `Hivly.config.yml` → `Share2Brain.config.yml` + `.example`; env family `HIVLY_*` → `SHARE2BRAIN_*`.
- **Atomicity constraint:** a partial rename breaks the build (unresolved `@hivly/*` imports). The change **must be a single branch / single PR / single green verification gate**.

---

## Section 3 — Recommended Approach

**Selected path: Option 1 — Direct Adjustment (single atomic chore).**

| Option | Verdict | Effort | Risk |
|---|---|---|---|
| 1. Direct Adjustment (one chore story, one PR) | **Chosen** | Medium | Low |
| 2. Rollback | N/A — nothing to revert | — | — |
| 3. MVP Review | N/A — MVP/scope unchanged | — | — |

**Rationale.** The rename is mechanical and behaviour-preserving. Splitting it across stories would leave the monorepo un-buildable between steps (broken `@hivly/*` imports), so it must land atomically. Risk is Low because nothing is deployed to prod (no data/stream migration), and the mandatory verification gate (`lint && test && build`) plus the Playwright e2e harness will catch any missed reference. The only architectural weight is ratifying the AD-13 key prefix in the SPINE — a naming ratification, not a redesign.

**Naming canon (single source of truth for all edits):**

| Old | New |
|---|---|
| `@hivly/{shared,bot,backend,workers,web}` | `@share2brain/{…}` |
| root `package.json` name `hivly` | `share2brain` |
| Brand `Hivly` / `KeepHive` (user-facing) | `Share2Brain` |
| `VITE_COMMUNITY_NAME` default `Hivly` | `Share2Brain` |
| `hivly-theme` (localStorage key) | `share2brain-theme` |
| Redis prefix `hivly:` → `hivly:discord:messages` / `:updated` / `:deleted` / `hivly:knowledge:events` / `hivly:indexer` / `hivly:sync` / `hivly:notifier` | `share2brain:…` |
| `Hivly.config.yml` (+`.example`) | `Share2Brain.config.yml` |
| `HIVLY_CONFIG_PATH` / `HIVLY_API_PROXY_TARGET` / `HIVLY_TEST_ALLOW_SHARED_DB` / `HIVLY_TEST_UNSET_VAR` | `SHARE2BRAIN_…` (same suffixes) |
| Postgres DB + user `hivly`; `DATABASE_URL=postgres://hivly:…@…/hivly` | `share2brain` |
| Repo dir `/Users/borjaberrocal/Documents/Webs/hivly` | `…/share2brain` |
| Git remote `github.com/borjaberrocal87/hivly.git` | `…/share2brain.git` |

---

## Section 4 — Detailed Change Proposals

Grouped by layer, executed in this order (inner-first per AD-1). Each group is one meaningful commit.

### 4.1 — Shared kernel (contracts first)
- `packages/shared/package.json`: `"name": "@hivly/shared"` → `"@share2brain/shared"`.
- `packages/shared/src/types/events.ts`: rewrite all stream-key + consumer-group literals `hivly:*` → `share2brain:*` (AD-13).
- `packages/shared/src/config/index.ts` + `embeddingDimensions.ts`: `DEFAULT_CONFIG_FILE = 'Hivly.config.yml'` → `'Share2Brain.config.yml'`; `HIVLY_CONFIG_PATH` → `SHARE2BRAIN_CONFIG_PATH`; update doc comments.
- `packages/shared/src/notifier/index.ts`: comment referencing `hivly:*` streams.

### 4.2 — Service packages
- `packages/{bot,backend,workers,web}/package.json`: `name` → `@share2brain/*`; any `@hivly/shared` dep key → `@share2brain/shared`.
- All `import … from '@hivly/…'` across `packages/*/src/**` → `@share2brain/…`.
- Backend: `HIVLY_API_PROXY_TARGET`, `HIVLY_TEST_*` env reads → `SHARE2BRAIN_*`.

### 4.3 — Web branding (user-facing)
- `packages/web/index.html`: `<title>Hivly` → `Share2Brain`; `localStorage.getItem('hivly-theme')` → `'share2brain-theme'` (and any setter).
- `packages/web/src/App.tsx`: `COMMUNITY_NAME … ?? 'Hivly'` → `'Share2Brain'`.
- `Sidebar.tsx`, `LoginScreen.tsx`, `ChatWidget.tsx` (×2): visible `Hivly` → `Share2Brain`.
- `Hexagon.tsx`, `global.css`, `icons.tsx`: `Hivly`/`KeepHive` in comments → `Share2Brain`.
- Update affected `*.test.ts(x)` expectations (`getByText('Hivly')`, config-filename strings, etc.).

### 4.4 — Root config & infra
- Root `package.json`: `"name": "hivly"` → `"share2brain"`.
- `docker-compose.yml`: `POSTGRES_DB`/`POSTGRES_USER` `hivly` → `share2brain`; all `DATABASE_URL`; `Hivly.config.yml` volume mounts → `Share2Brain.config.yml`; healthcheck `pg_isready -U … -d …`; comments.
- `Hivly.config.yml.example` → rename file to `Share2Brain.config.yml.example`; internal comments.
- `.env.example`: `HIVLY_*` vars, `hivly:changeme` placeholders, DB name.
- `nginx.conf`, `Dockerfile.migrator`, `.dockerignore`, `.gitignore`, `eslint.config.js`: `hivly` refs.
- `package-lock.json`: regenerate via `npm install` after scope rename (do **not** hand-edit).

### 4.5 — Docs (source of truth)
- `docs/context/ARCHITECTURE-SPINE.md`: **ratify AD-13** — canonical stream-key/consumer-group prefix is `share2brain:`; update all examples. Update product name.
- `docs/context/PRD.md`, `TECHNICAL-DESIGN.md`, `data-model.md`, `api-spec.yml`, `*-standards.md`, `development_guide.md`, `bmad-story-mandatory-steps.md`, `documentation-standards.md`: name, scope, config filename, env vars, DB name, examples.
- `CLAUDE.md` + `_bmad-output/project-context.md`: project name, `@share2brain/*` scope, `Share2Brain.config.yml`, stream keys, `npm run … -w @share2brain/*` commands.
- `README.md`.

### 4.6 — BMAD artifacts (DECISION CONFIRMED: rewrite all)
- `_bmad-output/**` (63 files — including completed dated story files, planning artifacts, `sprint-status.yaml`, `epics.md`, `project-context.md`), `_bmad/` config, `.opencode/`, `spike/`.
- **Confirmed by Borja:** full sweep — rewrite **every** `hivly`/`KeepHive` reference across all BMAD artifacts for 100% consistency, historical story files included.

### 4.7 — Repo & git (ops, outside code diff)
- Rename local dir `/Users/borjaberrocal/Documents/Webs/hivly` → `…/share2brain`.
- GitHub: rename repo `borjaberrocal87/hivly` → `borjaberrocal87/share2brain` (GitHub auto-redirects the old URL), then `git remote set-url origin https://github.com/borjaberrocal87/share2brain.git`.
- Recreate local dev state: `docker compose down -v` (drop old `hivly` DB volume + Redis keys) before first `docker compose up` with new names.

---

## Section 5 — Implementation Handoff

**Scope classification: Moderate.** Backlog change (one new chore story) + one AD invariant ratification. No PM/Architect redesign needed; the AD-13 change is a naming ratification recorded in the SPINE.

**Handoff plan:**
1. **Dev agent (`bmad-create-story` → `bmad-dev-story`)** — author and implement a single story `chore(repo): rename hivly → share2brain` on branch `chore/rename-share2brain`, executing groups 4.1→4.5 in order, one commit per group. Run the mandatory gate `npm run lint && npm run test && npm run build` + Playwright e2e; paste output. Regenerate `package-lock.json`.
2. **Architect note** — the story's Dev Notes must record the AD-13 ratification (SPINE update) so the invariant change is traceable.
3. **Product Owner (Borja)** — confirm §4.6 doc-rewrite depth at approval; perform §4.7 GitHub repo rename + local dir rename (ops steps outside the code PR).
4. **Code review (`bmad-code-review`)** — verify zero residual `hivly`/`KeepHive` refs in live code (`grep -ri 'hivly\|keephive' packages docs CLAUDE.md` returns only intentionally-preserved historical artifacts), gate green.

**Success criteria:**
- `npm run lint && npm run test && npm run build` green; Playwright e2e green.
- No `@hivly/*` import resolves anywhere; `grep -rl '@hivly' packages` empty.
- App boots via `docker compose up` with new DB name, config file, and stream keys; UI shows `Share2Brain`.
- Docs (SPINE/PRD/TECHNICAL-DESIGN/CLAUDE.md) reflect the new name and the AD-13 prefix.

---

## Approval

- [x] Borja approves this Sprint Change Proposal for implementation. _(2026-07-10)_
- [x] §4.6 doc-rewrite depth decision confirmed: **rewrite all 63 BMAD artifacts**.
