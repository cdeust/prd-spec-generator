/**
 * Non-invasive instrumentation hooks for the benchmark runner.
 *
 * Phase 4.3 measurement-only contract: this module READS `PipelineState`
 * after a run completes and extracts mismatch_kind events. It does NOT
 * modify reducer or handler logic. The signal source is the
 * `[self_check] plan mismatch detected — mismatch_kind:<kind>` strings
 * appended to `state.errors` by `handleSelfCheckPhaseB` (CHANGELOG [0.2.0]
 * HIGH fix; source: packages/orchestration/src/handlers/self-check.ts
 * lines 244-256).
 *
 * If the diagnostic prefix changes, this module ASSERTS on the unknown
 * format rather than silently degrading — Phase 4.3 demands a loud failure
 * mode so the K=460 study cannot accidentally report "0 fires" when the
 * upstream emitter rotated formats.
 */

import type { PipelineState } from "@prd-gen/orchestration";

/**
 * source: packages/orchestration/src/handlers/self-check.ts (Phase B append).
 * The leading marker uniquely identifies plan-mismatch diagnostics in
 * state.errors and is unlikely to collide with other appendError sites.
 */
const MISMATCH_PREFIX = "[self_check] plan mismatch detected — mismatch_kind:";

// source: packages/orchestration/src/handlers/self-check.ts:312-314 — the
// only two values the handler can emit. Any other value here is a bug in
// either the handler or this parser.
const KNOWN_MISMATCH_KINDS = ["content_mutation", "ordering_regression"] as const;
export type MismatchKind = (typeof KNOWN_MISMATCH_KINDS)[number];

export interface MismatchEvent {
  readonly kind: MismatchKind;
  readonly raw: string;
}

export interface MismatchExtraction {
  /** True iff at least one mismatch event was recorded for this run. */
  readonly fired: boolean;
  /** Distinct mismatch kinds observed (deduplicated, mirroring Phase B). */
  readonly distinctKinds: ReadonlyArray<MismatchKind>;
  /** Raw event list — may contain duplicates if the handler ever emits them. */
  readonly events: ReadonlyArray<MismatchEvent>;
}

function isKnownKind(s: string): s is MismatchKind {
  return (KNOWN_MISMATCH_KINDS as ReadonlyArray<string>).includes(s);
}

/**
 * Extract mismatch events from a completed pipeline state.
 *
 * Throws if a mismatch line is recognized but its kind is unknown — surfaces
 * format drift before it pollutes the calibration dataset.
 */
export function extractMismatchEvents(
  state: Pick<PipelineState, "errors">,
): MismatchExtraction {
  const events: MismatchEvent[] = [];
  for (const err of state.errors) {
    if (!err.startsWith(MISMATCH_PREFIX)) continue;
    const kind = err.slice(MISMATCH_PREFIX.length).trim();
    if (!isKnownKind(kind)) {
      throw new Error(
        `instrumentation: unknown mismatch_kind '${kind}' in state.errors. ` +
          `Update KNOWN_MISMATCH_KINDS or fix the handler emitter. Raw: ${err}`,
      );
    }
    events.push({ kind, raw: err });
  }
  const distinct = Array.from(new Set(events.map((e) => e.kind)));
  return {
    fired: events.length > 0,
    distinctKinds: distinct as MismatchKind[],
    events,
  };
}

/**
 * Convenience tally: maps each known kind to the count of events seen.
 * Useful for aggregating across many runs without re-walking the events.
 */
export function tallyByKind(
  extractions: ReadonlyArray<MismatchExtraction>,
): Record<MismatchKind, number> {
  const tally: Record<MismatchKind, number> = {
    content_mutation: 0,
    ordering_regression: 0,
  };
  for (const ext of extractions) {
    for (const k of ext.distinctKinds) {
      tally[k] += 1;
    }
  }
  return tally;
}

export const MISMATCH_DIAGNOSTIC_PREFIX = MISMATCH_PREFIX;
export const MISMATCH_KINDS = KNOWN_MISMATCH_KINDS;
