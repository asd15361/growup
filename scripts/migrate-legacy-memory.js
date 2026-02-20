#!/usr/bin/env node

const DEFAULT_API_BASE_URL = 'https://growup-api-3c44t6.cloud.sealos.io';

function baseUrl() {
  return String(process.env.API_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function login(base, email, password) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonSafe(response);
  if (!response.ok || !body?.token) {
    const message = body?.error || `login failed: ${response.status}`;
    throw new Error(message);
  }
  return body.token;
}

async function callAuthed(base, token, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await parseJsonSafe(response);
  return { ok: response.ok, status: response.status, data };
}

async function main() {
  const base = baseUrl();
  const email = String(process.env.MIGRATE_EMAIL || '').trim();
  const password = String(process.env.MIGRATE_PASSWORD || '').trim();

  if (!email || !password) {
    throw new Error('missing MIGRATE_EMAIL or MIGRATE_PASSWORD');
  }

  const token = await login(base, email, password);
  console.log(`[migrate] login success: ${email}`);

  const identityRes = await callAuthed(base, token, 'GET', '/api/identity');
  if (!identityRes.ok) {
    throw new Error(`fetch identity failed: ${identityRes.status} ${identityRes.data?.error || ''}`.trim());
  }
  const stateRes = await callAuthed(base, token, 'GET', '/api/state');
  if (!stateRes.ok) {
    throw new Error(`fetch state failed: ${stateRes.status} ${stateRes.data?.error || ''}`.trim());
  }

  const identity = identityRes.data?.identity || null;
  const state = stateRes.data?.state || null;

  if (identity) {
    const saveIdentityRes = await callAuthed(base, token, 'POST', '/api/identity', identity);
    if (!saveIdentityRes.ok) {
      throw new Error(`save identity failed: ${saveIdentityRes.status} ${saveIdentityRes.data?.error || ''}`.trim());
    }
    console.log('[migrate] identity migrated');
  } else {
    console.log('[migrate] identity not found, skipped');
  }

  if (state) {
    const saveStateRes = await callAuthed(base, token, 'POST', '/api/state', { state });
    if (!saveStateRes.ok) {
      throw new Error(`save state failed: ${saveStateRes.status} ${saveStateRes.data?.error || ''}`.trim());
    }
    console.log('[migrate] state migrated');
  } else {
    console.log('[migrate] state not found, skipped');
  }

  const memoriesRes = await callAuthed(base, token, 'GET', '/api/memories?limit=20');
  if (!memoriesRes.ok) {
    throw new Error(`verify memories failed: ${memoriesRes.status} ${memoriesRes.data?.error || ''}`.trim());
  }

  const memories = Array.isArray(memoriesRes.data?.memories) ? memoriesRes.data.memories : [];
  const kinds = Array.from(new Set(memories.map((item) => item.kind))).join(', ') || '(none)';
  console.log(`[migrate] done. memories=${memories.length}, kinds=${kinds}`);
}

main().catch((error) => {
  console.error(`[migrate] fail: ${error?.message || String(error)}`);
  process.exit(1);
});
