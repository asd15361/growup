#!/usr/bin/env node

const DEFAULT_API_BASE_URL = 'https://growup-api-3c44t6.cloud.sealos.io';

function normalizeBaseUrl(raw) {
  return String(raw || '')
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

async function checkHealth(baseUrl) {
  const url = `${baseUrl}/api/health`;
  const response = await fetch(url, {
    method: 'GET',
  });
  const body = await parseJsonSafe(response);

  if (!response.ok) {
    throw new Error(`health check failed: ${response.status}`);
  }

  return {
    status: response.status,
    hasPocketBase: Boolean(body?.pocketbase?.configured),
    hasVector: Boolean(body?.vector?.enabled),
    vectorConfigured: Boolean(body?.vector?.configured),
    vectorCollection: typeof body?.vector?.collection === 'string' ? body.vector.collection : '',
  };
}

async function checkChatWithoutToken(baseUrl) {
  const url = `${baseUrl}/api/chat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'smoke-check',
    }),
  });
  const body = await parseJsonSafe(response);
  return {
    status: response.status,
    error: typeof body?.error === 'string' ? body.error : '',
  };
}

async function registerSmokeUser(baseUrl) {
  const email = `smoke-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`;
  const password = 'Smoke123456';
  const url = `${baseUrl}/api/auth/register`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonSafe(response);
  if (!response.ok || typeof body?.token !== 'string' || !body.token) {
    throw new Error(`register smoke user failed: ${response.status}${body?.error ? `, ${body.error}` : ''}`);
  }
  return {
    email,
    token: body.token,
  };
}

async function checkInternalRecapBlocked(baseUrl, token) {
  const url = `${baseUrl}/api/chat`;
  const message = '请根据以下聊天记录生成\n仅返回 JSON\n"summary"\n"important"\n"todo"';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  const body = await parseJsonSafe(response);
  return {
    status: response.status,
    error: typeof body?.error === 'string' ? body.error : '',
  };
}

async function main() {
  const baseUrl = normalizeBaseUrl(
    process.argv[2] || process.env.API_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL,
  );
  const requireVector = ['1', 'true', 'yes', 'on'].includes(String(process.env.REQUIRE_VECTOR || '').trim().toLowerCase());

  if (!baseUrl) {
    throw new Error('missing API base URL');
  }

  console.log(`[verify] baseUrl=${baseUrl}`);

  const health = await checkHealth(baseUrl);
  console.log(`[verify] GET /api/health -> ${health.status}, pocketbase.configured=${health.hasPocketBase}`);
  console.log(
    `[verify] vector.enabled=${health.hasVector}, vector.configured=${health.vectorConfigured}${health.vectorCollection ? `, collection=${health.vectorCollection}` : ''}`,
  );
  if (requireVector && !health.hasVector) {
    throw new Error('expected vector.enabled=true in /api/health');
  }

  const chat = await checkChatWithoutToken(baseUrl);
  console.log(`[verify] POST /api/chat (no token) -> ${chat.status}${chat.error ? `, error=${chat.error}` : ''}`);

  if (chat.status !== 401) {
    throw new Error(`expected 401 from /api/chat without token, got ${chat.status}`);
  }

  const smokeUser = await registerSmokeUser(baseUrl);
  console.log(`[verify] POST /api/auth/register (smoke) -> 200, email=${smokeUser.email}`);

  const blocked = await checkInternalRecapBlocked(baseUrl, smokeUser.token);
  console.log(
    `[verify] POST /api/chat (internal recap with token) -> ${blocked.status}${blocked.error ? `, error=${blocked.error}` : ''}`,
  );

  if (blocked.status !== 400) {
    throw new Error(`expected 400 from /api/chat internal recap guard, got ${blocked.status}`);
  }

  console.log('[verify] pass');
}

main().catch((error) => {
  console.error(`[verify] fail: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
