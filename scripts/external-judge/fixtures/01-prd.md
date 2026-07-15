# PRD: Mettre la jauge de contexte de session-optimizer en conformité avec le design system AI-ARCHITECT.TOOLS (issue #4). Constat post-merge PR #3 (v1.4.2) : la fonction grad_rgb produit un dégradé continu ok→warn→accent→danger par interpolation RGB entre ancres, ce qui n'est pas conforme à la DA. La skill ai-architect-tools-design prescrit vraisemblablement des jauges/meters à paliers sémantiques discrets (pas d'interpolation continue entre familles sémantiques) et l'accent terracotta ne doit probablement pas servir d'ancre dans une rampe d'état. Objectif : remplacer le dégradé continu par le comportement prescrit par le DS (seuils/paliers discrets, familles de couleurs sémantiques correctes), sans régression fonctionnelle de la jauge (statusline de consommation de contexte).

Run ID: run_mrlqa0aj_u2rh15
Context: mvp

## Overview

## Overview

La jauge de contexte de session-optimizer (statusline, fonction `grad_rgb`/`make_bar` dans `statusline-command.sh`) affiche la consommation de budget de session par interpolation RGB continue entre ancres de couleur. Cette implémentation viole la gate G6 du design system AI-ARCHITECT.TOOLS (« No gradients except the heat track, no backdrop-filter, no glow ») : soit la jauge est un gradient interdit, soit elle doit être traitée comme le heat track et adopter sa palette dédiée — ce que PR #3 (v1.4.2) n'a que partiellement corrigé en retirant l'ancre terracotta de la rampe mais en conservant l'interpolation continue à deux segments. L'audience est le développeur utilisateur de Claude Code qui lit la statusline en continu pendant une session ; toute correction doit rester lisible en un coup d'œil, sans dégrader le signal d'alerte au seuil de checkpoint (~180K/200K selon le modèle).

Le succès se mesure par la conformité stricte à G6 : suppression de toute interpolation continue au profit de 4 paliers discrets et alignés sur le seuil de checkpoint (0-49/50-74/75-89/90-100 %), adoption d'une rampe heat mono-famille dérivée des tokens DS existants (ink-muted → ink → terracotta atténué → terracotta plein, sans vert/jaune/rouge), rendu segmenté (chaque cellule remplie garde la couleur de son palier), et absence de régression fonctionnelle de la jauge (même précision d'affichage du pourcentage de consommation, même déclenchement visuel au seuil de checkpoint).

## Goals & Objectives

## Goals & Objectives

- Éliminer le dégradé RGB continu de `grad_rgb` et le remplacer par un rendu à 4 paliers discrets, vérifiable par une revue de code confirmant l'absence de toute interpolation RGB entre couleurs (grep sur les formules de lerp dans `statusline-command.sh`).
- Aligner les seuils visuels de la jauge sur les seuils fonctionnels de checkpoint existants (0-49/50-74/75-89/90-100 %), mesuré par correspondance exacte entre les bornes de palier codées et les constantes de seuil déjà définies pour le checkpoint.
- Adopter exclusivement des tokens de couleur nommés du design system AI-ARCHITECT.TOOLS (ink-muted, ink, terracotta soft, terracotta) pour les 4 paliers, vérifié par absence de toute valeur RGB/hex littérale hors définition des tokens eux-mêmes.
- Rendre la jauge conforme à la gate G6 du DS ("No gradients except the heat track") en la requalifiant explicitement comme heat track segmenté, validé par une relecture de conformité DS documentée dans la PR de clôture de l'issue #4.
- Garantir zéro régression fonctionnelle de la jauge (affichage du pourcentage, déclenchement du seuil de checkpoint à 90 %, cohérence sous tous les terminaux truecolor supportés), mesuré par un test manuel de non-régression comparant le comportement avant/après sur les 4 seuils limites (49→50, 74→75, 89→90, 100 %).
- Conserver l'intégralité de la logique dans `statusline-command.sh` en bash pur avec séquences ANSI truecolor, sans dépendance externe ajoutée, vérifié par diff du fichier ne touchant aucun autre script ni introduisant de nouvel outil.

## Requirements

## Requirements

| ID | Requirement | Priority | Depends On | Source |
|---|---|---|---|---|
| FR-001 | Remplacer `grad_rgb()` (statusline-command.sh:294-303) par une fonction à paliers discrets (ex. `palier_rgb(pos)`) qui retourne l'une des 4 couleurs de palette DS en fonction de `pos`, sans interpolation RGB continue. | Must | — | codebase finding (statusline-command.sh:294-303) ; clarification round 3 |
| FR-002 | Définir 4 paliers de seuil sur `pos` (0-100) alignés sur les seuils checkpoint : palier 1 = 0-49, palier 2 = 50-74, palier 3 = 75-89, palier 4 = 90-100. | Must | FR-001 | clarification round 3 |
| FR-003 | Palier 1 (0-49%) utilise le token DS `ink-muted`. | Must | FR-002 | clarification rounds 4-5 |
| FR-004 | Palier 2 (50-74%) utilise le token DS `ink`. | Must | FR-002 | clarification rounds 4-5 |
| FR-005 | Palier 3 (75-89%) utilise le token DS terracotta atténué. | Must | FR-002 | clarification rounds 4-5 |
| FR-006 | Palier 4 (90-100%) utilise le token DS terracotta plein, avec option d'accentuation (gras) pour marquer l'état critique. | Must | FR-002 | clarification rounds 4-5 |
| FR-007 | Conserver dans `make_bar()` (statusline-command.sh:310-326) le rendu segmenté existant : chaque cellule remplie est colorée selon le palier correspondant à sa position `pos = i*100/(w-1)`, sans changer la logique de remplissage/vide. | Must | FR-001, FR-002 | codebase finding (statusline-command.sh:310-326) ; decision 5 (round 6) |
| FR-008 | Conserver le rendu des cellules vides en `OVERLAY ░` et le `RESET` final de la barre, inchangés par rapport à l'implémentation actuelle. | Must | FR-007 | codebase finding (statusline-command.sh:310-326) |
| FR-009 | Ne pas modifier `token_color()` (statusline-command.sh:329-334) ni la logique GREEN/YELLOW/RED sur `WARN_TOKENS`/`SAVE_TOKENS` : hors périmètre de la jauge. | Must | — | codebase finding (statusline-command.sh:329-334) ; user-request (issue #4 scope) |
| FR-010 | Supprimer toute constante RGB hardcodée héritée du dégradé continu ((101,201,140), (232,170,78), (232,97,84)) une fois la palette à 4 paliers en place. | Must | FR-001 à FR-006 | codebase finding (statusline-command.sh:294-303) |
| FR-011 | La jauge ne doit utiliser aucune couleur vert/jaune/rouge de type sémaphore ; la palette reste mono-famille dérivée de la DA (ink → terracotta). | Must | FR-003 à FR-006 | decision 1 (round 1) |
| FR-012 | La rampe de couleurs ne doit provenir d'aucune nouvelle source de tokens `--heat-*` ; seuls des tokens DS déjà existants sont réutilisés. | Must | FR-003 à FR-006 | decision 2 (round 2) |
| NFR-001 | Conformité gate G6 du design system (SKILL.md : « No gradients (except the heat track), no backdrop-filter, no glow ») : vérifiable par relecture du diff `grad_rgb`/`palier_rgb` confirmant l'absence de toute interpolation continue de couleur (lerp) et l'absence de `backdrop-filter`/effet de lueur dans le rendu ANSI. | Must | FR-001, FR-010 | user-request (issue #4) ; codebase finding (SKILL.md gate G6) |
| NFR-002 | Non-régression fonctionnelle de la jauge (statusline) : test manuel/scripté affichant la barre à des valeurs de `pos` couvrant chacun des 4 paliers (ex. 10, 60, 80, 95) et confirmant que le nombre de cellules remplies, l'ordre gauche-à-droite, et le caractère `░` des cellules vides restent identiques à l'implémentation pré-changement. | Must | FR-007, FR-008 | user-request (« sans régression fonctionnelle de la jauge ») |
| NFR-003 | Portabilité bash pur : la nouvelle fonction à paliers ne doit introduire aucune dépendance externe (pas de `bc`, `awk` flottant, etc.) au-delà de ce qu'utilise déjà `grad_rgb()`/`make_bar()`, vérifiable par relecture du diff limitée aux opérateurs arithmétiques entiers bash natifs (`$(( ))`). | Should | FR-001 | codebase finding (statusline-command.sh — bash pur, ANSI truecolor) |

## User Stories

## User Stories

### US-01 — Paliers discrets remplaçant le dégradé continu

> **Note de correction post-jury (round d'implémentation, issue #4)** : le jury multi-juges (voir `10-verification-report.md`, verdict `mendeleev` FAIL sur AC-008, confiance 0.60) a signalé que les AC-001..AC-004 ci-dessous, tels que rédigés initialement, décrivaient un modèle "barre-uniforme" (« toutes les cellules remplies... ») contradictoire avec le rendu SEGMENTÉ par position décidé en round 6 (FR-007, AC-008 canonique de la section Acceptance Criteria, qui fait foi). Les AC ci-dessous sont reformulées en modèle par-tranche : chaque cellule remplie est colorée selon le palier de SA PROPRE position dans la barre, pas selon le palier du pourcentage total. Un remplissage traversant plusieurs paliers (ex. 80%) produit donc une barre multi-couleurs (5x HEAT_1 + 2x HEAT_2 + 1x HEAT_3 sur 10 cellules), jamais un aplat uniforme.

En tant que développeur utilisateur de Claude Code, je veux que la jauge de contexte affiche 4 paliers de couleur discrets au lieu d'un dégradé RGB continu, afin de percevoir immédiatement dans quelle tranche de consommation je me trouve sans avoir à interpréter une teinte intermédiaire ambiguë.

- AC-001 : Les cellules remplies dont la position se situe dans la tranche 0-49 % sont rendues dans la couleur ink-muted (HEAT_1) — jamais les cellules d'une tranche supérieure.
- AC-002 : Les cellules remplies dont la position se situe dans la tranche 50-74 % sont rendues en ink (HEAT_2).
- AC-003 : Les cellules remplies dont la position se situe dans la tranche 75-89 % sont rendues en terracotta atténué (HEAT_3).
- AC-004 : Les cellules remplies dont la position se situe dans la tranche 90-100 % sont rendues en terracotta plein (HEAT_4) ; l'option gras évoquée en round 6 a été omise dans l'implémentation pour respecter la contrainte "une seule modification" de `make_bar` (voir PR de clôture de l'issue #4 pour la justification).
- AC-005 : La fonction `grad_rgb` (ou son équivalent renommé) ne calcule plus d'interpolation continue de composantes RGB ; elle retourne l'un des 4 triplets de couleur fixes correspondant au palier déterminé par le pourcentage.
- AC-006 : Les bornes exactes 49→50, 74→75 et 89→90 déclenchent un changement de palier visible (test unitaire ou script de vérification manuelle sur ces 3 valeurs pivot).

### US-02 — Rendu segmenté par cellule cohérent avec la position
En tant que développeur utilisateur de Claude Code, je veux que chaque cellule remplie de la jauge conserve la couleur du palier correspondant à sa propre position dans la barre (et non la couleur du palier global final), afin de visualiser la progression comme une accumulation de segments colorés plutôt qu'un aplat uniforme.

- AC-007 : Pour une jauge à N cellules et un pourcentage donné, chaque cellule remplie d'indice i est colorée selon le palier applicable au pourcentage représenté par la position i (et non systématiquement selon le palier du pourcentage total).
- AC-008 : À pourcentage égal à une borne de palier (ex. 75 %), les cellules situées avant la borne affichent la couleur du/des palier(s) inférieur(s) traversé(s), et seule la ou les dernières cellules atteintes affichent la couleur du palier courant — aucun repeint rétroactif de toute la barre dans une seule couleur.
- AC-009 : Les cellules non remplies restent rendues en chrome greyscale neutre (couleur de fond/inactive du design system), sans teinte terracotta ni ink.

### US-03 — Conformité à la gate G6 et à la palette DA AI-ARCHITECT.TOOLS
En tant que relecteur design propriétaire de la DA AI-ARCHITECT.TOOLS, je veux que la jauge de contexte n'utilise aucun dégradé (hors heat track) et respecte strictement la palette ink-muted / ink / terracotta atténué / terracotta plein, afin de valider la conformité à la gate G6 sans dérogation.

- AC-010 : Une revue du script `statusline-command.sh` ne fait apparaître aucune interpolation de couleur (pas de boucle de calcul RGB progressif) appliquée à la jauge de contexte — seules des affectations de couleur fixes par palier sont présentes.
- AC-011 : Les 4 couleurs utilisées correspondent exactement aux valeurs ANSI truecolor définies pour ink-muted, ink, terracotta atténué et terracotta plein dans le design system AI-ARCHITECT.TOOLS (pas de vert, jaune, rouge, ni toute autre teinte hors palette).
- AC-012 : Aucune autre partie de la statusline (hors heat track explicitement exempté) n'introduit de dégradé continu à l'occasion de ce changement.
- AC-013 : Le contrôle de conformité gate G6 (script ou checklist du SKILL.md) passe au vert sur `statusline-command.sh` après modification.

### US-04 — Non-régression fonctionnelle et alignement sur le seuil de checkpoint
En tant que développeur utilisateur de Claude Code, je veux que le changement de rendu de la jauge n'altère ni le calcul du pourcentage de contexte ni le comportement du seuil de checkpoint à 90 %, afin de continuer à me fier au même signal de décision qu'avant la migration visuelle.

- AC-014 : Le pourcentage de contexte affiché en texte à côté de la jauge reste strictement identique (même valeur numérique, même source de calcul) avant et après le changement, pour un même état de session.
- AC-015 : Le palier terracotta plein (90-100 %) démarre exactement à la valeur de seuil de checkpoint définie par `~/.claude/ctxguard-thresholds.json` pour le modèle courant, sans décalage.
- AC-016 : L'exécution de `statusline-command.sh` sur un jeu de pourcentages de référence (0, 25, 49, 50, 74, 75, 89, 90, 100) ne produit aucune erreur bash, aucun code ANSI mal formé, et un temps d'exécution non dégradé par rapport à la version précédente.
- AC-017 : Aucune autre fonctionnalité de la statusline (nom de session, modèle, coût, etc.) n'est modifiée par ce changement — diff limité à la logique de couleur/rendu de la jauge de contexte.

## Technical Specification

## Technical Specification

### Architecture (ports/adapters)

`heat_rgb` est une fonction pure de domaine : `position (0-100, entier) → 'r;g;b'`, clampée en entrée sur `[0, 100]`. Elle ne fait aucune I/O, ne dépend d'aucun état global, et remplace `grad_rgb` comme unique fournisseur de couleur pour la jauge de contexte.

Le bloc palette (constantes `HEAT_1`..`HEAT_4`, seuils nommés `HEAT_T2=50`, `HEAT_T3=75`, `HEAT_T4=90`) constitue la racine de composition : il fige les valeurs dérivées de la charte AI-ARCHITECT.TOOLS avant tout appel à `heat_rgb`, qui se contente de les sélectionner par comparaison de seuils — aucune valeur n'est calculée dans le chemin d'exécution.

`make_bar` reste l'unique adaptateur de rendu ANSI. Seule sa ligne d'appel de couleur change : `grad_rgb "$pct"` → `heat_rgb "$pct"`. Le contrat de sortie de `make_bar` (largeur, clamp `[0, w]`, séquence `\033[38;2;r;g;bm`) est inchangé.

### Palette et dérivation des couleurs

| Palier | RGB | Hex | Token DS | Dérivation |
|---|---|---|---|---|
| HEAT_1 (0-49%) | `136;134;130` | `#888682` | `--fg-2` | valeur DS existante, reprise telle quelle |
| HEAT_2 (50-74%) | `192;189;186` | `#c0bdba` | `--fg-1` | valeur DS existante, reprise telle quelle |
| HEAT_3 (75-89%) | (calculée) | (calculée) | terracotta atténué | pipeline oklch→srgb existant, ancre `oklch(64% 0.14 47)` (= `--accent`) avec chroma réduite à `oklch(64% 0.08 47)` ; valeur RGB recalculée par le pipeline, jamais estimée à la main |
| HEAT_4 (90-100%) | `207;110;57` | `#cf6e39` | `--accent` (PEACH) | réutilisation directe de la constante `PEACH` existante |

Le palier 4 peut activer `\033[1m` (gras) en complément, à valider visuellement avant merge ; s'il n'apporte rien, il est omis.

### Suppression de code mort

`grad_rgb` et ses 6 constantes de lerp sont supprimées intégralement : recherche préalable confirmant l'absence de tout autre appelant, aucun alias, aucun shim. Le commentaire G4 de `PEACH` est mis à jour pour refléter son second usage légitime (palier HEAT_4) sous l'exception G6 heat track.

### Contraintes transverses (portée : script local)

**Contrôle d'accès explicite.** Toutes les fonctions introduites ou modifiées (`heat_rgb`, `make_bar`) sont internes au script, documentées comme telles ; aucune n'est exportée (`export -f` absent), surface exposée hors process nulle. Fichiers lus limités à `$HOME/.claude/*` en permissions utilisateur (0644) ; ni `sudo` ni écriture hors caches dédiés.

**Réutilisabilité.** `heat_rgb` et les constantes `HEAT_*` centralisées dans un unique bloc palette, réutilisables par tout futur indicateur suivant le motif « fonction pure + constantes injectées » ; noms auto-documentés.

**Validation des entrées.** Chaque entrée externe validée à la frontière : JSON stdin parsé via `jq` avec défauts, pourcentage testé numérique (`[ "$p" -eq "$p" ] 2>/dev/null`) avant usage ; seuils de `ctxguard-thresholds.json` avec défauts sûrs ; clamp `[0,100]` dans `heat_rgb`, clamp `[0,w]` dans `make_bar`.

**Prévention d'injection / encodage de sortie.** Aucun `eval`, aucune commande construite depuis une entrée ; toutes les expansions quotées (`"$var"`) ; sorties via `printf '%s'` (jamais de valeur externe comme chaîne de format) ; séquences ANSI restreintes à une liste blanche fixe construite uniquement depuis les constantes `HEAT_*`/`PEACH`.

**Autorisation.** Modèle = permissions POSIX de l'utilisateur invoquant ; jamais d'élévation de privilèges ; aucun endpoint réseau ni IPC ; lectures bornées aux fichiers de l'utilisateur.

**Gestion d'erreur sûre et dégradation gracieuse.** Entrée invalide / fichier manquant / pourcentage incalculable → jauge omise silencieusement, le reste de la statusline s'affiche (pas de défaillance en cascade). Aucun chemin interne, trace ou contenu de config dans la sortie ; `stderr` étouffé sur les chemins de parsing (`2>/dev/null` existants). Pas de retry réseau car aucun appel réseau (vérifiable : `grep -c -E 'curl|wget' statusline-command.sh` = 0).

**Standards cryptographiques et données sensibles.** Aucun secret ni credential manipulé ; interdiction explicite d'introduire token/clé API dans ce script — tout besoin futur passera par le trousseau macOS (`security`). Données traitées = compteurs de tokens et pourcentages, non personnels ; aucun contenu de conversation, chemin de transcript ou identifiant ne transite dans la sortie ; le script n'écrit aucun log — seule sortie = ligne ANSI de la statusline.

**Minimisation des données.** Seuls les champs strictement nécessaires du JSON (tokens de contexte, modèle) sont lus ; rien d'autre extrait ni persisté ; caches locaux limités aux agrégats de coût existants, inchangés.

**Traçabilité et audit.** Assurée par git : toute modification de seuil/couleur passe par commit versionné (qui/quoi/quand) ; script en lecture seule sur sa configuration, aucune opération runtime sensible à journaliser.

**Gestion d'erreur structurée et format cohérent.** Chaque parsing a un défaut nommé documenté ; pas de catch-all masquant ; code de sortie inchangé (0 en dégradation) ; postcondition testée : erreur de conversion → palier `HEAT_1`, jamais une couleur hors palette. Format de dégradation unique = omission du segment, convention documentée en tête de script.

**Nombres magiques et nommage.** Seuils `HEAT_T2/T3/T4` et couleurs `HEAT_1..4` = constantes nommées commentées (hex + token DS + dérivation, format lignes 240-246) ; convention conservée : `UPPER_SNAKE` constantes, `lower_snake` fonctions, préfixe `HEAT_` réservé au heat track.

**Documentation de contrat.** Contrat de `heat_rgb` documenté en commentaire au-dessus de sa définition : entrée (entier 0-100 clampé), sortie (`'r;g;b'` ∈ {HEAT_1..HEAT_4}), échec impossible (fonction totale) ; même format que la doc de `make_bar` (lignes 305-309).

**Observabilité proportionnée.** Rendu local sans télémétrie ; ni service distant ni corrélation inter-service (mono-processus) ; diagnostic par exécution manuelle sur fixture (cf. Testing) ; tout échec immédiatement visible (jauge absente) = signal d'alerte utilisateur.

**Dépendances minimales.** Aucune dépendance ajoutée ; existantes (`bash`, `jq`, `python3` sous-scripts de coût) inchangées ; feature nette négative en LoC (suppression grad_rgb + 6 constantes) ; aucune licence tierce.

**Bornes de transaction et idempotence.** Script en lecture seule sur l'état affiché ; caches de coût écrits atomiquement via verrous existants (`COST_LOCK`, `TXT_LOCK`), non modifiés ; `heat_rgb` pure → deux exécutions sur le même état produisent la même sortie.

### Non-régression et performance (méthode de mesure)

**Correction fonctionnelle.** Exécution sur fixtures `0/25/49/50/74/75/89/90/100 %` ; extraction de chaque séquence `\033[38;2;r;g;bm` (via `grep -oE`) ; vérification d'appartenance exacte du triplet à `{HEAT_1, HEAT_2, HEAT_3, HEAT_4}` — critère binaire, sans tolérance colorimétrique.

**Performance.** `time bash statusline-command.sh < fixture.json`, moyenne sur 20 exécutions vs baseline pré-changement (même machine, même fixture, cache chaud). Budget : régression moyenne `< +5 ms` ; dépassement → investigation avant merge.

## Acceptance Criteria

## Acceptance Criteria

AC-001 : Étant donné un pourcentage de contexte de 25 %, quand `make_bar` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_1 (#888682/--fg-2) (FR-001, FR-003).

AC-002 : Étant donné un pourcentage de contexte de 60 %, quand `make_bar` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_2 (#c0bdba/--fg-1) (FR-001, FR-004).

AC-003 : Étant donné un pourcentage de contexte de 80 %, quand `make_bar` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_3 (terracotta atténué dérivé oklch) (FR-001, FR-005).

AC-004 : Étant donné un pourcentage de contexte de 95 %, quand `make_bar` calcule la couleur de la cellule concernée, alors la couleur retournée est HEAT_4 (#cf6e39/--accent) (FR-001, FR-006).

AC-005 : Étant donné un pourcentage de contexte de 49 %, quand la cellule est rendue, alors elle utilise HEAT_1 ; et étant donné 50 %, alors la cellule bascule sur HEAT_2 — sans valeur intermédiaire interpolée (FR-002, FR-003, FR-004).

AC-006 : Étant donné un pourcentage de contexte de 74 %, quand la cellule est rendue, alors elle utilise HEAT_2 ; et étant donné 75 %, alors la cellule bascule sur HEAT_3 — sans valeur intermédiaire interpolée (FR-002, FR-004, FR-005).

AC-007 : Étant donné un pourcentage de contexte de 89 %, quand la cellule est rendue, alors elle utilise HEAT_3 ; et étant donné 90 %, alors la cellule bascule sur HEAT_4 — sans valeur intermédiaire interpolée (FR-002, FR-005, FR-006).

AC-008 : Étant donné une jauge dont le remplissage traverse plusieurs paliers (ex. 0-90 %), quand `make_bar` génère la barre, alors chaque cellule pleine est colorée individuellement selon son palier propre (rendu segmenté multi-couleurs) (FR-007).

AC-009 : Étant donné une jauge partiellement remplie, quand les cellules au-delà du seuil de remplissage sont rendues, alors elles conservent le caractère OVERLAY ░ et son style existant (FR-008).

AC-010 : Étant donné le code source de `make_bar` après modification, quand on l'inspecte, alors aucune fonction ou expression de type lerp/interpolation continue (grad_rgb ou équivalent) n'est présente (FR-001, FR-010).

AC-011 : Étant donné le code source complet du module modifié, quand on grep les constantes de couleur, alors aucune référence à des couleurs vertes, jaunes ou rouges (ni littérales ni via variables héritées) n'est trouvée dans la jauge (FR-011).

AC-012 : Étant donné le code source complet du module modifié, quand on grep les tokens `--heat-*`, alors aucune occurrence n'est trouvée en tant que source de couleur (FR-012).

AC-013 : Étant donné le module `token_color`, quand on diffe le fichier avant/après, alors aucune modification n'y est apportée (FR-009).

AC-014 : Étant donné le jeu de valeurs {0, 25, 49, 50, 74, 75, 89, 90, 100}, quand le script est exécuté pour chacune, alors chaque exécution se termine sans erreur et produit un rendu de barre avec la couleur de palier attendue (FR-002 à FR-006, NFR-002).

AC-015 : Étant donné une exécution `time` moyennée sur 20 runs du script avant et après modification, quand on compare les deux moyennes, alors le delta est inférieur à +5 ms (NFR-002).

AC-016 : Étant donné le diff final soumis, quand on l'inspecte, alors il ne contient que des modifications bash pures dans session-optimizer (aucune dépendance externe ajoutée) et passe la gate G6 (FR-001 à FR-012, NFR-001, NFR-003).
