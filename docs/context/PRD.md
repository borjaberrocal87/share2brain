# PRD — Share2Brain Self-Hosted

**Agente de IA para comunidades de Discord — Sistema desplegable por el operador**

| | |
|---|---|
| **Nombre** | Share2Brain Self-Hosted |
| **Versión** | 1.0 |
| **Fecha** | 30 de junio de 2026 |
| **Estado** | Final |
| **Autor** | Borja Berrocal |

---

## 0. Supuestos de partida

Este documento define el **sistema core de Share2Brain** que cada operador despliega en su propia infraestructura para servir a una comunidad de Discord.

**Fuera de alcance (ver PRD-Landing-Share2Brain.md):**
- Landing page del proyecto
- Documentación pública del producto
- Sitio web institucional

**Dentro de alcance:**
- Discord Bot (ingesta de conocimiento)
- Web App (búsqueda + chat con agente)
- Backend (API + Agent Runtime)
- Base de datos (PostgreSQL + pgvector)
- Cola de eventos (Redis Streams)
- Configuración (YAML + .env)
- Autenticación (Discord OAuth2)
- Read Tracking (seguimiento de lectura)
- Empaquetado (Docker Compose)
- Despliegue y operaciones

---

## 0.1 Asunciones

| ID | Asunción | Propietario | Plan de validación |
|----|----------|-------------|-------------------|
| AS-1 | El operador dispone de un dominio público o IP accesible para el redirect URI de Discord OAuth2 | Operador | Verificar en guía de instalación; documentar configuración localhost para desarrollo |
| AS-2 | Los costes de embedding (proveedor/modelo configurable en `embeddings`) son asumibles para el volumen de mensajes de la comunidad objetivo | Producto | Calcular coste estimado para comunidades de 1k, 10k y 100k mensajes con el modelo configurado antes de lanzamiento |
| AS-3 | El rate limit de Discord API es suficiente para el backfill con `backfill_limit: 1000` mensajes por canal | Ingeniería | Validar con prueba de carga en entorno de staging con guild real |
| AS-4 | El modelo de embedding configurado (`embeddings.model`, p. ej. `text-embedding-3-small` a 1536 dims) ofrece calidad semántica suficiente para búsqueda en comunidades de Discord | Ingeniería | Evaluar precisión con conjunto de preguntas reales de 3 comunidades piloto sobre el modelo configurado |
| AS-5 | El Operador y el Admin del guild son la misma persona o el Operador tiene acceso administrativo al guild | Producto | Confirmar en fase de beta con primeros operadores reales |

---

## 0.2 Glosario

| Término | Definición |
|---------|------------|
| **Operador** | Persona o entidad que despliega y mantiene la instancia de Share2Brain para su comunidad |
| **Admin** | Administrador del servidor Discord con permisos para gestionar roles y canales. Se asume coincidente con el Operador en v1. |
| **Miembro** | Integrante autenticado de la comunidad Discord que usa la web app para buscar y chatear |
| **Guild** | Servidor de Discord identificado por su `guild_id` |
| **Mensaje** | Mensaje original publicado en un canal de Discord (`discord_messages`) |
| **Fragmento** | Recurso curado indexado: un enlace extraído de un mensaje, enriquecido con `title`+`description` generados por IA (`embeddings`, Epic 7 — Story 7.2). Es el concepto de cara al usuario. |
| **Embedding** | Vector numérico de dimensión configurable (`embeddings.dimensions`, default 1536) que representa semánticamente un Fragmento. Término interno de infraestructura. |
| **Conversación** | Sesión de chat entre un Miembro y el agente RAG (`conversations`) |
| **Backfill** | Proceso de indexación de mensajes históricos al iniciar el sistema |
| **Sync** | Proceso de reconciliación que detecta y propaga ediciones/borrados de mensajes en Discord |
| **RBAC** | Control de acceso basado en roles Discord; determina qué canales puede ver cada Miembro |

---

## 1. Resumen ejecutivo

Share2Brain es un agente de IA que **cura automáticamente un índice de recursos (enlaces) de una comunidad de Discord**: solo los mensajes que contienen una URL se indexan — cada enlace se enriquece con un título y una descripción generados por IA — y responde preguntas en lenguaje natural citando esos recursos con fuentes verificables.

> **Nota de alcance (2026-07-09, Epic 7 — pivote a índice curado):** el sistema ya NO indexa el
> texto de cualquier mensaje. Solo los mensajes con al menos una URL entran al índice; el
> contenido no-enlazado deja de ser buscable/citable. El `Fragmento` (glosario, §Definiciones)
> pasa de ser "un chunk de texto agrupado" a ser "un recurso (`title`+`description`+`link`) por
> URL indexada" — ver `docs/data-model.md` §embeddings y
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md` para el detalle completo
> del pivote. El resto de este documento describe el diseño pre-pivote y se actualiza
> incrementalmente a medida que las Historias 7.2–7.6 lo reemplazan.

Cada operador despliega una instancia independiente que sirve a **una comunidad de Discord** (un guild). La configuración se realiza mediante `Share2Brain.config.yml` y el sistema se levanta con `docker compose up -d`.

**Componentes del sistema:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Share2Brain SELF-HOSTED                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Discord Bot │  │   Web App   │  │       Backend           │ │
│  │  (Ingesta)  │  │  (UI React) │  │  (API + Agent Runtime)  │ │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘ │
│         │                │                      │              │
│         └────────────────┼──────────────────────┘              │
│                          │                                     │
│                          ▼                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ PostgreSQL  │  │    Redis    │  │   Notifier               │ │
│  │ + pgvector  │  │  Streams    │  │   (Telegram / Slack)     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Problema y objetivos

### 2.1 Problema que resuelve

- El conocimiento de una comunidad de Discord está fragmentado en decenas de canales
- Las preguntas recurrentes consumen tiempo de moderadores y miembros veteranos
- Los bots tradicionales responden con guiones fijos; no entienden el material propio
- Las soluciones SaaS implican subir el conocimiento a un tercero
- Buscar información antigua en Discord es prácticamente imposible

### 2.2 Objetivos del sistema

| ID | Objetivo | Criterio de aceptación |
|----|----------|------------------------|
| SO-1 | Indexación automática de mensajes | Bot lee canales configurados y indexa en tiempo real |
| SO-2 | Búsqueda semántica | Resultados por similitud de embedding, no solo keyword |
| SO-3 | Chat con agente RAG | Respuestas con fuentes citadas (canal, autor, fecha) |
| SO-4 | Read Tracking | Cada miembro tiene su propio estado de lectura |
| SO-5 | Configuración como código | Todo en `Share2Brain.config.yml` + `.env` |
| SO-6 | Despliegue trivial | Un comando: `docker compose up -d` |
| SO-7 | Datos bajo control | Self-hosted; datos en reposo nunca salen del servidor del operador. El procesamiento se delega a los proveedores configurados por el operador — LLM (Anthropic/OpenAI/custom) y embeddings (OpenAI/custom), posiblemente distintos e incl. endpoint custom self-hosted — delegación explícita y documentada (ver §13). |
| SO-8 | Multi-comunidad | Cada despliegue sirve a un guild independiente |

### 2.3 No-objetivos (en esta versión)

- No es multi-tenant: un despliegue = una comunidad
- No incluye panel de administración web (configuración via YAML)
- No reemplaza la moderación ni administra el servidor de Discord
- No incluye tools externas vía MCP
- No incluye modelos locales vía Ollama (fase posterior)
- La internacionalización cubre solo la UI web (idioma por despliegue vía `ui.language`, es/en — Épico 10); no incluye traducir el contenido indexado ni las respuestas del agente (el idioma del contenido generado por IA se gobierna aparte con `enrichment.language`)
- No indexa el contenido de attachments ni imágenes — solo el texto de los mensajes es buscable (OCR de imágenes, fase posterior)

---

## 3. Usuarios y personas

| Persona | Quién es | Qué necesita |
|---------|----------|--------------|
| **Operador** | Quien despliega Share2Brain para su comunidad | Configurar canales, levantar instancia, monitorear |
| **Admin del guild** | Administrador de Discord con permisos | Configurar el bot, revisar métricas |
| **Miembro** | Integrante de la comunidad | Buscar información y recibir respuestas con fuentes |

> **Nota:** En v1 se asume que el Operador y el Admin del guild son la misma persona o que el Operador tiene acceso administrativo al guild. Si son personas distintas, se requerirán endpoints de admin dedicados (pospuesto a v2, ver AS-5).

### 3.1 Flujo del operador

```
┌─────────────────────────────────────────────────────────────────┐
│                    OPERATOR FLOW                                 │
└─────────────────────────────────────────────────────────────────┘

1. INSTALACIÓN
   └─▶ git clone https://github.com/Share2Brain/Share2Brain.git
   └─▶ cp Share2Brain.config.yml.example Share2Brain.config.yml
   └─▶ cp .env.example .env
   └─▶ Configurar variables (Discord, DB, LLM)
   └─▶ docker compose up -d

2. CONFIGURACIÓN
   └─▶ Definir canales a indexar en Share2Brain.config.yml
   └─▶ Configurar modelo de IA y proveedor
   └─▶ Habilitar/deshabilitar tools
   └─▶ Configurar notificaciones Telegram (opcional)

3. MONITOREO
   └─▶ Revisar logs: docker compose logs -f
   └─▶ Verificar health: curl http://localhost:3000/health
   └─▶ Recibir notificaciones en Telegram
   └─▶ Revisar métricas de uso
```

### 3.2 Flujo del miembro

```
┌─────────────────────────────────────────────────────────────────┐
│                    MEMBER FLOW                                   │
│  Protagonista: Ana, moderadora técnica de una comunidad dev     │
└─────────────────────────────────────────────────────────────────┘

1. ACCESO
   └─▶ Ana entra a la web app y hace clic "Login with Discord"
   └─▶ Discord OAuth2 autentica su identidad y membresía en el guild
   └─▶ Share2Brain verifica sus roles → determina qué canales puede ver
   └─▶ Ana entra a la pantalla principal con su estado de lectura cargado

2. BÚSQUEDA
   └─▶ Ana escribe una pregunta en lenguaje natural en el buscador
   └─▶ Share2Brain devuelve fragmentos ordenados por relevancia semántica
   └─▶ Cada resultado muestra: canal origen, autor, fecha, badge 🔵 No leído / ✅ Leído
   └─▶ Ana puede filtrar por "Solo no leídos" o por canal

3. LECTURA DE UN FRAGMENTO
   └─▶ Ana hace clic en un resultado → se expande el fragmento completo
   └─▶ El badge cambia automáticamente a ✅ Leído
   └─▶ Si quiere ver el mensaje original: enlace directo al canal de Discord

4. CHAT CON EL AGENTE
   └─▶ Ana abre la vista de Chat y escribe su pregunta
   └─▶ El agente responde en streaming con fuentes citadas (canal, autor, fecha)
   └─▶ Ana puede hacer preguntas de seguimiento en la misma conversación
   └─▶ Si el agente no encuentra información: lo indica explícitamente sin inventar

5. GESTIÓN DE LECTURA
   └─▶ Ana ve en el sidebar el conteo de fragmentos no leídos por canal
   └─▶ Puede marcar un canal entero como leído con un clic
   └─▶ Su progreso de lectura es personal e independiente del de otros miembros
```

---

## 4. Componentes del sistema

### 4.1 Discord Bot — Ingesta de conocimiento

**Responsabilidad:** Escuchar mensajes de canales configurados y enviarlos al sistema de indexación.

| ID | Componente | Descripción |
|----|------------|-------------|
| SB-1 | DiscordBot | Conexión al guild con permisos necesarios |
| SB-2 | MessageListener | Escucha `messageCreate` en canales configurados |
| SB-3 | Backfiller | Indexa mensajes históricos al iniciar |
| SB-4 | MessageIndexer | Prepara mensajes para embedding |
| SB-5 | EventPublisher | Publica eventos en Redis Streams |
| SB-16 | MessageSyncHandler | Escucha `messageUpdate` y `messageDelete`; sincroniza ediciones y borrados |
| SB-17 | RoleResolver | Obtiene y cachea roles del usuario con TTL configurable |

**Permisos de Discord requeridos:**
```
- Read Message History
- Read Channels
- View Channel
```

**Flujo de indexación:**
```
┌─────────────────────────────────────────────────────────────────┐
│                    INDEXING FLOW                                 │
└─────────────────────────────────────────────────────────────────┘

1. NUEVO MENSAJE EN DISCORD
   └─▶ messageCreate event
   └─▶ Filtrar: canal habilitado? autor es bot?
   └─▶ Publicar evento: discord.message.created

2. BACKFILL AL INICIAR
   └─▶ Fetch mensajes históricos (backfill_limit)
   └─▶ Para cada canal habilitado
   └─▶ Publicar eventos: discord.message.created
   └─▶ Notificar completado: discord.backfill.completed

3. INDEXACIÓN (Indexer Worker)
   └─▶ Recibe evento de Redis Streams
   └─▶ Agrupa mensajes por ventana temporal
   └─▶ Genera embeddings (proveedor/modelo configurado)
   └─▶ Almacena en pgvector
   └─▶ Marca como indexado

4. EDICIÓN DE MENSAJE EN DISCORD
   └─▶ messageUpdate event
   └─▶ Filtrar: canal habilitado?
   └─▶ Publicar evento: discord.message.updated

5. BORRADO DE MENSAJE EN DISCORD
   └─▶ messageDelete event
   └─▶ Filtrar: canal habilitado?
   └─▶ Publicar evento: discord.message.deleted

6. RE-INDEXACIÓN POR EDICIÓN (Sync Worker)
   └─▶ Recibe evento discord.message.updated
   └─▶ Elimina embedding anterior del mensaje
   └─▶ Genera nuevo embedding con contenido actualizado
   └─▶ Almacena en pgvector
   └─▶ Notificar: discord.message.reindexed

7. PURGADO POR BORRADO (Sync Worker)
   └─▶ Recibe evento discord.message.deleted
   └─▶ Si delete_policy = "soft": marca deleted_at en discord_messages
   └─▶ Si delete_policy = "hard": elimina embedding de pgvector
   └─▶ Notificar: discord.message.purged

8. SYNC AL INICIAR (Sync Worker)
   └─▶ Comparar mensajes de Discord vs indexados
   └─▶ Detectar ediciones (updated_at discord > indexed_at)
   └─▶ Detectar borrados (mensaje ya no existe en Discord)
   └─▶ Publicar eventos de sync
   └─▶ Notificar completado: discord.sync.completed
```

**Modos de fallo del Discord Bot:**

| Escenario | Comportamiento esperado |
|-----------|------------------------|
| Desconexión del Discord Gateway | El bot reintenta conexión con exponential backoff (máx. 5 min). Persiste el último `message_id` visto por canal; al reconectar hace backfill desde ese punto, no desde `backfill_limit`. |
| Sin eventos en N minutos (configurable, default 10 min) | El bot emite alerta via Notifier: `⚠️ Share2Brain — Sin actividad en N minutos. Verificar conexión.` |
| Rate limit de Discord API durante backfill | Respeta el header `Retry-After`; delay mínimo de 1s entre páginas; procesa canales de forma secuencial, no paralela. |
| Token del bot expirado o revocado | Log de error crítico + alerta Notifier; el bot no intenta auto-renovar (requiere intervención del Operador). |

**Reconciliación por snowflake:**

El Backfiller y el Sync Worker almacenan el `last_seen_message_id` (Discord snowflake) por canal en la base de datos. Al reiniciar, el backfill parte desde `last_seen_message_id` en lugar de un conteo fijo, garantizando cobertura completa independientemente de cuánto tiempo estuvo el bot offline.

### 4.2 Backend — API + Agent Runtime

**Responsabilidad:** Servir la API REST, ejecutar el agente RAG y gestionar sesiones.

| ID | Componente | Descripción |
|----|------------|-------------|
| SB-6 | Express Server | HTTP API con middleware |
| SB-7 | WebSocket Server | Streaming de respuestas del agente |
| SB-8 | AgentRuntime | Bucle de ejecución con LangChain |
| SB-9 | ToolRegistry | Gestión de tools habilitadas |
| SB-10 | RetrievalChain | RAG con pgvector |

**Endpoints principales:**

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/auth/login` | Iniciar sesión con Discord |
| `POST` | `/api/auth/logout` | Cerrar sesión |
| `GET` | `/api/auth/me` | Obtener usuario actual |
| `GET` | `/api/search` | Buscar en conocimiento indexado |
| `GET` | `/api/documents` | Listar documentos |
| `POST` | `/api/chat` | Enviar mensaje al agente |
| `GET` | `/api/conversations` | Listar conversaciones |
| `GET` | `/api/conversations/:id` | Obtener conversación |
| `POST` | `/api/read-status/:embeddingId` | Marcar como leído |
| `DELETE` | `/api/read-status/:embeddingId` | Marcar como no leído |
| `POST` | `/api/read-status/mark-all` | Marcar canal como leído |
| `GET` | `/api/read-status/unread-count` | Conteo de no leídos |
| `GET` | `/api/auth/roles` | Obtener roles del usuario y canales accesibles |

**Agent Runtime (LangChain):**
```
┌─────────────────────────────────────────────────────────────────┐
│                    AGENT RUNTIME                                 │
└─────────────────────────────────────────────────────────────────┘

1. RECIBIR MENSAJE
   └─▶ Validar input (Zod)
   └─▶ Verificar autenticación

2. ENSAMBLAR CONTEXTO
   └─▶ System prompt (de config)
   └─▶ Tools habilitadas
   └─▶ Historial de conversación (summary memory)
   └─▶ Fragmentos recuperados (RAG)

3. EJECUTAR BUCLE
   └─▶ LLM genera respuesta o tool call
   └─▶ Si tool call:
       └─▶ Verificar permisos (auto/ask/off)
       └─▶ Ejecutar tool en sandbox
       └─▶ Agregar resultado al contexto
       └─▶ Repetir
   └─▶ Si respuesta final:
       └─▶ Streaming al cliente

4. GUARDAR
   └─▶ Guardar mensajes en DB
   └─▶ Retornar respuesta con citas
```

**Estrategia de memoria de conversación:**

Se usa `ConversationSummaryBufferMemory` de LangChain con los siguientes parámetros:
- Ventana deslizante: últimos **20 turnos** completos (configurable vía `agent.memory_window` en config).
- Cuando el historial supera el 60% del context window del modelo, se genera un resumen comprimido del historial anterior.
- El resumen se almacena en la tabla `messages` con `role: "system"` para persistencia entre sesiones.
- Presupuesto máximo de tokens para historial: **4.000 tokens** (ajustable según el modelo configurado).

**Modos de fallo del Agent Runtime:**

| Escenario | Comportamiento esperado |
|-----------|------------------------|
| API LLM no disponible (5xx, timeout) | Retornar HTTP 503 con mensaje: `"El agente no está disponible temporalmente. Intenta de nuevo en unos minutos."`. Registrar en Sentry. El endpoint `/health` expone `"agent": "degraded"`. |
| pgvector retorna 0 resultados | El agente responde explícitamente: `"No encontré información sobre esto en el conocimiento indexado de la comunidad."` No inventa ni rellena con conocimiento general. |
| Tool call falla o timeout | El agente registra el fallo, omite el resultado de la tool y continúa el razonamiento. Si la tool es crítica para responder, lo indica al usuario. |
| Context window superado | El mecanismo de memoria comprime el historial antes de cada llamada. Si aun así se supera, se trunca el historial más antiguo respetando el sistema prompt y los últimos 5 turnos. |

### 4.3 Web App — Interfaz de usuario

**Responsabilidad:** Proporcionar interfaz de búsqueda, listado de documentos y chat.

| ID | Componente | Descripción |
|----|------------|-------------|
| SB-11 | SearchView | Búsqueda semántica con filtros |
| SB-12 | DocumentList | Listado paginado de documentos |
| SB-13 | ChatWindow | Interfaz de chat con streaming |
| SB-14 | ReadStatusBadges | Badges de estado de lectura |
| SB-15 | Sidebar | Filtros y conteo de no leídos |

**Vistas principales:**

| Vista | Descripción |
|-------|-------------|
| **Search** | Búsqueda por texto con resultados por relevancia/fecha |
| **Documents** | Listado de todos los documentos indexados |
| **Chat** | Conversación con el agente |
| **Read Status** | Filtrado por leído/no leído |
| **Statistics** | KPIs de conocimiento, actividad de indexado (14 días), volumen por canal, cobertura de lectura personal y top contribuidores (Top 5 usuarios) — RBAC-scoped (AD-12), agrega sobre datos existentes |

### 4.4 Base de datos

**Responsabilidad:** Almacenar mensajes, embeddings, sesiones, conversaciones y estado de lectura.

**PostgreSQL + pgvector:**

| Tabla | Propósito |
|-------|-----------|
| `discord_messages` | Mensajes originales de Discord |
| `embeddings` | Fragmentos con vectores (pgvector) |
| `users` | Usuarios autenticados |
| `sessions` | Sesiones activas |
| `conversations` | Conversaciones con el agente |
| `messages` | Mensajes de conversaciones |
| `user_read_status` | Estado de lectura por usuario |
| `channel_permissions` | Mapeo canal → roles permitidos (RBAC) |
| `user_roles_cache` | Cache de roles de usuario con TTL |

**Índices críticos:**
```sql
-- Búsqueda vectorial (pgvector)
CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (embedding vector_cosine_ops);

-- Búsqueda por canal/fecha
CREATE INDEX idx_discord_messages_channel ON discord_messages(channel_id, created_at DESC);

-- Read tracking
CREATE INDEX idx_user_read_status_user ON user_read_status(user_id);
CREATE INDEX idx_user_read_status_embedding ON user_read_status(embedding_id);
```

### 4.5 Redis Streams

**Responsabilidad:** Desacoplamiento de la indexación y cola de eventos.

| Stream | Producer | Consumer | Descripción |
|--------|----------|----------|-------------|
| `discord.messages` | Discord Bot | Indexer | Mensajes para indexar |
| `discord.messages.updated` | Discord Bot | SyncHandler | Mensajes editados para re-indexar |
| `discord.messages.deleted` | Discord Bot | SyncHandler | Mensajes borrados para purgar |
| `knowledge.events` | Indexer / SyncHandler | Notifier | Eventos de notificación |

### 4.6 Configuración

**Responsabilidad:** Definir toda la configuración del sistema de forma declarativa.

**Archivos de configuración:**

| Archivo | Propósito |
|---------|-----------|
| `Share2Brain.config.yml` | Configuración principal del sistema |
| `.env` | Secretos (tokens, API keys, URLs) |

**Estructura de Share2Brain.config.yml:**

```yaml
# Share2Brain.config.yml
version: "1.0"  # Versión del schema de configuración; Share2Brain valida compatibilidad al arrancar

# Discord Bot
discord:
  guild_id: "${DISCORD_GUILD_ID}"
  channels:
    - id: "1234567890"
      name: "general"
      enabled: true
    - id: "1234567891"
      name: "soporte"
      enabled: true
  backfill:
    enabled: true
    limit: 1000
    ignore_bots: true
  ignore_bots: true

# Agent (LLM)
agent:
  provider: "anthropic"      # anthropic | openai | custom
  model: "claude-sonnet-4-6"
  base_url: "${LLM_BASE_URL}"    # opcional; OBLIGATORIO si provider: custom
  api_key: "${LLM_API_KEY}"      # ref a secreto (.env)
  temperature: 0.7
  max_iterations: 10
  memory_window: 20          # turnos de historial antes de comprimir; ver SD-17
  system_prompt: |
    Eres el asistente de la comunidad de Discord.
    Responde preguntas usando ÚNICAMENTE los mensajes indexados.
    Siempre cita el canal, autor y fecha del mensaje original.
    Si no encuentras información relevante, dilo explícitamente sin inventar.

# Embeddings
embeddings:
  provider: "openai"         # openai | custom  (NO anthropic — sin API de embeddings)
  model: "text-embedding-3-small"
  dimensions: 1536           # debe coincidir con la columna vector(N); deploy-time
  base_url: "${EMBEDDINGS_BASE_URL}"  # opcional; OBLIGATORIO si provider: custom
  api_key: "${EMBEDDINGS_API_KEY}"    # ref a secreto (.env)

# Read Tracking
read_tracking:
  enabled: true
  auto_mark_read_on_click: true
  show_unread_badge: true
  show_unread_count_in_sidebar: true

# Sync (editions & deletions)
sync:
  enabled: true
  sync_on_start: true
  delete_policy: "soft"  # soft = marcar deleted_at | hard = borrar embedding
  notify_on_edit: true
  notify_on_delete: true

# Access Control (RBAC)
access_control:
  enabled: true
  default_policy: "deny"  # deny = sin acceso por defecto | allow = acceso total por defecto
  role_cache_ttl: 300  # segundos (5 minutos)
  channel_permissions:
    # Por canal específico
    - channel_id: "1234567890"
      name: "staff"
      allowed_roles: ["admin", "mod"]
    - channel_id: "1234567891"
      name: "general"
      allowed_roles: ["admin", "mod", "member"]
    # Por categoría
    - category_id: "9876543210"
      name: "Soporte"
      allowed_roles: ["admin", "mod", "soporte"]
    # Excepciones (canal específico sobrescribe categoría)
    - channel_id: "1234567892"
      name: "soporte-privado"
      allowed_roles: ["admin"]

# Tools
tools:
  - name: "search_web"
    enabled: false          # deshabilitado por defecto; habilitar solo si el operador configura proveedor de búsqueda
    permission: "ask"       # requiere confirmación del usuario antes de ejecutar

# Limits
limits:
  global:
    max_queries_per_day: 1000
    max_tokens_per_day: 1000000
  per_user:
    max_queries_per_hour: 50

# Notifications (Telegram + Slack)
notifications:
  telegram:
    enabled: true
    bot_token: "${TELEGRAM_BOT_TOKEN}"
    chat_id: "${TELEGRAM_CHAT_ID}"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    channel: "#Share2Brain-alerts"

# Security
security:
  rate_limit:
    window_ms: 60000
    max_requests: 20
  allowed_origins:
    - "https://tu-dominio.com"

# Observability
observability:
  sentry_dsn: "${SENTRY_DSN}"
  log_level: "info"
```

### 4.7 Autenticación

**Responsabilidad:** Autenticar miembros del guild de Discord via OAuth2.

**Flujo OAuth2:**
```
┌─────────────────────────────────────────────────────────────────┐
│                    DISCORD OAuth2 FLOW                           │
└─────────────────────────────────────────────────────────────────┘

1. Usuario hace clic "Login with Discord"
   └─▶ Redirect a Discord OAuth2

2. Discord autentica al usuario
   └─▶ Scopes: identify, guilds.members.read

3. Discord redirige con código de autorización

4. Backend intercambia código por token
   └─▶ POST https://discord.com/api/oauth2/token

5. Backend obtiene información del usuario
   └─▶ GET https://discord.com/api/users/@me

6. Backend verifica membresía en el guild y obtiene roles
   └─▶ GET https://discord.com/api/users/@me/guilds/{guild_id}/member
   └─▶ Extraer roles del member
   └─▶ Guardar en user_roles_cache (con TTL configurable)

7. Si es miembro:
   └─▶ Crear sesión en DB
   └─▶ Establecer cookie httpOnly
   └─▶ Redirigir a la app

8. Si no es miembro:
   └─▶ Rechazar acceso
```

### 4.8 Read Tracking

**Responsabilidad:** Mantener el estado de lectura independiente para cada usuario y fragmento.

**Flujo:**
```
┌─────────────────────────────────────────────────────────────────┐
│                    READ TRACKING FLOW                            │
└─────────────────────────────────────────────────────────────────┘

1. NUEVO CONTENIDO INDEXADO
   └─▶ Se crea embedding en pgvector
   └─▶ Automáticamente es "No leído" para todos los usuarios

2. USUARIO BUSCA
   └─▶ Ve resultados con badge 🔵 No leído / ✅ Leído
   └─▶ Puede filtrar solo "No leídos"

3. USUARIO ABRE UN FRAGMENTO
   └─▶ Se registra en user_read_status
   └─▶ Badge cambia a ✅ Leído

4. USUARIO MARCA CANAL COMO LEÍDO
   └─▶ POST /api/read-status/mark-all
   └─▶ El backend procesa los embeddings del canal en **lotes de 1.000** para evitar transacciones masivas
   └─▶ Solo puede marcar canales a los que tiene acceso RBAC
   └─▶ Todos los embeddings de ese canal se marcan como leídos (procesamiento asíncrono si el canal tiene >5.000 fragmentos)
```

---

## 5. Modelo de datos

### 5.1 Diagrama ER

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     users       │       │    sessions     │       │ discord_messages │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ id (UUID PK)    │◄──┐   │ id (UUID PK)    │       │ id (UUID PK)    │
│ discord_id (UQ) │   │   │ token (UQ)      │       │ message_id (UQ) │
│ username        │   │   │ user_id (FK)────┼───┐   │ channel_id      │
│ avatar          │   │   │ expires_at      │   │   │ channel_name    │
│ created_at      │   │   └─────────────────┘   │   │ author_id       │
└─────────────────┘   │                         │   │ author_name     │
                      │                         │   │ content         │
                      │   ┌─────────────────┐   │   │ attachments     │
                      │   │  conversations  │   │   │ embeds          │
                      │   ├─────────────────┤   │   │ created_at      │
                      │   │ id (UUID PK)    │◄──┼───│ indexed_at      │
                      │   │ user_id (FK)────┼───┘   └─────────────────┘
                      │   │ title           │              │
                      │   │ created_at      │              │
                      │   └─────────────────┘              │
                      │                                    │
                      │   ┌─────────────────┐              │
                      │   │    messages     │              │
                      │   ├─────────────────┤              │
                      │   │ id (UUID PK)    │              │
                      │   │ conversation_id │              │
                      │   │ role            │              │
                      │   │ content         │              │
                      │   │ tool_calls      │              │
                      │   │ created_at      │              │
                      │   └─────────────────┘              │
                      │                                    │
                      │   ┌─────────────────┐       ┌──────▼─────────┐
                      │   │ user_read_status │       │   embeddings   │
                      │   ├─────────────────┤       ├─────────────────┤
                      │   │ id (UUID PK)    │       │ id (UUID PK)    │
                      │   │ user_id (FK)────┼───┐   │ message_id (FK) │
                      │   │ embedding_id (FK)┼───┼───│ chunk_text      │
                      │   │ read_at         │   │   │ embedding       │
                      │   │ UNIQUE(user_id, │   │   │ (vector 1536)   │
                      │   │   embedding_id) │   │   │ metadata        │
                      │   └─────────────────┘   │   │ created_at      │
                      └─────────────────────────┘   └─────────────────┘
```

### 5.2 Esquemas SQL

```sql
-- Habilitar pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Usuarios
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_id VARCHAR(64) UNIQUE NOT NULL,
    username VARCHAR(255) NOT NULL,
    avatar VARCHAR(512),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Sesiones
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token VARCHAR(255) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Mensajes de Discord
CREATE TABLE discord_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id VARCHAR(64) UNIQUE NOT NULL,
    channel_id VARCHAR(64) NOT NULL,
    channel_name VARCHAR(255),
    author_id VARCHAR(64) NOT NULL,
    author_name VARCHAR(255),
    content TEXT,
    attachments JSONB DEFAULT '[]',
    embeds JSONB DEFAULT '[]',
    created_at TIMESTAMP NOT NULL,
    indexed_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP NULL  -- NULL = activo, timestamp = borrado (soft delete)
);

-- Embeddings (pgvector)
CREATE TABLE embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES discord_messages(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    embedding vector(1536) NOT NULL,  -- 1536 = default; parametrizado por embeddings.dimensions
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Conversaciones
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    title VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Mensajes de conversación
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    tool_calls JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Read tracking
CREATE TABLE user_read_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    embedding_id UUID NOT NULL REFERENCES embeddings(id),
    read_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, embedding_id)
);

-- Channel permissions (RBAC)
CREATE TABLE channel_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id VARCHAR(64),        -- NULL si es por categoría
    category_id VARCHAR(64),       -- NULL si es por canal
    allowed_roles JSONB NOT NULL,  -- ["admin", "mod"]
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (channel_id IS NOT NULL OR category_id IS NOT NULL)
);

-- User roles cache
CREATE TABLE user_roles_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    discord_id VARCHAR(64) NOT NULL,
    roles JSONB NOT NULL,           -- ["role1", "role2"]
    guild_id VARCHAR(64) NOT NULL,
    cached_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    UNIQUE(user_id, guild_id)
);

-- Índices
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_discord_messages_channel ON discord_messages(channel_id, created_at DESC);
CREATE INDEX idx_discord_messages_author ON discord_messages(author_id);
CREATE INDEX idx_discord_messages_indexed ON discord_messages(indexed_at);
CREATE INDEX idx_discord_messages_deleted ON discord_messages(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_embeddings_message ON embeddings(message_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_user_read_status_user ON user_read_status(user_id);
CREATE INDEX idx_user_read_status_embedding ON user_read_status(embedding_id);
CREATE INDEX idx_user_read_status_read_at ON user_read_status(read_at);
CREATE INDEX idx_channel_permissions_channel ON channel_permissions(channel_id);
CREATE INDEX idx_channel_permissions_category ON channel_permissions(category_id);
CREATE INDEX idx_user_roles_cache_user ON user_roles_cache(user_id);
CREATE INDEX idx_user_roles_cache_expires ON user_roles_cache(expires_at);
```

---

## 6. Arquitectura técnica

### 6.1 Clean Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    INTERFACE LAYER                               │
│  (HTTP, WebSocket, Discord Bot, React UI)                       │
├─────────────────────────────────────────────────────────────────┤
│                  APPLICATION LAYER                               │
│  (Use Cases, Agent Runtime, DTOs, Ports)                        │
├─────────────────────────────────────────────────────────────────┤
│                    DOMAIN LAYER                                  │
│  (Entities, Value Objects, Events, Interfaces)                  │
├─────────────────────────────────────────────────────────────────┤
│                 INFRASTRUCTURE LAYER                             │
│  (Database, LangChain, Discord.js, Redis)                       │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Stack tecnológico

| Capa | Elección | Razón |
|------|----------|-------|
| Backend | **TypeScript/Node.js** | Stack del máster; ecosistema maduro para IA |
| Framework IA | **LangChain.js** | Agentes, tools, retrieval, memory pre-construidos |
| Discord Bot | **discord.js** | Librería estándar para bots de Discord en Node.js |
| Base de datos | **PostgreSQL + pgvector** | Mensajes, embeddings, sesiones, conversaciones |
| Cola de eventos | **Redis Streams** | Desacoplamiento de indexación |
| Configuración | **YAML + Zod** | Infrastructure-as-Code; validación de schema |
| Notificaciones | **Telegram Bot API** | Notificaciones al operador |
| Observabilidad | **Sentry + Pino** | Errores + logging estructurado |
| Empaquetado | **Docker Compose** | App + bot + base + redis |
| Web App | **React + Vite** | Búsqueda + chat |
| Testing | **Vitest + Playwright** | Unit/integration + E2E |
| CI/CD | **GitHub Actions** | Pipeline completo |

### 6.3 Estructura del repositorio

```
.
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env.example
├── Share2Brain.config.yml.example
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── domain/
│   │   ├── entities/
│   │   │   ├── Message.ts
│   │   │   ├── Document.ts
│   │   │   ├── Conversation.ts
│   │   │   └── User.ts
│   │   ├── value-objects/
│   │   │   ├── ChannelId.ts
│   │   │   ├── EmbeddingVector.ts
│   │   │   └── ToolPermission.ts
│   │   ├── events/
│   │   │   ├── MessageIndexed.ts
│   │   │   └── IndexCompleted.ts
│   │   └── ports/
│   │       ├── MessageRepository.ts
│   │       ├── VectorStore.ts
│   │       ├── EventPublisher.ts
│   │       ├── LLMProvider.ts
│   │       ├── Notifier.ts
│   │       └── ReadStatusRepository.ts
│   │
│   ├── application/
│   │   ├── use-cases/
│   │   │   ├── IndexMessage.ts
│   │   │   ├── SearchKnowledge.ts
│   │   │   ├── ChatWithAgent.ts
│   │   │   ├── AuthenticateUser.ts
│   │   │   ├── MarkAsRead.ts
│   │   │   ├── GetUnreadCount.ts
│   │   │   └── MarkChannelAsRead.ts
│   │   ├── dtos/
│   │   │   ├── SearchResult.ts
│   │   │   ├── ChatRequest.ts
│   │   │   └── ChatResponse.ts
│   │   └── ports/
│   │       ├── MessageRepository.ts
│   │       ├── VectorStore.ts
│   │       ├── Notifier.ts
│   │       └── ReadStatusRepository.ts
│   │
│   ├── infrastructure/
│   │   ├── config/
│   │   │   ├── loader.ts
│   │   │   ├── schema.ts
│   │   │   └── types.ts
│   │   ├── database/
│   │   │   ├── postgres/
│   │   │   │   ├── MessageRepository.ts
│   │   │   │   ├── ConversationRepository.ts
│   │   │   │   ├── UserRepository.ts
│   │   │   │   └── ReadStatusRepository.ts
│   │   │   ├── pgvector/
│   │   │   │   └── PgVectorStore.ts
│   │   │   └── migrations/
│   │   │       └── 001_initial.sql
│   │   ├── redis/
│   │   │   ├── EventPublisher.ts
│   │   │   └── EventConsumer.ts
│   │   ├── discord/
│   │   │   ├── DiscordBot.ts
│   │   │   ├── MessageIndexer.ts
│   │   │   ├── Backfiller.ts
│   │   │   ├── SyncHandler.ts
│   │   │   └── RoleResolver.ts
│   │   ├── langchain/
│   │   │   ├── AgentRuntime.ts
│   │   │   ├── ToolRegistry.ts
│   │   │   ├── MemoryManager.ts
│   │   │   └── RetrievalChain.ts
│   │   ├── auth/
│   │   │   ├── DiscordOAuth.ts
│   │   │   ├── SessionManager.ts
│   │   │   └── PermissionGuard.ts
│   │   ├── notifications/
│   │   │   └── TelegramNotifier.ts
│   │   └── observability/
│   │       ├── SentryConfig.ts
│   │       └── Logger.ts
│   │
│   └── interface/
│       ├── http/
│       │   ├── server.ts
│       │   ├── middleware/
│       │   │   ├── auth.ts
│       │   │   ├── rateLimiter.ts
│       │   │   ├── cors.ts
│       │   │   └── securityHeaders.ts
│       │   └── routes/
│       │       ├── auth.ts
│       │       ├── search.ts
│       │       ├── chat.ts
│       │       ├── documents.ts
│       │       ├── read-status.ts
│       │       └── health.ts
│       └── websocket/
│           └── ChatWebSocket.ts
│
├── web/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Search/
│   │   │   │   ├── SearchBar.tsx
│   │   │   │   ├── SearchResults.tsx
│   │   │   │   ├── ResultCard.tsx
│   │   │   │   └── ReadStatusFilter.tsx
│   │   │   ├── Chat/
│   │   │   │   ├── ChatWindow.tsx
│   │   │   │   ├── MessageBubble.tsx
│   │   │   │   └── SourceCitation.tsx
│   │   │   ├── Documents/
│   │   │   │   ├── DocumentList.tsx
│   │   │   │   ├── DocumentCard.tsx
│   │   │   │   └── UnreadBadge.tsx
│   │   │   └── Layout/
│   │   │       ├── Sidebar.tsx
│   │   │       └── Header.tsx
│   │   ├── hooks/
│   │   │   ├── useSearch.ts
│   │   │   ├── useChat.ts
│   │   │   ├── useAuth.ts
│   │   │   └── useReadStatus.ts
│   │   └── pages/
│   │       ├── Search.tsx
│   │       ├── Chat.tsx
│   │       └── Documents.tsx
│   └── package.json
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── .github/workflows/
│   ├── ci.yml
│   ├── test.yml
│   └── release.yml
├── docs/
│   ├── architecture.md
│   └── security.md
└── scripts/
    ├── seed.ts
    └── migrate.ts
```

---

## 7. Docker Compose

### 7.1 docker-compose.yml (desarrollo)

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://share2brain:share2brain@postgres:5432/share2brain
      - REDIS_URL=redis://redis:6379
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_GUILD_ID=${DISCORD_GUILD_ID}
      - SESSION_SECRET=${SESSION_SECRET}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    volumes:
      - ./Share2Brain.config.yml:/app/Share2Brain.config.yml
      - ./src:/app/src
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "127.0.0.1:5432:5432"  # solo localhost en desarrollo; nunca exponer en 0.0.0.0
    environment:
      - POSTGRES_USER=share2brain
      - POSTGRES_PASSWORD=share2brain
      - POSTGRES_DB=share2brain
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./src/infrastructure/database/migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U share2brain"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### 7.2 docker-compose.prod.yml (producción)

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: production
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_GUILD_ID=${DISCORD_GUILD_ID}
    secrets:
      - discord_client_secret   # DISCORD_CLIENT_SECRET — usar secrets, nunca variables de entorno en producción
      - database_url
      - session_secret
      - anthropic_api_key
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: always
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2'

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_USER=share2brain
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=share2brain
    volumes:
      - postgres_data:/var/lib/postgresql/data
    secrets:
      - postgres_password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U share2brain"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: always
    deploy:
      resources:
        limits:
          memory: 1G

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: always
    deploy:
      resources:
        limits:
          memory: 256M

secrets:
  discord_client_secret:
    file: ./secrets/discord_client_secret.txt
  database_url:
    file: ./secrets/database_url.txt
  session_secret:
    file: ./secrets/session_secret.txt
  anthropic_api_key:
    file: ./secrets/anthropic_api_key.txt
  postgres_password:
    file: ./secrets/postgres_password.txt

volumes:
  postgres_data:
  redis_data:
```

### 7.3 Dockerfile multi-stage

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

## 8. Variables de entorno

### 8.1 .env.example

```env
# Discord
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_GUILD_ID=your_guild_id
DISCORD_BOT_TOKEN=your_bot_token
# URL de callback OAuth2 — debe estar en la lista de redirect URIs de tu aplicación Discord
# Desarrollo: http://localhost:3000/api/auth/callback
# Producción:  https://tu-dominio.com/api/auth/callback
DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/callback

# Database
DATABASE_URL=postgresql://share2brain:password@localhost:5432/share2brain

# Redis
REDIS_URL=redis://localhost:6379

# Session
SESSION_SECRET=your_session_secret_at_least_32_chars

# LLM (agent.provider) y Embeddings (embeddings.provider)
LLM_API_KEY=your_llm_provider_key
LLM_BASE_URL=                       # solo si agent.provider: custom
EMBEDDINGS_API_KEY=your_embeddings_provider_key
EMBEDDINGS_BASE_URL=                # solo si embeddings.provider: custom

# Telegram (opcional)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Slack (opcional)
SLACK_BOT_TOKEN=your_slack_bot_token
SLACK_CHANNEL=#Share2Brain-alerts

# Sentry (opcional)
SENTRY_DSN=your_sentry_dsn
```

---

## 9. Seguridad

### 9.1 Requisitos de seguridad

| ID | Requisito | Implementación |
|----|-----------|----------------|
| SS-1 | Secretos nunca al cliente | Docker secrets en producción |
| SS-2 | Cookies httpOnly, secure | Configuración en SessionManager |
| SS-3 | Rate limiting | express-rate-limit por IP y usuario |
| SS-4 | Validación de inputs | Zod schema en cada endpoint |
| SS-5 | Tools con sandboxing | Ejecución en proceso aislado (worker_thread o subprocess); sin acceso al filesystem del host; sin llamadas de red fuera de las URLs permitidas en config; timeout máximo de 10s por tool call |
| SS-6 | Headers de seguridad | CSP, HSTS, X-Frame-Options |
| SS-7 | SQL injection | Queries parametrizadas |
| SS-8 | XSS | React auto-escaping; CSP |
| SS-9 | RBAC por canal | Filtro de permisos en queries; cache con TTL configurable (default 300s). El Operador puede forzar invalidación inmediata de un usuario via `POST /api/admin/roles/invalidate/:userId`. Trade-off documentado: TTL <60s aumenta significativamente las llamadas a Discord API. |
| SS-10 | Backup y recuperación | `pg_dump` diario programado (configurable en `Share2Brain.config.yml`). Retención mínima recomendada: 7 días. El Operador es responsable del backup del volumen `postgres_data`. Procedimiento de restore documentado en `/docs/operations.md`. |
| SS-11 | Expiración de sesiones | TTL de sesión configurable (default 7 días) via `SESSION_TTL_DAYS` en `.env`. Limpieza automática de sesiones expiradas ejecutada al inicio y cada 24h via cron interno. Un token expirado retorna HTTP 401 inmediatamente. |

### 9.2 Rate Limiting

```typescript
// Configuración de rate limiting
const rateLimitConfig = {
  global: {
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100 // 100 requests por ventana
  },
  chat: {
    windowMs: 60 * 1000, // 1 minuto
    max: 20 // 20 mensajes por minuto
  },
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10 // 10 intentos por ventana
  }
};
```

---

## 10. Observabilidad

### 10.1 Health Check

```typescript
// GET /health
{
  "status": "healthy",
  "timestamp": "2026-06-29T10:30:00Z",
  "version": "1.0.0",
  "components": {
    "database": "connected",
    "redis": "connected",
    "discord": "connected",
    "indexer": "running",
    "notifier": "connected"
  }
}
```

### 10.2 Logging estructurado

```typescript
// Pino logger
const logger = pino({
  name: 'Share2Brain',
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime
});
```

### 10.3 Notificaciones

**Eventos notificados:**

| Evento | Formato |
|--------|---------|
| Backfill completado | ✅ Share2Brain — Backfill completado |
| Nuevo contenido indexado | 📝 Nuevo conocimiento indexado |
| Error en indexación | ❌ Share2Brain — Error en indexación |
| Servicio iniciado | 🚀 Share2Brain — Servicio iniciado |
| Errores críticos | 🔴 Share2Brain — Error crítico |
| Mensaje editado | ✏️ Share2Brain — Mensaje editado en #canal |
| Mensaje borrado | 🗑️ Share2Brain — Mensaje borrado en #canal |
| Sync completado | 🔄 Share2Brain — Sincronización completada |

---

## 11. Requisitos no funcionales

### 11.1 Performance

| ID | Requisito | Target |
|----|-----------|--------|
| SNF-1 | Búsqueda vectorial P95 | < 200ms |
| SNF-2 | Tiempo de respuesta del agente P95 | < 5s |
| SNF-3 | Streaming de respuestas | < 100ms primer chunk |
| SNF-4 | Indexación asíncrona | No bloquear el bot |
| SNF-5 | Backfill con rate limiting | No saturar Discord API |
| SNF-13 | Latencia de re-indexación por edición | < 5s |
| SNF-14 | Latencia de purgado por borrado | < 3s |
| SNF-15 | Sync post-reinicio (1000 msgs) | < 60s |
| SNF-16 | Overhead de RBAC en search | < 10ms |
| SNF-17 | TTL cache de roles | Configurable (default 300s) |

### 11.2 Disponibilidad

| ID | Requisito | Criterio observable |
|----|-----------|---------------------|
| SNF-6 | Health check en `/health` | El endpoint retorna HTTP 200 con estado de cada componente en <500ms. Retorna HTTP 503 si cualquier componente está degradado. El campo `"agent"` reporta `"degraded"` cuando el API LLM no es alcanzable. |
| SNF-7 | Restart automático en fallo | El contenedor Docker se reinicia en <30s tras un crash (política `restart: unless-stopped`). Se emite alerta Notifier si el reinicio ocurre más de 3 veces en 5 minutos. |
| SNF-8 | Graceful shutdown | Al recibir SIGTERM, el servidor espera hasta 10s para completar requests en curso, cierra conexiones DB y Redis, y termina el proceso. Las peticiones nuevas durante el shutdown reciben HTTP 503. |
| SNF-9 | Logging de errores | Todos los errores HTTP 5xx son capturados por Sentry con stack trace y contexto de usuario. Los errores de indexación se loguean en Pino con nivel `error` e incluyen `channel_id` y `message_id`. |

### 11.3 Testing

| ID | Requisito | Target |
|----|-----------|--------|
| SNF-10 | Unit tests | Cobertura > 80% |
| SNF-11 | Integration tests | Discord bot + pgvector |
| SNF-12 | E2E tests | Flujos de búsqueda y chat |

---

## 12. Despliegue

### 12.1 Guía de instalación

```bash
# 1. Clonar repositorio
git clone https://github.com/Share2Brain/Share2Brain.git
cd Share2Brain

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus valores

# 3. Configurar Share2Brain
cp Share2Brain.config.yml.example Share2Brain.config.yml
# Editar Share2Brain.config.yml

# 4. Levantar servicios
docker compose up -d

# 5. Verificar
docker compose logs -f app
curl http://localhost:3000/health
```

### 12.2 Requisitos del servidor

| Recurso | Mínimo | Recomendado |
|---------|--------|-------------|
| CPU | 2 cores | 4 cores |
| RAM | 2 GB | 4 GB |
| Disco | 20 GB SSD | 50 GB SSD |
| OS | Ubuntu 22.04 | Ubuntu 24.04 |
| Docker | 24.0+ | 25.0+ |

### 12.3 Variables de entorno mínimas

```env
# Obligatorio
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_GUILD_ID=
DISCORD_BOT_TOKEN=
DISCORD_REDIRECT_URI=https://tu-dominio.com/api/auth/callback
DATABASE_URL=
REDIS_URL=
SESSION_SECRET=
LLM_API_KEY=            # clave del proveedor LLM (agent.provider)
LLM_BASE_URL=           # solo si agent.provider: custom
EMBEDDINGS_API_KEY=     # clave del proveedor de embeddings (embeddings.provider)
EMBEDDINGS_BASE_URL=    # solo si embeddings.provider: custom

# Opcional
SESSION_TTL_DAYS=7
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SLACK_BOT_TOKEN=
SLACK_CHANNEL=
SENTRY_DSN=
```

---

## 13. Threat Model

| Amenaza | Mitigación |
|---------|------------|
| Bot lee canales no autorizados | Configuración explícita de canales (`enabled: false` excluye el canal); permisos de Discord verificados en el gateway |
| Mensajes sensibles indexados | Lista de canales a excluir; ignorar mensajes de bots |
| Rate limit de Discord API | Backfill con delay; reintentos con exponential backoff |
| Alucinaciones del agente | RAG estricto; citations obligatorias; señalar cuando no hay fuente |
| Costos de embedding | Chunking eficiente; caching de embeddings; límites de uso |
| Acceso no autorizado | OAuth2 + verificación de membresía en guild |
| Usuario accede a contenido de canales restringidos | RBAC por canal; filtro en queries; cache con TTL |
| Inyección SQL | Queries parametrizadas; ORM |
| XSS | React auto-escaping; CSP headers |
| Secretos expuestos | Docker secrets; variables de entorno |
| Contenido de mensajes procesado por API LLM externo | Delegación explícita: SO-7 cubre datos en reposo. El Operador elige y acepta las políticas del proveedor LLM (Anthropic/OpenAI). El contenido de mensajes sale del servidor solo hacia el proveedor configurado. Documentado en §0.1 AS-4 y SD-18. |
| Embeddings de mensajes borrados aparecen en búsqueda | La cadena de recuperación filtra siempre `WHERE deleted_at IS NULL` en el join con `discord_messages`; embeddings de mensajes soft-deleted son excluidos de resultados. |

---

## 14. Preguntas Abiertas

| ID | Pregunta | Propietario | Condición de revisión |
|----|----------|-------------|----------------------|
| PO-1 | ¿Qué ocurre con las sesiones activas de un usuario al que se le revocan permisos en Discord durante una sesión activa de Share2Brain? ¿Se termina la sesión al expirar la cache de roles (max TTL) o hay logout forzado? | Ingeniería + Producto | Antes de implementar RBAC |
| PO-2 | ¿Cuál es la estrategia de migración de `Share2Brain.config.yml` cuando se añaden o eliminan campos entre versiones? ¿Error fatal o warning y valores default? | Ingeniería | Antes del primer release público |
| PO-3 | ¿El Operador es responsable de configurar y pagar el proveedor de búsqueda web si habilita `search_web`? ¿O Share2Brain provee un proveedor por defecto con límites de uso? | Producto | Antes de activar la tool en v1 |
| PO-4 | ¿Cómo se gestiona el upgrade de `Share2Brain.config.yml` para Operadores existentes cuando migran a una nueva versión del sistema? | Ingeniería | Antes del segundo release público |
| PO-5 | RESUELTO (Story 3.0): el proveedor y modelo de embeddings son configurables (`embeddings.provider`: OpenAI o custom OpenAI-compatible; `embeddings.model`; `embeddings.dimensions`) vía `Share2Brain.config.yml`. Anthropic no aplica (sin API de embeddings). Queda validar en piloto qué modelo rinde mejor con jerga técnica (Solidity, Rust). | Producto + Ingeniería | Validar con comunidades piloto técnicas en beta sobre el modelo configurado |
| PO-6 | ¿Qué ocurre con los embeddings al re-indexar si el modelo de embedding cambia (ej. el Operador cambia `embedding_model` en config)? ¿Reindexación total automática o manual? | Ingeniería | Antes de exponer `embedding_model` como config pública |
| PO-7 | ¿El formato de fecha y autor en las citas del agente sigue la zona horaria del servidor o la del usuario? | UX + Ingeniería | Antes de implementar el Agent Runtime |
| PO-8 | ¿Cómo se gestiona el `backfill_limit` si un canal tiene más mensajes que el límite? ¿Se documenta explícitamente que los mensajes más antiguos no estarán indexados? | Producto | Antes del lanzamiento; añadir advertencia visible en la UI |

---

## 15. Decisiones

| ID | Decisión | Justificación |
|----|----------|---------------|
| SD-1 | Discord como fuente de conocimiento | No requiere ingestión manual; actualización automática |
| SD-2 | Config via YAML | Infrastructure-as-Code; Git-friendly; para público técnico |
| SD-3 | Web para búsqueda y chat | Interfaz accesible; no requiere Discord para buscar |
| SD-4 | Telegram para notificaciones | Simple; gratuito; API HTTP directa |
| SD-5 | Single-tenant | Un despliegue = una comunidad; simplifica todo |
| SD-6 | LangChain.js | Framework estándar; tools, retrieval, memory pre-construidos |
| SD-7 | Read tracking por usuario | Cada miembro tiene su propio progreso de lectura |
| SD-8 | Docker Compose | Despliegue trivial con un comando |
| SD-9 | pgvector para embeddings | Nativo de PostgreSQL; sin servicio externo |
| SD-10 | Sync de ediciones/borrados | Fiabilidad de citations; contenido obsoleto rompe SO-3 |
| SD-11 | delete_policy configurable | Flexibilidad: soft para historial, hard para limpieza. **Riesgo reconocido:** el default `soft` puede resultar en embeddings activos de mensajes ya borrados en Discord. Mitigado por filtro `WHERE deleted_at IS NULL` en queries de recuperación (§13). La decisión de default pertenece al Operador. |
| SD-12 | Sync on start | Cobertura de eventos perdidos durante downtime |
| SD-13 | RBAC por canal en config | Control explícito; el operador define quién ve qué |
| SD-14 | Cache de roles con TTL | Balance entre precisión y performance. TTL <60s causa presión en Discord API (rate limit 1 req/s para `/guilds/{id}/member`). El Operador puede forzar invalidación inmediata via `POST /api/admin/roles/invalidate/:userId` para escenarios disciplinarios urgentes. |
| SD-15 | default_policy: deny | Seguridad por defecto; denegar si no hay regla explícita |
| SD-16 | mark-all usa batch processing | Para evitar transacciones masivas (potencialmente 100k+ inserts), `POST /api/read-status/mark-all` procesa embeddings en lotes de 1.000. Solo puede operar sobre canales con acceso RBAC del usuario solicitante. |
| SD-17 | Estrategia de memoria de conversación | ConversationSummaryBufferMemory: ventana de 20 turnos, resumen comprimido cuando supera el 60% del context window, presupuesto de 4.000 tokens para historial. Configurable via `agent.memory_window`. |
| SD-18 | SO-7 acotado a datos en reposo | "Datos bajo control" significa que PostgreSQL, Redis y los archivos de configuración residen en el servidor del Operador. El contenido de mensajes se envía a los proveedores configurados por el Operador — inferencia (LLM: Anthropic/OpenAI/custom) y embeddings (OpenAI/custom), posiblemente distintos e incl. endpoint custom self-hosted — delegación explícita documentada en §0.1 AS-4 y §13. |

---

## 16. Hoja de ruta

| Fase | Alcance |
|------|---------|
| **MVP** | Discord bot que escucha canales y indexa, backfill con reconciliación por snowflake, sync de ediciones/borrados, web con búsqueda y chat (streaming), read tracking con batch processing, control de acceso por rol/canal (RBAC), configuración YAML, notificaciones (Telegram/Slack), `docker compose`, tests básicos (unit + integration) |
| **v1** | Compactación de memoria avanzada, tools con confirmación UI, dashboard de métricas de uso, E2E tests completos, panel de admin web |
| **Posterior** | MCP tools, OCR de imágenes, modelos locales vía Ollama, internacionalización completa (más idiomas, contenido — la i18n de la UI es/en se entrega en el Épico 10 vía react-i18next), multi-tenant |

---

## 17. Métricas de éxito

> **Nota:** Los targets marcados con ★ son aspiracionales y serán calibrados en beta con comunidades piloto reales. No bloquean el lanzamiento pero deben ser instrumentados desde el día 1.

| ID | Métrica | Target | Counter-metric |
|----|---------|--------|---------------|
| SM-1 | % de sesiones de chat donde el usuario no repite la misma pregunta en 5 minutos (proxy de "pregunta resuelta") | > 70% ★ | % de sesiones con pregunta repetida en <5 min → indica fallo de retrieval o alucinación |
| SM-2 | % de respuestas del agente con ≥1 fuente citada | > 95% ★ | % de respuestas sin fuente (fallback a conocimiento general) → indica gap en el índice |
| SM-3 | % de sesiones donde el usuario abre ≥1 resultado de búsqueda tras la query (proxy de "resultado encontrado") | > 60% ★ | % de búsquedas con 0 clics en resultados → indica baja relevancia semántica |
| SM-4 | % de conversaciones de chat con ≥2 turnos (proxy de "engagement real") | > 40% ★ | Conversaciones de 1 turno sin seguimiento → indica respuesta insatisfactoria |
| SM-5 | Mensajes indexados por hora en condiciones normales de operación | > 1.000 | Lag de Redis Stream > 5 min → indica cuello de botella en Indexer Worker |
| SM-6 | % de fragmentos marcados como leídos sobre el total del usuario | > 40% ★ | % de usuarios con 0 fragmentos leídos tras 7 días → indica adopción del read tracking |
| SM-7 | Tiempo medio hasta que un fragmento nuevo es leído por al menos 1 miembro | < 7 días ★ | Fragmentos con edad >30 días y 0 lecturas → indica conocimiento "muerto" en el índice |

---

## 18. Checklist de despliegue

### Pre-despliegue

- [ ] Servidor con Docker instalado
- [ ] Dominio configurado (opcional)
- [ ] Certificado SSL (si aplica)
- [ ] Variables de entorno configuradas
- [ ] Share2Brain.config.yml personalizado
- [ ] Discord Bot creado y con permisos
- [ ] `DISCORD_REDIRECT_URI` configurada en el dashboard de la aplicación Discord
- [ ] Credenciales del/los proveedor(es) elegido(s): LLM (Anthropic/OpenAI/custom) y embeddings (OpenAI/custom) con API key (y base_url si custom)
- [ ] Estrategia de backup configurada (cron de `pg_dump` o snapshots del volumen)

### Despliegue

- [ ] Repositorio clonado
- [ ] `docker compose up -d` ejecutado
- [ ] Health check OK (`/health`)
- [ ] Bot conectado a Discord
- [ ] Backfill completado
- [ ] Indexación funcionando

### Post-despliegue

- [ ] Verificar búsqueda
- [ ] Verificar chat con agente
- [ ] Verificar read tracking
- [ ] Notificaciones Telegram configuradas
- [ ] Monitoreo de logs
- [ ] Backup de base de datos programado

---

*Fin del documento.*
