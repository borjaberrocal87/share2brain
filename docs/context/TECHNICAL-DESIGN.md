# Diseño Técnico — Hivly Self-Hosted

| | |
|---|---|
| **Proyecto** | Hivly Self-Hosted |
| **Versión** | 1.0 |
| **Fecha** | 30 de junio de 2026 |
| **Estado** | Final |
| **Fuente** | Derivado de `ARCHITECTURE-SPINE.md` + `docs/PRD.md` |

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Principios de diseño](#2-principios-de-diseño)
3. [Visión general del sistema](#3-visión-general-del-sistema)
4. [Estructura del monorepo](#4-estructura-del-monorepo)
5. [Servicios](#5-servicios)
   - 5.1 [packages/shared — Kernel de dominio](#51-packagesshared--kernel-de-dominio)
   - 5.2 [packages/bot — Discord Bot](#52-packagesbot--discord-bot)
   - 5.3 [packages/workers — Indexer + Sync](#53-packagesworkers--indexer--sync)
   - 5.4 [packages/backend — API + Agente RAG](#54-packagesbackend--api--agente-rag)
   - 5.5 [packages/web — Web App SPA](#55-packagesweb--web-app-spa)
   - 5.6 [nginx — Punto de entrada HTTP](#56-nginx--punto-de-entrada-http)
6. [Modelo de datos](#6-modelo-de-datos)
7. [Pipeline de ingestión](#7-pipeline-de-ingestión)
8. [Sistema de eventos: Redis Streams](#8-sistema-de-eventos-redis-streams)
9. [Agente RAG: LangGraph StateGraph](#9-agente-rag-langgraph-stategraph)
10. [Autenticación y RBAC](#10-autenticación-y-rbac)
11. [API REST](#11-api-rest)
12. [Streaming SSE del chat](#12-streaming-sse-del-chat)
13. [Configuración](#13-configuración)
14. [Despliegue](#14-despliegue)
15. [Stack tecnológico](#15-stack-tecnológico)
16. [Decisiones de arquitectura](#16-decisiones-de-arquitectura)
17. [Pendiente (Deferred)](#17-pendiente-deferred)

---

## 1. Resumen ejecutivo

Hivly es un agente de IA que indexa automáticamente el conocimiento de una comunidad de Discord y responde preguntas en lenguaje natural con fuentes verificables. Cada operador despliega una instancia independiente que sirve a un único servidor Discord (guild) con un solo comando: `docker compose up -d`.

Este documento describe la arquitectura técnica completa del sistema: cómo están organizados los servicios, cómo se comunican, qué datos almacenan y por qué se tomaron las decisiones clave. Es el documento de referencia para cualquier persona que construya, extienda o revise el sistema.

**Lo que construye este documento:**

```
Discord Bot  →  Redis Streams  →  Workers (Indexer + Sync)  →  PostgreSQL + pgvector
                                                                        ↑
                                                              Backend (Express + LangGraph)
                                                                        ↑
                                                                   nginx + React SPA
```

---

## 2. Principios de diseño

El sistema sigue dos patrones combinados:

### Hexagonal (Shared Kernel)

`packages/shared` es el kernel de dominio. Contiene el schema de base de datos, los contratos de API y la configuración. Los cuatro servicios de aplicación (`bot`, `backend`, `workers`, `web`) son adaptadores que dependen del kernel pero **nunca entre sí**.

La regla más importante del monorepo: **los servicios no se importan entre sí**. Si el bot necesita un tipo que también usa el backend, ese tipo vive en `packages/shared`, no en `packages/backend`.

```
packages/shared   ←── todos los servicios dependen de esto
packages/bot      ──┐
packages/backend  ──┼── nunca se importan entre sí
packages/workers  ──┘
packages/web      ───── solo importa de shared (tipos + schemas)
```

### Event-Driven Ingest (Redis Streams)

La ingestión de conocimiento es asíncrona y desacoplada. El Bot no indexa — publica eventos. Los Workers no escuchan Discord — consumen eventos. Este desacoplamiento tiene una consecuencia operacional importante: un backfill de 100.000 mensajes no degrada la API REST, y si el proceso de Workers cae, los eventos esperan en Redis hasta que vuelva (at-least-once delivery con consumer groups y ACK explícito).

---

## 3. Visión general del sistema

### Topología completa de producción

```mermaid
graph TD
    subgraph Internet
        Discord["Discord API / Gateway"]
        Member["Miembro\n(browser)"]
    end

    subgraph Host["Servidor del operador"]
        subgraph compose["Docker Compose"]
            nginx["nginx\n:80/:443\n(único puerto expuesto)"]

            subgraph appnet["Red interna Docker"]
                backend["backend\nExpress + LangGraph\n:3000"]
                bot["bot\ndiscord.js"]
                workers["workers\nIndexer + Sync"]
                migrator["migrator\n(one-shot, drizzle-kit)"]
                pg[("PostgreSQL 17\n+ pgvector 0.8.2\n:5432")]
                redis[("Redis 8\n:6379")]
            end
        end
    end

    Member -->|"HTTPS"| nginx
    nginx -->|"GET /  → dist/"| nginx
    nginx -->|"POST /api/*\nproxy_pass"| backend
    Discord -->|"Gateway WebSocket"| bot
    bot -->|"XADD hivly:discord:*"| redis
    workers -->|"XREADGROUP"| redis
    workers -->|"INSERT / UPDATE embeddings"| pg
    bot -->|"INSERT discord_messages"| pg
    backend -->|"SELECT + vector search"| pg
    backend -->|"GET/SET sessions"| redis
    migrator -->|"DDL migrations"| pg
```

### Las siete entidades de Compose

| Servicio | Tipo | Descripción |
|---|---|---|
| `migrator` | one-shot | Corre `drizzle-kit migrate` y termina. El resto depende de él. |
| `nginx` | long-running | Sirve la SPA y hace proxy de la API. Puerto 80/443. |
| `bot` | long-running | Conecta al Discord Gateway, publica eventos. |
| `backend` | long-running | Express API + LangGraph Agent. |
| `workers` | long-running | Indexer + Sync consumers de Redis Streams. |
| `postgres` | long-running | PostgreSQL 17 + pgvector 0.8.2. |
| `redis` | long-running | Redis 8. Streams de eventos + sesiones. |

---

## 4. Estructura del monorepo

```
hivly/
├── packages/
│   ├── shared/               # @hivly/shared — kernel de dominio
│   │   └── src/
│   │       ├── db/
│   │       │   ├── schema.ts         # Drizzle: fuente de verdad de tablas
│   │       │   ├── index.ts          # Cliente Drizzle exportado
│   │       │   └── migrations/       # SQL generado por drizzle-kit
│   │       ├── schemas/              # Zod schemas de API
│   │       │   ├── errors.ts         # { error: string, code: string }
│   │       │   └── sse.ts            # Wire types del stream SSE
│   │       ├── config/
│   │       │   └── index.ts          # loadConfig() + Zod schema del YAML
│   │       └── types/
│   │           └── events.ts         # Tipos de eventos Redis Streams
│   │
│   ├── bot/                  # @hivly/bot — Discord Bot
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── listeners/            # messageCreate, messageUpdate, messageDelete
│   │   │   ├── backfiller/           # Indexación histórica al arrancar
│   │   │   └── publisher/            # EventPublisher → Redis Streams
│   │   └── Dockerfile
│   │
│   ├── backend/              # @hivly/backend — Express API + Agente
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── routes/               # REST endpoints + /api/chat SSE
│   │   │   ├── agent/                # LangGraph StateGraph
│   │   │   └── middleware/           # Auth, rate-limit, RBAC filter
│   │   └── Dockerfile
│   │
│   ├── workers/              # @hivly/workers — Indexer + Sync
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── indexer/              # Consume created → embed → pgvector
│   │   │   └── sync/                 # Consume updated/deleted → re-index/purge
│   │   └── Dockerfile
│   │
│   └── web/                  # @hivly/web — Vite + React SPA
│       ├── src/
│       │   ├── main.tsx
│       │   ├── views/                # Search, Documents, Chat, ReadStatus
│       │   ├── components/
│       │   └── api/                  # Fetch wrappers tipados con z.infer<>
│       └── Dockerfile                # Multi-stage: build → dist/
│
├── docker-compose.yml
├── Hivly.config.yml          # Configuración de comportamiento
└── .env                      # Secretos (tokens, API keys)
```

### Regla fundamental de imports

```typescript
// ✅ Correcto — desde cualquier servicio
import { discordMessages } from '@hivly/shared/db/schema'
import { SearchResponseSchema } from '@hivly/shared/schemas'
import { loadConfig } from '@hivly/shared/config'

// ❌ Incorrecto — servicios no se importan entre sí
import { something } from '@hivly/backend'  // PROHIBIDO desde bot, workers, web
import { something } from '@hivly/bot'      // PROHIBIDO desde backend, workers, web
```

---

## 5. Servicios

### 5.1 packages/shared — Kernel de dominio

El paquete del que todos dependen y que no depende de nadie. Sus cuatro responsabilidades son estrictamente separadas:

**`src/db/schema.ts`** — Schema Drizzle. Definición de todas las tablas. Ningún servicio define tablas fuera de este fichero.

**`src/schemas/`** — Zod schemas de API. El backend los usa para validar inputs en runtime con `schema.parse()`; el frontend los usa solo para inferencia de tipos con `z.infer<>`. El contrato entre frontend y backend es este directorio.

**`src/config/index.ts`** — `loadConfig()`. Lee `Hivly.config.yml`, valida con un Zod schema y devuelve una configuración tipada. Si el YAML es inválido, lanza un error con un mensaje claro antes de que el servicio haga nada. Todos los servicios llaman a esto al arrancar.

**`src/types/events.ts`** — Tipos de eventos Redis Streams. El Bot los usa al hacer `XADD`; los Workers los usan al leer con `XREADGROUP`.

### 5.2 packages/bot — Discord Bot

**Responsabilidad:** Conectar al Discord Gateway, escuchar mensajes y publicar eventos a Redis Streams. El Bot no indexa, no calcula embeddings y no hace queries vectoriales.

**Flujo de arranque:**

```
1. loadConfig()                    → valida Hivly.config.yml
2. Inicializar cliente discord.js  → conectar al Gateway con permisos mínimos
3. Inicializar node-redis          → conectar a Redis
4. Registrar event listeners       → messageCreate, messageUpdate, messageDelete
5. Ejecutar Backfiller             → fetch mensajes históricos por canal
   └─ Para cada mensaje: XADD hivly:discord:messages
6. Emitir discord.backfill.completed → hivly:knowledge:events
```

**Backfill reconciliado por snowflake:**

El Backfiller almacena el `last_seen_message_id` (Discord snowflake) por canal en `discord_messages`. Al reiniciar, parte desde ese punto, no desde un conteo fijo. Si el bot estuvo offline 3 días, el backfill cubre exactamente ese gap.

**Modos de fallo:**

| Escenario | Comportamiento |
|---|---|
| Desconexión del Gateway | Reintento con exponential backoff (máx. 5 min); backfill desde `last_seen_message_id` al reconectar |
| Rate limit Discord durante backfill | Respeta `Retry-After`; procesa canales de forma secuencial; delay mínimo 1s entre páginas |
| Sin eventos en N minutos | Emite alerta al stream `hivly:knowledge:events` |
| Token del bot expirado | Log crítico + alerta; no intenta auto-renovar |

### 5.3 packages/workers — Indexer + Sync

**Responsabilidad:** Consumir eventos de Redis Streams y mantener el índice vectorial en PostgreSQL. Dos consumers en el mismo proceso, cada uno con su consumer group.

**Indexer** — consume `hivly:discord:messages` (consumer group `hivly:indexer`):

```
1. XREADGROUP GROUP hivly:indexer consumer-1 COUNT 10 STREAMS hivly:discord:messages >
2. Para cada mensaje:
   a. Agrupar con mensajes consecutivos del mismo canal (grouping_window)
   b. Generar chunk_text concatenado
   c. Dividir en fragmentos de chunk_size tokens con chunk_overlap
   d. Para cada fragmento: llamar a text-embedding-3-small → vector de 1536 dims
   e. INSERT INTO embeddings (content, embedding, channel_id, message_ids, ...)
   f. Actualizar discord_messages SET indexed_at = now()
3. XACK hivly:discord:messages hivly:indexer <message-id>
```

**Sync Worker** — consume `hivly:discord:messages:updated` y `hivly:discord:messages:deleted` (consumer group `hivly:sync`):

```
Para messageUpdate:
  1. DELETE FROM embeddings WHERE message_id = :id
  2. Re-indexar el mensaje con el nuevo contenido
  3. XACK

Para messageDelete:
  Si delete_policy = "soft": UPDATE discord_messages SET deleted_at = now()
  Si delete_policy = "hard": DELETE FROM embeddings WHERE message_id = :id
  3. XACK
```

**Regla de ACK:** Los Workers hacen `XACK` **solo** tras procesar con éxito. Si el procesamiento falla, no se hace ACK y Redis reintenta automáticamente con otro consumer del mismo group. El `pending entries list` (PEL) de Redis actúa como DLQ implícita.

### 5.4 packages/backend — API + Agente RAG

**Responsabilidad:** Servir la API REST, gestionar sesiones, ejecutar el agente RAG con streaming SSE y hacer upsert de `channel_permissions` al arrancar.

**Flujo de arranque:**

```
1. loadConfig()
2. Conectar a PostgreSQL (Drizzle) y Redis (node-redis)
3. Upsert channel_permissions desde config.access_control.channel_permissions
4. Inicializar express-session con connect-redis (usando la misma instancia node-redis que se abrió en el paso 2)
5. Registrar middleware: auth, RBAC expansion, rate-limit
6. Registrar routes
7. Escuchar en :3000 (red interna Docker)
```

**Middleware de auth y RBAC** (se ejecuta en cada request a `/api/*` excepto auth y health):

```typescript
// 1. Verificar sesión en Redis
const session = req.session  // express-session + connect-redis
if (!session.userId) return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' })

// 2. Expandir roles → canales permitidos (en cada request, no cacheado en sesión)
const allowedChannelIds = await db
  .select({ channelId: channelPermissions.channelId })
  .from(channelPermissions)
  .where(sql`${channelPermissions.allowedRoles} && ${session.discordRoles}`)

// 3. Inyectar en req para que los handlers lo usen
req.allowedChannelIds = allowedChannelIds.map(r => r.channelId)
```

**Por qué la expansión ocurre en cada request** (y no se cachea en la sesión): el operador puede cambiar los permisos en `Hivly.config.yml` y reiniciar el Backend. Si los `allowedChannelIds` estuvieran en la sesión, un miembro con sesión activa seguiría viendo canales de los que se le revocó acceso hasta que su sesión expire.

### 5.5 packages/web — Web App SPA

**Responsabilidad:** Interfaz de usuario para búsqueda semántica, listado de documentos, chat con el agente y gestión del estado de lectura.

La Web App es una **SPA estática**. No tiene servidor Node. El build de Vite produce `dist/` que nginx sirve directamente. Toda la lógica vive en el browser.

**Cuatro vistas principales:**

| Vista | Descripción |
|---|---|
| **Search** | Búsqueda semántica con filtros por canal y por estado de lectura |
| **Documents** | Listado paginado de fragmentos indexados |
| **Chat** | Conversación streaming con el agente RAG |
| **ReadStatus** | Gestión de lectura: badges, mark-all, conteo en sidebar |

**Contrato con el Backend:** todos los tipos de request y response se infieren de los Zod schemas de `@hivly/shared/schemas`. Si el Backend cambia el shape de un endpoint y actualiza el schema, el compilador TypeScript rompe el frontend antes de que llegue a producción.

```typescript
// packages/web/src/api/search.ts
import type { z } from 'zod'
import { SearchResponseSchema } from '@hivly/shared/schemas'

type SearchResponse = z.infer<typeof SearchResponseSchema>

export async function search(query: string, channelIds?: string[]): Promise<SearchResponse> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
  return SearchResponseSchema.parse(await res.json())
}
```

### 5.6 nginx — Punto de entrada HTTP

nginx cumple tres roles: servidor de estáticos, reverse proxy y terminador TLS. Es el único servicio con un puerto expuesto al host.

**Configuración esencial:**

```nginx
# Estáticos de la SPA
location / {
    root /usr/share/nginx/html;
    try_files $uri $uri/ /index.html;  # SPA: todas las rutas sin /api → index.html
}

# Proxy a la API
location /api/ {
    proxy_pass http://backend:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# SSE — CRÍTICO: deshabilitar buffering para que los tokens lleguen en tiempo real
location /api/chat {
    proxy_pass http://backend:3000;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

**Sin `proxy_buffering off` en `/api/chat`,** nginx acumula todos los tokens del stream SSE y los envía al cliente de golpe cuando el LLM termina. El usuario ve la pantalla en blanco durante 10-30 segundos y luego toda la respuesta aparece de una vez — exactamente lo contrario del efecto deseado.

---

## 6. Modelo de datos

Todas las tablas se definen en `packages/shared/src/db/schema.ts`. Nadie más hace DDL.

```mermaid
erDiagram
    discord_messages {
        string id PK "Discord snowflake"
        string channel_id
        string guild_id
        string author_id
        text content
        timestamp created_at
        timestamp updated_at
        timestamp indexed_at
        timestamp deleted_at "NULL si no borrado"
    }

    embeddings {
        uuid id PK
        text content "Fragmento de texto"
        vector embedding "1536 dims"
        string channel_id
        string[] message_ids
        timestamp created_at
    }

    users {
        uuid id PK
        string discord_id UK
        string username
        string avatar
        timestamp created_at
    }

    user_roles_cache {
        uuid user_id FK
        string[] discord_roles
        timestamp cached_at
        timestamp expires_at
    }

    channel_permissions {
        string channel_id PK
        string name
        string[] allowed_roles
        string category_id "NULL si es canal directo"
    }

    conversations {
        uuid id PK
        uuid user_id FK
        timestamp created_at
        timestamp updated_at
    }

    messages {
        uuid id PK
        uuid conversation_id FK
        string role "user | assistant | system"
        text content
        jsonb citations "Array de fuentes"
        timestamp created_at
    }

    user_read_status {
        uuid user_id FK
        uuid embedding_id FK
        timestamp read_at
    }

    users ||--o{ conversations : "tiene"
    conversations ||--o{ messages : "contiene"
    users ||--o{ user_read_status : "tiene"
    embeddings ||--o{ user_read_status : "referenciada por"
    users ||--o| user_roles_cache : "tiene"
```

**Índices críticos:**

```sql
-- Búsqueda vectorial
CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (embedding vector_cosine_ops);

-- Filtro RBAC en búsqueda vectorial
CREATE INDEX idx_embeddings_channel ON embeddings(channel_id);

-- Búsqueda por canal/fecha en messages de Discord
CREATE INDEX idx_discord_messages_channel ON discord_messages(channel_id, created_at DESC);

-- Read tracking
CREATE INDEX idx_user_read_status_user ON user_read_status(user_id);
CREATE INDEX idx_user_read_status_embedding ON user_read_status(embedding_id);
```

**Nota:** La tabla `sessions` que aparece en el PRD **no existe** en el schema Drizzle. Las sesiones viven en Redis (AD-10). La tabla `user_roles_cache` existe para consultas de RBAC que no necesiten ir a la Discord API, con TTL configurable.

---

## 7. Pipeline de ingestión

El flujo completo desde que un mensaje aparece en Discord hasta que es buscable:

```mermaid
sequenceDiagram
    participant D as Discord Gateway
    participant Bot
    participant RS as Redis Streams
    participant Idx as Workers/Indexer
    participant OAI as OpenAI Embeddings API
    participant PG as PostgreSQL+pgvector

    D->>Bot: messageCreate event
    Bot->>Bot: ¿Canal habilitado? ¿No es bot?
    Bot->>PG: INSERT discord_messages
    Bot->>RS: XADD hivly:discord:messages {messageId, channelId, content, ...}

    RS->>Idx: XREADGROUP hivly:indexer (at-least-once)
    Idx->>Idx: Agrupar mensajes consecutivos (grouping_window)
    Idx->>Idx: Dividir en fragmentos (chunk_size, chunk_overlap)
    Idx->>OAI: POST /embeddings (text-embedding-3-small)
    OAI-->>Idx: vector[1536]
    Idx->>PG: INSERT embeddings (content, embedding, channel_id, message_ids)
    Idx->>PG: UPDATE discord_messages SET indexed_at = now()
    Idx->>RS: XACK hivly:discord:messages hivly:indexer <id>
```

**Chunking:** Los mensajes de Discord son cortos, pero varios mensajes consecutivos del mismo canal se agrupan antes de hacer chunk. Esto mejora la coherencia semántica de los fragmentos: una conversación de 5 mensajes sobre un mismo tema queda en el mismo embedding, no fragmentada en 5 vectores independientes.

**Backfill al arrancar:**

```mermaid
flowchart TD
    A[Bot arranca] --> B{¿last_seen_message_id\nen discord_messages?}
    B -->|Sí| C[Fetch mensajes desde snowflake\nhasta ahora]
    B -->|No| D[Fetch hasta backfill_limit\ndesde el canal]
    C --> E[XADD cada mensaje\n→ hivly:discord:messages]
    D --> E
    E --> F[Actualizar last_seen_message_id\npor canal]
    F --> G[XADD discord.backfill.completed\n→ hivly:knowledge:events]
```

---

## 8. Sistema de eventos: Redis Streams

### Streams, producers y consumers

| Stream key | Producer | Consumer group | Consumer | Propósito |
|---|---|---|---|---|
| `hivly:discord:messages` | bot | `hivly:indexer` | workers/indexer | Indexar mensajes nuevos |
| `hivly:discord:messages:updated` | bot | `hivly:sync` | workers/sync | Re-indexar mensajes editados |
| `hivly:discord:messages:deleted` | bot | `hivly:sync` | workers/sync | Purgar mensajes borrados |
| `hivly:knowledge:events` *(planned — Epic 6)* | workers/bot | `hivly:notifier` | notifier *(deferred)* | Notificaciones al operador |

### Schema mínimo de cada mensaje de stream

Todos los mensajes deben incluir estos campos (definidos en `packages/shared/src/types/events.ts`):

```typescript
interface StreamEvent {
  messageId: string      // Discord snowflake
  channelId: string
  guildId: string
  timestamp: string      // ISO 8601 UTC
}

interface MessageCreatedEvent extends StreamEvent {
  type: 'discord.message.created'
  content: string
  authorId: string
}

interface MessageUpdatedEvent extends StreamEvent {
  type: 'discord.message.updated'
  newContent: string
}

interface MessageDeletedEvent extends StreamEvent {
  type: 'discord.message.deleted'
}
```

### Semántica at-least-once y ACK discipline

Los Workers leen con `XREADGROUP` en modo **at-least-once**: si un mensaje se lee pero no se hace ACK antes de un timeout, Redis lo reasigna a otro consumer del mismo group. El Worker solo hace `XACK` después de completar el procesamiento con éxito.

```
XREADGROUP GROUP hivly:indexer consumer-1 COUNT 10 BLOCK 5000 STREAMS hivly:discord:messages >

// Procesar...
if (éxito) {
  XACK hivly:discord:messages hivly:indexer <message-id>
}
// Si falla: no ACK → Redis reintenta automáticamente
```

**Consecuencia:** el procesamiento de un mensaje puede ocurrir más de una vez. Los Workers deben ser **idempotentes**: hacer un INSERT sobre un `embedding.id` que ya existe debe resultar en un UPSERT, no en un error.

---

## 9. Agente RAG: LangGraph StateGraph

El agente RAG es el corazón del sistema. Se implementa como un `StateGraph` de LangGraph 1.4 con cuatro nodos explícitos.

### Estructura del grafo

```mermaid
flowchart TD
    START([START]) --> retrieve
    retrieve --> reason
    reason --> respond
    reason -->|"si tool_call"| tool_exec
    tool_exec --> reason
    respond --> END([END])

    retrieve["retrieve\nBusca fragmentos relevantes\nen pgvector con filtro RBAC"]
    reason["reason\nLLM genera respuesta\no tool_call"]
    tool_exec["tool_exec\nEjecuta la tool\ny devuelve resultado"]
    respond["respond\nStreaming SSE al cliente\ncon citas incluidas"]
```

### Estado del grafo

```typescript
interface AgentState {
  messages: BaseMessage[]        // Historial de conversación (comprimido si supera tokens)
  allowedChannelIds: string[]    // Filtro RBAC inyectado por el middleware
  retrievedFragments: Fragment[] // Resultados del paso retrieve
  conversationId: string
}
```

### Nodo `retrieve`

```typescript
async function retrieve(state: AgentState): Promise<Partial<AgentState>> {
  const query = getLastUserMessage(state.messages)
  
  // Búsqueda vectorial con filtro RBAC obligatorio
  const fragments = await db
    .select()
    .from(embeddings)
    .where(inArray(embeddings.channelId, state.allowedChannelIds))
    .orderBy(sql`embedding <=> ${queryVector}`)
    .limit(config.knowledge.topK ?? 5)
  
  return { retrievedFragments: fragments }
}
```

El filtro RBAC (`inArray(embeddings.channelId, allowedChannelIds)`) es parte del query vectorial, no un post-filter. Se aplica antes de calcular similitud coseno.

### Gestión del historial (compresión)

Cuando el historial supera el presupuesto de tokens configurado (`agent.memory_window`), el nodo `reason` comprime los mensajes más antiguos en un resumen antes de llamar al LLM:

```typescript
async function reason(state: AgentState): Promise<Partial<AgentState>> {
  const { messages, compressed } = await compressIfNeeded(
    state.messages,
    { maxTokens: config.agent.memoryBudget ?? 4000 }
  )
  
  const response = await llm.invoke([
    systemPrompt,
    ...compressed,
    buildRAGContext(state.retrievedFragments),
    ...messages
  ])
  
  // Si es un tool_call, redirigir al nodo tool_exec
  if (response.tool_calls?.length) {
    return { messages: [...state.messages, response] }
  }
  
  return { messages: [...state.messages, response] }
}
```

### Streaming SSE

El nodo `respond` hace streaming token a token al cliente vía SSE. El wire format es:

```
data: {"type":"token","content":"La"}
data: {"type":"token","content":" respuesta"}
data: {"type":"citation","channel":"#general","author":"usuario","date":"2026-01-15"}
data: {"type":"done","conversationId":"uuid-..."}
```

El schema de cada frame está definido en `packages/shared/src/schemas/sse.ts`.

---

## 10. Autenticación y RBAC

### Flujo OAuth2 de Discord

```mermaid
sequenceDiagram
    participant U as Browser
    participant B as Backend
    participant D as Discord API

    U->>B: GET /api/auth/login
    B-->>U: Redirect → discord.com/oauth2/authorize
    U->>D: Autorizar (scopes: identify, guilds.members.read)
    D-->>U: Redirect → /api/auth/callback?code=...
    U->>B: GET /api/auth/callback?code=...
    B->>D: POST /oauth2/token (exchange code)
    D-->>B: access_token
    B->>D: GET /users/@me
    D-->>B: { id, username, avatar }
    B->>D: GET /users/@me/guilds/{guild_id}/member
    D-->>B: { roles: ["role-id-1", "role-id-2"] }
    B->>B: Verificar que es miembro del guild
    B->>Redis: SET session:uuid { userId, discordRoles }
    B-->>U: Set-Cookie: sid=uuid; HttpOnly; Secure
    U->>B: Redirect → /
```

### Sesiones en Redis

La sesión almacena solo lo imprescindible:

```typescript
interface Session {
  userId: string          // UUID del usuario en la tabla users
  discordRoles: string[]  // Role IDs del usuario en el guild
}
```

Los `allowedChannelIds` **no** se almacenan en sesión — se calculan en cada request uniendo `discordRoles` contra `channel_permissions`. Esto garantiza que un cambio de permisos en config tiene efecto inmediato en el siguiente request del usuario.

### RBAC: de roles a canales

```mermaid
flowchart LR
    Session["session.discordRoles\n['admin', 'mod']"] -->|JOIN| CP["channel_permissions\n(materializada de config)"]
    CP -->|"WHERE allowed_roles && discordRoles"| ACI["allowedChannelIds\n['ch-1', 'ch-2', 'ch-5']"]
    ACI -->|"WHERE channel_id = ANY(:)"| Query["pgvector query\n(filtrada)"]
```

El operador define la política en `Hivly.config.yml`:

```yaml
access_control:
  default_policy: "deny"   # Sin regla explícita = sin acceso
  channel_permissions:
    - channel_id: "123"
      name: "staff-privado"
      allowed_roles: ["admin", "mod"]
    - channel_id: "456"
      name: "general"
      allowed_roles: ["admin", "mod", "member"]
```

Al arrancar el Backend, `channel_permissions` se carga via upsert desde el YAML. No hay panel de administración — todo es código.

---

## 11. API REST

Todos los endpoints bajo `/api/*` requieren sesión válida excepto `/api/auth/*` y `/health`.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Health check del sistema |
| `GET` | `/api/auth/login` | Inicia flujo OAuth2 Discord |
| `GET` | `/api/auth/callback` | Callback OAuth2 |
| `POST` | `/api/auth/logout` | Cierra sesión (borra key Redis) |
| `GET` | `/api/auth/me` | Usuario autenticado actual |
| `GET` | `/api/auth/roles` | Roles del usuario + canales accesibles |
| `GET` | `/api/search?q=...` | Búsqueda semántica con filtro RBAC |
| `GET` | `/api/documents` | Listado paginado de fragmentos |
| `POST` | `/api/chat` | Chat con el agente (respuesta SSE) |
| `GET` | `/api/conversations` | Lista conversaciones del usuario |
| `GET` | `/api/conversations/:id` | Conversación con mensajes |
| `POST` | `/api/read-status/:embeddingId` | Marcar fragmento como leído |
| `DELETE` | `/api/read-status/:embeddingId` | Marcar fragmento como no leído |
| `POST` | `/api/read-status/mark-all` | Marcar canal como leído (batch 1000) |
| `GET` | `/api/read-status/unread-count` | Conteo de no leídos por canal |

**Shapes de request/response:** definidos en `packages/shared/src/schemas/`. El Backend los valida con `schema.parse()`; el Frontend los usa con `z.infer<>`.

**Error shape unificado:**

```typescript
// packages/shared/src/schemas/errors.ts
export const ErrorSchema = z.object({
  error: z.string(),
  code: z.string()
})
// Ejemplo: { error: "No autorizado", code: "AUTH_REQUIRED" }
```

---

## 12. Streaming SSE del chat

El endpoint `POST /api/chat` usa Server-Sent Events. El cliente usa `fetch` (no `EventSource`, porque necesita enviar un body en el POST).

### Cliente (packages/web)

```typescript
async function* streamChat(message: string, conversationId?: string) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId })
  })
  
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  
  for await (const chunk of readLines(reader, decoder)) {
    if (chunk.startsWith('data: ')) {
      yield JSON.parse(chunk.slice(6)) as SSEFrame
    }
  }
}
```

### Wire format (packages/shared/src/schemas/sse.ts)

```typescript
export type SSEFrame =
  | { type: 'token';    content: string }
  | { type: 'citation'; channel: string; author: string; date: string }
  | { type: 'done';     conversationId: string }
  | { type: 'error';    code: string; message: string }
```

### Configuración nginx requerida

```nginx
location /api/chat {
    proxy_pass http://backend:3000;
    proxy_buffering off;      # ← OBLIGATORIO para SSE
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

---

## 13. Configuración

El sistema usa dos ficheros:

- **`Hivly.config.yml`** — comportamiento del sistema (canales, modelos, RBAC, etc.)
- **`.env`** — secretos (tokens de Discord, API keys del LLM, URLs de DB)

La función `loadConfig()` de `packages/shared` lee y valida el YAML. Si una clave requerida falta o tiene tipo incorrecto, el servicio termina con un error descriptivo antes de hacer cualquier conexión de red.

### Ejemplo de Hivly.config.yml

```yaml
version: "1.0"

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

agent:
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  temperature: 0.7
  max_iterations: 10
  memory_window: 20

knowledge:
  chunk_size: 500
  chunk_overlap: 50
  grouping_window: 10
  embedding_model: "text-embedding-3-small"

sync:
  enabled: true
  sync_on_start: true
  delete_policy: "soft"

access_control:
  enabled: true
  default_policy: "deny"
  role_cache_ttl: 300
  channel_permissions:
    - channel_id: "1234567890"
      name: "general"
      allowed_roles: ["admin", "mod", "member"]

read_tracking:
  enabled: true
  auto_mark_read_on_click: true

observability:
  sentry_dsn: "${SENTRY_DSN}"
  log_level: "info"

security:
  rate_limit:
    window_ms: 60000
    max_requests: 20
  allowed_origins:
    - "${FRONTEND_URL}"
```

---

## 14. Despliegue

### Primer despliegue

```bash
git clone https://github.com/Hivly/hivly.git
cp Hivly.config.yml.example Hivly.config.yml
cp .env.example .env
# Editar ambos ficheros con los valores reales
docker compose up -d
```

### docker-compose.yml (estructura)

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17   # pgvector 0.8.2 sobre PostgreSQL 17
    environment:
      POSTGRES_DB: hivly
      # ...
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:8-alpine
    command: redis-server --appendonly yes

  migrator:
    build: ./packages/shared        # Usa drizzle-kit
    command: npx drizzle-kit migrate
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"                   # No reiniciar — es one-shot

  bot:
    build: ./packages/bot
    depends_on:
      migrator: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    volumes:
      - ./Hivly.config.yml:/app/Hivly.config.yml:ro
      - ./.env:/app/.env:ro

  workers:
    build: ./packages/workers
    depends_on:
      migrator: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    volumes:
      - ./Hivly.config.yml:/app/Hivly.config.yml:ro
      - ./.env:/app/.env:ro

  backend:
    build: ./packages/backend
    depends_on:
      migrator: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    volumes:
      - ./Hivly.config.yml:/app/Hivly.config.yml:ro
      - ./.env:/app/.env:ro

  nginx:
    image: nginx:1.27-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - webdist:/usr/share/nginx/html:ro
    depends_on:
      - backend

volumes:
  pgdata:
  webdist:
```

**Dependencias de arranque:**

```
postgres ──┐
           ├──→ migrator ──┬──→ bot
           │               ├──→ workers
redis ─────┘               └──→ backend ──→ nginx
```

### Actualización

```bash
git pull
docker compose build
docker compose up -d
# migrator corre automáticamente y aplica las nuevas migraciones
```

---

## 15. Stack tecnológico

| Componente | Tecnología | Versión | Notas |
|---|---|---|---|
| Runtime | Node.js | 24 LTS | Active LTS hasta 2028 |
| Lenguaje | TypeScript | 6.0 | 7.0-RC disponible; usar 6.0 en prod |
| Frontend | React + Vite | 19.2 + 8.1 | SPA estática, sin SSR |
| API | Express | 5.2 | Express 5 es el release recomendado por TC |
| Agente RAG | LangGraph + LangChain core | 1.4 + 1.2 | StateGraph API (no legacy chains) |
| ORM | drizzle-orm + drizzle-kit | 0.45 + 0.31 | Schema en TypeScript nativo |
| Discord client | discord.js | 14.26 | Gateway + REST Discord API |
| Validación | zod | 4.4 | Zod v4 (API diferente a v3 en algunos puntos) |
| Sesiones | express-session + connect-redis | 1.x + 9.0 | Sesiones en Redis, no en PostgreSQL |
| Redis client | node-redis (`redis`) | 6.x | Streams + sesiones |
| DB | PostgreSQL + pgvector | 17 + 0.8.2 | pgvector 0.8.2 corrige CVE-2026-3172 |
| Cache/Streams | Redis | 8 | |
| Reverse proxy | nginx | 1.27 mainline | |
| Contenedores | Docker Compose | 2 | |
| Embeddings | text-embedding-3-small | — | API OpenAI, 1536 dims |

---

## 16. Decisiones de arquitectura

Esta sección explica el **por qué** de las decisiones clave. El qué está en el spine.

### AD-1 — Tres procesos separados (actualmente; futuro notifier planeado)

El Bot hace backfill de miles de mensajes al arrancar. Si viviera en el mismo proceso que el Backend, ese backfill bloquearía el event loop y degradaría la API durante el arranque. Separar los procesos significa que el Bot puede estar procesando 10.000 mensajes históricos mientras el agente responde preguntas sin ningún impacto.

### AD-3 — Vite SPA, no Next.js

Next.js requiere un servidor Node siempre activo. Para una herramienta self-hosted, añadir un cuarto proceso de aplicación a Compose complica la instalación sin beneficio real — el SEO no importa porque la app requiere login. Vite produce estáticos que nginx sirve directamente.

### AD-4 — SSE, no WebSocket

El chat de Hivly es unidireccional durante el stream: el servidor envía tokens, el cliente no envía nada. SSE es exactamente eso. WebSocket sería bidireccional (ninguna ventaja aquí) y requiere manejo especial de auth en el handshake — las cookies httpOnly no viajan igual. SSE funciona sobre HTTP normal, la cookie de sesión funciona sin configuración extra.

### AD-10 — Sesiones en Redis, no en PostgreSQL

El PRD tenía una tabla `sessions` en PostgreSQL. La eliminamos. Redis es más rápido para lecturas de clave-valor, ya está en el stack para los Streams, y la revocación es inmediata (borrar la key). El único argumento para PostgreSQL sería la durabilidad — pero las sesiones con TTL corto no necesitan durabilidad.

### AD-11 — LangGraph, no LangChain legacy

El PRD mencionaba `ConversationSummaryBufferMemory`, una API de LangChain v0.2 que está en deprecación activa. LangGraph 1.4 modela el agente como un grafo explícito — el historial de conversación es parte visible del estado, no un objeto opaco. Esto hace que el testing sea más sencillo y que el comportamiento sea predecible.

### AD-12 — RBAC en el query vectorial, no en middleware

Un middleware de auth podría verificar que el usuario tiene acceso al sistema, pero no puede filtrar los resultados del vector search. Si el filtro RBAC no se aplica en la query pgvector, el agente RAG podría incluir en su contexto fragmentos de canales privados. El filtro debe estar en el SQL, no en una capa posterior.

### AD-13 — Stream keys y consumer groups fijados en el spine

En los primeros sprints, un builder del Bot y un builder de los Workers pueden trabajar en paralelo. Si los stream keys no están fijados como invariante, pueden elegir nombres incompatibles y el pipeline de ingestión produce cero embeddings sin ningún error visible. Es el bug más difícil de debuggar en un sistema event-driven.

---

## 17. Pendiente (Deferred)

Estas decisiones están conscientemente pospuestas. No son olvidos — son áreas donde los builders tienen libertad de elegir sin que sus elecciones rompan la integración con otros servicios.

| Área | Qué está pendiente | Restricción |
|---|---|---|
| **Notificador (Telegram/Slack)** | ¿Vive en `workers` o en `backend`? | Debe consumir `hivly:knowledge:events` |
| **Retry y DLQ (Redis Streams)** | Max reintentos, MAXLEN, dead-letter | AD-13 fija ACK discipline; el resto es libre |
| **CSS / UI framework** | Tailwind + shadcn/ui vs CSS Modules | Sin restricción |
| **Frontend data fetching** | TanStack Query vs SWR | Debe respetar AD-6 (tipos de Zod) |
| **Test framework** | Vitest + Playwright (asumido) | Sin restricción |
| **TLS en nginx** | Let's Encrypt vs cert manual | AD-7 establece que nginx termina TLS |
| **Health checks Compose** | Scripts de probe por servicio | Sin restricción |
| **Abstracción proveedor LLM** | Interfaz propia en shared (si necesaria) | LangChain.js ya abstrae Anthropic y OpenAI |
| **Batching del Indexer** | Lógica exacta de grouping_window | El config fija los parámetros |
| **Observabilidad** | Qué errores y traces van a Sentry | `SENTRY_DSN` en config |
| **Topología dev local** | Vite proxy, CORS config en Backend | No afecta producción (AD-7) |
| **nginx image tag** | `nginx:1.27-alpine` o versión exacta | No usar `nginx:latest` |
