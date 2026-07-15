/** One bilingual concept: the phrases that signal it, per language. */
export interface LexiconConcept {
  readonly en: readonly string[];
  readonly fr: readonly string[];
}
