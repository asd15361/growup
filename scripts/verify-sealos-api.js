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

async function checkVersion(baseUrl) {
  const url = `${baseUrl}/api/version`;
  const response = await fetch(url, { method: 'GET' });
  const body = await parseJsonSafe(response);
  return {
    status: response.status,
    version: typeof body?.version === 'string' ? body.version : '',
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
    code: typeof body?.code === 'string' ? body.code : '',
    requestId: typeof body?.requestId === 'string' ? body.requestId : '',
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

async function checkRecapGenerate(baseUrl, token) {
  const url = `${baseUrl}/api/recap/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      period: 'day',
      label: '2026-02-22',
      startDate: '2026-02-22',
      endDate: '2026-02-22',
      messages: [
        { id: 'm1', role: 'user', text: '今天推进了需求梳理', createdAt: new Date().toISOString() },
        { id: 'm2', role: 'assistant', text: '听起来你完成了关键一步', createdAt: new Date().toISOString() },
      ],
    }),
  });
  const body = await parseJsonSafe(response);
  return {
    status: response.status,
    error: typeof body?.error === 'string' ? body.error : '',
    hasRecap: Boolean(body?.recap && typeof body.recap === 'object'),
  };
}

async function checkContextReset(baseUrl, token) {
  const url = `${baseUrl}/api/context/reset`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  const body = await parseJsonSafe(response);
  return {
    status: response.status,
    error: typeof body?.error === 'string' ? body.error : '',
    stateReset: Boolean(body?.stateReset),
  };
}

async function main() {
  const baseUrl = normalizeBaseUrl(
    process.argv[2] || process.env.API_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL,
  );
  const requireVector = ['1', 'true', 'yes', 'on'].includes(String(process.env.REQUIRE_VECTOR || '').trim().toLowerCase());
  const requireErrorModel = ['1', 'true', 'yes', 'on'].includes(String(process.env.REQUIRE_ERROR_MODEL || '').trim().toLowerCase());
  const requireRecapEndpoint = ['1', 'true', 'yes', 'on'].includes(String(process.env.REQUIRE_RECAP_ENDPOINT || '').trim().toLowerCase());
  const requireContextResetEndpoint = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.REQUIRE_CONTEXT_RESET_ENDPOINT || '').trim().toLowerCase(),
  );
  const requireVersionEndpoint = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.REQUIRE_VERSION_ENDPOINT || '').trim().toLowerCase(),
  );
  const expectedVersion = String(process.env.EXPECTED_DEPLOY_VERSION || '').trim();

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

  const version = await checkVersion(baseUrl);
  console.log(`[verify] GET /api/version -> ${version.status}${version.version ? `, version=${version.version}` : ''}`);
  if (requireVersionEndpoint && version.status !== 200) {
    throw new Error(`expected 200 from /api/version, got ${version.status}`);
  }
  if (expectedVersion && version.version !== expectedVersion) {
    throw new Error(`expected /api/version=${expectedVersion}, got ${version.version || 'empty'}`);
  }

  const chat = await checkChatWithoutToken(baseUrl);
  console.log(
    `[verify] POST /api/chat (no token) -> ${chat.status}${chat.error ? `, error=${chat.error}` : ''}${chat.code ? `, code=${chat.code}` : ''}${chat.requestId ? `, requestId=${chat.requestId}` : ''}`,
  );

  if (chat.status !== 401) {
    throw new Error(`expected 401 from /api/chat without token, got ${chat.status}`);
  }
  if (requireErrorModel) {
    if (chat.code !== 'AUTH_MISSING_TOKEN') {
      throw new Error(`expected code AUTH_MISSING_TOKEN from /api/chat without token, got ${chat.code || 'empty'}`);
    }
    if (!chat.requestId) {
      throw new Error('expected requestId in /api/chat without token response');
    }
  }

  const smokeUser = await registerSmokeUser(baseUrl);
  console.log(`[verify] POST /api/auth/register (smoke) -> 200, email=${smokeUser.email}`);

  const recapResult = await checkRecapGenerate(baseUrl, smokeUser.token);
  console.log(
    `[verify] POST /api/recap/generate -> ${recapResult.status}${recapResult.error ? `, error=${recapResult.error}` : ''}`,
  );

  if (requireRecapEndpoint) {
    if (recapResult.status === 404) {
      throw new Error(`expected /api/recap/generate endpoint to exist, got ${recapResult.status}`);
    }
    if (recapResult.status === 200 && !recapResult.hasRecap) {
      throw new Error('expected recap content when /api/recap/generate returns 200');
    }
  }

  const contextResetResult = await checkContextReset(baseUrl, smokeUser.token);
  console.log(
    `[verify] POST /api/context/reset -> ${contextResetResult.status}${contextResetResult.error ? `, error=${contextResetResult.error}` : ''}`,
  );

  if (requireContextResetEndpoint) {
    if (contextResetResult.status === 404) {
      throw new Error(`expected /api/context/reset endpoint to exist, got ${contextResetResult.status}`);
    }
    if (contextResetResult.status === 200 && !contextResetResult.stateReset) {
      throw new Error('expected stateReset=true when /api/context/reset returns 200');
    }
  }

  console.log('[verify] pass');
}

main().catch((error) => {
  console.error(`[verify] fail: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
