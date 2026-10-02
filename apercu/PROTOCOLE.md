# Le protocole Aperçu (v1)

Tout ce qui sait **donner une image** et **recevoir un geste** peut s'afficher dans le panneau Aperçu : un jeu Unity, Godot ou Unreal, une app desktop Qt, WPF ou Swift, une app mobile en debug, un émulateur, une machine distante. Il suffit d'un petit adaptateur qui parle ce protocole. Les pilotes intégrés du hub (`web`, `adb`, `ios`, `ecran`) le parlent déjà. `apercu.py expose` sert l'un d'eux sur une autre machine.

Tout est en JSON sur HTTP. Les images sont des JPEG en base64.

## Les deux sens

Un adaptateur choisit **l'un des deux** :

| Sens | Qui ouvre la connexion | Quand le choisir |
| --- | --- | --- |
| **entrant** (`pilote: "pont"` sans `url`) | l'adaptateur appelle le hub | La cible est derrière un NAT, sur un téléphone, dans un moteur de jeu qui sait faire des requêtes mais pas servir. C'est le plus simple à écrire. |
| **sortant** (`pilote: "pont"` avec `url`) | le hub appelle l'adaptateur | L'adaptateur sait servir HTTP et le hub peut le joindre. |

### Entrant : l'adaptateur appelle le hub

Toutes les requêtes portent `Authorization: Bearer <jeton>`, le `jeton` de la cible dans `.apercu.json`.

```
POST {hub}/pont/{nom}/push     une image, à chaque changement (3 à 5 par seconde au plus)
  { "jpeg": "<base64>", "w": 1920, "h": 1080,
    "hints": [ { "x": 10, "y": 20, "w": 120, "h": 40, "cx": 70, "cy": 40,
                 "label": "Jouer", "kind": "bouton", "id": "MainMenu/Play" } ],
    "url": "unity://MainMenu", "logs": [ { "kind": "erreur", "text": "NullReference…" } ] }

GET  {hub}/pont/{nom}/pull?wait=20     attend des actions (longue attente, 20 s au plus)
  → { "ok": true, "actions": [ { "id": 7, "type": "tap", "x": 640, "y": 360 }, … ] }

POST {hub}/pont/{nom}/done     le résultat de chaque action, avec son id
  { "id": 7, "ok": true, "text": "touché « Jouer »" }      ou { "id": 7, "ok": false, "error": "…" }
```

Le hub attend la réponse 15 s. Une action non confirmée remonte en erreur à Claude.

### Sortant : le hub appelle l'adaptateur

```
GET  /state                    → { "url", "vw", "vh", "hints", "console": [{ "at", "kind", "text" }] }
GET  /frame?fmt=raw            → la même chose, plus "jpeg" (base64), "w" et "h"
POST /act { "type": … }        → { "ok": true, "last": { "text": "…" } }   ou { "ok": false, "error": "…" }
```

## Coordonnées

`w` × `h` est l'espace où vivent les repères et les touches. C'est celui que l'adaptateur sait viser : pixels de l'écran, points iOS, pixels CSS. L'image peut avoir une autre taille, le hub la met à l'échelle. L'origine est en haut à gauche, y vers le bas. Attention à Unity, dont l'origine écran est en bas.

## Repères (`hints`)

Ils sont facultatifs, mais ils changent tout. Sans repères, on vise par une grille (`C4`). Avec, on touche « 3 Jouer » et Claude lit la liste des boutons en texte. Donne ce qui est cliquable et visible : boutons, champs, onglets, éléments de liste. `kind` vaut `bouton`, `champ`, `lien` ou `liste`. `id` est libre : le hub te le renvoie en `ref` dans l'action `hint`, pour viser l'objet lui-même plutôt que son centre. Le champ `id` d'une action, lui, est son numéro à rappeler dans `/done`.

## Actions

| `type` | Champs | Obligatoire |
| --- | --- | --- |
| `tap` | `x`, `y` (dans l'espace `w` × `h`) | oui |
| `type` | `text` : à taper dans le champ qui a le focus | oui |
| `key` | `key` : `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowUp`… | oui |
| `scroll` | `dy` : positif vers le bas, en pixels | conseillé |
| `hint` | `n`, `ref` (l'`id` du repère), `x`, `y`, `text` (facultatif : remplir après avoir touché) | si tu donnes des `id` ; sinon le hub fait un `tap` au centre puis un `type` |
| `back`, `goto` (`url`), `reload` | | si ça a un sens pour la cible |

Une action inconnue répond `ok: false` avec une phrase : elle remonte telle quelle à Claude.

## Journal

`logs` (en entrant) ou `console` (en sortant) remontent les erreurs à l'écran du panneau et dans la réponse de l'outil de Claude : exceptions, erreurs réseau, assertions. C'est ce qui fait qu'il voit un bug sans que tu le lui décrives.

## Sécurité

- Le hub n'écoute que sur 127.0.0.1, sauf `--bind` explicite, qui exige alors un `--token`.
- Un pont entrant exige son propre `jeton`.
- Tout ce qui sort de la machine passe par un chemin que l'utilisateur a accepté : SSH, VPN, réseau local, tunnel. Voir la skill `integrer`.
