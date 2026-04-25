import type { StepHandler } from "../runner.js";
import { TIER_CAPABILITIES, type LicenseTier } from "@prd-gen/core";

/**
 * Banner text per license tier. Typed as `Record<LicenseTier, string>` so
 * adding a new tier in core/domain/license-tier.ts is a compile error
 * here until a banner is added — no runtime fallback needed.
 *
 * source: test-engineer M3 (Phase 3+4 cross-audit, 2026-04). Pre-fix
 * this was `Record<string, string>` with a runtime `?? state.license_tier`
 * fallback that the type system already made unreachable.
 */
const TIER_BANNER: Record<LicenseTier, string> = {
  free: "🟢 PRD Spec Generator — FREE TIER",
  trial: "⏳ PRD Spec Generator — TRIAL TIER (full features)",
  licensed: "✨ PRD Spec Generator — LICENSED TIER",
};

export const handleLicenseGate: StepHandler = ({ state }) => {
  const banner = TIER_BANNER[state.license_tier];
  const caps = TIER_CAPABILITIES[state.license_tier];

  const message = [
    banner,
    `Run ID: ${state.run_id}`,
    `Allowed strategies: ${caps.allowedStrategies.length}`,
    `Allowed PRD contexts: ${caps.allowedContextTypes.length}`,
    "",
    `Feature: ${state.feature_description}`,
    state.codebase_path
      ? `Codebase: ${state.codebase_path}`
      : "Codebase: (none provided)",
  ].join("\n");

  return {
    state: { ...state, current_step: "context_detection" },
    action: {
      kind: "emit_message",
      message,
      level: "info",
    },
  };
};
