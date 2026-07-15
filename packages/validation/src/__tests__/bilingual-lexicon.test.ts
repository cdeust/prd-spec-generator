/**
 * French-fixture regression coverage for the rule families migrated to the
 * shared lexicon (packages/validation/src/hard-output-rules/rules/lexicon.ts)
 * as the mechanism-level follow-up to commit f346204.
 *
 * f346204 fixed 5 rules (cryptographic_standards, rate_limiting_required,
 * secure_communication, consent_and_erasure_support, distributed_tracing)
 * plus no_magic_numbers/consistent_naming under time pressure during e2e
 * incident run_mrlqa0aj_u2rh15, and self-flagged that every OTHER
 * hasExplicitOptOut/keyword-list rule would reproduce the same bug class on
 * a French PRD. This file pins that fix for the remaining families named in
 * the follow-up: auth_on_every_endpoint, data_classification_required,
 * sensitive_data_protection, audit_trail_required, no_pii_in_observability,
 * structured_logging, alerting_thresholds — plus the opt-out escapes added
 * during the audit (input_validation_required,
 * output_encoding_injection_prevention, security_safe_error_handling,
 * api_contract_documentation, deprecation_strategy) that had none at all
 * before this change, the same defect class f346204 found in
 * cryptographic_standards.
 *
 * Each test is a Toulmin claim-evidence pair: French prose that covers the
 * rule's topic is not flagged (evidence: the rule's own English-language
 * regression is unaffected, checked in validation.test.ts).
 */

import { describe, expect, it } from "vitest";
import { validateSection } from "../index.js";

describe("bilingual detection — auth_on_every_endpoint (French)", () => {
  it("is satisfied when authN and authZ are both covered in French", () => {
    const content = `## Spécification Technique

Authentification : JWT porteur de jeton avec session côté serveur.
Autorisation : contrôle d'accès basé sur les rôles (RBAC), permissions
vérifiées à chaque appel.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("auth_on_every_endpoint")).toBe(false);
  });

  it("is exempted by a French opt-out near the auth topic", () => {
    const content = `## Spécification Technique

Authentification et autorisation : non applicable — ce script local ne
possède aucun point de terminaison exposé, aucun appelant distant.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("auth_on_every_endpoint")).toBe(false);
  });

  it("still flags auth in French when neither signal nor opt-out is present", () => {
    const content = `## Spécification Technique

Le service expose une API REST pour la gestion des commandes.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("auth_on_every_endpoint")).toBe(true);
  });
});

describe("bilingual detection — data_classification_required (French)", () => {
  it("is satisfied when classification levels are named in French", () => {
    const content = `## Spécification Technique

Classification des données : les champs sont classifiés selon un niveau de
sensibilité (public / interne / confidentiel / restreint) ; les données
personnelles sont marquées comme données sensibles.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("data_classification_required")).toBe(false);
  });

  it("is exempted by a French opt-out near the data-classification topic", () => {
    const content = `## Spécification Technique

Classification des données : sans objet — ce script ne manipule aucune
donnée personnelle ni donnée sensible, uniquement des fichiers de
configuration publics.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("data_classification_required")).toBe(false);
  });
});

describe("bilingual detection — sensitive_data_protection (French)", () => {
  it("is satisfied when 2+ protection categories are covered in French", () => {
    const content = `## Spécification Technique

Chiffrement au repos (AES) pour les champs sensibles. Masquage des
identifiants de connexion dans les journaux. Contrôle d'accès aux données
selon le principe du moindre privilège.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("sensitive_data_protection")).toBe(false);
  });

  it("is exempted by a French opt-out near the sensitive-data topic", () => {
    const content = `## Spécification Technique

Protection des données sensibles : non applicable — aucune donnée
personnelle, aucun secret, aucun identifiant traité par ce script.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("sensitive_data_protection")).toBe(false);
  });
});

describe("bilingual detection — audit_trail_required (French)", () => {
  it("is satisfied when an audit trail is described in French", () => {
    const content = `## Spécification Technique

Une piste d'audit inviolable enregistre qui a fait quoi pour chaque
événement d'authentification et chaque accès aux données.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("audit_trail_required")).toBe(false);
  });

  it("is exempted by a French opt-out near the audit topic", () => {
    const content = `## Spécification Technique

Piste d'audit : sans objet — script d'exécution locale sans accès aux
données et sans événement de conformité à consigner.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("audit_trail_required")).toBe(false);
  });
});

describe("bilingual detection — no_pii_in_observability (French)", () => {
  it("is satisfied when PII exclusion from logs/metrics/traces is stated in French", () => {
    const content = `## Spécification Technique

Aucune donnée personnelle dans les journaux : les identifiants sont
masqués avant écriture, les métriques et traces excluent les données
sensibles par construction.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("no_pii_in_observability")).toBe(false);
  });

  it("is exempted by a French opt-out near the pii-observability topic", () => {
    const content = `## Spécification Technique

Observabilité et données personnelles : non applicable — ce script
n'émet aucun journal, aucune métrique, aucune trace contenant des
données personnelles.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("no_pii_in_observability")).toBe(false);
  });
});

describe("bilingual detection — structured_logging (French)", () => {
  it("is satisfied when log format and levels are described in French", () => {
    const content = `## Spécification Technique

Journalisation structurée au format JSON. Niveaux de journalisation :
debug, avertissement, erreur, critique, selon la gravité de l'événement.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("structured_logging")).toBe(false);
  });

  it("is exempted by a French opt-out near the structured-logging topic", () => {
    const content = `## Spécification Technique

Journalisation : non applicable — script d'une seule exécution sans
sortie de journal persistante ni format de journal à définir.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("structured_logging")).toBe(false);
  });
});

describe("bilingual detection — alerting_thresholds (French)", () => {
  it("is satisfied when alerting/escalation is described in French", () => {
    const content = `## Spécification Technique

Alerte déclenchée au franchissement du seuil critique, avec escalade vers
l'astreinte et notification via la réponse aux incidents.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("alerting_thresholds")).toBe(false);
  });

  it("is exempted by a French opt-out near the alerting topic", () => {
    const content = `## Spécification Technique

Alerting : non applicable — script exécuté ponctuellement en local, sans
astreinte ni réponse aux incidents en production.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("alerting_thresholds")).toBe(false);
  });
});

describe("bilingual detection — rules newly given an opt-out escape (French)", () => {
  // These rules previously had NO opt-out path at all (the defect class
  // f346204 found in cryptographic_standards), found during this audit.

  it("input_validation_required is exempted by a French opt-out", () => {
    const content = `## Spécification Technique

Validation des entrées : non applicable — ce script ne reçoit aucune
entrée externe, aucune entrée utilisateur, aucune requête réseau.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("input_validation_required")).toBe(false);
  });

  it("output_encoding_injection_prevention is exempted by a French opt-out", () => {
    const content = `## Spécification Technique

Injection et encodage de sortie : non applicable — le script ne
construit aucune requête SQL et ne génère aucune sortie HTML.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("output_encoding_injection_prevention")).toBe(false);
  });

  it("security_safe_error_handling is exempted by a French opt-out", () => {
    const content = `## Spécification Technique

Erreur destinée au client : non applicable — script en ligne de
commande sans réponse d'erreur envoyée à un client distant.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("security_safe_error_handling")).toBe(false);
  });

  it("api_contract_documentation is exempted by a French opt-out", () => {
    const content = `## Spécification Technique

Contrat d'API : non applicable — ce script n'expose aucune interface
publique, aucun point de terminaison.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("api_contract_documentation")).toBe(false);
  });

  it("deprecation_strategy is exempted by a French opt-out", () => {
    const content = `## Spécification Technique

Dépréciation : non applicable — script interne à usage unique, aucune
API publique dont la version évoluerait.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("deprecation_strategy")).toBe(false);
  });
});

describe("bilingual detection — regression: English fixtures for the audited rules unchanged", () => {
  it("auth_on_every_endpoint still flags an English spec missing authZ", () => {
    const content = `## Technical Specification

Authentication: JWT bearer tokens with server-side session validation.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("auth_on_every_endpoint")).toBe(true);
  });

  it("input_validation_required is still satisfied by English signals (no opt-out needed)", () => {
    const content = `## Technical Specification

Input validation: schema validation and sanitization at every request
boundary. Reject invalid payloads with a 400.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("input_validation_required")).toBe(false);
  });

  it("structured_logging is still satisfied by English signals (no opt-out needed)", () => {
    const content = `## Technical Specification

Structured JSON logging with log levels DEBUG/INFO/WARN/ERROR.
`;
    const report = validateSection(content, "technical_specification");
    const rules = new Set(report.violations.map((v) => v.rule));
    expect(rules.has("structured_logging")).toBe(false);
  });
});
