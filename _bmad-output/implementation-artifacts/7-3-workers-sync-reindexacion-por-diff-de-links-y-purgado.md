---
baseline_commit: c557b96d0b9685accf47afe5714ed4c5a88cac4f
---

<!-- Powered by BMAD-CORE™ -->

<!-- story_key: 7-3-workers-sync-reindexacion-por-diff-de-links-y-purgado -->

# Story 7.3: workers/sync — re-indexación por diff de links y purgado

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created -->

## Story

As the system,
I want the Sync worker to reconcile an edited message's resource rows by link-diff (reusing the enrichment of unchanged links) and to keep purging deleted messages per `delete_policy`,
so that the curated resource index stays consistent with Discord edits and deletions without re-paying fetch/LLM/embedding cost for links that did not change.

**Scope**: `packages/workers` (sync rewrite + enrichment-module reuse + demolition of chunking) + `packages/shared` (retire the `knowledge` config block) + docs sync. FR6 (rewritten by the Epic 7 pivot): *"El Worker Sync debe consumir eventos `discord.message.updated`: re-extraer las URLs del contenido editado y reconciliar por diff de links (upsert de links nuevos/cambiados, purgado de los removidos)"* [Source: _bmad-output/planning-artifacts/epics.md:25].

**Out of scope**: FR21 notifications (P2.5 — the Notifier stays crash-alerts-only; sync must NOT emit "recurso enriquecido indexado"); DLQ/retry-cap (P2.2 — PEL stays the implicit DLQ); MAXLEN trimming (ops-1); `messageDeleteBulk` publishing (P2.3); backend/web projection (7.4/7.5); the 7.2 review deferrals in reused code (UTF-8 charset decode, surrogate-split truncation, meta-regex over full HTML — do not fix unless promoted).

## Decisions confirmed with Borja (2026-07-09, story creation)

1. **F1 — Rebuild-by-diff (chosen over row-preserving re-key and full re-enrich).** The diff is an *in-memory cost optimizer*, not a row-identity mechanism: kept links (same normalized `link` in old rows and new extraction) REUSE their existing `title`/`description`/`embedding` — zero fetch, zero LLM, zero embed. Persistence is a single-transaction wipe-and-reinsert: delete `user_read_status` → delete all the message's `embeddings` rows → insert the new row set keyed `<messageId>:<urlIndex>` (new positions). This sidesteps the positional-`chunk_key` unique-index collisions that any partial diff would hit when URL positions shift (old `[A,B]` → new `[B,C]`: B's key `:1` collides with C's new position). Accepted cost: read-status of kept links is lost on every edit — exactly what 6.2 does today.
2. **F2 — Kept links are NOT re-enriched when only the message text changed.** FR6 upserts links "nuevos/cambiados" — an unchanged link is not changed. Title/description derive mostly from the fetched page; skipping re-enrichment is the cost-control lever for pivot risk 🟠#2 (one fetch + one paid LLM call per URL).
3. **F3 — Edit that yields zero indexable URLs (none extracted, all SSRF-blocked, or content edited to blank) ⇒ PURGE.** All the message's resource rows are deleted (read-status first), `discord_messages.content`/`updated_at` refreshed, `indexed_at` stamped, entry XACKed. This converges with the Indexer's 7.2 discard semantics ("evaluated ⇒ stamped") and closes the 6.2 deferral *"edit-to-blank silently keeps stale chunks"*. Requires relaxing `parseUpdatedEvent` to accept empty `newContent` (`timestamp` stays mandatory non-blank — it feeds NOT NULL `updated_at`).

### Design decisions embedded in the ACs (recommended defaults — veto at review)

- **D1 — Failure classification is byte-for-byte the 7.2 contract**: fetch failure (`timeout`/`http_error`/`network_error`/`too_large`/`too_many_redirects`) is NOT a processing failure → enrich from message text only (row still produced). SSRF block (`ssrf_blocked`/`scheme_disallowed`) is NOT a failure → that URL is skipped, no row. Only LLM (`EnrichmentError`), embedding, or DB errors are real failures → no writes committed, no XACK, PEL replay (no retry cap, P2.2). [Source: docs/context/TECHNICAL-DESIGN.md §7:540-546]
- **D2 — Tombstone guard (closes 6.2 deferral #4's resurrect hazard)**: an update for a message whose `deleted_at IS NOT NULL` is a `debug`-log + ACK no-op. Previously an update arriving after a hard delete re-inserted purged embeddings (storage-only leak hidden by the anti-join). Unknown message stays a `debug` + ACK no-op (create path owns insertion).
- **D3 — `processDelete` survives unchanged.** Its predicates (`:messageId = ANY(message_ids)`, read-status-first FK order, soft = `deleted_at` only / hard = superset, idempotent 0-rows-is-success) are already URL-count-agnostic and correct post-7.2. 7.3 only re-confirms it via tests against per-URL rows. Do not rewrite it.
- **D4 — Demolition (the 7.2 D4 hand-off)**: delete `indexer/chunking.ts` + `chunking.test.ts`; drop `@langchain/textsplitters` from `packages/workers/package.json`; remove the `MAX_CHUNK_SIZE` import and the boot clamp warning from `main.ts`; retire the `knowledge` block from the shared config Zod schema, `Share2Brain.config.yml` and `Share2Brain.config.yml.example`. Zod strips unknown keys by default, so a deployed yml still carrying `knowledge:` keeps booting — removal is not a breaking config change.
- **D5 — Reuse by relocation, not duplication**: the per-message URL pipeline that 7.2 left module-private in `indexBatch.ts` (`processMessage`, `ResourceRow`, `MessageOutcome`, `MAX_URLS_PER_MESSAGE`) moves to `packages/workers/src/enrichment/` (e.g. `resourceRows.ts`) and gains an optional reuse lookup (`reuse?: (link: string) => { title; description; embedding } | undefined`). The Indexer re-imports it (passing no lookup); sync passes the old-row map. 7.2's dev notes explicitly planned this ("so 7.3 imports … and deletes its duplication"). Same-package relocation — AD-2 is about cross-service imports, not intra-package structure.
- **D6 — The cap applies to edits too**: `MAX_URLS_PER_MESSAGE = 20` (module constant, not config) with the same first-N + `logger.warn` dropped-count behavior.
- **D7 — Idempotent persistence stays UPSERT**: inside the rebuild transaction the inserts use `.onConflictDoUpdate({ target: embeddings.chunkKey, … })` even though old rows were just deleted — a concurrently-processing Indexer `created` event for the same message must converge, not crash (AD-13 last-write-wins per `chunk_key` is the ratified convergence model).
- **D8 — All fetch/LLM/embed I/O happens OUTSIDE the DB transaction** (established rule since 6.2 review patch; 7.2 upheld it). Embed only the freshly-enriched rows, via `buildEmbeddingText(title, description)` + `assertEmbeddingDimensions`, before opening the tx.
- **D9 — NFR6 ("re-index latency < 5s") is superseded in practice for new-link edits** — the 8s fetch timeout alone exceeds it; per-link enrichment cost was accepted in the pivot (risk 🟠#2). Kept-link and zero-URL edits stay fast. Document, don't chase.

## Acceptance Criteria

**AC-1 — Link-diff re-index on update (FR6).**
**Dado** que el Sync worker consume un evento `discord.message.updated` del grupo `share2brain:sync` para un mensaje existente y no tombstoned
**Cuando** lo procesa
**Entonces** re-extrae las URLs de `newContent` con `extractUrls(newContent, config.enrichment.fetch.allowed_schemes)` (mismo cap `MAX_URLS_PER_MESSAGE = 20` + `warn` con el recuento descartado)
**Y** hace diff por `link` normalizado contra las filas existentes del mensaje (`SELECT id, chunk_key, link, title, description, embedding FROM embeddings WHERE :messageId = ANY(message_ids)`)
**Y** los links conservados reutilizan su `title`/`description`/`embedding` sin fetch, sin LLM y sin embed
**Y** un mensaje previamente descartado por el Indexer (sin filas, `indexed_at` estampado) cuya edición AÑADE URLs produce sus filas nuevas por el mismo flujo (set viejo vacío — la edición es la vía de entrada tardía al índice)
**Y** los links nuevos ejecutan el pipeline 7.2 (`fetchUrl` → `extractPageHints` → `enrich`), con fallback a solo-texto en fallo de fetch y skip-sin-fila en bloqueo SSRF
**Y** los embeddings de las filas nuevas se calculan fuera de la transacción con `buildEmbeddingText` + `assertEmbeddingDimensions`
**Y** en UNA transacción: borra `user_read_status` dependiente → borra TODAS las filas viejas del mensaje → refresca `discord_messages.content`/`updated_at` → upserta el set nuevo con `chunk_key = "<messageId>:<urlIndex>"` (posición en la lista nueva) → estampa `indexed_at = now()`
**Y** hace XACK solo tras el COMMIT.

**AC-2 — Zero-URL edit purges (F3).**
**Dado** un evento `updated` cuyo `newContent` no produce ninguna URL indexable (ninguna extraída, todas bloqueadas por SSRF, o contenido vacío/blank)
**Cuando** lo procesa
**Entonces** purga todas las filas del mensaje (read-status primero), refresca `content`/`updated_at`, estampa `indexed_at` y hace XACK
**Y** `parseUpdatedEvent` acepta `newContent` vacío (deja de exigirlo non-blank); `timestamp` sigue siendo obligatorio non-blank (poison-pill de `updated_at`).

**AC-3 — No-op guards.**
**Dado** un evento `updated` para un mensaje inexistente en `discord_messages`, o con `deleted_at IS NOT NULL` (tombstone), o un evento malformado (parse → `null`)
**Cuando** lo procesa
**Entonces** no escribe nada, loguea `debug` (unknown/tombstone) o `warn` (malformado) y hace XACK.

**AC-4 — Failure classification and PEL (AD-13, D1).**
**Dado** un fallo de LLM (`EnrichmentError`), de embeddings o de DB durante el procesamiento de un update (o un abort de shutdown a mitad)
**Cuando** ocurre
**Entonces** no se comitea ninguna escritura, la entrada queda SIN XACK (PEL replay), y se loguea `error` con `{ streamId, stream, messageId, channelId, reason }` — NUNCA el contenido del mensaje
**Y** un fallo de fetch o un bloqueo SSRF NO dejan la entrada pendiente (D1: fallback / skip).

**AC-5 — Delete semantics re-confirmed (D3).**
**Dado** un evento `discord.message.deleted`
**Cuando** `delete_policy = "soft"` → solo `deleted_at = now()` (embeddings intactos, anti-join los oculta); **cuando** `"hard"` → una tx: read-status → embeddings (`ANY(message_ids)`) → `deleted_at`
**Entonces** ambas rutas siguen siendo idempotentes (0 filas = éxito + XACK) contra el modelo de filas por-URL — `processDelete.ts` NO se reescribe.

**AC-6 — Demolition (D4).**
**Dado** el repositorio tras esta historia
**Entonces** `indexer/chunking.ts` y `chunking.test.ts` no existen; `@langchain/textsplitters` no está en `packages/workers/package.json`; `main.ts` no importa `MAX_CHUNK_SIZE` ni emite el clamp warning; el bloque `knowledge` no existe en el Zod schema de config compartido, ni en `Share2Brain.config.yml`, ni en `Share2Brain.config.yml.example`, ni en fixtures de test
**Y** `npm run lint`, `npm run build` y la suite completa pasan sin referencias colgantes (grep repo-wide de `chunkContents|chunk_size|chunk_overlap|grouping_window|textsplitters|MAX_CHUNK_SIZE|knowledge\.` limpio en código activo).

**AC-7 — Wiring (AD-8).**
**Dado** el arranque de workers con `sync.enabled = true`
**Entonces** `main.ts` inyecta en `runSync` el MISMO `enrichModel` y `guard` construidos una vez en boot para el Indexer (`createChatModel(config.enrichment.llm)` / `createGuardedDispatcher(config.enrichment.fetch)`), más `embedder` y `signal` como hoy
**Y** `RunSyncDeps`/`ProcessUpdateDeps` tipan las nuevas dependencias; el drain de shutdown (7s in-process / 35s compose) sigue cubriendo ambos loops.

**AC-8 — Docs sync.**
**Entonces** `docs/context/TECHNICAL-DESIGN.md` §5.3 reescribe el pseudocódigo del Sync Worker al pipeline de diff (el actual referencia una columna `message_id` inexistente y re-indexado por chunking), §7 elimina el paréntesis "sigue vivo en `sync/processUpdate.ts` hasta la Historia 7.3", y §13 quita `knowledge` del sample de config; `docs/context/ARCHITECTURE-SPINE.md` línea de batching diferido (§Deferred, "chunking.ts/knowledge.* siguen vivos…") se actualiza a retirado; `docs/data-model.md` se revisa (write-ownership de `embeddings` ya es correcto; ajustar la nota de `indexed_at` si procede).

**AC-9 — Tests + gate.**
**Entonces** unit tests nuevos/reescritos cubren: diff (added/removed/kept/reordered), reuse-sin-LLM para kept links, zero-URL purge (incl. blank y all-blocked), tombstone/unknown no-ops, fallo LLM → no-ack, fallo embed → no-ack, cap 20, content-never-logged (serializando todo arg logueado)
**Y** integration tests (Postgres+Redis reales, `enrichModel`/`guard` fake-injected como en `indexBatch.integration.test.ts`, ids salteados por run) cubren: edit añade link (fila nueva enriquecida + kept reutilizado con embedding idéntico), edit añade URL a un mensaje antes descartado sin filas (entrada tardía al índice), edit elimina link (purga + cascade read-status), edit sin cambios de links (0 llamadas LLM), edit a cero URLs (purga total + stamp), convergencia en redelivery (evidencia de idempotencia §3.2 de mandatory-steps), fallo LLM → PEL, soft/hard delete (casos existentes intactos)
**Y** el gate completo pasa: `npm run lint` (0), `npm run test` (unit+web), `npm run build` (5 pkgs), `npm run test:integration`, e2e chromium con pass-count invariado.

## Tasks / Subtasks

- [x] Task 1 — Extraer el pipeline por-mensaje a `enrichment/` (AC-1, D5)
  - [x] Mover `processMessage` (renómbralo, p. ej. `buildResourceRows`), `ResourceRow`, `MessageOutcome`, `MAX_URLS_PER_MESSAGE` de `indexer/indexBatch.ts` a `packages/workers/src/enrichment/resourceRows.ts`
  - [x] Añadir el parámetro opcional de reuse: `reuse?: (link: string) => { title: string; description: string; embedding: number[] } | undefined` — un hit salta fetch+enrich y marca la fila como "no re-embeber"
  - [x] `indexBatch.ts` re-importa y pasa sin `reuse`; sus tests siguen verdes sin cambios de comportamiento
- [x] Task 2 — Reescribir `sync/processUpdate.ts` como rebuild-by-diff (AC-1, AC-2, AC-3, AC-4)
  - [x] Guard: mensaje inexistente O `deleted_at IS NOT NULL` → `debug` + `{ack: true}` (select `id, deleted_at`)
  - [x] SELECT filas viejas (`id, chunk_key, link, title, description, embedding` por `ANY(message_ids)`); construir `Map<link, row>`
  - [x] Extraer+capar URLs; correr el pipeline con `reuse` = lookup del map; embeber SOLO filas frescas (fuera de la tx, D8)
  - [x] Tx única: `DELETE user_read_status WHERE embedding_id IN (SELECT id FROM embeddings WHERE :id = ANY(message_ids))` → `DELETE embeddings` → `UPDATE discord_messages SET content, updated_at` → UPSERT filas nuevas (`onConflictDoUpdate` sobre `chunk_key`, D7) → stamp `indexed_at`; el caso cero-URLs es el mismo flujo con set nuevo vacío
  - [x] Catch: `error` log `{streamId, stream, messageId, channelId, reason}` (jamás contenido) + `{ack: false}`; rethrow-aware con abort (patrón 7.2 P3: no tragar `AbortError`)
- [x] Task 3 — Relajar `parseUpdatedEvent` (AC-2): `newContent` puede ser vacío (usa `?? ''` y elimina el check non-blank); `timestamp` sigue non-blank; actualizar doc-comment y `events.test.ts`
- [x] Task 4 — Wiring (AC-7): `ProcessUpdateDeps` + `RunSyncDeps` ganan `enrichModel: EnrichmentChatModel` y `guard: GuardedDispatcher`; `main.ts:237-248` los pasa a `runSync`; `consumer.ts` los propaga a `processUpdate`
- [x] Task 5 — Demolición (AC-6): borrar `chunking.ts`/`chunking.test.ts`; quitar `@langchain/textsplitters` (workers `package.json`); limpiar `main.ts` (import `MAX_CHUNK_SIZE` + clamp warn `:90-97`, reword del comment block); quitar `knowledge` del schema Zod (`packages/shared/src/config/index.ts:80-84`), de `Share2Brain.config.yml`, `Share2Brain.config.yml.example` y de TODOS los fixtures (grep repo-wide; los fixtures de `sync.integration.test.ts:31-40` y `processUpdate.test.ts` lo incluyen hoy)
- [x] Task 6 — Unit tests (AC-9): reescribir `processUpdate.test.ts` (diff matrix, reuse, purge, guards, failure classification, cap, no-content-logged); tocar `consumer.test.ts` solo al nivel de deps; `processDelete.test.ts` intacto; tests de `resourceRows.ts` (movidos + caso `reuse`)
- [x] Task 7 — Integration tests (AC-9): reescribir el caso update de `sync.integration.test.ts` + añadir los casos del AC-9 (patrón `indexBatch.integration.test.ts`: `openTestClients`, salt por run, cleanup por `chunk_key LIKE`, fake `EnrichmentChatModel` inyectado, `block_private_ips: false` + servidor `node:http` efímero si se ejercita fetch real)
- [x] Task 8 — Docs (AC-8): TD §5.3 pseudocódigo Sync + §7 paréntesis + §13 config sample; SPINE §Deferred línea batching; revisar data-model.md
- [x] Task 9 — Gate + verificación (AC-9): lint / unit+web / build / integration (parar contenedores compose de app primero) / e2e count; checklist `docs/bmad-story-mandatory-steps.md` (evidencia de idempotencia = test de redelivery)

## Dev Notes

### Architecture compliance (invariants that bind this story)

- **AD-13**: XACK solo tras éxito; PEL = DLQ implícita sin retry-cap; convergencia last-write-wins por `chunk_key` bajo IA no-determinista (ratificado en 7.2). [Source: docs/context/ARCHITECTURE-SPINE.md:117-139]
- **AD-5**: solo `packages/shared` hace DDL — esta historia NO toca `schema.ts` ni genera migración (el schema por-URL ya existe desde 7.1). Retirar `knowledge` del config Zod NO es DDL.
- **AD-2**: nada de imports entre servicios; toda la reutilización es intra-`packages/workers` + `@share2brain/shared`.
- **AD-8**: config inválida aborta el boot; Zod hace strip de claves desconocidas → yml viejos con `knowledge:` siguen arrancando.
- **FK crítico**: `user_read_status.embedding_id → embeddings.id` SIN `ON DELETE` (RESTRICT de facto) — todo `DELETE FROM embeddings` DEBE borrar antes sus `user_read_status` en la misma tx. "This is the #1 way hard-delete ships broken" (6.2 note #5; 7.2 lo re-confirmó: "7.3's purge owns that"). [Source: packages/shared/src/db/schema.ts:139-155]
- **Contratos de eventos**: interfaces TS (NO Zod) en `packages/shared/src/types/events.ts` — `MessageUpdatedEvent {type:'discord.message.updated', messageId, channelId, guildId, timestamp, newContent}`, `MessageDeletedEvent` (sin contenido); `STREAM_KEYS.DISCORD_MESSAGES_UPDATED/DELETED`, `CONSUMER_GROUPS.SYNC='share2brain:sync'`. Nunca hardcodear. No cambian en esta historia.

### Current state — verbatim anchors (verified 2026-07-09, main @ c557b96)

**`sync/processUpdate.ts` es el ÚNICO código stale post-7.2** — aún chunkea `newContent` completo y escribe placeholders:

- Firma: `export async function processUpdate(deps: ProcessUpdateDeps): Promise<ProcessResult>` (`processUpdate.ts:41`); deps `{event, streamId, stream, db, embedder, config, logger}` (`:20-30`).
- Flujo actual: existence check (`:48-59`, select por `inArray` — NO mira `deleted_at`) → `chunkContents([newContent], {chunk_size, chunk_overlap})` + `embedder.embedDocuments` + `assertEmbeddingDimensions` fuera de la tx (`:61-76`) → tx (`:78-126`): delete read-status → delete embeddings `ANY(message_ids)` → `UPDATE discord_messages SET content, updated_at` → inserta chunks con `chunkKey: \`${messageId}:${i}\``, `title: ''`, `description: chunks[i]`, `link: ''` + `onConflictDoUpdate` (`:97-123`) → stamp `indexed_at` (`:125`) → catch `{ack:false}` (`:129-140`).
- Hoy una edición **destruye las filas enriquecidas de 7.2 y las sustituye por basura chunked** (`title:''`, `link:''`, chunkIndex ≠ urlIndex) — ese es el bug de producto que esta historia elimina.
- `sync/processDelete.ts`: soft `:41-47`, hard `:49-61` (tx read-status → embeddings → `deleted_at`), catch `:64-75` con `policy` en el log. Correcto post-7.2 — NO tocar (D3).
- `sync/consumer.ts`: `runSync(deps)` (`:47`), deps `{redisUpdated, redisDeleted, db, embedder, config, logger, signal}` (`:29-40`) — un cliente Redis dedicado POR loop bloqueante; `CONSUMER='consumer-1'`, `COUNT=10`, `BLOCK_MS=5000` (`:25-27`); dos `runStreamLoop` bajo el grupo único `share2brain:sync` con PEL replay desde `'0'` + live `'>'`, BUSYGROUP tolerado; XACK solo con `{ack:true}` (`:165-183`).
- `sync/events.ts`: `parseUpdatedEvent` (`:23`) exige hoy `newContent` non-blank (`:26-35`) — F3 lo relaja; `timestamp` non-blank DEBE quedarse (poison-pill de `updated_at` NOT NULL, doc-comment `:16-20`). `parseDeletedEvent` (`:53`) sin cambios.
- `main.ts`: modelos construidos UNA vez (`:202-208`): `embedder = createEmbeddingsModel(config.embeddings)`, `enrichModel = createChatModel(config.enrichment.llm)`, `guard = createGuardedDispatcher(config.enrichment.fetch)` — hoy solo el Indexer los recibe; `runSync` (`:237-248`) recibe solo `embedder`. Gating `config.sync.enabled` (`:214-223`) crea+conecta `syncRedisUpdated`/`syncRedisDeleted`. Clamp warning a eliminar: `:90-97` + import `MAX_CHUNK_SIZE` en `:18`. Shutdown: abort → race 7s → quit Redis (5s c/u) → `db.$client.end()` 10s.

### 7.2 enrichment surface (reuse — do not reinvent)

Todo ya existe en `packages/workers/src/enrichment/`; **no escribas ningún fetch/prompt/parse nuevo**:

- `extractUrls(content, allowedSchemes): string[]` (`extractUrls.ts:53`) — unwrap `<url>`/markdown, strip de puntuación con balance de paréntesis, `URL.canParse`, rechaza credenciales, dedup por `url.href` normalizado en orden de aparición. **El `href` devuelto ES el `link` persistido → es la clave del diff.**
- `fetchUrl(url, fetchConfig, guard, signal): Promise<FetchOutcome>` (`urlFetcher.ts:71`) — **nunca lanza**; outcomes tipados `{ok:true, body, contentType, finalUrl} | {ok:false, reason: 'ssrf_blocked'|'scheme_disallowed'|'too_many_redirects'|'timeout'|'too_large'|'http_error'|'network_error'}`. Redirect-loop manual re-chequeando scheme+SSRF por hop; Layer A (`guard.isBlocked`) obligatorio (Layer B `connect.lookup` NO se invoca para IP literales); `AbortSignal.any([timeout, signal])`; byte-cap streaming.
- `createGuardedDispatcher(fetchConfig): GuardedDispatcher` (`ssrfGuard.ts:138`) / `GuardedDispatcher {enabled, dispatcher, isBlocked}` (`:121-130`) — construido en boot, inyectado; jamás módulo-singleton.
- `extractPageHints(body, contentType): PageHints | null` (`htmlText.ts:103`) — `null` ⇒ fallback a solo-texto.
- `enrich(model, input, signal): Promise<EnrichResult>` (`enrich.ts:192`) — lanza `EnrichmentError` (= fallo D1); prompt delimita contenido untrusted; bounds title(200)/description(1000); no traga `AbortError`.
- `EnrichmentChatModel` (`enrich.ts:47-52`) — interfaz estructural estrecha; en tests se fakea ESTO, nunca `BaseChatModel`.
- `buildEmbeddingText(title, description)` (`enrich.ts:222-224`) — "defined once so 7.3/7.4 reuse the exact same text when re-embedding". Úsala tal cual.
- Módulo-privados en `indexBatch.ts` a RELOCALIZAR (Task 1): `MAX_URLS_PER_MESSAGE = 20` (`indexBatch.ts:32`), `ResourceRow` (`:56-61`), `MessageOutcome` (`:63`), `processMessage` (`:73-115` — el loop por-URL completo con D1/D2), `persistMessage` (`:124-166` — nota: NO borra filas stale; el delete del diff es lógica nueva de 7.3).
- `indexer/types.ts` sigue exportando `Embedder`, `RawStreamEntry`, etc. — sync ya los importa.

### Link-diff — the pitfalls the design already resolved (do not re-litigate)

- **`chunk_key` es posicional** → identidad de fila por posición, identidad de RECURSO por `link`. El rebuild (F1) evita colisiones del unique index al rotar posiciones. No intentes un diff parcial con UPDATEs de chunk_key.
- **Filas legacy con `link: ''`** (placeholders 7.1/pre-7.3): nunca matchean un `href` extraído → cuentan como "removed" → se purgan en la primera edición. Correcto y deseado (el runbook clean-slate las elimina de todos modos).
- **Round-trip del vector**: la reutilización selecciona la columna `embedding` (pgvector custom type → `number[]`) y la reinserta tal cual. El integration test de "kept link" debe asertar igualdad del vector para blindar el round-trip drizzle/pgvector.
- **Mismo link dos veces**: `extractUrls` dedupea — el map viejo-por-link no necesita manejar duplicados nuevos; si hay filas viejas duplicadas por link (no debería), first-match gana.
- **Drizzle `inArray` con array vacío lanza** — guard `ids.length > 0` (convención `db/index.ts:22-26`).
- **`link` persiste la URL extraída (pre-redirect), NO `finalUrl`** — decisión ratificada en la review de 7.2 ("persist the URL the user shared"). El diff compara manzanas con manzanas.

### Test landscape — what breaks, what survives

- `processUpdate.test.ts` — **reescritura casi total**: asserts de chunking/placeholder (`inserted[0].description === 'edited content'`, `:163-174`), triggers BOOM/WRONGDIM vía `newContent` (el embedder ya no ve el contenido crudo sino `buildEmbeddingText`), y fixture con `knowledge.*` — todo muere. El gotcha 7.2 de `makeFakeDb` aplica: drizzle envuelve elementos de `inArray` en `Param {value}` — deriva los RETURNING sets de la where-condition, no de side-effects de inserts.
- `processDelete.test.ts` (8 casos) y `events.test.ts` — sobreviven; `events.test.ts` cambia SOLO el caso blank-`newContent` (ahora válido).
- `consumer.test.ts` — solo nivel deps (mock de `processUpdate` recibe `enrichModel`/`guard`).
- `sync.integration.test.ts` — caso update reescrito (hoy aserta `chunk_key = <id>:0` con description = contenido crudo); soft/hard delete y unknown-message sobreviven; fixture `knowledge` → fuera, `enrichment` → dentro (copia el shape de `indexBatch.integration.test.ts:31-60`).
- **Sin smoke nuevo**: 7.3 no añade lógica de prompt — reutiliza `enrich` intacto; `enrich.smoke.test.ts` (gated `ENRICHMENT_SMOKE=1`) ya cubre el standing DoD del LLM.
- Integration: parar contenedores app primero (`docker compose stop bot backend workers`); este Mac tiene DOS Redis (Homebrew :6379 vs compose sin puertos publicados) — los runs locales pegan al Homebrew.
- Runner: unit vía proyecto root `unit`; integration vía `npm run test:integration` (proyecto `workers-integration`, 15s timeouts, requiere `docker compose up -d postgres redis`).

### Previous story intelligence (7.2 + 6.2)

- **7.2 review P1 (HIGH)**: un throw que escapa el contrato "never throws" de `fetchUrl` = mensaje poison en PEL re-fetcheando para siempre. Si tocas cualquier capa del fetch path, respeta los outcomes tipados. La misma clase de bug aplica al nuevo processUpdate: clasifica ANTES de decidir ack.
- **7.2 review P3 (patrón 5.2)**: jamás tragar `AbortError` en un catch de fallback — rethrow si `signal.aborted`.
- **6.2 review**: embed SIEMPRE fuera de la tx (no sostener locks/pool a través de llamadas externas); logs de error con `streamId`+`stream` (AC-5 de 6.2, ya cableado en el catch actual — presérvalo); `parseUpdatedEvent` timestamp non-blank (poison-pill).
- **Convención logging**: jamás contenido de mensajes en logs (verificado en tests serializando cada arg logueado).
- **Shutdown drain**: 7s in-process / 35s compose — un update multi-URL puede no terminar; PEL replay es la red de seguridad. No alargues el drain.
- **Standing DoD**: patches de review se re-revisan como código nuevo; ids de test únicos por run (salt); "a test that lies" — verifica que los tests nuevos discriminan (revert-and-rerun del fix si hay duda).

### Git intelligence

Últimos commits relevantes (main @ c557b96, merge de PR #46): la 7.2 aterrizó el pipeline completo de enrichment + patches de review (`fix(workers): harden LLM enrichment…`, `cap URLs enriched per message`, `typed outcome on mid-body fetch failure`). Branch naming: `feat/7-3-sync-link-diff-reindex` (patrón `feat/<epic>-<story>-<slug>`). Commits convencionales `feat(workers):`/`fix(workers):`/`docs(repo):`/`chore(bmad):`.

### Project Structure Notes

- Nuevo: `packages/workers/src/enrichment/resourceRows.ts` (+ test) — relocación de `indexBatch.ts`, no código nuevo salvo el hook `reuse`.
- Reescrito: `packages/workers/src/sync/processUpdate.ts` (+ test), `sync.integration.test.ts` (caso update + casos nuevos).
- Tocado: `sync/types.ts` o deps-interfaces (enrichModel/guard), `sync/consumer.ts` (propagación), `sync/events.ts` (blank relax), `main.ts` (inyección + demolición clamp), `packages/workers/package.json` (−`@langchain/textsplitters`), `packages/shared/src/config/index.ts` (−`knowledge`), `Share2Brain.config.yml`(.example), fixtures.
- Borrado: `packages/workers/src/indexer/chunking.ts`, `chunking.test.ts`.
- Sin migración, sin cambio de `schema.ts`, sin dependencia nueva, sin cambio en bot/backend/web.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:25 (FR6), :51 (NFR6), :992-1011 (Épico 7)]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md §1 (decisiones), §2.3 (riesgos), §4 (propuestas)]
- [Source: docs/context/TECHNICAL-DESIGN.md §5.3:249-287 (pseudocódigo stale del Sync), §7:494-546 (pipeline 7.2 + clasificación de fallos), §8:563-616 (streams/eventos), §13:935-938 (sync config)]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2:49-53, AD-5:67-72, AD-13:117-139, §Deferred:313-323]
- [Source: docs/data-model.md:20 (ownership), :45-71 (embeddings), :123-129 (user_read_status), :205-220 (índices)]
- [Source: _bmad-output/implementation-artifacts/7-2-workers-indexer-extraccion-urls-fetch-ssrf-generacion-ia.md (D1-D4, enrichment surface, review patches)]
- [Source: _bmad-output/implementation-artifacts/6-2-worker-sync-re-indexacion-y-purgado.md (DECISIONs 1-5, notas #4/#5/#6)]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md §6.2/§7.2; operational-backlog.md P2.2/P2.3/P2.5, runbook clean-slate, Standing DoD]
- [Source: docs/bmad-story-mandatory-steps.md (gate + evidencia de idempotencia §3.2)]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

None — no blocking failures encountered; the two type errors caught by `tsc` (missing new
`ProcessUpdateDeps` fields in `sync.integration.test.ts`, `allowed_schemes` literal widening) were
fixed inline during Task 7/9 before the gate went green.

### Completion Notes List

- Task 1: `processMessage`/`ResourceRow`/`MessageOutcome`/`MAX_URLS_PER_MESSAGE` relocated
  `indexBatch.ts` → `enrichment/resourceRows.ts` as `buildResourceRows`, with an optional `reuse`
  lookup (kept-link fast path). `indexBatch.ts` re-imports without `reuse` — its existing test
  suite passes unchanged (29 tests across both files after adding `resourceRows.test.ts`).
- Task 2: `sync/processUpdate.ts` rewritten as rebuild-by-diff — tombstone/unknown guard (select
  `id, deleted_at`), old-rows diff select via the drizzle query builder (needed for the pgvector
  column's `mapFromDriverValue`, unlike a raw `db.execute`), `buildResourceRows` with the reuse
  lookup, embed only fresh rows outside the tx, single-tx wipe-and-reinsert with
  `onConflictDoUpdate`, XACK only after commit.
- Task 3: `parseUpdatedEvent` relaxed (`newContent ?? ''`, no non-blank check); `timestamp` stays
  mandatory non-blank.
- Task 4: `ProcessUpdateDeps`/`RunSyncDeps` gained `enrichModel`/`guard`/`signal`; `main.ts` injects
  the SAME boot-built `enrichModel`/`guard` used by the Indexer into `runSync`.
- Task 5: `indexer/chunking.ts`+test deleted; `@langchain/textsplitters` dropped from
  `packages/workers/package.json`; `main.ts`'s `MAX_CHUNK_SIZE` import + clamp warning removed;
  `knowledge` block removed from `Share2BrainConfigSchema`, `Share2Brain.config.yml`(.example), and the
  `packages/shared/src/config/index.test.ts` fixture.
- Task 6: `processUpdate.test.ts` rewritten (17 cases: tombstone/unknown guards, added/kept/
  removed/reordered diff, late-index-entry, cap-20, LLM/embed failure no-ack, content-never-logged);
  `consumer.test.ts` updated with fixed `enrichModel`/`guard` fakes (mocked processors, never
  invoked); `resourceRows.test.ts` added (11 cases incl. the reuse hook).
- Task 7: `sync.integration.test.ts` rewritten against real Postgres + an ephemeral local HTTP
  server (11 cases: new-link enrich + kept-link exact-embedding reuse, late index entry, removed-
  link purge + read-status cascade, zero-LLM-calls on a text-only edit, zero-URL purge, redelivery
  convergence, tombstone/unknown no-ops, LLM failure → PEL, soft/hard delete unchanged). The vector
  round-trip assertions compare against a value fetched through the SAME raw-`execute` read path
  pre/post-update (not the raw JS seed literal), isolating "does the reuse path perturb the vector"
  from float4 storage precision.
- Task 8: `TECHNICAL-DESIGN.md` §5.3 Sync pseudocode rewritten to the diff pipeline; the stale
  "sigue vivo... hasta la Historia 7.3" §7 parenthetical and the §13 `knowledge:` config sample
  removed; a stale `config.knowledge.topK` retrieve-node snippet fixed to the real
  `RETRIEVE_TOP_K` constant. `ARCHITECTURE-SPINE.md` §Deferred batching entry updated to "retired".
  `data-model.md`'s `indexed_at` note extended to cover the Sync worker's re-stamp on every edit.
  Also fixed two docs that would otherwise contradict the removed `knowledge` block:
  `docs/context/PRD.md`'s config sample and a stale bullet in `docs/backend-standards.md`.
- Task 9: full gate green — see verification evidence below.

**Verification evidence (§3.1/§3.2 of `docs/bmad-story-mandatory-steps.md`):**
- `npm run lint` → 0 errors.
- `npm run test` (unit+web) → 787 passed, 1 skipped (85 files).
- `npm run build` → clean across all 5 packages.
- `npm run test:integration` (backend+bot+workers, real Postgres+Redis) → 118 passed (19 files).
- `npm run test:e2e -w @share2brain/web` → 13/13 chromium passed, pass-count unchanged (this story
  touches no `@share2brain/web` code).
- Idempotency evidence (§3.2): `sync.integration.test.ts` — "should converge to the same single
  row on redelivery of the same update event (idempotency, AD-13)" redelivers the identical
  `MessageUpdatedEvent` twice against a real DB and asserts exactly one row survives with zero
  re-enrichment on the second pass.
- No schema/DDL change, no new dependency, no bot/backend/web behavior change — nothing to restore
  beyond each integration test's own `afterAll` cleanup (already self-contained).
- §3.3 (API endpoints) and §3.4 (Playwright UI verification beyond the unchanged full run) are not
  applicable — this story touches no HTTP endpoint and no `@share2brain/web` UI code.

### File List

**Added:**
- `packages/workers/src/enrichment/resourceRows.ts`
- `packages/workers/src/enrichment/resourceRows.test.ts`

**Modified:**
- `packages/workers/src/indexer/indexBatch.ts`
- `packages/workers/src/sync/processUpdate.ts`
- `packages/workers/src/sync/processUpdate.test.ts`
- `packages/workers/src/sync/events.ts`
- `packages/workers/src/sync/events.test.ts`
- `packages/workers/src/sync/consumer.ts`
- `packages/workers/src/sync/consumer.test.ts`
- `packages/workers/src/sync/sync.integration.test.ts`
- `packages/workers/src/main.ts`
- `packages/workers/package.json`
- `packages/shared/src/config/index.ts`
- `packages/shared/src/config/index.test.ts`
- `Share2Brain.config.yml`
- `Share2Brain.config.yml.example`
- `docs/context/TECHNICAL-DESIGN.md`
- `docs/context/ARCHITECTURE-SPINE.md`
- `docs/data-model.md`
- `docs/context/PRD.md`
- `docs/backend-standards.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/7-3-workers-sync-reindexacion-por-diff-de-links-y-purgado.md`

**Deleted:**
- `packages/workers/src/indexer/chunking.ts`
- `packages/workers/src/indexer/chunking.test.ts`

## Change Log

- 2026-07-09 — Story implemented (bmad-dev-story). Sync worker rewritten as the link-diff
  reconciler: kept links reuse title/description/embedding (zero fetch/LLM/embed), new/changed
  links run the 7.2 pipeline via `buildResourceRows` (relocated from `indexer/indexBatch.ts` with
  an optional `reuse` hook), persistence is a single-tx wipe-and-reinsert keyed on the new
  positional `chunk_key`. Zero-URL/blank edits purge all rows; tombstoned/unknown messages are
  ack'd no-ops. `enrichModel`/`guard` now injected into `runSync`/`processUpdate` from the same
  boot-built instances the Indexer uses. Demolished `chunking.ts`, `@langchain/textsplitters`, and
  the `knowledge` config block repo-wide (code + `Share2Brain.config.yml`(.example) + fixtures + stale
  doc references). Gate green: lint 0 / 787 unit+web / build clean (5 pkgs) / 118 integration (19
  files) / 13 e2e chromium unchanged. No migration, no schema change, no new dependency, no
  bot/backend/web behavior change. Status: review.
- 2026-07-09 — Story created (bmad-create-story). 3 forks confirmed with Borja: F1 rebuild-by-diff (in-tx wipe+reinsert, kept links reuse title/description/embedding — no fetch/LLM/embed; read-status loss on edit accepted, 6.2 precedent), F2 kept links NOT re-enriched on text-only edits, F3 zero-URL/blank edit purges all rows (parse relaxed, closes 6.2 edit-to-blank deferral). Status: ready-for-dev.

### Review Findings

Code review 2026-07-09 (bmad-code-review): 3 adversarial layers (Blind Hunter, Edge Case
Hunter, Acceptance Auditor) + reviewer cross-check. **Acceptance Auditor found 0 AC violations
— AC-1…AC-9 and F1-F3/D1-D9 all verified satisfied.** 2 Low patches, 4 deferred, 7 dismissed.
Re-review pass adversarially verified both patches (CONFIRMED correct, 0 regressions); 2
regression tests added to `processUpdate.test.ts` (stale-width reused-vector rejection; abort→debug
branch), each discrimination-checked by revert-and-rerun. Gate on affected code: lint 0, 19/19
processUpdate unit green, `tsc` clean.

- [x] [Review][Patch] Reused (kept-link) embeddings skip `assertEmbeddingDimensions` [packages/workers/src/sync/processUpdate.ts:127] — only `freshVectors` are width-checked; a pure-reuse edit (every link kept) inserts old vectors with no assertion. Harmless in supported flows (the column is fixed-width `NOT NULL vector(N)`, so a mismatch is a DB-rejected poison replay, not silent corruption), but asserting the full `embeddedRows` set before the tx is one-line insurance that turns a late DB error into an early clear one. (blind+edge) **FIXED 2026-07-09**: assertion moved to iterate every `embeddedRows` row (fresh + reused) before the tx.
- [x] [Review][Patch] Abort mid-update logged as `error` instead of expected-shutdown `debug` [packages/workers/src/sync/processUpdate.ts:191] — behavior is correct (`{ack:false}` → PEL replay, no false success), but a clean SIGTERM mid-fetch/enrich is recorded as a failure, indistinguishable from a real error to alerting. Task 2 named "rethrow-aware con abort (patrón 7.2 P3)"; the catch doesn't special-case `signal.aborted`. Fix: log at `debug` when `signal.aborted`. (blind+auditor) **FIXED 2026-07-09**: catch now logs `debug` when `signal.aborted`, `error` otherwise.
- [x] [Review][Defer] `discord_messages` content UPDATE has no edit-timestamp ordering guard [packages/workers/src/sync/processUpdate.ts:150] — deferred, pre-existing (6.2 behavior; last-write-by-arrival is the ratified model). Out-of-order redelivery of two edits can regress content to the older text.
- [x] [Review][Defer] Concurrent Indexer `created` vs Sync `updated` race can let the slower writer's stale rows win [packages/workers/src/sync/processUpdate.ts:89] — deferred, ratified AD-13/D7 last-write-wins convergence, inherent to the two-stream model; the out-of-tx `oldRows` read + reuse widens the stale-snapshot window slightly.
- [x] [Review][Defer] `newContent` length unbounded before the regex scan [packages/workers/src/sync/events.ts:32] — deferred, pre-existing pattern shared with `parseCreatedEvent`; Discord caps message size and the bot is the sole producer.
- [x] [Review][Defer] `embedder.embedDocuments` not passed the abort signal [packages/workers/src/sync/processUpdate.ts:123] — deferred, pre-existing, shared with the Indexer; the 7s/35s drain bounds a hanging embedder.

**Dismissed (7):** F3 empty-content-purge "destroys data" (Blind High) — ratified design decision; Bot 6.1 fetches full content before publishing so empty `newContent` only occurs on a genuine clear; Auditor confirmed AC-2 correct. Updated-before-created drops the edit — ratified AC-3/D2 (create path owns insertion). Kept-link read-status loss on edit — explicitly accepted F1 cost ("exactly what 6.2 does today"). Kept link beyond the cap-20 purged — ratified D6 cap, pathological. Duplicate-URL double-enrichment — false positive, `extractUrls` dedupes by `href`. URL-cap warning lacks caller context — nit. AC-4 content-leak test mocks past a real `EnrichmentError` — verified: all three `EnrichmentError` messages are static strings with no content interpolation, so the "never log content" guarantee holds.
