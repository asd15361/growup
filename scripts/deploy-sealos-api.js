#!/usr/bin/env node

const { spawn } = require('node:child_process');

const DEFAULT_API_BASE_URL = 'https://growup-api-3c44t6.cloud.sealos.io';

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function isEnabled(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

async function triggerRedeployWebhook(url, token, tokenHeaderName) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    if (tokenHeaderName.toLowerCase() === 'authorization') {
      headers.Authorization = `Bearer ${token}`;
    } else {
      headers[tokenHeaderName] = token;
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'growup/scripts/deploy-sealos-api.js',
      timestamp: new Date().toISOString(),
      note: 'trigger backend redeploy and wait for strict smoke pass',
    }),
  });

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`redeploy webhook failed: ${response.status}${text ? `, body=${text.slice(0, 400)}` : ''}`);
  }
}

async function runStrictSmoke(baseUrl, expectedVersion) {
  const env = {
    ...process.env,
    API_BASE_URL: baseUrl,
    REQUIRE_ERROR_MODEL: '1',
    REQUIRE_RECAP_ENDPOINT: '1',
    REQUIRE_CONTEXT_RESET_ENDPOINT: '1',
    REQUIRE_VERSION_ENDPOINT: '1',
  };
  if (expectedVersion) {
    env.EXPECTED_DEPLOY_VERSION = expectedVersion;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/verify-sealos-api.js'], {
      stdio: 'inherit',
      env,
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`strict smoke exited with code ${code}`));
    });
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.API_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL);
  const webhookUrl = String(process.env.SEALOS_REDEPLOY_WEBHOOK_URL || '').trim();
  const webhookToken = String(process.env.SEALOS_REDEPLOY_WEBHOOK_TOKEN || '').trim();
  const webhookTokenHeaderName = String(process.env.SEALOS_REDEPLOY_WEBHOOK_TOKEN_HEADER || 'Authorization').trim() || 'Authorization';
  const expectedVersion = String(process.env.EXPECTED_DEPLOY_VERSION || '').trim();

  const verifyTimeoutMs = toPositiveInt(process.env.DEPLOY_VERIFY_TIMEOUT_MS, 10 * 60 * 1000);
  const verifyIntervalMs = toPositiveInt(process.env.DEPLOY_VERIFY_INTERVAL_MS, 15 * 1000);
  const skipTrigger = isEnabled(process.env.DEPLOY_SKIP_REDEPLOY_TRIGGER, false);

  if (!baseUrl) {
    throw new Error('missing API_BASE_URL');
  }

  console.log(`[deploy] baseUrl=${baseUrl}`);
  if (expectedVersion) {
    console.log(`[deploy] expectedVersion=${expectedVersion}`);
  }

  if (!skipTrigger) {
    if (!webhookUrl) {
      throw new Error('missing SEALOS_REDEPLOY_WEBHOOK_URL');
    }
    console.log('[deploy] triggering Sealos redeploy webhook...');
    await triggerRedeployWebhook(webhookUrl, webhookToken, webhookTokenHeaderName);
    console.log('[deploy] webhook accepted. waiting for rollout...');
  } else {
    console.log('[deploy] skip trigger enabled, verify only mode.');
  }

  const deadline = Date.now() + verifyTimeoutMs;
  let attempt = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    attempt += 1;
    console.log(`[deploy] strict smoke attempt ${attempt}...`);
    try {
      await runStrictSmoke(baseUrl, expectedVersion);
      console.log('[deploy] strict smoke passed. deployment is healthy.');
      return;
    } catch (error) {
      lastError = error;
      const remainMs = Math.max(0, deadline - Date.now());
      console.log(`[deploy] strict smoke not ready yet: ${error.message}`);
      if (remainMs <= 0) break;
      console.log(`[deploy] retry in ${Math.min(verifyIntervalMs, remainMs)}ms...`);
      await sleep(Math.min(verifyIntervalMs, remainMs));
    }
  }

  throw new Error(`deployment verification timed out after ${verifyTimeoutMs}ms${lastError ? `, lastError=${lastError.message}` : ''}`);
}

main().catch((error) => {
  console.error(`[deploy] fail: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
