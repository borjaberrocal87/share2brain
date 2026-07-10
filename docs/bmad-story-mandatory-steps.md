---
description: Mandatory steps and verification gate when planning (epics/stories) and executing stories with the BMAD Method skills. The agent MUST run all verification itself.
alwaysApply: true
---

# Story Execution: Mandatory Steps Enforcement (BMAD Method)

Share2Brain is driven with the **BMAD Method** (BMM module, installed under `_bmad/`, configured in `_bmad/core/config.yaml` and `_bmad/bmm/config.yaml`). The way of working is story-based:

- **Plan** with `bmad-prd` (PRD), `bmad-ux` (UX specs), `bmad-architecture` (architecture spine), then `bmad-create-epics-and-stories` to break the PRD into epics and stories. Gate the plan with `bmad-check-implementation-readiness`.
- **Sprint** with `bmad-sprint-planning` (generate sprint status from epics) and `bmad-create-story` (author a self-contained story spec with all context).
- **Implement** one story at a time with `bmad-dev-story` (or `bmad-quick-dev` for small changes).
- **Review** with `bmad-code-review` (mandatory before merge) and surface the change with `bmad-checkpoint-preview` for human review.
- **Adjust** mid-sprint with `bmad-correct-course`; close an epic with `bmad-retrospective`.

This document is the checklist those skills enforce. When it and a BMAD skill disagree, the skill wins.

> Terminology: the unit of work is a **story** (`bmad-dev-story` implements exactly one). Planning artifacts (PRD, UX, architecture, epics, stories) live under `_bmad-output/planning-artifacts`; sprint status and per-story implementation notes under `_bmad-output/implementation-artifacts`. Durable project knowledge lives in `docs/`. The verification gate is **type-check + tests + build**.

## 1. Read the project context first

**BEFORE** creating a story or implementing one, read the way of working and design context:
- `docs/context/ARCHITECTURE-SPINE.md` — invariants `AD-1 … AD-13`, dependency rules, State Ownership.
- `docs/context/TECHNICAL-DESIGN.md` — the concrete design for the area you touch.
- `docs/context/PRD.md` and the epics/stories under `_bmad-output/planning-artifacts` — scope, acceptance criteria, dependencies.
- `base-standards.md` (workflow conventions, language, planning-model requirement) and the relevant `*-standards.md`.

## 2. Mandatory structure of a story

Every story authored with `bmad-create-story` and implemented with `bmad-dev-story` must satisfy, in order:

### Dependency gate (before any work)
- Build the transitive dependency closure from the story's `Depends on:` and its epic ordering.
- Every dependency story must be **merged** (not merely marked done). Any unmet → STOP and implement the deepest unmet dependency first, or explicitly re-order the sprint with `bmad-correct-course`.

### Branch first (before any edit)
- Run `git branch --show-current`. If it is the default branch, `git switch -c <branch>` before any edit.
- Branch format: `feat/<epic>-<story-slug>` for feature stories; `fix/<topic>` for fixes. Never work on `main`.

### Implementation order (within the story)
- Build inner layers first: persistence/schema (`packages/shared`) → core/domain → orchestration/use-case → adapters → controller/endpoint → UI → tests.
- **Tests-first where it pays** (core/domain, orchestration): write the story's acceptance/integration tests red, then implement to green.

### Story completion gate (every acceptance criterion, every story)
- [ ] Verification gate green — **type-check + tests + build actually RUN** (paste commands + exit status), never assumed.
- [ ] Every acceptance criterion of the story satisfied and mapped to evidence (code path or test name).
- [ ] Tests updated/added for every behavior the story changed.
- [ ] No TODO/FIXME/HACK left in the diff; no dead code; no duplicated logic (reuse the existing helper).
- [ ] No hidden breaking change (public contracts diffed against consumers).
- [ ] Architecture respected (dependency directions, layer boundaries, `AD-*` invariants).
- [ ] Story status and implementation notes updated in `_bmad-output/implementation-artifacts`; durable docs updated in `docs/` (see §3.5). Update the architecture context in `docs/context/` if a decision moved it.

### Commit
- One conventional commit per meaningful slice of the story: `git add <files>` then `git commit -m "<type>(<scope>): <summary>"` (full spec: `base-standards.md` §8). Run it — describing a commit is not committing.

### Finishing a story
- Flip the story status to done in the sprint tracking, commit, `git push`, and open the PR: `gh pr create --base main …`. The PR body is never empty (what/why/evidence, `Closes #<n>` when issue-born).
- Hand off to `bmad-code-review` (mandatory), then `bmad-checkpoint-preview` for human review. Never auto-merge.

## 3. Verification requirements — the agent MUST execute them

**IMPORTANT**: the coding agent (AI) performs all verification itself. **NEVER delegate testing to the user.** A story acceptance criterion is only marked satisfied after the agent has run the verification and pasted the evidence.

### 3.1 Verification gate (MANDATORY)

The agent MUST run and paste the output of:

```bash
npm run lint          # (type-check via tsc as configured)
npm run test          # Vitest across affected workspaces
npm run build
```

Scope to a workspace when appropriate (`-w @share2brain/backend`). If red, fix within the story's scope and re-run — never commit red. If it can't be fixed within scope, record it in the story's implementation notes, leave the work uncommitted, and stop with a clear report (or open a follow-up story via `bmad-correct-course`).

### 3.2 Data/state verification for DB-affecting changes (MANDATORY)

For changes that touch the schema, ingestion, or persisted state, the agent MUST:
1. **Prepare**: ensure Postgres (pgvector) and Redis are up (`docker compose up -d postgres redis`) and migrations are applied (`npx drizzle-kit migrate`).
2. **Baseline**: capture relevant pre-test state (row counts, key records, or a snapshot).
3. **Exercise**: run the targeted tests, then the broader suite.
4. **Verify + restore**: re-check the baseline indicators; if any test mutated persistent state, restore it and document the restoration.
5. **Idempotency check** (ingestion/Workers): confirm re-delivering the same stream event UPSERTs rather than duplicating, and that a failed processing path leaves the entry un-ACKed.

### 3.3 API endpoint verification (MANDATORY for new/changed endpoints) — AGENT MUST EXECUTE

The agent MUST exercise endpoints itself (start the Backend if needed):

- **REST** (GET/POST/PATCH/DELETE): call the endpoint (e.g. `curl` or a test client), verify status codes and that the response matches the Zod schema in `@share2brain/shared/schemas`. Verify the unified error shape `{ error, code }` for error cases (validation → 400/422, missing session → 401, not found → 404).
- **RBAC**: verify a request never returns fragments/documents outside the caller's `allowedChannelIds`.
- **SSE** (`POST /api/chat`): verify the stream emits `token` frames incrementally (not buffered), then `citation`/`done`, matching the `SSEFrame` schema. Confirm nginx config disables buffering for `/api/chat` when testing through the proxy.
- **Restore state**: for CREATE/UPDATE/DELETE, restore the DB to its pre-test state and document the cleanup.

### 3.4 E2E verification with Playwright (MANDATORY when UI is affected) — AGENT MUST EXECUTE

**Concrete verification path for this repo** — the Playwright harness landed by Story 4.5
(`packages/web/playwright.config.ts` + `packages/web/tests/`, run via
`npm run test:e2e -w @share2brain/web`). When a story affects `@share2brain/web` user workflows, the agent MUST:

1. Boot the harness backend: `createApp` with an **injected fake `DiscordOAuthClient`**
   (the `opts.oauth` pattern from `*.integration.test.ts`) + a deterministic fake
   `queryEmbedder`, over a test Postgres+pgvector/Redis seeded with `channel_permissions` +
   `embeddings`. The SPA gates on a Discord OAuth session, so acquire the session cookie via
   the **fake-OAuth callback** — never real Discord credentials, and never a production
   auth-bypass route.
2. Point Vite preview at the test backend and drive the workflow with Playwright (navigate,
   interact, assert) — e.g. search → results, docs read-status mark-all updates counts, chat
   streaming renders tokens + citations.
3. Assert **visual/CSS ACs** with `getComputedStyle` (fonts, box-shadow, token colors, grid
   templates) — jsdom cannot; use the **real** token names (`--text-primary/-muted/-subtle`,
   renamed in Story 2.1 from `--tx/--tx4/--tx5`). Capture screenshots as artifacts.
4. Test error/validation paths; verify persistence (data created via UI is present and
   correct); restore any test data and the DB state.

**Explicit fallback when the agent environment has no browser automation** (no Playwright
runner / no headless browser available in this session): the agent MUST
1. run the backend-slice smoke it *can* (REST/SSE + RBAC per §3.3, over a real DB + fake OAuth);
2. **explicitly flag every unverified visual/CSS AC** in the story implementation notes AND
   the PR body (name the exact ACs, e.g. "AC2 focus box-shadow not visually verified");
3. leave those ACs to be covered by the Story 4.5 harness spec.

**Never mark a visual/CSS AC "satisfied" without either the harness run or a documented
manual check.** A flagged-but-unverified AC is an accepted, documented deferral — a silently
passed one is a gate violation.

### 3.5 Documentation update (MANDATORY)

Update the docs the change implies (see `documentation-standards.md`): `data-model.md` for schema changes, `api-spec.yml` for API changes, `*-standards.md`/`development_guide.md` for stack/process changes, and the design context in `docs/context/` for architectural moves. Per-story implementation notes in `_bmad-output/implementation-artifacts` are part of the completion gate.

## 4. Verification checklist (before marking a story ready for review)

- [ ] Dependency gate documented and satisfied (or re-ordered via `bmad-correct-course`).
- [ ] Branch-first step done; branch format correct; never `main`.
- [ ] Every acceptance criterion satisfied and mapped to evidence.
- [ ] Mandatory verification steps executed and marked "AGENT MUST EXECUTE".
- [ ] DB-affecting changes include baseline + restore steps.
- [ ] E2E run if UI is affected (Playwright harness per §3.4); if browser automation is unavailable, the fallback ran and every unverified visual/CSS AC is flagged in notes + PR.
- [ ] Documentation-update step done.
- [ ] Closing hand-off to `bmad-code-review` → `bmad-checkpoint-preview` present for the finishing story.

## 5. When this applies

- Authoring a story via `bmad-create-story`, or planning epics/stories via `bmad-create-epics-and-stories`.
- Implementing a story via `bmad-dev-story` (or `bmad-quick-dev`) — the agent executes all verification.
- Any story that touches the schema, ingestion pipeline, API, or UI.

## 6. Example story-execution flow

```markdown
## Dependency gate
- [ ] Build the Depends-on closure; confirm each dependency story is merged (or re-order via bmad-correct-course)

## Branch (first)
- [ ] Run `git branch --show-current`; if default, `git switch -c feat/<epic>-<story-slug>`

## Implement (inner layers first)
- [ ] Write acceptance/integration tests (red)
- [ ] Implement schema change in packages/shared (drizzle-kit generate)
- [ ] Implement domain/orchestration to green
- [ ] Implement adapter/endpoint + Zod schema in @share2brain/shared/schemas
- [ ] Verify REST/SSE endpoints (AGENT MUST EXECUTE); check RBAC; restore state
- [ ] Gate: npm run lint && npm run test && npm run build (paste output)
- [ ] Update story notes in _bmad-output/implementation-artifacts + durable docs in docs/
- [ ] Commit: feat(<scope>): <summary>

## Finish
- [ ] Flip story status to done, commit, push, open PR (Closes #<n> if issue-born)
- [ ] Hand off to bmad-code-review → bmad-checkpoint-preview
```

## 7. Agent execution requirements

**CRITICAL**: when implementing via `bmad-dev-story`, the agent MUST:

1. **Execute all verification itself** — start services if needed; run the gate; exercise REST/SSE endpoints and E2E; verify RBAC and idempotency; restore state. Never ask the user to run them.
2. **Only mark a criterion satisfied after evidence** — a satisfied acceptance criterion requires the verification to have run, results verified, and (for mutating operations) state restored.
3. **Never delegate testing** to the user, never mark a story done without executing verification, never skip mandatory steps.
4. **Document execution** — commands run, results, RBAC/idempotency checks, and any restoration actions (in the story's implementation notes / the PR body as appropriate).

## Failure to follow

Authoring stories without these mandatory steps, or implementing a story without executing verification yourself, violates this rule. Read the project context first, keep work to one story at a time, run the gate, and hand off to `bmad-code-review` → `bmad-checkpoint-preview` before any merge.
