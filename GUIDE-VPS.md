# Installer le bot sur le VPS (pas à pas)

Compte environ 45 minutes la première fois. Fais tout sur un compte **DÉMO**.

## 0. Prépare tes clés (sur ton PC, avant de commencer)

Note-les dans un bloc-notes **que tu ne partages jamais** :

| Clé | Où la trouver |
|---|---|
| `ANTHROPIC_API_KEY` | platform.claude.com > Settings > API keys (ajoute 10 à 20 $ de crédit) |
| `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` | my.telegram.org > API development tools |
| `DISCORD_TOKEN` | discord.com/developers/applications > New Application > onglet **Bot** > **Reset Token** |
| `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER` | l'e-mail de ton broker pour le compte démo |
| `PANEL_PASSWORD` | invente-le (8 caractères minimum), c'est le mot de passe du site |

## 1. Se connecter au VPS

Ton hébergeur t'envoie une **IP**, un **utilisateur** (souvent `Administrator`) et un **mot de passe**.

- Sur ton PC Windows : touche Windows, tape **« Connexion Bureau à distance »**, entre l'IP, puis l'utilisateur et le mot de passe.
- Sur Mac : app **Windows App** (anciennement Microsoft Remote Desktop) sur l'App Store.

Tu vois alors le bureau du VPS. Pour partir, **ferme simplement la fenêtre** (la croix) : le bot continue de tourner. Ne clique **jamais** sur « Se déconnecter / Sign out », ça arrête tout.

## 2. Installer MetaTrader 5 (sur le VPS)

1. Ouvre le navigateur du VPS, va sur le site de ton broker, télécharge et installe **MT5**.
2. Connecte-toi avec ton **compte démo**.
3. `Outils > Options > Expert Advisors` : coche **« Autoriser le trading algorithmique »**.
4. Clique sur le bouton **Algo Trading** dans la barre du haut : il doit être **vert**.
5. Dans la fenêtre **Observation du marché**, note le nom exact de l'or : `XAUUSD`, `GOLD`, `XAUUSD.m`...

## 3. Télécharger le bot (sur le VPS)

1. Dans le navigateur du VPS, connecte-toi à GitHub et ouvre :
   `https://github.com/StealthKudasaii/StealthKudasaii/archive/refs/heads/main.zip`
2. Fais un clic droit sur le ZIP > **Extraire tout** > choisis `C:\bot-or`.
   Les fichiers (`installer.bat`, `demarrer.bat`...) doivent être directement dans `C:\bot-or`.

## 4. Installer (double-clic sur `installer.bat`)

Suis ce qui s'affiche :
1. Si Python n'était pas installé, il s'installe. **Ferme la fenêtre et relance `installer.bat`**.
2. Les modules s'installent (2 à 5 minutes).
3. Le fichier **`.env`** s'ouvre dans le Bloc-notes : colle tes clés de l'étape 0 après chaque `=`, puis **enregistre** et ferme.
4. Telegram te demande ton **numéro** (format +33...) puis le **code** reçu dans l'app Telegram. Ensuite la liste de tes groupes s'affiche : **note l'ID du groupe de signaux** (le nombre qui commence par `-100`).
5. Le fichier **`config.yaml`** s'ouvre. Change :
   - `source_chats:` : remplace `-1001234567890` par l'ID de ton groupe ;
   - `symbol:` : le nom de l'or noté à l'étape 2 ;
   - laisse `dry_run: true` pour l'instant.

   Enregistre et ferme.

## 5. Lancer (double-clic sur `demarrer.bat`)

- Une fenêtre noire s'ouvre : **laisse-la ouverte**, c'est le bot.
- Tu reçois « 🤖 Bot or démarré » dans tes **Messages enregistrés** Telegram.
- Le **site** est accessible sur le VPS : `http://127.0.0.1:8080`, avec ton `PANEL_PASSWORD`.

## 6. Brancher Discord

1. Ouvre `C:\bot-or\data\discord_invite.txt`, copie le lien et ouvre-le dans un navigateur : choisis ton serveur et clique sur **Autoriser**.
2. Sur ton serveur Discord, tape **`/setup`**. La catégorie, les salons et le rôle sont créés.
3. Va dans **📊 tableau-de-bord** : tu dois voir l'état du bot.

Si `/setup` n'apparaît pas, attends une minute et redémarre Discord. Ensuite, ferme la fenêtre du bot et relance `demarrer.bat`.

## 7. Que tout redémarre tout seul (si le VPS redémarre)

1. Appuie sur `Windows + R`, tape `shell:startup` et valide. Un dossier s'ouvre.
2. Dans ce dossier, crée un **raccourci** vers `C:\bot-or\demarrer.bat` (clic droit > Nouveau > Raccourci).
3. Fais pareil avec **MT5** (le raccourci du bureau).
4. Pour que Windows ouvre ta session sans mot de passe au démarrage : télécharge **Autologon** (outil gratuit de Microsoft, « Sysinternals Autologon »), entre ton utilisateur et ton mot de passe, puis clique sur **Enable**.

## 8. Les 3 étapes avant l'argent réel

1. **Quelques jours en `dry_run: true`** : le bot dit ce qu'il *aurait* fait. Vérifie dans Discord (📡 signaux) qu'il comprend bien chaque message.
2. **2 à 4 semaines en démo** : dans `config.yaml`, mets `dry_run: false`, ferme la fenêtre du bot et relance `demarrer.bat`. Suis les résultats dans 📈 stats.
3. **En réel** seulement si la démo est bonne : change les identifiants MT5 dans `.env`, commence petit (`/risque 0.5` ou `/lot-fixe 0.01`).

## Mettre le bot à jour plus tard

1. Ferme la fenêtre du bot.
2. Télécharge le nouveau ZIP (étape 3) et copie ses fichiers dans `C:\bot-or`, **sans remplacer** `.env`, `config.yaml` ni le dossier `data`.
3. Relance `installer.bat` (rapide, il ne réinstalle que ce qui manque), puis `demarrer.bat`.

## Problèmes fréquents

| Problème | Solution |
|---|---|
| « Impossible de se connecter à MT5 » | MT5 doit être ouvert et connecté, avec le bouton Algo Trading vert |
| « Symbole introuvable » | mauvais nom de l'or dans `config.yaml` (`symbol:`) |
| « Variable manquante dans .env » | une clé est vide dans `.env` |
| La fenêtre se ferme toute seule | lance `demarrer.bat` et lis le message d'erreur avant qu'elle redémarre, ou ouvre `logs\bot.log` |
| Les commandes Discord n'apparaissent pas | le bot doit être invité avec le lien de `data\discord_invite.txt`, puis redémarré |
