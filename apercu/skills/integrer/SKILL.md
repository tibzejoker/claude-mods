---
name: integrer
description: Brancher le panneau Aperçu sur n'importe quel projet, pour que l'utilisateur voie et pilote en direct ce que Claude construit (site, app mobile, client lourd, jeu Unity ou autre), même quand la session tourne sur une autre machine. Détecter le type de projet, choisir le pilote, écrire un adaptateur si besoin, monter le pont réseau (localhost, réseau local, VPN, SSH, tunnel), écrire .apercu.json, vérifier. À utiliser quand l'utilisateur veut « voir l'app », « l'aperçu », « tester à la main », un « side window » du projet, ou quand l'outil apercu répond qu'il n'y a pas de cible.
---

# Brancher l'Aperçu sur un projet

Le but : l'utilisateur ouvre `/apercu` et voit, en direct et navigable, ce que tu construis, quel que soit le projet. Tu fais l'intégration toi-même. Tu ne lui demandes que ce que toi seul ne peux pas faire, par exemple lancer une commande sur sa machine à lui.

Le hub tourne **à côté de la session** (`$PLUGIN/daemon/apercu.py serve`, lancé par le mod, 127.0.0.1:7357). Il tient des **cibles**. Ton travail consiste à décrire celles du projet dans `.apercu.json` à sa racine, puis à rendre chacune joignable.

`$PLUGIN` désigne le dossier de ce plugin, deux niveaux au-dessus de ce fichier. `PROTOCOLE.md` y décrit le protocole, et `adaptateurs/` contient des adaptateurs prêts à copier.

## 1. Comprendre où tourne quoi

Réponds à ces trois questions avant de choisir, en regardant le dépôt, les scripts et l'environnement. Ne les pose à l'utilisateur que si tu ne trouves pas.

1. **Qu'est-ce qu'on regarde ?** Un site, une app mobile, un exécutable desktop, un jeu, plusieurs à la fois (une API et son front).
2. **Où ça tourne ?** Sur la machine de la session (la plus simple), sur la machine de l'utilisateur (son Mac, son PC, l'éditeur Unity ouvert chez lui), ou sur un appareil (téléphone, TV, casque).
3. **Qui peut joindre qui ?** Vérifie-le, ne le devine pas : `ip addr`, `tailscale status`, `wg show`, `ip route`, un `ssh -o BatchMode=yes cible true`, un `curl` vers le port. Une session en Remote Control veut souvent dire que l'utilisateur est sur une autre machine que toi.

## 2. Choisir le pilote

| Projet | Pilote | Comment |
| --- | --- | --- |
| Site, front web (Vite, Next, Rails, Django…) | `web` | Lance le serveur de dev, puis `url`. `appareil: "mobile"` pour un site mobile d'abord. |
| Expo / React Native, Flutter, Ionic, Capacitor | `web` en `mobile` (`expo start --web`, `flutter run -d web-server`) **ou** `adb` sur un émulateur ou un téléphone | Le web est immédiat. L'Android est fidèle (gestes natifs, plugins). Prends les deux s'ils sont faciles. |
| Android natif (Kotlin, Java, Compose) | `adb` | `./gradlew installDebug`, puis `paquet`. Les repères viennent de l'arbre d'accessibilité. |
| iOS (Swift, SwiftUI, RN iOS) | `ios` | Seulement sur un Mac avec Xcode. Si la session n'y est pas, `expose ios` sur le Mac (étape 3). `idb` pour agir, sinon l'image seule. |
| Electron | `web` avec `cdp` | Lance l'app avec `--remote-debugging-port=9222`, puis `cdp: "http://127.0.0.1:9222"`. Repères DOM et console comme un site. |
| Tauri, WebView2 (Windows) | `web` avec `cdp` | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. Sous Linux (WebKitGTK), pas de CDP : utilise `ecran`. |
| Client lourd natif (Qt, GTK, WPF, WinForms, Swing, SwiftUI macOS, Avalonia…) | `ecran` | Sur un Linux sans écran : `Xvfb :99 -screen 0 1280x800x24 &`, l'app avec `DISPLAY=:99`, puis `display: ":99"`. Sinon `expose ecran` là où l'app tourne. `zone` pour cadrer une fenêtre. |
| Jeu Unity | `pont` avec `adaptateurs/unity/ApercuPont.cs` **ou** `adb` (build Android) **ou** `web` (build WebGL) **ou** `ecran` | L'adaptateur donne les repères UGUI (boutons nommés), le journal Unity (erreurs, exceptions) et vise les objets eux-mêmes : c'est le meilleur choix dès que l'éditeur ou un build desktop tourne. Voir plus bas. |
| Godot, Unreal, moteur maison, app embarquée | `pont` avec un adaptateur que **tu écris** dans le langage du projet, d'après `PROTOCOLE.md` (sens entrant : trois requêtes HTTP) **ou** `ecran` | Commence par `ecran` si c'est sur une machine joignable. Écris l'adaptateur si l'utilisateur veut des repères, le journal du jeu ou un build mobile. |
| Une API sans écran, une CLI | aucun | Dis-le. Pour un terminal, il y a le mod `terminal-distant`. |

Plusieurs cibles dans un même projet, c'est normal : un front `web` et le même en `adb`, ou un jeu en `pont` et son menu web. L'utilisateur passe de l'une à l'autre par les onglets du panneau.

## 3. Monter le pont

Prends le **premier** barreau de cette échelle qui marche, et vérifie-le réellement avec `curl` ou l'action `state`.

0. **Même machine** : `127.0.0.1`, rien à faire.
1. **Chemin privé existant** (réseau local, VPN, Tailscale, ZeroTier, WireGuard) :
   - Soit la cible écoute : `apercu.py expose <pilote> … --listen <ip privée>:7391 --token <jeton>`, et `{ "pilote": "pont", "url": "http://<ip>:7391", "jeton": … }`.
   - Soit la cible appelle le hub (sens entrant) : ouvre une écoute réservée aux ponts avec `python3 $PLUGIN/daemon/apercu-cli ecoute <ip privée> 7358`. Elle ne sert que `/pont/<nom>/*`, protégé par le jeton de chaque cible ; le reste du hub reste en 127.0.0.1. La cible vise `http://<ip privée>:7358`.
   - Pour `adb` : `adb connect <ip>:5555` marche à travers un VPN, avec l'option `connecter`.
2. **SSH**, dans un sens ou dans l'autre :
   - La session joint la cible : `ssh -fN -R 7357:127.0.0.1:7357 cible` rend le hub accessible sur le `127.0.0.1:7357` de la cible. Un adaptateur entrant (Unity dans l'éditeur, `expose --dial http://127.0.0.1:7357`) n'a alors plus rien à savoir. C'est le barreau le plus propre pour « l'éditeur tourne chez l'utilisateur ».
   - `ssh -fN -L 7391:127.0.0.1:7391 cible` pour atteindre un adaptateur en écoute.
   - Seule la cible joint la session (cas fréquent : la session est sur un serveur, l'utilisateur sur son portable) : donne-lui la commande `ssh -N -L 7357:127.0.0.1:7357 <session>` à lancer chez lui. Son Unity ou son `expose --dial` vise alors `http://127.0.0.1:7357`.
3. **Tunnel public** (`cloudflared tunnel --url http://127.0.0.1:7357`, `tailscale funnel`, `ngrok`, `bore`) : **demande d'abord à l'utilisateur**, car tu exposes un port sur Internet. Utilise un jeton aléatoire long (`openssl rand -hex 24`) et le sens entrant. Le tunnel pointe sur l'écoute réservée aux ponts (`apercu-cli ecoute 127.0.0.1 7358`, puis `cloudflared tunnel --url http://127.0.0.1:7358`), jamais sur le port du hub. Coupe le tunnel quand l'utilisateur a fini, et dis-lui qu'il tourne tant qu'il tourne.
4. **Rien ne passe** : explique ce qui bloque (pas de route, pare-feu) et propose le barreau le moins coûteux à ouvrir.

**Ce que tu ne peux pas lancer toi-même** (sur la machine de l'utilisateur, quand tu n'y as pas d'accès SSH) : donne-lui **une seule commande à copier**, complète, avec le jeton déjà dedans. Par exemple `curl -fsSL … && python3 apercu.py expose ecran --dial http://127.0.0.1:7357 --name pc --token …`. Pour qu'il récupère `apercu.py`, propose `scp` depuis sa machine, ou sers le fichier par le chemin déjà ouvert.

Les jetons vont dans `.apercu.json`. Ajoute `.apercu.json` au `.gitignore` du projet dès qu'il en contient un.

## 4. Préparer et décrire

Fais tourner la cible : serveur de dev, émulateur (`emulator -avd … -no-window` si la machine a KVM), build installé, Xvfb, éditeur. Si une étape exige un outil absent (`adb`, `mss`, `playwright`, `idb`), installe-le dans un environnement isolé (venv, dossier du projet) plutôt qu'au niveau système, et dis-le. Écris ensuite `.apercu.json` :

```json
{
  "cibles": [
    { "nom": "site", "pilote": "web", "url": "http://localhost:5173", "appareil": "mobile" },
    { "nom": "android", "pilote": "adb", "serie": "emulator-5554", "paquet": "com.exemple.app" },
    { "nom": "jeu", "pilote": "pont", "jeton": "9f2c…" },
    { "nom": "mac", "pilote": "pont", "url": "http://127.0.0.1:7391", "jeton": "…" },
    { "nom": "outil", "pilote": "ecran", "display": ":99", "zone": "0,0,1280,800" }
  ],
  "active": "site",
  "preparer": ["npm run dev", "Xvfb :99 &", "ssh -fN -R 7357:127.0.0.1:7357 mon-mac"],
  "notes": "le jeu Unity se connecte depuis l'éditeur du Mac via le tunnel SSH ci-dessus"
}
```

`preparer` et `notes` ne sont pas lus par le hub. Ils servent à la prochaine session, à toi ou à quelqu'un d'autre, pour remonter le même montage.

Options par pilote :
- **web** : `url`, `appareil` (`desktop`, `mobile`, `tablette`), `cdp`.
- **adb** : `serie`, `connecter`, `paquet`, `adb`.
- **ios** : `udid`, `bundle`.
- **ecran** : `display`, `ecran` (le numéro du moniteur), `zone`.
- **pont** : `url` (sortant) ou rien (entrant), `jeton`.

## 5. Vérifier, puis rendre la main

1. Outil `apercu`, action `config`, puis `cibles` : chaque cible doit être `prête`. Si elle est `en panne`, l'erreur dit pourquoi : corrige et recommence.
2. `state` sur chaque cible, puis `shot` et lis l'image avec Read : vérifie que c'est la bonne chose, cadrée, à jour.
3. Fais **un** geste réel (toucher un bouton, taper dans un champ) et vérifie que l'image change.
4. Dis à l'utilisateur ce qui est branché, en une ligne par cible : comment il l'ouvre (`/apercu`, ou `/apercu <nom>`), ce qui tourne en fond (un tunnel, un Xvfb, un émulateur) et comment l'arrêter.

## Unity en détail

`adaptateurs/unity/ApercuPont.cs` est un MonoBehaviour sans dépendance (UnityWebRequest, UGUI, TextMeshPro facultatif) :

1. Copie-le dans `Assets/Apercu/` du projet. Il se crée tout seul au lancement du jeu (`RuntimeInitializeOnLoadMethod`), seulement dans l'éditeur et dans les builds de développement.
2. Il lit son adresse dans `Assets/Apercu/apercu.txt` (deux lignes : l'URL du hub vue depuis la machine Unity, puis le jeton), ou dans les variables `APERCU_HUB` et `APERCU_TOKEN`. Écris ce fichier avec les valeurs du pont choisi, et le même `jeton` dans `.apercu.json` (cible `pont` sans `url`).
3. Il pousse l'écran du jeu 4 fois par seconde au plus, avec en repères les `Selectable` UGUI visibles (boutons, champs, toggles, sliders, dropdowns), et les erreurs et exceptions du journal Unity. Il exécute tap (raycast EventSystem et clic), hint (clic sur l'objet lui-même), type (dans le champ sélectionné, InputField ou TMP_InputField) et key (Enter valide, Escape désélectionne, Tab passe au suivant).
4. Les jeux qui lisent l'input directement (`Input.GetMouseButtonDown`, nouveau Input System sur des actions) ne reçoivent pas un clic UGUI. Pour eux, ajoute dans l'adaptateur une simulation d'input adaptée au projet (`InputSystem.QueueStateEvent` sur une souris virtuelle, ou un hook dans leur contrôleur), ou passe par `ecran`. Lis le code d'input du projet avant de choisir.
5. Le jeu doit tourner (Play dans l'éditeur, ou build lancé). Si l'éditeur est chez l'utilisateur, le pont SSH `-R` (barreau 2) est le plus simple. Sinon, demande-lui de faire Play.

Pour un autre moteur, écris l'équivalent en suivant le même plan : capture de l'écran, liste des contrôles visibles, application des gestes, journal. Le sens entrant ne demande qu'un client HTTP.
