# Deployment

## Target

`globe2` deploys directly to a Linux VPS. Nginx serves the built client, terminates TLS, and proxies `/api` plus `/api/ws` to the Fastify server. PM2 runs two Node processes:

- `sphere-paint-api`
- `sphere-paint-worker`

## Required Environment

Create `/var/www/globe2/current/.env` on the VPS:

```env
DATABASE_URL=postgres://...
APP_ORIGIN=https://your-domain.com
SERVER_HOST=127.0.0.1
SERVER_PORT=47291
SNAPSHOT_STORE_MODE=s3
AWS_REGION=your-bucket-region
AWS_S3_BUCKET=your-snapshot-bucket
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
VISIT_TIMEOUT_SECONDS=120
SNAPSHOT_CHECK_INTERVAL_SECONDS=60
SNAPSHOT_MIN_ELIGIBLE_DRAWINGS=500
SNAPSHOT_AGE_HOURS=24
SNAPSHOT_MIN_AGED_DRAWINGS=50
ADMIN_SECRET=...
```

Set the S3 bucket CORS allowed origins to include `APP_ORIGIN`.

## Build

From the release directory:

```sh
npm ci
npm run build
npm run db:migrate
```

## Deploy From Local

After pushing changes to GitHub, deploy from your local checkout:

```sh
npm run deploy
```

For local deploy settings, copy `.env.deploy.example` to `.env.deploy` and edit it:

```sh
cp .env.deploy.example .env.deploy
```

`.env.deploy` is ignored by Git. Use it for the SSH host/IP and remote path, not for an SSH password. Prefer SSH keys and your SSH agent.

The script defaults to:

- `DEPLOY_HOST=grant@basic-droplet`
- `DEPLOY_PATH=/home/grant/sphere-paint`
- `DEPLOY_BRANCH=main`
- `DEPLOY_HEALTH_URL=https://sphere-paint.constraint.systems/api/health`

Override them per run if needed:

```sh
DEPLOY_HOST=grant@your-host DEPLOY_PATH=/path/to/repo npm run deploy
```

## PM2

The PM2 config uses the directory containing `ecosystem.config.cjs` as its working directory.

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```

For updates:

```sh
npm ci
npm run build
npm run db:migrate
pm2 reload ecosystem.config.cjs --update-env
```

## Nginx

Copy `docs/nginx/globe2.conf` to `/etc/nginx/sites-available/globe2`, replace `example.com`, then enable it:

```sh
sudo ln -s /etc/nginx/sites-available/globe2 /etc/nginx/sites-enabled/globe2
sudo nginx -t
sudo systemctl reload nginx
```

Use Certbot or your normal TLS automation to add HTTPS.

## Smoke Checks

```sh
curl -fsS https://your-domain.com/api/health
curl -fsS -X POST -H "Authorization: Bearer $ADMIN_SECRET" https://your-domain.com/api/admin/force-snapshot
```

Then load the site and confirm `/api/bootstrap` returns S3 `snapshot.faces.*.url` values.
