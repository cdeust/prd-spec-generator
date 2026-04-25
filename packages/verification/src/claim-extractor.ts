/**
 * Claim extractor — turns a PRD section's markdown into a list of atomic Claims.
 *
 * Per-section-type extractors apply regex/structural parsing rules. Output
 * Claims have stable IDs (FR-001, AC-005, NFR-LATENCY-1, ...) so consensus
 * decisions can be cross-referenced.
 *
 * No LLM calls. No semantic understanding. The judges do that.
 */

import type { SectionType, Claim } from "@prd-gen/core";

type ClaimType = Claim["claim_type"];

interface ExtractContext {
  readonly section_type: SectionType;
  readonly content: string;
}

type Extractor = (ctx: ExtractContext) => readonly Claim[];

// ─── Helpers ────────────────────────────────────────────────────────────────

function snippet(content: string, line: string, before = 2, after = 2): string {
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === line.trim());
  if (idx === -1) return line;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + after + 1);
  return lines.slice(start, end).join("\n");
}

function* matchAllLines(re: RegExp, content: string): Generator<RegExpMatchArray> {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) yield m;
  }
}

// ─── FR / requirements ──────────────────────────────────────────────────────

const FR_LINE_RE = /^\s*(?:-|\*|\|)?\s*(FR-\d{3,})\s*[|:\-–—]\s*(.+?)\s*(?:\||$)/i;

const extractRequirements: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  for (const m of matchAllLines(FR_LINE_RE, content)) {
    const id = m[1].toUpperCase();
    const text = m[2].trim();
    if (!text) continue;
    claims.push({
      claim_id: id,
      claim_type: "fr_traceability",
      text: `Functional requirement: ${text}`,
      evidence: snippet(content, m[0]),
      source_section: section_type,
    });
  }
  return claims;
};

// ─── AC / acceptance criteria ───────────────────────────────────────────────

const AC_LINE_RE = /^\s*(?:-|\*|\|)?\s*(AC-\d{3,})\s*[|:\-–—]\s*(.+?)\s*(?:\||$)/i;

const extractAcceptanceCriteria: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  for (const m of matchAllLines(AC_LINE_RE, content)) {
    const id = m[1].toUpperCase();
    const text = m[2].trim();
    if (!text) continue;
    claims.push({
      claim_id: id,
      claim_type: "acceptance_criteria_completeness",
      text: `Acceptance criterion: ${text}`,
      evidence: snippet(content, m[0]),
      source_section: section_type,
    });
  }
  return claims;
};

// ─── NFR / performance ──────────────────────────────────────────────────────

const NFR_PATTERNS: Array<{ re: RegExp; subtype: string }> = [
  { re: /\b(?:p\d{2}|p99|p95|p50)\s*[<>=≤≥]+\s*(\d+(?:\.\d+)?\s*(?:ms|s|µs|us))/gi, subtype: "LATENCY" },
  { re: /\b(\d+(?:\.\d+)?\s*(?:rps|req\/s|qps|requests?\/(?:sec|second)))/gi, subtype: "THROUGHPUT" },
  { re: /\b(\d+(?:\.\d+)?\s*fps)/gi, subtype: "FRAMERATE" },
  { re: /\b(\d+(?:\.\d+)?\s*(?:GB|MB|TB|KB)\b)/gi, subtype: "STORAGE" },
];

const extractPerformance: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  for (const { re, subtype } of NFR_PATTERNS) {
    let counter = 0;
    for (const m of content.matchAll(re)) {
      counter += 1;
      claims.push({
        claim_id: `NFR-${subtype}-${counter.toString().padStart(2, "0")}`,
        claim_type: "performance",
        text: `Performance target: ${m[0]}`,
        evidence: snippet(content, m[0], 1, 1),
        source_section: section_type,
      });
    }
  }
  return claims;
};

// ─── Architecture / technical_specification ─────────────────────────────────

const ARCH_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /ports?[\s\-]?(?:and|\/)?[\s\-]?adapters?/i, label: "ports-and-adapters" },
  { re: /clean\s+architecture/i, label: "clean-architecture" },
  { re: /hexagonal/i, label: "hexagonal" },
  { re: /domain[\s-]+driven\s+design|\bDDD\b/i, label: "ddd" },
  { re: /event[\s-]+driven/i, label: "event-driven" },
  { re: /micro[\s-]?services?/i, label: "microservices" },
  { re: /repository\s+pattern/i, label: "repository-pattern" },
  { re: /CQRS/i, label: "cqrs" },
];

const extractArchitecture: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  for (const { re, label } of ARCH_PATTERNS) {
    if (re.test(content)) {
      const m = content.match(re)!;
      claims.push({
        claim_id: `ARCH-${label.toUpperCase()}`,
        claim_type: "architecture",
        text: `Architecture pattern claim: ${label}`,
        evidence: snippet(content, m[0], 3, 3),
        source_section: section_type,
      });
    }
  }
  return claims;
};

// ─── Security ───────────────────────────────────────────────────────────────

const SECURITY_KEYWORDS = [
  "authentication", "authorization", "encryption", "secrets", "PII",
  "OAuth", "JWT", "TLS", "AES", "SHA", "hash", "token", "session",
];

const extractSecurity: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  const lower = content.toLowerCase();
  let counter = 0;
  for (const kw of SECURITY_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      counter += 1;
      claims.push({
        claim_id: `SEC-${counter.toString().padStart(2, "0")}-${kw.toUpperCase()}`,
        claim_type: "security",
        text: `Security claim involving ${kw}`,
        evidence: extractParagraphContaining(content, kw),
        source_section: section_type,
      });
    }
  }
  return claims;
};

function extractParagraphContaining(content: string, keyword: string): string {
  const lower = content.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  const idx = lower.indexOf(lowerKw);
  if (idx === -1) return content.slice(0, 400);
  const start = Math.max(0, content.lastIndexOf("\n\n", idx));
  let end = content.indexOf("\n\n", idx);
  if (end === -1) end = Math.min(content.length, idx + 400);
  return content.slice(start, end).trim();
}

// ─── Data model ─────────────────────────────────────────────────────────────

const DDL_RE = /(CREATE\s+(?:TABLE|TYPE|ENUM|INDEX|VIEW)\s+\w+[\s\S]*?;)/gi;

const extractDataModel: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  let counter = 0;
  for (const m of content.matchAll(DDL_RE)) {
    counter += 1;
    const ddl = m[1];
    const nameMatch = ddl.match(
      /CREATE\s+(?:TABLE|TYPE|ENUM|INDEX|VIEW)\s+(\w+)/i,
    );
    const name = nameMatch?.[1] ?? "anonymous";
    claims.push({
      claim_id: `DDL-${counter.toString().padStart(2, "0")}-${name.toUpperCase()}`,
      claim_type: "data_model",
      text: `Schema definition: ${name}`,
      evidence: ddl.slice(0, 600),
      source_section: section_type,
    });
  }
  return claims;
};

// ─── Tests ──────────────────────────────────────────────────────────────────

const TEST_FN_RE = /(?:func|def|fn|it|test)\s+(test_?\w+|\w*Test\w*)\s*\(/gi;

const extractTests: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  let counter = 0;
  for (const m of content.matchAll(TEST_FN_RE)) {
    counter += 1;
    claims.push({
      claim_id: `TEST-${counter.toString().padStart(3, "0")}-${m[1].slice(0, 32)}`,
      claim_type: "test_coverage",
      text: `Test function: ${m[1]}`,
      evidence: snippet(content, m[0], 2, 4),
      source_section: section_type,
    });
  }
  return claims;
};

// ─── Risks ──────────────────────────────────────────────────────────────────

const RISK_LINE_RE = /^\s*(?:-|\*)\s*(?:\*\*Risk\*\*[:|]?\s*)?(.+?(?:risk|failure|hazard|threat|attack|vulnerab).+)$/i;

const extractRisks: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  let counter = 0;
  for (const m of matchAllLines(RISK_LINE_RE, content)) {
    counter += 1;
    claims.push({
      claim_id: `RISK-${counter.toString().padStart(2, "0")}`,
      claim_type: "risk",
      text: m[1].trim(),
      evidence: snippet(content, m[0]),
      source_section: section_type,
    });
  }
  return claims;
};

// ─── Story-point arithmetic ─────────────────────────────────────────────────

const SP_TOTAL_RE = /total\s*[:|=]\s*(\d+)\s*(?:sp|story\s*points?)?/gi;

const extractStoryPoints: Extractor = ({ content, section_type }) => {
  const claims: Claim[] = [];
  let counter = 0;
  for (const m of content.matchAll(SP_TOTAL_RE)) {
    counter += 1;
    claims.push({
      claim_id: `SP-TOTAL-${counter.toString().padStart(2, "0")}`,
      claim_type: "story_point_arithmetic",
      text: `Story-point total claim: ${m[0]}`,
      evidence: snippet(content, m[0]),
      source_section: section_type,
    });
  }
  return claims;
};

// ─── Dispatch ───────────────────────────────────────────────────────────────

const EXTRACTORS_BY_SECTION: Partial<Record<SectionType, readonly Extractor[]>> = {
  requirements: [extractRequirements],
  user_stories: [extractStoryPoints],
  technical_specification: [extractArchitecture],
  acceptance_criteria: [extractAcceptanceCriteria],
  data_model: [extractDataModel],
  api_specification: [extractRequirements], // FR-style endpoint claims
  security_considerations: [extractSecurity],
  performance_requirements: [extractPerformance],
  testing: [extractTests],
  test_code: [extractTests],
  risks: [extractRisks],
  timeline: [extractStoryPoints],
};

export function extractClaims(
  sectionType: SectionType,
  content: string,
): readonly Claim[] {
  const extractors = EXTRACTORS_BY_SECTION[sectionType] ?? [];
  const claims: Claim[] = [];
  for (const ex of extractors) {
    claims.push(...ex({ section_type: sectionType, content }));
  }
  return dedupeById(claims);
}

export function extractClaimsFromDocument(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): readonly Claim[] {
  const claims: Claim[] = [];
  for (const s of sections) {
    claims.push(...extractClaims(s.type, s.content));
  }
  return dedupeById(claims);
}

function dedupeById(claims: readonly Claim[]): readonly Claim[] {
  const seen = new Map<string, Claim>();
  for (const c of claims) {
    if (!seen.has(c.claim_id)) seen.set(c.claim_id, c);
  }
  return Array.from(seen.values());
}
