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
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-https://sphere-paint.constraint.systems/api/health}"

echo "Deploying ${DEPLOY_BRANCH} to ${DEPLOY_HOST}:${DEPLOY_PATH}"

ssh "$DEPLOY_HOST" \
  "DEPLOY_PATH='$DEPLOY_PATH' DEPLOY_BRANCH='$DEPLOY_BRANCH' bash -se" <<'EOF'
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
sudo nginx -t
sudo systemctl reload nginx
EOF

curl -fsS "$DEPLOY_HEALTH_URL"
echo
echo "Deploy complete"
