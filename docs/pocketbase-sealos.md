# GrowUp PocketBase (Sealos) Deployment Notes

Last updated: 2026-02-20

## 1) Instance Overview

- Provider: Sealos Cloud
- Region: Singapore
- Template: PocketBase (App Store)
- Instance status: running
- Public endpoint in use: `https://pocketbase-tocxusnx.cloud.sealos.io`

## 2) Network Endpoints

- Public URL (app/backend should use):
  - `https://pocketbase-tocxusnx.cloud.sealos.io`
- Admin console:
  - `https://pocketbase-tocxusnx.cloud.sealos.io/_/`

## 3) Secrets Policy

This repository no longer stores plaintext PocketBase secrets.

Store these values only in secure places:
- PocketBase admin email/password
- `PB_ENCRYPTION_KEY`

If any secret was exposed before, rotate it immediately.

## 4) Local Environment Configuration

Set these values in `.env.local`:

```env
POCKETBASE_URL_NEW=https://pocketbase-tocxusnx.cloud.sealos.io
POCKETBASE_USERS_COLLECTION=users
POCKETBASE_CHAT_COLLECTION=chat_messages
POCKETBASE_MEMORIES_COLLECTION=memories
```

Backend fallback behavior:
- `POCKETBASE_URL_NEW` is preferred.
- If missing, code falls back to `POCKETBASE_URL`.

## 5) PocketBase Collections Required by App

### `users` (Auth collection)

- Type: auth collection (email/password login)
- Suggested extra field:
  - `name` (text)

### `chat_messages` (Base collection)

Required fields:
- `user` (relation -> `users`, required, max select 1)
- `role` (text, values: `user` / `assistant` / `system`)
- `text` (text)
- `model` (text, optional)
- `image` (file, optional)

Internal usage:
- Stores only user/assistant chat records in current architecture.
- Legacy compatibility: old `system` snapshots can still be read by backend fallback.

### `memories` (Base collection)

Required fields (at least one content field is enough):
- `user` (relation -> `users`, required, max select 1)
- `kind` (text, recommended values: `identity-v1` / `state-v1`)
- `content` (text, JSON string) or `text` (text, JSON string)

Optional fields:
- `type` (text, compatibility)
- `model` (text, compatibility)

Recommended API rules (list/view/create/update/delete):

```txt
@request.auth.id != "" && user = @request.auth.id
```

## 6) Quick Verification

- `GET https://pocketbase-tocxusnx.cloud.sealos.io/api/health` -> `200`
- `GET https://pocketbase-tocxusnx.cloud.sealos.io/_/` -> `200`
- Local backend `GET /api/health` should show `pocketbase.configured: true`

## 7) App Integration Checklist

1. Keep `ZHIPU_API_KEY` in `.env.local`.
2. Set `POCKETBASE_URL_NEW` to the Sealos PocketBase URL.
3. Verify `users`, `chat_messages`, `memories` collections in PocketBase admin.
4. Start backend: `npm run server`.
5. Verify `GET /api/health`.
