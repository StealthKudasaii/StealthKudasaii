# Déploiement sur un serveur (VPS)

Exemple pour un VPS Linux (Ubuntu/Debian) avec un nom de domaine pointant vers lui (ex. `panel.ton-domaine.fr`). Deux méthodes : **Docker** (la plus simple) ou **Node.js + PM2**.

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
