# Installation locale et premier lancement

## Prérequis

- **Node.js 22.12 ou plus récent** : <https://nodejs.org> (version LTS). Vérifie avec `node -v`.
- Un serveur Discord dont tu es propriétaire ou administrateur.
- 10 minutes pour créer l’application Discord ([DISCORD.md](DISCORD.md)).

## 1. Installer les dépendances

```bash
cd rbks-pvp-bot
npm install
```

`better-sqlite3` utilise un binaire précompilé ; s’il n’existe pas pour ta plateforme, npm le compile (il faut alors Python 3 et un compilateur C++ : `build-essential` sous Debian/Ubuntu, « Outils de génération Visual Studio » sous Windows).

## 2. Configurer `.env`

```bash
cp .env.example .env        # Windows : copy .env.example .env
```

Remplis :

| Variable | Où la trouver |
|---|---|
| `DISCORD_TOKEN` | [DISCORD.md](DISCORD.md) §2 |
| `DISCORD_CLIENT_ID` | [DISCORD.md](DISCORD.md) §1 |
| `DISCORD_CLIENT_SECRET` | [OAUTH2.md](OAUTH2.md) §1 |
| `GUILD_ID` | [DISCORD.md](DISCORD.md) §3 |
| `SESSION_SECRET` | [OAUTH2.md](OAUTH2.md) §3 |
| `PUBLIC_URL` | `http://localhost:3000` en local |

Au démarrage, chaque variable est vérifiée : en cas d’oubli, le message indique précisément laquelle corriger.

## 3. Inviter le bot

```bash
npm run invite
```

Ouvre le lien, choisis le serveur, valide. Puis place le rôle du bot en haut de la liste des rôles ([DISCORD.md](DISCORD.md) §5).

## 4. Lancer

```bash
npm run build
npm start
```

Tu dois voir :

```
Base de données prête
Panel web démarré
Bot connecté à Discord
Commandes slash enregistrées sur le serveur
```

En développement, `npm run dev` relance le bot à chaque modification du code.

## 5. Configurer le serveur

Sur Discord :

1. `/setup installer` → lis l’aperçu (rôles, salons, permissions) → **Appliquer**.
2. Suis les « Étapes suivantes » affichées : Administrateur sur 👑 Fondateur, ordre des rôles, rôle Fondateur pour toi.
3. Les panneaux (règlement, notifications, tickets, suggestions, bugs, roadmap) sont publiés automatiquement.

## 6. Premiers pas

- **Candidatures bêta** : `/wlcreate` → remplis les infos → bouton **Modèle bêta** (ou ajoute tes questions) → **Salons & rôles** (choisis le salon de publication) → **Publier**.
- **Roadmap** : `/roadmap add` ou panel → Roadmap.
- **Versions** : `/release create`. **Tâches** : `/todo add`.
- **Panel** : ouvre <http://localhost:3000> → Se connecter avec Discord.

## Commandes utiles

| Commande | Rôle |
|---|---|
| `npm run dev` | Lancement en développement |
| `npm run build` puis `npm start` | Lancement en production |
| `npm test` | Lance les tests |
| `npm run invite` | Affiche le lien d’invitation |
| `npm run deploy-commands` | Enregistre les commandes slash sans démarrer le bot |
| `npm run backup` | Sauvegarde immédiate de la base dans `data/backups` |

## Données

Tout est dans `data/` : base SQLite (`rbks.sqlite`), transcripts de tickets (`transcripts/`), sauvegardes quotidiennes (`backups/`, 14 conservées par défaut). Sauvegarde ce dossier.

Pour restaurer : arrête le bot, remplace `data/rbks.sqlite` par une sauvegarde, supprime `rbks.sqlite-wal` et `rbks.sqlite-shm` s’ils existent, relance.
