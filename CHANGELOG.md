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
- GitHub Actions release workflow (`release.yml`): tag-triggered build +
  test + bundle-freshness gate + CHANGELOG-driven release notes.
- `assets/banner.svg` — ANSI Shadow project banner matching the ai-architect
  ecosystem's visual contract.
- README cross-links to companion projects (Cortex, zetetic-team-subagents,
  automatised-pipeline).
- `.claude-plugin/marketplace.json` and rewritten `plugin.json` — marketplace
  distribution via `claude plugin marketplace add cdeust/prd-spec-generator`.
- `mcp-server/index.js` — reproducible ESM bundle (esbuild; `better-sqlite3`
  stays external); `pnpm bundle` script; CI bundle-freshness gate.
- `pnpm verify` end-to-end chain: install → build → bundle → test.
- Cortex memory-hooks section in `packages/skill/SKILL.md`: documents
  per-section recall query templates, what to store out, and that Cortex
  hooks (not the host) persist session content automatically.
- `docs/INTEGRATION-TESTING.md`: walk-through for `AIPRD_PIPELINE_BIN`
  live-test setup, failure-mode table, and conventions for new integration
  tests.
- `docs/EXAMPLES.md`: canonical session transcript ("build OAuth login for
  the admin console") showing every host-visible action envelope and the
  EvidenceRepository rows produced; two failure scenarios.
- `preflight` pipeline step (runs after `banner`, before `context_detection`):
  probes Cortex (`memory_stats`) and, when `codebase_path` is supplied,
  ai-architect (`health_check`); emits one actionable `failed` action with
  setup advice on probe failure.
- `preflight_status: "ok" | "skipped" | null` field on `PipelineState`.
- `skip_preflight: boolean` parameter on `start_pipeline` MCP tool for
  callers that accept degraded mode.
- `hasExplicitOptOut(content, topicSignals)` helper in `@prd-gen/validation`:
  recognises "N/A — local CLI" / "by construction" / "no network" / "out of
  scope" markers within ±240 chars of a topic signal, exempting 13 service-
  shaped hard-output rules for features that genuinely have no network
  surface, no users, no PII, or no DB.
- `packages/core/src/domain/capabilities.ts`: single `CAPABILITIES` object
  replacing the removed `TIER_CAPABILITIES` record; values match the previous
  "licensed" tier exactly so behaviour for all callers is unchanged.

### Changed

- `start_pipeline_v2` → `start_pipeline`; `get_pipeline_state_v2` →
  `get_pipeline_state` (no v1 ever existed; suffix was historical baggage).
- `commands/generate-prd.md` (repo root): rewritten as a thin wrapper
  pointing at `packages/skill/SKILL.md` and the dispatcher loop — no
  mode detection, no environment branching, no license resolution.
- Plugin name `ai-prd-generator` → `prd-spec-generator`; MCP server name
  `ai-prd-tools` → `prd-gen`; `.mcp.json` extension bug fixed
  (`index.mjs` → `index.js`).
- `docs/PHASE_4_PLAN.md` relocated from repo root.
- CONTRIBUTING.md Code of Conduct section: points at local
  `CODE_OF_CONDUCT.md` (custom) instead of Contributor Covenant.
- Pipeline step `license_gate` renamed to `banner`; handler
  `handleLicenseGate` → `handleBanner`.
- Test count: 248 → 267 (preflight handler + regression suites).
- Plugin version 0.2.0 → 0.3.0 (minor bump: new pipeline step + new
  `start_pipeline` parameter, both backward-compatible).

### Fixed

- `no_self_referencing_deps` rule: regex used `[^|]*` which matched
  newlines, allowing it to walk forward into later markdown table rows and
  false-flag any FR-NNN referenced as a dependency by a subsequent row.
  Fixed by anchoring both table and prose patterns on `[^|\n]*`; prose
  pattern additionally bounded to 200 chars.
- Service-shaped hard-output rules (auth, rate limiting, secure
  communication, GDPR consent, distributed tracing, sensitive-data
  protection, etc.) falsely failed local-CLI / library / batch-job PRDs
  that explicitly acknowledged the topic was out of scope. Fixed via
  `hasExplicitOptOut` (see Added).
- Silent per-section Cortex degradation: before the `preflight` step, a
  disabled Cortex plugin caused every recall to return `success: false`
  tagged as `upstream_failure` with no user-visible warning; section
  quality degraded without any diagnosis path. Fixed by the preflight probe.

### Removed

- License-tier system carried over from the Swift port:
  `packages/core/src/domain/license-tier.ts` (`LicenseTierSchema`,
  `TIER_CAPABILITIES`, `LicenseTier`, `TierCapabilities`);
  `license_tier` field on `PipelineState`; `licenseTier` on `PRDDocument`;
  `license_tier_override` option on `start_pipeline`; `licenseTier` param
  on `selectStrategy`; `license_tiers` / `free_tier` / `trial_tier` /
  `licensed_tier` blocks in both `skill-config.json` files.
- `validate_license` and `get_license_features` MCP tools (tool count
  19 → 17).
- `packages/orchestration/src/handlers/license-gate.ts` (replaced by
  `banner.ts`).
- Free-tier-degraded-assignment branch in `strategy/selector.ts` and
  matching test.
- Cowork-mode branching in `commands/generate-prd.md` (detected a
  `validate_license` tool that no longer exists).
- `mcp-server/index.mjs` (stale orphan).

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
