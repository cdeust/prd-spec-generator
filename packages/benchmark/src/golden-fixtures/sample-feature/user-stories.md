# User Stories — Implementation Roadmap

## Phase 1: Core CRUD (Sprint 1-2)

| Story ID | Title | SP | Depends On | AC |
|----------|-------|-----|------------|-----|
| STORY-001 | Create snippet form | 3 | — | AC-001, AC-002 |
| STORY-002 | Edit snippet inline | 5 | STORY-001 | AC-003, AC-004 |
| STORY-003 | Delete with confirmation | 2 | STORY-001 | AC-005 |
| **Total** | | **10** | | |

## Phase 2: Search (Sprint 3)

| Story ID | Title | SP | Depends On | AC |
|----------|-------|-----|------------|-----|
| STORY-004 | Keyword search | 5 | STORY-001 | AC-006, AC-007 |
| STORY-005 | Tag filtering | 3 | STORY-003 | AC-008 |
| **Total** | | **8** | | |

## Acceptance Criteria

- AC-001: GIVEN a user on the create page WHEN they submit a valid title + code THEN the snippet is saved and visible in the list
- AC-002: GIVEN a user submitting a snippet WHEN the title is empty THEN a validation error is shown
- AC-003: GIVEN an existing snippet WHEN the user edits the code body THEN the updated version is saved
- AC-004: GIVEN an existing snippet WHEN the user changes the language THEN syntax highlighting updates
- AC-005: GIVEN a snippet WHEN the user clicks delete THEN a confirmation dialog appears before deletion
- AC-006: GIVEN the search bar WHEN the user types a keyword THEN results matching title or body are shown within 200ms
- AC-007: GIVEN search results WHEN no snippets match THEN an empty state message is shown
- AC-008: GIVEN tagged snippets WHEN the user selects a tag filter THEN only matching snippets are shown
