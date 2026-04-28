# Production-mode KPI gate calibration — runbook

**Status:** PILOT artefact produced (K=5, stub invoker). Promotable K=100
production batch is a separate session, scheduled per the parameters below.

**Source:** Wave F sub-stream F2 brief; PHASE_4_PLAN.md §4.5 (production-mode
disposition for `wall_time_ms_max` and `cortex_recall_empty_count_max`).

---

## Why a production-mode batch is needed

The committed canned baseline at `data/gate-calibration-K100.json` was
measured against `makeCannedDispatcher` — synthetic deterministic responses
with a ~1ms wall-time floor and 100% empty cortex recalls. Two gates are
held provisional (`hold_provisional: true`) because the canned baseline does
not represent real production:

| Gate | Canned-calibrated | Reason held |
|---|---|---|
| `wall_time_ms_max` | 1.534ms | Production wall time is dominated by LLM latency, ~1000–10000× the canned floor. Promoting 1.534ms would fire on every real claim. |
| `cortex_recall_empty_count_max` | 11 | Cold-cortex baseline (canned dispatcher always returns empty). Production cortex is warmer (prior runs seed the cache); loosening 3→11 may mask real recall failures. |

A production-mode batch re-calibrates these against real (or
realistically-stubbed) dispatcher behaviour.

---

## Ratchet protection — hold_provisional on all pilot gates (Popper AP-1)

All gates in `gate-calibration-K100-production.json` carry `hold_provisional: true`
until the K=100 batch lands. The loader (`calibrated-gates-loader.ts:109`) skips
any gate where `hold_provisional === true`, so passing this file path to the loader
produces no promotions regardless of `passes_threshold`.

To promote, edit each gate's `hold_provisional` to `false` **AFTER** verifying ALL
6 promotion conditions (listed in the "Promotion criteria" section below). Do NOT
flip `hold_provisional` for any gate that does not satisfy its conditions — gates
must be evaluated individually.

---

## Pilot K=5 (this session — DEMONSTRATION ONLY, not promotable)

Artefact: `data/gate-calibration-K100-production.json` with
`data_source: "production_pilot_K=5"`, `agent_invoker_class: "stub-pilot-K5"`.

Stub invoker parameters:
- `latencyMinMs: 50`, `latencyMaxMs: 200` (reduced from the 500–2000ms target
  to keep the pilot under 30s of wall clock; production runs MUST use the
  full 500–2000ms range or — better — a real host-backed invoker).
- `warmCortexHitProbability: 0.7` (~30% of recalls remain empty,
  simulating an imperfect-but-warm cache).
- `rng: mulberry32(0x4_05_C3_FF)` (deterministic).

Pilot results (raw):
- `wall_time_ms_max`: provisional=500 → calibrated=4396ms (would loosen).
  Demonstrates the runner machinery captures realistic-shape latency
  (4396ms is ~3000× the canned 1.4ms floor; it would scale further with
  the full 500–2000ms latency range or real LLM calls).
- `cortex_recall_empty_count_max`: provisional=3 → calibrated=3.8
  (would loosen). Substantially lower than the canned 11; consistent
  with warm-cortex behaviour.
- All other gates unchanged from the canned distribution (the canned
  fallback handles non-LLM actions identically).

The pilot K=5 artefact is **NOT promotable**. K=5 produces wide CIs that
do not satisfy the §4.5 promotion threshold (5% relative divergence with
95% CI excluding provisional). It exists only to prove the runner works.

---

## Promotable production batch — REQUIRED PARAMETERS

### K (sample size)
- **K = 100** (matches the canned baseline so distributions are directly
  comparable per-gate).
- Smaller K is permitted **ONLY** as a documented hedge (e.g., K=50 with
  CI's published, plus a planned K=100 follow-up). K < 30 is REFUSED for
  any promotion-bound batch — Clopper-Pearson CIs at K<30 are too wide to
  exclude a 5% provisional-vs-calibrated gap for typical distributions.
  Source: `clopper-pearson.ts` + Wave D D3.4.1 P95 reference math.

### RNG seed
- **`PRE_REGISTERED_SEED_45_PRODUCTION = 0x4_05_C3_FF`** (defined in
  `calibrate-gates-production.ts`). DELIBERATELY distinct from the canned
  seed `0x4_05_C3` so the two artefact lineages cannot be accidentally
  swapped. **Do not reuse `0x4_05_C3` for production runs.**
- A second production-mode seed (for a SECOND independent batch confirming
  the first) is RESERVED but not allocated — file an issue when needed.

### AgentInvoker wiring
The production runner accepts an `AgentInvoker` interface (defined in
`packages/orchestration/src/production-dispatcher.ts`):

```ts
interface AgentInvoker {
  invokeSubagentBatch(reqs): Promise<responses>;
  invokeCortexRecall(req): Promise<{ results, total }>;
}
```

For the K=100 promotable batch, this MUST be wired to one of:

1. **Real-host invoker (preferred).** A new file
   `packages/ecosystem-adapters/src/clients/host-agent-invoker.ts` that
   delegates to the Claude Code Agent tool through the existing
   `HostQueueSubagentClient` queue. Concurrent-session ceiling: the
   user's Claude Max plan supports N concurrent agent sessions
   (verify N before committing to a full run; do not exceed it).

2. **High-fidelity stub.** `makeStubAgentInvoker` with:
   - `latencyMinMs: 500`, `latencyMaxMs: 2000` (per-call latency
     drawn uniformly from a realistic LLM-response window).
   - `warmCortexHitProbability: 0.7` (justify any change with measured
     production cortex hit rate, NOT a guess).
   - `rng: mulberry32(0x4_05_C3_FF)` (deterministic).

   A high-fidelity stub run is acceptable as a HEDGE and as a
   reproducibility anchor, but it is NOT a substitute for a real-host
   batch when the goal is gate promotion.

### Wall-clock duration estimate
- K=100 calibration runs + K=50 event-rate runs = 150 pipeline executions.
- Each execution averages ~64 iterations (per the canned baseline's
  iteration_count P95).
- Each iteration that triggers `spawn_subagents` is one LLM-class wait of
  500–2000ms in the stub mode (~1.25s mean).
- Subagent-bearing iterations per run: roughly 9 sections × 1 draft call
  + N judge dispatches; pessimistically ~15 LLM-class waits per run.
- Pessimistic total: 150 runs × 15 waits/run × 1.25s/wait ≈ **47 minutes**
  for the stub mode; multiply by 2–4 for real-host mode (queueing,
  serial sessions on a Max plan).
- Plan a session window of **2–4 hours** for the real-host batch.

### Outputs
- `data/gate-calibration-K100-production.json` (overwrites the pilot;
  canned baseline at `gate-calibration-K100.json` is NEVER touched).
- `data/event-rate-K50-production.json`
- `data/gate-calibration-K100-production.xmr/<gate>.production.json`
  (per-gate XmR records).

The production artefact carries `data_source: "production_pilot_K=N"` —
update the runner to emit `production_promoted_K=N` once the batch is
declared promotable (small string change; do NOT change the field name).

### Promotion criteria — when can the held gates flip?

For each of `wall_time_ms_max` and `cortex_recall_empty_count_max`:

`hold_provisional` flips from `true` to `false` if and only if:

1. The production-mode K=100 batch has been run (not a pilot K<30).
2. The `agent_invoker_class` field is `"host-real"` (or a documented
   high-fidelity stub run AS A HEDGE — flag this in the disposition).
3. The calibrated value's 95% Clopper-Pearson CI excludes the
   provisional value.
4. The relative divergence `|calibrated − provisional| / max(provisional, 1e-9)`
   is `≥ 0.05` (i.e., the §4.5 `passes_threshold` predicate is true).
5. For `wall_time_ms_max`: a per-machine-class breakdown is provided
   (`machine_class != null`), AND a non-canned calibration exists for at
   least one bucket (per the `WALL_TIME_MS_GATE_BY_CLASS` task in
   PHASE_4_PLAN.md §4.5).
6. For `cortex_recall_empty_count_max`: the cortex was demonstrably
   warm during the run — log evidence (cortex hit-rate) committed
   alongside the artefact.

If ALL six conditions hold, edit `gate-calibration-K100.json` (yes, the
canned file — that's the file the loader consumes) to set the gate's
`hold_provisional: false` and update its `calibrated` value to the
production-derived one. Add a commit note pointing to the production
artefact.

---

## Reproducibility check (mandatory before promotion)

Per the zetetic standard (Henderson et al. 2018; Dodge et al. 2019):
re-run the production batch from the committed sidecar (this runbook +
`gate-calibration-K100-production.json`) on a different machine or in a
different session. The K=100 distribution should overlap within
Clopper-Pearson 95% CI of the original. If not, INVESTIGATE BEFORE
PROMOTING — the gate is not yet stable.

---

## Cross-references

- Runner: `packages/benchmark/calibration/calibrate-gates-production.ts`
- Dispatcher: `packages/orchestration/src/production-dispatcher.ts`
- Async pipeline driver: `packages/benchmark/src/pipeline-kpis-async.ts`
- CLI: `pnpm calibrate:gates -- --mode=production` (default mode is `canned`)
- Canned-baseline runner (unchanged): `calibrate-gates.ts`
- Loader (unchanged; reads either file): `calibrated-gates-loader.ts`
- Plan: `docs/PHASE_4_PLAN.md` §4.5 (production-mode disposition)
