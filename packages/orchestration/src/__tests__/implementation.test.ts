/**
 * `implementation` — the engineer spawn (design-phases-3-5.md §3, §4, PR 4a).
 *
 * Proves:
 *   1. Nominal: emits ONE spawn_subagents (purpose "implement",
 *      subagent_type "engineer", isolation "worktree") with a prompt
 *      embedding the feature description, spec files, and blast-radius
 *      summary.
 *   2. A parsable report (BRANCH:/WORKTREE:/FILES: footer) is extracted into
 *      `post_specs.implementation` and advances to `post_impl_verification`.
 *   3. A report with no BRANCH:/WORKTREE: footer ABORTS to `finalize`
 *      (error_kind "structural") — nothing to verify without code.
 *   4. A subagent error (or empty/missing raw_text) ABORTS to `finalize`
 *      (error_kind "upstream_failure").
 *   5. Idempotency: a replay after `post_specs.implementation` is already
 *      set skips straight to `post_impl_verification` without re-spawning
 *      the engineer.
 *
 * source: design-phases-3-5.md §3, §4, §5 PR 4a.
 */

import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

/** Must match handlers/protocol-ids.ts:IMPLEMENTATION_INV_ID. */
const IMPLEMENTATION_INV_ID = "implementation_engineer";

function stateAtImplementation(opts: {
  alreadyImplemented?: boolean;
}): PipelineState {
  const s = newPipelineState({
    run_id: "impl_001",
    feature_description: "OAuth login",
    codebase_path: "/tmp/impl-fixture",
  });
  return {
    ...s,
    current_step: "implementation",
    // Set so a successfully-parsed report's advance to
    // post_impl_verification does not immediately coalesce past it (that
    // handler's own no-op guard requires a graph_path) — this lets the
    // "parsable report" tests below observe the substantive
    // call_pipeline_tool[index_codebase] action post_impl_verification
    // emits, rather than a chain all the way to finalize.
    codebase_graph_path: "/tmp/impl-fixture/graph",
    written_files: ["prd-output/x/overview.md", "prd-output/x/technical_specification.md"],
    // finalize's own precondition (pending_completion !== null) must hold on
    // every abort path this handler reaches — mirrors post-impl-verification
    // .test.ts's stateAtVerification / implementation-gate.test.ts's
    // stateAtGate fixtures.
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
    post_specs: {
      decision: "implement",
      impact_queries: {
        done: true,
        index: 1,
        results: [
          {
            qualified_name: "src/auth.ts::login",
            success: true,
            data: { callers: ["src/routes.ts::handleLogin"], importers: [], users: [], implementors: [] },
          },
        ],
      },
      implementation: opts.alreadyImplemented
        ? {
            branch: "feat/prior",
            worktree_path: "/tmp/prior-worktree",
            changed_files: ["src/prior.ts"],
            raw_report: "prior report",
          }
        : null,
      verification: null,
      testing: null,
      review: null,
      pr: null,
      retry_count: 0,
    },
  };
}

function nominalReport(): string {
  return [
    "Implemented OAuth login end to end.",
    "",
    "BRANCH: feat/oauth-login",
    "WORKTREE: /tmp/engineer-worktree",
    "SHA: abc123def456",
    "FILES:",
    "- src/auth.ts",
    "- src/routes.ts",
  ].join("\n");
}

describe("implementation — nominal spawn", () => {
  it("emits one spawn_subagents with purpose implement, subagent_type engineer, isolation worktree", () => {
    const out = step({ state: stateAtImplementation({}) });

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.purpose).toBe("implement");
    expect(out.action.invocations).toHaveLength(1);
    expect(out.action.invocations[0].invocation_id).toBe(IMPLEMENTATION_INV_ID);
    expect(out.action.invocations[0].subagent_type).toBe("engineer");
    expect(out.action.invocations[0].isolation).toBe("worktree");
    expect(out.action.invocations[0].prompt).toContain("OAuth login");
    expect(out.action.invocations[0].prompt).toContain(
      "prd-output/x/technical_specification.md",
    );
    expect(out.action.invocations[0].prompt).toContain("src/auth.ts::login");
    expect(out.state.current_step).toBe("implementation");
  });
});

describe("implementation — parsable report", () => {
  it("extracts branch/worktree_path/changed_files and advances to post_impl_verification", () => {
    const issued = step({ state: stateAtImplementation({}) });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: IMPLEMENTATION_INV_ID, raw_text: nominalReport() }],
      },
    });

    expect(out.state.current_step).toBe("post_impl_verification");
    expect(out.state.post_specs?.implementation).toEqual({
      branch: "feat/oauth-login",
      worktree_path: "/tmp/engineer-worktree",
      changed_files: ["src/auth.ts", "src/routes.ts"],
      raw_report: nominalReport(),
    });
    expect(out.state.errors.length).toBe(0);
    // Coalesced straight into post_impl_verification's first call
    // (index_codebase is substantive — proves the runner did not silently
    // skip past this step).
    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind === "call_pipeline_tool") {
      expect(out.action.tool_name).toBe("index_codebase");
    }
  });

  it("tolerates a report with no FILES: block — changed_files defaults to []", () => {
    const issued = step({ state: stateAtImplementation({}) });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";
    const report = "Done.\n\nBRANCH: feat/no-files\nWORKTREE: /tmp/wt-no-files\nSHA: deadbeef";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: IMPLEMENTATION_INV_ID, raw_text: report }],
      },
    });

    expect(out.state.current_step).toBe("post_impl_verification");
    expect(out.state.post_specs?.implementation?.branch).toBe("feat/no-files");
    expect(out.state.post_specs?.implementation?.worktree_path).toBe("/tmp/wt-no-files");
    expect(out.state.post_specs?.implementation?.changed_files).toEqual([]);
  });
});

describe("implementation — unparsable report aborts to finalize (structural)", () => {
  it("a report with no BRANCH:/WORKTREE: footer aborts, records a structural error, never sets post_specs.implementation", () => {
    const issued = step({ state: stateAtImplementation({}) });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          {
            invocation_id: IMPLEMENTATION_INV_ID,
            raw_text: "I implemented the feature but forgot to report the required footer.",
          },
        ],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.implementation).toBeNull();
    expect(
      out.state.errors.some((e) => e.includes("did not include a parsable")),
    ).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("structural");
    expect(out.action.kind).not.toBe("failed");
  });
});

describe("implementation — subagent error/empty aborts to finalize (upstream_failure)", () => {
  it("an explicit subagent error aborts and records upstream_failure", () => {
    const issued = step({ state: stateAtImplementation({}) });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: IMPLEMENTATION_INV_ID, error: "subagent crashed" }],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.implementation).toBeNull();
    expect(out.state.errors.some((e) => e.includes("subagent crashed"))).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("upstream_failure");
    expect(out.action.kind).not.toBe("failed");
  });

  it("an empty/missing raw_text response aborts and records upstream_failure", () => {
    const issued = step({ state: stateAtImplementation({}) });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: IMPLEMENTATION_INV_ID, raw_text: "" }],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.implementation).toBeNull();
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("upstream_failure");
  });
});

describe("implementation — idempotency", () => {
  it("a replay after post_specs.implementation is already set skips straight to post_impl_verification without re-spawning", () => {
    const out = step({ state: stateAtImplementation({ alreadyImplemented: true }) });

    expect(out.action.kind).not.toBe("spawn_subagents");
    expect(out.state.current_step).toBe("post_impl_verification");
    expect(out.state.post_specs?.implementation?.branch).toBe("feat/prior");
  });

  it("result-processing is evaluated before the idempotency guard: a replayed subagent_batch_result is still consumed", () => {
    // Regression test for the Phase 2 git-historian loop-ordering bug: even
    // if post_specs.implementation were already set, an incoming result for
    // THIS batch must still be processed rather than silently ignored.
    const already = stateAtImplementation({ alreadyImplemented: true });
    const out = step({
      state: already,
      result: {
        kind: "subagent_batch_result",
        batch_id: IMPLEMENTATION_INV_ID,
        responses: [{ invocation_id: IMPLEMENTATION_INV_ID, raw_text: nominalReport() }],
      },
    });

    // The freshly-processed result overwrites the prior implementation
    // record — proving the result branch (not the idempotency branch) ran.
    expect(out.state.post_specs?.implementation?.branch).toBe("feat/oauth-login");
    expect(out.state.current_step).toBe("post_impl_verification");
  });
});
