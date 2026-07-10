# Validation Report — Share2Brain Self-Hosted

- **PRD:** `docs/PRD.md`
- **Rubric:** `.claude/skills/bmad-prd/assets/prd-validation-checklist.md`
- **Run at:** 2026-06-30T00:00:00Z
- **Grade:** Poor

## Overall verdict

Este PRD es técnicamente sólido a nivel de infraestructura — un ingeniero podría comenzar la implementación — pero falla como documento de decisión de producto: no tiene preguntas abiertas, no hay etiquetas de asunción, no hay marcado MVP/v1 por FR, y la persona principal (Miembro) carece de journeys documentados. Un PM no puede delimitar el MVP ni validar la tesis solo con este documento.

El revisor adversarial añade tres riesgos estructurales que elevan la calificación a Poor: las métricas de éxito son aspiracionales sin base de validación, el read tracking generará una explosión de datos a escala de comunidad no trivial, y el alcance del "MVP" es en realidad un producto completo de varios meses. La falta de comportamiento definido ante caídas del API del LLM es la omisión operacional más grave.

## Dimension verdicts

- Decision-readiness — **Thin**
- Substance over theater — **Adequate**
- Strategic coherence — **Adequate**
- Done-ness clarity — **Strong**
- Scope honesty — **Thin**
- Downstream usability — **Adequate**
- Shape fit — **Adequate**

## Findings by severity

### Critical (4)

**[Adversarial]** — Métricas de éxito son aspiracionales sin base de validación (§16)
SM-1 (>70% preguntas resueltas sin intervención humana) y SM-2 (>95% respuestas con fuente citada) se presentan como targets sin baseline, investigación de usuarios ni benchmark. SM-7 (>60% documentos marcados como leídos) asume comportamiento voluntario sin precedente en cultura Discord.
Fix: Reemplazar targets duros con proxies instrumentados medibles al lanzamiento, y etiquetar todos los SM targets como "aspiracionales — a validar en beta."

**[Adversarial]** — Read tracking generará explosión de datos a escala de comunidad (§4.8, §5.2)
500 miembros × 50.000 embeddings = 25.000.000 filas en user_read_status. El endpoint mark-all necesita insertar ~100.000 filas en una sola transacción. Sin límite de batch, paginación, ni upper bound.
Fix: Definir tamaño máximo de comunidad soportado. Considerar modelo inverso "no-leído desde timestamp" o bitset en lugar de acknowledgment positivo por embedding.

**[Adversarial]** — MVP no es realmente un MVP (§15)
El alcance MVP incluye Discord bot + backfiller + sync + web UI + RAG chat + read tracking + RBAC + YAML config + notificaciones + Docker Compose + tests. Esfuerzo de varios meses para un developer individual. RBAC y sync listados como v1 en §15 pero especificados como componentes requeridos en §4 — contradicción que causará scope arguments.
Fix: Definir MVP como el artefacto deployable más pequeño con valor demostrable: bot indexa + chat con citas. Mover read tracking y RBAC a v1.

**[Adversarial]** — Caída del API LLM no manejada (§4.2, §11.2)
El agent runtime llama un API LLM externo sin circuit breaker, modo degradado definido, ni contrato de error de cara al usuario. El health check no testea reachability del LLM API.
Fix: Definir comportamiento de fallo explícito: error visible al usuario con guía de retry, estado LLM en /health, comportamiento en modo degradado documentado.

### High (11)

**[Rúbrica — Decision-readiness]** — Sin preguntas abiertas documentadas (§ todo el documento)
Un producto AI self-hosted con cero preguntas abiertas es señal de alerta. Comportamiento ante errores, ruta de migración, modo degradado — ninguno surfaceado.
Fix: Añadir tabla "Preguntas Abiertas" antes de §14 con al menos 5–8 ítems sin resolver, con propietario y condición de revisión.

**[Rúbrica — Decision-readiness]** — Alcance MVP no trazable a FRs individuales (§4, §11, §15)
SB-16, SB-17, SNF-13–17 (listados como v1 en §15) aparecen sin etiqueta de fase en §4 y §11.
Fix: Añadir columna "Fase" a tablas de componentes y NFRs, o sufijo "(v1)" en filas fuera del alcance MVP.

**[Rúbrica — Strategic coherence]** — SO-7 "Datos bajo control" contradicho por uso del API LLM (§2.2, §4.2, §13)
El sistema envía contenido de mensajes a Anthropic/OpenAI para embeddings e inferencia. Nunca reconocido como tensión con la promesa self-hosted.
Fix: Añadir nota a SO-7 aclarando que "bajo control" es datos en reposo. Reconocer procesamiento del proveedor LLM en §13.

**[Rúbrica — Scope honesty]** — Sin asunciones etiquetadas (§ todo el documento)
Al menos cuatro asunciones load-bearing: OAuth redirect URL pública, costos de embedding negligibles, adecuación del rate limit Discord, calidad del modelo de embedding.
Fix: Añadir §0.1 Tabla de Asunciones con [ASSUMPTION] tags y plan de validación.

**[Rúbrica — Downstream usability]** — "Embedding" expuesto como identificador de cara al usuario en la API (§4.2, §4.8)
/api/read-status/:embeddingId expone un concepto de infraestructura como API de usuario. La entidad de cara al usuario debería ser "fragmento" o "documento indexado."
Fix: Introducir término de cara al usuario en el Glosario y renombrar la ruta API.

**[Adversarial]** — Caída del Discord Gateway rompe la indexación en tiempo real silenciosamente (§4.1, §13)
Si el bot se desconecta, mensajes se pierden. Sync on start solo funciona si el operador nota y reinicia. Si el bot está caído 48h, el gap puede superar backfill_limit.
Fix: Almacenar último snowflake visto por canal; backfill desde ese punto. Definir alerta de monitoreo ante ausencia de eventos en N minutos.

**[Adversarial]** — Staleness de cache RBAC crea ventana de seguridad (§4.6, §9 SS-9, SD-14)
Revocación de rol en Discord tarda hasta 5 minutos en aplicarse en Share2Brain. En escenario disciplinario es un problema real.
Fix: Añadir endpoint de invalidación de cache (solo admin). Documentar: "TTL <60s causará presión de rate limit en Discord API."

**[Adversarial]** — Sin estrategia de backup o recuperación especificada (§12, §17)
El checklist menciona backup como checkbox pero no especifica frecuencia, retención, procedimiento de restore, ni qué ocurre con user_read_status tras un restore.
Fix: Añadir sección con contrato mínimo de backup: pg_dump diario, cadencia de snapshot, procedimiento de restore. Incluir en Share2Brain.config.yml.

**[Adversarial]** — Historial de conversación "summary memory" sin especificar (§4.2)
No se define: estrategia de resumen, cuántos turnos antes de resumir, presupuesto de context window, cómo se almacena el resumen.
Fix: Especificar estrategia de memoria: rolling window de N mensajes o ConversationSummaryBufferMemory con presupuestos de tokens. Vincular al límite de context window del LLM configurado.

**[Adversarial]** — Tool search_web con permission: auto es una responsabilidad (§4.6 config)
Permite al agente invocar búsqueda web sin confirmación. Proveedor no nombrado, costo impredecible, riesgo de citar fuentes externas que contradicen el conocimiento de la comunidad.
Fix: Mover search_web a fase "Posterior". Si se mantiene, nombrar el proveedor, definir controles de costo, cambiar default a permission: "ask".

**[Adversarial]** — Rate limits Discord API para guilds/{guild_id}/member no cuantificados (§4.7)
Cada login dispara una llamada a Discord API. Con 100 usuarios logueándose tras reinicio del servicio, puede saturar el rate limit (1 req/seg por ruta).
Fix: Debounce por login: si existe entrada de cache válida, omitir la llamada Discord al login. Documentar el techo de rate limit y throughput de login soportable.

### Medium (19)

**[Rúbrica — Decision-readiness]** — Sin comportamiento de degradación/fallback (§4.2) — Fix: Subsección "Modos de fallo" en §4.2 y §4.1.

**[Rúbrica — Decision-readiness]** — Default soft-delete no justificado como trade-off (§4.6, SD-11) — Fix: Declarar riesgo reconocido en SD-11 y propietario de la decisión.

**[Rúbrica — Substance over theater]** — Admin del guild sin requisitos trazables (§3, §2.3) — Fix: Eliminar persona Admin o añadir flujo Admin concreto.

**[Rúbrica — Substance over theater]** — Miembro sin user journey (§3) — Fix: Añadir §3.2 Flujo del miembro con 5–6 pasos.

**[Rúbrica — Strategic coherence]** — SM-3/SM-4 duplican targets NFR (§16) — Fix: Reemplazar con métricas de outcome de producto.

**[Rúbrica — Strategic coherence]** — Sin counter-metrics nombradas (§16) — Fix: Añadir counter-metric para SM-1 y SM-2.

**[Rúbrica — Done-ness clarity]** — Manejo de attachments y embeds implícito (§4.1, §5.2) — Fix: Una frase en §4.1 o no-goal explícito en §2.3.

**[Rúbrica — Done-ness clarity]** — Tool sandboxing especificado pero no definido (§9 SS-5, §4.2) — Fix: 2–3 líneas definiendo scope del sandbox en §9.

**[Rúbrica — Scope honesty]** — Límites de fase del roadmap sin criterios de decisión (§15) — Fix: 1–2 criterios objetivos por transición de fase.

**[Rúbrica — Scope honesty]** — Distinción Operador vs Admin subdesarrollada (§3) — Fix: Declarar si Operador = Admin es restricción requerida o asunción.

**[Rúbrica — Downstream usability]** — Sin sección de Glosario (§ todo el documento) — Fix: Añadir §0.2 Glosario con términos canónicos.

**[Rúbrica — Downstream usability]** — ID namespace cruza múltiples componentes sin mapeo (§4) — Fix: Prefijar IDs por componente (BOT-, API-, UI-).

**[Rúbrica — Shape fit]** — Comportamiento de cara al miembro vastamente sub-especificado (§3, §4.3, §4.8) — Fix: Añadir §4.3.1 con el journey miembro a nivel de interacción UI.

**[Adversarial]** — Estrategia de chunking arbitraria (§4.6) — Fix: Especificar pipeline agrupamiento-luego-chunking; mínimo de caracteres por grupo.

**[Adversarial]** — Soft-delete crea citas desactualizadas (§4.1 step 7) — Fix: Requerir explícitamente filtro WHERE deleted_at IS NULL en queries de recuperación.

**[Adversarial]** — OAuth2 redirect URI no especificado (§4.7) — Fix: Añadir DISCORD_REDIRECT_URI a .env.example y documentar configuración del dashboard Discord.

**[Adversarial]** — Redis en producción puede evictar eventos de indexación silenciosamente (§7.2, §4.5) — Fix: Establecer maxmemory-policy noeviction para Redis de cola de eventos.

**[Adversarial]** — Sin expiración de sesión especificada (§5.2) — Fix: Especificar TTL de sesión como valor configurable y definir mecanismo de limpieza.

**[Adversarial]** — mark-all endpoint sin scope de autorización definido (§4.2) — Fix: Añadir reglas de autorización explícitas: un usuario solo puede marcar embeddings en canales a los que tiene acceso RBAC.

### Low (12)

**[Rúbrica — Strategic coherence]** — SM-5 es métrica de ingeniería en tabla de éxito de producto (§16) — Fix: Mover exclusivamente a §11.3.

**[Rúbrica — Done-ness clarity]** — grouping_window: 10 sin unidad (§4.6) — Fix: Clarificar unidad en schema o comentario YAML.

**[Rúbrica — Done-ness clarity]** — memory: 2G sin justificación (§7.2) — Fix: Añadir SNF de huella de memoria o comentar la cifra.

**[Rúbrica — Scope honesty]** — "Lista de canales a excluir" en §13 no está en §4.6 — Fix: Aclarar que enabled: false es el mecanismo de exclusión.

**[Rúbrica — Downstream usability]** — Sin user journeys con protagonistas nombrados (§3) — Fix: Añadir §3.2 Flujo del miembro con protagonista nombrado.

**[Rúbrica — Shape fit]** — Typo "ENsamBLAR CONTEXTO" (§4.2) — Fix: Corregir a "ENSAMBLAR CONTEXTO."

**[Rúbrica — Shape fit]** — Docker Compose version: '3.8' deprecado (§7.1, §7.2) — Fix: Eliminar la clave version: de ambos compose files.

**[Rúbrica — Mechanical]** — docker-compose.prod.yml tiene DISCORD_CLIENT_SECRET en environment: Y en secrets: — Fix: Eliminar la duplicación; usar solo Docker secrets en producción.

**[Adversarial]** — docker-compose.yml expone PostgreSQL en 0.0.0.0:5432 en dev (§7.1) — Fix: Enlazar a 127.0.0.1:5432:5432.

**[Adversarial]** — Interpolación ${ENV_VAR} en YAML sin especificar el parser (§4.6) — Fix: Documentar que loader.ts resuelve ${VAR} contra process.env.

**[Adversarial]** — Sin estrategia de versionado para Share2Brain.config.yml (§4.6, SD-2) — Fix: Añadir campo version: "1.0" y definir estrategia de migración.

**[Adversarial]** — backfill_limit: 1000 tiene unidad ambigua (§4.6) — Fix: Documentar unidad (mensajes, no páginas) y delay entre requests.

## Mechanical notes

- **Drift de glosario** — "fragmento" (§2.3, §4.8), "documento" (§4.3, §16), "embedding" (§4.2, §4.8, §5.1), "chunk" (§4.6) refieren al mismo concepto sin término canónico.
- **IDs no-continuos** — SB-1 a SB-17 cruza tres componentes en un único namespace sin mapeo visible.
- **SNF no-continuo** — SNF-6–9 en §11.2, SNF-10–12 en §11.3, SNF-13–17 de vuelta a §11.1. Numeración no sigue orden de sección.
- **Gap de cross-reference** — §13 menciona "Lista de canales a excluir" inexistente; el mecanismo real es enabled: false.
- **Duplicación SM/NFR** — SM-3 = SNF-1; SM-4 = SNF-2; SM-5 = SNF-10. Listados en dos secciones sin cross-reference.
- **docker-compose.prod.yml** — DISCORD_CLIENT_SECRET duplicado en environment: y secrets:.
- **Typo** — §4.2 "ENsamBLAR CONTEXTO" — casing mixto.

## Reviewer files

- `review-rubric.md`
- `review-adversarial.md`
