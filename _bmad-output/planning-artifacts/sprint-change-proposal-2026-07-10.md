# Sprint Change Proposal — 2026-07-10

**Project:** share2brain · **Author:** Borja · **Workflow:** `bmad-correct-course` · **Mode:** Incremental
**Classification:** Moderate (frontend-only; adds a story + updates unit/e2e harness)

---

## Section 1 — Issue Summary

**Problem statement.** In the current `DocsView`, already-read rows *read as "disabled"*: a
grey `--dot-read` indicator plus a title dimmed to `--text-muted` at `font-weight:400`, with the
description permanently muted. The visual language differentiates read vs. unread by *dimming the
read row* instead of *emphasising the unread one*, which makes consumed knowledge look broken/
inactive rather than simply "done".

**How discovered.** Design review after Story 7.5 (`web: DocsView render of title/description/link
+ UX`). Borja updated the reference design `docs/context/design/Share2Brain Web.dc.html` to a new
treatment and flagged the "disabled feeling" of read rows.

**Evidence.**
- Implemented read-state styling: `packages/web/src/components/DocsView.tsx:431-443`
  (grey dot + `--text-muted` title at weight 400).
- Updated design `docs/context/design/Share2Brain Web.dc.html`: read → checkmark; unread → amber dot +
  glow + "Nuevo" badge + row accent; título/descripción/link split into separate columns.

---

## Section 2 — Impact Analysis

### Epic Impact
- **Epic 7** (Índice Curado de Recursos con IA) is **closed** (retro 2026-07-09, roadmap complete).
  No open story absorbs this → a new story is required.
- No other epic affected. No resequencing. No epic obsoleted.
- **Decision:** home the work in a **new Epic 8 (UX Polish)**, Story **8.1**.

### Artifact Conflicts
| Artifact | Conflict | Detail |
|---|---|---|
| PRD | None | Resource model (title/description/link) unchanged; purely visual. |
| Architecture (AD-1…AD-13) | None | Frontend-only. No schema, no Zod contract, no RBAC. SPA static (AD-3) preserved. |
| data-model / api-spec | None | `title/description/link` exist since Story 7.1. |
| UX / design | Updated (source) | `Share2Brain Web.dc.html` already carries the new treatment. |

### Technical Impact (frontend-only)
- `packages/web/src/components/DocsView.tsx` — `DocRow`: 4→6 column grid; header
  `recurso`→`título/descripción/link`; read dot → checkmark; unread dot+glow + "Nuevo" badge +
  row accent (`box-shadow`); remove the "disabled"-style dimming of the read title.
- `packages/web/src/components/DocsView.test.tsx` — read-title color assertion changes; add
  checkmark/badge assertions.
- `packages/web/tests/docs.spec.ts` (7.6 visual harness) — header labels, `doc-row-dot` on read
  rows becomes a checkmark, grid columns, description line-clamp column.
- `packages/web/src/**/components.css` — new `.kh-doc-row` accent; `--dot-read` may become unused.

---

## Section 3 — Recommended Approach

**Direct Adjustment** — add one cohesive story (8.1) under a new **Epic 8 (UX Polish)**.
- **Effort:** small–moderate (single view + its unit and e2e coverage).
- **Risk:** low — no backend/contract surface; main risk is e2e harness assertions, mitigated by
  updating `docs.spec.ts` alongside the component.
- **Timeline:** one story, one PR.

**Layout decision (Borja):** adopt the full **6-column** layout from the design
(título · descripción · link · canal · autor · indexado; `min-width:720px`, horizontal scroll on
narrow viewports).

---

## Section 4 — Detailed Change Proposals

### 4.1 `epics.md` — append Epic 8
Add a new `## Épico 8: UX Polish` section (frontend-only goal, cross-refs this proposal) containing
Story 8.1 scope.

### 4.2 Story 8.1 — Acceptance Criteria (Gherkin)
- **AC1 — 6-column layout:** columns are título · descripción · link · canal · autor · indexado;
  row `min-width:720px` with horizontal scroll on narrow viewports.
- **AC2 — Unread = emphasis:** amber dot (8px) + glow, "Nuevo" badge under the title, and a row
  accent (left-edge `box-shadow`).
- **AC3 — Read = "done", not "disabled":** indicator is a checkmark ✓ (`--text-subtle`/`--tx5`),
  not a grey dot; title stays legible (no dim-to-`--text-muted`).
- **AC4 — Link icon-button with bubbling preserved:** external-link icon-button opens the resource
  in a new tab; clicking it on an unread row still marks the row read (Story 7.5 D-behavior).
- **AC5 — Theme parity + no functional regression:** correct in light and dark; channel filter,
  "Sin leer", "Marcar todas", and pagination unaffected.
- **AC6 — Tests green:** `DocsView.test.tsx` and the `docs.spec.ts` visual harness updated to the
  new treatment and passing.

### 4.3 Code change summary (handoff — implemented by `bmad-dev-story`)
See Section 2 "Technical Impact".

---

## Section 5 — Implementation Handoff

- **Scope:** **Moderate** — backlog addition (new Epic 8 + Story 8.1) then direct implementation.
- **Recipients:**
  1. Update `epics.md` with Epic 8 / Story 8.1 (this proposal).
  2. `bmad-create-story` → author Story 8.1 file with the ACs above.
  3. `bmad-dev-story` → implement (branch `feat/8-1-docsview-read-unread-redesign`), then
     `bmad-code-review` → `bmad-checkpoint-preview`.
- **Success criteria:** read rows no longer read as disabled; unread rows carry dot+glow+"Nuevo"
  badge+accent; 6-column layout matches `Share2Brain Web.dc.html`; lint+test+build green with updated
  unit and e2e assertions.
