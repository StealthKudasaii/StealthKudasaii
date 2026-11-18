# Déploiement sur un serveur (VPS)

Exemple pour un VPS Linux (Ubuntu/Debian) avec un nom de domaine pointant vers lui (ex. `panel.ton-domaine.fr`). La méthode recommandée installe le bot en une commande et le **met à jour automatiquement à chaque push** ; Docker et PM2 restent possibles (mises à jour manuelles).

> Un bot Discord ne doit tourner qu’**en un seul exemplaire**. Ne lance jamais deux instances avec le même token.

## Préparer `.env`

Comme en local, avec :

```env
NODE_ENV=production
PUBLIC_URL=https://panel.ton-domaine.fr
TRUST_PROXY=true
WEB_HOST=127.0.0.1     # le panel n'écoute qu'en local, le reverse proxy l'expose en HTTPS
```

Ajoute `https://panel.ton-domaine.fr/auth/callback` dans les redirects OAuth2 ([OAUTH2.md](OAUTH2.md)).

## VPS Windows (Windows Server) — mise à jour automatique

Si ton VPS est sous Windows (bureau à distance, invite de commandes `C:\Users\...`), les commandes Linux (`sudo`, `apt`) n’existent pas. Utilise cette méthode.

### 1. Installer Git et Node.js (une seule fois)

Dans le navigateur **du VPS**, télécharge et installe (bouton « Next » partout, options par défaut) :

- **Git** : <https://git-scm.com/download/win> (le téléchargement démarre tout seul)
- **Node.js LTS** : <https://nodejs.org/fr/download> → « Windows Installer (.msi) »

Ferme puis rouvre l’invite de commandes après les installations.

### 2. Télécharger le bot

Dans l’invite de commandes (`cmd`) :

```bat
cd C:\
git clone https://github.com/StealthKudasaii/StealthKudasaii.git
cd C:\StealthKudasaii\rbks-pvp-bot
lancer-bot.bat
```

Utilise `git clone` et non le téléchargement ZIP : sans Git, les mises à jour automatiques ne peuvent pas fonctionner.

### 3. Remplir `.env`

Au premier lancement, `lancer-bot.bat` installe tout puis ouvre `.env` dans le Bloc-notes. Remplis `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` et `GUILD_ID`, enregistre, puis relance `lancer-bot.bat`. Le bot démarre dans la fenêtre.

À partir de là, **chaque push sur `main` est appliqué en environ 1 minute**, avec les mêmes garde-fous que sous Linux (compilation à côté, retour automatique à la version précédente si le bot ne se reconnecte pas).

### 4. Faire tourner le bot en permanence (recommandé)

La fenêtre doit rester ouverte, ce qui est fragile (redémarrage du VPS, fermeture par erreur). Pour que le bot tourne en arrière-plan et démarre avec Windows :

1. Ferme la fenêtre de `lancer-bot.bat`.
2. Ouvre le dossier `rbks-pvp-bot\deploy\windows`, fais un **clic droit sur `demarrage-auto.bat` → Exécuter en tant qu’administrateur**, puis choisis `1`.

Le bot tourne alors sous forme de tâche planifiée « RBKS PVP Bot » (visible dans le Planificateur de tâches), sans fenêtre, et continue de se mettre à jour tout seul. Journaux : `data\vps.log` (mises à jour), `data\bot.log` et `data\bot-error.log` (bot). Pour l’arrêter : même fichier, choix `2`.

## Méthode recommandée (VPS Linux) — installation en une commande + mise à jour automatique

Le bot tourne comme un service (démarre avec le VPS, redémarre s’il plante) et **se met à jour tout seul à chaque push sur GitHub** : plus besoin de te connecter au VPS pour réinstaller.

### 1. Récupérer le code sur le VPS (une seule fois)

Dépôt **public** :

```bash
git clone https://github.com/<compte>/<depot>.git
```

Dépôt **privé** : crée une clé de déploiement en lecture seule (aucun mot de passe GitHub sur le VPS) :

```bash
ssh-keygen -t ed25519 -f ~/.ssh/rbks_deploy -N ""
cat ~/.ssh/rbks_deploy.pub
```

Sur GitHub : dépôt → **Settings → Deploy keys → Add deploy key** → colle la clé, **sans** cocher « Allow write access ». Puis :

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/rbks_deploy\n' >> ~/.ssh/config
git clone git@github.com:<compte>/<depot>.git
```

Place-toi sur la branche que le VPS doit suivre (en général `main`) : `git checkout main`.

### 2. Installer

```bash
cd <depot>/rbks-pvp-bot
./deploy/install-vps.sh
```

Le script installe Node.js 22 si besoin, les dépendances, crée `.env` (secret de session généré) et s’arrête pour que tu le complètes (`nano .env`). Relance-le ensuite : il compile et crée trois services systemd :

| Service | Rôle |
|---|---|
| `rbks-bot` | le bot et le panel (démarrage automatique, redémarrage en cas de crash) |
| `rbks-update.timer` | vérifie GitHub **chaque minute** |
| `rbks-update` | applique la mise à jour (`deploy/update.sh`) |

### 3. Mettre à jour = pousser sur GitHub

Tu pousses sur la branche suivie → environ 1 minute plus tard, le VPS :

1. récupère le code (avance uniquement : rien n’est jamais écrasé de force) ;
2. ne fait rien d’autre si le commit ne touche pas `rbks-pvp-bot/` ;
3. réinstalle les dépendances **seulement** si `package.json`/`package-lock.json` ont changé ;
4. compile à côté de la version en service : si la compilation échoue, **l’ancienne version continue de tourner** sans interruption ;
5. redémarre le bot et vérifie qu’il se reconnecte à Discord dans les 90 secondes ;
6. sinon, **revient automatiquement à la version précédente** et ne retente plus ce commit (le prochain push est essayé normalement).

Chaque mise à jour (ou annulation) est annoncée dans le salon de logs du bot, et `/botinfo` affiche le commit en service. Les migrations de base de données s’appliquent seules au démarrage ; `.env` et `data/` ne sont jamais touchés par les mises à jour.

### Commandes utiles

```bash
journalctl -u rbks-bot -f            # logs du bot
journalctl -u rbks-update -f         # logs des mises à jour
sudo systemctl start rbks-update     # mettre à jour tout de suite
sudo systemctl stop rbks-update.timer   # suspendre les mises à jour auto
sudo systemctl start rbks-update.timer  # les réactiver
sudo systemctl restart rbks-bot      # redémarrer le bot
```

Si une mise à jour est ignorée avec « Fichiers suivis modifiés directement sur le VPS » : ne modifie pas le code sur le VPS (seulement `.env`), annule avec `git checkout -- .` puis laisse faire. Après un force-push sur GitHub, aligne le VPS à la main : `git fetch && git reset --hard origin/main`.

## Méthode A — Docker

```bash
sudo apt install -y docker.io docker-compose-plugin
git clone <ton dépôt> && cd <dépôt>/rbks-pvp-bot
nano .env                     # remplis les valeurs (WEB_HOST=0.0.0.0 avec Docker)
docker compose up -d --build
docker compose logs -f        # suivre les logs
```

Le dossier `./data` est monté dans le conteneur : base, transcripts et sauvegardes survivent aux mises à jour. Le port 3000 n’est exposé qu’en local (`127.0.0.1`).

Mise à jour : `git pull && docker compose up -d --build`.

## Méthode B — Node.js + PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3
sudo npm install -g pm2

git clone <ton dépôt> && cd <dépôt>/rbks-pvp-bot
npm ci
nano .env
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                   # exécute la commande affichée pour le redémarrage automatique
```

Logs : `pm2 logs rbks-pvp-bot`. Mise à jour : `git pull && npm ci && npm run build && pm2 restart rbks-pvp-bot`.

## HTTPS avec Caddy (recommandé)

Caddy obtient et renouvelle automatiquement le certificat HTTPS.

```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

```
panel.ton-domaine.fr {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

### Variante Nginx

```nginx
server {
    server_name panel.ton-domaine.fr;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 10m;
    }
}
```

Puis `sudo certbot --nginx -d panel.ton-domaine.fr`.

## Pare-feu

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Le port 3000 ne doit pas être ouvert sur Internet.

## Sauvegardes

- Automatiques chaque jour dans `data/backups` (nombre conservé : `BACKUP_RETENTION`).
- Manuelles : panel → Réglages → « Sauvegarder maintenant », ou `npm run backup`.
- Pense à copier régulièrement `data/` hors du serveur (ex. `rsync` vers une autre machine).

## Redémarrages

Le bot reprend tout depuis la base au démarrage : boutons et menus des anciens messages restent fonctionnels, les sondages arrivés à échéance pendant l’arrêt sont clôturés, les rappels de session non envoyés partent, les formulaires changent d’état selon leurs dates. Un arrêt (`SIGTERM`, `docker stop`, `pm2 stop`) ferme proprement la base et la connexion Discord.
