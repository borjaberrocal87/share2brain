---
stepsCompleted: ["step-01", "step-02", "step-03", "step-04", "step-05", "step-06"]
documents:
  prd: "_bmad-output/planning-artifacts/prds/prd-share2brain-2026-06-30/validation-report.md"
  architecture_spine: "_bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/ARCHITECTURE-SPINE.md"
  architecture_technical: "_bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md"
  epics: "_bmad-output/planning-artifacts/epics.md"
  ux: "docs/design/Share2Brain Web.dc.html"
  prd_source: "docs/PRD.md"
---

# Implementation Readiness Assessment Report

**Date:** 2026-06-30
**Project:** Share2Brain Self-Hosted

---

## Análisis del PRD

### Requisitos Funcionales extraídos (PRD §4 + implicit en flujos)

| ID | Requisito |
|----|-----------|
| FR1 | Bot conecta al Gateway y escucha `messageCreate`; filtra bots y canales no habilitados; publica a Redis Streams |
| FR2 | Bot hace backfill histórico al iniciar, desde `last_seen_message_id` por canal (snowflake) o `backfill_limit` si es el primer arranque; canales secuenciales |
| FR3 | Bot detecta `messageUpdate` en canales habilitados y publica `discord.message.updated` a Redis |
| FR4 | Bot detecta `messageDelete` en canales habilitados y publica `discord.message.deleted` a Redis |
| FR5 | Worker Indexer: consume `share2brain:discord:messages`, agrupa por `grouping_window`, chunking (`chunk_size`/`chunk_overlap`), genera embeddings con `text-embedding-3-small` (1536d), UPSERT en pgvector |
| FR6 | Worker Sync: consume `discord.message.updated`; elimina embedding anterior; re-indexa con nuevo contenido |
| FR7 | Worker Sync: consume `discord.message.deleted`; soft delete (`deleted_at`) o hard delete según `delete_policy` |
| FR8 | Sync al iniciar: compara Discord vs indexados; publica eventos de sync para ediciones/borrados ocurridos offline |
| FR9 | Backend: Discord OAuth2 (scopes `identify` + `guilds.members.read`); verifica membresía en guild; crea sesión en Redis |
| FR10 | Backend: RBAC per-request — expande `discordRoles → allowedChannelIds` uniendo sesión contra `channel_permissions`; upsert de `channel_permissions` desde config al arrancar |
| FR11 | Backend: `GET /api/search` con búsqueda vectorial y filtro RBAC obligatorio (`WHERE channel_id = ANY(:allowed)`) |
| FR12 | Backend: `GET /api/documents` — listado paginado de fragmentos con metadatos (canal, autor, fecha), filtrado por canales accesibles |
| FR13 | Backend: Agente RAG como LangGraph StateGraph (`retrieve → reason → respond`) con streaming SSE en `POST /api/chat`; responde solo con info indexada; cita canal, autor, fecha; indica explícitamente si no hay información |
| FR14 | Agente RAG: historial de conversación con compresión cuando supera `agent.memory_window` (default 20 turnos / 4000 tokens) |
| FR15 | Backend: read tracking — marcar como leído, no leído, mark-all en batch de 1.000, conteo de no leídos |
| FR16 | Web App: vista Búsqueda — barra, resultados por relevancia, badges No leído/Leído, filtros por canal y estado lectura |
| FR17 | Web App: vista Documentos — listado paginado de fragmentos con badges y filtros |
| FR18 | Web App: chat floating widget — envío, streaming SSE token-a-token (fetch, no EventSource), visualización de citas |
| FR19 | Web App: sidebar con conteo de no leídos por canal y botón marcar canal como leído |
| FR20 | `GET /health` — estado de cada componente (database, redis, discord, indexer); HTTP 503 si algún componente está degradado |
| FR21 | Notificaciones Telegram/Slack al operador: backfill completado, nuevo contenido, errores críticos, sync completado, mensajes editados/borrados, servicio iniciado |
| FR22 | Configuración completa via `Share2Brain.config.yml` + `.env`; validados por `loadConfig()` al arrancar; fallo rápido si inválido |
| FR23 | Despliegue con `docker compose up -d`; servicio `migrator` one-shot con migraciones Drizzle antes del resto |

**Total FRs PRD: 23**

### Requisitos No Funcionales extraídos (PRD §11)

| ID | Requisito | Target |
|----|-----------|--------|
| NFR1 | Búsqueda vectorial P95 | < 200ms |
| NFR2 | Tiempo respuesta agente P95 | < 5s |
| NFR3 | Primer chunk streaming SSE | < 100ms |
| NFR4 | Indexación asíncrona | No bloquear bot |
| NFR5 | Backfill con rate limiting (Retry-After, 1s min entre páginas, canales secuenciales) | No saturar Discord API |
| NFR6 | Latencia re-indexación por edición | < 5s |
| NFR7 | Latencia purgado por borrado | < 3s |
| NFR8 | Sync post-reinicio 1000 msgs | < 60s |
| NFR9 | Overhead RBAC en search | < 10ms |
| NFR10 | `/health` responde en < 500ms; HTTP 200 healthy / HTTP 503 degraded | |
| NFR11 | Restart contenedor < 30s; alerta si > 3 reinicios en 5 min | |
| NFR12 | Graceful shutdown: 10s para requests en curso; nuevas peticiones → HTTP 503 | |
| NFR13 | Errores HTTP 5xx capturados por Sentry con stack trace y contexto | |
| NFR14 | Unit tests > 80% cobertura | |
| NFR15 | Integration tests: Discord bot + pgvector | |
| NFR16 | E2E tests: flujos de búsqueda y chat | |
| NFR17 | Cookies httpOnly + Secure; secretos en Docker secrets / .env | |
| NFR18 | Rate limiting: global 100 req/15min, chat 20 msg/min, auth 10 intentos/15min | |
| NFR19 | Validación de inputs con Zod en cada endpoint | |
| NFR20 | Headers de seguridad: CSP, HSTS, X-Frame-Options | |
| NFR21 | SQL parametrizado (no string interpolation) | |
| NFR22 | Sesiones con TTL configurable (default 7 días); limpieza de expiradas al inicio y cada 24h | |

**Total NFRs PRD: 22**

### Requisitos adicionales implícitos en PRD

- **SS-9**: Endpoint `POST /api/admin/roles/invalidate/:userId` para invalidación inmediata de roles (mencionado en §9.1 y SD-14)
- **SS-10**: Backup diario con `pg_dump`; retención mínima 7 días; responsabilidad del Operador
- **SD-11**: Filtro `WHERE deleted_at IS NULL` en todas las queries de recuperación (embeddings de mensajes borrados soft excluidos de búsqueda)

---

## Validación de Cobertura de Épicos

### Matriz de Cobertura FR

| FR | Cobertura en épicos | Historia | Estado |
|----|--------------------|---------:|--------|
| FR1 | Bot: listener messageCreate → Redis Streams | 3.1 | ✅ Cubierto |
| FR2 | Bot: backfill reconciliado por snowflake | 3.2 | ✅ Cubierto |
| FR3 | Bot: listener messageUpdate | 6.1 | ✅ Cubierto |
| FR4 | Bot: listener messageDelete | 6.1 | ✅ Cubierto |
| FR5 | Workers: Indexer (chunking + embeddings → pgvector) | 3.3 | ✅ Cubierto |
| FR6 | Workers: Sync re-indexación por edición | 6.2 | ✅ Cubierto |
| FR7 | Workers: Sync purgado por borrado | 6.2 | ✅ Cubierto |
| FR8 | Workers: Sync al inicio (reconciliación) | 6.3 | ✅ Cubierto |
| FR9 | Discord OAuth2 + sesiones en Redis | 2.3 | ✅ Cubierto |
| FR10 | Middleware RBAC (roles → allowedChannelIds) | 2.4 | ✅ Cubierto |
| FR11 | API búsqueda semántica con filtro RBAC | 4.1 | ✅ Cubierto |
| FR12 | API listado paginado de documentos | 4.2 | ✅ Cubierto |
| FR13 | Agente RAG LangGraph StateGraph + SSE | 5.1 | ✅ Cubierto |
| FR14 | Historial de conversación con compresión | 5.2 | ✅ Cubierto |
| FR15 | Read tracking: todos los endpoints | 4.2 | ✅ Cubierto |
| FR16 | Web App: vista Búsqueda | 4.3 | ✅ Cubierto |
| FR17 | Web App: vista Documentos | 4.4 | ✅ Cubierto |
| FR18 | Web App: chat floating widget | 5.3, 5.4 | ✅ Cubierto |
| FR19 | Web App: sidebar con conteo de no leídos | 4.4 | ✅ Cubierto |
| FR20 | Endpoint GET /health con estado de componentes | 1.3 | ✅ Cubierto |
| FR21 | Notificaciones Telegram/Slack al operador | 6.4 | ⚠️ Parcial |
| FR22 | Configuración YAML + .env + loadConfig() | 1.2 | ✅ Cubierto |
| FR23 | Docker Compose 7 servicios + migrator one-shot | 1.3 | ✅ Cubierto |

**Cobertura: 22/23 FRs completamente cubiertos, 1 parcial**

### Gaps Identificados

#### GAP-1 — IMPORTANTE: Historia 5.1 no filtra `deleted_at IS NULL` en RAG

**Historia afectada:** 5.1 (Endpoint SSE de Chat con Pipeline RAG)

**Descripción:** El AC de Historia 5.1 especifica que el nodo `retrieve` filtra por `allowedChannelIds`, pero **no menciona el filtro `WHERE deleted_at IS NULL`**. El PRD Threat Model (§13) exige explícitamente que la cadena de recuperación filtre siempre mensajes con soft-delete. Sin este filtro, el agente RAG podría citar mensajes que el operador ha marcado como borrados.

**Impacto:** Violación de seguridad / consistencia — un mensaje soft-deleted puede aparecer en respuestas del agente aunque ya no exista en Discord.

**Recomendación:** Añadir al AC de Historia 5.1: `**Y** el nodo retrieve excluye fragmentos de mensajes con \`deleted_at IS NOT NULL\` en el join con \`discord_messages\``

---

#### GAP-2 — IMPORTANTE: Historia 6.4 especifica rate limit incorrecto

**Historia afectada:** 6.4 (Notificaciones, Seguridad y Graceful Shutdown)

**Descripción:** El AC dice `máx. 100 req/min por IP`, pero PRD §9.2 y NFR18 en epics.md especifican `100 req/15 minutos` (ventana de 15 min, no 1 min). La discrepancia es de 15× — el story AC es 15 veces más permisivo que el requisito.

**Impacto:** El dev agent implementará un rate limit 15 veces más laxo que el especificado.

**Recomendación:** Corregir AC de Historia 6.4: `máx. 100 req/15 min por IP` (consistente con NFR18 y PRD §9.2).

---

#### GAP-3 — MODERADO: FR21 notificaciones — ACs no cubren todos los eventos

**Historia afectada:** 6.4 (FR21)

**Descripción:** El único AC de notificaciones en Historia 6.4 cubre solo "error crítico". PRD §10.3 lista 8 eventos a notificar: backfill completado, nuevo contenido indexado, error en indexación, servicio iniciado, errores críticos, mensaje editado, mensaje borrado, sync completado. Los ACs no verifican los otros 7 eventos.

**Impacto:** Un dev agent siguiendo los ACs podría implementar solo notificaciones de error crítico y pasar todos los tests. Los demás eventos del §10.3 quedarían sin implementar.

**Recomendación:** Añadir ACs adicionales a Historia 6.4 para: backfill completado, sync completado, servicio iniciado, nuevo contenido indexado.

---

#### GAP-4 — MODERADO: `user_roles_cache` tabla en schema sin historia que la use

**Historia afectada:** 1.2 (schema), ninguna la utiliza

**Descripción:** Historia 1.2 incluye `user_roles_cache` en el Drizzle schema. Sin embargo, ninguna historia lee de esta tabla ni escribe en ella para el propósito descrito en PRD SD-14 (cache TTL de roles de Discord entre sesiones). La arquitectura (AD-10) dice que los roles se almacenan en la sesión Redis al autenticarse, lo que cubre el caso de uso inmediato.

**Impacto:** La tabla se crea pero nunca se usa → deuda técnica desde el día 1, o bien la arquitectura implícitamente la omite.

**Recomendación:** Decisión de Borja — una de dos: (A) Eliminar `user_roles_cache` del schema (Historia 1.2), alineando con AD-10 que nunca la menciona. (B) Añadir un AC en Historia 2.3 o 2.4 que use la tabla como caché de roles de Discord entre sesiones con TTL.

---

#### GAP-5 — BAJO: Historia 1.3 `/health` no incluye componente `notifier`

**Historia afectada:** 1.3

**Descripción:** El AC de Historia 1.3 muestra el JSON de `/health` con 4 componentes: `database`, `redis`, `discord`, `indexer`. PRD §10.1 incluye un 5º componente: `notifier`. Si el notifier no está conectado a Telegram/Slack, debería reportarlo.

**Recomendación:** Añadir `notifier: "connected" | "disabled"` al JSON del AC de Historia 1.3.

---

#### GAP-6 — BAJO: `POST /api/admin/roles/invalidate/:userId` sin historia

**Historia afectada:** Ninguna

**Descripción:** PRD §9.1 SS-9 y SD-14 mencionan este endpoint para que el operador invalide roles inmediatamente (sin esperar el TTL). No está en ningún épico.

**Recomendación:** Este es un caso de borde para escenarios disciplinarios (echar a un miembro). Dado que el PRD lo menciona como feature explícita y no como "a futuro", se recomienda añadirlo al Épico 2 o crear una Historia 2.5. Si el equipo lo considera fuera del MVP, debe marcarse explícitamente como "pospuesto a v2" en el PRD.

---

### Estadísticas de Cobertura

- **FRs en PRD:** 23
- **FRs cubiertos completamente:** 22 (95.6%)
- **FRs cubiertos parcialmente:** 1 (FR21)
- **FRs sin cobertura:** 0
- **Gaps encontrados:** 6 (2 Importantes, 2 Moderados, 2 Bajos)

---

## Alineación UX

### Estado del Documento UX

**Encontrado:** `docs/design/Share2Brain Web.dc.html` — Diseño completo de pantallas (Login, Layout, Búsqueda, Documentos, Chat floating widget). 23 UX-DRs extraídos e integrados en `epics.md`.

### Alineación UX ↔ PRD

| Aspecto UX | PRD | Alineación |
|-----------|-----|-----------|
| Chat como floating widget (FAB + panel) | PRD §4.3 menciona "ChatWindow" y "chat view" sin especificar si es una página o widget flotante | ✅ Sin conflicto — el diseño es una decisión de implementación válida |
| 2 nav items (Búsqueda, Documentos) — Chat no está en nav | PRD §4.3 lista Búsqueda, Documentos, Chat, Read Status como vistas | ✅ Sin conflicto — "vista de chat" se resuelve como floating widget; Read Status es inline en las otras vistas |
| Dots ámbar/gris para estado de lectura | PRD §3.2 menciona "badge 🔵 No leído / ✅ Leído" como emoji | ✅ Sin conflicto — diseño evoluciona el concepto del PRD con mejor UX |
| Filtro "Sin leer" en Documentos como chip toggle | PRD §4.8 y FR16/FR17 — filtrado por leído/no leído | ✅ Alineado |
| Sidebar con conteo de no leídos en nav item Documentos | PRD §4.8 y FR19 | ✅ Alineado |
| Tema dark/light con toggle en header | PRD no lo menciona explícitamente | ✅ Sin conflicto — mejora UX fuera del alcance del PRD como requisito |

**Resultado UX ↔ PRD: Sin conflictos. El diseño es una implementación fiel y mejorada del PRD.**

### Alineación UX ↔ Arquitectura

| Aspecto UX | Requisito de Arquitectura | Alineación |
|-----------|--------------------------|-----------|
| Streaming SSE token-a-token con cursor `kh-blink` | AD-5: SSE en `POST /api/chat`; nginx `proxy_buffering off` | ✅ Soportado |
| RBAC filter chips mostrando solo canales accesibles | AD-10: `allowedChannelIds` per-request | ✅ Soportado — frontend usa `GET /api/auth/roles` para obtener la lista |
| React 19.2 + Vite 8.1 | UX requiere CSS custom properties, keyframes, clip-path | ✅ Estándar CSS, sin dependencias adicionales |
| Tema dark/light via `data-kh` attribute + localStorage | No en Arquitectura — pure frontend | ✅ No afecta backend, sin conflicto |
| Chat panel z-index 60, fixed positioning | No afecta arquitectura de servicios | ✅ Implementación CSS pura |
| Google Fonts (Space Grotesk, IBM Plex Sans, IBM Plex Mono) | No mencionado en Arquitectura | ⚠️ Requiere conexión a internet en el navegador del usuario — si la instancia está en red aislada, las fuentes no cargarán. Considerar bundling o self-hosting de fuentes |

### UX Warning

**WARN-1:** Las fuentes de Google Fonts requieren conectividad a `fonts.googleapis.com` desde el navegador del usuario. Para despliegues self-hosted en redes cerradas (intranet corporativa), las fuentes no cargarán. Se recomienda que Historia 2.1 especifique `font-display: swap` y tenga fallbacks de sistema (`system-ui, sans-serif`) bien definidos, o incluya las fuentes como assets servidos por nginx.

---

## Revisión de Calidad de Épicos

### Validación de Estructura de Épicos

| Épico | Valor de usuario | Independencia | Estado |
|-------|-----------------|---------------|--------|
| E1: Fundación del Sistema | ✅ Operador puede desplegar y verificar | ✅ Standalone | ✅ |
| E2: Acceso y Autenticación | ✅ Miembro puede autenticarse y ver UI | ✅ Usa solo E1 | ✅ |
| E3: Pipeline de Indexación | ✅ Conocimiento fluye al índice automáticamente | ✅ Usa E1+E2 | ✅ |
| E4: Búsqueda, Documentos y Read Tracking | ✅ Miembro puede buscar y gestionar lectura | ✅ Usa E1+E2+E3 | ✅ |
| E5: Agente RAG y Chat | ✅ Miembro puede preguntar al agente en lenguaje natural | ✅ Usa E1-E4 | ✅ |
| E6: Sincronización, Notificaciones y Fiabilidad | ✅ Sistema permanece preciso; Operador recibe alertas | ✅ Usa E1+E3 | ✅ |

**Sin épicos técnicos sin valor de usuario. Sin dependencias circulares. ✅**

### Validación de Independencia de Historias

| Historia | Dependencias correctas | Estado |
|---------|----------------------|--------|
| 1.1 → standalone | - | ✅ |
| 1.2 → 1.1 | Necesita estructura monorepo | ✅ |
| 1.3 → 1.1, 1.2 | Necesita packages para imágenes Docker | ✅ |
| 2.1 → E1 | Necesita packages/web creado | ✅ |
| 2.2 → 2.1 | Necesita tokens de diseño | ✅ |
| 2.3 → 1.2 | Necesita shared types + DB schema | ✅ |
| 2.4 → 2.2, 2.3 | Necesita UI + auth backend | ✅ |
| 3.1 → 1.2 | Necesita stream keys + config | ✅ |
| 3.2 → 3.1 | Necesita bot conectado | ✅ |
| 3.3 → 1.2, 3.1 | Necesita schema + eventos fluyendo | ✅ |
| 4.1 → 1.2, 2.4, 3.3 | Necesita schema + auth + vectors | ✅ |
| 4.2 → 4.1 | Necesita patrón RBAC + acceso | ✅ |
| 4.3 → 2.2, 4.1 | Necesita layout + Search API | ✅ |
| 4.4 → 2.2, 4.2 | Necesita layout + Documents API | ✅ |
| 5.1 → 1.2, 2.4, 3.3 | Necesita schema SSE + auth + vectors | ✅ |
| 5.2 → 5.1 | Necesita endpoint chat establecido | ✅ |
| 5.3 → 2.1, 2.2 | Necesita design system + layout | ✅ |
| 5.4 → 5.3, 5.1 | Necesita widget base + API | ✅ |
| 6.1 → 3.1 | Necesita bot conectado + streams | ✅ |
| 6.2 → 3.3, 6.1 | Necesita worker base + eventos sync | ✅ |
| 6.3 → 3.2, 6.1 | Necesita backfill + eventos sync | ✅ |
| 6.4 → 1.3, 6.1-6.3 | Necesita servicios corriendo | ✅ |

**Sin dependencias hacia adelante (forward dependencies) detectadas. ✅**

### Calidad de Criterios de Aceptación

#### 🟠 Issue Mayor: Historia 1.2 crea todas las tablas upfront

**Descripción:** Historia 1.2 define **todas las tablas** del sistema (`discord_messages`, `embeddings`, `users`, `user_roles_cache`, `channel_permissions`, `conversations`, `messages`, `user_read_status`) en el primer sprint. Esto viola el principio "crear tablas solo cuando son necesarias".

**Mitigante:** Esta violación es **forzada por la arquitectura AR3** (Drizzle ORM con schema único en `packages/shared/src/db/schema.ts` + migrator one-shot AR4). Un schema distribuido por story no es compatible con `drizzle-kit generate`.

**Veredicto:** Aceptable — violación conocida justificada por decisión arquitectónica. Documentada aquí para que el dev agent la entienda como intencional, no como error.

---

#### 🟡 Issue Menor: Historia 5.4 — AC vago sobre "nota de privacidad"

**AC afectado:** `**Y** el footer del panel muestra la nota de privacidad del sistema`

**Problema:** No especifica el texto exacto de la nota. ¿Qué dice? ¿Dónde está definido? El dev agent no sabrá qué renderizar.

**Recomendación:** Añadir el texto: `"Respuestas con fuente verificable · tools de share2brain.config.yml"` (ya visible en UX-DR22).

---

#### 🟡 Issue Menor: Historia 6.4 — historia de alcance amplio

**Descripción:** Historia 6.4 combina 3 preocupaciones distintas: (A) Notificaciones Telegram/Slack, (B) Rate limiting + headers de seguridad, (C) Graceful shutdown. Cada una es un dominio diferente.

**Impacto:** El dev agent puede implementar solo algunas partes y "pasar" la historia incompleta. Los tests de aceptación son claramente distintos por dominio.

**Mitigante:** Las 3 partes son bien pequeñas individualmente y compartir historia es razonable dado el bajo tamaño. Sin embargo, el dev agent debe implementar **los 3 bloques completos**.

**Recomendación:** En Sprint Planning, dividir Historia 6.4 en 3 subtareas en el mismo sprint para mayor claridad de implementación.

### Compliance Checklist por Épico

| Check | E1 | E2 | E3 | E4 | E5 | E6 |
|-------|----|----|----|----|----|----|
| Entrega valor de usuario | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Funciona de forma independiente | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Historias bien dimensionadas | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 6.4 amplia |
| Sin dependencias hacia adelante | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tablas creadas cuando se necesitan | ⚠️ AR3 | N/A | N/A | N/A | N/A | N/A |
| Criterios de aceptación claros | ✅ | ✅ | ✅ | ✅ | ⚠️ 5.4 vago | ⚠️ 6.4 amplio |
| Trazabilidad a FRs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Resumen Final y Recomendaciones

### Estado General de Readiness

> **⚠️ LISTO CON CORRECCIONES MENORES**
>
> El plan de implementación es sólido. La arquitectura, los épicos y las historias están bien estructurados. Se identificaron **9 issues** que deben resolverse antes de comenzar Sprint Planning para evitar que un dev agent implemente comportamientos incorrectos.

---

### Issues Críticos — Deben corregirse en `epics.md` antes de Sprint Planning

#### 🔴 GAP-1: Historia 5.1 — Falta filtro `deleted_at IS NULL` en RAG

**Corrección exacta en Historia 5.1:**

Añadir al bloque Given/When/Then del nodo retrieve:
```
**Y** el nodo retrieve excluye fragmentos con `deleted_at IS NOT NULL` en el join discord_messages
```

**Por qué es crítico:** Sin este filtro, el agente puede citar mensajes borrados (soft-delete). Viola directamente el Threat Model del PRD §13.

---

#### 🔴 GAP-2: Historia 6.4 — Rate limit incorrecto (100 req/min → debe ser 100 req/15 min)

**Corrección exacta en Historia 6.4:**

Cambiar: `máx. 100 req/min por IP en rutas de API, 10 req/min en /api/auth`
Por: `máx. 100 req/15 min por IP en rutas de API, 10 intentos/15 min en /api/auth`

**Por qué es crítico:** El dev agent implementará un rate limit 15 veces más permisivo que el especificado en NFR18 y PRD §9.2.

---

### Issues Moderados — Resolver antes de la historia afectada

#### 🟠 GAP-3: Historia 6.4 — ACs de FR21 solo cubren "error crítico"

**Corrección:** Añadir ACs adicionales para: backfill completado, sync completado, servicio iniciado, nuevo contenido indexado. (PRD §10.3 lista 8 eventos.)

#### 🟠 GAP-4: `user_roles_cache` en schema sin uso

**Decisión requerida de Borja:**
- **Opción A (recomendada):** Eliminar `user_roles_cache` del schema en Historia 1.2. La sesión Redis ya almacena los roles y AD-10 no la usa.
- **Opción B:** Añadir un AC en Historia 2.3 que escriba los roles en `user_roles_cache` con TTL, y en Historia 2.4 que la consulte como caché.

---

### Issues Bajos — Mejoras opcionales

#### 🟡 GAP-5: Historia 1.3 — `/health` no incluye componente `notifier`

Añadir `"notifier": "connected | disabled"` al JSON del AC.

#### 🟡 GAP-6: `POST /api/admin/roles/invalidate/:userId` sin historia

Confirmar si es MVP o v2. Si es MVP, añadir Historia 2.5.

#### 🟡 WARN-1: Google Fonts en despliegues sin internet

Historia 2.1 debe especificar `font-display: swap` y fallbacks de sistema.

#### 🟡 Historia 5.4 — "nota de privacidad" vaga

Especificar el texto exacto: `"Respuestas con fuente verificable · tools de share2brain.config.yml"`.

---

### Pasos Recomendados

1. **Ahora** — Corregir GAP-1 y GAP-2 en `epics.md` (5 minutos, 2 líneas de texto)
2. **Antes de Sprint Planning** — Resolver GAP-3 (añadir ACs a Historia 6.4) y GAP-4 (decisión sobre `user_roles_cache`)
3. **Durante Sprint Planning** — Dividir Historia 6.4 en 3 subtareas (notificaciones, seguridad, graceful shutdown)
4. **Al preparar Historia 5.1** — Verificar que el implementador añade el filtro `deleted_at IS NULL` en el nodo retrieve
5. **Al preparar Historia 2.1** — Añadir `font-display: swap` y fallbacks de sistema a los ACs de fuentes

---

### Resumen de Hallazgos

| Categoría | Count |
|-----------|-------|
| 🔴 Críticos (corregir en epics.md) | 2 |
| 🟠 Moderados (resolver antes de la historia) | 2 |
| 🟡 Bajos (mejoras opcionales) | 4 |
| ✅ Sin issues | 18/22 historias |

**Cobertura FR:** 23/23 (100%) · **Cobertura UX-DR:** 23/23 (100%)

*Assessment generado: 2026-06-30 · Proyecto: Share2Brain Self-Hosted*
