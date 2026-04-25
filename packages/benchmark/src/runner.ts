import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSection, validateDocument } from "@prd-gen/validation";
import { validateCrossReferences } from "@prd-gen/validation";
import type { SectionType, ValidationReport, CrossRefValidationResult } from "@prd-gen/core";

/**
 * Benchmark runner — executes golden fixtures through the validation pipeline.
 * Measures HOR pass rate, cross-ref integrity, and structural completeness.
 *
 * Golden fixtures are saved PRD outputs with known quality characteristics.
 * The quality gate: TypeScript validator must produce results >= Swift baseline.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BenchmarkScenario {
  readonly name: string;
  readonly context: string;
  readonly sections: ReadonlyArray<{
    name: string;
    type: SectionType;
    file: string;
  }>;
}

export interface BenchmarkResult {
  readonly scenario: string;
  readonly horReport: ValidationReport;
  readonly crossRefReport: CrossRefValidationResult;
  readonly metrics: {
    rulesChecked: number;
    rulesPassed: number;
    passRate: number;
    criticalViolations: number;
    crossRefValid: boolean;
    danglingRefs: number;
    orphanNodes: number;
    cycles: number;
    duplicateIds: number;
  };
}

export interface BenchmarkSummary {
  readonly timestamp: string;
  readonly scenarios: BenchmarkResult[];
  readonly aggregate: {
    totalRulesChecked: number;
    totalRulesPassed: number;
    overallPassRate: number;
    totalCriticalViolations: number;
    crossRefValidRate: number;
  };
  readonly qualityGatePassed: boolean;
}

// ─── Fixture Loading ─────────────────────────────────────────────────────────

function loadScenarios(fixturesDir: string): BenchmarkScenario[] {
  if (!existsSync(fixturesDir)) return [];

  const scenarios: BenchmarkScenario[] = [];
  const dirs = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const scenarioDir = join(fixturesDir, dir.name);
    const manifestPath = join(scenarioDir, "manifest.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      scenarios.push({
        name: manifest.name ?? dir.name,
        context: manifest.context ?? "feature",
        sections: (manifest.sections ?? []).map(
          (s: { name: string; type: string; file: string }) => ({
            name: s.name,
            type: s.type as SectionType,
            file: join(scenarioDir, s.file),
          }),
        ),
      });
    }
  }

  return scenarios;
}

// ─── Benchmark Execution ─────────────────────────────────────────────────────

function runScenario(scenario: BenchmarkScenario): BenchmarkResult {
  const sections: Array<{ type: SectionType; content: string }> = [];
  const crossRefSections: Array<{ name: string; content: string }> = [];

  for (const s of scenario.sections) {
    if (!existsSync(s.file)) continue;
    const content = readFileSync(s.file, "utf-8");
    sections.push({ type: s.type, content });
    crossRefSections.push({ name: s.name, content });
  }

  const horReport = validateDocument(sections);
  const crossRefReport = validateCrossReferences(crossRefSections);

  const passRate =
    horReport.rulesChecked.length > 0
      ? horReport.rulesPassed.length / horReport.rulesChecked.length
      : 1;

  return {
    scenario: scenario.name,
    horReport,
    crossRefReport,
    metrics: {
      rulesChecked: horReport.rulesChecked.length,
      rulesPassed: horReport.rulesPassed.length,
      passRate,
      criticalViolations: horReport.violations.filter((v) => v.isCritical).length,
      crossRefValid: crossRefReport.isValid,
      danglingRefs: crossRefReport.danglingReferences.length,
      orphanNodes: crossRefReport.orphanNodes.length,
      cycles: crossRefReport.cycles.length,
      duplicateIds: crossRefReport.duplicateIds.length,
    },
  };
}

// ─── Report Generation ───────────────────────────────────────────────────────

function generateReport(summary: BenchmarkSummary): string {
  const lines: string[] = [
    "# PRD Generator Benchmark Report",
    "",
    `**Date:** ${summary.timestamp}`,
    `**Quality Gate:** ${summary.qualityGatePassed ? "PASSED" : "FAILED"}`,
    "",
    "## Aggregate Metrics",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Rules Checked | ${summary.aggregate.totalRulesChecked} |`,
    `| Rules Passed | ${summary.aggregate.totalRulesPassed} |`,
    `| Overall Pass Rate | ${(summary.aggregate.overallPassRate * 100).toFixed(1)}% |`,
    `| Critical Violations | ${summary.aggregate.totalCriticalViolations} |`,
    `| Cross-Ref Valid Rate | ${(summary.aggregate.crossRefValidRate * 100).toFixed(1)}% |`,
    "",
    "## Per-Scenario Results",
    "",
  ];

  for (const result of summary.scenarios) {
    lines.push(`### ${result.scenario}`);
    lines.push("");
    lines.push(`- Pass rate: ${(result.metrics.passRate * 100).toFixed(1)}%`);
    lines.push(`- Rules: ${result.metrics.rulesPassed}/${result.metrics.rulesChecked}`);
    lines.push(`- Critical violations: ${result.metrics.criticalViolations}`);
    lines.push(`- Cross-ref valid: ${result.metrics.crossRefValid}`);

    if (result.metrics.danglingRefs > 0) {
      lines.push(`- Dangling refs: ${result.metrics.danglingRefs}`);
    }
    if (result.metrics.cycles > 0) {
      lines.push(`- Cycles: ${result.metrics.cycles}`);
    }

    if (result.horReport.violations.length > 0) {
      lines.push("");
      lines.push("**Violations:**");
      for (const v of result.horReport.violations.slice(0, 10)) {
        lines.push(`- \`${v.rule}\`: ${v.message}`);
      }
      if (result.horReport.violations.length > 10) {
        lines.push(
          `- ... and ${result.horReport.violations.length - 10} more`,
        );
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * source: provisional heuristic — initial value chosen to match the Swift
 * reference (`ai-architect-prd-builder` quality gate). Phase 4.5 will
 * recalibrate from a labelled fixture set; the right threshold depends
 * on the rate at which the validator's own rules surface false positives
 * vs catching real defects. Until then, 0.8 is a placeholder.
 *
 * Cross-audit curie M-1 (Phase 3+4, 2026-04).
 */
const QUALITY_GATE_THRESHOLD = 0.8;

export async function runBenchmark(
  fixturesDir?: string,
  outputPath?: string,
): Promise<BenchmarkSummary> {
  const dir = fixturesDir ?? join(process.cwd(), "packages/benchmark/src/golden-fixtures");
  const scenarios = loadScenarios(dir);

  if (scenarios.length === 0) {
    // Empty-fixture run is uninstrumented — there is nothing to certify.
    // Pre-fix this returned qualityGatePassed=true, treating "no data" as
    // "passing." A no-fixture run is now a hard FAIL per curie M-1
    // (Phase 3+4 cross-audit, 2026-04): silence is not a passing signal.
    console.log(
      "No benchmark scenarios found. Treating as quality-gate FAILURE (uninstrumented run).",
    );
    const empty: BenchmarkSummary = {
      timestamp: new Date().toISOString(),
      scenarios: [],
      aggregate: {
        totalRulesChecked: 0,
        totalRulesPassed: 0,
        overallPassRate: 0,
        totalCriticalViolations: 0,
        crossRefValidRate: 0,
      },
      qualityGatePassed: false,
    };
    return empty;
  }

  console.log(`Running ${scenarios.length} benchmark scenarios...`);

  const results: BenchmarkResult[] = [];
  for (const scenario of scenarios) {
    console.log(`  ${scenario.name}...`);
    results.push(runScenario(scenario));
  }

  const totalChecked = results.reduce((s, r) => s + r.metrics.rulesChecked, 0);
  const totalPassed = results.reduce((s, r) => s + r.metrics.rulesPassed, 0);
  const totalCritical = results.reduce((s, r) => s + r.metrics.criticalViolations, 0);
  const crossRefValid = results.filter((r) => r.metrics.crossRefValid).length;

  const overallPassRate = totalChecked > 0 ? totalPassed / totalChecked : 1;
  const crossRefValidRate = results.length > 0 ? crossRefValid / results.length : 1;

  const summary: BenchmarkSummary = {
    timestamp: new Date().toISOString(),
    scenarios: results,
    aggregate: {
      totalRulesChecked: totalChecked,
      totalRulesPassed: totalPassed,
      overallPassRate,
      totalCriticalViolations: totalCritical,
      crossRefValidRate,
    },
    qualityGatePassed:
      overallPassRate >= QUALITY_GATE_THRESHOLD && totalCritical === 0,
  };

  const report = generateReport(summary);
  const outPath = outputPath ?? join(process.cwd(), "benchmark-report.md");
  writeFileSync(outPath, report, "utf-8");
  console.log(`\nReport written to: ${outPath}`);
  console.log(`Quality gate: ${summary.qualityGatePassed ? "PASSED" : "FAILED"} (${(overallPassRate * 100).toFixed(1)}% pass rate)`);

  return summary;
}

// CLI entry point
if (process.argv[1]?.endsWith("runner.js")) {
  runBenchmark().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
