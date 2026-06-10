/**
 * Bounded-I/O eviction tests for InMemoryRunStore (Phase 3).
 *
 * Proves:
 *   - TTL eviction removes terminal (current_step:"complete") runs once their
 *     age since last access exceeds ttlMs — using an INJECTED clock, never a
 *     real sleep.
 *   - In-flight runs (current_step !== "complete") are NEVER evicted, regardless
 *     of age or max-runs pressure.
 *   - max-runs eviction drops terminal runs LRU-first; if only in-flight runs
 *     remain the store stays over cap rather than dropping an active run.
 *   - eviction is observable (evicted counter) and fires onEvict (so the
 *     composition root can release run-tied evidence).
 */
import { describe, expect, it } from "vitest";
import { InMemoryRunStore, type Clock } from "../index.js";
import { newPipelineState, type PipelineState } from "../index.js";

/** Mutable fake clock — tests advance time explicitly, never sleep. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function runAt(runId: string, step: PipelineState["current_step"]): PipelineState {
  const s = newPipelineState({
    run_id: runId,
    feature_description: "x",
    skip_preflight: true,
  });
  return { ...s, current_step: step };
}

describe("InMemoryRunStore — TTL eviction (injected clock)", () => {
  it("evicts a terminal run once age since last access exceeds ttlMs", () => {
    const clock = fakeClock();
    const store = new InMemoryRunStore({ ttlMs: 1_000, clock: clock.now });
    store.set(runAt("r1", "complete")); // lastAccess = t0

    clock.advance(999); // 999ms < ttl — still live
    expect(store.get("r1")).toBeDefined(); // refreshes lastAccess to t0+999

    clock.advance(1_000); // 1000ms since the refreshed access >= ttl
    expect(store.get("r1")).toBeUndefined();
    expect(store.evicted).toBe(1);
  });

  it("never evicts an in-flight run by TTL, no matter how old", () => {
    const clock = fakeClock();
    const store = new InMemoryRunStore({ ttlMs: 1_000, clock: clock.now });
    store.set(runAt("r1", "section_generation")); // in flight
    clock.advance(1_000_000);
    expect(store.get("r1")).toBeDefined();
    expect(store.evicted).toBe(0);
  });

  it("fires onEvict with the evicted run_id", () => {
    const clock = fakeClock();
    const evicted: string[] = [];
    const store = new InMemoryRunStore({
      ttlMs: 1_000,
      clock: clock.now,
      onEvict: (id) => evicted.push(id),
    });
    store.set(runAt("r1", "complete"));
    clock.advance(2_000);
    store.get("r1"); // triggers sweep
    expect(evicted).toEqual(["r1"]);
  });
});

describe("InMemoryRunStore — max-runs eviction (LRU, terminal-only)", () => {
  it("evicts terminal runs LRU-first when over the max-runs cap", () => {
    const clock = fakeClock();
    const store = new InMemoryRunStore({ maxRuns: 2, clock: clock.now });
    store.set(runAt("r1", "complete"));
    clock.advance(10);
    store.set(runAt("r2", "complete"));
    clock.advance(10);
    store.set(runAt("r3", "complete")); // over cap → evict LRU (r1)

    expect(store.get("r1")).toBeUndefined();
    expect(store.get("r2")).toBeDefined();
    expect(store.get("r3")).toBeDefined();
    expect(store.evicted).toBe(1);
    expect(store.size()).toBe(2);
  });

  it("never evicts in-flight runs even when over cap — stays over cap instead", () => {
    const clock = fakeClock();
    const store = new InMemoryRunStore({ maxRuns: 1, clock: clock.now });
    store.set(runAt("r1", "section_generation"));
    clock.advance(10);
    store.set(runAt("r2", "section_generation")); // both in flight, over cap

    // Neither is evicted — dropping an active run is forbidden.
    expect(store.get("r1")).toBeDefined();
    expect(store.get("r2")).toBeDefined();
    expect(store.evicted).toBe(0);
    expect(store.size()).toBe(2);
  });

  it("evicts only the terminal run when the store mixes in-flight and terminal over cap", () => {
    const clock = fakeClock();
    const store = new InMemoryRunStore({ maxRuns: 1, clock: clock.now });
    store.set(runAt("r1", "complete")); // terminal
    clock.advance(10);
    store.set(runAt("r2", "section_generation")); // in flight, over cap

    // r1 (terminal) is evicted; r2 (in flight) survives.
    expect(store.get("r1")).toBeUndefined();
    expect(store.get("r2")).toBeDefined();
    expect(store.evicted).toBe(1);
  });
});
