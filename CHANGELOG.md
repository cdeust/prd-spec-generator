# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Public-readiness baseline: LICENSE (MIT, sole independent author),
  CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md.
- GitHub issue templates (bug / feature / audit-finding) and PR template
  with audit-cycle checklist.
- `assets/banner.svg` — ANSI Shadow project banner matching the ai-architect
  ecosystem's visual contract.
- README cross-links to companion projects (Cortex, zetetic-team-subagents,
  automatised-pipeline).

## [0.2.0] — Phase 4: strategy-wiring + audit-cycle closure

### Added

- **Phase 4 strategy-wiring.** The `@prd-gen/strategy` package
  (research-evidence DB, claim analyzer, weighted selector,
  EffectivenessTracker) is now wired end-to-end through section-generation:
  - `selectStrategy` is called once per section at the pending → retrieving
    transition; the assignment is persisted on `SectionStatus`.
  - `buildSectionPrompt` renders a `<strategies>` block with required /
    optional / forbidden strategies + research citations.
  - Terminal section transitions enqueue one `ExecutionResult` per
    required strategy into `state.strategy_executions`.
  - The mcp-server composition root drains the queue into the
    `EvidenceRepository` via `EffectivenessTracker.recordExecution`,
    closing the feedback loop.
- Three error kinds (`section_failure` / `structural` / `upstream_failure`)
  in `state.error_kinds[]` so KPI gates distinguish handler bugs from
  recoverable upstream service failures.
- Typed `verification` field on the `done` action (replaces brittle regex
  parsing of the prose summary).
- Mixed-verdict KPI test that exercises consensus engine end-to-end.
- Per-handler injection tests + canned-dispatcher routing tests +
  feasibility-gate / license-gate / clarification proceed-branch tests.
- Schema round-trip test for `PipelineStateSchema` with populated
  strategy fields.

### Changed

- `consensus.ts`: `clampUnit` guards on every reliability/confidence input;
  `NO_INFORMATION_FLOOR=0.2` skips judges whose `adjustedReliability` would
  produce anti-correlated likelihoods.
- `DEFAULT_RELIABILITY_PRIOR_MEAN` doc-comment corrected (was mis-described
  as "uniform weak prior"; actually Beta(7,3), ESS=10).
- `buildExecutionResult` now emits one entry per required strategy (not
  just `required[0]`). Confidence gain decoupled from retry count.
- `start_pipeline_v2` → `start_pipeline`; `get_pipeline_state_v2` →
  `get_pipeline_state` (no v1 ever existed).
- `validation/audit-flags/engine.ts` split into engine + helpers +
  pipeline-ops + types modules (was 510 lines, all over §4.1).
- `handleSelfCheck` split into Phase A + Phase B + dispatcher (was 116
  lines, over §4.2).
- `smoke.test.ts` split into smoke + handler-injection (was 812 lines).

### Fixed

- **CRIT:** `runner.ts` coalesce-cap path bypassed `appendError`, breaking
  the `errors`/`error_kinds` lockstep invariant.
- **CRIT:** `parseVerdicts` return-empty mutation survived Phase B
  degradation tests (now caught by typed verification assertions).
- **CRIT:** `pipeline-tools.ts` inline ActionResult schema duplicated the
  canonical `ActionResultSchema`; now references the canonical schema
  directly.
- **CRIT:** Layer violation — `orchestration` was importing from
  `@prd-gen/ecosystem-adapters`. Pure domain types (`Claim`, `JudgeVerdict`,
  `JudgeRequest`, `AgentIdentity`) moved to `@prd-gen/core`.
- **HIGH:** `start_pipeline_v2` did not drain `strategy_executions` after
  initial step (now drains).
- **HIGH:** Free-tier zero-gain `ExecutionResult` entries were
  contaminating `chain_of_thought` cross-tier statistics; free-tier
  recording is now skipped.
- **HIGH:** Plan-mismatch diagnostic (`mismatch_kind:content_mutation` vs
  `:ordering_regression`) now surfaces in `state.errors` (was buried in
  unread synthetic verdict caveats).
- 60+ additional findings closed across two cross-audit cycles
  (Phase 3+4); see commit history `c664c95..main`.

### Tests

- 81 → 258 (+220% coverage) across 17 test files in 9 packages.
- Live integration test against the Rust automatised-pipeline binary,
  env-gated by `AIPRD_PIPELINE_BIN`.

## [0.1.0] — Initial release

- Stateless reducer (`step(state, result?) → next_state, action`) with
  9 pipeline steps.
- 11 MCP tools.
- Multi-judge verification with weighted-average + Bayesian consensus.
- Deterministic Hard Output Rules validation.
- 10 workspace packages with strict Clean Architecture layering.
