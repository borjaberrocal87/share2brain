---
description: Backend development standards, best practices, and conventions for the Hivly Node.js/TypeScript monorepo — hexagonal shared-kernel architecture, DDD principles, SOLID+DRY design, Drizzle/pgvector, Express 5 API, LangGraph RAG agent, Redis Streams ingestion, testing standards (Vitest), and security.
globs: ["packages/*/src/**/*.ts", "packages/shared/src/db/**/*.ts", "packages/*/vitest.config.ts", "packages/*/tsconfig.json", "packages/*/package.json", "packages/*/src/**/*.test.ts", "drizzle.config.ts", "docker-compose.yml"]
alwaysApply: true
---

# Backend Project Standards and Best Practices

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Architecture Overview](#architecture-overview)
  - [Hexagonal (Shared Kernel)](#hexagonal-shared-kernel)
  - [Domain-Driven Design (DDD)](#domain-driven-design-ddd)
  - [Layered Architecture](#layered-architecture)
  - [Project Structure](#project-structure)
  - [Event-Driven Ingest](#event-driven-ingest)
  - [Monorepo Structure](#monorepo-structure)
- [Architecture Principles](#architecture-principles)
- [Domain-Driven Design Principles](#domain-driven-design-principles)
  - [Entities](#entities)
  - [Value Objects](#value-objects)
  - [Aggregates](#aggregates)
  - [Repositories](#repositories)
  - [Domain Services](#domain-services)
  - [Additional Recommendations](#additional-recommendations)
- [SOLID and DRY Principles](#solid-and-dry-principles)
  - [Single Responsibility Principle (SRP)](#single-responsibility-principle-srp)
  - [Open/Closed Principle (OCP)](#openclosed-principle-ocp)
  - [Liskov Substitution Principle (LSP)](#liskov-substitution-principle-lsp)
  - [Interface Segregation Principle (ISP)](#interface-segregation-principle-isp)
  - [Dependency Inversion Principle (DIP)](#dependency-inversion-principle-dip)
  - [DRY (Don't Repeat Yourself)](#dry-dont-repeat-yourself)
- [Coding Standards](#coding-standards)
- [API Design Standards](#api-design-standards)
- [Database Patterns](#database-patterns-drizzle--pgvector)
- [Redis Streams Patterns](#redis-streams-patterns)
- [RAG Agent (LangGraph)](#rag-agent-langgraph)
- [Authentication & RBAC](#authentication--rbac)
- [Testing Standards](#testing-standards)
- [Performance Best Practices](#performance-best-practices)
- [Security Best Practices](#security-best-practices)
- [Development Workflow](#development-workflow)
- [Deployment (Docker Compose)](#deployment-docker-compose)

---

## Overview

This document outlines the conventions and standards for the Hivly backend-side services. "Backend" here spans three runtime processes plus two library packages:

- `@hivly/shared` — domain kernel (Drizzle schema, Zod API schemas, `loadConfig()`, shared types).
- `@hivly/web` — Vite + React SPA (built static, served by nginx; see `docs/frontend-standards.md`).
- `@hivly/bot` — Discord Bot, ingestion producer.
- `@hivly/backend` — Express API + LangGraph RAG agent.
- `@hivly/workers` — Indexer + Sync consumers.

The system follows **Hexagonal (Shared Kernel) + Event-Driven Ingest**. All invariants are in `docs/context/ARCHITECTURE-SPINE.md` (`AD-1 … AD-13`); the full technical design is in `docs/context/TECHNICAL-DESIGN.md`. When a rule below cites an `AD-*`, that AD is the authority.

## Technology Stack

| Concern | Technology | Version |
|---|---|---|
| Runtime | Node.js | 24 LTS |
| Language | TypeScript (strict) | 6.0 |
| API framework | Express | 5.2 |
| RAG agent | @langchain/langgraph + @langchain/core | 1.4 + 1.2 |
| ORM | drizzle-orm + drizzle-kit | 0.45 + 0.31 |
| Database | PostgreSQL + pgvector | 17 + 0.8.2 |
| Discord client | discord.js | 14.26 |
| Validation | zod | 4.4 |
| Sessions | express-session + connect-redis | 1.x + 9.0 |
| Redis client | node-redis (`redis`) (streams + sessions) | 6.x |
| Cache/Streams | Redis | 8 |
| Reverse proxy | nginx | 1.27 |
| Containers | Docker Compose | 2 |
| Testing | Vitest | latest |
| Embeddings | configurable via `embeddings.*` (provider/model; default text-embedding-3-small) | dimension declared in `embeddings.dimensions` |

There is **no serverless/AWS Lambda** deployment. The unit of deployment is Docker Compose.

## Architecture Overview

### Hexagonal (Shared Kernel)

`packages/shared` is the domain kernel every service depends on and that depends on no service. Services are adapters that **never import each other** (AD-2).

```
packages/shared   ←── every service depends on this
packages/bot      ──┐
packages/backend  ──┼── never import each other
packages/workers  ──┘
```

```typescript
// ✅ Correct — from any service
import { discordMessages } from '@hivly/shared/db/schema'
import { SearchResponseSchema } from '@hivly/shared/schemas'
import { loadConfig } from '@hivly/shared/config'

// ❌ Forbidden — services must not import each other
import { something } from '@hivly/backend'   // from bot/workers/web
import { something } from '@hivly/bot'        // from backend/workers/web
```

### Domain-Driven Design (DDD)

Domain-Driven Design is a methodology that focuses on modeling software according to business logic and domain knowledge. By centering development on a deep understanding of the domain, DDD facilitates the creation of complex systems.

**Benefits:**
- **Improved Communication**: Promotes a common language between developers and domain experts, improving communication and reducing interpretation errors.
- **Clear Domain Models**: Helps build models that accurately reflect business rules and processes.
- **High Maintainability**: By dividing the system into subdomains, it facilitates maintenance and software evolution.

### Layered Architecture

The backend follows a layered DDD architecture:

**Presentation Layer**
- Controllers handle HTTP requests/responses and SSE streams.
- Routes define API endpoints (live in `src/routes/`).
- Controllers use services from Application layer.

**Application Layer**
- Services contain business logic and orchestration.
- Validator handles input validation (Zod schemas in shared).
- Services use repositories from Domain layer.

**Domain Layer**
- Models define core business entities (DiscordMessage, Conversation, Embedding, etc.).
- Repository interfaces define data access contracts.
- Pure business logic without external dependencies.

**Infrastructure Layer** (implicit)
- Drizzle ORM handles database operations.
- Repository implementations (via Drizzle) satisfy domain interfaces.

### Project Structure

Within each service package, follow this DDD-aligned directory layout:

```
packages/<service>/
├── src/
│   ├── domain/
│   │   ├── models/          # Domain entities and value objects
│   │   └── repositories/    # Repository interfaces
│   ├── application/
│   │   ├── services/        # Business logic services
│   │   └── validator.ts     # Zod validation (or delegate to shared)
│   ├── presentation/
│   │   └── controllers/     # HTTP request handlers / SSE streams
│   ├── infrastructure/
│   │   ├── logger.ts        # Logging utilities
│   │   └── db.ts            # Drizzle client setup
│   ├── routes/              # Express route definitions
│   ├── middleware/          # Express middleware
│   └── main.ts              # Application entry point
├── test-utils/
│   ├── builders/            # Test data builders
│   └── mocks/               # Mock helpers
├── vitest.config.ts         # Vitest configuration
├── tsconfig.json            # TypeScript configuration
├── Dockerfile               # Container image
└── package.json             # Dependencies and scripts
```

Not all services strictly follow this layout today. For reference, the current `packages/backend/src/` structure is:

```
backend/src/
├── main.ts              # Express app entry
├── routes/              # REST endpoints + /api/chat SSE
├── agent/               # LangGraph StateGraph
├── middleware/           # auth, RBAC, rate-limit
```

Migrate incrementally towards the DDD-aligned layout above. The shared kernel (`packages/shared`) houses cross-cutting domain types.

### Event-Driven Ingest

Ingestion is asynchronous: the Bot **publishes** Discord message events to Redis Streams; the Workers **consume** them via consumer groups with explicit ACK (at-least-once). A future knowledge-events stream (Epic 6) may add workers as producers and a notifier as consumer. The Backend only reads pipeline results (PostgreSQL + pgvector); it never writes to streams or ingestion tables (AD-13).

### Monorepo Structure

```
packages/
  shared/                 # @hivly/shared — domain kernel
    src/
      db/
        schema.ts         # Drizzle schema — source of truth for tables (AD-5)
        index.ts          # exported Drizzle client
        migrations/       # SQL generated by drizzle-kit
      schemas/            # Zod API schemas (errors.ts, sse.ts, ...)
      config/
        index.ts          # loadConfig() + Zod schema for Hivly.config.yml
      types/
        events.ts         # Redis Streams event types
  bot/                    # @hivly/bot
    src/
      main.ts
      listeners/          # messageCreate, messageUpdate, messageDelete
      backfiller/         # historical indexing on startup
      publisher/          # EventPublisher → Redis Streams
    Dockerfile
  backend/                # @hivly/backend
    src/
      main.ts
      routes/             # REST endpoints + /api/chat SSE
      agent/              # LangGraph StateGraph (retrieve → reason → respond)
      middleware/         # auth, RBAC channel filter, rate-limit
    Dockerfile
  workers/                # @hivly/workers
    src/
      main.ts
      indexer/            # consume created → embed → pgvector
      sync/               # consume updated/deleted → re-index/purge
    Dockerfile
```

## Architecture Principles

- **AD-1 — three independent processes (current)**: `bot`, `backend`, `workers` are separate Node processes, each with its own `package.json`, `Dockerfile`, and Compose entry. A backfill must never block the API. A future notifier process is planned but not yet built.
- **AD-2 — shared kernel, no cross-service imports**: shared types/schemas/config live in `@hivly/shared`.
- **AD-5 — Drizzle is the only DB layer**: schema in `packages/shared/src/db/schema.ts`; migrations via `drizzle-kit` as explicit SQL. No DDL elsewhere. Never hand-edit generated SQL.
- **AD-6 — Zod contracts in shared**: every request/response shape is a Zod schema in `packages/shared/src/schemas/`. Backend validates with `.parse()`; consumers infer with `z.infer<>`. No service defines API shapes locally.
- **AD-8 — centralized config**: every service calls `loadConfig()` in `main.ts`; invalid YAML aborts the process with a clear error before any network I/O.
- **AD-12 — RBAC in the vector query**: never post-filter.
- **AD-13 — fixed stream keys/consumer groups + idempotent workers**.

See also [Domain-Driven Design Principles](#domain-driven-design-principles) and [SOLID and DRY Principles](#solid-and-dry-principles) below for detailed design-level guidance.

## Domain-Driven Design Principles

The following patterns define the target domain model. Not all code currently follows these patterns — migrate incrementally. The shared kernel (`@hivly/shared`) is the natural home for shared entities and value objects.

DDD entities may be implemented either as classes (for rich behavior) or as typed plain objects with standalone domain functions. Prefer plain objects + Zod-inferred types for simple CRUD; use classes for aggregates with invariants (e.g., Conversation).

### Entities

Entities are objects with a distinct identity that persists over time.

**Before:**

```typescript
// Previously, Discord message data might have been handled as a plain object without methods
const message = {
  id: '123456789',
  channelId: '987654321',
  guildId: '555555555',
  content: 'Hello world',
  createdAt: new Date(),
  deletedAt: null
}
```

**After:**

```typescript
export class DiscordMessage {
  constructor(
    public readonly id: string,
    public channelId: string,
    public guildId: string,
    public authorId: string,
    public content: string,
    public readonly createdAt: Date,
    public updatedAt: Date,
    public indexedAt: Date | null = null,
    public deletedAt: Date | null = null,
  ) {}

  get isActive(): boolean {
    return this.deletedAt === null
  }

  edit(newContent: string): void {
    this.content = newContent
    this.updatedAt = new Date()
  }

  softDelete(): void {
    this.deletedAt = new Date()
  }
}
```

**Explanation**: `DiscordMessage` is an entity because it has a unique identifier (`id` — a Discord snowflake) that distinguishes it from other messages, even if other properties are identical.

**Best Practice**: Entities should encapsulate business logic related to their domain concept and maintain consistency of their internal state.

### Value Objects

Value Objects describe aspects of the domain without conceptual identity. They are defined by their attributes rather than an identifier.

**Before:**

```typescript
// Handling citation information as a plain inline object
const citation = { channel: 'general', author: 'Alice', date: '2024-01-15' }
```

**After:**

```typescript
export class Citation {
  constructor(
    public readonly channel: string,
    public readonly author: string,
    public readonly date: string,
  ) {}

  equals(other: Citation): boolean {
    return (
      this.channel === other.channel &&
      this.author === other.author &&
      this.date === other.date
    )
  }

  static fromSSEFrame(frame: { channel: string; author: string; date: string }): Citation {
    return new Citation(frame.channel, frame.author, frame.date)
  }
}
```

**Explanation**: `Citation` can be considered a Value Object because it describes a source citation without needing a unique identifier — two citations with the same channel, author, and date are interchangeable.

### Aggregates

Aggregates are clusters of objects that must be treated as a unit. They have a root entity that enforces invariants and consistency boundaries.

**Before:**

```typescript
// Conversation and messages handled separately
const conversation = { id: 'conv_1', userId: 'user_1' }
const messages = [{ conversationId: 'conv_1', role: 'user', content: 'Hello' }]
```

**After:**

```typescript
export class Conversation {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly createdAt: Date,
    private _messages: Message[] = [],
    private _updatedAt: Date = new Date(),
  ) {}

  get messages(): readonly Message[] {
    return this._messages
  }

  addExchange(userContent: string, assistantContent: string, citations: Citation[]): void {
    this._messages.push(
      new Message(crypto.randomUUID(), this.id, 'user', userContent, []),
      new Message(crypto.randomUUID(), this.id, 'assistant', assistantContent, citations),
    )
    this._updatedAt = new Date()
  }
}
```

**Explanation**: `Conversation` acts as an aggregate root that contains `Message` entities. Messages only make sense in the context of a conversation.

**Recommendation**: Operations that affect child objects (adding messages, compressing history) should be handled through the aggregate root to maintain integrity and encapsulation.

### Repositories

Repositories provide interfaces for accessing aggregates and entities, encapsulating data access logic.

**Before:**

```typescript
// Direct database access without abstraction
function findMessageById(id: string) {
  return db.select().from(discordMessages).where(eq(discordMessages.id, id))
}
```

**After:**

```typescript
export interface IDiscordMessageRepository {
  findById(id: string): Promise<DiscordMessage | null>
  findActiveByChannel(channelId: string, limit: number): Promise<DiscordMessage[]>
  upsert(message: DiscordMessage): Promise<void>
}

export class DiscordMessageRepository implements IDiscordMessageRepository {
  constructor(private db: Database) {}

  async findById(id: string): Promise<DiscordMessage | null> {
    const row = await this.db
      .select()
      .from(discordMessages)
      .where(eq(discordMessages.id, id))
      .then((rows) => rows[0] ?? null)
    return row ? hydrateDiscordMessage(row) : null
  }

  async upsert(message: DiscordMessage): Promise<void> {
    await this.db
      .insert(discordMessages)
      .values({
        id: message.id,
        channelId: message.channelId,
        guildId: message.guildId,
        authorId: message.authorId,
        content: message.content,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        indexedAt: message.indexedAt,
        deletedAt: message.deletedAt,
      })
      .onConflictDoUpdate({ target: discordMessages.id, set: { content: message.content } })
  }
}
```

**Explanation**: `DiscordMessageRepository` provides a clear interface for accessing message data, encapsulating Drizzle query logic.

**Recommendation**:
- Develop complete repository interfaces for each aggregate, ensuring all database interactions pass through the repository.
- Inject the Drizzle client via the constructor. Use repository interfaces in domain logic; switch implementations in infrastructure.

### Domain Services

Domain Services contain business logic that doesn't naturally belong to a single entity or value object.

**Before:**

```typescript
// Loose functions to handle RBAC logic
function expandAllowedChannelIds(db: Database, roles: string[]) {
  // inline implementation scattered across modules
}
```

**After:**

```typescript
export class RbacService {
  constructor(
    private db: Database,
    private config: HivlyConfig,
  ) {}

  async expandAllowedChannelIds(discordRoles: string[]): Promise<string[]> {
    const permissions = await this.db
      .select()
      .from(channelPermissions)

    return permissions
      .filter((p) => p.allowedRoles.some((role) => discordRoles.includes(role)))
      .map((p) => p.channelId)
  }
}
```

**Explanation**: `RbacService` encapsulates RBAC expansion logic that spans multiple channel permissions, providing a centralized and coherent point for handling this domain operation.

### Additional Recommendations

**Use of Factories**

Factories are useful in DDD to encapsulate the logic of creating complex objects, ensuring that all created objects comply with domain rules from the moment of creation.

**Recommendation**: Implement factories for the creation of entities and aggregates, especially those that are complex and require specific initial configuration. For example, a factory that builds an `EventPublisher` with the correct stream key from AD-13 constants, or a `Conversation` factory that initializes the message history.

**Improvement in Relationship Modeling**

Relationships between entities and aggregates must be clear and consistent with business rules.

**Recommendation**: Review and model relationships to accurately reflect domain needs. For example, a `Conversation` aggregate should own its `Message` entities — child objects should only be accessed and modified through the aggregate root, not manipulated independently.

**Domain Events Integration**

Domain events handle side effects of domain operations in a decoupled manner. Hivly uses Redis Streams as the domain event bus — e.g., a `MessageCreatedEvent` published to `hivly:discord:messages` is a domain event.

**Recommendation**: Implement domain events that allow entities and aggregates to publish events that other system components can handle without being tightly coupled to the entities that generate them. Event types live in `packages/shared/src/types/events.ts`.

## SOLID and DRY Principles

SOLID principles are five object-oriented design principles that help create more understandable, flexible, and maintainable systems.

### Single Responsibility Principle (SRP)

Each class or module should have a single responsibility or reason to change.

**Before:**

```typescript
// A module that handles multiple responsibilities: config loading AND database creation
function startService() {
  const config = loadConfig('Hivly.config.yml')
  const db = createDatabase(config.databaseUrl)
  // ...
}
```

**After:**

```typescript
// ✅ packages/shared/src/config/index.ts — single responsibility: load & validate config
export function loadConfig(path?: string): HivlyConfig { /* ... */ }

// ✅ packages/shared/src/db/index.ts — single responsibility: create DB client
export function createDatabase(connectionString: string): Database { /* ... */ }

// ✅ main.ts — orchestration only
const config = loadConfig()
const db = createDatabase(process.env.DATABASE_URL!)
```

**Explanation**: Configuration loading and database connection creation are separated into distinct modules, each with a single reason to change.

### Open/Closed Principle (OCP)

Software entities should be open for extension but closed for modification.

**Before:**

```typescript
// Modifying existing code to add new agent behavior
class Agent {
  async process(query: string) {
    const results = await this.retrieve(query)
    const answer = await this.reason(results)
    // To add search_tools, we modify this class
  }
}
```

**After:**

```typescript
// The LangGraph StateGraph is open for extension, closed for modification
const graph = new StateGraph(AgentState)
  .addNode('retrieve', retrieveNode)
  .addNode('reason', reasonNode)
  .addNode('respond', respondNode)
  // Extend by adding nodes, not modifying existing ones
  .addNode('search_tools', toolExecNode)
  .addEdge(...)
```

**Explanation**: The agent graph is extended by adding nodes, not by modifying existing node logic.

### Liskov Substitution Principle (LSP)

Objects of a derived class should be replaceable with objects of the base class without altering the program's functionality.

**Before:**

```typescript
// A derived class that breaks substitution
class FailingIndexer extends BaseIndexer {
  async process(entry: StreamEntry): Promise<void> {
    throw new Error("This indexer can't process entries")
  }
}
```

**After:**

```typescript
class BaseConsumer {
  async process(entry: StreamEntry): Promise<void> { /* ... */ }
}

class IndexerConsumer extends BaseConsumer {
  async process(entry: StreamEntry): Promise<void> {
    // Full implementation — substitutable for BaseConsumer
    await this.indexMessage(entry)
  }
}
```

**Explanation**: `IndexerConsumer` provides a proper implementation that respects the base class contract, allowing substitution without errors.

**Recommendation**: Prefer composition over inheritance to avoid LSP violations.

### Interface Segregation Principle (ISP)

Many specific interfaces are better than a single general interface.

**Before:**

```typescript
// A large interface that small clients don't fully use
interface MessageOperations {
  findById(id: string): Promise<DiscordMessage | null>
  upsert(message: DiscordMessage): Promise<void>
  softDelete(id: string): Promise<void>
  syncRoles(guildId: string): Promise<void>
}
```

**After:**

```typescript
interface IMessageReader {
  findById(id: string): Promise<DiscordMessage | null>
  findActiveByChannel(channelId: string): Promise<DiscordMessage[]>
}

interface IMessageWriter {
  upsert(message: DiscordMessage): Promise<void>
}

interface IMessageDeleter {
  softDelete(id: string): Promise<void>
}

// Consumers implement only what they need
class Indexer implements IMessageReader, IMessageWriter { /* ... */ }
class SearchService implements IMessageReader { /* ... */ }
```

**Explanation**: Interfaces are segregated into smaller operations, allowing classes to implement only what they need.

### Dependency Inversion Principle (DIP)

High-level modules should not depend on low-level modules; both should depend on abstractions.

**Before:**

```typescript
// Direct dependency on a concrete implementation
class HealthController {
  private db = createDatabase(process.env.DATABASE_URL!)
  private redis = new Redis()

  async check() {
    // Depends directly on concrete instances
  }
}
```

**After:**

```typescript
// ✅ computeHealth depends on abstractions (Database, Redis), not concretions
export async function computeHealth(db: Database, redis: Redis): Promise<HealthResponse> {
  const [dbOk, redisOk] = await Promise.all([
    db.execute(sql`SELECT 1`).then(() => true).catch(() => false),
    redis.ping().then(() => true).catch(() => false),
  ])
  return { database: dbOk, redis: redisOk, status: dbOk && redisOk ? 'healthy' : 'degraded' }
}
```

**Explanation**: `computeHealth` depends on abstractions (`Database`, `Redis`), not concrete implementations. Dependencies are injected by the caller in `main.ts`.

### DRY (Don't Repeat Yourself)

Each piece of knowledge should have a single, unambiguous, and authoritative representation within a system.

**Before:**

```typescript
// Repeated validation logic in multiple endpoints
// In chat route:
const chatBody = JSON.parse(req.body)
if (typeof chatBody.message !== 'string') throw new Error('Invalid message')

// In search route:
const searchBody = JSON.parse(req.body)
if (typeof searchBody.query !== 'string') throw new Error('Invalid query')
```

**After:**

```typescript
// ✅ Zod schemas in shared are the single source of truth
// Defined once in packages/shared/src/schemas/:
export const ChatRequestSchema = z.object({ conversationId: z.string(), message: z.string() })
export const SearchRequestSchema = z.object({ query: z.string(), topK: z.number().optional() })

// Used everywhere — never redefine the shape
// backend validates: const body = ChatRequestSchema.parse(req.body)
// frontend infers:   type ChatRequest = z.infer<typeof ChatRequestSchema>
```

**Explanation**: Centralize validation logic in Zod schemas within `packages/shared/src/schemas/`. Centralize repeated logic (error mapping, response formatting) instead of duplicating it across services.

## Coding Standards

### Naming Conventions

- **Files**: `camelCase.ts` for modules; `PascalCase.ts` for classes and (in `web`) React components.
- **Variables/functions**: `camelCase` (e.g. `allowedChannelIds`, `publishMessageEvent`).
- **Classes/types/interfaces**: `PascalCase` (e.g. `EventPublisher`, `AgentState`).
- **Constants**: `UPPER_SNAKE_CASE`.
- **Packages**: `@hivly/{bot,backend,workers,web,shared}`.
- **REST endpoints**: `/api/<resource>` kebab-case plural; route params in camelCase (`/api/conversations/:conversationId`).
- **Redis stream keys / consumer groups**: fixed by AD-13 (`hivly:discord:messages`, group `hivly:indexer`, etc.).

### TypeScript Usage

- **Strict mode** always on in `tsconfig.json`.
- Explicit types for function parameters and return values.
- Avoid `any` — use `unknown` or specific types. Prefer types inferred from Zod schemas over hand-written duplicates.

```typescript
// Good
async function findConversation(id: string): Promise<Conversation | null> { /* ... */ }
// Avoid
function processData(data: any): any { /* ... */ }
```

### Error Handling

- Use the unified error shape from `@hivly/shared/schemas/errors.ts`: `{ error: string, code: string }` (AD Consistency Conventions).
- Map errors to responses at the controller/endpoint layer; never leak raw external (Discord/LLM/DB) errors inward or to clients.
- Adapters translate external failures into typed errors before they cross into the domain.

```typescript
// packages/shared/src/schemas/errors.ts
export const ErrorSchema = z.object({ error: z.string(), code: z.string() })
// e.g. res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' })
```

### Validation

- Validate all external input at the edge with the Zod schema for that endpoint: `const body = ChatRequestSchema.parse(req.body)`.
- Validate before executing business logic; a parse failure maps to a `400`/`422` with the unified error shape.

### Logging

- Use the logger exported from `@hivly/shared`; level from `observability.log_level` in `Hivly.config.yml`.
- Structured logs with relevant context; never log secrets or full message content beyond what observability requires.

## API Design Standards

- **REST + SSE**: standard REST for CRUD/search; `POST /api/chat` streams via Server-Sent Events (AD-4). The client uses `fetch` streaming (not `EventSource`) so it can POST a body.
- **Auth**: every `/api/*` route requires a valid Redis session except `/api/auth/*` and `/health`.
- **Shapes**: defined once in `packages/shared/src/schemas/`; validated with `.parse()`.
- **Endpoints** (see `TECHNICAL-DESIGN.md` §11 and `api-spec.yml` for the authoritative list): auth (`/api/auth/*`), `/api/search`, `/api/documents`, `/api/chat`, `/api/conversations`, `/api/read-status/*`, `/health`.

### SSE wire format (AD-4)

Frame schema in `packages/shared/src/schemas/sse.ts`:

```typescript
export type SSEFrame =
  | { type: 'token';    content: string }
  | { type: 'citation'; channel: string; author: string; date: string }
  | { type: 'done';     conversationId: string }
  | { type: 'error';    code: string; message: string }
```

nginx MUST disable buffering on `/api/chat` (`proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;`) or the stream is delivered all-at-once (AD-7).

### CORS

- Production: nginx is the single entry point; the Backend listens only on the internal Docker network.
- Dev: the Backend allows `security.allowed_origins` (e.g. `FRONTEND_URL`) for the Vite dev server on `:5173`.

## Database Patterns (Drizzle + pgvector)

- **Single source of truth**: `packages/shared/src/db/schema.ts`. Only `packages/shared` does DDL (AD-5).
- **Migrations**: generate with `npx drizzle-kit generate`, apply with `npx drizzle-kit migrate`. In Compose, the one-shot `migrator` service runs migrations; app services declare `depends_on: { migrator: { condition: service_completed_successfully } }` (AD-9).
- **Write ownership**: only the owning service writes a table (see `data-model.md`). Bot writes `discord_messages`; Workers write `embeddings`; Backend writes app tables.
- **Vector queries always carry the RBAC filter** (AD-12):

```typescript
const fragments = await db
  .select()
  .from(embeddings)
  .where(inArray(embeddings.channelId, allowedChannelIds))   // RBAC — part of the query
  .orderBy(sql`embedding <=> ${queryVector}`)
  .limit(config.knowledge.topK ?? 5)
```

- **Indexes**: HNSW on `embeddings.embedding` and a btree on `embeddings.channel_id` (see `data-model.md`).

## Redis Streams Patterns

Stream keys and consumer groups are invariants (AD-13):

| Stream key | Producer | Consumer group | Consumer |
|---|---|---|---|---|
| `hivly:discord:messages` | bot | `hivly:indexer` *(consumer live since 3.3)* | workers/indexer |
| `hivly:discord:messages:updated` | bot | `hivly:sync` | workers/sync |
| `hivly:discord:messages:deleted` | bot | `hivly:sync` | workers/sync |
| `hivly:knowledge:events` | bot (since 3.2: `discord.backfill.completed`); workers *(Epic 6)* | `hivly:notifier` | notifier *(deferred — Epic 6)* |

Rules:
- Event types are defined in `packages/shared/src/types/events.ts`; every message carries at least `messageId`, `channelId`, `guildId`, `timestamp` (ISO 8601).
- Consume with `XREADGROUP`; **`XACK` only after successful processing**. On failure, do not ACK — Redis reassigns the entry to another consumer of the same group (the PEL acts as an implicit DLQ).
- **Workers must be idempotent**: an insert on an existing `embedding.id` must UPSERT, not error (at-least-once delivery).

## RAG Agent (LangGraph)

- Implement the agent as a LangGraph `StateGraph` with explicit nodes `retrieve → reason → respond` and an optional `tool_exec` loop (AD-11). No legacy LangChain APIs (`langchain/chains`, `langchain/memory`) — an ESLint `no-restricted-imports` rule in `packages/backend` enforces this in CI.
- Conversation history is explicit graph state (the `messages` field), compressed when it exceeds `agent.memory_window`.
- The `retrieve` node applies the RBAC filter inside the vector query (AD-12).
- The `respond` node streams tokens to the client via SSE using the `SSEFrame` schema.

## Authentication & RBAC

- **Discord OAuth2** login (`identify`, `guilds.members.read`); verify guild membership; store only `{ userId, discordRoles }` in the Redis session (AD-10).
- **Sessions in Redis** via `express-session` + `connect-redis`; httpOnly cookie holds only the session ID; revoke by deleting the Redis key. `connect-redis` receives the same **`node-redis`** instance used for streams via its `client` option — there is a single Redis client for both concerns. (node-redis, not ioredis: `connect-redis@9` dropped ioredis support and node-redis is the recommended client for Redis 8.)
- **RBAC** middleware runs on every `/api/*` request (except auth/health): expand `session.discordRoles` → `allowedChannelIds` by joining `channel_permissions` **per request** (not cached in the session), so a config/permission change takes effect immediately (AD-12). Inject `req.allowedChannelIds` for handlers and the agent.
- `channel_permissions` is materialized from `Hivly.config.yml` via upsert at Backend startup, before accepting requests.

## Testing Standards

### Test Runner

Vitest with TypeScript 6 strict. Co-locate tests as `*.test.ts` next to the source code. Integration tests against real Postgres+pgvector use the `*.integration.test.ts` convention (separate Vitest project).

### Verification Gate

Per story: `npm run lint && npm run test && npm run build` must run green before committing. Never commit red.

### Tests-first vs Tests-after

For core/domain and orchestration (the agent graph, the Indexer pipeline, RBAC expansion), write acceptance/integration tests first (red) then implement to green. Adapter glue (discord.js listeners, HTTP controllers) may test after.

### Test Organization Pattern

```typescript
describe('[ComponentName] — [methodName]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('should [expected behavior] when [condition]', () => {
    it('should [specific test case]', async () => {
      // Arrange
      // Act
      // Assert
    })
  })
})
```

### Test Case Naming Convention

Use behavior-driven names: `should <expected behavior> when <condition>`. Group related test cases under descriptive `describe` blocks.

### Test Structure (AAA Pattern)

Always follow Arrange-Act-Assert:

```typescript
it('should update record successfully when valid data provided', async () => {
  // Arrange — set up test data and mocks
  const recordId = 1

  // Act — execute the function under test
  const result = await updateRecord(recordId)

  // Assert — verify the expected behavior
  expect(result).toEqual(expectedResult)
})
```

Use specific matchers: `toHaveBeenCalledWith()`, `toHaveBeenCalledTimes()`. Verify both successful operations and error conditions. Assert on return values and side effects.

### Mocking Standards

- **Module-level**: `vi.mock('@hivly/shared/db')` at the top of test files.
- **Function-level**: Use `fakeDb()` / `fakeRedis()` helpers (as in `health.test.ts`) for simple stubs.
- **Isolation**: Mock external dependencies (Discord API, LLM/embeddings API, DB and Redis clients in unit tests). Never open real network/DB connections in unit tests.
- Clear mocks in `beforeEach(() => vi.clearAllMocks())`.

### Test Coverage Requirements

- **Target**: 80%+ for branches, functions, lines, and statements. 90% is the long-term aspiration for core/domain modules.
- Run: `npm run test -- --coverage`
- Generate coverage reports with `npm run test:coverage`

### Error Testing

- Test both expected and unexpected errors.
- Verify error messages are descriptive and use the unified error shape (`{ error, code }`).
- Ensure proper HTTP status codes in controller tests.

### Controller Testing Specifics

- Mock the service layer completely.
- Test HTTP request/response handling (use `supertest` or `vitest-http`).
- Verify Zod validation at the edge — a malformed body must map to `400`/`422` with the unified error shape.

### Service Testing Specifics

- Mock repositories and domain models.
- Test business logic in isolation.
- Verify data transformation, validation, and error propagation.

### Database Testing (Unit)

- Mock the Drizzle client for unit tests (use `fakeDb()` pattern).
- Test query construction and parameter passing.
- Never open real database connections in unit tests.

### Database Testing (Integration)

Test against real Postgres+pgvector via Docker Compose. Use the test helper to open clients. Cover:
- Vector queries with the RBAC filter (AD-12).
- HNSW index behavior and ordering.
- Idempotency: re-inserting the same message must UPSERT, not error.

### Async Testing

- Always use `async/await`.
- Use `Promise.all()` for concurrent operations; use `Promise.allSettled()` when partial failure is acceptable.
- Test timeout scenarios where applicable.

### Test Data Management

- Use factory functions for creating test data.
- Keep test data consistent and realistic.
- Avoid hardcoded values in multiple places.

### Integration Testing

Integration tests open real Postgres and Redis connections. Run with `npm run test:integration`. Cover:
- Repository/query behavior against real SQL.
- End-to-end HTTP flows (e.g., `GET /health`) using real DB and Redis.

### Hivly-Specific Testing Requirements

- **Idempotency & At-Least-Once**: Test that re-delivering the same stream event does not duplicate embeddings (UPSERT), and that a processing failure leaves the entry un-ACKed.
- **RBAC**: Test that vector queries never return fragments outside `allowedChannelIds`.
- **LangGraph Agent**: Test the StateGraph pipeline end-to-end — retrieve → reason → respond with mocked retrievers and LLM.

### Common Anti-Patterns to Avoid

- Don't test implementation details; test behavior.
- Don't create overly complex test setups.
- Don't ignore failing tests or skip error scenarios.
- Don't use real database connections in unit tests.
- Don't create tests dependent on external services.
- Don't write tests too tightly coupled to implementation.

### Example Test Structures

```typescript
// Unit test example
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('RBAC expansion — allowedChannelIds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('should exclude channels whose allowed_roles do not intersect the user roles', async () => {
    // Arrange
    const session = { userId: 'u1', discordRoles: ['member'] }
    // Act
    const ids = await expandAllowedChannelIds(db, session.discordRoles)
    // Assert
    expect(ids).not.toContain('staff-only-channel')
  })
})
```

```typescript
// Integration test example
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

describe('GET /health — integration', () => {
  beforeAll(async () => {
    await openTestClients()
  })

  afterAll(async () => {
    await closeTestClients()
  })

  it('should return healthy when DB and Redis are reachable', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('healthy')
  })
})
```

## Performance Best Practices

### Database Query Optimization

- **Select only needed fields**; rely on the HNSW index for vector search and the `channel_id` index for the RBAC filter.
- **Avoid N+1 Queries**: Use Drizzle's `join` or batch loading to fetch related data efficiently.

```typescript
// Good: Fetch related data with a single query
const messagesWithEmbeds = await db
  .select()
  .from(discordMessages)
  .leftJoin(embeddings, eq(discordMessages.id, embeddings.messageId))
  .where(eq(discordMessages.channelId, channelId))

// Avoid: N+1 queries
const messages = await db.select().from(discordMessages).where(eq(discordMessages.channelId, channelId))
const embeds = await Promise.all(messages.map(m => db.select().from(embeddings).where(eq(embeddings.messageId, m.id))))
```

### Async/Await Patterns

- **Always Use Async/Await**: Use async/await instead of promise chains.
- **Parallel Operations**: Use `Promise.all()` for independent I/O (e.g. parallel embedding batches) — but respect Discord/LLM rate limits.

```typescript
// Good: Parallel independent operations
const [dbOk, redisOk] = await Promise.all([
  db.execute(sql`SELECT 1`).then(() => true).catch(() => false),
  redis.ping().then(() => true).catch(() => false),
])
```

- **Batch** ingestion: the Indexer/Sync worker process one message at a time per `XREADGROUP` batch — one `embeddings` row per extracted URL, no cross-message grouping or chunking (Epic 7 pivot).
- **Backpressure**: `XREADGROUP` with `COUNT`/`BLOCK`; do not fetch unbounded batches.

### Error Handling Performance

- **Early Returns**: Return early to avoid unnecessary processing.
- **Error Propagation**: Let typed errors propagate naturally through the call stack.
- **Avoid Over-Wrapping**: Don't wrap errors unnecessarily.

## Security Best Practices

- **Secrets only in `.env`; behavior only in `Hivly.config.yml`** — never mix (AD Consistency Conventions). Never commit `.env`.
- **Validate config and env at startup**: `loadConfig()` aborts on invalid YAML; assert required env vars before connecting to anything.
- **Validate all external input** with Zod at the edge; sanitize before use.
- **RBAC is a security boundary** — the vector-query filter prevents private-channel leakage into search results and RAG context (AD-12).
- **Least-privilege Discord bot**: request minimal Gateway intents/permissions.
- **Rate limiting**: apply `security.rate_limit` (window/max) middleware on the API.

## Development Workflow

Follow the BMAD Method way of working (see `base-standards.md` and `bmad-story-mandatory-steps.md`):

- **Branches**: one story at a time. Feature → `feat/<epic>-<story-slug>`; fix → `fix/<topic>`. Never commit on `main`.
- **Verify branch first**, run the gate before committing, one conventional commit per meaningful slice (`base-standards.md` §8).
- **PR at story end** (`gh pr create --base main`), body never empty (what/why/evidence, `Closes #<n>` when issue-born).
- **Mandatory review**: hand off to `bmad-code-review` before merge; `bmad-checkpoint-preview` surfaces the change for human review. Never auto-merge.

### Development Scripts

```bash
npm run dev -w @hivly/backend    # API + agent, hot reload
npm run dev -w @hivly/bot        # Bot
npm run dev -w @hivly/workers    # Workers
npm run lint                     # ESLint
npm run test                     # Vitest
npm run build                    # build all packages
npx drizzle-kit generate         # new migration from schema.ts
npx drizzle-kit migrate          # apply migrations
```

## Deployment (Docker Compose)

- Seven services: `migrator` (one-shot), `nginx`, `bot`, `backend`, `workers`, `postgres` (pgvector), `redis`.
- App services depend on `migrator` completing successfully (AD-9).
- nginx is the only host-exposed service and the TLS terminator; it serves the SPA and proxies `/api/*` (with SSE buffering disabled) (AD-7).
- Pin images explicitly (e.g. `pgvector/pgvector:pg17`, `redis:8-alpine`, `nginx:1.27-alpine`) — never `:latest`.

```bash
docker compose up -d     # first deploy / start
git pull && docker compose build && docker compose up -d   # update (migrator runs automatically)
```

This document is the foundation for a maintainable, scalable, and testable Hivly backend. All contributors follow these practices; when in doubt, the `AD-*` invariants in `docs/context/ARCHITECTURE-SPINE.md` win.
