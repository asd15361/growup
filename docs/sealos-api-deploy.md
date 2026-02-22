# GrowUp API Sealos Deployment

Last updated: 2026-02-22

## 1) Goal

Deploy backend API on Sealos and connect to the new shared PocketBase instance:

- PocketBase: `https://pocketbase-jcgrvdda.cloud.sealos.io`
- Backend entry: `server/index.js`
- Dockerfile: `Dockerfile.sealos-api`

## 2) Required Environment Variables

Set in Sealos runtime:

```env
PORT=8787
POCKETBASE_URL_NEW=https://pocketbase-jcgrvdda.cloud.sealos.io
POCKETBASE_USERS_COLLECTION=users
POCKETBASE_CHAT_COLLECTION=growup_chat_messages
POCKETBASE_MEMORIES_COLLECTION=growup_memories
POCKETBASE_USER_APPS_COLLECTION=user_apps
POCKETBASE_APP_ID=mobile
POCKETBASE_APP_ID_WHITELIST=mobile,web,admin
POCKETBASE_DEFAULT_USER_ROLE=member
POCKETBASE_DEFAULT_USER_STATUS=active
DEEPSEEK_API_KEY=<your-key>
DEEPSEEK_TEXT_MODEL=deepseek-chat
DEEPSEEK_VISION_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
APP_VERSION=<app-version>
DEPLOY_GIT_SHA=<git-sha>
DEPLOY_IMAGE_DIGEST=<image-digest-or-tag>
BUILD_TIME=<iso-time>
```

Optional timeouts:

```env
MODEL_TIMEOUT_MS=45000
POCKETBASE_TIMEOUT_MS=15000
CHAT_PERSIST_TIMEOUT_MS=1500
```

## 3) Deploy PocketBase Schema First

Run locally (never commit superuser credentials):

```powershell
$env:POCKETBASE_URL_NEW="https://pocketbase-jcgrvdda.cloud.sealos.io"
$env:POCKETBASE_SUPERUSER_EMAIL="<superuser-email>"
$env:POCKETBASE_SUPERUSER_PASSWORD="<superuser-password>"
npm run deploy:pocketbase
```

## 4) Backend Verification

After API deployment:

1. `GET <API_DOMAIN>/api/health` should return `ok: true`.
2. `pocketbase.configured` should be `true`.
3. Returned pocketbase info should include:
   - `usersCollection: users`
   - `chatCollection: growup_chat_messages`
   - `memoriesCollection: growup_memories`
   - `userAppsCollection: user_apps`
   - `appId: mobile`
4. `POST <API_DOMAIN>/api/chat` without token should return `401`.
5. `POST <API_DOMAIN>/api/context/reset` with token should return `200` and `stateReset: true`.

Quick smoke:

```bash
npm run smoke:sealos
```

Strict smoke for rollout gates:

```bash
REQUIRE_VERSION_ENDPOINT=1 REQUIRE_ERROR_MODEL=1 REQUIRE_RECAP_ENDPOINT=1 REQUIRE_CONTEXT_RESET_ENDPOINT=1 npm run smoke:sealos
```

Strict smoke with expected deploy version:

```bash
REQUIRE_VERSION_ENDPOINT=1 REQUIRE_ERROR_MODEL=1 REQUIRE_RECAP_ENDPOINT=1 REQUIRE_CONTEXT_RESET_ENDPOINT=1 EXPECTED_DEPLOY_VERSION=1.19.11 npm run smoke:sealos
```

## 5) Root-Cause Fix (No More Manual Drift)

Use automated deploy + strict verify instead of manual click-only flow.

### 5.1 Sealos Webhook (one-time setup)

Create a redeploy webhook in Sealos for backend app `growup-api-3c44t6` and record:

- `SEALOS_REDEPLOY_WEBHOOK_URL`
- Optional token and header:
  - `SEALOS_REDEPLOY_WEBHOOK_TOKEN`
  - `SEALOS_REDEPLOY_WEBHOOK_TOKEN_HEADER` (default `Authorization`)

### 5.2 One-command local deploy verification

```bash
API_BASE_URL=https://growup-api-3c44t6.cloud.sealos.io \
SEALOS_REDEPLOY_WEBHOOK_URL=<your-webhook> \
SEALOS_REDEPLOY_WEBHOOK_TOKEN=<optional-token> \
EXPECTED_DEPLOY_VERSION=1.19.11 \
npm run deploy:sealos
```

If webhook is not available yet, run verify-only mode first:

```bash
API_BASE_URL=https://growup-api-3c44t6.cloud.sealos.io \
DEPLOY_SKIP_REDEPLOY_TRIGGER=1 \
npm run deploy:sealos
```

What this command does:

1. Trigger Sealos redeploy webhook
2. Poll strict smoke gates until pass or timeout
3. Fail loudly with exact gate reason

### 5.3 GitHub Actions (recommended single deploy入口)

Workflow file: `.github/workflows/sealos-backend-deploy.yml`

Configure repository secrets:

- `SEALOS_API_BASE_URL`
- `SEALOS_REDEPLOY_WEBHOOK_URL`
- `SEALOS_REDEPLOY_WEBHOOK_TOKEN` (optional)
- `SEALOS_REDEPLOY_WEBHOOK_TOKEN_HEADER` (optional)

Then trigger workflow manually (`workflow_dispatch`) or let `master` push auto-run.

## 6) Notes

- Do not keep real credentials in repository.
- If schema changed, always rerun `deploy:pocketbase` and re-verify rules/indexes.
