# 🔥 RBKS PVP — Bot Discord officiel et panel web

Outil d’administration complet pour le serveur Discord de **RBKS PVP** (jeu Roblox inspiré de Naruto et Shinobi Striker) : configuration automatique du serveur, tickets, candidatures bêta-test, suivi du développement (versions, tâches, roadmap), annonces et patch notes, suggestions, bugs, sessions de test, sondages, notifications, statistiques, logs, et un **panel web** sécurisé par Discord OAuth2.

Tout se gère depuis Discord (commandes slash, boutons, menus, fenêtres) ou depuis le panel. Aucune opération courante ne demande de toucher au code.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Démarrage rapide](#démarrage-rapide)
3. [Commandes Discord](#commandes-discord)
4. [Architecture](#architecture)
5. [Limites de Discord et solutions retenues](#limites-de-discord-et-solutions-retenues)
6. [Sécurité](#sécurité)
7. [Guides détaillés](#guides-détaillés)

---

## Fonctionnalités

| Domaine | Ce que fait le bot |
|---|---|
| **/setup** | Crée les rôles (hiérarchie Fondateur → Bots + 5 rôles de notification), les catégories, les salons et leurs permissions. **Idempotent** : reconnaît l’existant (même renommé), corrige les permissions manquantes sans écraser les tiennes, affiche un **aperçu avant d’appliquer**. `/setup cleanup` ne touche qu’aux éléments gérés par le bot, avec aperçu et confirmation. |
| **Tickets** | Panneau avec bouton → choix du motif → formulaire → salon privé. Prise en charge, ajout de membres, notes internes invisibles du joueur, fermeture avec confirmation, **transcript HTML** archivé (logs + panel), suppression ou archivage du salon. Anti-spam : tickets ouverts max, délai entre ouvertures, limite globale. |
| **Candidatures bêta** | `/wlcreate` ouvre un **assistant** : infos, salons, rôles, paramètres, questions (réponse courte/longue, choix unique/multiple, nombre, pseudo Roblox, obligatoire ou non, texte indicatif, plage). Découpage automatique en **étapes** au-delà de 5 questions. Examen par le staff avec Accepter / Refuser (motif) / En attente / Note / Consulter, attribution du rôle, MP, historique. Formulaires multiples et indépendants. |
| **Développement** | `#release` : une fiche par version (fonctionnalités, statut, date, progression). `#to-do` : une fiche par tâche avec boutons *En cours / En test / Terminé / Reporter*. **Roadmap** : un message par catégorie, mis à jour sur place. |
| **Publications** | Patch notes (nouveautés, corrections, équilibrage, image, date), annonces, mises à jour, spoils, chacun dans son salon, avec mention facultative du rôle de notification. Modifiables après publication. |
| **Communauté** | Suggestions avec vote 👍/👎 (1 vote par membre), fil de discussion, statut et réponse du staff. Rapports de bug avec plateforme et **captures/vidéos jointes**, prise en charge, statut, notes internes, historique. Sessions de test avec inscription, places, **liste d’attente** et promotion automatique, rappel avant la session. Sondages (anonymes ou publics, choix multiples, durée, résultats en direct). |
| **Notifications** | Panneau où chaque membre choisit ses rôles de notification (annonces, mises à jour, patch notes, bêta, sessions). |
| **Stats & logs** | `/stats` et tableau de bord. Logs configurables (arrivées/départs, sanctions lues dans le journal d’audit, tickets, candidatures, roadmap, tâches, publications, administration), en base et dans un salon staff. |
| **Panel web** | Connexion Discord, tableau de bord, profil du bot (nom, avatar, statut, activité **appliqués via l’API Discord**), identité visuelle, salons, permissions par fonctionnalité, tickets, formulaires et candidatures, versions, tâches, roadmap, publications, suggestions, bugs, sessions, sondages, logs, sauvegardes. |

## Démarrage rapide

**Sous Windows : double-clique sur `lancer-bot.bat`.** Il vérifie Node.js, installe les dépendances, crée le fichier `.env` (secret de session généré automatiquement) et l’ouvre dans le Bloc-notes s’il manque des valeurs, compile, lance le bot et le panel, puis le redémarre automatiquement s’il s’arrête.

Autres systèmes — prérequis : **Node.js 22.12+** (ou Docker).

```bash
cd rbks-pvp-bot
npm install
cp .env.example .env      # puis remplis les valeurs (voir docs/DISCORD.md)
npm run invite            # affiche le lien d'invitation du bot
npm run build
npm start
```

Puis sur Discord : `/setup installer` → **Appliquer**. Le panel est sur l’adresse `PUBLIC_URL`.

En développement : `npm run dev` (rechargement automatique). Tests : `npm test`.

👉 Guide pas à pas : [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Commandes Discord

Toutes les commandes vérifient les permissions **côté serveur**. `/help` n’affiche que ce que la personne peut utiliser.

| Catégorie | Commandes |
|---|---|
| Général | `/help`, `/ping`, `/botinfo`, `/stats` |
| Administration | `/setup installer`, `/setup cleanup`, `/setup panneaux`, `/permissions view/add/remove/reset` |
| Support | `/ticket add/remove/claim/close/panel` |
| Candidatures | `/wlcreate`, `/wledit`, `/wldelete`, `/wllist`, `/wlopen`, `/wlclose`, `/wlstats`, `/wlreview` |
| Développement | `/release create/edit/status/list/delete/sync`, `/todo add/edit/status/list/remove`, `/roadmap view/add/edit/remove/status/progress/publish` |
| Publications | `/patchnote create/edit`, `/announcement create/edit` |
| Communauté | `/suggestion`, `/bugreport`, `/bugs list/view`, `/testsession create/list/cancel`, `/poll create/end`, `/notifications` |

## Architecture

**Choix techniques** : TypeScript, **discord.js 14** (composants de fenêtres modernes : listes, choix de salons/rôles, envoi de fichiers), **SQLite** via better-sqlite3 (persistant, transactionnel, zéro service à administrer, sauvegardes à chaud), **Express 5 + EJS** pour le panel (rendu serveur, aucun build front, fonctionne sans JavaScript), **zod** pour valider la configuration, **pino** pour les logs techniques.

Le bot et le panel tournent dans **le même processus** et partagent la même couche de services : une modification faite dans le panel passe par exactement le même code qu’une commande Discord, et le message Discord est mis à jour immédiatement.

```
rbks-pvp-bot/
├── src/
│   ├── index.ts                 # démarrage, arrêt propre
│   ├── config/                  # .env validé (zod), constantes, structure du serveur (/setup)
│   ├── core/                    # réglages, permissions, ressources gérées, dates, anti-abus, planificateur, sauvegardes
│   ├── db/                      # connexion SQLite, migrations versionnées, données initiales
│   ├── bot/                     # client, routage des interactions, réponses, embeds, panneaux, événements
│   ├── modules/
│   │   ├── setup/               # /setup (aperçu = application) et cleanup
│   │   ├── tickets/             # tickets + transcripts
│   │   ├── whitelist/           # formulaires, assistant, candidatures, examen
│   │   ├── dev/                 # versions, tâches, roadmap
│   │   ├── community/           # suggestions, bugs, sessions de test, sondages
│   │   ├── publications/        # patch notes et annonces
│   │   ├── notifications/       # rôles de notification
│   │   ├── general/             # aide, ping, infos, stats, permissions, règlement
│   │   ├── logs/                # journal (base + salon Discord)
│   │   └── stats/ botprofile.ts
│   ├── web/                     # serveur, OAuth2, sessions, CSRF, routes du panel
│   └── scripts/                 # invite, enregistrement des commandes, sauvegarde
├── web/views, web/public        # gabarits EJS, CSS, JS
├── test/                        # 36 tests (logique, base, composants Discord, panel HTTP)
├── docs/                        # guides
├── Dockerfile, docker-compose.yml, ecosystem.config.cjs
└── .env.example
```

Détails (schéma de base, flux, sécurité) : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limites de Discord et solutions retenues

| Limite Discord | Solution |
|---|---|
| Une fenêtre modale contient **5 champs maximum** | Les formulaires sont découpés en étapes ; un bouton « Continuer » ouvre la suivante, les réponses sont gardées 1 h en brouillon. |
| Une modale ne peut pas en ouvrir une autre | Après chaque étape, un message privé propose le bouton de l’étape suivante. |
| Intitulé d’une question : **45 caractères** max | Contrôlé à la saisie (Discord et panel), avec la description (100 caractères) pour les précisions. |
| Choix : **25 options** max par liste | 25 choix max par question, 25 questions max par formulaire, 25 motifs de ticket. |
| Message : **6 000 caractères** au total, champ : 1 024 | Textes tronqués proprement ; la réponse complète reste visible via « Consulter » et dans le panel. Roadmap : un message par catégorie. |
| `/setup` ne peut pas avoir de sous-commandes **et** être lancé seul | `/setup installer` et `/setup cleanup`. Idem `/roadmap view`. |
| Le bot ne peut pas donner une permission qu’il n’a pas | Il n’a pas Administrateur (sécurité) : `/setup` te demande d’activer Administrateur sur 👑 Fondateur à la main. |
| Le bot ne gère pas les rôles au-dessus du sien | Voulu : place Fondateur, Co-Fondateur et Administrateur au-dessus du bot. `/setup` le signale. |
| Nom du bot : **2 changements par heure** | Message clair dans le panel ; le surnom sur le serveur n’a pas cette limite. |
| Les liens des pièces jointes expirent | Les captures de bug et images d’annonces sont ré-envoyées par le bot dans le message. |
| Une interaction doit répondre en 3 s | Réponse différée pour les opérations longues, erreurs « interaction expirée » ignorées proprement. |

## Sécurité

- Secrets uniquement dans `.env` (jamais en base, jamais dans les logs : masquage automatique).
- Le bot est invité **sans Administrateur** ; le rôle Fondateur n’est **jamais attribué automatiquement** et ne peut pas être choisi comme rôle d’acceptation.
- Permissions **par fonctionnalité** (`/permissions` ou panel), vérifiées à chaque commande, bouton et page.
- Panel : OAuth2 avec paramètre `state`, scope `identify` uniquement, jeton Discord non conservé, session régénérée à la connexion, cookie `httpOnly`/`sameSite`/`secure` en HTTPS, **CSRF** sur chaque formulaire, en-têtes de sécurité (CSP), limitation de débit, **accès revérifié à chaque requête** à partir des rôles actuels.
- Anti-abus : limites par membre, délais, verrous et transitions atomiques en base (une candidature ou un ticket ne peut pas être traité deux fois), index unique contre les candidatures en double.
- Sauvegarde automatique quotidienne de la base (`data/backups`).

## Guides détaillés

- [Installation locale](docs/INSTALLATION.md)
- [Créer et configurer le bot Discord](docs/DISCORD.md)
- [Configurer OAuth2 pour le panel](docs/OAUTH2.md)
- [Déployer sur un serveur](docs/DEPLOIEMENT.md)
- [Architecture et base de données](docs/ARCHITECTURE.md)
