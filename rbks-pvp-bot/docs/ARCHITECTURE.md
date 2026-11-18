# Architecture technique

## Vue d’ensemble

```
            ┌──────────────────────── processus Node.js ────────────────────────┐
Discord ◄──►│ bot/ (client, interactions, événements)                            │
            │        │                                                           │
            │        ▼                                                           │
            │ modules/ (services métier : tickets, whitelist, dev, community…)   │◄──► SQLite (data/rbks.sqlite)
            │        ▲                                                           │
Navigateur ◄►│ web/ (Express : OAuth2, sessions, CSRF, routes du panel)           │
            │ core/scheduler (toutes les 30 s : sondages, sessions, formulaires, │
            │                 sauvegarde quotidienne, nettoyage)                 │
            └────────────────────────────────────────────────────────────────────┘
```

- **Un seul processus** : le panel appelle directement les services du bot, qui mettent à jour Discord immédiatement (pas de file d’attente intermédiaire à maintenir).
- **Composants persistants** : chaque bouton/menu a un identifiant `module:action:id`. Le gestionnaire retrouve tout en base : les boutons des anciens messages fonctionnent après un redémarrage.
- **Messages mis à jour sur place** : formulaires publiés, versions, tâches, roadmap, panneaux, suggestions, bugs, sessions et sondages mémorisent leur message ; une modification édite ce message (et en recrée un seulement s’il a été supprimé). Les mises à jour rapprochées sont regroupées (anti-rebond) pour ménager les limites de l’API.

## Modules

| Module | Fichiers clés | Rôle |
|---|---|---|
| `config` | `env.ts`, `layout.ts`, `constants.ts` | Variables d’environnement validées ; structure cible du serveur (rôles, salons, permissions par preset) ; statuts et libellés. |
| `core` | `permissions.ts`, `resources.ts`, `settings.ts`, `guards.ts`, `time.ts`, `scheduler.ts`, `backup.ts` | Permissions par fonctionnalité ; éléments Discord gérés ; réglages typés ; cooldowns, limites, verrous, anti-rebond ; dates FR/fuseau ; tâches planifiées. |
| `bot` | `interactions.ts`, `reply.ts`, `messages.ts`, `panels.ts`, `events/` | Routage + gestion d’erreurs (interactions expirées, permissions manquantes) ; réponses privées ; publication idempotente ; journalisation des arrivées, départs et sanctions. |
| `modules/setup` | `setup.service.ts` | Un seul parcours pour l’aperçu et l’application : l’aperçu est fidèle à ce qui sera fait. |
| `modules/whitelist` | `forms.repo.ts`, `forms.logic.ts`, `forms.service.ts`, `builder.ts` | Données ; logique pure testée (étapes, validation, états) ; parcours candidat et examen ; assistant de création. |
| `web` | `server.ts`, `auth.ts`, `middleware.ts`, `routes/` | Panel. |

## Base de données (SQLite, migrations dans `src/db/migrations.ts`)

| Table | Contenu |
|---|---|
| `settings` | Réglages clé/valeur JSON (marque, présence, salons réaffectés, logs, tickets, panneaux…). |
| `managed_resources` | Rôles/catégories/salons créés ou repris par `/setup` (clé stable → identifiant Discord). |
| `feature_roles` | Rôles autorisés par fonctionnalité (sinon valeurs par défaut). |
| `audit_logs` | Journal de toutes les actions. |
| `ticket_reasons`, `tickets`, `ticket_notes` | Motifs, tickets, notes internes. |
| `forms`, `form_questions` | Formulaires de candidature et leurs questions. |
| `applications`, `application_notes`, `application_events`, `application_drafts` | Candidatures (réponses figées avec l’intitulé des questions), notes, historique, brouillons d’étapes. Index unique : une seule candidature active par membre et par formulaire. |
| `versions`, `tasks`, `roadmap_categories`, `roadmap_items` | Suivi du développement. |
| `suggestions`, `suggestion_votes` | Suggestions et votes (clé primaire membre + suggestion : un vote par membre). |
| `bugs`, `bug_events` | Rapports de bug et historique (notes internes marquées). |
| `publications` | Patch notes, annonces, mises à jour, spoils. |
| `test_sessions`, `test_session_participants` | Sessions et inscriptions (inscrit / liste d’attente). |
| `polls`, `poll_votes` | Sondages et votes. |
| `web_sessions` | Sessions du panel. |

Ajouter une évolution de schéma : ajouter une entrée à la fin du tableau `migrations` (jamais modifier une migration existante). Elle est appliquée automatiquement au démarrage, dans une transaction.

## Concurrence et doublons

- **Transitions atomiques en base** : `UPDATE … WHERE status IN (…)` pour décider d’une candidature, prendre en charge ou fermer un ticket, clôturer un sondage. Si deux membres du staff cliquent en même temps, un seul réussit, l’autre reçoit « déjà traité ».
- **Verrous applicatifs** par candidature, ticket, session et sondage pour sérialiser les traitements qui touchent Discord.
- **Anti-abus** : 20 interactions / 10 s par membre, cooldowns (tickets, suggestions, bugs), limite globale d’ouverture de tickets, limitation de débit HTTP du panel.

## Permissions

`can(member, feature)` est appelée côté serveur pour chaque commande, bouton, fenêtre et route du panel :

1. propriétaire du serveur, permission Administrateur ou `BOT_OWNER_IDS` → autorisé ;
2. sinon, le membre doit avoir un des rôles de `feature_roles` (ou des rôles par défaut résolus via `managed_resources`) ;
3. pour les candidatures, les rôles examinateurs propres au formulaire s’ajoutent.

Le panel revérifie les rôles **à chaque requête** : retirer un rôle sur Discord coupe l’accès immédiatement.

## Ajouter une commande

1. Dans le module concerné, ajouter un objet `SlashCommand` (`data`, `category`, `help`, `feature`, `execute`).
2. Pour des boutons : un `ComponentHandler` avec un préfixe unique et des customIds `prefixe:action:args`.
3. Les commandes sont enregistrées automatiquement au démarrage. `npm test` vérifie leur validité pour Discord.
