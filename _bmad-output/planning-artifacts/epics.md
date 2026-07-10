---
stepsCompleted: ["step-01", "step-02", "step-03", "step-04"]
inputDocuments:
  - "docs/PRD.md"
  - "_bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/ARCHITECTURE-SPINE.md"
  - "_bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md"
  - "docs/design/Share2Brain Web.dc.html"
---

# Share2Brain Self-Hosted - Epic Breakdown

## Visión general

Este documento contiene el desglose completo de épicos e historias para Share2Brain Self-Hosted, descomponiendo los requisitos del PRD y la Arquitectura en historias implementables.

## Inventario de Requisitos

### Requisitos Funcionales

FR1: El bot de Discord debe conectar al Gateway y escuchar eventos `messageCreate` en los canales configurados, filtrando mensajes de bots y canales no habilitados, publicando eventos a Redis Streams.
FR2: El bot debe realizar backfill de mensajes históricos al iniciar, partiendo del `last_seen_message_id` por canal (snowflake) o desde `backfill_limit` si es el primer arranque. Cada canal se procesa secuencialmente.
FR3: El bot debe detectar ediciones de mensajes (`messageUpdate`) en canales habilitados y publicar el evento `discord.message.updated` a Redis Streams para re-indexación.
FR4: El bot debe detectar borrados de mensajes (`messageDelete`) en canales habilitados y publicar el evento `discord.message.deleted` a Redis Streams para purgado (soft o hard según `delete_policy`).
FR5: El Worker Indexer consume `share2brain:discord:messages`, extrae las URLs del texto del mensaje y descarta el mensaje si no contiene ninguna. Por cada URL: hace fetch del recurso (con guarda SSRF, timeout y tope de tamaño), genera título y descripción con el LLM de `enrichment.llm` a partir del texto del mensaje + el contenido del recurso (con fallback a solo-texto si el fetch falla) en el idioma de `enrichment.language`, calcula el embedding de `title+description` y almacena una fila por URL en pgvector (`chunk_key = messageId:urlIndex`). Sin agrupación ni chunking.
FR6: El Worker Sync debe consumir eventos `discord.message.updated`: re-extraer las URLs del contenido editado y reconciliar por diff de links (upsert de links nuevos/cambiados, purgado de los removidos).
FR7: El Worker Sync debe consumir eventos `discord.message.deleted`: aplicar soft delete (`deleted_at`) o hard delete del embedding según `delete_policy`.
FR8: El sistema debe ejecutar un sync al iniciar para detectar ediciones y borrados ocurridos mientras el bot estuvo offline (comparar Discord vs. indexados).
FR9: El Backend debe implementar autenticación Discord OAuth2 (scopes: `identify`, `guilds.members.read`), verificar membresía en el guild y crear sesión en Redis.
FR10: El Backend debe implementar RBAC: en cada request autenticado, expandir `discordRoles → allowedChannelIds` uniendo la sesión contra `channel_permissions`. La tabla `channel_permissions` se carga via upsert desde `Share2Brain.config.yml` al arrancar.
FR11: El Backend debe proporcionar búsqueda semántica (`GET /api/search`) con filtro RBAC obligatorio en la query pgvector (`WHERE channel_id = ANY(:allowed_channel_ids)`), devolviendo `title`, `description` y `link` por resultado.
FR12: El Backend debe proporcionar un listado paginado de recursos indexados (`GET /api/documents`) con metadatos (`title`, `description`, `link`, canal, autor, fecha), filtrado por canales accesibles del usuario.
FR13: El Backend debe implementar el agente RAG como LangGraph StateGraph (nodos: `retrieve → reason → respond`) con streaming SSE en `POST /api/chat`. El agente responde ÚNICAMENTE con información indexada, citando canal, autor, fecha y el link del recurso. Si no hay información, lo indica explícitamente.
FR14: El agente RAG debe mantener historial de conversación con compresión cuando supera el presupuesto de tokens (`agent.memory_window`, default 20 turnos / 4000 tokens).
FR15: El Backend debe implementar read tracking: registrar estado de lectura por usuario y fragmento (`user_read_status`). Endpoints: marcar como leído, marcar como no leído, marcar canal completo como leído (batch de 1.000), obtener conteo de no leídos.
FR16: La Web App debe implementar la vista de búsqueda: barra de búsqueda, resultados (título + descripción + link al recurso) ordenados por relevancia, badges de estado de lectura (🔵 No leído / ✅ Leído), filtros por canal y por estado de lectura.
FR17: La Web App debe implementar la vista de documentos: listado paginado de recursos indexados (título + descripción + link) con badges de lectura y filtros.
FR18: La Web App debe implementar la vista de chat: envío de mensajes, streaming de respuestas token a token con SSE (usando `fetch`, no `EventSource`), visualización de citas.
FR19: La Web App debe implementar la gestión de estado de lectura en sidebar: conteo de no leídos por canal, botón "marcar canal como leído".
FR20: El sistema debe exponer `GET /health` con estado de cada componente (database, redis, discord, indexer); retorna 503 si algún componente está degradado.
FR21: El sistema debe emitir notificaciones al operador (Telegram/Slack) para: backfill completado, recurso enriquecido indexado, errores críticos, sync completado, mensajes editados/borrados.
FR22: El sistema debe ser configurable íntegramente mediante `Share2Brain.config.yml` (comportamiento) y `.env` (secretos), validados por `loadConfig()` al arrancar cada servicio.
FR23: El sistema debe desplegarse con `docker compose up -d`, incluyendo el servicio `migrator` one-shot que aplica migraciones Drizzle antes de que arranquen bot, workers y backend.
FR24: La Web App debe presentar una vista de Estadísticas con KPIs de conocimiento, actividad de indexado en el tiempo, volumen por canal y cobertura de lectura personal.
FR25: Toda estadística debe limitarse a los canales accesibles del usuario (AD-12); ninguna métrica expone datos de canales que el usuario no puede leer.

### Requisitos No Funcionales

NFR1: Búsqueda vectorial P95 < 200ms.
NFR2: Tiempo de respuesta del agente RAG P95 < 5s.
NFR3: Primer token de streaming SSE < 100ms.
NFR4: Indexación asíncrona (Redis Streams) sin bloquear el bot ni la API.
NFR5: Backfill con rate limiting (respeta `Retry-After`; delay mínimo 1s entre páginas; canales procesados secuencialmente).
NFR6: Latencia de re-indexación por edición < 5s.
NFR7: Latencia de purgado por borrado < 3s.
NFR8: Sync post-reinicio de 1.000 mensajes completado en < 60s.
NFR9: Overhead de RBAC en search < 10ms.
NFR10: `/health` responde en < 500ms; retorna HTTP 200 con estado de cada componente; HTTP 503 si cualquier componente está degradado.
NFR11: Restart automático del contenedor en < 30s tras un crash; alerta Notifier si reinicia > 3 veces en 5 minutos.
NFR12: Graceful shutdown: espera hasta 10s para completar requests en curso; las peticiones nuevas durante shutdown reciben HTTP 503.
NFR13: Todos los errores HTTP 5xx capturados por Sentry con stack trace y contexto de usuario.
NFR14: Cobertura de unit tests > 80%.
NFR15: Integration tests cubriendo Discord bot + pgvector.
NFR16: E2E tests cubriendo flujos principales de búsqueda y chat.
NFR17: Cookies httpOnly + Secure; secretos solo en Docker secrets o `.env`, nunca expuestos al cliente.
NFR18: Rate limiting configurado: global (100 req/15 min), chat (20 msg/min), auth (10 intentos/15 min).
NFR19: Validación de inputs con Zod en cada endpoint del backend.
NFR20: Headers de seguridad: CSP, HSTS, X-Frame-Options, aplicados via middleware.
NFR21: Queries SQL con parámetros (never raw string interpolation).
NFR22: Sesiones con TTL configurable (default 7 días via `SESSION_TTL_DAYS`); limpieza automática de sesiones expiradas al inicio y cada 24h.

### Requisitos Adicionales (Arquitectura)

- **AR1 — Monorepo npm workspaces:** El proyecto se estructura como monorepo con `packages/{bot,backend,workers,web,shared}`. Los servicios importan solo de `@share2brain/shared`; nunca entre sí. ESLint enforza esta regla.
- **AR2 — Proyecto greenfield:** No existe código previo. El primer épico debe inicializar la estructura del monorepo, configuración TypeScript, Docker Compose y `packages/shared` (schema Drizzle + Zod schemas + loadConfig).
- **AR3 — Drizzle ORM + drizzle-kit:** Toda la DDL vive en `packages/shared/src/db/schema.ts`. Las migraciones se generan como SQL explícito con `drizzle-kit generate` y se aplican via el servicio `migrator`.
- **AR4 — Servicio migrator one-shot:** El `docker-compose.yml` incluye el servicio `migrator` que ejecuta `drizzle-kit migrate` y termina. Bot, Backend y Workers declaran `depends_on: { migrator: { condition: service_completed_successfully } }`.
- **AR5 — SSE (Server-Sent Events) para chat:** El endpoint `POST /api/chat` retorna `Content-Type: text/event-stream`. Wire format definido en `packages/shared/src/schemas/sse.ts`: frames de tipo `token`, `citation`, `done`, `error`. La config nginx para `/api/chat` DEBE incluir `proxy_buffering off; proxy_cache off; proxy_read_timeout 300s`.
- **AR6 — LangGraph StateGraph (no LangChain legacy):** El agente RAG usa `@langchain/langgraph` 1.4. ESLint rule `no-restricted-imports` en `packages/backend` prohíbe importar de `langchain/chains`, `langchain/memory` y módulos deprecated.
- **AR7 — nginx como único punto de entrada HTTP:** nginx sirve el `dist/` de la SPA y hace proxy de `/api/*` al Backend. Es el único servicio con puerto expuesto. Backend escucha solo en red interna Docker.
- **AR8 — Redis Streams con keys y consumer groups fijos:** Stream keys: `share2brain:discord:messages`, `share2brain:discord:messages:updated`, `share2brain:discord:messages:deleted`, `share2brain:knowledge:events`. Consumer groups: `share2brain:indexer`, `share2brain:sync`, `share2brain:notifier`. Campos mínimos en cada evento: `messageId`, `channelId`, `guildId`, `timestamp`. Definidos en `packages/shared/src/types/events.ts`.
- **AR9 — Sesiones en Redis (express-session + connect-redis):** No existe tabla `sessions` en PostgreSQL. Las sesiones almacenan `{ userId, discordRoles }` con TTL. Revocación inmediata borrando la key Redis.
- **AR10 — RBAC calculado en cada request:** `allowedChannelIds` NO se cachean en sesión. Se calculan uniendo `session.discordRoles` contra `channel_permissions` en cada request a `/api/*` (excepto auth y health). `channel_permissions` se materializa desde `Share2Brain.config.yml` via upsert al arrancar el Backend.
- **AR11 — Zod schemas como contrato de API en shared:** Todos los shapes de request/response definidos en `packages/shared/src/schemas/`. Backend valida con `schema.parse()`; frontend infiere tipos con `z.infer<typeof schema>`.
- **AR12 — loadConfig() falla rápido:** Si `Share2Brain.config.yml` es inválido (campo faltante o tipo incorrecto), el proceso termina con error descriptivo antes de hacer cualquier conexión. Ningún servicio parsea YAML localmente.
- **AR13 — Workers idempotentes:** Los Workers usan UPSERT (no INSERT simple) porque Redis Streams entrega at-least-once. Un mensaje procesado dos veces no debe causar duplicados en `embeddings`.
- **AR14 — Stack fijado:** Node.js 24 LTS, TypeScript 6.0, React 19.2, Vite 8.1, Express 5.2, LangGraph 1.4, Drizzle 0.45, discord.js 14.26, Zod 4.4, PostgreSQL 17 + pgvector 0.8.2, Redis 8, nginx 1.27-alpine.
- **AR15 — PostgreSQL expuesto solo en localhost (desarrollo):** En desarrollo, el puerto de postgres se expone en `127.0.0.1:5432`, nunca en `0.0.0.0`.

### Requisitos de Diseño UX

UX-DR1: **Tokens de diseño (CSS custom properties)** — Implementar sistema completo de tokens via CSS variables: paleta de fondo (--bg, --bg-deep, --surface, --card, --hover-row, --track), bordes (--border, --border-strong, --border-hover), texto (--tx a --tx5), interacción (--hover, --on-accent, --accent-ink), con soporte dual dark/light. El accent principal es amber (#F5A623 / #FFCB6B). El color Discord es #5865F2. El estado activo/positivo es #3BA55D. El error/peligro es #ED4245. *(Historia 8.1 — se retira el token `--dot-read`: el dot de "no leído" ahora es el único indicador de punto de la fila; las filas leídas muestran un checkmark, no un dot atenuado.)*

UX-DR2: **Sistema tipográfico de 3 familias** — Space Grotesk (500/600/700) para títulos, nombres de marca y encabezados de sección. IBM Plex Sans (400/500/600) para cuerpo de texto y UI general. IBM Plex Mono (400/500/600) para: metadata, timestamps, conteos, badges de canal, etiquetas de estado, scopes OAuth, versiones, y toda información técnica. Las 3 fuentes se cargan desde Google Fonts.

UX-DR3: **Forma hexagonal de marca (clip-path)** — El logotipo y avatares de Share2Brain usan `clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)` con gradiente amber (#FFCB6B → #F5A623). Se implementa en 3 variantes de tamaño: grande (74px login, 60px chat empty state), mediano (32px sidebar/chat header), pequeño (30px avatar agente en mensajes). La estructura interna es hexágono anidado: exterior amber → interior bg-color → punto amber.

UX-DR4: **Tema dual dark/light con toggle persistente** — El atributo `data-kh="dark|light"` en el elemento raíz controla el tema via CSS variables. Toggle en el header con icono sol (modo dark activo) / luna (modo light activo). Persistencia en `localStorage('share2brain-theme')`. El tema dark es el default. Todos los colores de UI deben usar variables, nunca hardcoded.

UX-DR5: **Layout de aplicación: sidebar + contenido + chat floating** — Estructura `display:flex; height:100vh` con: sidebar fija 236px (izquierda, bg-deep, border-right) + área de contenido (flex:1, overflow hidden). El Chat NO tiene sección en la navegación — es un floating widget sobre el layout. 3 ítems de navegación: Búsqueda, Documentos y Estadísticas *(Historia 9.2)*.

UX-DR6: **Sidebar — estructura y contenido** — Logo Share2Brain hexagonal (32px) + wordmark "Share2Brain" (Space Grotesk 700 17px). Nav vertical: 3 botones (Búsqueda con lupa, Documentos con grid, Estadísticas con ícono de gráfico de líneas *(Historia 9.2)*). El ítem activo tiene `background: rgba(245,166,35,0.12); color: var(--accent-ink)`. El ítem Documentos muestra badge ámbar circular (IBM Plex Mono 10.5px) con el conteo de no leídos cuando > 0. Al fondo: panel de estado del sistema + footer "self-hosted · open source" (mono 10px, --tx5).

UX-DR7: **Panel de estado del sistema (sidebar footer)** — Widget con borde y border-radius 12px, fondo --surface. Fila superior: dot verde (#3BA55D) + "share2brain.config.yml" (mono 11px). Tres filas de status: "indexer / running", "redis stream / ok", "pgvector / ok" — labels en --tx4, valores en #3BA55D. Todas las filas con `justify-content: space-between`.

UX-DR8: **Header — estructura fija 62px** — Lado izquierdo: [ícono Discord #5865F2 (17px) + nombre comunidad (600 15px) | separador vertical 1px | statsLine (mono 11.5px, --tx4)]. Lado derecho: [badge "indexando en vivo" con dot amber pulsante (kh-pulse) | avatar circular usuario Discord (30px, #5865F2) + nombre | toggle tema (30px) | botón logout (30px, hover color #ED4245)]. Borde inferior --line.

UX-DR9: **Pantalla de Login** — Full screen con fondo: radial gradients amber y Discord purple + hexágonos decorativos flotantes animados (kh-float, 4 piezas). Card 430px (max-width 92vw): padding 48px 44px 36px, border-radius 20px, box-shadow profundo. Contenido centrado: hexágono grande → h1 "Share2Brain" (Space Grotesk 700 30px) → subtítulo mono uppercase → párrafo descriptivo → botón "Continuar con Discord" (height 52px, #5865F2, radius 12px, shadow) con estado loading (spinner + "Conectando con Discord…") → nota seguridad (ícono candado + texto) → footer separado con scopes + versión (mono 10.5px).

UX-DR10: **Vista Búsqueda — layout y componentes** — Padding 34px 40px, max-width 860px centrado. Título + descripción. Barra búsqueda 54px (ícono lupa left 17px; focus: amber border + amber shadow ring 3px). Filter chips scrollables (IBM Plex Mono; activo: amber tint border + amber text; inactivo: --surface + --border). Row de resultados: count label (mono 12px, --tx4) + "ordenado por similitud" (mono 11px, --tx5). Cards de resultado con hover border. Empty state: dashed border card con 2 líneas de texto.

UX-DR11: **Cards de resultado de búsqueda** — Card con padding 18px 20px, background --surface, border --border, border-radius 14px, hover border-strong. Fila superior: [badge canal amber (mono 12px, rgba(245,166,35,0.1) bg) | fecha (12px --tx5)] / [similarity bar 54x5px (amber gradient, border-radius 3px, track bg) | porcentaje (mono 11.5px)]. Título del recurso: h3 Space Grotesk 600 15.5px, --tx. Descripción debajo del título: 14px, line-height 1.6, --tx2. Fila inferior: [avatar autor 24px + nombre] / [enlace "ver recurso" (ícono externo, hover amber, apunta al link del recurso) + enlace "ver en Discord" (ícono externo, hover #5865F2, deep link al mensaje ancla)]. *(Story 7.5 — título+link del recurso curado; antes solo mostraba la descripción y "ver en Discord".)*

UX-DR12: **Vista Documentos — tabla y controles** — Header: título "Documentos indexados" + descripción ("Cada recurso es un link compartido en la comunidad, enriquecido con título y descripción por IA. El punto ámbar marca los recursos sin leer — tocá una fila para marcarla como leída"). Barra de controles: filter chips + spacer + botón "Marcar todas como leídas" (pill, visible solo si hay no-leídos) + chip toggle "Sin leer · N" (mismo style que chips de canal pero con dot amber). Tabla: border-radius 14px, `overflow-x: auto` (scroll horizontal en viewports angostos en vez de aplastar la grid). Header tabla: grid 6 cols (`título / descripción / link / canal / autor / indexado`), uppercase mono 10.5px --tx5, bg --bg. Filas: hover --hover-row. Paginación: "mostrando X de Y" + botón "Cargar más" (border amber en hover). *(Story 7.5 — copy de-chunked: el header decía "chunk" y la descripción hablaba de "mensajes agrupados por autor y ventana temporal". Historia 8.1 — header de 4→6 columnas y `overflow:hidden`→`overflow-x:auto`, ver UX-DR13 para el detalle de fila.)*

UX-DR13: **Filas de tabla de documentos** — Grid `150px minmax(160px,1fr) 44px 92px 116px 84px` (título / descripción / link / canal / autor / indexado), gap 12px, min-width 720px. Accento de fila en el borde izquierdo: `inset 3px 0 0 #F5A623` (no leído) / `inset 3px 0 0 transparent` (leído). Columna título: slot indicador de 16px con dot (8px, glow `0 0 0 3px rgba(245,166,35,0.16)`) si no leído XOR checkmark (`--tx5`) si leído, + título (clamp 2 líneas, siempre `--tx` — nunca se atenúa al leer) + badge "Nuevo" (mono 9.5px, `--accent-ink` sobre `rgba(245,166,35,0.13)`) debajo del título solo si no leído. Título no leído: weight 700. Título leído: weight 500 (sin badge, sin dot — el checkmark reemplaza al dot como señal de "hecho", no de "deshabilitado"). Columna descripción: propia celda, 13px, `--tx3`, clamp 2 líneas. Columna link: botón-ícono 28×28 (borde + color `--tx4`, hover `--accent-ink`), ícono externo, apunta al link del recurso; el click abre el recurso Y burbujea al handler de la fila — no usa `stopPropagation` — así que también marca la fila como leída. Columna canal: mono 12px amber. Columna autor: avatar 20px + nombre truncado 12.5px. Columna fecha: mono 11.5px --tx4, text-align right. Click en fila (o en el botón-ícono del link) marca como leído. *(Story 7.5 — la columna mostraba solo la descripción; separó título/descripción/enlace. Historia 8.1 — rediseño completo: 6 columnas propias, leído ya no se atenúa (checkmark en vez de dot gris + título siempre `--tx`), no leído gana badge "Nuevo" + accento de borde, enlace pasa de texto a botón-ícono.)*

UX-DR14: **Empty state de documentos (todo leído)** — Ícono check en círculo verde (#3BA55D, bg rgba), título "¡Estás al día! No te quedan fuentes sin leer.", subtítulo en --tx5 para quitar el filtro.

UX-DR15: **Chat floating widget — FAB** — Botón hexagonal amber 60px en posición fixed bottom:24px right:24px, z-index 60. Ícono chat oscuro (--on-accent). Shadow amber `0 14px 34px -10px rgba(245,166,35,0.65)`. Hover: translateY(-2px). Dot verde pulsante (13px, border 2px solid --bg) en top-right cuando `launcherActive` (enviando mensaje con chat cerrado).

UX-DR16: **Chat floating widget — panel** — 404x642px, max-width calc(100vw - 32px), max-height calc(100vh - 48px). Fixed bottom-right, z-index 60, border-radius 18px, border --border-strong, shadow profundo. Animación kh-pop al abrir. Header (bg-deep): logo mini + nombre "Share2Brain" + status "Agente de conocimiento" (punto verde + texto --tx4 11px) + 3 botones icon (historial, nueva conv, cerrar). Botones 32px, border --border, radius 9px, hover amber para historial/nueva, hover #ED4245 para cerrar.

UX-DR17: **Chat — historial de conversaciones** — Panel overlay absoluto (inset:0, z-index 5, bg --bg). Label "Historial de conversaciones" (mono uppercase 10px --tx5). Lista de conversaciones: botones full-width, icon chat + título truncado + timestamp. Item activo: amber tint. Hover: --hover bg.

UX-DR18: **Chat — área de mensajes y estado vacío** — Empty state centrado: hexágono 60px amber grande → h3 "Preguntá lo que quieras" (Space Grotesk 600 21px) → párrafo descriptivo → 3 suggestion chips (padding 13px 16px, border --border, radius 11px, hover border amber + text white). Mensajes en flex column gap:22px.

UX-DR19: **Chat — burbujas de mensaje** — Layout: avatar 30px (circle) + contenido (flex:1). Usuario: avatar circular Discord purple con iniciales. Agente: avatar hexagonal amber pequeño. Nombre encima del mensaje: 12.5px 600 --tx3. Texto del mensaje: 15px line-height 1.7 --tx, white-space pre-wrap. Cursor pulsante amber (8x17px, kh-blink) durante streaming.

UX-DR20: **Chat — "execution loop" trace panel** — Panel colapsible con borde y bg --bg-deep, border-radius 12px. Header: spinner (durante streaming) o check verde (al completar) + label "loop de ejecución" (mono uppercase 10.5px). Pasos en lista: dot hexagonal 7px de color categoría + label colored (mono 10.5px) + texto descripción + detail block opcional (mono 11.5px, bg --surface, border --line, radius 7px). Colores: razonamiento=--tx3, tool_call=#F5A623, observación=#3BA55D.

UX-DR21: **Chat — citas/fuentes** — Sección "Fuentes" (mono uppercase 10px --tx5). Chips en flex-wrap gap:8px. Cada chip: avatar 20px + badge canal mono amber + **título del recurso** (11.5px --tx, max-width 180px, ellipsis 1 línea) + nombre autor + ícono externo. Hover border #5865F2. `href` = link del recurso curado; links abren en `_blank`. *(Story 7.5 — antes el chip no mostraba el título y el href era un placeholder `discord.com/channels` genérico.)*

UX-DR22: **Chat — input de mensaje** — Contenedor con `style-focus-within` amber border. Textarea auto-resize (rows=1, max-height 120px), sin borde, bg transparente. Botón send 40x40px, radius 11px: amber (#F5A623) con ícono --on-accent cuando hay texto; --line con ícono --tx5 + cursor not-allowed cuando vacío. Enter sin Shift para enviar. Footer: lock icon + "Respuestas con fuente verificable · tools de share2brain.config.yml" (10.5px --tx5).

UX-DR23: **Animaciones del sistema** — Definir como @keyframes: kh-spin (spinner 0.7s linear), kh-blink (cursor SSE, 1s step-end, 50% opacity toggle), kh-up (entrada con translateY 10px, para notificaciones/toasts), kh-float (hexágonos decorativos, 9-13s ease-in-out, translateY + rotate), kh-pop (entrada del chat widget, translateY 6px + scale 0.98, 0.2s ease), kh-pulse (dot de actividad, scale 0.85→1 + opacity 0.35→1, 1.4-1.6s).

UX-DR24: **Estadísticas** — Vista `isStats` (3ª entrada de nav): contenedor `maxWidth 1040`, scroll propio. Orden: header (h2 + intro) → grid de 4 KPI cards (`repeat(auto-fit,minmax(210px,1fr))`; label + ícono chip 32px amber + valor Space Grotesk 700 29px + sub) → "Actividad de indexado" (14 barras `height:180`, hoy con gradiente `linear-gradient(180deg,#FFCB6B,#F5A623)`, resto `--track`) → grid 2-up (`Recursos por canal` con barras horizontales amber + donut de cobertura `conic-gradient` con leyenda) → "Top 5 · usuarios más activos" (avatares derivados con hash de `authorId` sobre paleta de 6 colores, barra blurple `#5865F2→#8891F5`). Contenido de los KPIs viene 100% del contrato `StatsResponse` (D1, nunca hardcodeado); copy de secciones adaptada de "mensajes" a "recursos" post-pivote Epic 7 (D2). Sin dependencia de gráficos — solo flex/grid + gradientes CSS. Sin hover/focus states en toda la pantalla (solo tooltips nativos `title`). *(Historia 9.2)*

### Mapa de Cobertura de Requisitos

| FR | Épico | Descripción |
|---|---|---|
| FR1 | Épico 3 | Bot: listener messageCreate → Redis Streams |
| FR2 | Épico 3 | Bot: backfill reconciliado por snowflake |
| FR3 | Épico 6 | Bot: listener messageUpdate |
| FR4 | Épico 6 | Bot: listener messageDelete |
| FR5 | Épico 3 | Workers: Indexer (chunking + embeddings → pgvector) |
| FR6 | Épico 6 | Workers: Sync re-indexación por edición |
| FR7 | Épico 6 | Workers: Sync purgado por borrado |
| FR8 | Épico 6 | Workers: Sync al inicio (reconciliación) |
| FR9 | Épico 2 | Discord OAuth2 + sesiones en Redis |
| FR10 | Épico 2 | Middleware RBAC (roles → allowedChannelIds) |
| FR11 | Épico 4 | API búsqueda semántica con filtro RBAC |
| FR12 | Épico 4 | API listado paginado de documentos |
| FR13 | Épico 5 | Agente RAG LangGraph StateGraph + SSE |
| FR14 | Épico 5 | Historial de conversación con compresión de memoria |
| FR15 | Épico 4 | Read tracking: todos los endpoints |
| FR16 | Épico 4 | Web App: vista Búsqueda |
| FR17 | Épico 4 | Web App: vista Documentos |
| FR18 | Épico 5 | Web App: chat floating widget |
| FR19 | Épico 4 | Web App: sidebar con conteo de no leídos |
| FR20 | Épico 1 | Endpoint GET /health con estado de componentes |
| FR21 | Épico 6 | Notificaciones Telegram/Slack al operador |
| FR22 | Épico 1 | Configuración YAML + .env + loadConfig() |
| FR23 | Épico 1 | Docker Compose 7 servicios + migrator one-shot |
| FR24 | Épico 9 | Web App: vista Estadísticas |
| FR25 | Épico 9 | GET /api/stats: agregaciones RBAC-scoped en-SQL |

## Lista de Épicos

### Épico 1: Fundación del Sistema
El Operador puede clonar el repositorio, ejecutar `docker compose up -d` y verificar vía `GET /health` que todos los servicios están saludables. Incluye la inicialización del monorepo npm workspaces con los 5 paquetes (`shared`, `bot`, `backend`, `workers`, `web`), `packages/shared` con schema Drizzle, Zod schemas de API, `loadConfig()` y tipos de eventos Redis Streams, Docker Compose con 7 servicios (migrator one-shot, nginx, postgres, redis, bot, backend, workers), migraciones automáticas, y el endpoint `/health`.
**FRs cubiertos:** FR20, FR22, FR23

### Épico 2: Acceso y Autenticación
Un miembro del guild de Discord puede autenticarse via OAuth2 y ver la interfaz principal de la web app. Incluye el flujo completo de Discord OAuth2, sesiones en Redis (`express-session` + `connect-redis`), middleware RBAC (expandir `discordRoles → allowedChannelIds` en cada request), y la web app con el sistema de diseño completo implementado (tokens de color, tipografía, hexágono de marca, layout sidebar/header, pantalla de login, toggle de tema).
**FRs cubiertos:** FR9, FR10
**UX cubiertos:** UX-DR1 al UX-DR9

### Épico 3: Pipeline de Indexación de Conocimiento
El conocimiento de los canales de Discord configurados fluye automáticamente al índice vectorial y es consultable. Incluye el Discord Bot (listener `messageCreate`, backfill reconciliado por snowflake con `last_seen_message_id`, publicación a Redis Streams), y los Workers Indexer (consumo at-least-once, agrupación por `grouping_window`, chunking, embeddings con el proveedor/modelo configurado (`embeddings.*`), upsert idempotente en pgvector).
**FRs cubiertos:** FR1, FR2, FR5

### Épico 4: Búsqueda, Documentos y Read Tracking
El miembro puede buscar semánticamente el conocimiento indexado, explorar todos los fragmentos y gestionar su estado de lectura personal. Incluye los endpoints de búsqueda semántica (filtro RBAC en query pgvector), listado paginado de documentos, todos los endpoints de read-status (marcar/desmarcar fragmento, mark-all en batch de 1.000, conteo por canal), y la Web App: vista Búsqueda (barra, filter chips, result cards con similarity bar y badges), vista Documentos (tabla grid con dots ámbar/gris, toggle "Sin leer", "Cargar más"), y sidebar con conteo de no leídos por canal. Cierra con el harness de verificación visual E2E (Playwright) que valida los ACs visuales/CSS de las vistas Búsqueda y Documentos y desbloquea la verificación del chat en Epic 5.
**FRs cubiertos:** FR11, FR12, FR15, FR16, FR17, FR19
**UX cubiertos:** UX-DR10 al UX-DR14 (verificados vía el harness E2E de la Historia 4.5)

### Épico 5: Agente RAG y Chat
El miembro puede hacer preguntas en lenguaje natural y recibir respuestas en streaming con fuentes citadas, con historial de conversación persistente. Incluye el LangGraph StateGraph (`retrieve → reason → respond`) con compresión de historial, streaming SSE con wire format definido, persistencia de conversaciones, y la Web App: chat floating widget completo (FAB hexagonal, panel 404×642px con animación kh-pop, historial de conversaciones, burbujas de mensaje con trace de ejecución, citas clicables, input con auto-resize y botón send adaptativo).
**FRs cubiertos:** FR13, FR14, FR18
**UX cubiertos:** UX-DR15 al UX-DR23

### Épico 6: Sincronización, Notificaciones y Fiabilidad
El sistema permanece preciso cuando mensajes de Discord son editados o borrados, el operador recibe notificaciones sobre eventos del sistema, y la aplicación maneja fallos de forma robusta. Incluye el Bot con listeners `messageUpdate` y `messageDelete` + sync al inicio, Workers Sync (re-indexación de ediciones, purgado por delete_policy), notificaciones Telegram/Slack para todos los eventos configurados, rate limiting completo, headers de seguridad CSP/HSTS, y graceful shutdown.
**FRs cubiertos:** FR3, FR4, FR6, FR7, FR8, FR21

### Épico 7: Índice Curado de Recursos con IA
Convierte el KB de "todo mensaje indexado" a un índice curado de recursos: solo mensajes con URL, cada URL enriquecida por IA (título + descripción) y almacenada con su link. Reescribe la ingesta (fin de grouping/chunking, fetch saliente con guarda SSRF, paso generativo LLM) y proyecta title/description/link en search, documentos, RAG y las vistas web.
**FRs cubiertos:** FR5, FR6, FR11, FR12, FR13, FR16, FR17, FR21

---

## Épico 1: Fundación del Sistema

El Operador puede clonar el repositorio, ejecutar `docker compose up -d` y verificar vía `GET /health` que todos los servicios están saludables.

### Historia 1.1: Inicializar el repositorio y la estructura del monorepo

Como desarrollador,
quiero que el repositorio tenga la estructura npm workspaces con TypeScript y ESLint configurados,
para que todos los servicios compartan el entorno de desarrollo y la prohibición de imports cruzados se enforce desde el inicio.

**Criterios de Aceptación:**

**Dado** un repositorio vacío con el `package.json` raíz configurado con workspaces
**Cuando** el desarrollador ejecuta `npm install` en la raíz
**Entonces** npm resuelve los 5 workspaces `packages/{shared,bot,backend,workers,web}` e instala todas las dependencias
**Y** `tsc --noEmit` pasa con cero errores en todos los paquetes

**Dado** un archivo en `packages/bot` que intenta importar de `@share2brain/backend`
**Cuando** ESLint ejecuta sobre ese archivo
**Entonces** la rule `no-restricted-imports` reporta un error señalando el import cruzado prohibido
**Y** un import de `@share2brain/shared` en el mismo archivo no genera ningún error

**Dado** los archivos `Share2Brain.config.yml.example` y `.env.example`
**Cuando** el desarrollador los revisa
**Entonces** contienen todos los campos documentados en el PRD con valores de ejemplo claros

---

### Historia 1.2: Implementar packages/shared — el kernel de dominio

Como desarrollador de cualquier servicio,
quiero que `packages/shared` exporte el schema Drizzle, los Zod schemas de API, `loadConfig()` y los tipos de eventos Redis Streams,
para que todos los servicios usen una única fuente de verdad para modelos de datos, contratos de API y configuración.

**Criterios de Aceptación:**

**Dado** `packages/shared/src/db/schema.ts`
**Cuando** es revisado
**Entonces** define todas las tablas: `discord_messages`, `embeddings`, `users`, `channel_permissions`, `conversations`, `messages`, `user_read_status`
**Y** la tabla `sessions` NO está definida (las sesiones viven en Redis)
**Y** ejecutar `npx drizzle-kit generate` produce archivos SQL de migración en `src/db/migrations/`

**Dado** un `Share2Brain.config.yml` válido
**Cuando** `loadConfig()` es llamado
**Entonces** retorna un objeto de configuración tipado con todos los campos requeridos validados

**Dado** un `Share2Brain.config.yml` con un campo inválido o ausente
**Cuando** cualquier servicio llama a `loadConfig()` al arrancar
**Entonces** el proceso termina con un mensaje de error descriptivo antes de establecer cualquier conexión de red

**Dado** `packages/shared/src/schemas/sse.ts`
**Cuando** es revisado
**Entonces** exporta `SSEFrame` como union discriminada: `token | citation | done | error` con los campos correctos por tipo

**Dado** `packages/shared/src/types/events.ts`
**Cuando** es revisado
**Entonces** exporta `MessageCreatedEvent`, `MessageUpdatedEvent`, `MessageDeletedEvent` con campos mínimos obligatorios: `messageId`, `channelId`, `guildId`, `timestamp` (ISO 8601 UTC)

---

### Historia 1.3: Docker Compose, servicios base y endpoint /health

Como Operador,
quiero ejecutar `docker compose up -d` y verificar el estado del sistema con `GET /health`,
para confirmar que el despliegue es correcto con un solo comando.

**Criterios de Aceptación:**

**Dado** el `docker-compose.yml`
**Cuando** es revisado
**Entonces** define exactamente 7 servicios: `migrator` (one-shot), `nginx`, `bot`, `backend`, `workers`, `postgres`, `redis`
**Y** `bot`, `backend` y `workers` declaran `depends_on: { migrator: { condition: service_completed_successfully } }`
**Y** `nginx` es el único servicio con puertos expuestos al host (80/443)
**Y** en desarrollo, `postgres` expone el puerto solo en `127.0.0.1:5432`

**Dado** un entorno con `.env` y `Share2Brain.config.yml` válidos
**Cuando** el Operador ejecuta `docker compose up -d`
**Entonces** el servicio `migrator` ejecuta `drizzle-kit migrate`, aplica todas las migraciones y termina con código 0
**Y** los demás servicios arrancan tras la finalización exitosa del `migrator`

**Dado** todos los servicios corriendo
**Cuando** se llama `GET /health`
**Entonces** la respuesta es HTTP 200 con JSON `{ status: "healthy", components: { database: "connected", redis: "connected", discord: "pending", indexer: "pending" } }`

**Dado** que el servicio de PostgreSQL no es alcanzable
**Cuando** se llama `GET /health`
**Entonces** la respuesta es HTTP 503 con `{ status: "degraded", components: { database: "disconnected", ... } }`

**Dado** el `nginx.conf`
**Cuando** es revisado
**Entonces** contiene para `/api/chat`: `proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;`
**Y** `/api/` proxea a `http://backend:3000`
**Y** `/` sirve `dist/` con `try_files $uri $uri/ /index.html`

---

## Épico 2: Acceso y Autenticación

Un miembro del guild de Discord puede autenticarse via OAuth2 y ver la interfaz principal de la web app con el sistema de diseño completo implementado.

### Historia 2.1: Sistema de diseño en packages/web

Como miembro de la comunidad,
quiero que la interfaz de Share2Brain tenga una identidad visual consistente con soporte de tema claro/oscuro,
para que la experiencia sea profesional y adaptable a mis preferencias.

**Criterios de Aceptación:**

**Dado** el archivo de estilos globales en `packages/web`
**Cuando** es revisado
**Entonces** define todas las CSS custom properties: `--bg`, `--bg-deep`, `--surface`, `--card`, `--border`, `--border-strong`, `--border-hover`, `--dot-read`, `--tx` a `--tx5`, `--accent-ink`, `--on-accent`, `--hover` para los temas dark (`[data-kh="dark"]`) y light (`[data-kh="light"]`)

**Dado** los estilos globales
**Cuando** son revisados
**Entonces** importan Space Grotesk (500/600/700), IBM Plex Sans (400/500/600) e IBM Plex Mono (400/500/600) desde Google Fonts
**Y** `font-family` del body es `'IBM Plex Sans', system-ui, sans-serif`

**Dado** el componente hexagonal de Share2Brain
**Cuando** es renderizado
**Entonces** aplica `clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)` con gradiente `linear-gradient(150deg, #FFCB6B, #F5A623)` con estructura anidada (exterior amber → interior bg-color → punto amber)
**Y** existe en 3 variantes de tamaño: 74px (login), 32px (sidebar/chat header), 30px (avatar agente en mensajes)

**Dado** los estilos globales
**Cuando** son revisados
**Entonces** definen los 6 `@keyframes`: `kh-spin` (0.7s linear), `kh-blink` (1s step-end), `kh-up` (translateY 10px), `kh-float` (translateY + rotate), `kh-pop` (translateY 6px + scale 0.98, 0.2s), `kh-pulse` (scale 0.85→1 + opacity, 1.4–1.6s)

**Dado** el tema dark activo
**Cuando** el desarrollador inspecciona el DOM
**Entonces** `--accent-ink` resuelve a `#F5A623` y `--on-accent` a `#0E1116`
**Dado** el tema light activo
**Entonces** `--accent-ink` resuelve a `#9A5B00`

---

### Historia 2.2: Layout principal, sidebar y pantalla de login

Como miembro de la comunidad,
quiero ver la pantalla de login de Share2Brain y, una vez autenticado, la interfaz principal con sidebar y header,
para poder navegar entre las secciones de la aplicación.

**Criterios de Aceptación:**

**Dado** que el usuario no está autenticado
**Cuando** accede a la web app
**Entonces** ve la pantalla de login con: fondo de radial gradients amber y Discord purple + 4 hexágonos decorativos animados con `kh-float`, card centrada (430px max-width, border-radius 20px), logo hexagonal 74px, título "Share2Brain" (Space Grotesk 700 30px), subtítulo mono uppercase, párrafo descriptivo, botón "Continuar con Discord" (#5865F2, height 52px), nota de seguridad con ícono candado, y footer con scopes OAuth2 + versión

**Dado** que el usuario está autenticado
**Cuando** accede a la web app
**Entonces** ve el layout de aplicación con sidebar (236px, `var(--bg-deep)`, `border-right: 1px solid var(--line)`) y área de contenido (flex:1, min-width:0)

**Dado** el sidebar renderizado
**Cuando** es inspeccionado
**Entonces** muestra: logo hexagonal 32px + wordmark "Share2Brain" (Space Grotesk 700 17px), 2 nav items (Búsqueda con ícono lupa, Documentos con ícono grid), espacio flexible, panel de estado del sistema (indexer/redis stream/pgvector con dots verdes y valores "running"/"ok"), y footer "self-hosted · open source" (mono 10px, `--tx5`)

**Dado** el header renderizado (height 62px)
**Cuando** es inspeccionado
**Entonces** muestra: [ícono Discord #5865F2 (17px) + nombre comunidad (font-weight 600, 15px) | separador vertical | statsLine (mono 11.5px, `--tx4`)] / [badge "indexando en vivo" con dot ámbar animado con `kh-pulse` | avatar circular usuario (30px, #5865F2) + nombre | botón toggle tema (30px) | botón logout (30px, hover color #ED4245)]

**Dado** el nav item activo
**Cuando** está seleccionado
**Entonces** tiene `background: rgba(245,166,35,0.12)` y `color: var(--accent-ink)`
**Y** el nav item inactivo tiene `background: transparent` y `color: var(--tx3)`

**Dado** el botón toggle de tema en el header
**Cuando** el usuario hace clic
**Entonces** el `data-kh` del elemento raíz alterna entre `"dark"` y `"light"`
**Y** la preferencia se persiste en `localStorage('share2brain-theme')`
**Y** al recargar la página, el tema guardado se aplica antes del primer render visible

---

### Historia 2.3: Backend — Discord OAuth2 y sesiones en Redis

Como miembro de la comunidad,
quiero autenticarme con mi cuenta de Discord,
para que el sistema verifique que pertenezco al guild y cree una sesión segura sin almacenar mis credenciales.

**Criterios de Aceptación:**

**Dado** que el usuario accede a `GET /api/auth/login`
**Cuando** el endpoint procesa la request
**Entonces** redirige a `https://discord.com/oauth2/authorize` con scopes `identify` y `guilds.members.read` y el `redirect_uri` configurado en `.env`

**Dado** que Discord redirige con código de autorización a `GET /api/auth/callback?code=...`
**Cuando** el backend procesa el callback
**Entonces** intercambia el código por `access_token` via `POST https://discord.com/api/oauth2/token`
**Y** obtiene datos del usuario via `GET https://discord.com/api/users/@me`
**Y** verifica membresía y obtiene roles via `GET https://discord.com/api/users/@me/guilds/{guild_id}/member`

**Dado** que el usuario ES miembro del guild
**Cuando** el callback completa
**Entonces** hace upsert del usuario en la tabla `users` (discord_id, username, avatar)
**Y** almacena la sesión en Redis: `{ userId, discordRoles }` con TTL configurable via `SESSION_TTL_DAYS`
**Y** establece cookie httpOnly `sid` y redirige al frontend en `/`

**Dado** que el usuario NO es miembro del guild
**Cuando** el backend verifica la membresía
**Entonces** retorna HTTP 403 con `{ error: "No eres miembro del guild", code: "GUILD_MEMBER_REQUIRED" }`

**Dado** una sesión válida en Redis
**Cuando** se llama `GET /api/auth/me`
**Entonces** retorna HTTP 200 con `{ id, discordId, username, avatar }`

**Dado** una sesión válida en Redis
**Cuando** se llama `POST /api/auth/logout`
**Entonces** la key de sesión es eliminada inmediatamente de Redis
**Y** la cookie `sid` es invalidada
**Y** retorna HTTP 200

---

### Historia 2.4: RBAC, protección de rutas y conexión UI

Como miembro de la comunidad,
quiero que la app muestre solo el contenido al que tengo acceso según mis roles de Discord,
para que los canales privados del guild permanezcan protegidos.

**Criterios de Aceptación:**

**Dado** el arranque del backend
**Cuando** el servicio se inicializa
**Entonces** hace upsert de `channel_permissions` desde `config.access_control.channel_permissions` antes de aceptar cualquier request
**Y** `default_policy: "deny"` implica que un usuario sin regla explícita recibe `allowedChannelIds = []`

**Dado** cualquier request a `/api/*` excepto `/api/auth/*` y `/health`
**Cuando** el middleware de auth lo procesa sin sesión válida
**Entonces** retorna HTTP 401 `{ error: "Unauthorized", code: "AUTH_REQUIRED" }`

**Dado** una sesión válida en Redis
**Cuando** el middleware RBAC expande los roles en cada request
**Entonces** une `session.discordRoles` contra `channel_permissions` con `WHERE allowed_roles && discordRoles`
**Y** adjunta `req.allowedChannelIds` al objeto request para uso en los handlers
**Y** este cálculo ocurre en cada request (no se cachea en la sesión)

**Dado** `GET /api/auth/roles` con sesión válida
**Cuando** es llamado
**Entonces** retorna `{ roles: string[], allowedChannels: string[] }` con los roles y canales accesibles del usuario

**Dado** que la web app carga con una sesión válida (cookie presente)
**Cuando** llama a `GET /api/auth/me`
**Entonces** muestra el layout autenticado (sidebar + header) con el nombre e iniciales del usuario
**Y** el nombre de la comunidad en el header proviene de `config.discord.guild_id` o nombre configurable

**Dado** que el usuario hace clic en el botón logout del header
**Cuando** `POST /api/auth/logout` completa con éxito
**Entonces** la app renderiza la pantalla de login
**Y** cualquier request posterior a `/api/*` desde esa sesión retorna HTTP 401

---

## Épico 3: Pipeline de Indexación de Conocimiento

El conocimiento de los canales de Discord configurados fluye automáticamente al índice vectorial y es consultable.

### Historia 3.0: Configuración de proveedores LLM y embeddings

Como Operador,
quiero elegir de forma independiente el proveedor de LLM (Anthropic, OpenAI o custom
OpenAI-compatible) y el de embeddings (OpenAI o custom), con sus claves y endpoints,
para adaptar Share2Brain a mi stack sin tocar código.

**Criterios de Aceptación:**

**Dado** `packages/shared/src/config/index.ts`
**Cuando** es revisado
**Entonces** `agent.provider` es `z.enum(['anthropic','openai','custom'])` y existe el bloque `embeddings` con `provider: z.enum(['openai','custom'])`, `model`, `dimensions` (entero > 0), `base_url?` y `api_key`
**Y** `agent` incluye `base_url?` y `api_key`
**Y** `knowledge` ya NO contiene `embedding_model` (movido a `embeddings`)
**Y** un `.superRefine` exige `base_url` no vacío cuando `provider === 'custom'` (agent y embeddings)

**Dado** un `Share2Brain.config.yml` con `embeddings.provider: "anthropic"`
**Cuando** `loadConfig()` valida
**Entonces** falla con error descriptivo (Anthropic no ofrece API de embeddings)

**Dado** un `provider: "custom"` sin `base_url`
**Cuando** `loadConfig()` valida
**Entonces** el proceso aborta con mensaje indicando que `base_url` es obligatorio para custom

**Dado** un provider-factory en `packages/shared`
**Cuando** recibe la config del `agent`
**Entonces** devuelve `ChatAnthropic` (anthropic), o `ChatOpenAI` con `configuration.baseURL` + `apiKey` (openai/custom)
**Y** para `embeddings` devuelve `OpenAIEmbeddings` con `configuration.baseURL` + `apiKey` (openai/custom)
**Y** el `api_key`/`base_url` se pasan explícitos desde config (sin depender de nombres de env)

**Dado** `packages/shared/src/db/schema.ts`
**Cuando** se ejecuta `drizzle-kit generate`
**Entonces** la dimensión de `vector('embedding', { dimensions })` proviene de `embeddings.dimensions` leída con un lector mínimo de YAML (NO `loadConfig()` completo, para no fallar por `${VAR}` sin setear)

**Dado** el arranque de un servicio que genera/consulta embeddings
**Cuando** obtiene un vector del proveedor
**Entonces** un guard verifica `vector.length === embeddings.dimensions` y aborta/loguea error si no coincide (protege AD-13)

**Dado** `Share2Brain.config.yml.example` y `.env.example`
**Cuando** son revisados
**Entonces** reflejan los bloques `agent`/`embeddings` y las keys `LLM_API_KEY`, `LLM_BASE_URL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_BASE_URL`

**Notas de implementación:**
- Contrato = scope `shared` (AD-6). Evoluciona el contrato ya shipped en Story 1.2.
- Aprovecha el spike abierto de Epic 2 (smoke real de embeddings API, verificar dimensión).
- `docker-compose.yml`: propagar las nuevas env vars a bot/backend/workers.
- **Dependencia:** 3.0 bloquea 3.3 (y a 4.1 / 5.1).

---

### Historia 3.1: Discord Bot — conexión al Gateway y listener messageCreate

Como Operador,
quiero que el bot de Discord escuche mensajes nuevos en los canales configurados y los publique al pipeline de indexación,
para que el conocimiento de la comunidad se capture en tiempo real sin intervención manual.

**Criterios de Aceptación:**

**Dado** el servicio `bot` arrancando con `Share2Brain.config.yml` válido
**Cuando** `loadConfig()` parsea la configuración
**Entonces** el cliente `discord.js` se conecta al Discord Gateway con los permisos: `Read Message History`, `Read Channels`, `View Channel`
**Y** los event listeners `messageCreate`, `messageUpdate`, `messageDelete` son registrados

**Dado** un nuevo mensaje publicado en un canal con `enabled: true`
**Cuando** el evento `messageCreate` es recibido por el bot
**Entonces** el bot verifica que el canal está habilitado y que el autor no es un bot (cuando `ignore_bots: true`)
**Y** hace INSERT del mensaje en la tabla `discord_messages` (message_id, channel_id, channel_name, author_id, author_name, content, created_at)
**Y** hace `XADD share2brain:discord:messages` con los campos obligatorios: `messageId`, `channelId`, `guildId`, `timestamp`, `content`, `authorId`

**Dado** un mensaje en un canal con `enabled: false`
**Cuando** el evento `messageCreate` es recibido
**Entonces** el mensaje es silenciosamente ignorado (no INSERT, no XADD)

**Dado** que el bot pierde la conexión con el Discord Gateway
**Cuando** se detecta la desconexión
**Entonces** reintenta la conexión con exponential backoff hasta un máximo de 5 minutos entre reintentos
**Y** persiste el `last_seen_message_id` por canal en `discord_messages` para poder reanudar sin perder mensajes

---

### Historia 3.2: Discord Bot — backfill histórico con reconciliación por snowflake

Como Operador,
quiero que el bot indexe el historial de mensajes de Discord al arrancar,
para que el conocimiento previo a la instalación de Share2Brain sea consultable desde el primer día.

**Criterios de Aceptación:**

**Dado** el bot arrancando con `backfill.enabled: true`
**Cuando** el Backfiller inicia para un canal
**Entonces** consulta `discord_messages` para obtener el `last_seen_message_id` del canal
**Y** si existe, hace fetch de Discord API desde ese snowflake hasta el presente
**Y** si no existe, hace fetch hasta el límite de `backfill.limit` mensajes (default 1000)

**Dado** el Backfiller procesando mensajes históricos
**Cuando** itera por cada mensaje
**Entonces** publica cada mensaje como evento en `share2brain:discord:messages`
**Y** respeta el rate limit de Discord API: delay mínimo de 1s entre páginas de resultados
**Y** honra el header `Retry-After` si Discord retorna rate limit
**Y** procesa los canales de forma secuencial (no paralela)

**Dado** que el Backfiller completa para todos los canales
**Cuando** finaliza
**Entonces** publica un evento `discord.backfill.completed` al stream `share2brain:knowledge:events`
**Y** actualiza el `last_seen_message_id` por canal

**Dado** que el bot se reinicia tras haber estado offline
**Cuando** el Backfiller arranca
**Entonces** parte desde el `last_seen_message_id` almacenado (no desde `backfill_limit`)
**Y** cubre exactamente el gap de mensajes perdidos durante el downtime

---

### Historia 3.3: Workers — Indexer (embeddings y pgvector)

Como miembro de la comunidad,
quiero que los mensajes de Discord sean transformados en vectores de búsqueda semántica,
para poder encontrar conocimiento relevante con búsquedas en lenguaje natural.

**Criterios de Aceptación:**

**Dado** el Worker Indexer arrancando
**Cuando** se inicializa
**Entonces** crea el consumer group `share2brain:indexer` en el stream `share2brain:discord:messages` si no existe
**Y** comienza a leer con `XREADGROUP GROUP share2brain:indexer consumer-1 COUNT 10 BLOCK 5000`

**Dado** un lote de mensajes leídos del stream
**Cuando** el Indexer los procesa
**Entonces** agrupa mensajes consecutivos del mismo canal dentro de la ventana `grouping_window` configurada
**Y** concatena el texto agrupado y lo divide en fragmentos de `chunk_size` tokens con `chunk_overlap` de solapamiento
**Y** para cada fragmento llama al cliente de embeddings del provider-factory (config `embeddings`), obteniendo un vector de `embeddings.dimensions`
**Y** un guard verifica que la longitud del vector === `embeddings.dimensions`; si no coincide, NO hace XACK y registra error (protege AD-13)

**Dado** los vectores generados para un fragmento
**Cuando** son almacenados
**Entonces** hace UPSERT (no INSERT simple) en la tabla `embeddings` (content, embedding, channel_id, message_ids, created_at)
**Y** actualiza `discord_messages SET indexed_at = now()` para los mensajes incluidos

**Dado** que el procesamiento de un mensaje fue exitoso
**Cuando** el Indexer hace ACK
**Entonces** ejecuta `XACK share2brain:discord:messages share2brain:indexer <message-id>`
**Y** si el procesamiento falla, NO hace XACK para que Redis reintente automáticamente

**Dado** que el mismo mensaje llega dos veces al stream (at-least-once delivery)
**Cuando** el Indexer lo procesa la segunda vez
**Entonces** el UPSERT no crea duplicados en `embeddings`
**Y** el procesamiento completa sin error

---

## Épico 4: Búsqueda, Documentos y Read Tracking

El miembro puede buscar semánticamente el conocimiento indexado, explorar todos los fragmentos y gestionar su estado de lectura personal.

### Historia 4.1: Backend — API de búsqueda semántica

Como miembro de la comunidad,
quiero poder buscar en el conocimiento indexado con lenguaje natural,
para que el sistema me devuelva los fragmentos más relevantes respetando los canales a los que tengo acceso.

**Criterios de Aceptación:**

**Dado** `GET /api/search?q=texto` con sesión válida
**Cuando** el endpoint procesa la request
**Entonces** valida el query con el Zod schema de `packages/shared/src/schemas/`
**Y** genera el embedding de la query con el cliente de embeddings del provider-factory (config `embeddings`)
**Y** ejecuta la búsqueda vectorial en pgvector con filtro `WHERE channel_id = ANY(:allowedChannelIds)` obligatorio
**Y** retorna los fragmentos ordenados por similitud coseno descendente

**Dado** la respuesta de búsqueda
**Cuando** es revisada
**Entonces** cada fragmento incluye: `id`, `content`, `channelId`, `channelName`, `authorId`, `authorName`, `createdAt`, `similarity` (float 0–1), `messageId`
**Y** los fragmentos de mensajes con `deleted_at IS NOT NULL` son excluidos del resultado

**Dado** un usuario sin acceso a ningún canal (`allowedChannelIds = []`)
**Cuando** hace una búsqueda
**Entonces** retorna HTTP 200 con array vacío de resultados

**Dado** una búsqueda sin parámetro `q`
**Cuando** el endpoint valida la request
**Entonces** retorna HTTP 400 con `{ error: "Query requerida", code: "VALIDATION_ERROR" }`

---

### Historia 4.2: Backend — API de documentos y read tracking

Como miembro de la comunidad,
quiero ver todos los fragmentos indexados y gestionar cuáles he leído,
para llevar un seguimiento personal de qué conocimiento nuevo hay disponible.

**Criterios de Aceptación:**

**Dado** `GET /api/documents?page=1&limit=20` con sesión válida
**Cuando** el endpoint procesa la request
**Entonces** retorna los fragmentos paginados de `embeddings` filtrados por `allowedChannelIds`
**Y** cada fragmento incluye `isRead: boolean` basado en `user_read_status` para el usuario actual
**Y** los fragmentos con `deleted_at IS NOT NULL` son excluidos

**Dado** `POST /api/read-status/:embeddingId` con sesión válida
**Cuando** el fragmento existe y el usuario tiene acceso RBAC al canal
**Entonces** inserta en `user_read_status` con `ON CONFLICT DO NOTHING`
**Y** retorna HTTP 200

**Dado** `DELETE /api/read-status/:embeddingId` con sesión válida
**Cuando** el fragmento existe
**Entonces** elimina la fila de `user_read_status` y retorna HTTP 200

**Dado** `POST /api/read-status/mark-all` con `{ channelId }` y sesión válida
**Cuando** el usuario tiene acceso RBAC al canal
**Entonces** procesa los embeddings en lotes de 1.000 insertando en `user_read_status`
**Y** solo opera sobre canales en `allowedChannelIds`
**Y** retorna HTTP 200 con `{ markedCount: number }`

**Dado** `GET /api/read-status/unread-count` con sesión válida
**Cuando** el endpoint procesa la request
**Entonces** retorna `{ [channelId]: number }` con el conteo de no leídos por canal
**Y** solo incluye canales en `allowedChannelIds`

---

### Historia 4.3: Web App — vista Búsqueda

Como miembro de la comunidad,
quiero buscar en el conocimiento indexado desde la web app y ver los resultados con su relevancia y estado de lectura,
para encontrar rápidamente la información que necesito.

**Criterios de Aceptación:**

**Dado** que el usuario navega a la sección Búsqueda
**Cuando** la vista carga
**Entonces** muestra título "Búsqueda de conocimiento" (Space Grotesk 600 25px), descripción, barra de búsqueda (height 54px, ícono lupa en left 17px), y filter chips de canales accesibles

**Dado** la barra de búsqueda con foco activo
**Cuando** es inspeccionada
**Entonces** muestra `border-color: var(--accent-ink)` y `box-shadow: 0 0 0 3px rgba(245,166,35,0.12)`

**Dado** que el usuario escribe en la barra de búsqueda
**Cuando** la query tiene al menos 2 caracteres
**Entonces** llama a `GET /api/search?q=...` y renderiza los result cards debajo
**Y** muestra el conteo de resultados (IBM Plex Mono 12px, `--tx4`) y "ordenado por similitud" (mono 11px, `--tx5`)

**Dado** los result cards renderizados
**Cuando** son inspeccionados
**Entonces** cada card muestra: badge canal (mono 12px, amber bg `rgba(245,166,35,0.1)`), fecha, barra de similitud (54×5px, gradiente amber, border-radius 3px, track bg `--track`) con porcentaje (mono 11.5px), contenido (14.5px, line-height 1.6), avatar autor (24px) + nombre, y enlace "ver en Discord" con ícono externo (hover color #5865F2)

**Dado** un chip de canal activo
**Cuando** está seleccionado
**Entonces** tiene `background: rgba(245,166,35,0.14)`, `border: 1px solid rgba(245,166,35,0.45)`, `color: var(--accent-ink)`

**Dado** que la búsqueda retorna 0 resultados
**Cuando** la respuesta llega
**Entonces** muestra el empty state con `border: 1px dashed var(--border-strong)`, texto "Sin coincidencias en el conocimiento indexado." y sugerencia de consultar al agente

---

### Historia 4.4: Web App — vista Documentos, read tracking UI y sidebar badge

Como miembro de la comunidad,
quiero explorar todos los fragmentos indexados en una tabla, filtrar los no leídos y gestionar mi estado de lectura,
para saber qué conocimiento nuevo tengo pendiente de revisar.

**Criterios de Aceptación:**

**Dado** que el usuario navega a la sección Documentos
**Cuando** la vista carga
**Entonces** muestra la tabla con grid `1fr 130px 130px 96px` y header con "chunk / canal / autor / indexado" en IBM Plex Mono uppercase 10.5px `--tx5` sobre fondo `--bg`

**Dado** las filas de la tabla
**Cuando** son renderizadas
**Entonces** fragmentos no leídos muestran: dot ámbar (#F5A623) con glow `0 0 0 3px rgba(245,166,35,0.16)`, texto `color: var(--tx)`, `font-weight: 500`
**Y** fragmentos leídos muestran: dot `var(--dot-read)` sin glow, `color: var(--tx4)`, `font-weight: 400`
**Y** el hover de fila aplica `background: var(--hover-row)`

**Dado** que el usuario hace clic en una fila no leída
**Cuando** el click es procesado
**Entonces** llama a `POST /api/read-status/:embeddingId` y el dot cambia a gris de forma optimista

**Dado** el chip toggle "Sin leer · N"
**Cuando** el usuario hace clic
**Entonces** la tabla filtra para mostrar solo fragmentos con `isRead: false`
**Y** cuando no quedan no leídos muestra el empty state: ícono check en círculo verde (#3BA55D) + "¡Estás al día! No te quedan fuentes sin leer."

**Dado** el botón "Marcar todas como leídas" (visible cuando `unreadCount > 0`)
**Cuando** el usuario hace clic
**Entonces** llama a `POST /api/read-status/mark-all` con el canal activo (o todos si filtro = "todos")
**Y** actualiza el estado de lectura en la UI de forma optimista

**Dado** el nav item "Documentos" en el sidebar
**Cuando** `unreadCount > 0`
**Entonces** muestra badge ámbar circular (IBM Plex Mono 10.5px, min-width 18px, height 18px, border-radius 9px) con el total de no leídos
**Y** cuando `unreadCount = 0` el badge no se renderiza

**Dado** el botón "Cargar más" al pie de la tabla
**Cuando** hay más documentos disponibles
**Entonces** carga los siguientes 20 fragmentos añadiéndolos a la lista
**Y** el hover aplica `border-color: var(--accent-ink)` y `color: var(--accent-ink)`

---

### Historia 4.5: Web App — Harness de verificación visual E2E (Playwright)

Como desarrollador del proyecto,
quiero un harness E2E que arranque la SPA autenticada sin Discord real y verifique los criterios visuales/CSS reales de las vistas,
para cerrar el gap de verificación que dejó la Story 4.3 y desbloquear la verificación de la vista Documentos (4.4) y del chat (Epic 5).

> Story transversal de habilitación de tests, descubierta durante la review de 4.3 (ver `sprint-change-proposal-2026-07-07.md`). El gate obligatorio (`bmad-story-mandatory-steps.md` §3.4) exige Playwright E2E cuando se toca la UI, pero no existía harness ni forma de autenticar la SPA sin Discord real. Playwright **no** está instalado hoy.

**Criterios de Aceptación:**

**Dado** el monorepo sin tooling E2E
**Cuando** se instala y configura el harness
**Entonces** `@share2brain/web` declara `@playwright/test`, existe `playwright.config.ts` en `packages/web`, y el script `npm run test:e2e -w @share2brain/web` ejecuta la suite E2E (con el wiring en la raíz)

**Dado** que el harness necesita un backend determinista
**Cuando** arranca
**Entonces** monta `createApp` con un `DiscordOAuthClient` fake inyectado (patrón `opts.oauth` de los `*.integration.test.ts`) y un `queryEmbedder` determinista, sobre Postgres+pgvector/Redis de test seedeados con `channel_permissions` + `embeddings`, de modo que `GET /api/search` devuelve resultados fijos

**Dado** que la SPA gatea todo tras sesión OAuth (`App.tsx → /api/auth/me → LoginScreen`)
**Cuando** el harness inicia una sesión de navegador
**Entonces** obtiene la cookie de sesión mediante el flujo fake-OAuth (`/api/auth/login` → callback fake) **sin credenciales reales de Discord** y **sin añadir una ruta de auth-bypass en producción** (una ruta test-only guarded a no-prod es solo fallback)

**Dado** el frontend construido
**Cuando** Playwright lo dirige
**Entonces** Vite preview apunta al backend de test y la SPA autenticada renderiza las vistas reales

**Dado** la spec inicial del harness
**Cuando** navega a la vista Búsqueda (cobertura retroactiva de Story 4.3)
**Entonces** verifica vía `getComputedStyle`: AC1 título (Space Grotesk 600 / 25px) + barra de búsqueda 54px; AC2 foco con `border-color: var(--accent-ink)` + `box-shadow: 0 0 0 3px rgba(245,166,35,0.12)`; AC4 tokens de result card (badge amber, gradiente de similarity-bar, avatar); AC5 chip activo/inactivo; AC6 empty state con borde dashed

**Dado** la spec inicial del harness
**Cuando** navega a la vista Documentos (cobertura retroactiva de Story 4.4)
**Entonces** verifica vía `getComputedStyle`: grid de tabla `1fr 130px 130px 96px`; dot no leído ámbar con glow `0 0 0 3px rgba(245,166,35,0.16)` vs. leído `var(--dot-read)`; hover de fila `var(--hover-row)`; badge del sidebar; empty state "todo leído"

**Dado** los nombres de tokens del mockup (`--tx`/`--tx4`/`--tx5`)
**Cuando** se escriben las aserciones
**Entonces** usan los **nombres reales** renombrados en Story 2.1 (`--text-primary`/`--text-muted`/`--text-subtle`, mismos valores)

**Dado** una corrida del harness
**Cuando** completa
**Entonces** captura screenshots de las vistas como artefactos, y el harness queda documentado/reutilizable para que las Stories 5.3/5.4 añadan sus propias specs

**Dependencias:** bloquea 5.3 y 5.4.

---

## Épico 5: Agente RAG y Chat

**Goal:** Implementar el pipeline RAG con LangGraph StateGraph, el endpoint SSE `/api/chat`, la gestión de conversaciones, y el widget flotante de chat con streaming en tiempo real.

**FRs cubiertos:** FR13, FR14, FR18 | **UX-DRs:** UX-DR15–UX-DR23

---

### Historia 5.1: Endpoint SSE de Chat con Pipeline RAG

Como usuario autenticado,
quiero enviar un mensaje al agente y recibir respuestas en streaming,
para obtener respuestas contextualizadas de mi comunidad en tiempo real.

**Criterios de Aceptación:**

**Dado** que el usuario envía POST /api/chat con `{ conversationId, message }`
**Cuando** el endpoint procesa la petición
**Entonces** responde con `Content-Type: text/event-stream`
**Y** ejecuta el StateGraph LangGraph: nodo retrieve → nodo reason → nodo respond
**Y** el StateGraph instancia el LLM vía provider-factory (config `agent`: provider/model/base_url/api_key), soportando anthropic | openai | custom
**Y** el nodo retrieve filtra vectores por `allowedChannelIds` calculados en tiempo real (JOIN session.discordRoles + channel_permissions)
**Y** el nodo retrieve excluye fragmentos con `deleted_at IS NOT NULL` en el join con `discord_messages`
**Y** emite frames SSE según el wire format de `shared/schemas/sse.ts`: `token`, `citation`, `done`, `error`
**Y** el ESLint rule `no-restricted-imports` bloquea importaciones de `langchain/chains` y `langchain/memory`
**Y** nginx tiene `proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 300s` en `/api/chat`

---

### Historia 5.2: Gestión de Conversaciones e Historial

Como usuario autenticado,
quiero que mis conversaciones persistan y se compriman automáticamente,
para continuar sesiones previas sin perder contexto y sin exceder límites de tokens.

**Criterios de Aceptación:**

**Dado** que el usuario llama a GET /api/conversations
**Cuando** tiene conversaciones previas
**Entonces** devuelve lista paginada con título (extraído del primer mensaje) y timestamp
**Y** GET /api/conversations/:id devuelve mensajes ordenados cronológicamente

**Dado** que una conversación supera 4000 tokens
**Cuando** se procesa el siguiente mensaje
**Entonces** `compressIfNeeded()` comprime mensajes históricos preservando el contexto reciente
**Y** el título se genera automáticamente a partir del primer mensaje del usuario

---

### Historia 5.3: Widget Flotante FAB + Panel Base

Como usuario de la web app,
quiero abrir un panel de chat flotante desde cualquier pantalla,
para acceder al agente sin abandonar mi contexto actual.

**Criterios de Aceptación:**

**Dado** que el usuario está en cualquier ruta autenticada
**Cuando** visualiza la interfaz
**Entonces** ve el FAB hexagonal de 60px con icono de chat y color amber `#F5A623`, fixed bottom:24px right:24px, z-index 60

**Dado** que el usuario hace clic en el FAB
**Cuando** el panel se abre
**Entonces** aparece con animación `kh-pop`, dimensiones 404×642px, `border-radius: 18px`
**Y** muestra header con título "Chat" y botón de cerrar
**Y** muestra estado vacío con hexágono central y sugerencias de preguntas
**Y** muestra overlay de historial de conversaciones cuando se accede desde el header
**Y** el botón FAB se oculta mientras el panel está abierto

---

### Historia 5.4: Mensajes de Chat y UI de Streaming SSE

Como usuario del chat,
quiero ver las respuestas del agente en streaming con trazabilidad del razonamiento,
para entender cómo el agente llegó a cada respuesta.

**Criterios de Aceptación:**

**Dado** que el usuario envía un mensaje desde el textarea
**Cuando** el agente está procesando
**Entonces** aparece la burbuja del agente con cursor amber parpadeante (`kh-blink`)
**Y** los frames SSE `token` se acumulan en la burbuja en tiempo real
**Y** los frames `tool_call` muestran el paso de ejecución en color `#F5A623`
**Y** los frames `observation` muestran el resultado en color `#3BA55D`
**Y** el razonamiento se muestra en color `--tx3` (muted)

**Dado** que la respuesta incluye citas
**Cuando** llegan los frames `citation`
**Entonces** se renderizan como chips clicables bajo la respuesta

**Dado** que el textarea está vacío
**Cuando** el usuario no ha escrito nada
**Entonces** el botón de envío muestra el color `--line` (deshabilitado)
**Y** cuando hay texto, el botón cambia a amber `#F5A623` (40×40px)

**Y** el footer del panel muestra la nota de privacidad del sistema

---

## Épico 6: Sincronización, Notificaciones y Fiabilidad

**Goal:** Implementar la detección de ediciones/borrados en Discord, la sincronización al arranque, las notificaciones externas, y los mecanismos de fiabilidad del sistema (graceful shutdown, idempotencia, seguridad).

**FRs cubiertos:** FR3, FR4, FR6, FR7, FR8, FR21

---

### Historia 6.1: Bot — Detección de Ediciones y Borrados en Tiempo Real

Como sistema,
quiero que el bot publique eventos `messageUpdate` y `messageDelete` a Redis Streams,
para que el worker de sync mantenga el índice vectorial consistente con Discord.

**Criterios de Aceptación:**

**Dado** que ocurre un evento `messageUpdate` en un canal habilitado
**Cuando** el bot lo recibe
**Entonces** publica a la stream `share2brain:discord:messages:updated` con `{ messageId, channelId, newContent, editedAt }`
**Y** ignora actualizaciones en canales no habilitados o mensajes de bots

**Dado** que ocurre un evento `messageDelete` en un canal habilitado
**Cuando** el bot lo recibe
**Entonces** publica a la stream `share2brain:discord:messages:deleted` con `{ messageId, channelId, deletedAt }`
**Y** el evento se publica aunque el bot no haya visto el mensaje original (Discord no garantiza la caché)

---

### Historia 6.2: Worker Sync — Re-indexación y Purgado

Como sistema,
quiero que el worker procese eventos de edición y borrado con idempotencia,
para mantener los embeddings sincronizados sin duplicados ni corrupción de datos.

**Criterios de Aceptación:**

**Dado** que el Worker Sync consume un evento `discord.message.updated` del consumer group `share2brain:sync`
**Cuando** procesa el mensaje
**Entonces** elimina el embedding anterior del mensaje en pgvector
**Y** genera nuevo embedding con el contenido actualizado y lo inserta (UPSERT por `message_id`)
**Y** ejecuta XACK solo tras éxito; en fallo deja el mensaje en la stream para reintento

**Dado** que el Worker Sync consume un evento `discord.message.deleted`
**Cuando** `delete_policy = "soft"`
**Entonces** marca el registro con `deleted_at = NOW()` sin eliminar el embedding
**Y** cuando `delete_policy = "hard"` elimina el embedding de pgvector permanentemente
**Y** la operación es idempotente: si el mensaje ya no existe, continúa sin error

---

### Historia 6.3: Sincronización al Arranque y Reconciliación Offline

Como sistema,
quiero que el bot detecte ediciones y borrados ocurridos mientras estuvo offline,
para que el índice vectorial sea consistente tras reinicios o caídas.

**Criterios de Aceptación:**

**Dado** que el bot arranca (o reinicia)
**Cuando** completa el backfill de mensajes nuevos (FR2)
**Entonces** ejecuta el sync offline: consulta Discord los mensajes recientes por canal y los compara con los indexados
**Y** para cada mensaje editado offline publica evento `discord.message.updated` a la stream
**Y** para cada mensaje borrado offline publica evento `discord.message.deleted` a la stream
**Y** el proceso usa `last_seen_message_id` como punto de partida para limitar el rango de comparación
**Y** el sync offline se ejecuta por canal de forma secuencial para no saturar la API de Discord

---

### Historia 6.4: Notificaciones Externas, Seguridad y Graceful Shutdown

Como operador del sistema,
quiero que el sistema envíe alertas a Telegram/Slack ante errores críticos, aplique cabeceras de seguridad y realice un cierre ordenado,
para garantizar la observabilidad, seguridad y fiabilidad operacional.

**Criterios de Aceptación:**

**Dado** que ocurre un error crítico en cualquier servicio (bot, backend, workers)
**Cuando** el error supera el umbral configurado
**Entonces** el sistema envía una notificación al canal Telegram o Slack configurado en `Share2Brain.config.yml` (FR21)
**Y** la notificación incluye el nombre del servicio, mensaje de error y timestamp

**Dado** que el backend recibe cualquier request HTTP
**Cuando** responde
**Entonces** incluye las cabeceras: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`
**Y** el rate limiting está activo: máx. 100 req/15 min por IP en rutas de API, 10 intentos/15 min en `/api/auth`, 20 msg/min en `/api/chat`

**Dado** que cualquier proceso recibe señal `SIGTERM` o `SIGINT`
**Cuando** el graceful shutdown comienza
**Entonces** el bot cierra la conexión al Gateway de Discord correctamente
**Y** los workers finalizan el procesamiento del mensaje en curso antes de cerrar
**Y** el backend deja de aceptar nuevas conexiones y espera a que las activas terminen (timeout 10s)
**Y** todas las conexiones a PostgreSQL y Redis se cierran limpiamente

---

## Épico 7: Índice Curado de Recursos con IA

**Goal:** Convertir el KB de "todo mensaje indexado" a un índice curado de recursos: solo mensajes con
URL, cada URL enriquecida por IA (título + descripción) y almacenada con su link. Reescribe la ingesta
(fin de grouping/chunking, fetch saliente con guarda SSRF, paso generativo LLM) y proyecta
title/description/link en search, documentos, RAG y las vistas web.

**FRs cubiertos:** FR5, FR6, FR11, FR12, FR13, FR16, FR17, FR21

> Aprobado via `bmad-correct-course` (2026-07-09,
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md`), clasificación **Major**,
> migración destructiva aprobada. Las historias 7.2–7.6 se detallan (ACs Gherkin completas) cuando se
> creen individualmente vía `bmad-create-story` — este resumen lista su alcance, no sus criterios.

- **Historia 7.1 · shared:** modelo de datos + contratos + config de enriquecimiento.
- **Historia 7.2 · workers/indexer:** extracción de URLs + UrlFetcher (SSRF) + generación IA + descarte.
- **Historia 7.3 · workers/sync:** re-indexación por diff de links + purgado.
- **Historia 7.4 · backend:** proyección search/documents/RAG/prompt/citas + seed e2e.
- **Historia 7.5 · web:** SearchView/DocsView/citas render de title/description/link + UX.
- **Historia 7.6 · e2e:** extender harness visual (patrón Epic 4) a los campos nuevos.

## Épico 8: UX Polish

**Goal:** Refinamientos visuales post-roadmap sobre vistas ya entregadas, sin tocar contratos,
schema ni backend. Frontend-only (AD-3 intacto).

> Aprobado via `bmad-correct-course` (2026-07-10,
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10.md`), clasificación
> **Moderate**. Las ACs Gherkin completas de cada historia se detallan al crearse vía
> `bmad-create-story`.

### Historia 8.1: web — DocsView: rediseño de estados leído/no-leído y layout de columnas

**Disparador:** las filas leídas se leían como "deshabilitadas" (punto gris + título atenuado a
`--text-muted`). El diseño actualizado (`docs/context/design/Share2Brain Web.dc.html`) mueve el énfasis
a *destacar lo no leído* en vez de *apagar lo leído*.

- **AC1 · Layout 6 columnas:** título · descripción · link · canal · autor · indexado; fila con
  `min-width:720px` y scroll horizontal en viewports estrechos.
- **AC2 · Fila no leída = énfasis:** punto ámbar (8px) con glow, badge "Nuevo" bajo el título y
  acento de fila (`box-shadow` en el borde izquierdo).
- **AC3 · Fila leída = "hecho", no "deshabilitado":** indicador checkmark ✓ (`--text-subtle`/`--tx5`),
  no punto gris; el título permanece legible (sin atenuar a `--text-muted`).
- **AC4 · Link como botón-icono con bubbling preservado:** botón-icono external-link que abre el
  recurso en nueva pestaña; un click sobre él en fila no leída sigue marcándola como leída (7.5).
- **AC5 · Paridad de tema y sin regresión funcional:** correcto en tema claro y oscuro; filtros por
  canal, "Sin leer", "Marcar todas" y paginación no regresan.
- **AC6 · Tests verdes:** `DocsView.test.tsx` y el harness e2e `docs.spec.ts` actualizados al nuevo
  tratamiento (checkmark en leído, badge/acento en no leído) y pasando.

## Épico 9: Estadísticas del Conocimiento (Analytics)

**Goal:** Añadir la vista Estadísticas (3ª entrada de nav) del diseño `Share2Brain Web.dc.html`
(`isStats`): KPIs de conocimiento, actividad de indexado (14 días), volumen por canal y cobertura
de lectura personal. Sin ingesta nueva (agrega sobre datos existentes); sin tabla nueva.

**FRs cubiertos:** FR24, FR25 (nuevos)

> Aprobado via `bmad-correct-course` (2026-07-10,
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-stats.md`), clasificación
> **Moderate**. 🚩 Restricción crítica ratificada: **AD-12 — toda agregación filtra por
> `allowedChannelIds` dentro del SQL** (no expone volumen de canales privados). Endpoint único
> `GET /api/stats`. Las ACs Gherkin completas se detallan al crear cada historia vía
> `bmad-create-story`; este resumen lista su alcance.

- **Historia 9.1 · shared + backend:** contrato `StatsResponse` (Zod, AD-6) + endpoint
  RBAC-scoped `GET /api/stats` (kpis + activity + channels + coverage) + índice compuesto
  `idx_embeddings_channel_created` sobre `embeddings(channel_id, created_at DESC)` — `created_at`
  ES el `indexedAt` que expone `/api/documents`; `embeddings` no tiene columna `indexed_at`
  (migración reemplaza el índice de un solo canal, sin tabla nueva) + test de integración RBAC que
  prueba la exclusión de canales fuera de alcance.
- **Historia 9.2 · web:** `StatsView` + 3ª entrada de nav "Estadísticas" (mismo patrón AppLayout
  que Búsqueda/Documentos, UX-DR5); KPI cards, bar-chart de actividad, barras por canal, donut de
  cobertura y la sección **Top 5 usuarios más activos** (lista `topUsers` — nombre + count, del
  contrato 9.5); tipos vía `z.infer<StatsResponse>`; sin dependencia de gráficos (flex/grid +
  gradientes CSS). El render de Top 5 depende de que 9.5 haya aterrizado.
- **Historia 9.3 · e2e:** extender el harness visual Playwright (patrón Epic 4/7) a la vista de
  estadísticas con seed determinista y RBAC-consistente, **incluyendo la sección Top 5 usuarios**
  (seed de autores con `author_name` y assert de orden/exclusión de canal denegado).
- **Historia 9.4 · bot + shared:** capturar el nombre visible del autor en la ingesta. Nueva
  columna nullable `discord_messages.author_name` (DDL en `schema.ts`, AD-5) + migración generada;
  el Bot la escribe en los handlers de `create` y `edit` (Épico 6), tomándola del `author` del
  mensaje de Discord (username/displayName). Sin backfill: las filas antiguas quedan `NULL` y se
  resuelven vía `COALESCE(author_name, users.username, author_id)` aguas abajo.
- **Historia 9.5 · shared + backend:** extender el contrato `StatsResponse` con el bloque
  `topUsers` (AD-6) y servirlo desde `GET /api/stats`. Shape `{ authorId, authorName, count }`,
  orden `count DESC, authorId ASC`, **límite 5**; query RBAC-scoped in-SQL (AD-12): Top 5
  `author_id` por count de embeddings no borrados y con scope cuyo autor-ancla (`message_ids[1]`)
  sea ese `author_id`, `authorName = COALESCE(dm.author_name, u.username, dm.author_id)`; test de
  integración que prueba la exclusión del canal denegado en `topUsers` + docs (`api-spec.yml`).
  **Depende de 9.4.** Secuencia binding del añadido: 9.4 → 9.5 → (9.2 render, 9.3 e2e).

> **KPIs (ratificado 2026-07-10):** los 4 cards son **Recursos indexados · Canales · Autores ·
> Tus consultas al agente**. Los 3 primeros RBAC-scoped por `allowedChannelIds` (AD-12). El 4º
> ("Tus consultas al agente") cuenta los mensajes de rol `user` de las conversaciones del propio
> usuario (`conversations`/`messages`, Epic 5) — métrica **per-usuario**, sin `channel_id`, por lo
> que no aplica el filtro de canal y no hay fuga. La **cobertura de lectura** la cubre el donut
> (no se duplica como KPI).

> **Top 5 usuarios (añadido 2026-07-10, `sprint-change-proposal-2026-07-10-topusers.md`):** la 5ª
> sección del mock (`Top 5 · usuarios más activos`) se incorpora al contrato como bloque `topUsers`
> (RBAC-scoped, AD-12) vía las historias **9.4** (captura de `author_name` en el Bot) + **9.5**
> (bloque `topUsers` en el contrato + endpoint). Promovida desde la review de la Historia 9.1
> (decisión D9) para no ampliar su alcance en revisión. **No añade FR nuevo** — es parte de la vista
> de Estadísticas (FR24) y respeta FR25. Nombre real para mensajes nuevos; los antiguos degradan vía
> `COALESCE(author_name, users.username, author_id)` (sin backfill).
