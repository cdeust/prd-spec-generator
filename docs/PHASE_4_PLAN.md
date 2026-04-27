# Phase 4 Plan — Calibration & Closed Loops (revised post-cross-audit)

Living document. Audited by engineering + genius teams (Phase 3+4 cross-audit, 2026-04).
Status: REVISED draft. **Implementation blocked on items marked PRE-REGISTRATION REQUIRED.**

This revision incorporates:
- Popper falsifiability + anti-pattern audit (5 anti-patterns flagged)
- Fermi order-of-magnitude sample-size brackets (5/5 items underpowered)
- Shannon load-bearing-quantity analysis (KPI surface refactored)
- Curie back-action / observer-effect audit (9 named anomalies, 6 mandatory R1-R6)
- Fisher experimental design (RCBD, blocking, power calculations, pre-registration)
- Laplace Bayesian update (MLE → Beta conjugate; N=30 dominance threshold)
- Deming common-cause vs special-cause + sequencing dependencies
- Code-reviewer §8 source discipline
- Test-engineer postcondition adequacy
- DevOps CI integration gaps

---

## Sequencing — REVISED per Deming

```
4.3 (measurement only, no dependencies, run first)
4.1 (reliability calibration)            ─┐
                                          ├─ both must complete before 4.4
                                          ┘
4.4 (strategy wiring — depends on 4.1 for correct consensus confidence)
4.2 (MAX_ATTEMPTS — depends on 4.4 for closed-loop retry behavior)
4.5 (KPI gate calibration — depends on 4.2 + 4.4 for stable distributions)
```

The original sequencing (4.1 ‖ 4.2 ‖ 4.3 → 4.4 → 4.5) was incorrect: 4.2's
MAX_ATTEMPTS calibration runs against an uncalibrated consensus output, and 4.5
calibrates KPI gates on a pipeline whose iteration_count distribution is about
to shift when MAX_ATTEMPTS changes.

---

## Cross-cutting prerequisites (mandatory before any item runs)

### CC-1 — Pre-registration discipline (Fisher Fi-A)

Each item below has a "PRE-REGISTRATION" block specifying:
- Hypothesis (H0 / H1)
- Estimand
- Estimator + sufficient statistic
- Power calculation result
- Decision rule
- Stopping rule
- RNG seed for sampling (committed before any data is collected)

A plan that specifies what data to collect but not how it will be analyzed is
not pre-registered. All five items must complete pre-registration before
implementation.

### CC-2 — Analysis script + data committed alongside each constant (Deming + §8)

Every calibrated constant introduced by Phase 4 must commit with:
1. `// source: benchmark/<script-name>, run <date>, N=<count>` at the use site
2. The analysis script in `packages/benchmark/calibration/`
3. Raw data (or a reproducible benchmark that regenerates it) committed to git

Without these three artifacts, the constant calcifies into knowledge graves.

### CC-3 — Forced exploration (ε-greedy) for any closed loop (Fisher 4.4 + Curie A6)

Any feedback loop that uses its own output to drive future decisions must
include a control arm:
- Mechanism: `ignoreHistory: boolean` flag on the relevant function
- Allocation: deterministic partition (`run_id % 5 === 0` → control; ε=0.20)
- Comparison: control vs treatment on a downstream quality metric, not on
  the loop's own output

### CC-4 — Control charts before threshold updates (Deming)

No constant calibrated by Phase 4 may be updated based on individual
observations. Each calibrated constant must have a control chart (XmR or
P-chart) and may only be revised when:
- A point falls outside 3σ limits, OR
- A run of 8 consecutive points lies on one side of the mean

This prevents the tampering cycle where common-cause variation triggers
constant adjustment.

---

## 4.1 — Per-judge reliability calibration

### PRE-REGISTRATION (mandatory before implementation)

**Hypothesis.** H1: replacing `DEFAULT_RELIABILITY_PRIOR = 0.7` with a
per-(agent_kind, claim_type) Beta posterior produces a different consensus
verdict on at least one claim where the calibrated low-reliability judge is
discounted, AND does not produce worse consensus accuracy on a held-out
labeled set.

**Estimand.** Per-(agent_kind, claim_type) reliability = P(agent_verdict ==
ground_truth_verdict | parse_succeeded). Note: parse-failure verdicts
(INCONCLUSIVE with `caveats: ["parse_error"]`) are EXCLUDED from this
estimate (Deming: parse failures are special-cause noise tracked on a
separate P-chart, not part of the reliability process).

**Estimator.** Beta-Binomial conjugate update:
- Prior: Beta(7, 3) — mean 0.7, effective sample size 10. (Laplace: this
  is moderately-informative-toward-reliability, NOT weak; the existing
  comment is corrected.)
- Posterior: Beta(7 + correct, 3 + incorrect)
- Point estimate: posterior mean = (7 + correct) / (10 + N)

**Sufficient statistic.** (correct, N) per (agent_kind, agent_name, claim_type)
cell.

**Sample size (per Fermi + Fisher + Laplace).**
- For ±0.10 reliability precision (95% CI): N = 81 per cell (Wilson interval).
- For ≥30 to ensure data dominates the prior (Laplace): minimum N = 30.
- Required N per cell: 80, ceiling 130 (Fisher RCBD power calc).
- 11 claim types × ~3 judges per panel = 33 cells × 80 = ~2,640 verdicts.
- Wall-time at ~5ms per canned-judge call: 13 seconds total.

**Decision rule.**
- Replace `DEFAULT_RELIABILITY_PRIOR` for an (agent, claim_type) cell IFF:
  1. N ≥ 30 for that cell, AND
  2. The 95% Beta credible interval excludes 0.7, AND
  3. The proposed posterior mean does not degrade consensus accuracy on a
     held-out labeled set (negative falsifier — Popper AP-5).
- For cells with N < 30, fall back to the global per-agent reliability.
- For agents with insufficient global data, fall back to Beta(7, 3) prior.

**Stopping rule.** Sampling stops when each cell reaches N=130 OR all claims
with deterministic ground truth are exhausted. The minimum-data-threshold
constant N=30 is a derived constant (Beta(7,3) effective sample size = 10;
data dominates when N > 10; ±0.05 precision requires N ≥ 30).

**Ground-truth procedure (Curie R2).** Eliminates the "either/or"; both
methods must run:
1. Run deterministic validator on a claim set. Record verdict.
2. Independent human reviewer labels the same claim set. Record verdict.
3. Calibration set = claims where both agree.
4. Disagreement set size / total = noise floor.
5. Reliability is computed only on the calibration set.

Sample drawn from a stratified random partition (RNG seed committed before
any data is collected) over (claim_type × deterministic-validator-agreement),
NOT from the first N claims of each panel (which is convenience sampling).

**Open Curie hand-off (resolved).** Verdict-direction asymmetry: maintain
TWO Beta posteriors per (agent, claim_type) cell — sensitivity (correct on
FAIL claims) and specificity (correct on PASS claims). Use the appropriate
one based on observed verdict direction in `consensus()`.

**Persistence (Laplace L6).** New schema:
```sql
agent_reliability(
  agent_kind TEXT,
  agent_name TEXT,
  claim_type TEXT,
  verdict_direction TEXT,  -- 'pass' | 'fail'
  alpha REAL,
  beta REAL,
  last_updated TEXT,
  PRIMARY KEY (agent_kind, agent_name, claim_type, verdict_direction)
);
```
ConsensusVerdict snapshots the reliability map version used so audit replays
are reproducible.

**Falsifiability (positive + negative — Popper AP-5).**
- Positive: at least one claim flips verdict between calibrated and
  uncalibrated runs.
- Negative: on a held-out labeled set with K = 50 claims (independent of
  calibration data), calibrated consensus accuracy ≥ uncalibrated accuracy.
  If the negative falsifier fires, REVERT to default prior and investigate.

---

## 4.2 — MAX_ATTEMPTS calibration

### PRE-REGISTRATION (mandatory before implementation)

**Hypothesis.** H1: P(passed at attempt 3 | failed at attempt 2) < 0.05,
justifying a reduction of MAX_ATTEMPTS from 3 to 2.

**Estimand.** CONDITIONAL pass probability — P(passed | attempt = k, failed
at all attempts < k). This is a survival-analysis quantity, NOT the marginal
P(passed | attempt = k). The plan's original specification was wrong (Fisher
Fi-4.2 critical specification error).

**Estimator.** Kaplan-Meier survival estimator over attempt number, treating
"pass at attempt k" as the event. Stratified by section_type.

**Sufficient statistic.** (k_passed_at_attempt_k, n_at_risk_at_attempt_k)
per (section_type, attempt) cell. n_at_risk_at_k = sections that reached
attempt k (failed all prior attempts).

**Sample size (per Fermi + Fisher + Test-engineer).**
- For 5pp effect detection at α=0.05, power=0.80, baseline ~0.7: N ≈ 1156
  per attempt level, OR
- ≥620 second-attempt observations + 620 third-attempt observations.
- If first-attempt fail rate ≈ 30%, total trials needed: ~2,070.
- N=50 (original plan) is underpowered by 23×.
- Wall-time at ~5ms per mocked trial: ~10 seconds for 2,000 runs.

**Decision rule.**
- If 95% CI for P(passed at attempt 3 | failed at attempt 2) excludes 0.05
  AND the upper bound of that CI is below 0.05: lower MAX_ATTEMPTS to 2.
- If 95% CI is wide (insufficient data): hold MAX_ATTEMPTS = 3.
- If P(passed at attempt 2 | failed at attempt 1) is also below 0.05: this
  is a separate signal — `prior_violations` is not improving drafts. Surface
  as Phase 4.2-secondary investigation; do NOT lower MAX_ATTEMPTS until the
  retry mechanism is fixed.

**Stopping rule.** All N=2,070 runs must complete OR until each (section_type,
attempt) cell reaches the per-cell minimum required for variance estimation.

**Mechanistic instrumentation (Curie A4 / Deming).** Add a `prior_violations_used`
boolean to recordExecution: true if the engineer's draft contains at least
one of the violation strings from `prior_violations`. Without this, retry
pass-rate cannot be attributed to violation feedback vs random variation.

**Ablation arm.** Run a second arm where `prior_violations = []` is passed
to the engineer subagent on retries. If pass-rate-by-attempt is identical
between arms, retries are random draws and MAX_ATTEMPTS = 1 is the correct
choice.

**Falsifiability.**
- Positive: P(passed at k=3 | failed at k=2) < 0.05 with 95% CI excluding 0.05.
- Negative: ablation shows no difference between with/without prior_violations
  → retry mechanism is broken; do NOT lower MAX_ATTEMPTS until fixed.

---

## 4.3 — Plan-mismatch fire-rate

### PRE-REGISTRATION

**Hypothesis.**
- H0: plan_mismatch fire rate p ≤ 0.01 (one-percent ceiling — "vanishingly rare").
- H1: p > 0.01.

The diagnostic event is observable: each fire appends a string of the form
`[self_check] plan mismatch detected — mismatch_kind:<kind>` to `state.errors`,
where `<kind>` ∈ {`content_mutation`, `ordering_regression`} (source:
`packages/orchestration/src/handlers/self-check.ts` Phase B append, CHANGELOG
[0.2.0] HIGH fix).

**Estimand.** Empirical fire rate p̂ = fire_count / K, plus per-mismatch_kind
rates (p̂_content, p̂_ordering). A run "fires" iff its `state.errors` contains
≥1 mismatch_kind entry; a run can fire at most once per kind per analysis (we
deduplicate per-run before counting, mirroring the Phase B `mismatchSeen` set).

**Estimator.** Direct count + Clopper-Pearson exact 95% CI on the binomial
proportion. No normal approximation — fire_count may be 0 or very small, where
Wald CI is degenerate.

**Sufficient statistic.** (fire_count, K) overall and per (mismatch_kind,
prd_context) cell. Stored as JSONL in
`packages/benchmark/calibration/data/mismatch-fire-rate.<run-id>.jsonl`,
one row per pipeline run.

**Sample size.**
- K=200 → Clopper-Pearson upper 95% bound at fire_count=0 is ≈ 1.83%
  (sufficient to refute H1 only at the 1.83% level, NOT 1%).
- K=300 → upper bound at 0 fires ≈ 1.22%.
- K=460 → upper bound at 0 fires ≈ 0.80% (clears the 1% ceiling).
- Recommended primary K = 460. Fall back to K=3,000 (≈0.12% upper bound) if
  fire_count ∈ {1, 2} and finer resolution is needed.
- Wall time at ~5ms per mocked run (`measurePipeline` with default canned
  dispatcher): K=460 ≈ 2.3s, K=3,000 ≈ 15s.
- Stratification floor (per Fisher): all 8 PRD context types represented at
  ≥ K/8 each. K=460 ⇒ ≥ 58 per context. K=200 ⇒ ≥ 25 per context.

**Stratification (Fisher).** Round-robin assignment of `prd_context` over the
8-element domain (`proposal`, `feature`, `bug`, `incident`, `poc`, `mvp`,
`release`, `cicd` — source: `packages/core/src/domain/prd-context.ts`). Each
run is tagged with its assigned context in the JSONL row so per-cell rates can
be reconstructed.

**Decision rule (pre-registered before data collection — four branches).**
- **Branch A — H0 rejected:** Clopper-Pearson upper 95% bound on overall p̂ < 0.01
  (typically: 0 fires in K ≥ 460 → upper ≈ 0.80%). Outcome: `fallback_unreached_delete_candidate`.
  Publish the evidence, mark the fallback path as "demonstrably unreached,"
  and proceed to deletion under a separate change with a regression test that
  artificially injects a mismatch and verifies the diagnostic still surfaces.
- **Branch B — underpowered regime (K=3,000 fallback trigger):**
  fire_count ∈ {1, 2} on the K=460 primary run. The CP-95 upper bound sits
  above 1% but the event count is too low to conclude root-cause investigation
  with statistical confidence. Outcome: `underpowered_run_fallback_K3000`.
  Run the pre-registered K=3,000 fallback dataset. FIRE_RATE_CEILING (1%) and
  the same Clopper-Pearson upper-bound test apply identically on the fallback;
  no new decision logic is introduced. Expected upper bound at 0 fires in
  K=3,000: ≈ 0.12%.
- **Branch C — investigate root cause:** fire_count ≥ 3 on K=460, OR
  fire_count ≥ 1 on the K=3,000 fallback with CP-95 upper ≥ 0.01.
  Outcome: `investigate_root_cause`. Capture every fire's
  `(mismatch_kind, prd_context, causative_section_if_known, run_id)`, do NOT
  delete the fallback path, hand off the root-cause investigation to the
  orchestration owner.
- **Branch D — underpowered (guard):** K < 460. Outcome: `underpowered`.
  Collect more runs before deciding.
- The control chart (CC-4) governs *re-evaluation* cadence; it does not
  override the binary decision above for the initial K=460 study.

**Stopping rule.** The study stops when EITHER (a) K = 460 runs have completed
AND each prd_context cell has ≥ 58 runs, OR (b) fire_count ≥ 5 — at which
point further sampling cannot lower the upper bound below 1% within budget,
and the priority shifts to root-cause analysis. Early-stopping is permitted
ONLY at these two conditions; "stop because the rate looks fine" is a
pre-registration violation.

**RNG seed.** Round-robin context assignment is deterministic; seed only
governs feature_description sampling (drawn from a fixed K=460-element corpus
committed alongside the data). Seed value: `0xC0FFEE0403` (committed in
`packages/benchmark/calibration/mismatch-fire-rate.ts` BEFORE any data row is
written; fail-fast assertion in the runner verifies the constant has not
changed at analysis time).

**Analysis script (CC-2).**
- Script: `packages/benchmark/calibration/mismatch-fire-rate.ts`.
- Raw data: `packages/benchmark/calibration/data/mismatch-fire-rate.*.jsonl`
  (one file per study run, content-addressable filename).
- Re-run command: `pnpm --filter @prd-gen/benchmark run calibrate:mismatch`
  (hooked once Phase 4.3 collects its first dataset).

**Control chart (CC-4).** XmR chart on per-batch fire rate, batches of size
n=20 runs (so 460/20 = 23 batches). Limits computed from the first 12 batches
and frozen; subsequent batches plot against frozen limits. Re-tune the gate
ONLY when (a) a point falls outside 3σ, OR (b) a run of 8 consecutive batches
sits on one side of the centerline (Western Electric rule 1 + 4). Until then:
hold the decision from the K=460 study.

**Ground-truth backing for the decision.** The mismatch reason is persisted
to `state.errors` by the Phase B handler (`self-check.ts` lines 244-256,
CHANGELOG [0.2.0] HIGH fix). The instrumentation in
`packages/benchmark/src/instrumentation.ts` parses these strings; if the
string format changes, the parser asserts on an unknown-mismatch-kind and
fails the calibration run loudly rather than silently.

**Falsifiability.** Binary, well-specified. The H1 falsifier is the upper
bound of the Clopper-Pearson 95% CI: if it sits below 0.01 with K ≥ 460, H1
is rejected at the pre-registered level.

**AP-5 negative falsifier — injection harness (Curie A3).**
A 0-fire result is ONLY meaningful if the instrumentation can actually detect
mismatch events. The negative falsifier is a synthetic injection round-trip:
1. `packages/benchmark/calibration/__tests__/instrumentation-injection.test.ts`
   — unit test that constructs synthetic `state.errors` with known-good and
   known-bad mismatch strings, calls `extractMismatchEvents`, and asserts
   exact event counts. Runs in CI on every commit; a failure here means the
   prefix in `instrumentation.ts` has drifted from the handler emitter.
2. `packages/benchmark/calibration/mismatch-fire-rate.ts:runPreflightInjectionCheck()`
   — called as Step 0 in the CLI analysis script before any real dataset row
   is consumed. If the injection round-trip returns 0 events, the analysis
   aborts with a clear human-readable error; no decision is emitted and no
   JSONL row is consumed. This ensures the K=460 study cannot accidentally
   report "0 fires" when the upstream emitter has rotated formats.

---

## 4.4 — Strategy-effectiveness closed feedback loop

### PRE-REGISTRATION (mandatory before implementation)

**Hypothesis.** H1: closing the feedback loop (`recordExecution()` populates
`getHistoricalAdjustments()`) produces better section_pass_rate than the
unclosed-loop control arm, on a held-out labeled set.

**Estimand.** Δ = E[section_pass_rate | feedback_enabled] -
E[section_pass_rate | feedback_disabled (control)].

**Estimator.** Two-sample t-test (or Mann-Whitney U if non-normal) per
(prd_context, complexity_tier) cell.

**Sufficient statistic.** (sum_pass_rate, sum_sq_pass_rate, n) per
(strategy, prd_context, complexity_tier, arm) cell. EvidenceRepository must
record sum-of-squares, not just mean, to enable variance estimation
(Fisher Fi-4.4).

**Sample size.**
- For δ=10pp section_pass_rate detection: N ≈ 393 per (strategy, cell, arm).
- 17 strategies × ~12 cells × 2 arms × 50 = 20,400 runs.
- Reduced scope: fix one (prd_context, complexity_tier) cell, compare 4
  strategies head-to-head: 4 × 2 × 393 = 3,144 runs. Manageable.
- For mocked benchmark only — at ~5ms per run, 15 seconds.
- For real ecosystem — 3,144 runs × 30s/run = 26 hours. Prohibitive.

**Forced exploration (CC-3, Curie R4).**
- Mechanism: `ignoreHistory: boolean` on `selectStrategies()`.
- Allocation: `run_id % 5 === 0` → control (ignoreHistory=true), 80% treatment.
- Holdout duration: full Phase 4.4 calibration period; analysis at the end.

**Stable variance — XmR control chart (Deming).**
- Before computing the historical adjustment for a strategy, plot
  actualConfidenceGain values for that strategy on an XmR chart.
- Update the historical adjustment ONLY when:
  - A point falls outside 3σ limits (special-cause: investigate before
    updating), OR
  - A run of 8 consecutive points lies on one side of the mean (sustained
    shift: legitimate update).
- Otherwise: hold the current adjustment. Do NOT tune on individual runs.

**actualConfidenceGain operational definition (Curie A7).**
- If `judge_dispatch_count == 0` on the first attempt (zero claims extracted),
  `actualConfidenceGain` is **omitted** (not zero). recordExecution skips the
  write entirely. Without this guard, every strategy is recorded as
  high-gain in the canned baseline.
- Compare against `chain_of_thought` baseline (Fisher 4.4 hand-off):
  `actualConfidenceGain = strategy_consensus_confidence - chain_of_thought_consensus_confidence`
  on the same input. This requires running each input twice (once with the
  treatment strategy, once with chain_of_thought as control) — doubles the
  N requirement but yields a cleaner signal.

**Decision rule.**
- If treatment arm section_pass_rate > control arm section_pass_rate by ≥10pp
  with 95% CI excluding zero: the closed loop is beneficial; ship.
- If treatment ≤ control: revert to uncalibrated selector; the loop is
  reflexivity-corrupted (Curie A6 confirmed).
- If 95% CI spans zero: insufficient data; collect more or accept that the
  effect is < 10pp.

**Falsifiability (Popper AP-3 + Curie A6).** The control arm IS the falsifier.
Without it, "improvement" is unmeasurable. Closed loops without holdout =
§9 anti-pattern.

---

## 4.5 — KPI gate threshold tuning

### PRE-REGISTRATION (mandatory before implementation)

**Hypothesis.** H1: gate thresholds set at the upper bound of the 95% CI of
P95 of K=100+ runs (a) do not trigger on ±5% normal variation and (b) do
trigger on a +20% regression.

**Estimand.** Per-KPI per-machine-class P95.

**Estimator.** Empirical P95 with Clopper-Pearson 95% CI on the order
statistic. Gate placed at upper CI bound, NOT at point estimate (Fisher 4.5).

**Sample size.**
- Fermi K5: K ≥ 100 minimum for stable P95.
- Fisher Fi-4.5: K=20 produces a P95 estimate that is the 19th-order statistic
  with very wide CI. K=100 brings CI half-width ≈ 5%.
- For real-ecosystem at ~30s/run: K=100 = 50 minutes (manageable).
- For mocked: K=100 = 0.5 seconds.

**Frozen-baseline anchor (Popper AP-1).**
- Run K=100 calibration runs against a tagged baseline version of the
  pipeline. Record the full distribution per KPI per machine class.
- Set initial gates at upper-CI-bound P95 of this frozen baseline.
- Subsequent calibration MAY widen bands but MUST NOT move the anchor.
  This prevents the threshold-ratchet failure mode where gradual regression
  is calibrated as the new normal.

**Censoring mitigation (Curie R6).**
- Run the K=100 calibration with gates DISABLED (all runs complete). Record
  the full distribution.
- After gates are enabled, maintain a "gate-blocked run log" separate from
  EvidenceRepository, recording the KPIs of blocked runs even though they
  did not complete. Use this to audit threshold drift.

**Per-KPI strategy.**
- iteration_count: P95 + 1σ as gate. Verify a +20% regression triggers.
- wall_time_ms: per-machine-class gate. Normalize against a calibration
  benchmark run on each machine.
- section_fail_count + structural_error_count: gate at 0 (any failure is a
  defect — Deming special-cause).
- distribution_pass_rate: SUSPENDED for canned-dispatcher runs (already
  implemented). For real runs, calibrate against known-good vs known-bad
  PRDs to establish a defensible threshold.
- safety_cap_hit: gate at false (any hit is a defect).
- mean_section_attempts: keep provisional 2.5 until N≥100 real runs;
  recalibrate to upper-CI-bound P95.

**Tampering safeguard (Deming + CC-4).** Gate thresholds may only change
when:
- The control chart for the corresponding KPI shows a sustained shift
  (run of 8 on one side of mean), OR
- A pre-registered re-calibration cycle (e.g., quarterly).

Individual gate violations are NOT grounds for adjusting the gate.

**Falsifiability.** Two arms:
- Inject a synthetic +20% regression in iteration_count: gate must fire.
- Re-run the baseline distribution: < 5% of runs should fire the gate
  (false-positive rate = 1 - confidence level).

If either fails: the gate is miscalibrated; tune K higher or change the
percentile.

---

## Cross-cutting risks (revised)

### Shannon: mismatch_kinds count-loss (deferred to Wave B+)

`MismatchExtraction.distinctKinds` is a `ReadonlyArray<MismatchKind>` (deduped
per run). Shannon flagged that this loses the per-kind fire count when a single
run fires the same kind multiple times. The correct representation would be
`Record<MismatchKind, number>`. This refactor is deferred: it requires changing
the `PipelineKpis.mismatch_kinds` surface, the `CalibrationRun.mismatch_kinds`
JSONL schema, and the per-kind CI computation in `analyze()`. It is NOT
blocking Phase 4.3 data collection because the current dedup-per-run matches
the pre-registered estimand (a run "fires" at most once per kind). File a
Wave B+ task to migrate to the typed count before any per-kind rate is used
for a Phase 4 deletion decision.

### Reflexivity (Curie A6, A8 / Popper AP-1, AP-3)

Two reflexivity hazards exist:

1. **Strategy effectiveness loop (4.4)** — addressed by ε-greedy control arm
   (CC-3).
2. **KPI gate censoring (4.5)** — addressed by frozen baseline + gate-blocked
   run log.

### Persistence concurrency (Lamport, Curie A1)

EvidenceRepository writes from concurrent runs serialize at the SQLite file
lock. WAL mode is on. Recommend: switch to per-run JSONL append + nightly
batch import to SQLite, eliminating write contention on the hot path.

### Constants-as-knowledge-graves (Deming + §8)

Every Phase 4 constant must commit with:
1. `// source: <script-path> run <date> N=<count>` at the use site.
2. The analysis script in `packages/benchmark/calibration/`.
3. Raw data or reproducible benchmark.

If any of these is missing, the constant has not graduated from "heuristic"
status.

### Parse-failure rate as a separate special-cause signal (Deming)

Parse failures (verdict caveats containing `parse_error` or
`judge_invocation_failed`) are tracked on a separate P-chart. They are NOT
included in the reliability calculation. They trigger infrastructure
investigation, not reliability-prior adjustment.

---

## Implementation gates

Before ANY Phase 4 item ships:
- [ ] CC-1: Pre-registration block completed for the item
- [ ] CC-2: Analysis script + raw data committed
- [ ] CC-3: Forced-exploration / control arm specified for closed loops
- [ ] CC-4: Control chart specified for any threshold updates

Before 4.1 ships:
- [ ] Dual ground-truth procedure (Curie R2)
- [ ] Beta(7,3) prior with sensitivity/specificity split (Laplace)
- [ ] Persistence schema with version snapshot (Laplace L6)
- [ ] Negative falsifier on held-out set (Popper AP-5)

Before 4.2 ships:
- [ ] Conditional (not marginal) estimand + Kaplan-Meier (Fisher Fi-4.2)
- [ ] N ≥ 2,070 trials OR effect-size revision to detectable range
- [ ] Ablation arm: with/without prior_violations
- [ ] `prior_violations_used` instrumentation

Before 4.4 ships:
- [ ] 4.1 complete (correct consensus confidence)
- [ ] ε-greedy control arm wired
- [ ] XmR control chart on actualConfidenceGain
- [ ] Zero-claim-attempt guard on recordExecution
- [ ] Reference strategy (chain_of_thought) baseline

Before 4.5 ships:
- [ ] 4.2 + 4.4 complete (stable KPI distributions)
- [ ] K ≥ 100 calibration runs against frozen baseline
- [ ] Gate-blocked run log instrumented
- [ ] Per-machine-class wall_time_ms gate
- [ ] Synthetic +20% regression test passes; ±5% variation does not

---

## Audit lineage

This plan was revised after a 10-agent cross-audit (Phase 3+4):

| Agent | Findings |
|---|---|
| Popper | 5 anti-patterns (AP-1 ratchet, AP-2 broken-by-construction gate, AP-3 missing control arm, AP-4 proxy/target confusion, AP-5 missing negative falsifier) |
| Fermi | 5/5 sample sizes underpowered; 5/8 KPI thresholds out of bracket; arithmetic error in wall_time_ms |
| Shannon | 8 KPIs analyzed; section_pass_rate redundant; judge_dispatch_count brittle (regex-parsed); 5 missing quantities (mean_section_attempts, structural_error_count, section_fail_ids, cortex_recall_empty_count, claims_evaluated typed) |
| Curie | 9 named anomalies (ground-truth-circularity, selector-feedback-reflexivity, zero-first-attempt-confidence-inflation, gate-induced-measurement-censoring, …); 6 mandatory R1-R6 |
| Fisher | All 5 items lack pre-registered analysis plan; 4.2 specification error (marginal vs conditional); 4.4 needs ε-greedy |
| Laplace | Plan specified MLE not Bayesian; Beta(7,3) prior; N=30 dominance threshold; sensitivity/specificity split |
| Deming | Sequencing correction; tampering risk on every threshold; control charts mandatory; parse-failure rate as separate signal |
| Code-reviewer | KPI gate constants need use-site source comments; defaultCraftResult duplicates smoke harness (extract to shared) |
| Test-engineer | iteration_count off-by-one bug (fixed); existsSync gate silently skips; missing connect timeout |
| DevOps | 6/10 packages have zero tests; mcp-server dist drift untracked; --workspace-concurrency=1 unnecessary in pnpm v8+ |
