# claude-mods

Des mods pour Claude Code (2.1.28x et plus), utilisables par tout le monde.

| Mod | Ce que ça fait | Où |
| --- | --- | --- |
| `clawd` | Clawd, la mascotte de Claude Code, vit dans un petit bureau et mime ce que fait Claude : il lit à la bibliothèque, code au bureau, tape au terminal, part sur le web. Il naît dans un œuf et évolue avec les tokens traités (de l'œuf à LEGEND à 10M), sa gemme dit son modèle. Les sous-agents apparaissent en mini-Clawds, les autres sessions de la machine entrent dans le bureau, la fenêtre et l'horloge suivent l'heure, un HUD de jeu montre le contexte et les limites. Pixel art sur desktop et mobile ; dans le terminal, la pièce est redessinée en caractères (Clawd comme le logo du CLI), nette dans n'importe quel panneau. `/clawd` | desktop, mobile, terminal |
| `vignettes` | Les images que Claude lit (Read), partage (SendUserFile) ou reçoit d'un outil MCP (captures d'écran) s'affichent en miniature dans le terminal, en demi-blocs colorés (tmux compris) ou en vraies images sur kitty, Ghostty et WezTerm. `/voir` ouvre une galerie, lisible aussi depuis le téléphone. | terminal ; galerie partout |
| `terminal-distant` | `/terminal` ouvre un shell dans un panneau : depuis l'appli desktop, VS Code ou le téléphone connecté en Remote Control, on lance des commandes sur la machine de la session (sortie en direct, `cd` retenu, Stop) et on peut joindre une sortie à son prochain message. | desktop, VS Code, mobile (boutons) |
| `apercu` | `/apercu` affiche en direct dans un panneau ce que Claude construit, même quand la session tourne sur une autre machine (Remote Control) : un site (Chromium, ou Electron par CDP), une app Android (adb, émulateur ou téléphone), un simulateur iOS, un client lourd ou n'importe quel écran, un jeu Unity (adaptateur fourni), ou tout ce qui parle le [protocole Aperçu](apercu/PROTOCOLE.md). Claude fait l'intégration lui-même (skill `apercu:integrer`) : il reconnaît le type de projet, choisit le pilote, écrit un adaptateur si besoin, monte le pont réseau (localhost, réseau local, VPN, SSH, et un tunnel seulement si tu l'acceptes) et décrit le tout dans `.apercu.json`. On touche par repères numérotés (boutons, champs) ou, pour un jeu, par une grille (`C4`). Plusieurs cibles s'affichent en onglets. Claude pilote la même cible avec l'outil `apercu` : tu vois ses tests en direct, et les erreurs (console, journal Unity) s'affichent. | desktop, mobile, terminal |
| `recap` | `/recap` résume la session (fait, en attente, prochaines étapes) dans un panneau, sans rien ajouter à la conversation. Bouton Copier. | partout |
| `masque-secrets` | Les mots de passe et jetons de tes fichiers `.env` sont remplacés par `[secret:NOM]` dans ce que les outils renvoient au modèle. | partout |

## Installer

```sh
claude plugin marketplace add tibzejoker/claude-mods
claude plugin install clawd@claude-mods
```

Remplace `clawd` par le mod voulu. Ou pour essayer sans installer, depuis un clone : `claude --plugin-dir ./clawd`.

Dans le terminal, `ctrl+x tab` (ou un clic) donne le clavier au panneau de `clawd` : `p` caresse Clawd, `s` lui donne un cookie, `d` le fait danser, `1` `2` `3` ouvrent les menus, `Esc` rend la main.

## Limites connues

- `apercu` : le hub est en Python ; chaque pilote a ses dépendances (`playwright` pour le web, `pillow` partout, `mss` et `pynput` ou `python-xlib` pour un écran, `adb`, `xcrun` et `idb` pour iOS). Claude les installe au besoin. Un émulateur Android demande une machine avec virtualisation ; sinon, un téléphone en Wi-Fi ou par VPN. L'adaptateur Unity n'a pas encore été compilé dans un vrai projet.

- `vignettes` décode le PNG lui-même ; JPEG, WebP, GIF et HEIC passent par le premier outil trouvé sur la machine (ImageMagick, ffmpeg, sips sur macOS, Pillow).
- `terminal-distant` n'est pas un vrai TTY : pas de vim ni de top, pas de saisie pendant qu'une commande tourne. Les commandes tournent avec tes droits, sans passer par les permissions de Claude : c'est toi qui tapes, pas le modèle.

## Licence

MIT, voir [LICENSE](LICENSE).
