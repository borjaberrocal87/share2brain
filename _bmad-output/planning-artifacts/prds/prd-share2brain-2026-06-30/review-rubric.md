# PRD Quality Review — Share2Brain Self-Hosted

## Overall verdict

This PRD is technically credible and unusually well-specified at the infrastructure layer, but it stops short of the product layer: there are no user journeys for the member persona (the end user who generates the value), no counter-metrics, no explicit MVP/v1 tagging on individual requirements, and no assumption or open-question discipline. A developer could build the system described; a product decision-maker could not confidently scope the MVP, prioritize trade-offs, or validate the thesis without supplementary conversations.

---

## 1. Decision-readiness — thin

The Decisions table (§14, SD-1 through SD-15) is genuinely useful: each decision has a rationale and is traceable. The Non-Goals list (§2.3) is concrete and does real work. However, the PRD reads as having already resolved all trade-offs in one direction, with no surfaced alternatives or honest cost acknowledgment.

There are no Open Questions anywhere in the document. For a 1.0 of a self-hosted AI product, this is implausible. Unresolved questions that should be visible include: (a) what happens when the Discord API returns an error mid-backfill — is the partial index acceptable?; (b) what is the degradation behavior when the LLM provider is unavailable?; (c) how does an operator migrate data across Share2Brain versions?; (d) is `delete_policy: soft` the right default, given that soft-deleted content could appear in citations and confuse members?

The roadmap (§15) separates MVP from v1 at the phase level but no individual FR or component is tagged with its phase. An engineer reading §4 cannot determine which components are in scope for MVP. The statement "sync de ediciones/borrados" appears in v1 in §15, yet SB-16, SB-17, SNF-13, SNF-14, SNF-15 are written as first-class requirements alongside MVP components in §4 and §11 — this creates an incoherent implementation boundary.

### Findings

- **high** No open questions documented (entire document) — A self-hosted AI agent product with zero open questions is a red flag. No error-recovery behavior, no migration path, no provider-unavailability degradation mode is surfaced for PM decision. *Fix:* Add an "Open Questions" table before §14 with at least 5–8 genuine unresolved items tagged by owner and deadline.
- **high** MVP scope is not traceable to individual FRs (§4, §11, §15) — §15 lists MVP scope in prose, but SB-16, SB-17, SNF-13–17 (sync and RBAC — listed as v1 in §15) appear as full peers with no phase tag in §4 and §11. *Fix:* Add a Phase column to every component table and NFR table, or add a note "(v1)" suffix to each row that is out of MVP scope.
- **medium** No degradation/fallback behavior specified (§4.2 Agent Runtime) — The document specifies the happy path through the agent runtime but does not state what the system returns when the LLM provider is unavailable, when pgvector returns 0 results, or when the Discord API rate-limits during backfill. *Fix:* Add a "Failure modes" subsection to §4.2 and §4.1 naming at minimum: LLM-unavailable, zero-retrieval, and Discord-rate-limit behaviors.
- **medium** Soft-delete default not justified as a trade-off (§4.6 config, SD-11) — SD-11 explains the options but not why soft is the right default. A member could receive a citation pointing to a deleted message, which directly violates SO-3's promise of "fuentes verificables." *Fix:* State the acknowledged risk of soft-default in SD-11 and note who owns the decision to accept it.

---

## 2. Substance over theater — adequate

The persona table (§3) is thin but not purely theatrical: the Operador persona directly drives the operator flow (§3.1), the Docker Compose specs, the config YAML, and the deployment checklist. The Admin del guild persona, however, has no concrete requirements traceable to it — there is no admin panel (explicitly excluded in §2.3) and no admin-specific endpoints or flows. The Admin persona is furniture as currently written.

The Miembro persona ("Buscar información y recibir respuestas con fuentes") is the end-user of the entire system, yet there is no user journey, no interaction model, and no UX flows for members. The Read Tracking flow in §4.8 is the closest approximation and it is written in system-event terms, not member-experience terms.

The NFRs (§11) are above average for a PRD: they have specific numeric thresholds (SNF-1: `< 200ms`, SNF-2: `< 5s`, SNF-3: `< 100ms first chunk`, SNF-13: `< 5s re-indexing`, SNF-14: `< 3s purge`, SNF-15: `< 60s sync for 1000 msgs`). These are product-specific and testable. The availability section (SNF-6 through SNF-9) is weaker — "Health check en /health" and "Logging de errores" are implementation facts, not requirements.

The vision statement in §1 ("agente de IA que indexa automáticamente el conocimiento de una comunidad de Discord") is functional and specific enough to the product category. It is not generic.

### Findings

- **medium** Admin del guild persona has no traceable requirements (§3, §2.3) — The persona is named, but "Configurar el bot, revisar métricas" has no corresponding endpoint, view, or FR. There is no admin-metrics endpoint in §4.2 and no admin web view in §4.3. *Fix:* Either remove the Admin persona (collapsing its needs into the Operador) or add one concrete Admin-specific flow (e.g., a `/api/admin/metrics` endpoint and the AdminMetrics view).
- **medium** Miembro persona has no user journey (§3) — The primary end-user of the product has a one-line description and no flow. §4.8 documents the system events of read tracking; nothing documents the member experience of searching, reading, and chatting. *Fix:* Add a "Flujo del miembro" parallel to §3.1 (Flujo del operador), even at 5–6 steps, covering: login, search, open document, chat, mark read.
- **low** SNF-6–9 availability requirements are implementation facts, not requirements (§11.2) — "Health check en /health" describes implementation. The requirement should be: "The system must return a non-2xx response within N seconds when any component is degraded." *Fix:* Rewrite SNF-6 through SNF-9 as observable outcomes with thresholds.

---

## 3. Strategic coherence — adequate

The PRD has a clear thesis: community knowledge is fragmented in Discord; self-hosted AI lets operators capture and serve it while keeping data under control. The SO objectives (§2.2) map onto this thesis, and the components (§4) implement those objectives. The data sovereignty angle (SO-7) is the product's primary differentiator over SaaS alternatives, and it is consistently enforced — no external data transmission except to the LLM provider (which is a noteworthy gap: member message content leaves the operator's server to the LLM API, but this is not acknowledged as a tension with SO-7).

The Success Metrics (§16) partially validate the thesis. SM-1 (% questions resolved without human intervention) and SM-2 (% responses with cited source) are good thesis-validators. SM-3/SM-4 duplicate NFRs SNF-1/SNF-2 exactly — they are engineering targets repackaged as success metrics rather than product outcomes. SM-5 (test coverage) is an engineering hygiene metric, not a product success metric. SM-6 (messages indexed per hour) measures throughput, not value. SM-7/SM-8 (read tracking engagement) measure feature adoption but not the thesis of "knowledge fragmentation solved."

No counter-metrics are named anywhere. For SM-1, the natural counter-metric is "% of agent responses that triggered a follow-up correction by a moderator" — its absence means there is no failure signal for hallucination or wrong citations in production.

### Findings

- **high** SO-7 "Datos bajo control" is contradicted by LLM API usage (§2.2, §4.2) — The system sends member message content to Anthropic/OpenAI APIs for both embedding (`text-embedding-3-small`) and agent inference. This is never acknowledged as a tension with the self-hosted data-sovereignty promise. *Fix:* Add a note to SO-7 explicitly scoping "bajo control" to mean data-at-rest, and acknowledge LLM provider data processing in §13 Threat Model.
- **medium** SM-3/SM-4 duplicate NFR targets and are not product metrics (§16) — SM-3 is identical to SNF-1 and SM-4 is identical to SNF-2. Success metrics should measure product outcomes, not engineering compliance. *Fix:* Replace SM-3/SM-4 with outcome metrics such as "% of member sessions that result in a found answer" or "% of chat sessions that cite ≥1 source."
- **medium** No counter-metrics named (§16) — SM-1's failure mode (bad answers, hallucinations) and SM-2's failure mode (citations that point to deleted/wrong content) have no named counter-signals. *Fix:* Add a counter-metric column or a note to SM-1 and SM-2 naming the failure indicator.
- **low** SM-5 (test coverage > 80%) is an engineering metric in a product success table (§16) — *Fix:* Move SNF-10 and SM-5 to §11.3 exclusively; remove from §16.

---

## 4. Done-ness clarity — strong

This is the PRD's strongest dimension. The component tables in §4 identify specific named components (DiscordBot, MessageListener, Backfiller, AgentRuntime, ToolRegistry, etc.) that map onto a specific repo structure (§6.3). The SQL schemas (§5.2) are complete and include constraints. The API endpoint table (§4.2) names methods, routes, and descriptions. The indexing flow diagrams (§4.1) detail every event name (discord.message.created, discord.message.updated, discord.message.deleted, discord.message.reindexed, discord.message.purged). The NFR thresholds are numeric and testable.

An engineer receiving this PRD could proceed to implementation without significant ambiguity at the component level. This is well above average for a PRD.

### Findings

- **medium** "Handles attachments and embeds" is implicit — `discord_messages.attachments` and `.embeds` are JSONB columns in the schema, but no FR states what the system does with attachments (indexes the text content? skips? downloads images?). *Fix:* Add one sentence in §4.1 MessageIndexer describing attachment handling — are they indexed, ignored, or deferred to the "OCR de imágenes" roadmap item?
- **medium** Tool sandboxing is specified but not defined (§9 SS-5, §4.2 Agent Runtime) — "Ejecución aislada; permisos" and "Ejecutar tool en sandbox" appear without any definition of what sandbox means (subprocess isolation? no filesystem access? network restrictions?). *Fix:* Add a 2–3 line definition of sandbox scope in §9, or reference SD-X for the decision.
- **low** `grouping_window: 10` in config has no unit (§4.6) — Is this 10 messages? 10 seconds? 10 minutes? *Fix:* Clarify in the config schema or a YAML comment.
- **low** `memory: 2G` in docker-compose.prod.yml for the app service has no justification (§7.2) — The NFRs don't state memory targets. *Fix:* Either add an SNF entry for memory footprint or add a comment explaining the 2G figure.

---

## 5. Scope honesty — thin

The Non-Goals section (§2.3) is present and does real work — it names six specific exclusions (multi-tenant, admin panel, moderation, MCP tools, Ollama, i18n). This is good. The scope-in list in §0 is clear.

However, there are no [ASSUMPTION] tags anywhere in the document. Several assumptions are load-bearing:
- That the operator has a public-facing domain for Discord OAuth2 redirect URIs
- That embedding costs are negligible at the community sizes targeted
- That Discord's API rate limits are sufficient for backfill at `backfill_limit: 1000`
- That `text-embedding-3-small` at 1536 dimensions is adequate for community-scale semantic search quality

There are no [NOTE FOR PM] callouts. The roadmap (§15) defers decisions into phases without marking which deferred items require a PM decision before implementation begins.

The document also implicitly assumes the operator is a solo technical person — the "Admin del guild" persona (who could be a different person managing Discord permissions) is never given a workflow or access path that distinguishes them from the operator.

### Findings

- **high** No assumptions are tagged (entire document) — At least four load-bearing assumptions exist (OAuth redirect URL requirement, embedding cost model, Discord API rate limit adequacy, embedding quality threshold) that could invalidate scope if wrong. *Fix:* Add a §0.1 Assumptions table with [ASSUMPTION] tags and owner/validation plan for each.
- **medium** Roadmap phase boundaries have no decision criteria (§15) — "v1" items are listed but there is no criterion for when MVP is considered complete and v1 begins. Without a definition of MVP exit, the boundary is meaningless to a PM. *Fix:* Add one or two objective criteria per phase transition (e.g., "MVP complete when SM-1 > 70% across 3 active communities in production for 30 days").
- **medium** Operator vs. Admin persona distinction is underdeveloped (§3) — The PRD assumes the operator and the Discord Admin are the same person, but they need not be. If they are different, the Admin has no access path to Share2Brain (no admin endpoints, no login). *Fix:* Explicitly state whether Operator = Admin is a required constraint or an assumption.
- **low** "Lista de canales a excluir" mentioned in §13 Threat Model but not in §4.6 config — The YAML schema in §4.6 shows `channels[].enabled: true/false` but the threat model implies a separate exclusion list. *Fix:* Reconcile: clarify that `enabled: false` is the exclusion mechanism and remove the ambiguity from §13.

---

## 6. Downstream usability — adequate

The repo structure (§6.3) is detailed enough for an architect to begin scaffolding. The API endpoints (§4.2) are concrete enough for a frontend engineer to stub. The SQL schemas (§5.2) are implementation-ready. The Docker Compose files (§7) are deployable as written.

However, there is no Glossary. The document uses "documento," "mensaje," "fragmento," "embedding," and "chunk" somewhat interchangeably when referring to the indexed knowledge unit. A UX designer writing copy or an engineer writing error messages would need to guess the canonical term. "Embedding" appears both as the vector representation (technically correct) and as the UI-facing concept in read tracking ("marcar embedding como leído," API endpoint `/api/read-status/:embeddingId`) — exposing an implementation detail as a user-facing identifier.

FR IDs are component-scoped (SB-1 through SB-17, SS-1 through SS-9, SNF-1 through SNF-17) and non-sequential within each group (SB-1 through SB-10 cover both Discord Bot and Backend; SB-11 through SB-15 cover Web App; SB-16 and SB-17 are sync components inserted at the end). There is no globally-numbered FR list. This makes cross-referencing in stories difficult.

SB-1 through SB-17 spans three different components (Discord Bot: SB-1 to SB-5 + SB-16/17; Backend: SB-6 to SB-10; Web App: SB-11 to SB-15) — the ID namespace does not reflect the component boundary, which will cause confusion in story creation.

### Findings

- **high** "Embedding" exposed as user-facing identifier in the API (§4.2, §4.8) — `/api/read-status/:embeddingId` and the read tracking flow reference "embedding" as the key concept for members. An embedding is an infrastructure concept; the user-facing entity is a "document fragment" or "message." *Fix:* Introduce a user-facing term ("fragment," "documento indexado") in the Glossary and map it to the DB entity; rename the API path accordingly or add a note explaining the internal-only nature.
- **medium** No Glossary section (entire document) — "documento," "fragmento," "mensaje," "embedding," "chunk" are used without canonical definition. The lack of a glossary will cause terminology drift across UX copy, API responses, and the codebase. *Fix:* Add §0.2 Glosario with at minimum: Operador, Admin, Miembro, Mensaje (Discord message), Fragmento (indexed chunk), Conversación, Guild, Embedding.
- **medium** ID namespace spans multiple components without clear mapping (§4.1, §4.2, §4.3) — SB-1 through SB-17 mixes Discord Bot, Backend, and Web App components in a single namespace. Story creation from this PRD requires the author to know the mapping. *Fix:* Prefix IDs by component: `BOT-1` through `BOT-7` for Discord Bot, `API-1` through `API-5` for Backend, `UI-1` through `UI-5` for Web App.
- **low** No user journeys with named protagonists (§3) — Only the Operador has a flow (§3.1). UX work and story creation for Miembro features cannot source-extract from this PRD. *Fix:* Add §3.2 Flujo del miembro with a named protagonist (e.g., "Ana, moderadora técnica de una comunidad de developers") covering the core search/chat/read-tracking loop.

---

## 7. Shape fit — adequate

This is a technical operator-centric product and the PRD is correctly shaped for that: the operator flow (§3.1), configuration-as-code (§4.6), Docker Compose (§7), deployment checklist (§17), and threat model (§13) are all appropriate artifacts for this product type. The level of technical detail in the SQL schemas and repo structure is justified by the operator audience.

Where the shape is strained: the member interaction layer is almost absent. For a product whose value proposition is delivered to members (they are the ones searching, chatting, and reading), the PRD has approximately 15 lines about member-facing behavior (§3 one-liner, §4.8 read tracking flow) versus several hundred lines of infrastructure specification. This is an imbalance for a product PRD, even a technical one — the member experience is what determines whether the product delivers SO-1 through SO-4's promise.

The "En revisión" status is appropriate; this document reads as a first-author draft that has not yet been reviewed by a PM, UX designer, or second technical reviewer.

The ENSAMBLAR typo ("ENsamBLAR" in §4.2) is a cosmetic issue but signals the document has not been proofread.

### Findings

- **medium** Member-facing behavior is vastly under-specified relative to infrastructure (§3, §4.3, §4.8) — The Web App (§4.3) lists five components and four views in a table, with no interaction detail, no empty states, no error states, no loading states. For a product PRD, the interface layer for the primary persona should have at least one interaction flow. *Fix:* Add a §4.3.1 with the member search-to-answer journey at the UI interaction level (not system-event level), or reference a separate UX spec.
- **low** Typo in §4.2 heading — "ENsamBLAR CONTEXTO" should be "ENSAMBLAR CONTEXTO." *Fix:* Correct the casing.
- **low** Docker Compose `version: '3.8'` is deprecated syntax in current Docker Compose v2 (§7.1, §7.2) — While it still works, Docker Compose v2 ignores the `version` key and it can cause linter warnings. *Fix:* Remove the `version:` key from both compose files.

---

## Mechanical notes

- **Glossary drift** — "fragmento" (§2.3 bullet, §4.8 flow), "documento" (§4.3 DocumentList view, §16 SM-7/SM-8), "embedding" (§4.2 API route, §4.8, §5.1 ER diagram), "chunk" (§4.6 `chunk_size` config) all refer to the same indexed knowledge unit at different levels of abstraction. No canonical term is established.
- **ID non-continuity** — SB-1 through SB-17 has a gap between SB-5 and SB-6 (crossing component boundaries) and SB-15 and SB-16 (late-added sync components). The numbering is chronological-insertion order, not logical grouping. SS-1 through SS-9 and SNF-1 through SNF-17 are separate namespaces that could conflict if referenced without prefix.
- **SNF non-continuity** — SNF-6 through SNF-9 (availability) appear in §11.2 after SNF-1 through SNF-5 (performance) in §11.1, then SNF-10 through SNF-12 (testing) in §11.3, then SNF-13 through SNF-17 back in §11.1. The numbering does not follow section order.
- **Cross-reference gap** — §13 Threat Model mentions "Lista de canales a excluir" but there is no such list in §4.6; the mechanism is `enabled: false` per channel. The threat model cross-references a feature that is not explicitly specified as a feature.
- **SM/NFR duplication** — SM-3 = SNF-1 (búsqueda vectorial P95 < 200ms); SM-4 = SNF-2 (agente P95 < 5s); SM-5 = SNF-10 (cobertura > 80%). These are listed in two separate sections without cross-reference.
- **Typo** — §4.2 "ENsamBLAR CONTEXTO" — mixed case in section header.
- **docker-compose.prod.yml** — `DISCORD_CLIENT_SECRET` is in the `environment:` block AND in `secrets:` (as `discord_client_secret`). The two mechanisms overlap; the environment variable would take precedence over the secret mount, making the secret declaration redundant.
