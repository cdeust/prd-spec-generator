import type { LexiconConcept } from "./lexicon-types.js";

/**
 * Cross-cutting concept fragments used by more than one rule family's
 * bilingual detection (opt-out markers, and the generic "error"/"security"/
 * "sensitive"/"log"/negation-word fragments composed into broader-signal
 * checks in security-rules.ts, data-protection-rules.ts, and
 * observability-rules.ts). Split out of lexicon.ts to keep every lexicon
 * file under the 500-line hard limit (coding-standards.md §4.1).
 */
export const SHARED_LEXICON = {
  // -----------------------------------------------------------------------
  // Opt-out escape — shared by every rule that supports an explicit N/A.
  // -----------------------------------------------------------------------
  optOut: {
    en: [
      "n/a",
      "not applicable",
      "by construction",
      "no network",
      "no database",
      "no endpoint",
      "no public surface",
      "no public interface",
      "no http",
      "no rest",
      "no graphql",
      "no grpc",
      "no users",
      "no caller",
      "no remote",
      "no service",
      "no api",
      "absent surface",
      "no attack surface",
      "out of scope",
    ],
    fr: [
      "non applicable",
      "n'est pas applicable",
      "sans objet",
      "hors champ",
      "hors périmètre",
      "hors du périmètre",
      "de par sa construction",
      "par construction",
      "aucun réseau",
      "pas de réseau",
      "aucun appel réseau",
      "aucune base de données",
      "aucun point de terminaison",
      "pas de point de terminaison",
      "aucune interface publique",
      "aucune surface publique",
      "aucun utilisateur",
      "aucun appelant",
      "aucun service distant",
      "aucune api",
      "surface d'attaque absente",
      "aucune surface d'attaque",
    ],
  },
  errorTermSignals: {
    en: ["error"],
    fr: ["erreur"],
  },
  securityOrSensitiveTermSignals: {
    en: ["secur", "sensitive"],
    fr: ["sécur", "sensible"],
  },
  sensitiveTermSignals: {
    en: ["sensitive"],
    fr: ["sensible", "sensibles"],
  },
  logTermSignals: {
    en: ["log"],
    fr: ["journal", "journaux", "journalisation"],
  },
  negationActionSignals: {
    en: ["never", "must not", "exclude", "prevent"],
    fr: ["jamais", "ne doit pas", "exclure", "empêcher"],
  },
} as const satisfies Record<string, LexiconConcept>;
