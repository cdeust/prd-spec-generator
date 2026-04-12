# Functional Requirements

| ID | Requirement | Priority | Depends On | Source |
|----|------------|----------|------------|--------|
| FR-001 | User can create a new snippet with title, language, and code body | High | — | User Request |
| FR-002 | User can search snippets by keyword across title and body | High | FR-001 | User Request |
| FR-003 | User can tag snippets with custom labels | Medium | FR-001 | Clarification Q2 |
| FR-004 | System validates snippet syntax before saving | Medium | FR-001 | Codebase (src/validators/syntax.ts:15) |

## Non-Functional Requirements

| ID | Requirement | Target | Category |
|----|------------|--------|----------|
| NFR-001 | Search response time | < 200ms p95 | Performance |
| NFR-002 | Code storage limit per user | 50MB | Capacity |
