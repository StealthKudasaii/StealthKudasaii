#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  RBKS PVP — mise à jour automatique depuis GitHub
#  Lancé chaque minute par le timer systemd « rbks-update ».
#  Peut aussi être lancé à la main : ./deploy/update.sh
#
#  1. git fetch : rien de nouveau → on s'arrête.
#  2. Avance la copie locale (fast-forward uniquement, jamais d'écrasement).
#  3. Rien ne concerne le bot → pas de redémarrage.
#  4. npm ci seulement si les dépendances ont changé.
#  5. Compile dans dist-next : en cas d'échec, l'ancienne version continue de tourner.
#  6. Redémarre et vérifie que le bot se reconnecte à Discord.
#  7. Échec → retour automatique à la version précédente, et ce commit n'est plus retenté.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
REL_DIR="$(realpath --relative-to="$REPO_DIR" "$APP_DIR")"
SERVICE="${RBKS_SERVICE:-rbks-bot}"
BRANCH="${RBKS_BRANCH:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)}"
DATA_DIR_RAW="$(grep -E '^DATA_DIR=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
DATA_DIR="${DATA_DIR_RAW:-./data}"
[[ "$DATA_DIR" = /* ]] || DATA_DIR="$APP_DIR/$DATA_DIR"
WEB_PORT="$(grep -E '^WEB_PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
WEB_PORT="${WEB_PORT:-3000}"
WEB_ENABLED="$(grep -E '^WEB_ENABLED=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
BAD_FILE="$DATA_DIR/deploy-bad-commit"
mkdir -p "$DATA_DIR"

log() { echo "[$(date '+%F %T')] $*"; }

# Un seul passage à la fois.
exec 9>"$DATA_DIR/.update.lock"
flock -n 9 || exit 0

cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
[ "$OLD" = "$NEW" ] && exit 0

if [ -f "$BAD_FILE" ] && [ "$(cat "$BAD_FILE")" = "$NEW" ]; then
  exit 0 # ce commit a déjà échoué : on attend le prochain push
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "Fichiers suivis modifiés directement sur le VPS : mise à jour ignorée (git status pour voir lesquels)."
  exit 1
fi
if ! git merge-base --is-ancestor "$OLD" "$NEW"; then
  log "L'historique GitHub a été réécrit (force-push) : mise à jour ignorée. Fais un « git reset --hard origin/$BRANCH » à la main si c'est voulu."
  exit 1
fi

CHANGED="$(git diff --name-only "$OLD" "$NEW" -- "$REL_DIR")"
MESSAGE="$(git log -1 --format=%s "$NEW")"
git merge --ff-only --quiet "$NEW"
if [ -z "$CHANGED" ]; then
  log "Nouveau commit ${NEW:0:7} sans changement pour le bot : pas de redémarrage."
  exit 0
fi
log "Mise à jour ${OLD:0:7} → ${NEW:0:7} : $MESSAGE"

cd "$APP_DIR"
DEPS_CHANGED=0
if echo "$CHANGED" | grep -qE '(^|/)package(-lock)?\.json$'; then DEPS_CHANGED=1; fi

write_deploy() { # status reason
  node -e '
    const [file, status, commit, previous, message, reason] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({ status, commit, previous, message, reason: reason || undefined, at: new Date().toISOString(), announced: false }, null, 2));
  ' "$DATA_DIR/deploy.json" "$1" "$NEW" "$OLD" "$MESSAGE" "${2:-}"
}

OLD_PID=""
restart_bot() {
  OLD_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
    kill -TERM "$OLD_PID" 2>/dev/null || true # systemd (Restart=always) relance aussitôt le bot avec le nouveau code
  else
    log "Service $SERVICE non démarré : lance « sudo systemctl start $SERVICE »."
  fi
}

wait_healthy() {
  # 1. Attendre que l'ancien processus soit remplacé (sinon on testerait l'ancienne version).
  local pid=""
  for _ in $(seq 1 30); do
    pid="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
    if [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "$OLD_PID" ]; then break; fi
    sleep 1
  done
  if [ -z "$pid" ] || [ "$pid" = "0" ] || [ "$pid" = "$OLD_PID" ]; then return 1; fi
  # 2. Le nouveau processus doit se connecter à Discord (90 s max).
  for _ in $(seq 1 30); do
    sleep 3
    if [ "${WEB_ENABLED:-true}" = "false" ]; then
      sleep 15
      [ "$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)" = "$pid" ] && return 0 || return 1
    fi
    if curl -fsS "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null | grep -q '"discord":true'; then return 0; fi
  done
  return 1
}

SWAPPED=0
rollback() { # reason
  log "ÉCHEC ($1) → retour à ${OLD:0:7}"
  echo "$NEW" > "$BAD_FILE"
  git -C "$REPO_DIR" reset --hard --quiet "$OLD"
  if [ "$DEPS_CHANGED" = "1" ]; then npm ci --no-audit --no-fund || true; fi
  write_deploy rollback "$1"
  # Si la nouvelle version n'a jamais été mise en place, l'ancienne tourne toujours : rien à redémarrer.
  if [ "$SWAPPED" = "1" ]; then
    rm -rf dist && mv dist-prev dist
    restart_bot
  fi
}

if [ "$DEPS_CHANGED" = "1" ]; then
  log "Dépendances modifiées : npm ci"
  if ! npm ci --no-audit --no-fund; then rollback "installation des dépendances"; exit 1; fi
fi

rm -rf dist-next
if ! npm run build --silent -- --outDir dist-next; then
  rm -rf dist-next
  rollback "compilation"
  exit 1
fi

rm -rf dist-prev
[ -d dist ] && mv dist dist-prev
mv dist-next dist
SWAPPED=1
write_deploy updated
restart_bot

if wait_healthy; then
  rm -f "$BAD_FILE"
  log "Mise à jour ${NEW:0:7} en ligne ✔"
else
  rollback "le bot ne s'est pas reconnecté à Discord après la mise à jour"
  exit 1
fi
