# Sprint Change Proposal — UI Internationalization (i18n)

- **Date:** 2026-07-12
- **Project:** share2brain
- **Workflow:** bmad-correct-course (mode: Incremental)
- **Author:** Developer agent, with Borja
- **Status:** Approved proposals P1–P6 (incremental review); pending final sign-off

---

## 1. Issue Summary

**Problem statement.** The web SPA hardcodes every user-facing string in Spanish (~31 literals across 9 components: `LoginScreen`, `Sidebar`, `Header`, `ChatWidget`, `DocsView`, `SearchView`, `StatsView`, `AppLayout`, `icons`), and `StatsView` pins `toLocaleString('es')`. There is no mechanism to deploy the application in another language.

**Trigger.** Stakeholder (Borja) request, post-roadmap (Epics 1–9 done, story 2.5 done). Not triggered by any story. Original ask: i18n with static JSON translation resources and the language selectable via `.env`.

**Evidence.**
- `grep` over `packages/web/src/**/*.tsx` surfaces literals such as `"Cerrar sesión"`, `"Historial de conversaciones"`, `"Modo invitado"`, `"Sin leer"`, `"Cargar más"`.
- `docs/context/PRD.md:138` explicitly excludes internationalization from scope; line 1497 lists it under the "Posterior" roadmap phase.
- Playwright e2e specs and many unit tests assert those Spanish literals verbatim (e.g. `chat.spec.ts:141` `'Historial de conversaciones'`, `analytics.spec.ts:34` `'Estadísticas'`).

**Ratified decisions (Borja, 2026-07-12).**
1. **Language source:** `Share2Brain.config.yml` (`ui.language`), **not** `.env` — preserves the project's secrets-vs-behavior rule (AD-8). The original `.env` ask is superseded.
2. **Scope:** full web UI — SPA literals + date/number formatting + client-side mapping of backend error codes to translated messages. Backend responses (`{ error, code }`) unchanged.
3. **Initial languages:** `es` + `en`.
4. **Mechanism:** `react-i18next` with static JSON resources.

---

## 2. Impact Analysis

### Epic impact
- No in-flight epic is affected (Epics 1–9 done). This is purely additive work → **new Epic 10: UI Internationalization (i18n)**, following the post-roadmap addition precedent (guest access → 2.5; stats → Epic 9).
- Introduces a **forward rule**: every future web story must use i18n keys, never hardcoded user-facing literals (codified in `frontend-standards.md`).
- Housekeeping: `epic-2` is still `in-progress` in `sprint-status.yaml` although 2.5 converged done → flip to `done`.

### Story impact
- Two new stories (layered pair, inner-first, precedent 9-4/9-5):
  - **10.1** shared+backend — `ui.language` config block + `GET /api/ui-config`.
  - **10.2** web — react-i18next, literal extraction to `es.json`/`en.json`, locale-aware formatting, error-code mapping.
- No existing story requires re-work.

### Artifact conflicts
| Artifact | Conflict | Resolution |
|---|---|---|
| `docs/context/PRD.md` | i18n explicitly out of scope (§2.3, §16) | Narrow the non-goal to content i18n; promote UI i18n (P2) |
| `docs/context/TECHNICAL-DESIGN.md` | No `ui` config block, no endpoint | Add `ui.language`, `GET /api/ui-config`, §5.5 web design (P3) |
| `docs/api-spec.yml` | Endpoint missing | Add path + `UiConfigResponse` schema (P4) |
| `docs/frontend-standards.md` | No i18n rule | New "Internationalization (i18n)" standard (P5) |
| `_bmad-output/planning-artifacts/epics.md` | No FR / epic | FR26 + Epic 10 with stories 10.1/10.2 (P1) |
| `sprint-status.yaml` | No entries | epic-10 backlog + epic-2 → done (P6) |
| `docs/data-model.md` | — | Untouched (no DDL) |
| UX artifacts (UX-DRs in epics.md) | — | Untouched (no visual change; default stays `es`) |

### Technical impact
- **No architecture invariant breaks.** AD-3 intact (SPA stays static; language arrives via API at runtime — no image rebuild). AD-6 (Zod contract `UiConfigResponse` in `packages/shared/src/schemas/`). AD-8 (config validated at boot). No DDL (AD-5 untouched). No new AD needed.
- **Main risk — test suite coupling to Spanish literals:** 28 e2e tests + unit tests assert Spanish texts. Mitigation baked into the design: default language when the `ui` block is absent is `es`, and resources are bundled + initialized synchronously → unit tests and the e2e environment (which runs without a `ui` block) remain **byte-identical**. Story 10.2 carries this as an explicit AC.
- Two new runtime dependencies in `packages/web`: `i18next`, `react-i18next`.
- New unauthenticated endpoint: read-only, no sensitive data, general rate-limit tier (lesson from the `/api/auth/me` 429 incident — not the auth tier).

---

## 3. Recommended Approach

**Selected path: Option 1 — Direct Adjustment** (add a new epic + 2 stories within the existing plan).

- Option 2 (Rollback): N/A — nothing to revert; the change is additive.
- Option 3 (MVP Review): not needed — the MVP is delivered; only the PRD scope note is amended.

**Rationale.** Purely additive work on a closed roadmap; zero invariant changes; the layered split (shared+backend → web) mirrors the ratified 9-4/9-5 precedent; the default-`es` guard keeps the entire verification harness green without touching a single existing assertion.

- **Effort:** Medium-low (10.1 small; 10.2 is the bulk: ~31 keys × 2 languages, 9 components, tests).
- **Risk:** Low (main risk mitigated by default-`es` + synchronous init).
- **Timeline impact:** none on committed work; sequences after current operational-hardening backlog at Borja's discretion.

---

## 4. Detailed Change Proposals (all approved incrementally)

### P1 — `_bmad-output/planning-artifacts/epics.md` (APPROVED)

**Add to the FR inventory:**

> FR26: La UI web carga sus textos desde recursos JSON de traducción (i18n). El idioma se define por despliegue en `Share2Brain.config.yml` (`ui.language`, default `es`); la SPA lo resuelve en runtime vía `GET /api/ui-config` (sin auth). Cubre literales, formato de fechas/números y mapeo de códigos de error a mensajes traducidos en el cliente. Idiomas iniciales: es, en.

**Add new epic after Épico 9 (and to the "Lista de Épicos" summary):**

> ## Épico 10: Internacionalización de la UI (i18n)
> El Operador puede fijar el idioma de la aplicación web (es/en) en `Share2Brain.config.yml` sin reconstruir imágenes. Toda la UI (literales, fechas/números, mensajes de error) se renderiza en el idioma configurado desde recursos JSON estáticos vía react-i18next.
> **FRs cubiertos:** FR26 (nuevo)
>
> ### Historia 10.1: shared+backend — config `ui.language` y endpoint `/api/ui-config`
> - Bloque opcional `ui:` en el schema Zod de config (`language: 'es' | 'en'`; bloque ausente ⇒ default `es` resuelto en backend — precedente D4 de 2.5)
> - `UiConfigResponse` en `packages/shared/src/schemas/`
> - `GET /api/ui-config` sin auth (tier de rate-limit general, no el de auth)
> - `Share2Brain.config.example.yml` + docs sync
>
> ### Historia 10.2: web — react-i18next, extracción de literales y locales JSON
> - deps: `i18next` + `react-i18next`; recursos `es.json`/`en.json` empaquetados (import estático, init síncrono — sin estado de carga)
> - Extracción de los ~31 literales de los 9 componentes a claves i18n
> - `toLocaleString('es')` fijo → locale del idioma activo
> - Mapeo código de error del backend → mensaje traducido en cliente (`errors.<CODE>`), con el `error` crudo como fallback
> - Guardia: default `es` ⇒ los 28 e2e y los tests unitarios NO cambian sus asserts (AC explícito)

**Rationale:** post-roadmap addition per Epic 9 precedent; layered inner-first pair like 9-4→9-5. No DDL, no new AD.

### P2 — `docs/context/PRD.md` (APPROVED)

**§2.3 No-objetivos (line 138):**

OLD:
> - No incluye internacionalización

NEW:
> - La internacionalización cubre solo la UI web (idioma por despliegue vía `ui.language`, es/en); no incluye traducir el contenido indexado ni las respuestas del agente (el idioma del contenido generado por IA se gobierna aparte con `enrichment.language`)

**§16 Hoja de ruta (line 1497):**

OLD:
> | **Posterior** | MCP tools, OCR de imágenes, modelos locales vía Ollama, internacionalización, multi-tenant |

NEW:
> | **Posterior** | MCP tools, OCR de imágenes, modelos locales vía Ollama, internacionalización completa (más idiomas, contenido), multi-tenant |

Plus a note in the row reflecting current post-MVP scope: "i18n de la UI (es/en) vía react-i18next — Épico 10".

**Rationale:** the SCP promotes UI i18n into scope; the PRD must stop excluding it while keeping content i18n / more languages as "Posterior".

### P3 — `docs/context/TECHNICAL-DESIGN.md` (APPROVED)

**§13 config example (~line 977, next to `enrichment`):**

```yaml
# Idioma de la UI web (Épico 10). Bloque opcional; si falta ⇒ "es".
# Gobierna SOLO la SPA (literales, formato de fechas/números, mensajes de
# error en cliente). El idioma del contenido generado por IA sigue siendo
# enrichment.language.
ui:
  language: "es"           # es | en
```

**§11 API REST (endpoints table):**

> `GET /api/ui-config` — no auth — `UiConfigResponse` — UI config for the SPA (today: `{ language }`). Unauthenticated: the login screen needs the language before any session. General rate-limit tier (lesson from the `/api/auth/me` 429).

**§5.5 packages/web (new paragraph):**

> i18n via react-i18next: `es.json`/`en.json` resources bundled (static import, synchronous init — no loading state, no FOUC). On boot the SPA calls `GET /api/ui-config` and sets the language; on failure it degrades to `es`. Backend error codes (`{ error, code }`) map to translated client messages; the raw `error` string remains only as fallback for unknown codes.

**Rationale:** AD-6 (Zod contract in shared), AD-8 (config validated at boot), AD-3 intact (SPA still static; runtime language, no rebuild).

### P4 — `docs/api-spec.yml` (APPROVED)

New path:

```yaml
/api/ui-config:
  get:
    tags: [config]
    summary: UI configuration for the SPA (language)
    description: >
      Unauthenticated: the login screen already needs the language before any
      session exists. Returns the deployment's UI language resolved from
      Share2Brain.config.yml (`ui.language`, default "es" when the block is
      absent). The SPA falls back to "es" if this call fails.
    security: []
    responses:
      "200":
        description: UI configuration
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UiConfigResponse'
```

New schema under `components.schemas`:

```yaml
UiConfigResponse:
  type: object
  required: [language]
  properties:
    language:
      type: string
      enum: [es, en]
      example: es
```

**Rationale:** AD-6 — OpenAPI mirrors the shared Zod `UiConfigResponse`. Read-only, no sensitive data (unlike the guest probe, no existence signal to hide).

### P5 — `docs/frontend-standards.md` (APPROVED)

New subsection under Coding Standards (plus a pointer line in UI/UX Standards):

> ### Internationalization (i18n)
> - Every user-facing string in `packages/web` MUST go through react-i18next (`t('key')` / `<Trans>`). Hardcoded user-facing literals in `.tsx` are forbidden from Epic 10 onward.
> - Translation resources live as static JSON per language (`packages/web/src/locales/es.json`, `en.json`), statically imported and registered at i18n init (synchronous — no loading state).
> - Key naming: camelCase namespaced by view/component (e.g. `chat.historyTitle`, `docs.unreadToggle`, `common.close`).
> - The active language comes from `GET /api/ui-config` at boot; fall back to `es` on failure. Never read the language from `import.meta.env`.
> - Dates/numbers: use `toLocaleString(i18n.language)` — never a hardcoded locale literal.
> - Backend error codes (`{ error, code }`) map to translated messages in the client (`errors.<CODE>` keys); the raw `error` string is only the fallback for unknown codes.
> - Tests: unit tests render with the real `es` resources (default), so existing text assertions stay valid; e2e runs with the `ui` block absent (⇒ `es`) and its Spanish-literal assertions remain byte-identical.

Note: the project's "English only in code" rule stays intact — keys and code in English; translated values live only in the JSON resources.

**Rationale:** makes the Epic 10 pattern a permanent rule so no future web story reintroduces hardcoded literals.

### P6 — `_bmad-output/implementation-artifacts/sprint-status.yaml` (APPROVED)

Add after the Epic 9 block:

```yaml
# ── Épico 10: Internacionalización de la UI (i18n) ──────────────────────────
# Added 2026-07-12 via bmad-correct-course (sprint-change-proposal-2026-07-12-i18n.md):
# UI language via Share2Brain.config.yml (ui.language, default es), runtime
# GET /api/ui-config (no auth), react-i18next + static es/en JSON resources.
# New FR26. Layered pair (shared+backend → web), precedent 9-4/9-5.
epic-10: backlog
10-1-shared-backend-config-ui-language-endpoint-ui-config: backlog
10-2-web-react-i18next-extraccion-literales-locales-json: backlog
epic-10-retrospective: optional
```

Housekeeping (checklist §2.1 finding): `epic-2: in-progress` → `epic-2: done` (story 2.5 converged done on re-review #4; the epic was left open).

---

## 5. Implementation Handoff

**Scope classification: Moderate** — backlog reorganization (new epic + 2 stories + 6 artifact updates), no fundamental replan, no invariant change.

| Role | Responsibility |
|---|---|
| **PO/Dev (this handoff)** | Apply P1–P6 artifact edits exactly as approved (docs-first, before any code). |
| **Developer agent** | `bmad-create-story 10-1` → `bmad-dev-story 10-1` → review; then 10.2. One story at a time, inner-first. |
| **Borja** | Decides sequencing vs the operational-hardening backlog (`operational-backlog.md` remains the active production plan). |

**Sequencing:** P1–P6 doc edits → story 10.1 (shared+backend) → story 10.2 (web). 10.2 depends on 10.1's contract.

**Success criteria:**
1. `ui.language: en` in `Share2Brain.config.yml` + restart renders the full UI in English; removing the block renders Spanish — no image rebuild in either case.
2. With the `ui` block absent, the full verification gate stays green **without modifying any existing assertion**: `npm run lint && npm run test && npm run build` + 28 e2e.
3. No hardcoded user-facing literal remains in `packages/web/src/**/*.tsx` (grep-verifiable).
4. `GET /api/ui-config` responds per the OpenAPI contract, unauthenticated, general rate-limit tier.

**Out of scope (explicitly):** per-user language selector in the UI; localizing backend response bodies; translating indexed content or agent answers (`enrichment.language` governs AI-generated content, unchanged); languages beyond es/en.
