# Sprint Change Proposal — "Top 5 usuarios más activos" (Épico 9)

**Date:** 2026-07-10
**Author:** Borja (via bmad-correct-course)
**Classification:** Moderate (backlog reorganization — 2 new stories + scope extension of 2 planned stories)
**Mode:** Incremental

---

## Section 1 — Issue Summary

**Problem statement.** The Statistics design (`Share2Brain Web.dc.html`, `isStats`) includes a 5th
section, **"Top 5 · usuarios más activos"**, that was deliberately left OUT of the ratified
`StatsResponse` contract in Story 9.1 (decision **D9** — the ratified SCP §4.2 shape has exactly
`kpis / activity / channels / coverage`).

**Discovery.** During the `bmad-code-review` of Story 9.1 (2026-07-10), the exclusion was surfaced
for veto. Borja chose to **promote the section to its own story** rather than widen 9.1's ratified
scope mid-review. The review also surfaced a hard **data gap**: `discord_messages` stores only
`author_id` (a Discord snowflake) — there is **no author display name**; `users.username` resolves
only for the subset of authors who logged into the web app via OAuth.

**Evidence.**
- `_bmad-output/implementation-artifacts/9-1-...-rbac-scoped.md` → *Review Findings* §decision-needed
  (D9 resolved: "promote to its own story via `bmad-correct-course`").
- `packages/shared/src/db/schema.ts:45` — `discord_messages.author_id` is the only author field.
- `packages/shared/src/db/schema.ts` `users` — `username` exists but only for OAuth users.

---

## Section 2 — Impact Analysis

**Epic impact.** Épico 9 (Estadísticas) is **extended**, not redefined. Story 9.1 (`done`, PR #54)
is unaffected. Stories 9.2 (web) and 9.3 (e2e) are still `backlog`, so they absorb the new scope
with zero rework. Épicos 1–8 unaffected.

**Artifact conflicts.**
- **PRD** — FR24 already frames the Statistics view generically; "top contributors" is a sub-section
  of that same view (RBAC-scoped per FR25). **No new FR number** (avoids inflation, D10 discipline);
  a one-line mention suffices.
- **Architecture / ADs** — AD-12 applies unchanged (aggregation scoped in-SQL). **AD-5 is touched:**
  a new nullable column `discord_messages.author_name` (DDL in `schema.ts`) + generated migration.
  AD-6 contract extension: new `topUsers` block in `StatsResponse`.
- **UX** — new "Top 5 usuarios" section in `StatsView` (Story 9.2).
- **Other artifacts** — the **Bot (Épico 6 ingestion)** must write `author_name` on message create
  AND edit. Existing rows: **nullable column + `COALESCE(author_name, users.username, author_id)`
  fallback** (no active backfill — new messages carry the real name, old ones degrade gracefully and
  converge over time).

**Technical impact.** shared (schema + migration + contract + tests), bot (ingestion write path),
backend (new RBAC-scoped `topUsers` query + service + integration test), web (render), e2e (coverage).

---

## Section 3 — Recommended Approach

**Direct Adjustment (Hybrid).** Add two small, layered stories to Épico 9 and extend the two
planned stories — no rollback, no MVP reduction.

- **Effort:** Medium · **Risk:** Low · **Timeline:** additive to Épico 9 (post-roadmap).

Rationale: keeps the epic's inner→outer layering discipline; the data-plumbing (bot capture) is a
distinct concern from the aggregation (topUsers), so splitting keeps each story independently
testable and each review focused. The COALESCE fallback avoids a backfill job (Discord API rate
limits, departed-author handling) while still delivering real names for all newly-ingested messages.

---

## Section 4 — Detailed Change Proposals

### 4.1 — NEW Historia 9.4 · bot + shared (author-name capture)

> **Historia 9.4 · bot + shared:** capturar el nombre visible del autor en la ingesta. Nueva
> columna nullable `discord_messages.author_name` (DDL en `schema.ts`, AD-5) + migración generada;
> el Bot la escribe en los handlers de `create` y `edit` (Épico 6), tomándola del `author`
> del mensaje de Discord (username/displayName). Sin backfill: filas antiguas quedan `NULL` y se
> resuelven vía `COALESCE(author_name, users.username, author_id)` aguas abajo. Tests: unit del
> parseo/escritura en el Bot; el gate de migración habitual.

### 4.2 — NEW Historia 9.5 · shared + backend (bloque topUsers)

> **Historia 9.5 · shared + backend:** extender el contrato `StatsResponse` con el bloque
> `topUsers` (AD-6) y servirlo desde `GET /api/stats`. Shape `{ authorId, authorName, count }`,
> orden `count DESC, authorId ASC`, **límite 5**. Query RBAC-scoped (AD-12, in-SQL): Top 5
> `author_id` por count de embeddings no borrados y con scope (`allowedChannelIds` + el filtro D4
> de mensaje borrado) cuyo autor-ancla (`message_ids[1]`) sea ese `author_id`; `authorName =
> COALESCE(dm.author_name, u.username, e.channel_id?...)` → `COALESCE(dm.author_name, u.username,
> dm.author_id)`. Test de integración que prueba que el canal denegado **no** aparece en `topUsers`
> (mismo patrón de exclusión que 9.1) + docs (`api-spec.yml`). Depende de 9.4.

### 4.3 — EDIT Historia 9.2 (web) — add Top 5 render

```
OLD:
- **Historia 9.2 · web:** `StatsView` + 3ª entrada de nav "Estadísticas" (mismo patrón AppLayout
  que Búsqueda/Documentos, UX-DR5); KPI cards, bar-chart de actividad, barras por canal y donut de
  cobertura; tipos vía `z.infer<StatsResponse>`; sin dependencia de gráficos (flex/grid + gradientes CSS).

NEW:
- **Historia 9.2 · web:** `StatsView` + 3ª entrada de nav "Estadísticas" (mismo patrón AppLayout
  que Búsqueda/Documentos, UX-DR5); KPI cards, bar-chart de actividad, barras por canal, donut de
  cobertura y la sección **Top 5 usuarios más activos** (lista `topUsers` — nombre + count, del
  contrato 9.5); tipos vía `z.infer<StatsResponse>`; sin dependencia de gráficos (flex/grid +
  gradientes CSS). El render de Top 5 depende de que 9.5 haya aterrizado.
```

### 4.4 — EDIT Historia 9.3 (e2e) — add Top 5 coverage

```
OLD:
- **Historia 9.3 · e2e:** extender el harness visual Playwright (patrón Epic 4/7) a la vista de
  estadísticas con seed determinista y RBAC-consistente.

NEW:
- **Historia 9.3 · e2e:** extender el harness visual Playwright (patrón Epic 4/7) a la vista de
  estadísticas con seed determinista y RBAC-consistente, **incluyendo la sección Top 5 usuarios**
  (seed de autores con `author_name` y assert de orden/exclusión de canal denegado).
```

### 4.5 — EDIT Épico 9 ratified-KPIs note — record the Top 5 section

Append to the "KPIs (ratificado 2026-07-10)" blockquote:

> **Top 5 usuarios (añadido 2026-07-10, `sprint-change-proposal-2026-07-10-topusers.md`):** la 5ª
> sección del mock se incorpora al contrato como bloque `topUsers` (RBAC-scoped, AD-12) vía las
> historias 9.4 (captura de `author_name` en el Bot) + 9.5 (contrato + endpoint). No añade FR nuevo
> — es parte de la vista de Estadísticas (FR24) y respeta FR25.

### 4.6 — EDIT PRD — one-line mention

Add "top contribuidores" to the Statistics-view feature mention (no FR numbering, per D10).

---

## Section 5 — Implementation Handoff

**Scope classification: Moderate** — backlog reorganization (2 new stories + 2 scope extensions).

- **Route to:** Product Owner / Developer.
- **Sequencing (binding):** 9.4 → 9.5 → (9.2 render, 9.3 e2e). 9.4 must land before 9.5; 9.5 before
  9.2 renders `topUsers`.
- **Deliverables:** this proposal + `epics.md` edits + `sprint-status.yaml` entries for 9-4 / 9-5.
- **Success criteria:** `GET /api/stats` returns a `topUsers` array (≤5, RBAC-scoped, real names for
  newly-ingested messages) validated by `StatsResponseSchema`; an integration test proves the denied
  channel never appears in `topUsers`; the Statistics view renders the section.

**Next step:** `bmad-create-story 9.4` (then 9.5) when Épico 9 implementation resumes.
