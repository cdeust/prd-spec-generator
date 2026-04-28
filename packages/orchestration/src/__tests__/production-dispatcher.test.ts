/**
 * Tests for the production-mode dispatcher (Wave F2 sub-stream).
 *
 * Coverage:
 *  - F2.E.1: makeProductionDispatcher rejects null AgentInvoker.
 *  - F2.E.2: spawn_subagents is delegated to AgentInvoker.invokeSubagentBatch
 *            and the dispatcher echoes back invocation_ids.
 *  - F2.E.3: call_cortex_tool with tool_name="recall" delegates to
 *            invokeCortexRecall and threads results onto a tool_result.
 *  - F2.E.4: non-LLM action kinds (ask_user, write_file) reuse the canned
 *            implementation and don't touch the invoker.
 *  - F2.E.5: terminal actions (done/failed) return undefined.
 *  - F2.E.6: stub invoker simulates latency via sleep injection (deterministic).
 *  - F2.E.7: stub invoker warm-cortex behaviour controlled by hit probability.
 */

import { describe, it, expect, vi } from "vitest";
import {
  makeProductionDispatcher,
  makeStubAgentInvoker,
  type AgentInvoker,
  type AgentInvocationRequest,
} from "../production-dispatcher.js";
import type { NextAction } from "../types/actions.js";

function spyInvoker(): {
  invoker: AgentInvoker;
  subagentCalls: AgentInvocationRequest[][];
  cortexCalls: { correlation_id: string; query: string }[];
} {
  const subagentCalls: AgentInvocationRequest[][] = [];
  const cortexCalls: { correlation_id: string; query: string }[] = [];
  const invoker: AgentInvoker = {
    async invokeSubagentBatch(reqs) {
      subagentCalls.push([...reqs]);
      return reqs.map((r) => ({
        invocation_id: r.invocation_id,
        raw_text: `spy-response:${r.invocation_id}`,
      }));
    },
    async invokeCortexRecall(req) {
      cortexCalls.push({
        correlation_id: req.correlation_id,
        query: req.query,
      });
      return { results: [], total: 0 };
    },
  };
  return { invoker, subagentCalls, cortexCalls };
}

describe("makeProductionDispatcher — F2.E.1 invariants", () => {
  it("throws when agentInvoker is null", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeProductionDispatcher({ agentInvoker: null as any }),
    ).toThrow(/agentInvoker is required/);
  });
});

describe("makeProductionDispatcher — F2.E.2 spawn_subagents delegation", () => {
  it("invokes invokeSubagentBatch and echoes back invocation_ids", async () => {
    const { invoker, subagentCalls } = spyInvoker();
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "spawn_subagents",
      batch_id: "b1",
      purpose: "judge",
      invocations: [
        {
          invocation_id: "inv-1",
          subagent_type: "engineer",
          description: "do x",
          prompt: "p1",
          isolation: "none",
        },
        {
          invocation_id: "inv-2",
          subagent_type: "engineer",
          description: "do y",
          prompt: "p2",
          isolation: "none",
        },
      ],
    };
    const result = await dispatch(action);
    expect(result?.kind).toBe("subagent_batch_result");
    if (result?.kind !== "subagent_batch_result") return;
    expect(result.batch_id).toBe("b1");
    expect(result.responses).toHaveLength(2);
    expect(result.responses.map((r) => r.invocation_id)).toEqual([
      "inv-1",
      "inv-2",
    ]);
    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls[0].map((r) => r.subagent_type)).toEqual([
      "engineer",
      "engineer",
    ]);
    expect(subagentCalls[0].every((r) => r.purpose === "judge")).toBe(true);
  });
});

describe("makeProductionDispatcher — F2.E.3 cortex recall delegation", () => {
  it("threads recall results onto a tool_result on success", async () => {
    const invoker: AgentInvoker = {
      async invokeSubagentBatch() {
        return [];
      },
      async invokeCortexRecall() {
        return {
          results: [{ content: "hit-A", score: 0.9 }],
          total: 1,
        };
      },
    };
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "call_cortex_tool",
      tool_name: "recall",
      arguments: { query: "what was tried before for OAuth?" },
      correlation_id: "c-1",
    };
    const result = await dispatch(action);
    expect(result?.kind).toBe("tool_result");
    if (result?.kind !== "tool_result") return;
    expect(result.correlation_id).toBe("c-1");
    expect(result.success).toBe(true);
    const data = result.data as { results: unknown[]; total: number };
    expect(data.total).toBe(1);
    expect(data.results).toHaveLength(1);
  });

  it("falls back to canned dispatcher for non-recall cortex tools", async () => {
    const { invoker, cortexCalls } = spyInvoker();
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "call_cortex_tool",
      tool_name: "remember",
      arguments: { content: "x" },
      correlation_id: "c-2",
    };
    const result = await dispatch(action);
    expect(result?.kind).toBe("tool_result");
    expect(cortexCalls).toHaveLength(0); // recall NOT consulted
  });
});

describe("makeProductionDispatcher — F2.E.4 non-LLM fallback", () => {
  it("ask_user uses canned dispatcher (no invoker call)", async () => {
    const { invoker, subagentCalls } = spyInvoker();
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "ask_user",
      question_id: "q-1",
      header: "Pick one",
      description: "Test prompt body",
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
      multi_select: false,
    };
    const result = await dispatch(action);
    expect(result?.kind).toBe("user_answer");
    expect(subagentCalls).toHaveLength(0);
  });

  it("write_file uses canned dispatcher", async () => {
    const { invoker, subagentCalls } = spyInvoker();
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "write_file",
      path: "/tmp/foo.md",
      content: "hello",
    };
    const result = await dispatch(action);
    expect(result?.kind).toBe("file_written");
    expect(subagentCalls).toHaveLength(0);
  });
});

describe("makeProductionDispatcher — F2.E.5 terminal actions", () => {
  it("done returns undefined", async () => {
    const { invoker } = spyInvoker();
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "done",
      summary: "ok",
      artifacts: [],
    };
    const result = await dispatch(action);
    expect(result).toBeUndefined();
  });

  it("failed returns undefined", async () => {
    const { invoker } = spyInvoker();
    const dispatch = makeProductionDispatcher({ agentInvoker: invoker });
    const action: NextAction = {
      kind: "failed",
      reason: "x",
      step: "test",
    };
    const result = await dispatch(action);
    expect(result).toBeUndefined();
  });
});

describe("makeStubAgentInvoker — F2.E.6 deterministic latency injection", () => {
  it("calls the injected sleep function with simulated latency", async () => {
    const sleeps: number[] = [];
    const stub = makeStubAgentInvoker({
      latencyMinMs: 100,
      latencyMaxMs: 200,
      rng: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await stub.invokeSubagentBatch([
      {
        invocation_id: "iv-1",
        purpose: "judge",
        subagent_type: "engineer",
        prompt: "p",
      },
    ]);
    expect(sleeps).toHaveLength(1);
    // latency = 100 + floor(0.5 * (200-100)) = 100 + 50 = 150
    expect(sleeps[0]).toBe(150);
  });
});

describe("makeStubAgentInvoker — F2.E.7 warm-cortex behaviour", () => {
  it("returns hit when rng < hit probability", async () => {
    const stub = makeStubAgentInvoker({
      warmCortexHitProbability: 0.7,
      rng: () => 0.5, // 0.5 < 0.7 ⇒ hit
      sleep: async () => undefined,
    });
    const r = await stub.invokeCortexRecall({
      correlation_id: "c",
      query: "q",
    });
    expect(r.total).toBe(1);
    expect(r.results).toHaveLength(1);
  });

  it("returns empty when rng > hit probability", async () => {
    const stub = makeStubAgentInvoker({
      warmCortexHitProbability: 0.3,
      rng: () => 0.9, // 0.9 > 0.3 ⇒ miss
      sleep: async () => undefined,
    });
    const r = await stub.invokeCortexRecall({
      correlation_id: "c",
      query: "q",
    });
    expect(r.total).toBe(0);
    expect(r.results).toHaveLength(0);
  });
});
