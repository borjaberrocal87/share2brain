---
type: sprint-change-proposal
date: 2026-07-07
author: Amelia (Dev) — bmad-correct-course
project: share2brain
status: approved
scope_classification: moderate
mode: incremental
---

# Sprint Change Proposal — E2E Visual-Verification Harness (Playwright)

## 1. Issue Summary

**Trigger type:** Technical limitation discovered during implementation (not a failed story,
not a product-scope change).

**Discovery context:** Surfaced during the code review of **Story 4.3** (Web App — vista
Búsqueda), the first frontend story of Epic 4. Story 4.3 was marked `done`/merged
(commit 92d3a3b) **with its visual/CSS acceptance criteria (AC1/AC2/AC4/AC5) unverified**.

**Core problem:** The mandatory verification gate (`docs/bmad-story-mandatory-steps.md`
§3.4 + §7) **requires the agent to execute Playwright E2E whenever a story affects
`@share2brain/web`**, and `frontend-standards.md` / `development_guide.md` document
`npm run test:e2e -w @share2brain/web` **as if it existed**. In reality:

1. **No harness exists.** `packages/web` has no `playwright.config`, no `test:e2e` script,
   and no `@playwright/test` dependency. Verified on disk — the sprint-status:45 comment
   claiming "Playwright 1.61.1 already installed" is **incorrect** (not in any `package.json`,
   not in `node_modules`, no bin).
2. **The environment can't run it as specified.** The agent environment has no browser
   automation and no real Discord OAuth credentials, and the SPA gates everything behind an
   OAuth session (`App.tsx → /api/auth/me → LoginScreen → full-page /api/auth/login`), so a
   real headless Discord login is impossible.
3. **jsdom ignores external CSS**, so token/box-shadow/font ACs are inherently unverifiable by
   unit test.

The gap is **recurring**: every remaining UI story carries the same heavy visual ACs
(UX-DR10–UX-DR23) and will hit the same wall.

**Evidence:** `sprint-status.yaml:45-46`; Playwright absence confirmed on disk;
`bmad-story-mandatory-steps.md` §3.4/§7; `frontend-standards.md:187,258` and
`development_guide.md:115-118` referencing a non-existent command.

**Decisions locked with the stakeholder (Borja, 2026-07-07):**

1. The harness ships as a new **Story 4.5** (appended after the docs view 4.4) — **no
   renumbering**. The docs view keeps its number 4.4.
2. Process-gate reconciliation = **amend the process docs + define an explicit fallback**;
   Playwright stays a **convention, not an AD invariant** (not elevated in the spine).
3. The harness spec covers **Story 4.3 + Story 4.4 visual ACs retroactively** as its initial
   coverage.

## 2. Impact Analysis

### Epic Impact
- **Epic 4 (in-progress):** completable as planned; gains **new Story 4.5** — a cross-cutting
  test-enablement / consolidation story. 4.3 is done; 4.4 (docs view) proceeds next under the
  fallback flag; 4.5 then builds the harness and retroactively verifies the whole Epic 4 UI
  surface (4.3 + 4.4) before Epic 5's chat UI.
- **Epic 5 (backlog):** unblocked-with-dependency — Stories **5.3 / 5.4** (chat FAB, panel,
  SSE streaming UI) rely on the harness. 4.5 blocks 5.3/5.4.
- **No epic obsolete; no new epic; one new story (4.5).**

### Story Impact
| Story | Change |
|---|---|
| **4.5 (new)** | Playwright harness: `@playwright/test` + `playwright.config.ts` + real `test:e2e` script; fake-OAuth injected `createApp` session bootstrap; seeded test Postgres+pgvector/Redis; `getComputedStyle` visual assertions + screenshots; **initial spec covers 4.3 + 4.4 ACs retroactively**. Blocks 5.3/5.4. |
| 4.3 (done) | No reopen. Its unverified visual ACs (AC1/AC2/AC4/AC5) become part of 4.5's initial spec. |
| 4.4 (backlog) | No AC change. Ships next under the **fallback flag** (visual ACs flagged unverified in notes+PR), verified retroactively by 4.5. |
| 5.3 / 5.4 | Gain a hard dependency on 4.5; each adds its own harness spec. |

### Artifact Conflicts
- **PRD:** no product conflict. NFR16 / SNF-12 ("E2E de búsqueda y chat") stays valid; the
  roadmap defers "E2E tests completos" to v1 — a **minor tension** (the per-story gate is
  stricter than the roadmap), clarified via the process amendment, MVP unchanged.
- **Process docs (the core):** `bmad-story-mandatory-steps.md` §3.4 + §4 checklist,
  `frontend-standards.md:187,258`, `development_guide.md:115-118` — reconciled with reality
  (real harness + explicit fallback; remove the "as if it exists" framing).
- **Architecture (light touch, no AD):** `ARCHITECTURE-SPINE.md:308` /
  `TECHNICAL-DESIGN.md` test-framework rows note the harness pattern (fake-OAuth injected
  session, guarded non-prod) is implemented in Story 4.5; Playwright stays a convention.
- **UI/UX:** no design change.

### Technical Impact
- **New:** `packages/web/playwright.config.ts`; `packages/web/tests/` (e2e specs + fixtures);
  `@playwright/test` devDependency; `test:e2e` script in `packages/web` (+ root wiring).
- **Session bootstrap (recommended):** the harness boots its own `createApp` instance with an
  **injected fake `DiscordOAuthClient`** (the existing `opts.oauth` pattern from
  `*.integration.test.ts`) + a deterministic fake `queryEmbedder`, over a test
  Postgres+pgvector/Redis seeded with `channel_permissions` + `embeddings`, and drives
  `/api/auth/login` → fake callback to obtain the session cookie. **This avoids adding any
  production auth-bypass HTTP route** — the safer path. A test-only login route guarded to
  non-prod is a fallback only if acquiring the cookie from a separate app instance proves
  awkward.
- **Token-name gotcha:** assertions must use the **real** token names
  (`--text-primary` / `--text-muted` / `--text-subtle`), renamed in Story 2.1 from the
  mockup's `--tx` / `--tx4` / `--tx5` (same values).
- **Invariants touched:** none broken. The fake-OAuth session bootstrap respects AD-9/AD-10
  (sessions in Redis; no `sessions` table) and stays guarded to non-prod.

## 3. Recommended Approach

**Option 1 — Direct Adjustment (Hybrid):** one new Story 4.5 (harness) + process-doc
amendments + explicit-fallback definition + light architecture note.

- **Effort:** Medium. **Risk:** Low.
- **Rationale:** the harness is additive test-enablement; the session-bootstrap reuses the
  proven `opts.oauth` injection from the integration tests (no new prod surface); placing it
  at 4.5 avoids renumbering and lets it consolidate the whole Epic 4 UI surface in one spec
  before Epic 5. The explicit fallback unblocks 4.4 immediately without a silent gate
  violation.
- **Rejected:** Rollback of 4.3 (unnecessary — verified retroactively by 4.5); MVP review
  (MVP unchanged — this adds verification capability, cuts nothing).

## 4. Detailed Change Proposals

### 4.1 New Story 4.5 (epics.md, appended after Historia 4.4, before `## Épico 5`)
**Historia 4.5: Web App — Harness de verificación visual E2E (Playwright)** — full AC set:
1. `@playwright/test` added; `playwright.config.ts` in `packages/web`; real `test:e2e`
   script (+ root wiring).
2. Harness boots `createApp` with an injected fake `DiscordOAuthClient` (`opts.oauth`) +
   deterministic fake `queryEmbedder`, over test Postgres+pgvector/Redis seeded with
   `channel_permissions` + `embeddings` so `/api/search` returns fixed results.
3. Authenticated session bootstrap without real Discord (fake-OAuth callback → session
   cookie); **no production auth-bypass route** (test-only guarded route only as fallback).
4. Vite preview points at the test backend.
5. **Initial spec covers Story 4.3 + 4.4 ACs retroactively** via `getComputedStyle`:
   - **4.3 (Búsqueda):** AC1 title (Space Grotesk 600 / 25px) + 54px search bar; AC2 focus
     `border-color: var(--accent-ink)` + `box-shadow: 0 0 0 3px rgba(245,166,35,0.12)`; AC4
     result-card tokens (amber badge, similarity-bar gradient, avatar); AC5 active/inactive
     chip styles; AC6 dashed empty state.
   - **4.4 (Documentos):** table grid `1fr 130px 130px 96px`; unread dot amber + glow
     `0 0 0 3px rgba(245,166,35,0.16)` vs read `var(--dot-read)`; row hover
     `var(--hover-row)`; sidebar badge; "todo leído" empty state.
   - Use the **real token names** (`--text-primary/-muted/-subtle`).
6. Screenshots captured as CI artifacts.
7. Harness documented/reusable so 5.3/5.4 add their own specs.

**Dependencies:** blocks 5.3, 5.4.

### 4.2 sprint-status.yaml
- Add `4-5-web-app-e2e-visual-verification-harness: backlog` (blocks 5-3/5-4).
- Keep `4-4-...` unchanged (no renumber).
- Fix the stale comment: Playwright **not** installed; formalized as Story 4.5; retroactive
  4.3 + 4.4 coverage. Add the correct-course audit line.

### 4.3 docs/bmad-story-mandatory-steps.md §3.4 + §4
Rewrite §3.4 to define this repo's concrete E2E verification (Playwright harness + fake-OAuth
injected session + `getComputedStyle` + screenshots, via `npm run test:e2e -w @share2brain/web`)
**and the explicit fallback** when no browser is available in the agent environment:
(a) run the backend slice smoke the agent can; (b) **explicitly flag** the unverified visual
ACs in the story notes + PR; (c) those ACs are covered by the harness — **never mark a visual
AC "satisfied" without the harness run or a documented manual check** (no silent pass).
Update the §4 checklist item ("E2E run if UI is affected").

### 4.4 docs/frontend-standards.md (§Testing Standards, §Scripts)
Align the E2E section to the real harness: fake-OAuth session bootstrap, `getComputedStyle`
pattern for visual/token ACs, and the now-real `test:e2e` script with its prerequisites.

### 4.5 docs/development_guide.md (E2E section)
Document `npm run test:e2e` as real + its prerequisites (test Postgres+Redis, fake-OAuth
session), landing with Story 4.5.

### 4.6 Architecture (light touch — no AD)
`ARCHITECTURE-SPINE.md:308` (and the matching TECHNICAL-DESIGN test-framework row): note the
E2E harness pattern (fake-OAuth injected session, guarded non-prod) is implemented in Story
4.5; Playwright remains a convention, not an invariant.

## 5. Implementation Handoff

**Scope classification: Moderate** (new story + backlog reorg + source-of-truth process-doc
updates).

| Recipient | Responsibility |
|---|---|
| **Developer (Amelia)** | Apply doc/backlog edits (§4.2–4.6), then author Story 4.5 via `bmad-create-story` → `bmad-dev-story` |
| **Architect (advisory)** | Sanity-check the process-gate rewrite (§4.3) and the fake-OAuth session-bootstrap approach (AD-9/AD-10 boundary, non-prod guard) |

**Sequencing:** apply proposal edits → continue with Story 4.4 (docs view, under the fallback
flag) → then create & implement Story 4.5 (harness) which retroactively verifies 4.3 + 4.4 →
then Epic 5. Story 4.5 is a **hard dependency** of 5.3/5.4.

**Success criteria:**
- `npm run test:e2e -w @share2brain/web` runs Playwright against an authenticated SPA using an
  injected fake-OAuth session (no real Discord, no prod auth-bypass route).
- The initial spec asserts the 4.3 + 4.4 visual/CSS ACs via `getComputedStyle` and captures
  screenshots as artifacts.
- `bmad-story-mandatory-steps.md` §3.4 defines the real verification path **and** the explicit
  fallback; `frontend-standards.md` / `development_guide.md` no longer reference a
  non-existent command.
- sprint-status reflects Story 4.5 (backlog, blocks 5-3/5-4) with the corrected comment.

## 6. Notes
- Playwright stays a **convention**, not an AD invariant (stakeholder decision) — the spine's
  "asumido" framing is preserved, only annotated with the implementing story.
- 4.4 shipping with visual ACs verified retroactively is an **accepted, documented** tradeoff,
  covered by the explicit fallback in §3.4 — not a silent gate violation.
