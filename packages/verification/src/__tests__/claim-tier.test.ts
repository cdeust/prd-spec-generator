/**
 * Claim verification tiering — calibrated against the 29 REAL claims of e2e
 * run run_mrlqa0aj_u2rh15 (2026-07-15): 16 acceptance criteria (AC-001..016,
 * verbatim from the "## Acceptance Criteria" Gherkin block), 12 functional
 * requirements (FR-001..012, verbatim from the "## Requirements" table),
 * and 1 architecture claim ("### Architecture (ports/adapters)").
 *
 * source (verbatim excerpts below): repo `session-optimizer`, file
 * `prd-output/run_mrlq/01-prd.md`:
 *   - FR-001..012:        lines 31-42
 *   - AC-001..016:        lines 156-186
 *   - Architecture claim: lines 87-97 ("### Architecture (ports/adapters)")
 *
 * Ground truth for the mechanical/subjective split is the CLAIM TEXT ITSELF
 * (not asserted by the test author): AC-010 through AC-016 each name an
 * explicit deterministic verification method (grep / diff / `time` /
 * absence-of-pattern / a named pass-fail gate); AC-001 through AC-009 assert
 * a rendered outcome without naming a verification method — including
 * AC-008, the claim the real multi-judge panel actually caught a FAIL on
 * (mendeleev, confidence 0.60 — see claim-tier.ts module doc). FR-001..012
 * are design-intent statements (claim_type fr_traceability is always
 * subjective by construction). The architecture claim is always subjective
 * by construction.
 */

import { describe, expect, it } from "vitest";
import { extractClaims, extractClaimsFromDocument } from "../claim-extractor.js";
import { classifyClaimTier } from "../claim-tier.js";

// ─── Verbatim fixtures (see module doc for source line ranges) ─────────────

const REQUIREMENTS_CONTENT = `
| ID | Requirement | Priority | Depends | Source |
|----|-------------|----------|---------|--------|
| FR-001 | Remplacer \`grad_rgb()\` (statusline-command.sh:294-303) par une fonction à paliers discrets (ex. \`palier_rgb(pos)\`) qui retourne l'une des 4 couleurs de palette DS en fonction de \`pos\`, sans interpolation RGB continue. | Must | — | codebase finding |
| FR-002 | Définir 4 paliers de seuil sur \`pos\` (0-100) alignés sur les seuils checkpoint : palier 1 = 0-49, palier 2 = 50-74, palier 3 = 75-89, palier 4 = 90-100. | Must | FR-001 | clarification round 3 |
| FR-003 | Palier 1 (0-49%) utilise le token DS \`ink-muted\`. | Must | FR-002 | clarification rounds 4-5 |
| FR-004 | Palier 2 (50-74%) utilise le token DS \`ink\`. | Must | FR-002 | clarification rounds 4-5 |
| FR-005 | Palier 3 (75-89%) utilise le token DS terracotta atténué. | Must | FR-002 | clarification rounds 4-5 |
| FR-006 | Palier 4 (90-100%) utilise le token DS terracotta plein, avec option d'accentuation (gras) pour marquer l'état critique. | Must | FR-002 | clarification rounds 4-5 |
| FR-007 | Conserver dans \`make_bar()\` (statusline-command.sh:310-326) le rendu segmenté existant : chaque cellule remplie est colorée selon le palier correspondant à sa position \`pos = i*100/(w-1)\`, sans changer la logique de remplissage/vide. | Must | FR-001, FR-002 | codebase finding |
| FR-008 | Conserver le rendu des cellules vides en \`OVERLAY ░\` et le \`RESET\` final de la barre, inchangés par rapport à l'implémentation actuelle. | Must | FR-007 | codebase finding |
| FR-009 | Ne pas modifier \`token_color()\` (statusline-command.sh:329-334) ni la logique GREEN/YELLOW/RED sur \`WARN_TOKENS\`/\`SAVE_TOKENS\` : hors périmètre de la jauge. | Must | — | codebase finding |
| FR-010 | Supprimer toute constante RGB hardcodée héritée du dégradé continu ((101,201,140), (232,170,78), (232,97,84)) une fois la palette à 4 paliers en place. | Must | FR-001 à FR-006 | codebase finding |
| FR-011 | La jauge ne doit utiliser aucune couleur vert/jaune/rouge de type sémaphore ; la palette reste mono-famille dérivée de la DA (ink → terracotta). | Must | FR-003 à FR-006 | decision 1 |
| FR-012 | La rampe de couleurs ne doit provenir d'aucune nouvelle source de tokens \`--heat-*\` ; seuls des tokens DS déjà existants sont réutilisés. | Must | FR-003 à FR-006 | decision 2 |
`.trim();

const ACCEPTANCE_CRITERIA_CONTENT = `
AC-001 : Étant donné un pourcentage de contexte de 25 %, quand \`make_bar\` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_1 (#888682/--fg-2) (FR-001, FR-003).

AC-002 : Étant donné un pourcentage de contexte de 60 %, quand \`make_bar\` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_2 (#c0bdba/--fg-1) (FR-001, FR-004).

AC-003 : Étant donné un pourcentage de contexte de 80 %, quand \`make_bar\` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_3 (terracotta atténué dérivé oklch) (FR-001, FR-005).

AC-004 : Étant donné un pourcentage de contexte de 95 %, quand \`make_bar\` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_4 (#cf6e39/--accent) (FR-001, FR-006).

AC-005 : Étant donné un pourcentage de contexte de 49 %, quand la cellule est rendue, alors elle utilise HEAT_1 ; et étant donné 50 %, alors la cellule bascule sur HEAT_2 — sans valeur intermédiaire interpolée (FR-002, FR-003, FR-004).

AC-006 : Étant donné un pourcentage de contexte de 74 %, quand la cellule est rendue, alors elle utilise HEAT_2 ; et étant donné 75 %, alors la cellule bascule sur HEAT_3 — sans valeur intermédiaire interpolée (FR-002, FR-004, FR-005).

AC-007 : Étant donné un pourcentage de contexte de 89 %, quand la cellule est rendue, alors elle utilise HEAT_3 ; et étant donné 90 %, alors la cellule bascule sur HEAT_4 — sans valeur intermédiaire interpolée (FR-002, FR-005, FR-006).

AC-008 : Étant donné une jauge dont le remplissage traverse plusieurs paliers (ex. 0-90 %), quand \`make_bar\` génère la barre, alors chaque cellule pleine est colorée individuellement selon son palier propre (rendu segmenté multi-couleurs) (FR-007).

AC-009 : Étant donné une jauge partiellement remplie, quand les cellules au-delà du seuil de remplissage sont rendues, alors elles conservent le caractère OVERLAY ░ et son style existant (FR-008).

AC-010 : Étant donné le code source de \`make_bar\` après modification, quand on l'inspecte, alors aucune fonction ou expression de type lerp/interpolation continue (grad_rgb ou équivalent) n'est présente (FR-001, FR-010).

AC-011 : Étant donné le code source complet du module modifié, quand on grep les constantes de couleur, alors aucune référence à des couleurs vertes, jaunes ou rouges (ni littérales ni via variables héritées) n'est trouvée dans la jauge (FR-011).

AC-012 : Étant donné le code source complet du module modifié, quand on grep les tokens \`--heat-*\`, alors aucune occurrence n'est trouvée en tant que source de couleur (FR-012).

AC-013 : Étant donné le module \`token_color\`, quand on diffe le fichier avant/après, alors aucune modification n'y est apportée (FR-009).

AC-014 : Étant donné le jeu de valeurs {0, 25, 49, 50, 74, 75, 89, 90, 100}, quand le script est exécuté pour chacune, alors chaque exécution se termine sans erreur et produit un rendu de barre avec la couleur de palier attendue (FR-002 à FR-006, NFR-002).

AC-015 : Étant donné une exécution \`time\` moyennée sur 20 runs du script avant et après modification, quand on compare les deux moyennes, alors le delta est inférieur à +5 ms (NFR-002).

AC-016 : Étant donné le diff final soumis, quand on l'inspecte, alors il ne contient que des modifications bash pures dans session-optimizer (aucune dépendance externe ajoutée) et passe la gate G6 (FR-001 à FR-012, NFR-001, NFR-003).
`.trim();

const TECHNICAL_SPEC_CONTENT = `
### Architecture (ports/adapters)

\`heat_rgb\` est une fonction pure de domaine : \`position (0-100, entier) → 'r;g;b'\`, clampée en entrée sur \`[0, 100]\`. Elle ne fait aucune I/O, ne dépend d'aucun état global, et remplace \`grad_rgb\` comme unique fournisseur de couleur pour la jauge de contexte.
`.trim();

const MECHANICAL_AC_IDS = [
  "AC-010",
  "AC-011",
  "AC-012",
  "AC-013",
  "AC-014",
  "AC-015",
  "AC-016",
];
const SUBJECTIVE_AC_IDS = [
  "AC-001",
  "AC-002",
  "AC-003",
  "AC-004",
  "AC-005",
  "AC-006",
  "AC-007",
  "AC-008",
  "AC-009",
];
const FR_IDS = Array.from(
  { length: 12 },
  (_, i) => `FR-${(i + 1).toString().padStart(3, "0")}`,
);

describe("classifyClaimTier — calibrated against run_mrlqa0aj_u2rh15's real 29 claims", () => {
  const acClaims = extractClaims("acceptance_criteria", ACCEPTANCE_CRITERIA_CONTENT);
  const frClaims = extractClaims("requirements", REQUIREMENTS_CONTENT);
  const archClaims = extractClaims("technical_specification", TECHNICAL_SPEC_CONTENT);

  it("extracts exactly the 16 AC + 12 FR + 1 ARCH claims the real run produced", () => {
    expect(acClaims).toHaveLength(16);
    expect(frClaims).toHaveLength(12);
    expect(archClaims).toHaveLength(1);
    expect(archClaims[0].claim_id).toBe("ARCH-PORTS-AND-ADAPTERS");
  });

  it.each(MECHANICAL_AC_IDS)(
    "%s (names an explicit grep/diff/time/exit-status verification method) → mechanical",
    (id) => {
      const claim = acClaims.find((c) => c.claim_id === id);
      expect(claim).toBeDefined();
      expect(classifyClaimTier(claim!)).toBe("mechanical");
    },
  );

  it.each(SUBJECTIVE_AC_IDS)(
    "%s (asserts a rendered outcome, names no verification method) → subjective",
    (id) => {
      const claim = acClaims.find((c) => c.claim_id === id);
      expect(claim).toBeDefined();
      expect(classifyClaimTier(claim!)).toBe("subjective");
    },
  );

  it("AC-008 — the claim the real multi-judge panel FAILed (mendeleev, 0.60) — stays subjective", () => {
    // The concrete argument for NOT routing semantic ACs to the mechanical
    // tier: a rule-based check (no grep/diff/time marker in AC-008's text)
    // would never have caught the AC ID-collision + rendering-model
    // contradiction the real judge panel found. See claim-tier.ts module doc.
    const ac008 = acClaims.find((c) => c.claim_id === "AC-008")!;
    expect(classifyClaimTier(ac008)).toBe("subjective");
  });

  it.each(FR_IDS)(
    "%s (fr_traceability — design intent, always subjective by construction) → subjective",
    (id) => {
      const claim = frClaims.find((c) => c.claim_id === id);
      expect(claim).toBeDefined();
      expect(classifyClaimTier(claim!)).toBe("subjective");
    },
  );

  it("the architecture claim (ports/adapters) is always subjective by construction", () => {
    expect(classifyClaimTier(archClaims[0])).toBe("subjective");
  });

  it("document-level plan: 7 mechanical, 22 subjective, out of all 29 real claims", () => {
    const claims = extractClaimsFromDocument([
      { type: "requirements", content: REQUIREMENTS_CONTENT },
      { type: "acceptance_criteria", content: ACCEPTANCE_CRITERIA_CONTENT },
      { type: "technical_specification", content: TECHNICAL_SPEC_CONTENT },
    ]);
    expect(claims).toHaveLength(29);
    const mechanical = claims.filter((c) => classifyClaimTier(c) === "mechanical");
    const subjective = claims.filter((c) => classifyClaimTier(c) === "subjective");
    expect(mechanical).toHaveLength(7);
    expect(subjective).toHaveLength(22);
  });
});

describe("classifyClaimTier — conservative-by-default behavior", () => {
  it("an eligible claim_type with NO named verification method stays subjective", () => {
    const claim = {
      claim_id: "TEST-001",
      claim_type: "test_coverage" as const,
      text: "Test function: test_login",
      evidence: "def test_login(): assert login(user) is not None",
    };
    expect(classifyClaimTier(claim)).toBe("subjective");
  });

  it("a data_model claim naming an explicit diff check → mechanical", () => {
    const claim = {
      claim_id: "DDL-001-USERS",
      claim_type: "data_model" as const,
      text: "Schema definition: users",
      evidence: "Given the schema diff before/after, no modification is made to `users`.",
    };
    expect(classifyClaimTier(claim)).toBe("mechanical");
  });

  it("architecture claims stay subjective even when the text mentions grep", () => {
    const claim = {
      claim_id: "ARCH-TEST",
      claim_type: "architecture" as const,
      text: "Architecture pattern claim: hexagonal",
      evidence: "grep confirms the ports/adapters boundary is respected.",
    };
    expect(classifyClaimTier(claim)).toBe("subjective");
  });

  it("fr_traceability claims stay subjective even when the text mentions grep/diff", () => {
    const claim = {
      claim_id: "FR-999",
      claim_type: "fr_traceability" as const,
      text: "Functional requirement: grep confirms no dead code remains after the diff",
      evidence: "codebase finding",
    };
    expect(classifyClaimTier(claim)).toBe("subjective");
  });
});
