# GrowUp PocketBase (Sealos) Deployment Notes

Last updated: 2026-02-18

## 1) Instance Overview

- Provider: Sealos Cloud
- Region: Singapore
- Team/Workspace: Private Team
- Template: PocketBase (App Store)
- Sealos app name used during deploy: `growup-pocketbase-sealos`
- Instance name: `pocketbase-wydxpmyd`
- Status: running
- Created at (Sealos): `2026-02-18 16:41`
- Container image: `adrianmusante/pocketbase:0.29.3`

## 2) Network Endpoints

- Public URL (use this in app/backend):
  - `https://pocketbase-tocxusnx.cloud.sealos.io`
- Internal URL (Sealos internal service):
  - `http://pocketbase-wydxpmyd.ns-i0nobo1l:3000`
- Admin console:
  - `https://pocketbase-tocxusnx.cloud.sealos.io/_/`

## 3) Admin Credentials

- Admin email: `growup.admin@local.dev`
- Admin password: `GrowupPB_2026!J8vF`
- PB_ENCRYPTION_KEY (from deploy form): `oxobzaynobktddkfushggffkszfxflsr`

Security note: these are production-like secrets. Rotate password/key if this file is shared externally.

## 4) Local Environment Configuration

Set these values in `.env.local`:

```env
POCKETBASE_URL_NEW=https://pocketbase-tocxusnx.cloud.sealos.io
POCKETBASE_USERS_COLLECTION=users
POCKETBASE_CHAT_COLLECTION=chat_messages
```

Current backend fallback behavior:
- `POCKETBASE_URL_NEW` is preferred.
- If missing, code falls back to `POCKETBASE_URL`.

## 5) PocketBase Collections Required by GrowUp

### `users` (Auth collection)

- Type: auth collection (email/password login)
- Status on this instance: already exists (id: `_pb_users_auth_`)
- Suggested extra fields:
  - `name` (text)

### `chat_messages` (Base collection)

- Status on this instance: created (id: `pbc_102036695`)
- `user` (relation -> `users`, required, max select 1)
- `role` (text, values: `user` / `assistant` / `system`)
- `text` (text)
- `model` (text, optional)
- `image` (file, optional)

Recommended API rules (list/view/create/update/delete):

```txt
@request.auth.id != "" && user.id = @request.auth.id
```

## 6) Quick Verification

Verified from local shell:

- `GET https://pocketbase-tocxusnx.cloud.sealos.io/api/health` -> `200`
- `GET https://pocketbase-tocxusnx.cloud.sealos.io/_/` -> `200`
- Start local backend and call `GET http://localhost:8787/api/health` -> `pocketbase.configured: true`
- `POST http://localhost:8787/api/auth/register` smoke test -> success (temporary user created and then deleted)

## 7) App Integration Checklist

1. Keep `ZHIPU_API_KEY` in `.env.local`.
2. Set `POCKETBASE_URL_NEW` to this new Sealos URL.
3. Verify `users` and `chat_messages` collections in PocketBase admin.
4. Start backend: `npm run server`.
5. Check health endpoint: `GET /api/health` and confirm `pocketbase.configured = true`.
