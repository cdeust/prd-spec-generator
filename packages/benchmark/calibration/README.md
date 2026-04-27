# Phase 4.3 — Plan-mismatch fire-rate calibration

Pre-registered measurement-only study. The full pre-registration block lives
in [`docs/PHASE_4_PLAN.md` § 4.3](../../../docs/PHASE_4_PLAN.md). This README
describes the procedure and the file layout; **the canonical contract is the
pre-registration**, not this README.

## Hypothesis (one-line)

H0: empirical fire rate of the `[self_check] plan mismatch detected` diagnostic
is ≤ 1% of full pipeline runs. H1: > 1%. Reject H0 if the upper bound of the
Clopper-Pearson 95% CI on the observed rate sits below 0.01.

## Why this is item 4.3 (Deming sequencing)

It is measurement only. It does not change any reducer, handler, or threshold.
It depends on no other Phase 4 item. Run it first.

## Layout

```
calibration/
├── README.md                    # this file
├── index.ts                     # barrel (re-exports analyze/types/constants)
├── clopper-pearson.ts           # exact binomial CI (Numerical Recipes 3e)
├── xmr.ts                       # XmR control chart (Wheeler 1995, WE 1956)
├── mismatch-fire-rate.ts        # the 4.3 analysis script
└── data/
    └── mismatch-fire-rate.<run-id>.jsonl   # raw runs (one JSONL per row)
```

Each row in a JSONL data file:

```json
{
  "run_id": "string",
  "prd_context": "feature",
  "mismatch_fired": false,
  "mismatch_kinds": []
}
```

## Procedure

1. **Pre-register.** PHASE_4_PLAN.md §4.3 must already be filled in (it is, as
   of the commit that introduced this directory). The RNG seed
   `PRE_REGISTERED_SEED = 0xC0FFEE0403` is committed in
   `mismatch-fire-rate.ts`. Mutating it post hoc is a pre-registration
   violation; the analysis script asserts on it.

2. **Collect.** Run the calibration runner (separate concern — see
   "Remaining gaps" below). Each pipeline run drains its `state.errors`
   through `extractMismatchEvents` (`packages/benchmark/src/instrumentation.ts`)
   and appends one JSONL row to `data/`.

   Sample sizes (pre-registered):
   - Primary: K = 460 runs, ≥ 58 per `prd_context`.
   - Fall-back: K = 3,000 if the first study sees fire_count ∈ {1, 2}.

3. **Analyze.** Once the JSONL files exist:

   ```bash
   pnpm --filter @prd-gen/benchmark build
   node packages/benchmark/dist/calibration/mismatch-fire-rate.js \
     packages/benchmark/calibration/data
   ```

   The script prints the overall + per-kind Clopper-Pearson 95% CIs, the
   stratification report, the XmR chart signals, and the pre-registered
   decision rule's outcome.

4. **Decide.** Per the pre-reg:
   - Upper CI < 0.01 (typically 0 fires in K ≥ 460) ⇒ "fallback path
     demonstrably unreached"; deletion is permitted in a separate change with
     an injection-test regression guard.
   - fire_count ≥ 1 ⇒ root-cause hand-off to the orchestration owner. The
     fallback path stays.

5. **CC-4 (control chart).** XmR limits computed from the first 12 batches of
   20 runs are frozen. Subsequent batches plot against frozen limits. Re-tune
   only on (a) a 3σ excursion or (b) a run of 8 consecutive batches on one
   side of the centerline (Western Electric rules 1 + 4).

## Sources

- Clopper, C. J. & Pearson, E. S. (1934). *Biometrika* 26(4), 404-413.
- Wheeler, D. J. (1995). *Advanced Topics in Statistical Process Control.*
  SPC Press.
- Western Electric Co. (1956). *Statistical Quality Control Handbook.*
- Press et al. (2007). *Numerical Recipes,* 3rd ed., §6.4 / §6.14.
- ASTM Manual on Presentation of Data and Control Chart Analysis, 6th ed.
  (1976), Table 3 — d2 = 1.128 for n=2 subgroups.

## Remaining gaps (this commit does NOT close)

The following are required before Phase 4.3 can be declared "shipped" per the
implementation-gates checklist in `docs/PHASE_4_PLAN.md`:

- A **calibration runner** that actually executes K=460 calls to
  `measurePipeline`, round-robin-assigns prd_context, threads
  `feature_description` from a fixed corpus, and appends one JSONL row per run.
  Out of scope for this commit (touched only the measurement plumbing). The
  runner must call `extractMismatchEvents` on `state` after each pipeline
  completes; the row schema is already pinned in `analyze()`'s
  `CalibrationRun` type.
- A **fixed feature_description corpus** of K=460 entries committed under
  `data/` so the seed reference is reproducible.
- A **package.json script** (`calibrate:mismatch`) wiring the build + run
  steps. Out of scope here because it is a build-system concern.
- The **first dataset** (one JSONL file). Cannot be produced without live
  infra per task brief.

## Reproducibility sidecar (when first dataset lands)

A run of this script must commit alongside:
- The JSONL data file under `data/`.
- The git commit hash of `mismatch-fire-rate.ts` and `instrumentation.ts` at
  collection time.
- The Node + pnpm versions and OS class.
- The exact CLI invocation.
- The console output as `data/<run-id>.report.txt`.

Without all five, the result does not pass CC-2.
