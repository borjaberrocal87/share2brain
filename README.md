# Share2Brain

Agente de IA self-hosted que cura un índice de recursos (enlaces) de una comunidad de
Discord y responde preguntas en lenguaje natural citando fuentes verificables.

Cada operador despliega una instancia independiente que sirve a **un guild** de Discord.
La configuración se realiza mediante `Share2Brain.config.yml` + `.env`, y el sistema se levanta
con un solo comando: `docker compose up -d`.

## Características

- **Indexación automática** — Un bot de Discord lee los canales configurados e indexa los
  mensajes que contienen URLs, enriqueciendo cada enlace con título y descripción generados
  por IA.
- **Búsqueda semántica** — Resultados por similitud de embeddings (pgvector), no solo keyword.
- **Chat con agente RAG** — Respuestas en streaming (SSE) con fuentes citadas (canal, autor,
  fecha, enlace). Si no encuentra información, lo indica sin inventar.
- **RBAC por canal** — El control de acceso basado en roles de Discord se aplica **dentro** de
  la query vectorial, no como post-filtro.
- **Read Tracking** — Cada miembro tiene su propio estado de lectura por fragmento.
- **Self-hosted** — Los datos en reposo nunca salen del servidor del operador. El procesamiento
  se delega a los proveedores configurados (LLM y embeddings).
- **Despliegue trivial** — Un comando levanta los 7 servicios de Docker Compose.

## Arquitectura

Monorepo npm workspaces con kernel compartido (hexagonal) + ingestión event-driven sobre
Redis Streams.

```
Discord ──▶ Bot ──▶ Redis Streams ──▶ Workers ──▶ PostgreSQL + pgvector
                                                          ▲
                       Web App (SPA) ──▶ Backend (API + RAG Agent)
```

| Paquete | Rol |
|---|---|
| `packages/shared` | Kernel de dominio: schema Drizzle, Zod schemas, `loadConfig()` |
| `packages/bot` | Discord Bot — ingesta de mensajes (backfill + tiempo real + sync) |
| `packages/backend` | Express API + agente RAG (LangGraph) con streaming SSE |
| `packages/workers` | Indexer + Sync consumers (Redis Streams → pgvector) |
| `packages/web` | SPA React + Vite (búsqueda, chat, documentos, estadísticas) |

**Invariante clave:** los servicios dependen de `@share2brain/shared` pero **nunca entre sí**.
La ingesta es event-driven: el Bot publica eventos a Redis Streams; los Workers los consumen
con ACK explícito (at-least-once). El Backend solo lee resultados del pipeline.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | TypeScript, Node.js 24, Express 5 |
| IA | LangGraph 1.4 (agente RAG), Zod 4 |
| Discord | discord.js 14 |
| Base de datos | PostgreSQL 17 + pgvector 0.8 |
| Cola de eventos | Redis 8 (Streams) |
| ORM / Migraciones | Drizzle ORM 0.45 + drizzle-kit |
| Web | React 19, Vite 8 |
| Edge | nginx 1.27 (único puerto expuesto) |
| Empaquetado | Docker Compose v2 (7 servicios) |
| Testing | Vitest (unit/integration) + Playwright (e2e) |

## Primeros pasos

### Prerrequisitos

- **Node.js** 24 LTS
- **npm** 10+ (soporte workspaces)
- **Docker** y **Docker Compose** v2
- **Git**

### 1. Clonar e instalar

```bash
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain
npm install
```

### 2. Configuración

El sistema usa **dos** ficheros de configuración (nunca mezclarlos):

- `Share2Brain.config.yml` — comportamiento (canales, modelos, RBAC, rate limits)
- `.env` — secretos (tokens, API keys, URLs de DB/Redis)

```bash
cp Share2Brain.config.yml.example Share2Brain.config.yml
cp .env.example .env
# editar ambos con valores reales
```

Necesitarás:

- Un **bot de Discord** con permisos de lectura (token, client ID, client secret)
- El **guild ID** de tu servidor de Discord
- Una **API key de LLM** (Anthropic, OpenAI o endpoint custom)
- Una **API key de embeddings** (OpenAI o endpoint custom — Anthropic no ofrece embeddings)

### 3. Levantar el stack completo (Docker Compose)

```bash
docker compose up -d          # arranca los 7 servicios
docker compose ps             # verificar estado
docker compose logs -f backend
```

Los 7 servicios: `postgres` (pgvector), `redis`, `migrator` (one-shot), `bot`, `workers`,
`backend`, `nginx` (único puerto expuesto: 80/443).

### 4. Desarrollo local (servicios fuera de Docker)

```bash
docker compose up -d postgres redis   # solo infra
npx drizzle-kit migrate               # aplicar migraciones

npm run dev -w @share2brain/backend        # API + agente RAG en :3000
npm run dev -w @share2brain/web            # Vite dev server (SPA) en :5173
npm run dev -w @share2brain/bot            # Discord Bot (ingesta)
npm run dev -w @share2brain/workers        # Indexer + Sync consumers
```

En dev, Vite (`:5173`) hace proxy de `/api/*` al Backend (`:3000`).

## Comandos

```bash
npm run lint                         # ESLint en todos los paquetes
npm run test                         # Vitest (unit/integration)
npm run test:integration             # integration (necesita Postgres + Redis)
npm run test:e2e                     # Playwright (web)
npm run typecheck                    # TypeScript en todos los workspaces
npm run build                        # build de todos los paquetes

npx drizzle-kit generate             # generar migración SQL desde schema.ts
npx drizzle-kit migrate              # aplicar migraciones
```

> **Aviso:** no ejecutes `npm run test:integration` contra una DB que un stack de app
> en vivo también esté usando. Detén los contenedores de app primero:
> `docker compose stop bot backend workers` (deja postgres + redis).

## Actualizar un despliegue

```bash
git pull
docker compose build
docker compose up -d
# el servicio migrator aplica las migraciones nuevas automáticamente
```

## Documentación

La documentación autoritativa vive en `docs/`:

| Fichero | Contenido |
|---|---|
| `docs/context/PRD.md` | Qué se construye y por qué |
| `docs/context/ARCHITECTURE-SPINE.md` | Invariantes de arquitectura (AD-1…AD-13) |
| `docs/context/TECHNICAL-DESIGN.md` | Diseño concreto (servicios, datos, pipeline, RAG, auth, API) |
| `docs/data-model.md` | Modelo de datos e índices |
| `docs/api-spec.yml` | Endpoints REST + SSE |
| `docs/development_guide.md` | Setup, ejecución y testing |
| `docs/base-standards.md` | Estándares y reglas de trabajo |

## Licencia

Propietario — © Borja Berrocal
