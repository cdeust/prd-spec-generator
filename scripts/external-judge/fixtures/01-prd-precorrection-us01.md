# session-optimizer PRD excerpt (pre-correction) — issue #4 / run_mrlqa0aj_u2rh15

Historical/reconstructed excerpt used ONLY for claim AC-008's calibration
prompt — see `fixtures/ground-truth.json`'s `provenance.note_on_ac008` for
full sourcing (what is verbatim-quoted from git vs. reconstructed, and
why). Every other claim in this fixture set is prompted from the
corrected `fixtures/01-prd.md`.

### US-01 — Paliers discrets remplaçant le dégradé continu (texte pré-correction, avant round d'implémentation issue #4)

En tant que développeur utilisateur de Claude Code, je veux que la jauge
de contexte affiche 4 paliers de couleur discrets au lieu d'un dégradé
RGB continu, afin de percevoir immédiatement dans quelle tranche de
consommation je me trouve sans avoir à interpréter une teinte
intermédiaire ambiguë.

- AC-001 : Étant donné un pourcentage de contexte dans la tranche 0-49 %,
  toutes les cellules remplies de la jauge sont rendues dans la couleur
  ink-muted (HEAT_1).
- AC-002 : Étant donné un pourcentage de contexte dans la tranche 50-74 %,
  toutes les cellules remplies de la jauge sont rendues en ink (HEAT_2).
- AC-003 : Étant donné un pourcentage de contexte dans la tranche 75-89 %,
  toutes les cellules remplies de la jauge sont rendues en terracotta
  atténué (HEAT_3).
- AC-004 : Étant donné un pourcentage de contexte dans la tranche
  90-100 %, toutes les cellules remplies de la jauge sont rendues en
  terracotta plein (HEAT_4).

## Requirements (excerpt — FR-007, canonical, unchanged by the correction)

| ID | Requirement | Priority | Depends On | Source |
|---|---|---|---|---|
| FR-007 | Conserver dans `make_bar()` (statusline-command.sh:310-326) le rendu segmenté existant : chaque cellule remplie est colorée selon le palier correspondant à sa position `pos = i*100/(w-1)`, sans changer la logique de remplissage/vide. | Must | FR-001, FR-002 | codebase finding (statusline-command.sh:310-326) ; decision 5 (round 6) |

## Acceptance Criteria (excerpt — AC-008, canonical section, unchanged by the correction)

AC-008 : Étant donné une jauge dont le remplissage traverse plusieurs
paliers (ex. 0-90 %), quand `make_bar` génère la barre, alors chaque
cellule pleine est colorée individuellement selon son palier propre
(rendu segmenté multi-couleurs) (FR-007).

## Open item (US section / canonical section ID collision)

The User Stories section above runs its own AC-001..AC-017 (US-01
through US-04, not all shown in this excerpt); the canonical Acceptance
Criteria section separately runs AC-001..AC-016. Two disjoint numbering
spaces share IDs — never renumbered or merged (open item,
`10-verification-report.md:25`).

Note for the judge: FR-007 and AC-008 both describe a segmented,
per-cell render (a fill spanning multiple paliers produces a
multi-color bar). US-01's AC-001..AC-004 above describe the opposite —
a uniform-fill render where "toutes les cellules remplies" (all filled
cells, regardless of position) take a single palier's color for a given
overall percentage. Assess whether this is a genuine contradiction, and
whether the AC-001..017/AC-001..016 numbering collision is a residual
risk worth flagging even independent of your verdict.
