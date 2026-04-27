/**
 * Generic stdio MCP client wrapper.
 *
 * Spawns a foreign MCP server as a child process and exposes a `callTool` method.
 * Lifecycle is reference-counted: callers `connect()` once, share the client,
 * and `close()` when done.
 *
 * Source: @modelcontextprotocol/sdk client API (v1.12+).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface StdioMcpClientConfig {
  readonly serverName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/**
 * Maximum milliseconds to wait for the MCP server process to complete its
 * capability-exchange handshake after spawn.
 *
 * source: provisional heuristic — MCP SDK capability exchange on a locally-
 * built Rust binary completes in <500 ms on Mac M-series hardware; 10 000 ms
 * gives 20× headroom for cold-start on slow CI runners and first-launch
 * compilation. If the exchange does not complete in this window the binary
 * is considered unreachable (not merely slow), which is the failure mode
 * the integration test's existsSync gate cannot catch.
 * Phase 4.5 will calibrate from measured p99 connect latency on CI.
 *
 * source: test-engineer TE4 (Phase 3+4 cross-audit, 2026-04).
 */
const CONNECT_TIMEOUT_MS = 10_000;

export class StdioMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly config: StdioMcpClientConfig) {}

  /**
   * Connect to the foreign MCP server. Idempotent — repeated calls share the
   * same connection. Safe to call concurrently.
   */
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: [...(this.config.args ?? [])],
      env: this.config.env ? { ...this.config.env } : undefined,
      cwd: this.config.cwd,
    });

    this.client = new Client(
      { name: `prd-gen-adapter-${this.config.serverName}`, version: "0.1.0" },
      { capabilities: {} },
    );

    const connectWithTimeout = Promise.race([
      this.client.connect(this.transport),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `${this.config.serverName}: connect() timed out after ${CONNECT_TIMEOUT_MS} ms. ` +
                "Verify the binary path is correct and the process can start.",
              ),
            ),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    await connectWithTimeout;
  }

  /**
   * Call a tool on the foreign MCP server. Returns the parsed JSON content of
   * the first text block. Throws if the server returns an error result.
   */
  async callTool<TArgs extends Record<string, unknown>, TResult = unknown>(
    name: string,
    args: TArgs,
  ): Promise<TResult> {
    if (!this.client) {
      throw new Error(
        `${this.config.serverName}: callTool('${name}') before connect()`,
      );
    }

    const rawResult = await this.client.callTool({ name, arguments: args });
    const result = rawResult as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    };

    if (result.isError) {
      const text = this.extractText(result);
      throw new Error(
        `${this.config.serverName}.${name} returned error: ${text}`,
      );
    }

    return this.parseContent<TResult>(result, name);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private extractText(result: { content?: unknown }): string {
    const content = (result.content ?? []) as Array<{
      type: string;
      text?: string;
    }>;
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n");
  }

  private parseContent<T>(
    result: { content?: unknown; structuredContent?: unknown },
    toolName: string,
  ): T {
    // Prefer structuredContent if present (MCP 1.x).
    if (
      result.structuredContent !== undefined &&
      result.structuredContent !== null
    ) {
      return result.structuredContent as T;
    }

    const text = this.extractText(result);
    if (!text) {
      throw new Error(
        `${this.config.serverName}.${toolName} returned no text content`,
      );
    }

    // Many MCP servers return JSON in a text block. Attempt to parse; if not
    // JSON, return the string as-is (cast to T).
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
