#!/usr/bin/env bash
set -euo pipefail

if [ -f ".env.deploy" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.deploy"
  set +a
fi

DEPLOY_HOST="${DEPLOY_HOST:-grant@basic-droplet}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/grant/sphere-paint}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_RELOAD_NGINX="${DEPLOY_RELOAD_NGINX:-0}"

echo "Deploying ${DEPLOY_BRANCH} to ${DEPLOY_HOST}:${DEPLOY_PATH}"

ssh "$DEPLOY_HOST" \
  "DEPLOY_PATH='$DEPLOY_PATH' DEPLOY_BRANCH='$DEPLOY_BRANCH' DEPLOY_RELOAD_NGINX='$DEPLOY_RELOAD_NGINX' bash -se" <<'EOF'
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$DEPLOY_PATH"
git fetch origin "$DEPLOY_BRANCH"
git checkout "$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH"
npm ci
npm run build
npm run db:migrate
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
if [ "$DEPLOY_RELOAD_NGINX" = "1" ]; then
  sudo -n nginx -t
  sudo -n systemctl reload nginx
else
  echo "Skipping Nginx reload. Set DEPLOY_RELOAD_NGINX=1 if passwordless sudo is configured."
fi
EOF

echo "Deploy complete"
