/**
 * Tests for the `stage-5.affected_symbols.json` extraction contract
 * (automatised-pipeline stages/stage-6.md §4.2).
 *
 * Extraction is tolerant (absent/malformed block → empty document, never
 * throws); validation of retained entries is strict (invalid array elements
 * are dropped individually, not the whole array).
 */

import { describe, expect, it } from "vitest";
import {
  AFFECTED_SYMBOLS_MARKER,
  parseAffectedSymbolsBlock,
  stripAffectedSymbolsBlock,
} from "../index.js";

function blockWith(json: string): string {
  return [
    "## Technical Specification",
    "",
    "We use ports-and-adapters architecture.",
    "",
    AFFECTED_SYMBOLS_MARKER,
    "```json",
    json,
    "```",
  ].join("\n");
}

describe("parseAffectedSymbolsBlock", () => {
  it("returns an empty document when the marker is absent", () => {
    const doc = parseAffectedSymbolsBlock(
      "## Technical Specification\n\nNo symbols here.",
    );
    expect(doc.affected_symbols).toEqual([]);
    expect(doc.scope_claims).toEqual([]);
  });

  it("parses a well-formed block", () => {
    const content = blockWith(
      JSON.stringify({
        affected_symbols: [
          {
            qualified_name: "src/main.rs::handle_tool_call",
            change_kind: "modify",
            rationale: "add retry logic",
          },
        ],
        scope_claims: [
          { kind: "community_scope", assertion: "graph-indexing" },
          {
            kind: "process_exclusion",
            processes: ["process::src/main.rs::main"],
          },
        ],
      }),
    );
    const doc = parseAffectedSymbolsBlock(content);
    expect(doc.affected_symbols).toEqual([
      {
        qualified_name: "src/main.rs::handle_tool_call",
        change_kind: "modify",
        rationale: "add retry logic",
      },
    ]);
    expect(doc.scope_claims).toHaveLength(2);
    expect(doc.scope_claims[0]).toEqual({
      kind: "community_scope",
      assertion: "graph-indexing",
    });
    expect(doc.scope_claims[1]).toEqual({
      kind: "process_exclusion",
      processes: ["process::src/main.rs::main"],
    });
  });

  it("does not throw and returns empty on malformed JSON inside the fence", () => {
    const content = blockWith("{ affected_symbols: [ not valid json");
    const doc = parseAffectedSymbolsBlock(content);
    expect(doc.affected_symbols).toEqual([]);
    expect(doc.scope_claims).toEqual([]);
  });

  it("drops entries without qualified_name but keeps valid siblings (partial-invalidity tolerance)", () => {
    const content = blockWith(
      JSON.stringify({
        affected_symbols: [
          { change_kind: "modify", rationale: "missing qualified_name" },
          { qualified_name: "src/lib.rs::valid_fn", change_kind: "add" },
        ],
      }),
    );
    const doc = parseAffectedSymbolsBlock(content);
    expect(doc.affected_symbols).toEqual([
      { qualified_name: "src/lib.rs::valid_fn", change_kind: "add" },
    ]);
  });

  it("drops scope_claims with an unrecognized kind", () => {
    const content = blockWith(
      JSON.stringify({
        scope_claims: [
          { kind: "not_a_real_kind", assertion: "should be dropped" },
          { kind: "community_scope", assertion: "kept" },
        ],
      }),
    );
    const doc = parseAffectedSymbolsBlock(content);
    expect(doc.scope_claims).toEqual([
      { kind: "community_scope", assertion: "kept" },
    ]);
  });

  it("ignores other fenced code blocks in the same section (marker-anchored, not fence-anchored)", () => {
    const content = [
      "## Technical Specification",
      "",
      "```json",
      '{"affected_symbols": [{"qualified_name": "src/decoy.rs::decoy"}]}',
      "```",
      "",
      "The above is an unrelated code example, not the claims block.",
    ].join("\n");
    const doc = parseAffectedSymbolsBlock(content);
    expect(doc.affected_symbols).toEqual([]);
  });
});

describe("stripAffectedSymbolsBlock", () => {
  it("removes the marker and fenced block, leaving the rest of the section intact", () => {
    const content = blockWith(
      JSON.stringify({
        affected_symbols: [{ qualified_name: "src/main.rs::foo" }],
      }),
    );
    const stripped = stripAffectedSymbolsBlock(content);
    expect(stripped).not.toContain(AFFECTED_SYMBOLS_MARKER);
    expect(stripped).not.toContain("affected_symbols");
    expect(stripped).toContain("## Technical Specification");
    expect(stripped).toContain("We use ports-and-adapters architecture.");
  });

  it("is a no-op when the marker is absent", () => {
    const content = "## Technical Specification\n\nNo symbols here.";
    expect(stripAffectedSymbolsBlock(content)).toBe(content);
  });
});
