/**
 * `testing` + `review` — the bounded review loop (design-phases-3-5.md §3,
 * §4, §6, PR 4b).
 *
 * Proves:
 *   1. `testing` nominal: one spawn_subagents (purpose "test", subagent_type
 *      "test-engineer", isolation "none", SAME worktree/branch as
 *      `implementation`); a successful report is stored and advances to
 *      `review`.
 *   2. `testing` failure → finding, not abort: a test-engineer subagent
 *      error DEGRADES (upstream_failure recorded, a failure marker stored
 *      in `testing.raw_report`) and STILL advances to `review`.
 *   3. `testing` idempotency: a replay after `testing` is recorded skips
 *      straight to `review` without re-spawning.
 *   4. `review` PASS direct: one spawn_subagents (purpose "review",
 *      subagent_type "code-reviewer"); a PASS verdict advances to
 *      `finalize`.
 *   5. `review` FAIL → retry → PASS: a FAIL verdict retries `implementation`
 *      on the SAME worktree/branch with findings injected into the prompt,
 *      resetting `verification`/`testing` to null; the retried
 *      implementation's success re-runs post_impl_verification → testing →
 *      review, which now PASSes and reaches `finalize`.
 *   6. `review` FAIL×(cap) → advisory → `finalize`: after `REVIEW_RETRY_CAP`
 *      retries are exhausted, the loop degrades to an advisory FAIL verdict
 *      (visible in `post_specs.review`) and reaches `finalize` — never a
 *      hard abort.
 *   7. Explicit loop-guard regression test (Phase 2 git-historian lesson,
 *      restated in design §3): a full traversal with a reviewer that always
 *      FAILs terminates within a bounded number of `step()` calls — it does
 *      NOT infinite-loop.
 *   8. `review` idempotency: a replay after `review` has PASSed skips
 *      straight to `finalize` without re-spawning the reviewer.
 *
 * source: design-phases-3-5.md §3, §4, §6, PR 4b.
 */

import { describe, expect, it } from "vitest";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "../index.js";

/** Must match handlers/protocol-ids.ts. */
const TESTING_INV_ID = "testing_test_engineer";
const REVIEW_INV_PREFIX = "review_code_reviewer_";
const IMPLEMENTATION_INV_ID = "implementation_engineer";
const REVIEW_RETRY_CAP = 3;

function basePostSpecs() {
  return {
    decision: "implement" as const,
    impact_queries: { done: true, index: 0, results: [] },
    implementation: {
      branch: "feat/oauth",
      worktree_path: "/tmp/engineer-worktree",
      changed_files: ["src/auth.ts"],
      raw_report: "Implemented OAuth login.",
    },
    verification: {
      step: "done" as const,
      after_graph_path: "/g/after",
      changed_symbols: ["src/auth.ts::login"],
      detect_changes: null,
      verify_semantic_diff: null,
      check_security_gates: null,
      gates_passed: true,
    },
    testing: null,
    review: null,
    pr: null,
    retry_count: 0,
  };
}

function stateAtTesting(opts: { testingAlreadyRecorded?: boolean } = {}): PipelineState {
  const s = newPipelineState({
    run_id: "loop_001",
    feature_description: "OAuth login",
    codebase_path: "/tmp/loop-fixture",
  });
  const postSpecs = basePostSpecs();
  return {
    ...s,
    current_step: "testing",
    written_files: ["prd-output/x/technical_specification.md"],
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
    post_specs: {
      ...postSpecs,
      testing: opts.testingAlreadyRecorded ? { raw_report: "prior testing report" } : null,
    },
  };
}

function stateAtReview(opts: { retry_count?: number; reviewFailVerdict?: boolean } = {}): PipelineState {
  const s = newPipelineState({
    run_id: "loop_002",
    feature_description: "OAuth login",
    codebase_path: "/tmp/loop-fixture",
  });
  const postSpecs = basePostSpecs();
  return {
    ...s,
    current_step: "review",
    codebase_graph_path: "/g/before",
    written_files: ["prd-output/x/technical_specification.md"],
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
    post_specs: {
      ...postSpecs,
      testing: { raw_report: "All tests pass." },
      retry_count: opts.retry_count ?? 0,
      review: opts.reviewFailVerdict
        ? { verdict: "fail", findings: ["fix the thing"], attempt: 1 }
        : null,
    },
  };
}

// ─── testing ────────────────────────────────────────────────────────────────

describe("testing — nominal spawn", () => {
  it("emits one spawn_subagents (purpose test, subagent_type test-engineer, isolation none) on the SAME worktree", () => {
    const out = step({ state: stateAtTesting() });

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.purpose).toBe("test");
    expect(out.action.invocations).toHaveLength(1);
    expect(out.action.invocations[0].invocation_id).toBe(TESTING_INV_ID);
    expect(out.action.invocations[0].subagent_type).toBe("test-engineer");
    expect(out.action.invocations[0].isolation).toBe("none");
    expect(out.action.invocations[0].prompt).toContain("/tmp/engineer-worktree");
    expect(out.action.invocations[0].prompt).toContain("feat/oauth");
  });

  it("a successful report is stored and advances to review", () => {
    const issued = step({ state: stateAtTesting() });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: TESTING_INV_ID, raw_text: "Ran the suite. All green." }],
      },
    });

    expect(out.state.current_step).toBe("review");
    expect(out.state.post_specs?.testing?.raw_report).toBe("Ran the suite. All green.");
    expect(out.state.errors.length).toBe(0);
    expect(out.action.kind).toBe("spawn_subagents");
  });
});

describe("testing — failure degrades to a finding, not an abort", () => {
  it("a subagent error records upstream_failure and STILL advances to review with a failure marker", () => {
    const issued = step({ state: stateAtTesting() });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: TESTING_INV_ID, error: "sandbox crashed" }],
      },
    });

    expect(out.state.current_step).toBe("review");
    expect(out.state.post_specs?.testing?.raw_report).toContain("TEST-ENGINEER FAILURE");
    expect(out.state.errors.some((e) => e.includes("testing subagent failed"))).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("upstream_failure");
    expect(out.action.kind).not.toBe("failed");
  });
});

describe("testing — idempotency", () => {
  it("a replay after testing is already recorded skips to review without re-spawning the test-engineer", () => {
    const out = step({ state: stateAtTesting({ testingAlreadyRecorded: true }) });

    // Coalesces straight into review's own spawn (substantive) — the proof
    // this test cares about is that testing itself did NOT re-spawn (no
    // "test"-purpose batch was issued), not that the overall action is a
    // non-spawn kind.
    expect(out.state.current_step).toBe("review");
    expect(out.state.post_specs?.testing?.raw_report).toBe("prior testing report");
    if (out.action.kind === "spawn_subagents") {
      expect(out.action.purpose).not.toBe("test");
    }
  });
});

// ─── review ─────────────────────────────────────────────────────────────────

function reviewReport(verdict: "PASS" | "FAIL", findings: string[] = []): string {
  if (verdict === "PASS") {
    return "Looks good.\n\nVERDICT: PASS";
  }
  return [
    "Needs work.",
    "",
    "VERDICT: FAIL",
    "FINDINGS:",
    ...findings.map((f) => `- ${f}`),
  ].join("\n");
}

describe("review — PASS direct", () => {
  it("emits one spawn_subagents (purpose review, subagent_type code-reviewer), PASS advances to finalize", () => {
    const issued = step({ state: stateAtReview() });
    expect(issued.action.kind).toBe("spawn_subagents");
    if (issued.action.kind !== "spawn_subagents") return;
    expect(issued.action.purpose).toBe("review");
    expect(issued.action.invocations[0].subagent_type).toBe("code-reviewer");
    expect(issued.action.invocations[0].invocation_id).toBe(`${REVIEW_INV_PREFIX}1`);
    const batch_id = issued.action.batch_id;

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: `${REVIEW_INV_PREFIX}1`, raw_text: reviewReport("PASS") }],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.review).toEqual({ verdict: "pass", findings: [], attempt: 1 });
  });
});

describe("review — FAIL retries implementation on the SAME worktree", () => {
  it("a FAIL verdict increments retry_count, resets verification/testing, and re-transitions to implementation with findings", () => {
    const issued = step({ state: stateAtReview() });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          {
            invocation_id: `${REVIEW_INV_PREFIX}1`,
            raw_text: reviewReport("FAIL", ["missing error handling on login"]),
          },
        ],
      },
    });

    expect(out.state.post_specs?.retry_count).toBe(1);
    expect(out.state.post_specs?.review?.verdict).toBe("fail");
    expect(out.state.post_specs?.review?.findings).toEqual(["missing error handling on login"]);
    expect(out.state.post_specs?.verification).toBeNull();
    expect(out.state.post_specs?.testing).toBeNull();
    // implementation is preserved (worktree/branch continuity for the retry prompt).
    expect(out.state.post_specs?.implementation?.worktree_path).toBe("/tmp/engineer-worktree");
    expect(out.state.current_step).toBe("implementation");
    // Coalesced straight into implementation's re-spawn (substantive action).
    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.purpose).toBe("implement");
    expect(out.action.invocations[0].prompt).toContain("missing error handling on login");
    expect(out.action.invocations[0].prompt).toContain("Continue on your EXISTING worktree");
    expect(out.action.invocations[0].prompt).toContain("/tmp/engineer-worktree");
  });

  it("full loop: FAIL → retry implementation → PASS reaches finalize", () => {
    // 1. Review FAILs.
    const issuedReview = step({ state: stateAtReview() });
    const reviewBatch1 = issuedReview.action.kind === "spawn_subagents" ? issuedReview.action.batch_id : "";
    const afterFail = step({
      state: issuedReview.state,
      result: {
        kind: "subagent_batch_result",
        batch_id: reviewBatch1,
        responses: [
          { invocation_id: `${REVIEW_INV_PREFIX}1`, raw_text: reviewReport("FAIL", ["fix X"]) },
        ],
      },
    });
    expect(afterFail.state.current_step).toBe("implementation");
    expect(afterFail.action.kind).toBe("spawn_subagents");
    if (afterFail.action.kind !== "spawn_subagents") return;

    // 2. Retried implementation succeeds (SAME worktree/branch in the report).
    const afterImpl = step({
      state: afterFail.state,
      result: {
        kind: "subagent_batch_result",
        batch_id: afterFail.action.batch_id,
        responses: [
          {
            invocation_id: IMPLEMENTATION_INV_ID,
            raw_text: [
              "Fixed the issue.",
              "",
              "BRANCH: feat/oauth",
              "WORKTREE: /tmp/engineer-worktree",
              "SHA: def456",
            ].join("\n"),
          },
        ],
      },
    });
    // review is reset to null on a successful (re-)implementation.
    expect(afterImpl.state.post_specs?.review).toBeNull();
    expect(afterImpl.state.current_step).toBe("post_impl_verification");
    expect(afterImpl.action.kind).toBe("call_pipeline_tool");

    // 3. Drive post_impl_verification's 4-call sequence to completion.
    let state = afterImpl.state;
    let action: NextAction = afterImpl.action;
    const CIDS = [
      "post_impl_verification_index_codebase",
      "post_impl_verification_detect_changes",
      "post_impl_verification_verify_semantic_diff",
      "post_impl_verification_check_security_gates",
    ];
    for (const cid of CIDS) {
      if (action.kind !== "call_pipeline_tool") throw new Error(`expected call_pipeline_tool for ${cid}`);
      const data =
        cid === "post_impl_verification_index_codebase"
          ? { graph_path: "/g/after2" }
          : cid === "post_impl_verification_check_security_gates"
            ? { gates_passed: true }
            : {};
      const res = step({
        state,
        result: { kind: "tool_result", correlation_id: cid, success: true, data },
      });
      state = res.state;
      action = res.action;
    }
    // Coalesced into testing's spawn.
    expect(state.current_step).toBe("testing");
    expect(action.kind).toBe("spawn_subagents");
    if (action.kind !== "spawn_subagents") return;

    // 4. Testing succeeds.
    const afterTesting = step({
      state,
      result: {
        kind: "subagent_batch_result",
        batch_id: action.batch_id,
        responses: [{ invocation_id: TESTING_INV_ID, raw_text: "All tests pass now." }],
      },
    });
    expect(afterTesting.state.current_step).toBe("review");
    expect(afterTesting.action.kind).toBe("spawn_subagents");
    if (afterTesting.action.kind !== "spawn_subagents") return;
    // Second review attempt — attempt-indexed invocation_id must be "_2".
    expect(afterTesting.action.invocations[0].invocation_id).toBe(`${REVIEW_INV_PREFIX}2`);

    // 5. Review PASSes this time.
    const afterPass = step({
      state: afterTesting.state,
      result: {
        kind: "subagent_batch_result",
        batch_id: afterTesting.action.batch_id,
        responses: [
          { invocation_id: `${REVIEW_INV_PREFIX}2`, raw_text: reviewReport("PASS") },
        ],
      },
    });
    expect(afterPass.state.current_step).toBe("finalize");
    expect(afterPass.state.post_specs?.review?.verdict).toBe("pass");
    expect(afterPass.state.post_specs?.retry_count).toBe(1);
  });
});

describe("review — FAIL×(cap) degrades to advisory, reaches finalize (never a hard abort)", () => {
  it(`after ${REVIEW_RETRY_CAP} retries, a further FAIL degrades to advisory and advances to finalize`, () => {
    // Simulate the state right after the CAP'th retry has already been spent
    // (retry_count === REVIEW_RETRY_CAP) and this review attempt ALSO fails.
    const state = stateAtReview({ retry_count: REVIEW_RETRY_CAP });
    const issued = step({ state });
    const attempt = REVIEW_RETRY_CAP + 1;
    expect(issued.action.kind).toBe("spawn_subagents");
    if (issued.action.kind !== "spawn_subagents") return;
    expect(issued.action.invocations[0].invocation_id).toBe(`${REVIEW_INV_PREFIX}${attempt}`);

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id: issued.action.batch_id,
        responses: [
          {
            invocation_id: `${REVIEW_INV_PREFIX}${attempt}`,
            raw_text: reviewReport("FAIL", ["still broken"]),
          },
        ],
      },
    });

    // Cap exhausted: does NOT retry implementation again.
    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.review?.verdict).toBe("fail");
    expect(out.state.post_specs?.review?.findings).toEqual(["still broken"]);
    // retry_count is NOT incremented past the cap on the advisory-degrade path.
    expect(out.state.post_specs?.retry_count).toBe(REVIEW_RETRY_CAP);
    expect(out.action.kind).not.toBe("failed");
  });

  it("a reviewer subagent error also degrades to advisory after the cap (not a retry-implementation)", () => {
    const state = stateAtReview({ retry_count: REVIEW_RETRY_CAP });
    const issued = step({ state });
    const attempt = REVIEW_RETRY_CAP + 1;
    if (issued.action.kind !== "spawn_subagents") throw new Error("expected spawn");

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id: issued.action.batch_id,
        responses: [{ invocation_id: `${REVIEW_INV_PREFIX}${attempt}`, error: "reviewer crashed" }],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.review?.verdict).toBe("fail");
    expect(out.action.kind).not.toBe("failed");
  });
});

describe("review — loop-guard regression test (Phase 2 git-historian lesson)", () => {
  it("a reviewer that ALWAYS FAILs terminates within a bounded number of step() calls, never infinite-loops", () => {
    const SAFETY_CAP = 200;
    const dispatch = makeCannedDispatcher({
      implementation_gate_answer: "Implement",
      review_verdict_for_attempt: () => "fail",
    });
    const seed = newPipelineState({
      run_id: "loop_guard_always_fail",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/loop-guard-fail",
    });

    let state: PipelineState = seed;
    let pendingResult: ActionResult | undefined = undefined;
    let iterations = 0;

    for (let i = 0; i < SAFETY_CAP; i++) {
      iterations = i + 1;
      const out = step({ state, result: pendingResult });
      state = out.state;
      if (out.action.kind === "done" || out.action.kind === "failed") {
        expect(out.action.kind).toBe("done");
        break;
      }
      pendingResult = dispatch(out.action);
      if (pendingResult === undefined) {
        throw new Error(`no canned result for action.kind=${out.action.kind}`);
      }
    }

    expect(iterations).toBeLessThan(SAFETY_CAP);
    expect(state.current_step).toBe("complete");
    expect(state.post_specs?.review?.verdict).toBe("fail");
    expect(state.post_specs?.retry_count).toBe(REVIEW_RETRY_CAP);
  });
});

describe("review — idempotency", () => {
  it("a replay after review has PASSed skips straight to finalize without re-spawning the reviewer", () => {
    const s = newPipelineState({
      run_id: "loop_003",
      feature_description: "OAuth login",
      codebase_path: "/tmp/loop-fixture",
    });
    const postSpecs = basePostSpecs();
    const state: PipelineState = {
      ...s,
      current_step: "review",
      pending_completion: {
        summary: "Self-check complete. 3/3 sections passed.",
        artifacts: ["overview: passed"],
      },
      post_specs: {
        ...postSpecs,
        testing: { raw_report: "All tests pass." },
        review: { verdict: "pass", findings: [], attempt: 1 },
      },
    };

    const out = step({ state });

    expect(out.action.kind).not.toBe("spawn_subagents");
    expect(out.state.current_step).toBe("finalize");
  });
});
