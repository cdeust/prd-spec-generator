# Technical Specification

## Architecture

This system follows **clean architecture** with **ports and adapters** (hexagonal) pattern.

### Domain Layer

The domain layer defines protocols (ports) for all external dependencies:

```typescript
// SnippetRepository port — domain defines the contract
interface SnippetRepositoryPort {
  save(snippet: Snippet): Promise<void>;
  findById(id: SnippetId): Promise<Snippet | null>;
  search(query: SearchQuery): Promise<Snippet[]>;
  delete(id: SnippetId): Promise<void>;
}

// ClockPort — injected, never use Date() directly
interface ClockPort {
  now(): Timestamp;
}

// UUIDGeneratorPort — injected, never use UUID() directly
interface UUIDGeneratorPort {
  generate(): UniqueId;
}
```

### Adapter Layer

Infrastructure adapters implement domain ports:

```typescript
// PostgreSQL adapter implements SnippetRepositoryPort
class PostgresSnippetRepository implements SnippetRepositoryPort {
  constructor(private readonly pool: Pool) {}
  // ... implementation
}
```

### Composition Root

The composition root wires adapters to ports via factory-based injection:

```typescript
class SnippetUseCaseFactory {
  static create(config: AppConfig): CreateSnippetUseCase {
    const repo = new PostgresSnippetRepository(config.pool);
    const clock = new SystemClock();
    const uuidGen = new CryptoUUIDGenerator();
    return new CreateSnippetUseCase(repo, clock, uuidGen);
  }
}
```

## Data Model

```sql
CREATE TABLE snippets (
  id UUID PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  language VARCHAR(50) NOT NULL,
  code_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID NOT NULL REFERENCES users(id)
);

CREATE TYPE tag_type AS ENUM ('custom', 'language', 'framework');

CREATE TABLE snippet_tags (
  snippet_id UUID NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
  tag_name VARCHAR(100) NOT NULL,
  tag_type tag_type NOT NULL DEFAULT 'custom',
  PRIMARY KEY (snippet_id, tag_name)
);

CREATE INDEX idx_snippets_user ON snippets(user_id);
CREATE INDEX idx_snippets_language ON snippets(language);
CREATE INDEX idx_snippet_tags_name ON snippet_tags(tag_name);
```

## API Specification

| Method | Endpoint | Auth | Rate Limit | Description |
|--------|----------|------|------------|-------------|
| POST | /api/snippets | Bearer token | 60/min | Create snippet with input validation |
| GET | /api/snippets/:id | Bearer token | 120/min | Get snippet by ID |
| PUT | /api/snippets/:id | Bearer token | 60/min | Update snippet with optimistic concurrency via ETag |
| DELETE | /api/snippets/:id | Bearer token | 30/min | Delete snippet with confirmation |
| GET | /api/snippets/search?q=keyword | Bearer token | 120/min | Search with sanitized input, rate limiting |
