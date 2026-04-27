/**
 * Unit tests for StdioMcpClient pre-connection contract.
 *
 * Verifies that callTool() throws a clear error when invoked before connect()
 * has been called — this is the documented pre-condition for safe operation.
 *
 * source: StdioMcpClient contract (line 104–112 in stdio-mcp-client.ts).
 */

import { describe, it, expect } from "vitest";
import { StdioMcpClient } from "../transport/stdio-mcp-client.js";

describe("StdioMcpClient — pre-connection contract", () => {
  it("callTool() throws 'not connected' error when called before connect()", async () => {
    const client = new StdioMcpClient({
      serverName: "test-server",
      command: "echo",
      args: ["unused"],
    });

    // callTool() without prior connect() should throw.
    const toolCall = client.callTool("example_tool", { foo: "bar" });

    await expect(toolCall).rejects.toThrow(/before connect\(\)/);
  });
});
