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

**Hypothesis (two-sided).**
- H0: per-(judge × claim_type) calibrated sensitivity AND specificity each
  lie within ±0.10 of the Beta(7,3) prior mean of 0.70 — i.e. the
  judge-specific posterior is observationally equivalent to the default
  prior at the target effect size.
- H1: at least one of {sensitivity, specificity} for at least one
  (judge × claim_type) cell departs from 0.70 by more than 0.10 (in
  either direction). Target effect size: |Δ| ≥ 0.10 on the
  posterior-mean reliability scale.

**Estimand.** Per-(judge_id, claim_type) sensitivity AND specificity
(NOT a single aggregate reliability):
- sensitivity = P(judge_verdict = PASS | ground_truth = PASS, parse_succeeded)
- specificity = P(judge_verdict = FAIL | ground_truth = FAIL, parse_succeeded)

Parse-failure verdicts (INCONCLUSIVE with `caveats: ["parse_error"]`) are
EXCLUDED from both estimates and tracked on a separate P-chart (Deming:
parse failures are special-cause noise, not part of the reliability
process).

**Estimator.** Beta-Binomial conjugate update applied independently to
each arm:
- Prior (both arms): Beta(7, 3) — mean 0.70, effective sample size 10.
  Source for the prior elicitation: Phase-3 audit baseline reliability
  estimate observed across 9 canned panels (range 0.62–0.78, central
  tendency ≈ 0.70); ESS=10 chosen so the prior is dominated by N≥30
  observations per Laplace L4. The prior is moderately informative
  toward reliability, NOT weak — a uniform prior would be Beta(1,1).
- sens posterior = Beta(7 + TP, 3 + FN)
- spec posterior = Beta(7 + TN, 3 + FP)
- Point estimate per arm: posterior **mode** =
  (α − 1) / (α + β − 2) when α, β > 1 (Laplace L4: MAP, not mean,
  is the correct point estimate; the mean over-shoots toward the prior
  when N is small).

**Sufficient statistic.** Per (judge_id, claim_type) cell, the 4-tuple
(true_positives, false_positives, true_negatives, false_negatives) over
the dual-annotator-consensus calibration set. The sens arm consumes
(TP, FN); the spec arm consumes (TN, FP). The two arms are statistically
independent because they index disjoint subsets of the ground-truth
labels (PASS for sens, FAIL for spec).

**Power calculation (per arm, per cell).**
- Goal: detect a 0.10 swing in posterior mean from the Beta(7,3) prior at
  80% power, two-sided α = 0.05.
- Frequentist proxy via Wilson score interval: at p̂ = 0.70 with
  half-width 0.10 and α = 0.05 → N ≈ 81. At 80% power for a 0.10 shift
  (p₀=0.70 vs p₁=0.80 or p₀=0.70 vs p₁=0.60), the two-proportion
  z-test gives N ≈ 80–82 per arm.
- Adopt **N = 80 per arm per (judge × claim_type) cell** as the design
  target, with a hard ceiling at N = 130 to bound wall-time.
- Note: an arm requires N ground-truth observations of the corresponding
  class. A judge facing 50/50 PASS/FAIL claims needs ~160 calibration
  claims per claim_type to fill both arms.
- Total budget: 11 claim_types × ~3 judges/panel × 2 arms × 80 ≈ 5,280
  arm-observations, ≈ 2,640 calibration claims (each yielding both
  arms by consensus class).
- Wall-time at ~5ms per canned-judge call: ≈ 13 s total.

**Decision rule (per (judge, claim_type) cell, per arm).**
Persist a calibrated posterior IFF all three hold:
  1. N_arm ≥ 30 for that arm (the dominance threshold derived from
     Beta(7,3): ESS_prior = 10, observed mass exceeds prior mass at
     N ≥ 10; ±0.05 posterior-mean precision is met at N ≥ 30 — Laplace
     L4), AND
  2. The 95% equal-tailed Beta credible interval for that arm
     excludes 0.70, AND
  3. The held-out negative-falsifier check (see Falsifiability below)
     does not regress.

Otherwise the cell-arm is *deferred*: the consensus call falls back to
the next coarser scope:
  - cell-arm with N < 30 → use the judge's global per-arm posterior (if
    that posterior itself crosses the dominance threshold)
  - judge with no arm crossing → fall back to Beta(7, 3) prior

**Stopping rule.** Sampling stops when EITHER:
- every (judge, claim_type, arm) cell reaches N = 130, OR
- the dual-annotator-consensus pool is exhausted.

If exhaustion fires before any cell reaches N = 30, the cell remains on
the prior; this is a documented null result, not a calibration failure.

**RNG seed (frozen).** `seed = 4_010_704` (interpretation: phase 4.1,
sub-stream 4010704). This seed is committed in this pre-registration
block before any sampling begins; all stratified-random partitions over
(claim_type × dual-annotator-class) MUST consume this seed. Re-using a
different seed post-hoc invalidates the run.

**Dual ground-truth procedure (Curie R2 — mandatory).** Each
calibration label requires the following procedure:

1. **Two independent annotators** label the same claim. "Independent"
   here means operationally:
   - Annotators do not see each other's verdicts during labeling.
   - Annotators do not coordinate before labeling (no shared rubric
     interpretation discussion specific to the claim under review;
     the rubric itself is shared and frozen before annotation).
   - Annotators do not see the judge's verdict.
   - Annotators do not see deterministic-validator output for the
     claim.
   - Each annotator records both a verdict ∈ {PASS, FAIL} and a free-
     text rationale; the rationale is stored but not shown to the
     other annotator.
2. **Concordance:** if the two verdicts agree, the consensus label is
   that verdict and the claim enters the calibration pool.
3. **Conflict resolution:** if the two verdicts disagree, a third
   reviewer (distinct from the original two) labels the claim with
   access to both prior rationales. The third reviewer's verdict is
   the consensus label. The claim enters the calibration pool with a
   `conflict_resolved = true` flag.
4. **Drop set:** if even the third reviewer marks the claim as
   ambiguous (verdict = INCONCLUSIVE), the claim is dropped from the
   calibration pool entirely. The drop rate is reported as a
   measurement-quality KPI; a drop rate > 10% triggers rubric review.
5. **Sampling:** the stratified random partition over
   (claim_type × consensus-class) is drawn from the resulting pool
   using the frozen seed above. NOT from the first-N claims of each
   panel (convenience sampling).

This procedure replaces the prior plan's "deterministic validator +
human reviewer" formulation, which double-counted any deterministic-
validator bias as ground truth.

**Schema (Laplace L6 — schema-version snapshot mandatory).**

The persistence layer (downstream wave; not implemented in B1) MUST use
the following schema. A schema-version snapshot is required so audit
replays of historical ConsensusVerdicts can identify which calibration
generation produced the reliability map they saw.

```sql
CREATE TABLE judge_reliability (
  judge_id              TEXT    NOT NULL,
  claim_type            TEXT    NOT NULL,
  sensitivity_alpha     REAL    NOT NULL,
  sensitivity_beta      REAL    NOT NULL,
  specificity_alpha     REAL    NOT NULL,
  specificity_beta      REAL    NOT NULL,
  n_observations        INTEGER NOT NULL,  -- total claims feeding this row
  schema_version        INTEGER NOT NULL,  -- bumped on any column or
                                           -- semantic change
  last_updated          TEXT    NOT NULL,  -- ISO-8601 UTC
  PRIMARY KEY (judge_id, claim_type)
);

CREATE TABLE judge_reliability_schema_history (
  schema_version        INTEGER NOT NULL PRIMARY KEY,
  applied_at            TEXT    NOT NULL,
  description           TEXT    NOT NULL
);
```

Equivalent JSON-file form (one record per (judge_id, claim_type)):
```json
{
  "judge_id":          "string",
  "claim_type":        "string",
  "sensitivity_alpha": 7.0,
  "sensitivity_beta":  3.0,
  "specificity_alpha": 7.0,
  "specificity_beta":  3.0,
  "n_observations":    0,
  "schema_version":    1,
  "last_updated":      "2026-04-27T00:00:00Z"
}
```

`n_observations` is the count of consensus-labeled claims that fed this
row's posterior (TP + FP + TN + FN). Note this is the union over both
arms; per-arm ESS is recoverable as α + β − prior_ESS.

The ConsensusVerdict structure SHALL include a `reliability_schema_version`
field so audit replays bind the verdict to a specific reliability
generation. Bumping `schema_version` invalidates downstream comparisons
across the boundary unless a migration is documented in
`judge_reliability_schema_history`.

**Falsifiability (positive + negative — Popper AP-5).**

- Positive falsifier (H1 evidence): at least one (judge × claim_type)
  cell-arm has its 95% Beta credible interval excluding 0.70 AND at
  least one downstream consensus claim flips verdict between the
  uncalibrated baseline and the calibrated run.

- **Negative falsifier (rejection trigger): held-out 80/20 split.**
  - Before any calibration is run, the dual-annotator-consensus pool
    is partitioned into 80% calibration / 20% held-out test, drawn
    using the frozen RNG seed above. Stratified by claim_type and by
    consensus class so each held-out cell preserves the population
    PASS/FAIL ratio.
  - The held-out 20% set is *sealed*: it does not feed any posterior
    update, no judge sees it during calibration, no human reviewer
    re-labels it during calibration tuning.
  - After calibration, the calibrated reliability map is evaluated on
    the held-out set against the Beta(7,3) prior baseline using
    consensus accuracy as the metric.
  - **Reject calibration** (revert to Beta(7,3) prior; investigate)
    IFF held-out consensus accuracy under the calibrated map is lower
    than under the prior baseline by any margin that exceeds the 95%
    bootstrap CI of the difference.
  - The held-out set is used at most ONCE per calibration generation;
    re-using it after a tuning iteration constitutes leakage and
    voids the falsifier (Popper AP-5).

**Math layer (this wave, B1).** The pure-stdlib Beta-update primitives
live in `packages/benchmark/src/calibration/reliability.ts`:
`betaUpdate`, `posteriorMean`, `posteriorMode`, `effectiveSampleSize`,
`dominanceThreshold`, `splitSensitivitySpecificity`, `tallyConfusion`.
No I/O. No verification or orchestration imports. Tests under
`packages/benchmark/src/calibration/__tests__/reliability.test.ts`.

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

**Hypothesis.** H1: plan_mismatch_count > 0 over K independent full-pipeline
runs.

**Estimand.** Empirical fire rate = fire_count / K, by mismatch_kind.

**Estimator.** Direct count, with Clopper-Pearson exact 95% CI for the rate.

**Sufficient statistic.** (fire_count, K) overall + per-mismatch_kind counts.

**Sample size.**
- K=200 detects fire rate ≥ 1.5% with 95% confidence.
- K=3,000 (Fermi recommendation) detects ≥ 0.1% — may be needed if K=200
  shows zero fires.
- Wall time at ~5ms per mocked run: 15 seconds for K=3000.

**Stratification (Fisher).** All 8 PRD context types must be represented at
minimum K_per_context = K/8 = 25 each.

**Decision rule (binary).**
- If upper Clopper-Pearson 95% bound < 1% (fire_count = 0 in K=200): delete
  the fallback path; document the evidence in a source comment and a deleted
  test.
- If fire_count > 0: record mutation_kind for all fires, identify the causative
  section using the persisted `[self_check] verification_plan mismatch (...)`
  state.errors entries (curie A5 fix already landed), and fix root cause
  before re-running.

**Ground-truth backing for the decision.** The mismatch reason is now
persisted to `state.errors` (commit: self-check.ts mismatchKind fix). K=200
runs accumulate analyzable distribution data.

**Falsifiability.** Binary; well-specified.

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
