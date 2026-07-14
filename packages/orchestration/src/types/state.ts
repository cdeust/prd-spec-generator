/**
 * Transparent re-export shim. The state module was split by concern into
 * ./state/ (Phase 3a refactor, §4.1 500-line file cap) — see
 * ./state/index.ts for the module map. This file exists so every existing
 * `"./types/state.js"` / `"../types/state.js"` import specifier keeps
 * resolving without a single call-site edit.
 */
export * from "./state/index.js";
