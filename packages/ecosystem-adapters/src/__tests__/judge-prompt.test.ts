import { describe, expect, it } from "vitest";
import { buildJudgePrompt, extractJsonObject } from "../index.js";
import type { JudgeRequest } from "../index.js";

const baseReq: JudgeRequest = {
  judge: { kind: "genius", name: "liskov" },
  claim: {
    claim_id: "FR-001",
    claim_type: "fr_traceability",
    text: "System must support OAuth login",
    evidence: "From requirements section.",
    source_section: "requirements",
  },
  context: {
    prd_excerpt: undefined,
    codebase_excerpts: [],
    memory_excerpts: [],
  },
};

describe("buildJudgePrompt", () => {
  it("includes the judge's reasoning pattern instruction for genius judges", () => {
    const built = buildJudgePrompt(baseReq);
    expect(built.prompt).toContain("liskov reasoning pattern");
  });

  it("includes the role expertise instruction for team judges", () => {
    const built = buildJudgePrompt({
      ...baseReq,
      judge: { kind: "team", name: "code-reviewer" },
    });
    expect(built.prompt).toContain("code-reviewer role expertise");
  });

  it("embeds the verdict taxonomy with NFR constraint", () => {
    const built = buildJudgePrompt(baseReq);
    expect(built.prompt).toContain("PASS");
    expect(built.prompt).toContain("SPEC-COMPLETE");
    expect(built.prompt).toContain("NFR claims");
    expect(built.prompt).toContain("MUST NOT receive PASS");
  });

  it("includes the response schema", () => {
    const built = buildJudgePrompt(baseReq);
    expect(built.prompt).toContain('"verdict"');
    expect(built.prompt).toContain('"rationale"');
    expect(built.prompt).toContain('"confidence"');
  });

  it("returns the correct subagent_type for genius judges", () => {
    const built = buildJudgePrompt(baseReq);
    expect(built.subagent_type).toBe("zetetic-team-subagents:genius:liskov");
  });

  it("returns the correct subagent_type for team judges", () => {
    const built = buildJudgePrompt({
      ...baseReq,
      judge: { kind: "team", name: "security-auditor" },
    });
    expect(built.subagent_type).toBe(
      "zetetic-team-subagents:security-auditor",
    );
  });
});

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    const out = extractJsonObject('{"a": 1, "b": "x"}');
    expect(out).toEqual({ a: 1, b: "x" });
  });

  it("strips markdown fences", () => {
    const out = extractJsonObject('```json\n{"verdict": "PASS"}\n```');
    expect(out).toEqual({ verdict: "PASS" });
  });

  it("handles a prose preamble before the JSON", () => {
    const text =
      "Here is my verdict:\n\n{\"verdict\": \"FAIL\", \"confidence\": 0.9}";
    expect(extractJsonObject(text)).toEqual({ verdict: "FAIL", confidence: 0.9 });
  });

  it("handles nested objects", () => {
    const out = extractJsonObject('{"outer": {"inner": [1, 2, 3]}}');
    expect(out).toEqual({ outer: { inner: [1, 2, 3] } });
  });

  it("throws on missing object", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });

  it("throws on unbalanced braces", () => {
    expect(() => extractJsonObject('{"a": 1')).toThrow(/unbalanced/);
  });
});
