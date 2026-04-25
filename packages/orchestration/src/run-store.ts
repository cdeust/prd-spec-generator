/**
 * In-memory store of active pipeline runs, keyed by run_id.
 *
 * The MCP server is per-session, so a single in-memory map is correct for
 * one host. If we ever need multi-host or persistent runs, swap this for a
 * SQLite-backed store — the contract is just `get` / `set` / `delete`.
 */

import type { PipelineState } from "./types/state.js";

export interface RunStore {
  get(runId: string): PipelineState | undefined;
  set(state: PipelineState): void;
  delete(runId: string): void;
  list(): readonly PipelineState[];
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, PipelineState>();

  get(runId: string): PipelineState | undefined {
    return this.runs.get(runId);
  }

  set(state: PipelineState): void {
    this.runs.set(state.run_id, state);
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  list(): readonly PipelineState[] {
    return Array.from(this.runs.values());
  }
}
