#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  RBKS PVP — installation sur un VPS Linux (Ubuntu/Debian), une seule fois.
#  Usage (depuis le dossier rbks-pvp-bot) :  ./deploy/install-vps.sh
#  Installe le bot comme service (démarrage auto, redémarrage en cas de crash)
#  et active la mise à jour automatique à chaque push sur GitHub.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
cd "$APP_DIR"

if [ "$APP_USER" = "root" ]; then
  echo "⚠️  Lance ce script avec ton utilisateur habituel (pas root) : il demandera sudo quand il le faut."
  exit 1
fi
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "Ce dossier doit être un clone git du dépôt (git clone …)."; exit 1; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# ── Node.js 22.12+ ──
need_node=1
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' && need_node=0
fi
if [ "$need_node" = "1" ]; then
  echo "→ Installation de Node.js 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v curl >/dev/null || sudo apt-get install -y curl
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
echo "✔ Node.js $(node -v)"

# ── Dépendances ──
echo "→ Installation des dépendances…"
npm ci --no-audit --no-fund

# ── .env ──
set +e
node scripts/prepare-env.cjs
code=$?
set -e
if [ "$code" = "3" ]; then
  echo
  echo "Complète le fichier .env (par exemple : nano .env), puis relance ./deploy/install-vps.sh"
  echo "Sur un VPS, pense aussi à PUBLIC_URL (https://ton-domaine), TRUST_PROXY=true et WEB_HOST=127.0.0.1."
  exit 1
fi

# ── Compilation ──
echo "→ Compilation…"
npm run build --silent
chmod +x deploy/update.sh

# ── Services systemd ──
echo "→ Création des services (sudo)…"
sudo tee /etc/systemd/system/rbks-bot.service >/dev/null <<UNIT
[Unit]
Description=RBKS PVP - bot Discord et panel web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN dist/index.js
Restart=always
RestartSec=5
# Code 2 = erreur de configuration (token, .env…) : inutile de redémarrer en boucle.
RestartPreventExitStatus=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/rbks-update.service >/dev/null <<UNIT
[Unit]
Description=RBKS PVP - mise à jour automatique depuis GitHub
After=network-online.target

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=RBKS_BRANCH=$BRANCH
ExecStart=$APP_DIR/deploy/update.sh
UNIT

sudo tee /etc/systemd/system/rbks-update.timer >/dev/null <<UNIT
[Unit]
Description=RBKS PVP - vérifie GitHub chaque minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now rbks-bot.service rbks-update.timer
sudo systemctl restart rbks-bot.service

echo
echo "✔ Installé. Le bot tourne et suit la branche « $BRANCH » : chaque push est appliqué en 1 minute environ."
echo
echo "  Logs du bot           : journalctl -u rbks-bot -f"
echo "  Logs des mises à jour : journalctl -u rbks-update -f"
echo "  Redémarrer le bot     : sudo systemctl restart rbks-bot"
echo "  Mettre à jour tout de suite : sudo systemctl start rbks-update"
echo "  Suspendre les mises à jour  : sudo systemctl stop rbks-update.timer"
