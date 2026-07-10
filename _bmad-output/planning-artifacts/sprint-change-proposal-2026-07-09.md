# Sprint Change Proposal — AI-Curated Resource Index

- **Date**: 2026-07-09
- **Author**: Borja (via Correct Course workflow)
- **Change scope classification**: **Major** (new product-scope functionality → new Epic + PRD/Architecture/docs edits)
- **Mode**: Incremental

---

## 1. Issue Summary

**Trigger**: New business requirement raised after the roadmap closed (all six epics `done`).

Today the knowledge base indexes **every** enabled-channel message: the Indexer groups
consecutive same-channel messages (`grouping_window`), splits them into chunks
(`chunk_size`/`chunk_overlap`), embeds the **raw text**, and stores it in the
`embeddings.content` column (one row may span several messages via `message_ids[]`).

Borja wants to pivot the product into a **curated resource index**:

- Only messages that **contain a URL** are indexed. A message with no URL is **discarded**
  (no embedding created).
- For **each URL** in a message, the Indexer creates one embedding row enriched with:
  - **`title`** — AI-generated
  - **`description`** — AI-generated (replaces the old `content` column semantically)
  - **`link`** — the URL itself
- The embedding **vector is computed from `title + description`** (not raw message text).
- The AI generates title/description from the **message text + the fetched content of the
  linked URL**; on fetch failure it **falls back to message-text-only** (the resource is
  still indexed, with its link).
- The `embeddings` table changes: **`+title +description +link`, `−content`**.

**How discovered**: Product decision, confirmed interactively during this workflow (all four
scoping decisions + three design decisions recorded below).

**Confirmed decisions**:

| Decision | Choice |
|---|---|
| What is "link" | URL inside the message text |
| Row granularity | One embedding **per URL** (`chunk_key = "<messageId>:<urlIndex>"`) |
| Embedding vector source | `title + description` (AI-generated) |
| Product scope (PRD) | Curated resource index — non-link discussion is no longer searchable |
| AI input | Message text **+ fetched URL content** |
| Fetch-failure policy | **Fallback to message-text-only** (resource still indexed) |
| Enrichment LLM | New independent **`enrichment.llm`** config block |
| Work structure | **New Epic 7** (6 stories) |
| Citation link | **Yes in v1** — `link` added to `CitationSchema` |
| Non-HTML resources | Fetch-failure → message-text fallback (no extractors in v1) |
| Deploy migration | Destructive + **full wipe & fresh ingest** (truncate `discord_messages` + `embeddings`) |
| Enrichment output language | **`enrichment.language`** in `Share2Brain.config.yml` (behavior, not `.env`) |

---

## 2. Impact Analysis

### 2.1 Epic Impact
The roadmap is closed; this is **additive new functionality**, not a fix to defective work.
No existing epic is invalidated. A **new Epic 7** is added. Epic 3 (Ingestion) is the
conceptual origin; Epics 4 (Search/Docs) and 5 (RAG/Chat) are rippled at the projection layer
only (they read the changed columns).

### 2.2 Artifact Conflicts

| Artifact | Change |
|---|---|
| **FRs** (`epics.md`) | **FR5 rewritten** (no grouping/chunking; URL extraction; fetch+AI enrichment; discard-if-no-link). **FR6** re-index by link-diff. **FR11/12/16/17** switch `content`→`title/description/link`. **FR13/FR21** clarified. |
| **ARCHITECTURE-SPINE (ADs)** | **AD-5** DDL change (`embeddings`). **AD-6** contract change. **AD-12 (RBAC)** *preserved* — still `WHERE channel_id = ANY(...)`. **AD-13** new `chunk_key` + UPSERT convergence under non-deterministic AI. New capability: generative LLM + outbound fetch in workers. |
| **`docs/data-model.md`** | `embeddings`: `+title +description +link −content`. `user_read_status` FK unchanged. |
| **`docs/api-spec.yml`** | `/api/search` & `/api/documents` response bodies: `content`→`title/description/link`. |
| **`docs/context/TECHNICAL-DESIGN.md`** | Rewrite Ingestion pipeline section; adjust RAG retrieval/citation section. |
| **Backend** | `embeddingSearchRepository.drizzle.ts`, `documentRepository.drizzle.ts`, `ragRetriever.drizzle.ts` (SELECT), `searchService.ts`/`documentService.ts` (map), `agent/prompt.ts` (context block), citations (+link), `e2e/seed.ts`. |
| **Frontend** | `SearchView.tsx` (card: title heading + description + "view resource" link), `DocsView.tsx` (row: title + description clamp), chat citations (+link). UX-DR11/12/13/21 revised. |
| **Config** | New `enrichment` block (`llm` + `fetch`); new secret `ENRICHMENT_LLM_API_KEY`. |
| **Workers** | `createChatModel` **already exists** in `@share2brain/shared/providers` → reused (no AD-2 break). New `UrlFetcher` with SSRF guard. `grouping.ts`/`chunking.ts` retired or repurposed. |

### 2.3 Key Risks (surfaced, not silently accepted)

1. **🔴 SSRF (security)** — fetching arbitrary URLs posted in Discord grants reach into
   internal network / cloud metadata endpoints (`169.254.169.254`), `localhost`, private
   ranges. Mandatory mitigations: scheme allowlist (`http`/`https` only), DNS resolution +
   private/link-local IP block, redirect cap, size cap, timeout. Touches NFR17. **Real work,
   not a flag.**
2. **🟠 Cost & latency** — one fetch + one LLM completion **per URL**. Affects NFR2/NFR6/NFR8;
   every link-message is now a paid generative call.
3. **🟠 Fetch failures** — resolved: **fallback to message-text-only** (resource still indexed).
4. **🟡 Destructive migration** — dropping `content` and changing the model invalidates all
   existing embeddings → a **full re-index** is required after deploy. **APPROVED by Borja
   (2026-07-09): destructive migration is acceptable — no production data to preserve.**

---

## 3. Recommended Approach

**Option 1 — Direct Adjustment via a new Epic (Hybrid).** Add Epic 7 and edit
PRD/ADs/docs/config. Rollback (Option 2) does not apply (no defective work to revert). MVP
Review (Option 3) applies partially and is **already resolved** — Borja confirmed the product
pivot to a curated resource index.

- **Effort**: High · **Risk**: Medium-High (SSRF + destructive migration + LLM cost).
- **Handoff classification**: **Major** — PM/Architect replan of PRD/ADs/TECHNICAL-DESIGN
  first, then PO/Dev per story.

---

## 4. Detailed Change Proposals

### 4.1 Schema — `packages/shared/src/db/schema.ts` (`embeddings`)

```
OLD:
    chunkKey: text('chunk_key').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    channelId: text('channel_id').notNull(),
    messageIds: text('message_ids').array().notNull(),

NEW:
    chunkKey: text('chunk_key').notNull(),      // now "<messageId>:<urlIndex>"
    title: text('title').notNull(),             // AI-generated
    description: text('description').notNull(),  // AI-generated (replaces content)
    link: text('link').notNull(),               // the extracted URL
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    channelId: text('channel_id').notNull(),    // RBAC column (AD-12) — unchanged
    messageIds: text('message_ids').array().notNull(), // length 1; anchor = messageIds[0]
```
Rationale: one row per URL; embed `title+description`; keep `messageIds` (length 1) so the
Search/Docs anchor projection (`message_ids[0]`) survives with minimal downstream churn.
Migration via `drizzle-kit generate` — **destructive** (drops `content`); requires full
re-index after deploy.

### 4.2 Zod contracts — `packages/shared/src/schemas/`

`search.ts` `SearchFragmentSchema`:
```
OLD:  content: z.string(),
NEW:  title: z.string(),
      description: z.string(),
      link: z.string().url(),
```
`documents.ts` `DocumentFragmentSchema`: same `content` → `title/description/link` swap.

`citation.ts` (**CONFIRMED for v1**): add `link: z.string().url()` to `CitationSchema` so the
RAG answer cites the source URL. **NOTE**: this changes the `Citation` interface in
`db/schema.ts` (`messages.citations` jsonb) and the SSE `citation` frame — keep the
compile-time `satisfies` guard in sync (Story 7.1 + 7.4).

### 4.3 Config — `Share2Brain.config.yml` + `loadConfig` schema

```yaml
enrichment:
  language: "en"                # AI title/description output language (behavior → here,
                                #   NOT .env). Drives the enrichment LLM prompt (Story 7.2).
  llm:
    provider: "custom"          # anthropic | openai | custom
    model: "..."
    temperature: 0.2
    base_url: "..."             # for custom
  fetch:
    timeout_ms: 8000
    max_bytes: 2000000          # size cap
    max_redirects: 3
    user_agent: "Share2BrainBot/1.0"
    allowed_schemes: ["http", "https"]
    block_private_ips: true     # SSRF guard — DNS resolve + reject private/link-local
```
New secret in `.env`: `ENRICHMENT_LLM_API_KEY`. `loadConfig` Zod schema extended; invalid
config aborts the process (AR12/AD-8).

### 4.4 FR edits — `epics.md`

- **FR5 (rewrite)**: "El Worker Indexer consume `share2brain:discord:messages`, extrae las URLs del
  texto del mensaje y **descarta el mensaje si no contiene ninguna**. Por cada URL: hace fetch
  del recurso (con guarda SSRF, timeout y tope de tamaño), genera **título y descripción con
  el LLM de `enrichment.llm`** a partir del texto del mensaje + el contenido del recurso (con
  **fallback a solo-texto** si el fetch falla) **en el idioma de `enrichment.language`**,
  calcula el embedding de `title+description` y almacena una fila por URL en pgvector
  (`chunk_key = messageId:urlIndex`). Sin agrupación ni chunking."
- **FR6 (adjust)**: re-index on edit re-extracts links and reconciles by link-diff
  (upsert changed/new, delete removed).
- **FR11/FR12/FR16/FR17**: results expose `title/description/link` instead of `content`.
- **FR13/FR21**: RAG cites the source link; "nuevo contenido indexado" notification reads
  "recurso enriquecido indexado".

### 4.5 New Epic — `epics.md` (append)

```
### Épico 7: Índice Curado de Recursos con IA
Convierte el KB de "todo mensaje indexado" a un índice curado de recursos: solo mensajes con
URL, cada URL enriquecida por IA (título + descripción) y almacenada con su link. Reescribe la
ingesta (fin de grouping/chunking, fetch saliente con guarda SSRF, paso generativo LLM) y
proyecta title/description/link en search, documentos, RAG y las vistas web.

Historia 7.1 · shared: modelo de datos + contratos + config de enriquecimiento
Historia 7.2 · workers/indexer: extracción de URLs + UrlFetcher (SSRF) + generación IA + descarte
Historia 7.3 · workers/sync: re-indexación por diff de links + purgado
Historia 7.4 · backend: proyección search/documents/RAG/prompt/citas + seed e2e
Historia 7.5 · web: SearchView/DocsView/citas render de title/description/link + UX
Historia 7.6 · e2e: extender harness visual (patrón Epic 4) a los campos nuevos
```

### 4.6 Backend projection

- `embeddingSearchRepository.drizzle.ts`, `documentRepository.drizzle.ts`,
  `ragRetriever.drizzle.ts`: `SELECT e.title, e.description, e.link` instead of `e.content`.
- `searchService.ts`/`documentService.ts`: map new fields.
- `agent/prompt.ts`: context block becomes `title — description (link)` per fragment.
- `e2e/seed.ts`: seed `title/description/link`.

### 4.7 Frontend

- `SearchView.tsx` result card: title as heading (Space Grotesk), description body,
  distinct "ver recurso" external link (the URL) alongside the existing "ver en Discord".
- `DocsView.tsx` row: title + clamped description.
- Chat citations: optional link chip (pending 4.2 citation decision).
- UX-DR11/12/13/21 updated to reflect title/description/link.

### 4.8 Docs

- `docs/data-model.md`: `embeddings` columns.
- `docs/api-spec.yml`: search/documents response schemas.
- `docs/context/TECHNICAL-DESIGN.md`: Ingestion pipeline + RAG retrieval/citation.
- `docs/context/ARCHITECTURE-SPINE.md`: note AD-5/AD-6 revisions + new ingestion capability.

---

## 5. Implementation Handoff

- **Classification**: **Major**.
- **Phase 0 (PM/Architect)**: ratify FR5 rewrite, AD-5/AD-6/TECHNICAL-DESIGN edits, the SSRF
  security requirement, and the destructive-migration + full-reindex operational plan.
- **Phase 1+ (PO/Dev)**: implement Epic 7 one story at a time (`bmad-create-story` →
  `bmad-dev-story` → `bmad-code-review`), inner-layers-first: 7.1 → 7.2 → 7.3 → 7.4 → 7.5 → 7.6.
- **Success criteria**: link-only messages indexed with AI title/description; non-link
  messages discarded; RBAC still enforced inside the vector query; idempotent re-index;
  search/docs/chat render the new fields; SSRF guard verified; full re-index runbook documented.

---

## Resolved items (Borja, 2026-07-09)

1. **Citation link** — ✅ **YES in v1**. `link` added to `CitationSchema` (§4.2); ripples to
   the `Citation` interface + SSE `citation` frame + `satisfies` guard (Stories 7.1/7.4).
2. **Non-HTML resources** (PDF/image) — ✅ treated as **fetch-failure → message-text fallback**
   in v1 (no extractors). Consistent with the general fetch-failure policy.
3. **Clean slate** — ✅ **full wipe + fresh ingest**. Truncate `discord_messages` AND
   `embeddings` and re-ingest from scratch after deploy (even simpler than replaying the
   stream). No data to preserve. Documented as the deploy runbook for Epic 7.
4. **Enrichment language** — ✅ AI title/description generated in **`enrichment.language`**
   (`Share2Brain.config.yml`, behavior config — NOT `.env`). Drives the LLM prompt (Story 7.2);
   `loadConfig` validates it (Story 7.1).
