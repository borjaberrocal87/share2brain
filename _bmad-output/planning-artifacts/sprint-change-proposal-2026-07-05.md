---
type: sprint-change-proposal
date: 2026-07-05
author: Amelia (Dev) — bmad-correct-course
project: share2brain
status: approved
scope_classification: moderate
mode: incremental
---

# Sprint Change Proposal — Configurable LLM & Embeddings Providers

## 1. Issue Summary

**Trigger type:** New requirement emerged from stakeholder (scope expansion — not a failed story).

The operator must be able to select the agent provider **independently for LLM and for
embeddings**:

- **LLM:** `anthropic | openai | custom` (OpenAI-compatible, url + key).
- **Embeddings:** `openai | custom` (OpenAI-compatible, url + key).

**Hard constraint (confirmed via the `claude-api` skill):** Anthropic offers **no embeddings
API**, so "Anthropic for embeddings" is not a real option — the embeddings selector is
`openai | custom` only, while the LLM selector keeps all three.

**Discovery context:** Raised before Epic 3 (Knowledge Indexing) started. Current state:

- `packages/shared/src/config/index.ts:46` — `agent.provider: z.string()` (single provider);
  `knowledge.embedding_model: z.string()` only, no provider/base_url/key selection.
- Embeddings hardcoded to `text-embedding-3-small` / 1536 dims across schema, migration,
  docs, and the AC of Stories 3.3 / 4.1 / 5.1.
- **Epics 1–2 are `done`; Epics 3–6 are `backlog` → zero embeddings persisted yet**, so an
  embedding-dimension change carries no migration/reindex cost right now.

**Decisions locked with the stakeholder:**

1. Embeddings selector = `openai | custom` (no Anthropic).
2. Embedding **dimension is configurable** (`embeddings.dimensions`) — this touches AD-5.
3. Config split preserved: `dimensions`, `provider`, `model`, `base_url` are **behavior →
   `Share2Brain.config.yml`**; only API keys are **secrets → `.env`**. The operator edits both
   files (two-file model is a core invariant; not collapsed into `.env`).

## 2. Impact Analysis

### Epic Impact
- **Epic 1 (done):** its config contract (Story 1.2) evolves forward — cannot be "re-completed";
  the change is carried by a new story in Epic 3 rather than reopening Epic 1.
- **Epic 3 (backlog):** gains **new Story 3.0** (contract + provider-factory + dimension guard),
  which blocks Story 3.3. Story 3.3 AC amended.
- **Epic 4 (backlog):** Story 4.1 AC amended (query embedding via factory).
- **Epic 5 (backlog):** Story 5.1 AC amended (LLM via factory).
- No epic obsolete; **no new epic**; one new story (3.0). Sequencing: 3.0 precedes 3.3.

### Story Impact
| Story | Change |
|---|---|
| **3.0 (new)** | Zod contract (`agent` + `embeddings` blocks), provider-factory in `shared`, dimension guard, config/example/env updates |
| 3.3 | Indexer uses factory + dimension guard instead of hardcoded `text-embedding-3-small`/1536 |
| 4.1 | Search query embedding via factory |
| 5.1 | RAG StateGraph instantiates LLM via factory (provider/model/base_url/api_key) |

### Artifact Conflicts
- **PRD** (`docs/context/PRD.md`): FR5, PO-5 (resolved), AS-2/AS-4, SO-7/SD-18/§13, config
  examples, prerequisites.
- **Architecture** (`docs/context/TECHNICAL-DESIGN.md`): config block, tech table, deferred
  table (un-defer provider abstraction), embeddings sequence diagram.
  `ARCHITECTURE-SPINE.md:311` + AD-5 note (dimension parametrized).
- **Data model** (`docs/data-model.md`) + `backend-standards.md:79`: dimension configurable.
- **UI/UX:** no impact (backend/config only).

### Technical Impact
- `packages/shared/src/config/index.ts` (+ `index.test.ts`) — enum + `embeddings` block +
  `superRefine`.
- `packages/shared/src/db/schema.ts` (+ migration) — `vector('embedding', { dimensions })`
  read at generate-time via a **minimal YAML reader** (not full `loadConfig()`, to avoid
  `${VAR}` interpolation failures in the `drizzle-kit generate` context).
- New **provider-factory** in `shared`: config → `ChatAnthropic` / `ChatOpenAI({configuration:
  {baseURL}})` / `OpenAIEmbeddings({configuration:{baseURL}})`.
- Runtime **guard**: `assert(vector.length === embeddings.dimensions)` (protects AD-13).
- `Share2Brain.config.yml(.example)`, `.env.example`, `docker-compose.yml` env propagation.
- Ties into the open Epic-2 spike action item (real embeddings-API smoke, verify dimension).

**Invariants touched:** AD-6 (Zod contract) and AD-8 (loadConfig) — always. **AD-5** — dimension
parametrized to deploy-time; `schema.ts` stays the DDL source of truth; documented, not broken.

## 3. Recommended Approach

**Option 1 — Direct Adjustment (Hybrid):** one new story (3.0) + AC amendments (3.3/4.1/5.1) +
documentation updates.

- **Effort:** Medium. **Risk:** Low.
- **Rationale:** the affected pipeline is greenfield (Epics 3–5 all backlog, no embeddings
  persisted), so the AD-5 dimension change incurs **no migration/reindex cost now**; the
  factory un-defers a decision the architecture already anticipated
  (`TECHNICAL-DESIGN.md:1072`); the contract lives in `shared` (single source, AD-6).
- **Rejected:** Rollback (unnecessary — the shipped 1.2 contract evolves forward); MVP review
  (MVP unchanged — this widens configurability, cuts nothing).

## 4. Detailed Change Proposals

### 4.1 Config contract — `Share2Brain.config.yml`, `config/index.ts`, `.env.example`
Extract embeddings into its own top-level block; add provider enum, `base_url?`, `api_key`,
`dimensions`.

`agent`: `provider: enum(anthropic|openai|custom)`, `model`, `base_url?`, `api_key`,
`temperature`, `max_iterations`, `memory_window`.
`embeddings` (new): `provider: enum(openai|custom)`, `model`, `dimensions: int>0`,
`base_url?`, `api_key`.
`knowledge`: `chunk_size`, `chunk_overlap`, `grouping_window` (drop `embedding_model`).
`.superRefine`: `provider === 'custom'` ⇒ non-empty `base_url` (both blocks).
`.env`: `LLM_API_KEY`, `LLM_BASE_URL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_BASE_URL`.
Dimension: single source in YAML; `schema.ts` reads it via minimal YAML reader at generate-time;
runtime guard asserts vector length.

### 4.2 New Story 3.0 (epics.md, before 3.1)
"Configuración de proveedores LLM y embeddings" — full AC set covering: Zod enum + `embeddings`
block; reject `embeddings.provider: anthropic`; reject `custom` without `base_url`;
provider-factory (LLM + embeddings) with explicit key/base_url; `schema.ts` generate-time
dimension read; runtime dimension guard; `.example`/`.env.example` updates. Blocks 3.3.

### 4.3 FR5 + downstream AC (epics.md)
- **FR5:** "generar embeddings con el proveedor/modelo configurado en `embeddings`" (drop
  hardcoded `text-embedding-3-small`).
- **3.3:** embeddings via factory → `embeddings.dimensions`; new AC: guard checks vector length
  before UPSERT, no ACK on mismatch.
- **4.1:** query embedding via factory.
- **5.1:** new AC — StateGraph instantiates LLM via factory (provider/model/base_url/api_key).

### 4.4 PRD (docs/context/PRD.md)
- **PO-5:** open question → **RESOLVED** (Story 3.0): provider/model of embeddings configurable
  (OpenAI/custom); Anthropic N/A (no embeddings API).
- **AS-2/AS-4:** cost/quality no longer tied to `text-embedding-3-small`; piloted on the
  configured model.
- **SO-7/SD-18/§13:** delegation no longer assumes fixed Anthropic/OpenAI — content leaves to
  the operator-configured provider(s) (LLM and embeddings, possibly distinct, incl. custom
  self-hosted endpoint); still explicit and documented.
- **Config examples** (~478-494, 1210-1212, 1399-1402) + prerequisites (~1511) updated.

### 4.5 Architecture / data-model / standards
- **TECHNICAL-DESIGN:** config block, tech table (Embeddings → configurable), deferred table
  (un-defer → factory implemented in 3.0), embeddings sequence diagram (`vector[dimensions]`).
- **ARCHITECTURE-SPINE:311:** provider abstraction implemented; AD-5 note — dimension
  parametrized to deploy-time, `schema.ts` remains DDL source of truth, change ⇒ migrate +
  reindex.
- **data-model.md** (10/51/134) + **backend-standards.md:79:** dimension configurable.

### 4.6 Backlog & infra
- **sprint-status.yaml:** add `3-0-config-proveedores-llm-y-embeddings: backlog` (blocks 3-3) +
  audit comment.
- **docker-compose.yml:** propagate `LLM_API_KEY`, `LLM_BASE_URL`, `EMBEDDINGS_API_KEY`,
  `EMBEDDINGS_BASE_URL` to bot/backend/workers per consumption.
- **Share2Brain.config.yml.example:** mirror 4.1.

## 5. Implementation Handoff

**Scope classification: Moderate** (backlog reorganization — new story + cross-epic AC
amendments + source-of-truth doc updates).

| Recipient | Responsibility |
|---|---|
| **Developer (Amelia)** | Apply doc/backlog edits (§4.2–4.6), then implement Story 3.0 via `bmad-create-story` → `bmad-dev-story` |
| **PM / Architect (advisory)** | Sanity-check PRD (§4.4) and architecture (§4.5) edits, since they touch source-of-truth docs |

**Sequencing:** apply proposal edits → create & implement Story 3.0 → then Epic 3 (3.1 → 3.3).
Story 3.0 is a **hard dependency** of 3.3.

**Success criteria:**
- `loadConfig()` accepts `anthropic|openai|custom` (LLM) and `openai|custom` (embeddings);
  rejects `embeddings.provider: anthropic` and `custom` without `base_url`.
- Provider-factory returns the correct LangChain client per provider with explicit
  key/base_url.
- `drizzle-kit generate` produces `vector(embeddings.dimensions)`.
- Runtime guard aborts on vector-length mismatch.
- Docs (PRD/architecture/data-model/standards) reflect configurable providers + dimension.

## 6. Notes
- The two-file config model (secrets in `.env`, behavior in `Share2Brain.config.yml`) is preserved —
  a core invariant; not collapsed into a single file.
- No data migration needed now (greenfield pipeline); the AD-5 note documents the
  migrate + reindex requirement for any future dimension change once embeddings exist.
