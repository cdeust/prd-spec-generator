# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Phase 4.1 closed-loop reliability calibration.** Bayesian Beta(7,3) prior
  with sensitivity / specificity split per `claim_type`; SQLite-backed
  `ReliabilityRepository`; observation-flush hook on every claim resolution;
  CC-3 control arm via `getReliabilityForRun` (deterministic 20% partition
  forced-explored on the prior); JSONL audit logs alongside the SQLite store.
- **Phase 4.2 MAX_ATTEMPTS retry-budget calibration.** Kaplan-Meier survival
  math (`kmEstimate`, `kmMedianAttempts`, `logRankTest`) with Greenwood and
  Brookmeyer-Crowley CIs; Schoenfeld sample-size derivation; CC-3 control arm
  via `getRetryArmForRun`. Stopping rule revised from N=823 to N≈519 after
  measuring `event_rate=0.4762` (CP CI [0.4456, 0.5069]).
- **Phase 4.3 plan-mismatch fire-rate measurement.** Clopper-Pearson exact
  binomial CI; XmR control charts with frozen limits (Wheeler 1995 + Western
  Electric 1956 rules); fault-injection harness; pre-flight synthetic
  injection round-trip that catches drift between the diagnostic prefix and
  the regex matcher.
- **Phase 4.5 KPI gate tuning.** Frozen-baseline content-hash assertion;
  per-machine-class wall_time normalization with 5-bucket `detectMachineClass`;
  `loadCalibratedGates` + `hold_provisional` ratchet protection for thin-data
  gates; K=100 baseline committed under `packages/benchmark/calibration/data/`.
- **Externally-grounded oracle subsystem.** Ajv schema oracle, mathjs oracle,
  `tsc` subprocess code oracle, `validateSection` spec oracle.
  `OracleUnavailableError` typed throw replaces stub-mode fabrication —
  breaks annotator-circularity at the type-system boundary.
- **Paired-bootstrap implementation** (Efron & Tibshirani 1993 §16.4) —
  deterministic mulberry32 RNG; 12-decimal reproducibility pin; CI-based
  recommendation rule (`calibrated_helps` / `prior_helps` /
  `inconclusive_underpowered`); continuous-null p-value uniformity test.
- **Cross-arm comparison metrics.** `computeAblationComparison`,
  `computeReliabilityComparison`, `computeKpiGateComparison`. Each accepts a
  `SEAL_VERIFIED` typeof sentinel as a parameter; the only way to obtain it
  is to verify the held-out partition's sha256 first. Peeking before
  evaluation is a type error.
- **Production-mode dispatcher.** `makeProductionDispatcher` +
  `AgentInvoker` interface for non-canned calibration; CLI
  `--mode production|canned` flag selects whether calibration sees real
  verdicts or canned ones; the canned arm is preserved for offline
  reproducibility.
- **Claim-level `external_grounding` field.** Propagates from `Claim`
  through the orchestrator to the oracle-resolution path. The
  `conclude_verification` MCP tool now accepts an optional `claims` array
  carrying `external_grounding` so oracle-resolved truth replaces LLM-only
  consensus where schema / math / code / spec oracles are available.
- **Three sealed held-out lock files.**
  `packages/benchmark/calibration/data/maxattempts-heldout.lock.json` (§4.2),
  `packages/benchmark/calibration/data/kpigates-heldout.lock.json` (§4.5),
  `packages/benchmark/calibration/data/heldout-partition.lock.json` (§4.1,
  50-claim externally-grounded corpus). Each commits a sha256 of the
  partition before evaluation.
- **Audit lineage.** Six cross-audit cycles by Popper / Curie / Fermi /
  Shannon / code-reviewer over Waves A–F; ~50 BLOCKs closed across the wave
  sequence.
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
- Test count: 248 → 267 (preflight handler + regression suites);
  267 → 583 across Phase 4 Waves A–F (+316 tests, mostly calibration
  invariants, oracle round-trips, paired-bootstrap reproducibility,
  seal verification, and cross-arm metric edge cases).
- §4.2 Schoenfeld sample size revised from N=823 to N≈519 based on
  measured `event_rate=0.4762` (CP CI [0.4456, 0.5069]) — Popper AP-2
  closure.
- `MAX_ATTEMPTS` exported from `@prd-gen/orchestration` as
  `MAX_ATTEMPTS_DEFAULT` (was module-private; calibration needs to read it
  to derive the survival baseline).
- Build chain: `composite: true` + project reference wiring fixes the
  `pnpm -r build` chain across all 10 packages so the calibration subtree
  can consume orchestration types without circular references.
- `package.json#description`, `.claude-plugin/plugin.json#description`,
  `.claude-plugin/marketplace.json` descriptions: rewritten to reflect
  Phase 4 closure (closed-loop calibration, externally-grounded oracles,
  sealed falsifier protocols).
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

## [0.6.0] — 2026-07-17

### Added

- **Claim tiering + model-diversity judge slots** (`@prd-gen/verification`).
  A claim whose own text names a deterministically executable verification
  method (grep/diff/time/kcov/exit-status/named gate) skips the judge panel
  and gets a synthesized rule-tier verdict instead
  (`{kind:"rule",name:"rule-tier"}`); architecture-typed claims get one
  judge per model in `VerifyBudgetConfig.diversity_models` (default
  `["haiku","sonnet"]`) instead of N persona-prompted judges on one
  underlying model. `JudgeVerdict.model` records which model judged each
  claim; `10-verification-report.md` renders a cross-model-agreement
  summary. Measured on the calibration fixture: 30 → 23 judge invocations
  (-23%).
- **Explicit verification acceptance policy at `implementation_gate`.**
  `VerificationPolicyConfig` (`block_on`, `min_subjective_sampled_ratio`,
  `on_unsampled_below_ratio`, `on_cross_model_disagreement` —
  composition-root-injectable, default null uses
  `DEFAULT_VERIFICATION_POLICY`) and `evaluatePolicy()`, a pure function
  turning verification results into `pass` / `needs_attention` / `blocked`.
  `implementation_gate` now shapes its "Implement / PRD only" question from
  that verdict — a bare "Implement" is never offered while blocked — and
  records any human derogation on `post_specs.policy_derogation`.
- **Host-side external-judge executor** (`scripts/external-judge/`). A
  zero-dependency Node CLI (`judge.mjs`) that posts a judge prompt to an
  OpenAI-compatible endpoint (Gemini via AI Studio, Mistral via La
  Plateforme) when a `spawn_subagents` invocation names a non-Anthropic
  model, plus a calibration harness (`calibrate.mjs`) gated on agreement
  ≥ 0.7. No API key configured produces an explicit skipped result, never
  a fabricated verdict.
- Bilingual (FR/EN) hard-output-rule detection: opt-out markers and
  per-rule topic/keyword signal lists now recognize French phrasing via a
  shared lexicon (`rules/lexicon.ts`); 12 previously English-only rule
  checks (crypto, input validation, output encoding, structured logging,
  alerting thresholds, API contract docs, deprecation strategy, etc.) gain
  an explicit opt-out path, audited by
  `packages/validation/src/__tests__/opt-out-coverage.test.ts`.
- Budget-gated haiku judge panel for `self_check` verification
  (`PipelineState.verify_budget`, composition-root-injected): default
  panel reduced to 1 judge/claim (2 for architecture claims); a budget
  gate asks the user (reduced sample / full fleet / skip verification)
  when the invocation count exceeds a configurable cap (default 20).
- `submit_action_result` / `start_pipeline` response-size bound
  (`boundEnvelopeResponse`): an oversized `spawn_subagents` action has
  every invocation's prompt replaced by an observable `OmittedStub`; the
  full unbounded action is recoverable via
  `get_pipeline_state(run_id, format:"action")`.
- `10-verification-report.md` now written by `implementation_gate` before
  the implementation decision is asked, carrying per-claim judge verdicts
  when available.
- Root `pnpm lint` typechecks every workspace package via `tsc --noEmit`
  (`lint` script added to all 9 TS packages) and runs in CI.

### Fixed

- Root `lint` script was structurally broken: `tsc --noEmit` at the repo
  root found no `tsconfig.json` (only `tsconfig.base.json` exists), so it
  printed CLI help and exited non-zero — invisible because CI never ran
  it. Fixed by delegating to each package's own `lint` script via
  `pnpm -r run lint`; CI now runs the step so it cannot rot silently again.
- Hard-output-rule false positives on French-language PRD sections
  (technical_specification, cryptographic_standards, rate_limiting,
  secure_communication, GDPR consent, distributed_tracing) that had
  explicit, justified "non applicable" prose the English-only detector
  could not recognize.
- `test_traceability_integrity`'s test-function pattern only matched
  Swift-style `func test_xxx(`, so bash-defined tests (`test_xxx() { }`,
  `function test_xxx() { }`) were reported missing even when present.
- `claim-extractor.ts`'s evidence-snippet window used a fixed ±N-line
  radius that ignored claim boundaries, letting an adjacent claim's
  wording bleed into the current claim's evidence and mis-tier it;
  `snippet()` now stops at the neighboring claim's own start line.
- `file-export.ts` wrote placeholder text for companion files whose
  source section(s) produced no content; such files are now omitted
  entirely, with the omission and its reason recorded in
  `00-run-notes.md` (numbering stays stable).
- `renderJudgeVerdicts` stringified the structured `AgentIdentity` judge
  field as `"[object Object]"` instead of `"kind:name"`.

### Known limitation

- `server.json`'s `packages[0].file_sha256` remains a placeholder
  (`000...000`) — the real SHA-256 can only be computed after the
  `.mcpb` bundle is built by the tag-triggered release workflow, which
  does not currently write it back to this file. Tracked in #23.

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
