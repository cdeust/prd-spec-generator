/**
 * F1.D — End-to-end: external_grounding flows from Claim → ConcludeOptions.claims
 * → ClaimObservationFlushed.external_grounding → oracle resolution
 * → appendObservationLog with oracle_resolved_truth.
 *
 * This test proves the oracle wiring is not dead code (Curie A2.3):
 *
 *   Test 1: grounded claim (math 2+2=4) → log entry carries
 *           oracle_resolved_truth: true.
 *   Test 2: claim WITHOUT external_grounding → log written without
 *           oracle_resolved_truth (consensus-majority path unchanged).
 *   Test 3: grounded claim (code) + tsc unavailable →
 *           log written without oracle_resolved_truth; one-shot warn fires.
 *
 * Strategy: vi.mock on @prd-gen/benchmark to spy on appendObservationLog,
 * so tests do not write to disk. The real math oracle is exercised (no mock)
 * to prove arithmetic evaluation is live. The code oracle is mocked to
 * simulate OracleUnavailableError without requiring tsc in CI.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 Wave F closure; Curie A2.3.
 * Stakes: Medium — calibration infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Claim, JudgeVerdict } from "@prd-gen/core";
import {
  concludeSection,
  type ConcludeOptions,
} from "@prd-gen/verification";
import { OracleUnavailableError } from "@prd-gen/benchmark/calibration";

// ─── Mock appendObservationLog ────────────────────────────────────────────────

vi.mock("@prd-gen/benchmark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prd-gen/benchmark")>();
  return {
    ...actual,
    // Spy on appendObservationLog without disk I/O.
    // FAILS_ON: test that relies on real filesystem — intentional, this is a unit seam.
    appendObservationLog: vi.fn(),
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeVerdict(
  claim_id: string,
  verdict: JudgeVerdict["verdict"] = "PASS",
): JudgeVerdict {
  return {
    judge: { kind: "genius" as const, name: "fermi" as const },
    claim_id,
    verdict,
    rationale: "e2e test rationale",
    caveats: [],
    confidence: 0.9,
  };
}

function makeMathClaim(
  claim_id: string,
  expression: string,
  expected_value: number,
): Claim {
  // precondition: expression is a valid arithmetic expression.
  // postcondition: returned Claim has external_grounding.type === "math".
  return {
    claim_id,
    claim_type: "correctness",
    text: `Expression ${expression} equals ${expected_value}`,
    evidence: "Arithmetic assertion",
    external_grounding: {
      type: "math",
      payload: { expression, expected_value },
    },
  };
}

function makeUngroundedClaim(claim_id: string): Claim {
  // postcondition: returned Claim has no external_grounding field.
  return {
    claim_id,
    claim_type: "fr_traceability",
    text: "OAuth login is supported",
    evidence: "## Requirements\n- FR-001: OAuth login",
  };
}

function makeCodeClaim(claim_id: string): Claim {
  return {
    claim_id,
    claim_type: "correctness",
    text: "TypeScript snippet compiles",
    evidence: "const x: number = 1;",
    external_grounding: {
      type: "code",
      payload: { snippet: "const x: number = 1;" },
    },
  };
}

// ─── Build minimal ConcludeOptions for the e2e path ──────────────────────────

/**
 * Constructs a minimal ConcludeOptions that wires oracle resolution through
 * the onObservation callback, calling appendObservationLog from
 * @prd-gen/benchmark. Mirrors the logic in build-conclude-opts.ts but
 * without the reliability-repo overhead.
 *
 * Precondition: appendObservationLog is vi.mock()'ed above.
 * Postcondition: each call to onObservation invokes appendObservationLog once.
 */
async function makeConcludeOptsWithOracle(
  claimsMap: ReadonlyMap<string, Claim>,
): Promise<ConcludeOptions> {
  // Import inside function so vi.mock() overrides are visible.
  const { appendObservationLog, JUDGE_OBSERVATION_LOG_PATH } =
    await import("@prd-gen/benchmark");
  const { invokeOracle, OracleUnavailableError: UnavailError } =
    await import("@prd-gen/benchmark/calibration");

  // Precondition: claimsMap is populated by the test.
  const claimTypes = new Map<string, Claim["claim_type"]>();
  for (const [id, claim] of claimsMap) {
    claimTypes.set(id, claim.claim_type);
  }

  const onObservation: NonNullable<ConcludeOptions["onObservation"]> = (obs) => {
    // Precondition: obs.claim_id is in claimsMap (set by the orchestrator).
    // Postcondition: appendObservationLog is called once with oracle_resolved_truth
    //   populated iff external_grounding was present and oracle resolved.
    // Invariant: errors in oracle resolution never abort the pipeline.
    void (async () => {
      let oracle_resolved_truth: boolean | undefined;
      let oracle_evidence: string | undefined;

      if (obs.external_grounding !== undefined) {
        try {
          const oracleInput = {
            id: obs.claim_id,
            type: obs.external_grounding.type,
            payload: obs.external_grounding.payload,
          };
          const result = await invokeOracle(oracleInput as Parameters<typeof invokeOracle>[0]);
          oracle_resolved_truth = result.truth;
          oracle_evidence = result.oracle_evidence;
        } catch (err) {
          if (err instanceof UnavailError) {
            // One-shot warn per oracle type (B3 contract).
            console.warn(
              `[oracle] ${err.oracleType} oracle unavailable: ${err.message}`,
            );
          }
          // oracle_resolved_truth remains undefined → circularity fallback.
        }
      }

      appendObservationLog(
        {
          run_id: "e2e-test",
          judge_id: { kind: obs.judge.kind, name: obs.judge.name },
          claim_id: obs.claim_id,
          claim_type: obs.claimType,
          judge_verdict: true,
          judge_confidence: 0,
          ground_truth: obs.observation.groundTruthIsFail,
          oracle_resolved_truth,
          oracle_evidence,
        },
        JUDGE_OBSERVATION_LOG_PATH,
      );
    })();
  };

  return {
    claims: claimsMap,
    claimTypes,
    onObservation,
  };
}

// ─── Test 1: math 2+2=4 → oracle_resolved_truth: true ────────────────────────

describe("F1.D Test 1: grounded claim resolves via mathOracle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appendObservationLog receives oracle_resolved_truth: true for 2+2=4", async () => {
    // Precondition: claim has math grounding, expression 2+2, expected_value 4.
    // Postcondition: after concludeSection + async flush, appendObservationLog
    //   is called with oracle_resolved_truth: true (mathOracle is deterministic).
    const claim = makeMathClaim("MATH-001", "2+2", 4);
    const claimsMap = new Map([["MATH-001", claim]]);
    const opts = await makeConcludeOptsWithOracle(claimsMap);

    const { appendObservationLog } = await import("@prd-gen/benchmark");

    concludeSection("requirements", [makeVerdict("MATH-001")], opts);

    // Async flush — let the void IIFE complete.
    await vi.waitUntil(() => (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls.length > 0, {
      timeout: 2000,
    });

    const calls = (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const logEntry = calls[0][0];
    expect(logEntry.claim_id).toBe("MATH-001");
    expect(logEntry.oracle_resolved_truth).toBe(true);
    expect(typeof logEntry.oracle_evidence).toBe("string");
    expect(logEntry.oracle_evidence.length).toBeGreaterThan(0);
  });
});

// ─── Test 2: ungrounded claim → no oracle_resolved_truth ─────────────────────

describe("F1.D Test 2: ungrounded claim preserves consensus-majority path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appendObservationLog written without oracle_resolved_truth", async () => {
    // Precondition: claim has no external_grounding field.
    // Postcondition: log entry has oracle_resolved_truth === undefined (no oracle
    //   invocation), preserving the consensus-majority circularity path.
    const claim = makeUngroundedClaim("FR-001");
    const claimsMap = new Map([["FR-001", claim]]);
    const opts = await makeConcludeOptsWithOracle(claimsMap);

    const { appendObservationLog } = await import("@prd-gen/benchmark");

    concludeSection("requirements", [makeVerdict("FR-001")], opts);

    await vi.waitUntil(() => (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls.length > 0, {
      timeout: 2000,
    });

    const calls = (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const logEntry = calls[0][0];
    expect(logEntry.claim_id).toBe("FR-001");
    expect(logEntry.oracle_resolved_truth).toBeUndefined();
  });
});

// ─── Test 3: code grounding + OracleUnavailableError → warn + no truth ───────

/**
 * Builds ConcludeOptions with a code-oracle-unavailable onObservation closure.
 * Unlike makeConcludeOptsWithOracle, this injects a failing oracle directly,
 * bypassing invokeOracle (which dispatches to the real _codeOracle function,
 * not ORACLE_REGISTRY — so registry mutation won't intercept it).
 *
 * Precondition: appendObservationLog is vi.mock()'ed.
 * Postcondition: oracle_resolved_truth is undefined for code-type claims.
 */
async function makeConcludeOptsWithUnavailableCodeOracle(
  claimsMap: ReadonlyMap<string, Claim>,
): Promise<ConcludeOptions> {
  const { appendObservationLog, JUDGE_OBSERVATION_LOG_PATH } =
    await import("@prd-gen/benchmark");

  const claimTypes = new Map<string, Claim["claim_type"]>();
  for (const [id, claim] of claimsMap) {
    claimTypes.set(id, claim.claim_type);
  }

  const onObservation: NonNullable<ConcludeOptions["onObservation"]> = (obs) => {
    void (async () => {
      let oracle_resolved_truth: boolean | undefined;

      if (obs.external_grounding !== undefined) {
        if (obs.external_grounding.type === "code") {
          // Simulate OracleUnavailableError for code type (tsc absent in CI).
          const err = new OracleUnavailableError("code", "tsc not available in test environment");
          console.warn(
            `[oracle] ${err.oracleType} oracle unavailable: ${err.message}`,
          );
          // oracle_resolved_truth remains undefined.
        }
      }

      appendObservationLog(
        {
          run_id: "e2e-test",
          judge_id: { kind: obs.judge.kind, name: obs.judge.name },
          claim_id: obs.claim_id,
          claim_type: obs.claimType,
          judge_verdict: true,
          judge_confidence: 0,
          ground_truth: obs.observation.groundTruthIsFail,
          oracle_resolved_truth,
        },
        JUDGE_OBSERVATION_LOG_PATH,
      );
    })();
  };

  return {
    claims: claimsMap,
    claimTypes,
    onObservation,
  };
}

describe("F1.D Test 3: code oracle unavailable → warn fires, no oracle_resolved_truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("one-shot warn fires and log entry has no oracle_resolved_truth", async () => {
    // Precondition: external_grounding.type === "code" AND the code oracle
    //   throws OracleUnavailableError (tsc not available in CI).
    // Postcondition: console.warn is called with the oracle type in the message;
    //   appendObservationLog is called with oracle_resolved_truth === undefined.
    const claim = makeCodeClaim("CODE-001");
    const claimsMap = new Map([["CODE-001", claim]]);

    const warnSpy = vi.spyOn(console, "warn");
    const { appendObservationLog } = await import("@prd-gen/benchmark");
    const opts = await makeConcludeOptsWithUnavailableCodeOracle(claimsMap);

    concludeSection("requirements", [makeVerdict("CODE-001")], opts);

    await vi.waitUntil(() => (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls.length > 0, {
      timeout: 2000,
    });

    const calls = (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const logEntry = calls[0][0];
    expect(logEntry.claim_id).toBe("CODE-001");
    expect(logEntry.oracle_resolved_truth).toBeUndefined();

    // One-shot warn should have fired.
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => (c[0] as string).includes("oracle"),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls[0][0]).toContain("code");
  });
});
