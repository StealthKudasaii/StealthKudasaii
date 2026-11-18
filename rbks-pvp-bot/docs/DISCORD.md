# Créer et configurer le bot Discord

Ce guide te fait créer l’application Discord et récupérer les 4 valeurs nécessaires au fichier `.env`. Aucune valeur n’est inventée ici : tu les copies depuis ton propre compte.

## 1. Créer l’application

1. Va sur <https://discord.com/developers/applications> et connecte-toi.
2. **New Application** → nomme-la (ex. « RBKS PVP ») → accepte les conditions → **Create**.
3. Onglet **General Information** :
   - Ajoute une icône et une description si tu le souhaites.
   - Copie **Application ID** → c’est `DISCORD_CLIENT_ID` dans `.env`.

## 2. Créer le bot et son token

1. Onglet **Bot**.
2. Personnalise le nom et l’avatar (tu pourras aussi les changer plus tard depuis le panel).
3. **Reset Token** → confirme → **Copy**. C’est `DISCORD_TOKEN`.
   - ⚠️ Ce token donne le contrôle total du bot. Ne le partage jamais, ne le publie jamais (GitHub, captures d’écran…). S’il fuit, refais **Reset Token**.
4. Désactive **Public Bot** (pour que personne d’autre ne puisse l’inviter).
5. Dans **Privileged Gateway Intents**, active :
   - ✅ **Server Members Intent** (arrivées/départs, rôles, statistiques)
   - ✅ **Message Content Intent** (contenu des messages pour les transcripts de tickets)
   - (Presence Intent n’est pas nécessaire)
6. **Save Changes**.

Sans ces deux intents, le bot refusera de démarrer avec le message « Intents privilégiés refusés ».

## 3. Récupérer l’identifiant du serveur

1. Dans Discord : **Paramètres utilisateur → Avancés → Mode développeur** (activer).
2. Clic droit sur l’icône du serveur RBKS PVP → **Copier l’identifiant du serveur**. C’est `GUILD_ID`.
3. (Facultatif) Clic droit sur ton propre profil → **Copier l’identifiant** pour `BOT_OWNER_IDS`.

## 4. Inviter le bot

Une fois `DISCORD_CLIENT_ID` et `GUILD_ID` remplis dans `.env` :

```bash
npm run invite
```

Ouvre le lien affiché. Il demande uniquement les permissions nécessaires, **sans Administrateur** (choix de sécurité). Valide l’ajout sur ton serveur.

## 5. Placer le rôle du bot

Discord donne au bot un rôle à son nom. Pour que `/setup` puisse créer et ordonner tous les rôles, ce rôle doit être **en haut de la liste** au premier lancement :

1. **Paramètres du serveur → Rôles** → fais glisser le rôle du bot tout en haut → enregistre.
2. Lance `/setup installer` → vérifie l’aperçu → **Appliquer**.
3. Ensuite, applique la hiérarchie de sécurité recommandée :

```
👑 Fondateur          ← active « Administrateur » à la main sur ce rôle
⚜️ Co-Fondateur
🛡️ Administrateur
[ rôle du bot ]       ← le bot ne peut pas modifier les 3 rôles au-dessus de lui
🔨 Modérateur
🎫 Support
💻 Développeur
🎨 Builder
🧪 Testeur
⭐ VIP
👤 Membre
🤖 Bots
🔔 rôles de notification
```

4. Attribue-toi le rôle **👑 Fondateur** manuellement (le bot ne l’attribue jamais).

Relancer `/setup installer` plus tard est sans risque : rien n’est recréé en double, et les rôles au-dessus du bot sont simplement signalés.

## 6. Qui a accès à quoi ?

- Le **propriétaire du serveur**, les membres ayant la permission **Administrateur** et les identifiants de `BOT_OWNER_IDS` ont accès à tout.
- Pour les autres, chaque fonctionnalité (tickets, candidatures, roadmap, panel…) a ses rôles autorisés : `/permissions view` ou panel → **Rôles & permissions**. Les valeurs par défaut suivent la hiérarchie demandée (ex. Support → tickets, Développeur → tâches et roadmap).
- Les commandes du staff restent visibles dans la liste Discord mais refusent l’accès aux non-autorisés. Pour les masquer aussi, utilise **Paramètres du serveur → Intégrations → ton bot**.
