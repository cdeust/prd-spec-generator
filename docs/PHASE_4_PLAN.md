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

**Power calculation (per arm, per cell) — CORRECTED (B-Fermi-2).**

The original N=80 figure was wrong. Correct derivation:

Two-proportion z-test for p₀=0.70 vs p₁=0.80, |Δ|=0.10, α=0.05 (two-sided),
power=0.80:

    p̄ = (p₀ + p₁) / 2 = 0.375 (note: pooled proportion differs from p̄ below)
    
    More precisely:
      p̄ = (0.70 + 0.80) / 2 = 0.75
      pooled_variance_under_H0 = p̄(1-p̄) = 0.75 × 0.25 = 0.1875
      variance_under_H1 = p₀(1-p₀)/2 + p₁(1-p₁)/2 = 0.21/2 + 0.16/2 = 0.185
      
    Formula: N = (z_{α/2} √(2·p̄(1-p̄)) + z_{β} √(p₀(1-p₀)+p₁(1-p₁)))² / Δ²
    
    z_{0.025} = 1.96, z_{0.20} = 0.84, Δ = 0.10
    
    Numerator term A = 1.96 × √(2 × 0.75 × 0.25) = 1.96 × √0.375 = 1.96 × 0.6124 = 1.200
    Numerator term B = 0.84 × √(0.70×0.30 + 0.80×0.20) = 0.84 × √(0.21+0.16) = 0.84 × √0.37 = 0.84 × 0.6083 = 0.511
    
    N = (1.200 + 0.511)² / 0.01 = (1.711)² / 0.01 = 2.928 / 0.01 ≈ **292 per arm**

- **CORRECTED: N ≈ 292 per arm per (judge × claim_type) cell** (was wrongly stated as N=80).
- Hard ceiling N = 400 to bound annotator time.
- Source: Fermi cross-audit B-Fermi-2; two-proportion z-test (Fleiss, Levin, Paik
  2003, "Statistical Methods for Rates and Proportions", 3rd ed., Ch. 4).

**Calibration capacity (RESOURCE-ALLOCATION GATE — B-Fermi-2, REVISED).**
- 11 claim_types × 3 judges/panel × 2 arms × 292 ≈ 19,272 arm-observations.
  Each calibration claim yields ≈ 2 arms (one per consensus class), so
  ≈ 9,636 calibration claims needed per panel.
- This project runs on a Claude Max subscription. Annotators are LLM
  subagents, not paid humans — there is no dollar-cost gate. The binding
  constraints are agent-invocation count and orchestrator wall-clock at
  N parallel. See "§4.1 Open design decision — calibration scope" below
  for the parallel-throughput math; full N=292 calibration is feasible in
  ~1 hour at 60 parallel agent pairs.
- The earlier human-annotator framing (~344 hours at $25/hr) is preserved
  here only as historical context; it is no longer the binding constraint.
- **The actual gate is methodological, not financial:** LLM-annotator
  independence (Curie circularity) must be resolved before calibration runs
  begin — see the design-decision section below for the two acceptable
  resolutions (heterogeneous model families OR externally-grounded held-out
  subset).
- Wall-time for automated judge calls at ~5ms each: ~48 s total (negligible).
- Note: an arm requires N ground-truth observations of the corresponding class.
  A judge facing 50/50 PASS/FAIL claims needs ~584 calibration claims per
  claim_type to fill both arms (292 per arm × 2 arms).
- Total budget per panel: 11 claim_types × ~3 judges × 2 arms × 292 ≈ 19,272
  arm-observations, ≈ 9,636 calibration claims.

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

**Persistence implementation (Wave B2 delivery).**

The persistence layer is `SqliteReliabilityRepository` at `~/.prd-gen/reliability.db`, separate from `evidence.db` to allow independent backup and schema evolution. The port (`ReliabilityRepository` interface and all types) lives in `packages/core/src/persistence/reliability-repository.ts` with no SQLite import, satisfying DIP (coding-standards §1.5). The SQLite adapter lives in `packages/core/src/persistence/sqlite-reliability-repository.ts`.

Schema-version policy: a `schema_meta` table holds a single `schema_version` integer row (currently `2`, constant `RELIABILITY_SCHEMA_VERSION`). The constructor reads this and throws a human-readable error if it does not match the constant. Auto-migration is out of scope for Wave B — a version mismatch requires manual intervention before the DB can be read. This hard-stop prevents silent corruption from an incompatible schema. **Pre-rename `reliability.db` files (schema_version=1, verdict_direction in ('pass','fail')) must be deleted before first run on Wave B+ code.**

Implementation note: `sqlite-reliability-repository.ts` uses one row per `verdict_direction` (instead of the 4-column-per-row layout in the DDL block above). Both forms encode the same sufficient statistics; the row-per-arm form was chosen for atomic UPSERT and CHECK constraint integrity.

Empty-DB / prior contract: `getReliability(judge, claimType, direction)` returns `null` for unseen cells. Callers must substitute `Beta(BETA_PRIOR_ALPHA=7, BETA_PRIOR_BETA=3)` when they receive `null`. The repository does not embed fallback policy. The `n_observations` field is stored explicitly (redundant with `α + β - 10`) for human-readable diagnostics and control-chart queries (CC-4). WAL mode is on; concurrent writers serialise at the SQLite file lock; each `recordObservation` is an atomic UPSERT, so final state matches sequential application regardless of call ordering. Lamport should review the multi-process scenario if >1 calibration process writes to the same `reliability.db` simultaneously.

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
  - **Mechanical sealing enforcement (M2)**: the partition is sealed by
    writing `packages/benchmark/calibration/data/heldout-partition.lock.json`
    (schema: `{ rng_seed, partition_hash, partition_size, sealed_at, schema_version: 1 }`).
    `verifyHeldoutPartitionSeal(observed_indices, lockPath)` in
    `packages/benchmark/calibration/calibration-seams.ts` MUST be called
    BEFORE any held-out evaluation. It throws if the lock file is missing,
    if the sha256 of the sorted claim_ids does not match `partition_hash`,
    or if `sealed_at` is in the future. No evaluation may proceed without
    this check passing.
  - After calibration, the calibrated reliability map is evaluated on
    the held-out set against the Beta(7,3) prior baseline using
    consensus accuracy as the metric.
  - **Reject calibration** (revert to Beta(7,3) prior; investigate)
    IFF held-out consensus accuracy under the calibrated map is lower
    than under the prior baseline by any margin that exceeds the 95%
    bootstrap CI of the difference.
  - **Paired bootstrap implementation site (M4)**: the bootstrap
    accuracy-difference estimator is stubbed at
    `packages/benchmark/calibration/paired-bootstrap.ts::pairedBootstrapAccuracyDifference`.
    The stub throws `PAIRED_BOOTSTRAP_NOT_YET_IMPLEMENTED` — Wave C+ scope.
    Types `HeldoutClaim` and `AccuracyMap` are defined there and are final.
    The rejection rule (ci95[1] < 0 → revert) is documented in the function
    contract. Do not implement before the held-out partition is sealed.
  - The held-out set is used at most ONCE per calibration generation;
    re-using it after a tuning iteration constitutes leakage and
    voids the falsifier (Popper AP-5).

**Math layer (this wave, B1).** The pure-stdlib Beta-update primitives
live in `packages/benchmark/calibration/reliability.ts`:
`betaUpdate`, `posteriorMean`, `posteriorMode`, `effectiveSampleSize`,
`dominanceThreshold`, `splitSensitivitySpecificity`, `tallyConfusion`.
No I/O. No verification or orchestration imports. Tests under
`packages/benchmark/calibration/__tests__/reliability.test.ts`.

**Control arm — CC-3 (B-Popper-1).**

4.1 is a closed feedback loop (judge reliability estimates feed the consensus
engine, which drives future calibration runs). Per CC-3, every closed loop must
include a forced-exploration control arm.

Specification:
- **Allocation**: deterministic partition `fnv1a32(run_id) % 5 === 0` → control
  arm (ε = 0.20; 1 in 5 runs is held back). The hash function is FNV-1a 32-bit
  (deterministic, no external deps); the same run_id always maps to the same arm.
- **Control arm behaviour**: ignores `ReliabilityRepository`; uses Beta(7,3)
  prior for ALL (judge × claim_type) cells. This simulates the uncalibrated
  pipeline.
- **Treatment arm behaviour**: uses the persisted posterior from
  `ReliabilityRepository` (the normal path).
- **Comparison metric**: downstream consensus accuracy on the held-out 20% of
  the dual-annotator-consensus pool — NOT the calibration loop's own output.
  Self-referential comparison is forbidden (Curie A6).

Published seam (Wave B delivery):
- `isControlArmRun(runId: string): boolean` — deterministic partition predicate.
- `getReliabilityForRun(runId, judge, claimType, direction, repo)` — returns
  `null` (= use prior) for control-arm runs; delegates to `repo.getReliability`
  for treatment-arm runs.
- Both exported from `packages/benchmark/calibration/observations.ts`.

Wiring into `consensus.ts` is Wave C+ scope. The seam exists so 4.4 and 4.5
CANNOT ship without explicitly wiring it.

source: CC-3 (docs/PHASE_4_PLAN.md §CC-3); B-Popper-1 cross-audit finding.

---

## 4.2 — MAX_ATTEMPTS calibration

### PRE-REGISTRATION (mandatory before implementation) — REVISED for C1

**Status.** Methodology + Kaplan-Meier math layer + Schoenfeld sample-size +
ablation/control-arm seams published in this revision (C1 deliverable, Wave C).
Final calibration is BLOCKED on the ≥823-trial benchmark run feeding the
math layer with real (or mocked-end-to-end) (attempt, pass) data, AND on the
held-out 20% partition being sealed via `data/maxattempts-heldout.lock.json`.
No promotion of the calibrated MAX_ATTEMPTS value (whether 2 or another) may
land in `section-generation.ts` until the falsifier passes (see below).

**Hypothesis (two-sided, conditional).**
- H0: the conditional hazard of passing at attempt k+1 given a failure at
  attempt k is statistically indistinguishable between the two ablation arms
  (with vs. without `prior_violations`); equivalently, hazard ratio HR = 1.
- H1: HR ≠ 1; specifically, the calibration targets detection of HR ≤ 0.7
  (a 30% reduction in the conditional fail-hazard when prior_violations is
  passed forward — a clinically meaningful improvement the retry mechanism
  must demonstrate to justify MAX_ATTEMPTS > 1).

**Estimand — CONDITIONAL, not marginal (Fisher Fi-4.2 critical correction).**
The MAX_ATTEMPTS calibration question is:
  P(passed at attempt k | failed at all attempts < k)
This is a survival quantity. The original Phase-4 plan specified the marginal
P(passed at attempt = k), which conflates first-attempt easy sections with
multi-attempt hard sections and underestimates the value of retries on
already-failing sections. The marginal estimand is hereby retired.

The Kaplan-Meier survival function S(k) = P(T > k), where T is the first
attempt at which a section passes, gives the marginal at-risk fraction at
each attempt level; the conditional pass probability at k+1 equals
1 − S(k+1)/S(k), which is the quantity that drives the
"is one more attempt worth it?" decision.

**Estimator.** Kaplan-Meier non-parametric survival estimator with
Greenwood's-formula 95% CI, stratified by section_type and by ablation arm
(`with_prior_violations` vs `without_prior_violations`). Two-sample
comparison across ablation arms uses the log-rank (Mantel 1966) test.

Math layer published this wave (Wave C1) at
`packages/benchmark/calibration/kaplan-meier.ts`:
- `kmEstimate(events): { times, survival, ci95 }` — KM curve + Greenwood CI.
- `kmMedianAttempts(events): { median, ci95 }` — median attempts-to-pass with
  Brookmeyer-Crowley (1982) CI.
- `logRankTest(armA, armB): { chi2, pValue }` — two-arm log-rank (1 df).
- `schoenfeldRequiredEvents(input): { events, sampleSize }` — sample-size
  derivation (see "Sample size" below).

Module is pure-stdlib (§2.2 layer rule), no I/O, no @prd-gen/core imports.
Tested at `__tests__/kaplan-meier.test.ts` against:
- closed-form check (no censoring → 1 − empirical CDF),
- Kalbfleisch & Prentice 2002 §1.1.1 textbook example (S(6), S(7), S(10)),
- log-rank chi² hand-computation on a 5-subject reference dataset,
- Schoenfeld D=247 / N=823 on the §4.2 production parameters.

**Sufficient statistic.** Per (section_type, ablation_arm, attempt k) cell:
(d_k = events at k, n_k = at-risk just before k, c_k = censored at k).
n_{k+1} = n_k − d_k − c_k. The pooled 4-tuple per arm reproduces the
log-rank chi² without re-reading per-section data.

**Sample size (REVISED — Schoenfeld 1981 derivation, replaces ad-hoc 2,070).**
Two-sample log-rank test for HR = 0.7, α = 0.05 two-sided, power = 0.80,
50/50 allocation:

    D = (z_{α/2} + z_β)² / (p_A · p_B · (log HR)²)
      = (1.95996 + 0.84162)² / (0.5 · 0.5 · (log 0.7)²)
      = (2.80158)² / (0.25 · 0.12722)
      = 7.8489 / 0.031806
      ≈ 246.78  →  ceil = 247 events

Convert to subjects via the first-attempt fail rate (the fraction of sections
that produce ≥ 1 retry observation, i.e. the fraction that ever enter the
at-risk set for log-rank). Production telemetry: first-attempt fail rate
≈ 30% (provisional; recalibrate from real runs before the calibration study).

    N = ceil(D / event_rate) = ceil(246.78 / 0.30) = 823 subjects

The earlier ~2,070 figure derived from a marginal-estimand power calculation
for a different hypothesis (5pp difference in marginal pass rate) and is
hereby superseded. The revised target is **823 sections (~412 per arm)**
under the conditional/survival framing. If first-attempt fail rate is lower
than 0.30 in production, N rises proportionally; the runner MUST recompute
N from the observed event rate before any decision rule fires.

source: Schoenfeld, D. (1981). "The Asymptotic Properties of Nonparametric
  Tests for Comparing Survival Distributions." Biometrika 68(1), 316-319.
source: Collett, D. (2015). "Modelling Survival Data in Medical Research,"
  3rd ed., Ch. 10.2.
source: implementation `schoenfeldRequiredEvents` at
  `packages/benchmark/calibration/kaplan-meier.ts`, tested against the
  hand-computed D=247 / N=823.

**Decision rule (per pre-registered contract).**
1. If `logRankTest(arm_with, arm_without).pValue ≥ 0.05`: ablation arms are
   indistinguishable — `prior_violations` feedback is NOT driving retry
   improvement. Set `calibrated_MAX_ATTEMPTS = 1` (retries are random
   draws). Surface "retry mechanism broken" as a separate Phase-4.2-secondary
   investigation; do NOT silently leave MAX_ATTEMPTS = 3.
2. Else (arms separable; treatment beats control): compute the KM curve on
   the with-prior-violations arm and find the smallest k* such that
   `1 − S(k+1)/S(k) < 0.05` with the upper Greenwood-CI bound also below
   0.05. Set `calibrated_MAX_ATTEMPTS = k*`.
3. If no k* satisfies (2) within the observed support: hold MAX_ATTEMPTS = 3
   (status quo); collect more data.
4. The calibrated value is then validated on the held-out 20% set (negative
   falsifier, below). A failure to outperform the baseline reverts to
   MAX_ATTEMPTS_BASELINE = 3.

**Stopping rule.** Sampling stops when EITHER (a) N = 823 subjects have been
observed AND each (section_type × ablation_arm) cell has reached its minimum
event count per Schoenfeld, OR (b) the first-attempt fail rate observed in
the first 200 subjects is below 0.10 — at which point the conditional
estimand is unidentifiable in budget and MAX_ATTEMPTS = 3 is held by default
(no calibration possible). Early-stopping for any other reason is a
pre-registration violation.

**RNG seed (frozen).** `seed = 4_020_704` (interpretation: phase 4.2,
sub-stream 4020704). Committed in this pre-registration block. All
stratified-random partitions over (section_type × ablation_arm) MUST
consume this seed. Re-using a different seed post-hoc invalidates the run.

**Mechanistic instrumentation (Curie A4 / Deming).** Add a
`prior_violations_used: boolean` field to `recordExecution`: true iff the
engineer's draft contains at least one of the violation strings from
`prior_violations`. Without this, retry pass-rate cannot be attributed to
violation feedback vs. random variation. C2's scope (orchestration wiring)
includes this instrumentation; this pre-reg block locks the field name and
type so C2 cannot drift.

**Ablation arm specification (Wave C1 seam).**
- Arm A — `with_prior_violations` (treatment): retry receives the full
  `prior_violations` array from the previous attempt. Current behaviour.
- Arm B — `without_prior_violations` (control): retry receives an EMPTY
  `prior_violations` array. The ablation. Engineer subagent must NOT
  receive the previous violations list in any form.
- **Allocation**: deterministic 50/50 partition by FNV-1a top-bit
  extraction: `(fnv1a32(run_id) >>> 30) < 2` → arm B. ε = 0.50 matches
  Schoenfeld's symmetric-allocation assumption used in the power
  calculation. Top-bit (vs. low-bit `% 4`) extraction avoids FNV-1a's
  known low-bit skew on short ASCII inputs.
- **Seam**: `getRetryArmForRun(runId): RetryArm` exported from
  `packages/benchmark/calibration/calibration-seams.ts`. Reuses the same
  fnv1a32 hash function used by `isControlArmRun`; partition is independent
  of the CC-3 reliability arm because the modulus base differs.
- C2 wires this seam into the retry loop in
  `packages/orchestration/src/handlers/section-generation.ts`. NOT done in
  C1 — only the seam is published.

source: PHASE_4_PLAN.md §4.2 ablation arm; implementation
  `packages/benchmark/calibration/calibration-seams.ts::getRetryArmForRun`.

**Forced-exploration control arm — CC-3 (closed-loop falsifier).**
Phase 4.2 IS a closed loop: a calibrated MAX_ATTEMPTS feeds retry behaviour,
which changes future (attempt, pass) observations, which feeds the next
calibration cycle. Per CC-3, every closed loop must include a
forced-exploration control arm.

- **Allocation**: same partition predicate as Phase 4.1 — `fnv1a32(runId) % 5
  === 0` → control arm (ε = 0.20). Reusing the same predicate intentionally
  so a single run is fully control or fully treatment across both 4.1 and
  4.2; analyses can be joined on run_id without cross-arm contamination.
- **Control arm behaviour**: ignore the calibrated MAX_ATTEMPTS; use the
  hardcoded baseline `MAX_ATTEMPTS_BASELINE = 3`.
- **Treatment arm behaviour**: use the calibrated value.
- **Comparison metric**: section_pass_rate on the held-out 20% set, NOT
  the calibration loop's own (attempt, pass) output (Curie A6 self-reference
  forbidden).
- **Seam**: `getMaxAttemptsForRun(runId, calibratedValue): number` and
  `MAX_ATTEMPTS_BASELINE` exported from `calibration-seams.ts`.
- C2 wires this seam at the retry-loop call site (Wave C2 scope, not C1).

source: PHASE_4_PLAN.md §CC-3; implementation
  `packages/benchmark/calibration/calibration-seams.ts::getMaxAttemptsForRun`.

**Falsifiability (positive + negative — Popper AP-5).**

- *Positive falsifier (H1 evidence):* `logRankTest(arm_with, arm_without).pValue
  < 0.05` AND the calibrated MAX_ATTEMPTS k* lies strictly below the current
  baseline (3) AND the held-out evaluation passes.

- *Negative falsifier (rejection trigger): held-out 80/20 split.*
  - Before any calibration is run, the candidate-run pool is partitioned 80%
    calibration / 20% held-out using the frozen RNG seed `4_020_704`,
    stratified by section_type so each held-out cell preserves the
    population pass/fail ratio.
  - The held-out 20% set is *sealed*: it does not feed any KM or log-rank
    update; no calibration tuning may inspect it.
  - **Mechanical sealing enforcement.** The partition is sealed by writing
    `packages/benchmark/calibration/data/maxattempts-heldout.lock.json`
    (schema reuses the Phase-4.1 `HeldoutPartitionLockSchema`:
    `{ schema_version: 1, rng_seed, partition_hash, partition_size, sealed_at }`).
    `verifyHeldoutPartitionSeal(observed_indices, lockPath)` from
    `calibration-seams.ts` MUST be called BEFORE any held-out evaluation. It
    throws on missing lock, hash mismatch, future `sealed_at`, or null
    template fields.
  - After calibration, the held-out set is replayed under the calibrated
    MAX_ATTEMPTS and (separately) under MAX_ATTEMPTS_BASELINE = 3. Compare
    section_pass_rate using paired-bootstrap CI of the difference.
  - **Reject calibration** (revert to MAX_ATTEMPTS = 3; investigate) IFF the
    held-out section_pass_rate under the calibrated value is lower than
    under the baseline by any margin that exceeds the 95% bootstrap CI of
    the difference.
  - The held-out set is used at most ONCE per calibration generation; re-use
    after a tuning iteration constitutes leakage and voids the falsifier.

- *Ablation falsifier (mechanism check).* If the log-rank test on
  with-vs-without prior_violations returns p ≥ 0.05, the retry MECHANISM is
  broken regardless of the survival-rate signal. Set MAX_ATTEMPTS = 1 and
  surface as a separate engineering investigation. Do NOT lower MAX_ATTEMPTS
  to 2 in this case — that would bake in random-draw-as-feature.

source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure (template);
  M2 mechanical enforcement; Popper AP-5.

**Math layer (this wave, C1).** Pure-stdlib KM/log-rank/Schoenfeld primitives
at `packages/benchmark/calibration/kaplan-meier.ts`. Tests at
`__tests__/kaplan-meier.test.ts`. Seam tests at
`__tests__/calibration-seams.test.ts`. No I/O, no orchestration imports.

**Orchestration wiring (Wave C2 scope, NOT this wave).** C2 will:
1. Replace the hardcoded `MAX_ATTEMPTS = 3` in
   `packages/orchestration/src/handlers/section-generation.ts:46` with a
   call to `getMaxAttemptsForRun(state.run_id, calibratedValue)`.
2. Thread `getRetryArmForRun(state.run_id)` into the retry-prompt builder
   so arm B sections receive an empty prior_violations array.
3. Emit the `prior_violations_used` boolean on every recordExecution.

C1 publishes the seams; C2 consumes them. The seams cannot be removed
without breaking the calibration plan, so Wave C2 cannot ship without
explicit wiring (B-Popper-1 same-pattern enforcement).

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
- [ ] CC-3 control arm seam: `isControlArmRun` / `getReliabilityForRun` published
      and wired at call sites in 4.4 / 4.5 (B-Popper-1)
- [ ] Calibration scope decision committed: which option (1/2/3/4) from
      "§4.1 Open design decision" + LLM-annotator independence resolution
      (heterogeneous model families OR externally-grounded held-out subset)
      (B-Fermi-2 gate, revised under Max subscription)
- [ ] dominanceThreshold ESS correction deployed (B-Fermi-3)
- [ ] VerdictDirection renamed to sensitivity_arm/specificity_arm (C-Shannon-CONCERN-3)
- [ ] AnnotatorView enforced at all queue drain consumers (B-Curie-4)
- [ ] busy_timeout = 5000 in SqliteReliabilityRepository (B-Curie-5)
- [ ] judge_id structured record deployed (B-Shannon-6)
- [ ] DEFAULT_RELIABILITY_PRIOR single source of truth in @prd-gen/core (B-Shannon-7)

Before 4.2 ships:
- [x] Conditional (not marginal) estimand + Kaplan-Meier math layer
      (Fisher Fi-4.2) — published in `kaplan-meier.ts` (Wave C1)
- [x] Sample size revised under Schoenfeld 1981: N = 823 subjects (~412 per
      arm) at HR = 0.7, α = 0.05, power = 0.80, event_rate ≈ 0.30. The
      original ~2,070 figure is superseded — see §4.2 power calculation
      (Wave C1)
- [x] Ablation arm seam published: `getRetryArmForRun(runId)` returning
      `with_prior_violations` / `without_prior_violations` (Wave C1)
- [x] CC-3 closed-loop control-arm seam published: `getMaxAttemptsForRun`
      + `MAX_ATTEMPTS_BASELINE = 3` (Wave C1)
- [x] Held-out 20% partition seal template at
      `data/maxattempts-heldout.lock.json` — must be drawn + sealed before
      held-out evaluation (Wave C1)
- [ ] `prior_violations_used` boolean instrumentation on `recordExecution`
      (Wave C2 scope — orchestration wiring)
- [ ] Retry-loop wiring: `getMaxAttemptsForRun` + `getRetryArmForRun`
      consumed in `section-generation.ts` (Wave C2 scope)
- [ ] N=823 trials run end-to-end on real or mocked-end-to-end pipeline,
      stratified by section_type and ablation arm (Wave C+ scope; gated on
      C2)
- [ ] Held-out 20% set populated, sealed, and replayed under both calibrated
      and baseline MAX_ATTEMPTS (Wave C+ scope)

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

---

## §4.1 Open design decision — calibration scope (Fermi cross-audit)

**Status: UNDECIDED. Decision must be made before annotation work begins.**

**Context.** The 33-cell × 2-arm design (11 claim_types × 3 judge kinds ×
{sensitivity, specificity}) requires N=292/arm observations per cell to detect
|Δ|≥0.10 at power=0.80 (Laplace L4; §4.1 PRE-REGISTRATION). Total observations:
292 × 33 × 2 = 19,272 claims. With LLM agents as the annotator pool (this
project runs on a Claude Max subscription — no human-annotator dollar cost,
only invocation/wall-clock budget), the original Fermi finding ("3-17 years
at 1 run/day with paid human annotators") collapses: parallel agent dispatch
removes the throughput ceiling.

**Cost axis re-framed.** All four options below are zero-marginal-cost in
dollars on the Max subscription. The binding constraints are:
- **Agent-invocation count** (subagent dispatch capacity)
- **Wall-clock at N parallel agents** (orchestrator throughput)
- **Statistical guarantee** (effect size × power)
- **Methodological soundness** (LLM-annotator independence — see warning below)

**WARNING — LLM-annotator independence (Curie circularity).** When the
"dual annotators" are LLM agents and the JUDGES being calibrated are also LLM
agents, two independence concerns emerge:
1. **Annotator-annotator independence.** Two agents from the same model family
   share base biases. The dual-annotator procedure (Curie R2) requires
   annotators be *operationally* independent (blind to peer verdict, judge
   verdict, validator output). LLM-pair independence requires either
   (a) different model families per annotator, or (b) explicit prompt-level
   isolation with verified non-leakage.
2. **Annotator-judge independence.** If annotator-LLMs and judge-LLMs share
   training data, the calibration measures *agreement-with-annotator-LLM*, not
   *agreement-with-truth*. A judge that disagrees with the annotator pool may
   actually be more correct, not less. This is genuinely unsolved by simply
   parallelizing more agents.

**Recommended treatment of independence:** the held-out 20% partition (already
mechanically sealed via `verifyHeldoutPartitionSeal`) should include claims
with externally-verifiable ground truth (e.g., schema-correct vs.
schema-broken JSON, factual claims with ground-truth lookup) so the falsifier
test can distinguish "calibration agrees with annotator pool" from
"calibration agrees with reality." This is a Wave C+ constraint, not a Wave B
implementation gate.

---

### Option 1 — Full parallel agent calibration (NEW DEFAULT under Max subscription)

Dispatch K parallel subagent pairs as the annotator pool. With LLM agents,
1 run/pair/day becomes 1 run/pair/minute or faster.

**Throughput math.** 3,890 runs / 60 parallel pairs at ~30s/claim ≈
3,890 / (60 × 120 claims/hr) = 0.54 hours of orchestrator wall-clock.
Sequential at 1 pair: ~32 hours. Either form is feasible in a single working
session.

| Dimension | Value |
|---|---|
| Agent invocations | ~58,000 (annotator + judge + adjudicator passes) |
| Wall-clock | 1 hour (60-pair parallel) → 32 hours (1-pair sequential) |
| Statistical guarantee | \|Δ\|≥0.10 at power=0.80; full per-cell calibration |
| Falsifier sensitivity | full — all 66 cell-arms calibrated |
| Code/spec changes | none — existing implementation supports this |
| Risk | LLM-annotator independence (see warning above). Must be addressed by either heterogeneous-model-family annotators OR external ground-truth claims in the held-out partition. |

---

### Option 2 — Hierarchical pooling (multilevel model, claim_type as random effect)

Estimate per-judge sensitivity/specificity with claim_type as a partial-pooling
random effect (multilevel / mixed-effects Beta-Binomial). Reduces effective N
from 292/cell to ~292/judge ≈ 9× fewer observations.

**Throughput math.** 3 judge kinds × 292/judge = 876 observations total. At
60 parallel agent pairs × 30s/claim: ~7 minutes wall-clock.

| Dimension | Value |
|---|---|
| Agent invocations | ~2,600 (9× fewer than Option 1) |
| Wall-clock | 7 minutes (parallel) → 4 hours (sequential) |
| Statistical guarantee | \|Δ\|≥0.10 at the per-judge level; claim_type effect is pooled |
| Falsifier sensitivity | reduced — claim_type deviations partially pooled toward judge mean |
| Code/spec changes | replace `splitSensitivitySpecificity` with hierarchical model; new math module; separate pre-registration for the multilevel structure |
| Risk | Statistical complexity; hierarchical assumption (claim_type random effect well-behaved) is unverified — needs sensitivity analysis comparing to Option 1 on a subset. |

---

### Option 3 — Lowered v1 N target (N=80/cell)

Ship v1 with N=80/arm/cell. Detects |Δ|≥0.20 at power=0.80 (not 0.10).
Originally proposed because of the dollar-cost ceiling of paid annotators —
that constraint is dissolved under the Max subscription, but Option 3 remains
useful as a fast smoke-test pass before committing to the full N=292.

| Dimension | Value |
|---|---|
| Agent invocations | ~16,000 |
| Wall-clock | 18 minutes (parallel) → 9 hours (sequential) |
| Statistical guarantee | \|Δ\|≥0.20 at power=0.80 per cell |
| Falsifier sensitivity | low — detects large reliability failures only |
| Code/spec changes | update N_TARGET constant in pre-registration; update stopping rule |
| Risk | Weaker statistical claims; if true reliability shift is 0.10, v1 misses it. Useful as a v0 smoke test before committing the full Option 1 run. |

---

### Option 4 — Subset-of-judges first (calibrate top 1-2 judges in v1)

Calibrate only the 1-2 most-frequently-dispatched judges in v1. Defer remaining
judges to v2.

| Dimension | Value (1 judge / 2 judges, N=292) |
|---|---|
| Agent invocations | ~6,500 / ~13,000 |
| Wall-clock | 7 / 14 minutes (parallel) |
| Statistical guarantee | full per-cell for selected judges; uncalibrated for remainder |
| Falsifier sensitivity | partial — only selected judges contribute |
| Code/spec changes | add judge-dispatch-frequency telemetry to select top judges; add fallback policy (use prior) for uncalibrated judges in consensus.ts |
| Risk | Incomplete consensus weighting; "top-dispatched" judge set may shift as dispatch patterns change. Useful only if Option 1 invocation budget is somehow constrained, which it isn't here. |

---

### Decision rule (revised under Max subscription)

**NEW DEFAULT: Option 1 (full parallel agent calibration).** Zero marginal
cost, ~1 hour parallel wall-clock, full per-cell |Δ|≥0.10 calibration.
**Conditional on resolving the LLM-annotator independence concern** before
the run begins — Wave C+ must commit to either heterogeneous-model-family
annotators OR an externally-grounded held-out subset.

**Recommended sequencing:**
1. Run Option 3 (N=80) first as a smoke test (~18 minutes parallel) to
   validate the pipeline end-to-end and surface any operational issues.
2. Then Option 1 (N=292) for the production calibration.
3. Track Option 2 (hierarchical pooling) as an analytical follow-on once
   Option 1 data is in hand — the multilevel model can be fit on the same
   observation log without re-running the agents.

Option 4 is deprecated under Max subscription (no invocation-budget reason to
prefer it).

**This sequencing must be locked in before annotation begins, but the lock-in
is now a methodological commitment (independence resolution + run order), not
a financial one.**

Source: Fermi cross-audit A1; docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION;
Laplace L4 (N=292 derivation); M4 residual (paired-bootstrap implementation site).
