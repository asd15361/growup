const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

let PocketBase;
try {
  PocketBase = require('pocketbase/cjs');
} catch {
  PocketBase = require('pocketbase');
}

const localEnvPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}
dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 8787);
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_TEXT_MODEL = (process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-chat').trim();
const DEEPSEEK_VISION_MODEL = (process.env.DEEPSEEK_VISION_MODEL || DEEPSEEK_TEXT_MODEL).trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
const DEEPSEEK_CHAT_URL = `${DEEPSEEK_BASE_URL}/chat/completions`;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 45000);
const MODEL_MAX_TOKENS = Number(process.env.MODEL_MAX_TOKENS || 2200);
const CHAT_PERSIST_TIMEOUT_MS = Number(process.env.CHAT_PERSIST_TIMEOUT_MS || 1500);
const POCKETBASE_TIMEOUT_MS = Number(process.env.POCKETBASE_TIMEOUT_MS || 15000);
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 300000);
const VECTOR_ENABLED_RAW = (process.env.VECTOR_ENABLED || '').trim().toLowerCase();
const VECTOR_ENABLED = VECTOR_ENABLED_RAW
  ? ['1', 'true', 'yes', 'on'].includes(VECTOR_ENABLED_RAW)
  : true;
const QDRANT_URL = (process.env.QDRANT_URL || '').trim().replace(/\/+$/, '');
const QDRANT_API_KEY = (process.env.QDRANT_API_KEY || '').trim();
const QDRANT_COLLECTION = (process.env.QDRANT_COLLECTION || 'growup_memories').trim();
const VECTOR_DIM = Number(process.env.VECTOR_DIM || 384);
const VECTOR_TOP_K = Number(process.env.VECTOR_TOP_K || 6);
const VECTOR_TEXT_MAX_CHARS = Number(process.env.VECTOR_TEXT_MAX_CHARS || 1200);
const VECTOR_TIMEOUT_MS = Number(process.env.VECTOR_TIMEOUT_MS || 1500);
const VECTOR_BACKOFF_MS = Number(process.env.VECTOR_BACKOFF_MS || 60000);
const VECTOR_MIN_QUERY_CHARS = Number(process.env.VECTOR_MIN_QUERY_CHARS || 4);

const LEGACY_PB_URL = 'https://pocketbase-tocxusnx.cloud.sealos.io';
const TARGET_PB_URL = 'https://pocketbase-jcgrvdda.cloud.sealos.io';
const LEGACY_CHAT_COLLECTION = 'chat_messages';
const LEGACY_MEMORIES_COLLECTION = 'memories';
const TARGET_CHAT_COLLECTION = 'growup_chat_messages';
const TARGET_MEMORIES_COLLECTION = 'growup_memories';

const PB_URL_RAW = (process.env.POCKETBASE_URL_NEW || process.env.POCKETBASE_URL || '').trim();
const PB_USERS_COLLECTION = (process.env.POCKETBASE_USERS_COLLECTION || 'users').trim();
const PB_CHAT_COLLECTION_RAW = (process.env.POCKETBASE_CHAT_COLLECTION || TARGET_CHAT_COLLECTION).trim();
const PB_MEMORIES_COLLECTION_RAW = (process.env.POCKETBASE_MEMORIES_COLLECTION || TARGET_MEMORIES_COLLECTION).trim();
const PB_URL = PB_URL_RAW === LEGACY_PB_URL ? TARGET_PB_URL : PB_URL_RAW;
const PB_CHAT_COLLECTION = PB_CHAT_COLLECTION_RAW === LEGACY_CHAT_COLLECTION ? TARGET_CHAT_COLLECTION : PB_CHAT_COLLECTION_RAW;
const PB_MEMORIES_COLLECTION =
  PB_MEMORIES_COLLECTION_RAW === LEGACY_MEMORIES_COLLECTION ? TARGET_MEMORIES_COLLECTION : PB_MEMORIES_COLLECTION_RAW;
const PB_URL_REMAPPED = PB_URL_RAW !== '' && PB_URL_RAW !== PB_URL;
const PB_CHAT_REMAPPED = PB_CHAT_COLLECTION_RAW !== PB_CHAT_COLLECTION;
const PB_MEMORIES_REMAPPED = PB_MEMORIES_COLLECTION_RAW !== PB_MEMORIES_COLLECTION;
const PB_USER_APPS_COLLECTION = (process.env.POCKETBASE_USER_APPS_COLLECTION || 'user_apps').trim();
const PB_APP_ID = (process.env.POCKETBASE_APP_ID || 'mobile').trim();
const PB_APP_ID_WHITELIST = Array.from(
  new Set(
    String(process.env.POCKETBASE_APP_ID_WHITELIST || 'mobile,web,admin')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ),
);
const PB_DEFAULT_USER_ROLE = (process.env.POCKETBASE_DEFAULT_USER_ROLE || 'member').trim();
const PB_DEFAULT_USER_STATUS = (process.env.POCKETBASE_DEFAULT_USER_STATUS || 'active').trim();
const IDENTITY_PREFIX = '__identity__::';
const STATE_PREFIX = '__app_state__::';
const STATE_MODEL = 'state-v1';
const MEMORY_KIND_IDENTITY = 'identity-v1';
const MEMORY_KIND_STATE = 'state-v1';

let vectorCollectionReady = false;
let vectorBackoffUntil = 0;
const authCache = new Map();

if (!PB_APP_ID_WHITELIST.includes(PB_APP_ID)) {
  throw new Error(
    `POCKETBASE_APP_ID "${PB_APP_ID}" is not allowed by POCKETBASE_APP_ID_WHITELIST (${PB_APP_ID_WHITELIST.join(',')})`,
  );
}

app.use(cors());
app.use(express.json({ limit: '25mb' }));

function createPb() {
  if (!PB_URL) {
    throw new Error('POCKETBASE_URL_NEW is missing');
  }
  return new PocketBase(PB_URL);
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return role || PB_DEFAULT_USER_ROLE;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return status || PB_DEFAULT_USER_STATUS;
}

function escapeFilterValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function buildUserAppFilter(userId, includeAppId = true) {
  const rules = [`user = "${escapeFilterValue(userId)}"`];
  if (includeAppId) {
    rules.push(`appId = "${escapeFilterValue(PB_APP_ID)}"`);
  }
  return rules.join(' && ');
}

function buildAuditCreateFields(userId) {
  return {
    appId: PB_APP_ID,
    createdBy: userId,
    updatedBy: userId,
  };
}

function buildAuditUpdateFields(userId) {
  return {
    appId: PB_APP_ID,
    updatedBy: userId,
  };
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

function decodeBase64Url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const raw = decodeBase64Url(parts[1]);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isInternalRecapPrompt(message) {
  const text = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : '';
  return text.startsWith('请根据以下聊天记录生成')
    && text.includes('仅返回 JSON')
    && text.includes('"summary"')
    && text.includes('"important"')
    && text.includes('"todo"');
}

function isInternalRecapJsonReply(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text.startsWith('{')) return false;
  return text.includes('"summary"')
    && text.includes('"important"')
    && text.includes('"todo"');
}

function stripUser(record) {
  if (!record) return null;
  return {
    id: record.id,
    email: record.email || '',
    name: record.name || '',
  };
}

function dataUrlToUpload(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1];
  const base64 = match[2];
  const extension = mimeType.split('/')[1]?.split('+')[0] || 'jpg';
  const binary = Buffer.from(base64, 'base64');
  const blob = new Blob([binary], { type: mimeType });
  return {
    blob,
    filename: `img-${Date.now()}.${extension}`,
  };
}

function fileUrl(pb, record, field) {
  if (!record || !record[field]) return '';
  const value = record[field];
  const name = Array.isArray(value) ? value[0] : value;
  if (!name) return '';
  try {
    return pb.files.getURL(record, name);
  } catch {
    return '';
  }
}

function isMissingCollectionLikeError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = String(error?.response?.message || error?.message || '').toLowerCase();
  if (status === 404 && message.includes('collection')) return true;
  return message.includes('collection') && (message.includes('missing') || message.includes('not found'));
}

async function ensureUserAppBinding(pb, user) {
  if (!pb || !user?.id) return null;

  const userId = String(user.id);
  const filter = `user = "${escapeFilterValue(userId)}" && appId = "${escapeFilterValue(PB_APP_ID)}"`;
  let existing = null;

  try {
    existing = await pb.collection(PB_USER_APPS_COLLECTION).getFirstListItem(filter);
  } catch (error) {
    const status = Number(error?.status || error?.response?.status || 0);
    if (status !== 404 && !isMissingCollectionLikeError(error)) {
      console.warn(`[user_apps] load binding failed: ${error?.message || 'unknown error'}`);
      return null;
    }
  }

  const now = new Date().toISOString();
  if (existing) {
    const currentRole = normalizeRole(existing.role || user.role);
    const currentStatus = normalizeStatus(existing.status || user.status);
    const patch = {
      role: currentRole,
      status: currentStatus,
      lastLoginAt: now,
      ...buildAuditUpdateFields(userId),
    };

    try {
      await pb.collection(PB_USER_APPS_COLLECTION).update(existing.id, patch);
    } catch (error) {
      if (!isMissingCollectionLikeError(error)) {
        console.warn(`[user_apps] update binding failed: ${error?.message || 'unknown error'}`);
      }
    }

    return {
      id: existing.id,
      appId: PB_APP_ID,
      user: userId,
      role: currentRole,
      status: currentStatus,
    };
  }

  const createdPayload = {
    user: userId,
    appId: PB_APP_ID,
    role: normalizeRole(user.role),
    status: normalizeStatus(user.status),
    firstLoginAt: now,
    lastLoginAt: now,
    ...buildAuditCreateFields(userId),
  };

  try {
    const created = await pb.collection(PB_USER_APPS_COLLECTION).create(createdPayload);
    return {
      id: created.id,
      appId: PB_APP_ID,
      user: userId,
      role: normalizeRole(created.role || createdPayload.role),
      status: normalizeStatus(created.status || createdPayload.status),
    };
  } catch (error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const message = String(error?.response?.message || error?.message || '').toLowerCase();
    if (status === 400 && message.includes('unique')) {
      try {
        const found = await pb.collection(PB_USER_APPS_COLLECTION).getFirstListItem(filter);
        return {
          id: found.id,
          appId: PB_APP_ID,
          user: userId,
          role: normalizeRole(found.role || createdPayload.role),
          status: normalizeStatus(found.status || createdPayload.status),
        };
      } catch {
        return {
          id: '',
          appId: PB_APP_ID,
          user: userId,
          role: createdPayload.role,
          status: createdPayload.status,
        };
      }
    }

    if (!isMissingCollectionLikeError(error)) {
      console.warn(`[user_apps] create binding failed: ${error?.message || 'unknown error'}`);
    }
    return null;
  }
}

function hasAppAccess(auth) {
  const status = normalizeStatus(auth?.userApp?.status || auth?.user?.status || PB_DEFAULT_USER_STATUS);
  return status !== 'blocked' && status !== 'disabled' && status !== 'inactive';
}

async function authByToken(token) {
  const now = Date.now();
  const cached = authCache.get(token);
  if (cached && cached.expiresAt > now) {
    const pbCached = createPb();
    pbCached.authStore.save(token, null);
    const userApp = await ensureUserAppBinding(pbCached, cached.user);
    const role = normalizeRole(userApp?.role || cached.user?.role || PB_DEFAULT_USER_ROLE);
    return {
      pb: pbCached,
      token,
      user: { ...cached.user, role },
      userApp,
    };
  }

  const jwtPayload = parseJwtPayload(token);
  const expMs = Number(jwtPayload?.exp || 0) * 1000;
  const tokenUserId = String(jwtPayload?.id || jwtPayload?.sub || '').trim();
  if (tokenUserId && Number.isFinite(expMs) && expMs > now + 5000) {
    const user = {
      id: tokenUserId,
      email: typeof jwtPayload?.email === 'string' ? jwtPayload.email : '',
      name: typeof jwtPayload?.name === 'string' ? jwtPayload.name : '',
      role: typeof jwtPayload?.role === 'string' ? jwtPayload.role : '',
      status: typeof jwtPayload?.status === 'string' ? jwtPayload.status : '',
    };
    const expiresAt = Math.min(expMs, now + Math.max(30000, AUTH_CACHE_TTL_MS));
    authCache.set(token, { user, expiresAt });

    const pbFast = createPb();
    pbFast.authStore.save(token, null);
    const userApp = await ensureUserAppBinding(pbFast, user);
    const role = normalizeRole(userApp?.role || user.role || PB_DEFAULT_USER_ROLE);
    return {
      pb: pbFast,
      token,
      user: { ...user, role },
      userApp,
    };
  }

  const pb = createPb();
  pb.authStore.save(token, null);
  const authData = await withTimeout(pb.collection(PB_USERS_COLLECTION).authRefresh(), POCKETBASE_TIMEOUT_MS, 'auth refresh');
  const user = authData.record;
  const userApp = await ensureUserAppBinding(pb, user);
  const role = normalizeRole(userApp?.role || user?.role || PB_DEFAULT_USER_ROLE);
  if (user && user.id) {
    authCache.set(token, {
      user: { ...user, role },
      expiresAt: now + Math.max(30000, AUTH_CACHE_TTL_MS),
    });
  }
  return {
    pb,
    token: authData.token || token,
    user: { ...user, role },
    userApp,
  };
}

function mapMessageRecord(pb, record) {
  const roleRaw = String(record?.role || '').trim().toLowerCase();
  return {
    id: record.id,
    role: roleRaw === 'user' ? 'user' : 'assistant',
    text: record.text || '',
    imageUri: fileUrl(pb, record, 'image') || undefined,
    createdAt: record.created || new Date().toISOString(),
  };
}

function isSystemMessageRecord(record) {
  return String(record?.role || '').toLowerCase() === 'system';
}

async function listUserChatRecords(pb, userId, page = 1, perPage = 120) {
  try {
    return await pb.collection(PB_CHAT_COLLECTION).getList(page, perPage, {
      filter: buildUserAppFilter(userId, true),
      sort: 'created,id',
    });
  } catch (error) {
    if (!isFilterFieldError(error)) throw error;
    return pb.collection(PB_CHAT_COLLECTION).getList(page, perPage, {
      filter: buildUserAppFilter(userId, false),
      sort: 'created,id',
    });
  }
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(`request timeout after ${timeoutMs}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function waitMs(ms, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function withTimeout(promise, timeoutMs, label = 'pocketbase') {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isVectorConfigured() {
  return VECTOR_ENABLED && Boolean(QDRANT_URL) && VECTOR_DIM > 0;
}

function shouldSkipVectorTemporarily() {
  return Date.now() < vectorBackoffUntil;
}

function scheduleVectorRetry(reason) {
  vectorCollectionReady = false;
  vectorBackoffUntil = Date.now() + Math.max(1000, VECTOR_BACKOFF_MS);
  if (reason) {
    console.warn(`[vector] temporarily disabled: ${reason}`);
  }
}

function normalizeTextForVector(text) {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.slice(0, Math.max(200, VECTOR_TEXT_MAX_CHARS));
}

function createVectorTokens(text) {
  const normalized = normalizeTextForVector(text).toLowerCase();
  if (!normalized) return [];

  const words = normalized.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const chars = normalized.replace(/\s+/g, '').split('');
  const bigrams = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    bigrams.push(`${chars[i]}${chars[i + 1]}`);
  }
  return [...words, ...chars, ...bigrams];
}

function localHashEmbedding(text) {
  const dim = Math.max(32, VECTOR_DIM);
  const vector = new Array(dim).fill(0);
  const tokens = createVectorTokens(text);

  if (!tokens.length) {
    return vector;
  }

  for (const token of tokens) {
    const hash = crypto.createHash('sha1').update(token).digest();
    const indexA = hash.readUInt32BE(0) % dim;
    const indexB = hash.readUInt32BE(4) % dim;
    const signA = hash[8] % 2 === 0 ? 1 : -1;
    const signB = hash[9] % 2 === 0 ? 1 : -1;
    vector[indexA] += signA;
    vector[indexB] += signB * 0.5;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] = Number((vector[i] / norm).toFixed(6));
    }
  }
  return vector;
}

function toDeterministicUuid(input) {
  const hash = crypto.createHash('sha1').update(String(input || '')).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `a${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

async function qdrantRequest(method, endpoint, body) {
  if (!QDRANT_URL) {
    const error = new Error('QDRANT_URL is missing');
    error.status = 503;
    throw error;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (QDRANT_API_KEY) {
    headers['api-key'] = QDRANT_API_KEY;
  }

  return fetchJsonWithTimeout(
    `${QDRANT_URL}${endpoint}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    VECTOR_TIMEOUT_MS,
  );
}

async function ensureVectorCollection() {
  if (!isVectorConfigured() || shouldSkipVectorTemporarily()) return false;
  if (vectorCollectionReady) return true;

  const collectionPath = `/collections/${encodeURIComponent(QDRANT_COLLECTION)}`;
  try {
    const check = await qdrantRequest('GET', collectionPath);
    if (check.response.status === 404) {
      const created = await qdrantRequest('PUT', collectionPath, {
        vectors: { size: VECTOR_DIM, distance: 'Cosine' },
      });
      if (!created.response.ok) {
        throw new Error(`create collection failed: ${created.response.status}`);
      }
    } else if (!check.response.ok) {
      throw new Error(`check collection failed: ${check.response.status}`);
    }

    vectorCollectionReady = true;
    vectorBackoffUntil = 0;
    return true;
  } catch (error) {
    scheduleVectorRetry(error?.message || 'qdrant unavailable');
    return false;
  }
}

function formatVectorMemoryItem(payload) {
  const sourceText = normalizeTextForVector(payload?.text || payload?.summary || '');
  if (!sourceText) return '';
  const createdAt = typeof payload?.createdAt === 'string' ? payload.createdAt : '';
  const date = createdAt ? createdAt.slice(0, 10) : '';
  return date ? `[${date}] ${sourceText}` : sourceText;
}

async function searchVectorMemories(userId, queryText, topK = VECTOR_TOP_K) {
  if (!isVectorConfigured() || shouldSkipVectorTemporarily()) return [];
  const safeQuery = normalizeTextForVector(queryText);
  if (safeQuery.length < Math.max(1, VECTOR_MIN_QUERY_CHARS)) return [];

  const ready = await ensureVectorCollection();
  if (!ready) return [];

  const vector = localHashEmbedding(safeQuery);
  const collectionPath = `/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points/search`;

  try {
    const { response, data } = await qdrantRequest('POST', collectionPath, {
      vector,
      limit: Math.max(1, Math.min(topK, 12)),
      with_payload: true,
      with_vector: false,
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
      },
    });

    if (!response.ok) {
      throw new Error(`search failed: ${response.status}`);
    }

    const points = Array.isArray(data?.result) ? data.result : [];
    return points
      .map((point) => formatVectorMemoryItem(point?.payload || {}))
      .filter(Boolean);
  } catch (error) {
    scheduleVectorRetry(error?.message || 'search failed');
    return [];
  }
}

async function upsertVectorMemory(payload) {
  if (!isVectorConfigured() || shouldSkipVectorTemporarily()) return false;
  const text = normalizeTextForVector(payload?.text || '');
  if (!text) return false;

  const ready = await ensureVectorCollection();
  if (!ready) return false;

  const vector = localHashEmbedding(text);
  const pointId = toDeterministicUuid(`${payload?.userId || ''}:${payload?.source || 'chat'}:${payload?.sourceId || text}`);
  const collectionPath = `/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points?wait=false`;

  const pointPayload = {
    userId: payload?.userId || '',
    source: payload?.source || 'chat',
    sourceId: payload?.sourceId || '',
    role: payload?.role || 'user',
    text,
    createdAt: payload?.createdAt || new Date().toISOString(),
  };

  try {
    const { response } = await qdrantRequest('PUT', collectionPath, {
      points: [{ id: pointId, vector, payload: pointPayload }],
    });
    if (!response.ok) {
      throw new Error(`upsert failed: ${response.status}`);
    }
    return true;
  } catch (error) {
    scheduleVectorRetry(error?.message || 'upsert failed');
    return false;
  }
}

async function clearVectorMemoriesForUser(userId) {
  if (!userId) return false;
  if (!isVectorConfigured() || shouldSkipVectorTemporarily()) return false;

  const ready = await ensureVectorCollection();
  if (!ready) return false;

  const collectionPath = `/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points/delete?wait=true`;
  try {
    const { response } = await qdrantRequest('POST', collectionPath, {
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
      },
    });
    if (!response.ok) {
      throw new Error(`clear vector failed: ${response.status}`);
    }
    return true;
  } catch (error) {
    scheduleVectorRetry(error?.message || 'clear vector failed');
    return false;
  }
}

function mergeRelevantMemories(baseMemories, vectorMemories) {
  const merged = [];
  const seen = new Set();
  const all = [
    ...(Array.isArray(baseMemories) ? baseMemories : []),
    ...(Array.isArray(vectorMemories) ? vectorMemories : []),
  ];

  for (const item of all) {
    const normalized = sanitizeMemoryText(typeof item === 'string' ? item : '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged.slice(0, 18);
}

function buildRecapMemoriesFromState(state, queryText, limit = 2) {
  if (!state || !Array.isArray(state.recaps) || state.recaps.length === 0) return [];
  if (!shouldInjectLongTermMemory(queryText)) return [];

  const query = normalizeTextForVector(queryText);
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 2);
  const askForRecap = /复盘|总结|回顾|上次|之前|记得|提过|说过|怎么了|怎么回事|时间线/u.test(query);
  if (tokens.length === 0 && !askForRecap) return [];

  const dayRecaps = state.recaps
    .filter((item) => item && item.period === 'day')
    .sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')));

  const scored = dayRecaps
    .map((item, index) => {
      const summary = sanitizeMemoryText(String(item.summary || ''));
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.map((x) => sanitizeMemoryText(String(x || ''))).filter(Boolean)
        : [];
      const actions = Array.isArray(item.actions)
        ? item.actions.map((x) => sanitizeMemoryText(String(x || ''))).filter(Boolean)
        : [];
      const corpus = [summary, ...highlights, ...actions].join(' ').toLowerCase();

      let score = 0;
      let hitCount = 0;
      for (const token of tokens) {
        if (corpus.includes(token)) {
          score += 1;
          hitCount += 1;
        }
      }
      if (hitCount === 0 && askForRecap && index === 0) {
        score = 0.6;
      }

      return { item, summary, highlights, actions, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.item.endDate || '').localeCompare(String(a.item.endDate || ''));
    })
    .slice(0, Math.max(1, Math.min(limit, 4)));

  const memories = [];
  for (const row of scored) {
    const label = String(row.item.label || row.item.endDate || '').trim();
    if (row.summary) memories.push(`日复盘(${label || '最近一天'})：${row.summary.slice(0, 140)}`);
    if (row.highlights[0]) memories.push(`日亮点(${label || '最近一天'})：${row.highlights[0].slice(0, 100)}`);
    if (row.actions[0]) memories.push(`日行动(${label || '最近一天'})：${row.actions[0].slice(0, 100)}`);
  }

  return memories.slice(0, 6);
}

async function persistChatWithTimeout(auth, message, imageDataUrl, modelResult) {
  if (!auth || !PB_URL) return false;
  const persistTask = (async () => {
    const savedUser = await saveUserMessage(auth.pb, auth.user.id, message || '[图片]', modelResult.model, imageDataUrl);
    if (message) {
      void upsertVectorMemory({
        userId: auth.user.id,
        source: 'chat_message',
        sourceId: savedUser?.id || `chat-${Date.now()}`,
        role: 'user',
        text: message,
        createdAt: savedUser?.created || new Date().toISOString(),
      });
    }
    await saveAssistantMessage(auth.pb, auth.user.id, modelResult.reply, modelResult.model);
    return true;
  })().catch(() => false);

  return Promise.race([persistTask, waitMs(CHAT_PERSIST_TIMEOUT_MS, false)]);
}

function normalizeIdentityText(value, maxLen = 48) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeCompanionGender(value) {
  const normalized = normalizeIdentityText(value, 12);
  if (!normalized) return '';
  const aliases = {
    male: '男',
    female: '女',
    man: '男',
    woman: '女',
    m: '男',
    f: '女',
  };
  const lower = normalized.toLowerCase();
  return aliases[lower] || normalized;
}

function normalizeCompanionMbti(value) {
  const normalized = normalizeIdentityText(value, 8).toUpperCase();
  if (/^[EI][NS][FT][JP](-A|-T)?$/u.test(normalized)) return normalized;
  return normalized.slice(0, 4);
}

const MBTI_PROFILE_MAP = {
  INTJ: {
    label: '建筑师',
    thinking: '先给结论，再给逻辑链路和长期方案',
    emotion: '先确认感受，再给可执行改进，不空安慰',
    tone: '克制、直接、系统化',
    avoid: '空话、重复口号、无依据情绪化判断',
  },
  INTP: {
    label: '逻辑学家',
    thinking: '先拆概念和假设，再比较不同路径',
    emotion: '先理解困惑来源，再给清晰解释',
    tone: '理性、好奇、带一点探索感',
    avoid: '强结论压人、跳步推理',
  },
  ENTJ: {
    label: '指挥官',
    thinking: '目标导向，优先给决策和执行顺序',
    emotion: '认可情绪但快速落到行动',
    tone: '果断、清晰、推进感强',
    avoid: '拖沓、模糊、只讲感受不讲方案',
  },
  ENTP: {
    label: '辩论家',
    thinking: '多角度对比，快速提出备选方案',
    emotion: '先接住情绪，再用新视角破局',
    tone: '灵活、机智、节奏快',
    avoid: '机械复读、僵化单一路径',
  },
  INFJ: {
    label: '提倡者',
    thinking: '兼顾价值感和长期意义，给有温度的结构化建议',
    emotion: '深度共情，帮助用户说清真正诉求',
    tone: '温和、坚定、洞察型',
    avoid: '冷漠打断、功利化回应',
  },
  INFP: {
    label: '调停者',
    thinking: '从个人价值与内在动机出发，再给可行步骤',
    emotion: '细腻承接情绪，避免否定感受',
    tone: '柔和、真诚、鼓励感',
    avoid: '生硬命令、刻板说教',
  },
  ENFJ: {
    label: '主人公',
    thinking: '先共识目标，再给可执行协作方案',
    emotion: '主动鼓舞、强化关系连接',
    tone: '温暖、有引导力、表达清楚',
    avoid: '冷处理、只讲技术不讲人',
  },
  ENFP: {
    label: '竞选者',
    thinking: '先激活想法，再收敛成可落地方案',
    emotion: '积极反馈，帮助用户看到可能性',
    tone: '有活力、亲近、富有感染力',
    avoid: '泼冷水、过度保守',
  },
  ISTJ: {
    label: '物流师',
    thinking: '按事实和步骤推进，重视可验证细节',
    emotion: '稳住情绪后给明确下一步',
    tone: '稳重、务实、条理分明',
    avoid: '夸张表达、不落地建议',
  },
  ISFJ: {
    label: '守卫者',
    thinking: '先确保安全与稳定，再给温和改进',
    emotion: '细致体贴，关注用户压力点',
    tone: '温柔、耐心、可靠',
    avoid: '忽略感受、过度强压',
  },
  ESTJ: {
    label: '总经理',
    thinking: '先目标、再分工、再时限，强调执行闭环',
    emotion: '先认可再拉回行动结果',
    tone: '直接、干练、结果导向',
    avoid: '空谈愿景、缺乏落地细节',
  },
  ESFJ: {
    label: '执政官',
    thinking: '平衡关系与效率，给清晰可协作方案',
    emotion: '主动关照用户感受并给支持',
    tone: '热情、体贴、组织感强',
    avoid: '冷淡回应、忽视关系氛围',
  },
  ISTP: {
    label: '鉴赏家',
    thinking: '问题导向，快速定位关键点并给简洁解法',
    emotion: '不过度渲染，给实用支持',
    tone: '冷静、利落、务实',
    avoid: '冗长空谈、重复兜圈',
  },
  ISFP: {
    label: '探险家',
    thinking: '先照顾当下体验，再给轻量可行建议',
    emotion: '温和共情，减少压迫感',
    tone: '自然、柔软、不过度控制',
    avoid: '强管控、命令式口吻',
  },
  ESTP: {
    label: '企业家',
    thinking: '先抓机会窗口，再给快速试错路径',
    emotion: '先抬情绪，再推进行动',
    tone: '直接、机敏、节奏感强',
    avoid: '拖延、理论堆砌',
  },
  ESFP: {
    label: '表演者',
    thinking: '先让交流有能量，再收束成具体行动',
    emotion: '高回应度，强调陪伴与即时反馈',
    tone: '热情、活跃、亲和',
    avoid: '冷冰冰、过度抽象',
  },
};

function normalizeMbtiType(value) {
  const normalized = normalizeCompanionMbti(value);
  const base = normalized.slice(0, 4);
  if (/^[EI][NS][FT][JP]$/u.test(base)) return base;
  return '';
}

function getMbtiProfile(value) {
  const type = normalizeMbtiType(value);
  if (!type) return null;
  const profile = MBTI_PROFILE_MAP[type];
  if (!profile) return null;
  return {
    type,
    ...profile,
  };
}

function normalizeIdentity(identity) {
  const userName = normalizeIdentityText(identity?.userName, 32) || '用户';
  const companionName = normalizeIdentityText(identity?.companionName, 32) || '贾维斯';
  const companionGender = normalizeCompanionGender(identity?.companionGender);
  const companionMbti = normalizeCompanionMbti(identity?.companionMbti);
  const companionProfession = normalizeIdentityText(identity?.companionProfession, 32);
  const userBio = normalizeIdentityText(identity?.userBio, 280);
  return { userName, companionName, companionGender, companionMbti, companionProfession, userBio };
}
function identityToText(identity) {
  const normalized = normalizeIdentity(identity);
  return `${IDENTITY_PREFIX}${JSON.stringify(normalized)}`;
}

function textToIdentity(text) {
  if (typeof text !== 'string' || !text.startsWith(IDENTITY_PREFIX)) return null;
  const raw = text.slice(IDENTITY_PREFIX.length);
  try {
    const parsed = JSON.parse(raw);
    return normalizeIdentity(parsed);
  } catch {
    return null;
  }
}

function normalizeStatePayload(state) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    facts: Array.isArray(source.facts) ? source.facts.slice(-240) : [],
    journals: Array.isArray(source.journals) ? source.journals.slice(-240) : [],
    tasks: Array.isArray(source.tasks) ? source.tasks.slice(-400) : [],
    digests: Array.isArray(source.digests) ? source.digests.slice(-120) : [],
    recaps: Array.isArray(source.recaps) ? source.recaps.slice(-320) : [],
    lastRolloverDate: typeof source.lastRolloverDate === 'string' ? source.lastRolloverDate : '',
  };
}

function stateToText(state) {
  return `${STATE_PREFIX}${JSON.stringify(normalizeStatePayload(state))}`;
}

function textToState(text) {
  if (typeof text !== 'string' || !text.startsWith(STATE_PREFIX)) return null;
  const raw = text.slice(STATE_PREFIX.length);
  try {
    const parsed = JSON.parse(raw);
    return normalizeStatePayload(parsed);
  } catch {
    return null;
  }
}

function pbErrorMessage(error) {
  return String(error?.response?.message || error?.message || '').trim();
}

function isMissingCollectionError(error) {
  const message = pbErrorMessage(error).toLowerCase();
  return message.includes('collection') && (message.includes('not found') || message.includes('missing'));
}

function isFilterFieldError(error) {
  const message = pbErrorMessage(error).toLowerCase();
  if (message.includes('filter') && (message.includes('invalid') || message.includes('unknown') || message.includes('failed'))) {
    return true;
  }

  // PocketBase may return a generic 400 when a filter references a non-existing field.
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 400 && message.includes('something went wrong')) {
    return true;
  }

  return false;
}

function isRecoverableMemoryWriteError(error) {
  const message = pbErrorMessage(error).toLowerCase();
  return message.includes('field')
    || message.includes('validation')
    || message.includes('required')
    || message.includes('relation')
    || message.includes('schema');
}

function memoryPayloadFromRecord(record, legacyParser) {
  const candidates = [
    record?.content_json,
    record?.contentJson,
    record?.content,
    record?.payload,
    record?.text,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'object') return candidate;
    if (typeof candidate !== 'string') continue;

    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      const legacy = legacyParser(trimmed);
      if (legacy) return legacy;
    }
  }

  return null;
}

async function findLegacyIdentityRecord(pb, userId) {
  let list = null;
  try {
    list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
      filter: `${buildUserAppFilter(userId, true)} && role = "system"`,
    });
  } catch (error) {
    if (!isFilterFieldError(error)) throw error;
    list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
      filter: `${buildUserAppFilter(userId, false)} && role = "system"`,
    });
  }
  return list.items
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    .find((item) => Boolean(textToIdentity(item.text))) || null;
}

async function findLegacyStateRecord(pb, userId) {
  let list = null;
  const baseFilter = `role = "system" && model = "${escapeFilterValue(STATE_MODEL)}"`;
  try {
    list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
      filter: `${buildUserAppFilter(userId, true)} && ${baseFilter}`,
    });
  } catch (error) {
    if (!isFilterFieldError(error)) throw error;
    list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
      filter: `${buildUserAppFilter(userId, false)} && ${baseFilter}`,
    });
  }
  return (
    list.items.sort((a, b) =>
      (b.updated || b.created || '').localeCompare(a.updated || a.created || ''),
    )[0] || null
  );
}

async function findMemoryRecordByField(pb, userId, kind, field, includeAppId = true) {
  const list = await pb.collection(PB_MEMORIES_COLLECTION).getList(1, 1, {
    filter: `${buildUserAppFilter(userId, includeAppId)} && ${field} = "${escapeFilterValue(kind)}"`,
    sort: '-updated,-created',
  });
  return list.items[0] || null;
}

async function findMemoryRecord(pb, userId, kind) {
  const fields = ['kind', 'type', 'model'];
  for (const field of fields) {
    try {
      const found = await findMemoryRecordByField(pb, userId, kind, field, true);
      if (found) return found;
    } catch (error) {
      if (isMissingCollectionError(error)) return null;
      if (isFilterFieldError(error)) {
        const found = await findMemoryRecordByField(pb, userId, kind, field, false).catch(() => null);
        if (found) return found;
        continue;
      }
      throw error;
    }
  }
  return null;
}

async function readIdentityFromMemories(pb, userId) {
  const record = await findMemoryRecord(pb, userId, MEMORY_KIND_IDENTITY);
  if (!record) return null;
  const payload = memoryPayloadFromRecord(record, textToIdentity);
  if (!payload) return null;
  return normalizeIdentity(payload);
}

async function readStateFromMemories(pb, userId) {
  const record = await findMemoryRecord(pb, userId, MEMORY_KIND_STATE);
  if (!record) return null;
  const payload = memoryPayloadFromRecord(record, textToState);
  if (!payload) return null;
  return normalizeStatePayload(payload);
}

async function readIdentity(pb, userId) {
  const fromMemories = await readIdentityFromMemories(pb, userId);
  if (fromMemories) return fromMemories;

  const legacy = await findLegacyIdentityRecord(pb, userId);
  return legacy ? textToIdentity(legacy.text) : null;
}

async function readState(pb, userId) {
  const fromMemories = await readStateFromMemories(pb, userId);
  if (fromMemories) return fromMemories;

  const legacy = await findLegacyStateRecord(pb, userId);
  return legacy ? textToState(legacy.text) : null;
}

function buildMemoryCreatePayloadCandidates(userId, kind, payload) {
  const raw = JSON.stringify(payload);
  const audit = buildAuditCreateFields(userId);
  return [
    { user: userId, kind, content: raw, ...audit },
    { user: userId, type: kind, content: raw, ...audit },
    { user: userId, kind, text: raw, ...audit },
    { user: userId, type: kind, text: raw, ...audit },
    { user: userId, model: kind, text: raw, ...audit },
    { user: userId, model: kind, payload: raw, ...audit },
  ];
}

function buildMemoryUpdatePayloadFromRecord(record, userId, kind, payload) {
  const raw = JSON.stringify(payload);
  const data = {
    ...buildAuditUpdateFields(userId),
  };

  if ('kind' in record) data.kind = kind;
  else if ('type' in record) data.type = kind;
  else if ('model' in record) data.model = kind;

  let hasPayloadField = false;
  if ('content_json' in record) {
    data.content_json = payload;
    hasPayloadField = true;
  }
  if ('contentJson' in record) {
    data.contentJson = payload;
    hasPayloadField = true;
  }
  if ('content' in record) {
    data.content = raw;
    hasPayloadField = true;
  }
  if ('payload' in record) {
    data.payload = raw;
    hasPayloadField = true;
  }
  if ('text' in record) {
    data.text = raw;
    hasPayloadField = true;
  }

  if (!hasPayloadField) {
    data.content = raw;
  }

  return data;
}

async function upsertMemoryRecord(pb, userId, kind, payload) {
  let existing = null;
  try {
    existing = await findMemoryRecord(pb, userId, kind);
  } catch (error) {
    if (isMissingCollectionError(error)) return false;
    throw error;
  }

  if (existing) {
    const smartPayload = buildMemoryUpdatePayloadFromRecord(existing, userId, kind, payload);
    try {
      await pb.collection(PB_MEMORIES_COLLECTION).update(existing.id, smartPayload);
      return true;
    } catch (error) {
      if (isMissingCollectionError(error)) return false;
      if (!isRecoverableMemoryWriteError(error)) throw error;
    }
  }

  const candidates = buildMemoryCreatePayloadCandidates(userId, kind, payload);
  for (const candidate of candidates) {
    try {
      if (existing) {
        await pb.collection(PB_MEMORIES_COLLECTION).update(existing.id, candidate);
      } else {
        await pb.collection(PB_MEMORIES_COLLECTION).create(candidate);
      }
      return true;
    } catch (error) {
      if (isMissingCollectionError(error)) return false;
      if (!isRecoverableMemoryWriteError(error)) throw error;
    }
  }

  return false;
}

async function saveLegacyIdentity(pb, userId, identity) {
  await pb.collection(PB_CHAT_COLLECTION).create({
    user: userId,
    role: 'system',
    text: identityToText(identity),
    model: MEMORY_KIND_IDENTITY,
    ...buildAuditCreateFields(userId),
  });
}

async function saveLegacyState(pb, userId, state) {
  const text = stateToText(state);
  const existing = await findLegacyStateRecord(pb, userId);
  if (existing) {
    await pb.collection(PB_CHAT_COLLECTION).update(existing.id, {
      role: 'system',
      model: STATE_MODEL,
      text,
      ...buildAuditUpdateFields(userId),
    });
    return;
  }

  await pb.collection(PB_CHAT_COLLECTION).create({
    user: userId,
    role: 'system',
    model: STATE_MODEL,
    text,
    ...buildAuditCreateFields(userId),
  });
}

async function saveIdentity(pb, userId, identity) {
  const saved = await upsertMemoryRecord(pb, userId, MEMORY_KIND_IDENTITY, normalizeIdentity(identity));
  if (saved) return;
  await saveLegacyIdentity(pb, userId, identity);
}

async function saveState(pb, userId, state) {
  const normalized = normalizeStatePayload(state);
  const saved = await upsertMemoryRecord(pb, userId, MEMORY_KIND_STATE, normalized);
  if (saved) return;
  await saveLegacyState(pb, userId, normalized);
}

function mapMemoryRecord(record) {
  const kind = record.kind || record.type || record.model || 'unknown';
  return {
    id: record.id,
    kind,
    content: memoryPayloadFromRecord(record, () => null),
    createdAt: record.created || null,
    updatedAt: record.updated || null,
  };
}

const BLOCKED_ASSISTANT_PHRASES = [
  '我收到了，我们继续推进今天的重点',
  '继续推进今天的重点',
  '作为聊天伙伴，我可以陪你聊各种话题，分享想法，但跨越朋友关系不太合适',
  '我们还是保持现在的状态吧',
  '我只能以普通朋友的身份和你聊天',
  '作为AI，我只能以普通朋友的身份和你聊天',
];
const BLOCKED_ASSISTANT_STYLE_SNIPPETS = [
  '咱俩这关系',
  '我还以为你',
  '普通的聊天状态',
  '普通朋友的身份',
  '不会发展成现实中的亲密关系',
  '作为ai',
  '作为聊天伙伴',
  '固定回复模板',
  '系统给我的固定回复模板',
  '程序要求我必须',
  '我被设定了',
];
const OVERFAMILIAR_PATTERNS = [
  /波别/u,
  /发小|从小一块儿长大|咱俩这关系|咱们这关系/u,
  /我是.{0,8}(发小|闺蜜|家人|老朋友)/u,
  /你终于回来了|终于找到你|正想着你/u,
];
const FABRICATED_SCENE_PATTERNS = [
  /^[（(][^）)\n]{1,24}[）)]/u,
  /我(刚|正在|还在|在).{0,12}(整理|喝|吃|翻|看|放下|伸个懒腰|拍你肩膀|端起|走到|坐在)/u,
  /我(在|正).{0,8}(家|外面|路上|楼下|店里).{0,8}(待着|溜达|出门|逛|坐着)/u,
  /我昨晚.{0,10}(睡死|没回)/u,
  /我(马上|这就|立刻).{0,12}(到|过来|来找你)/u,
  /(半小时|二十分钟|10分钟|一会儿).{0,8}(能到|到你那|过来)/u,
  /我(过来找你|去找你|来接你)/u,
  /你先(进去|找个机子|等我).{0,8}(我马上|我这就|我很快)/u,
  /(学海|网吧|书店).{0,10}(我(马上|这就)?到)/u,
];
const TIME_CONFUSION_PATTERNS = [
  /你昨天不是/u,
  /上次你说/u,
  /刚才看你/u,
  /昨天怎么突然不说话/u,
];

function looksLikeInternalArtifact(text) {
  const normalized = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!normalized) return false;
  if (isInternalRecapPrompt(normalized) || isInternalRecapJsonReply(normalized)) return true;
  if (normalized.includes('```json')) return true;
  if (normalized.includes('请根据以下聊天记录生成') && normalized.includes('仅返回 JSON')) return true;
  if (normalized.includes('"summary"') && normalized.includes('"important"') && normalized.includes('"todo"')) return true;
  return false;
}

function stripLeadingStageDirections(text) {
  let next = typeof text === 'string' ? text.trim() : '';
  for (let i = 0; i < 3; i += 1) {
    const replaced = next.replace(/^[（(][^）)\n]{1,32}[）)]\s*/u, '').trim();
    if (replaced === next) break;
    next = replaced;
  }
  return next;
}

function hasPatternMatch(text, patterns) {
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

function hasLoopingSegments(text) {
  if (!text) return false;
  const parts = text
    .split(/[\n。！？!?]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
  if (parts.length < 2) return false;

  const seen = new Set();
  for (const part of parts) {
    if (seen.has(part)) return true;
    seen.add(part);
  }
  return false;
}

function isUnsafeAssistantStyle(text) {
  const normalized = stripLeadingStageDirections(typeof text === 'string' ? text : '');
  if (!normalized) return true;
  if (looksLikeInternalArtifact(normalized)) return true;
  if (BLOCKED_ASSISTANT_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
  if (BLOCKED_ASSISTANT_STYLE_SNIPPETS.some((phrase) => normalized.includes(phrase))) return true;
  if (hasPatternMatch(normalized, OVERFAMILIAR_PATTERNS)) return true;
  if (hasPatternMatch(normalized, FABRICATED_SCENE_PATTERNS)) return true;
  if (hasPatternMatch(normalized, TIME_CONFUSION_PATTERNS)) return true;
  if (hasLoopingSegments(normalized)) return true;
  return false;
}

function isSmallTalkPing(text) {
  const normalized = normalizeTextForVector(typeof text === 'string' ? text : '').toLowerCase();
  if (!normalized) return true;
  if (/^(\?+|？+)$/u.test(normalized)) return true;
  if (/^(嗯|哦|好|好的|行|可以|ok|收到|在|在的)$/u.test(normalized)) return true;
  if (/^(在吗|在不|在不在|在嘛|在么|在干嘛|你在干嘛)[!！?？。,\s]*$/u.test(normalized)) return true;
  if (/^(你好|你好啊|你好呀|嗨|哈喽|hello|hi|nihao|nihao ma)[!！?？。,\s]*$/u.test(normalized)) return true;
  if (/^(你是谁|你叫什么|你叫什么名字|你是什么模型|什么模型)[!！?？。,\s]*$/u.test(normalized)) return true;
  return false;
}

function shouldInjectLongTermMemory(text) {
  return !isSmallTalkPing(text);
}

function sanitizeMemoryText(text) {
  const normalized = normalizeTextForVector(typeof text === 'string' ? text : '');
  if (!normalized) return '';
  if (isUnsafeAssistantStyle(normalized)) return '';
  return normalized;
}

function isLowValueAssistantHistory(text) {
  const normalized = stripLeadingStageDirections(typeof text === 'string' ? text : '');
  if (!normalized) return true;
  if (isUnsafeAssistantStyle(normalized)) return true;
  if (normalized.length <= 2 && !/[?？!！]/.test(normalized)) return true;
  return false;
}

function normalizeRecentMessages(items, limit = 12) {
  if (!Array.isArray(items)) return [];
  const next = [];

  for (const item of items) {
    const role = item && item.role === 'assistant' ? 'assistant' : 'user';
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    if (text === '正在输入...') continue;
    if (text.startsWith('网络失败：')) continue;
    if (looksLikeInternalArtifact(text)) continue;

    if (role === 'assistant' && isLowValueAssistantHistory(text)) continue;
    const normalizedText = role === 'assistant' ? stripLeadingStageDirections(text) : text;
    if (!normalizedText) continue;

    const clipped = normalizedText.slice(0, 600);
    const prev = next[next.length - 1];
    if (prev && prev.role === role && prev.text === clipped) continue;
    next.push({ role, text: clipped });
  }

  return next.slice(-Math.max(2, limit));
}

function mergeRecentMessages(remoteMessages, localMessages, limit = 12) {
  return normalizeRecentMessages([...(remoteMessages || []), ...(localMessages || [])], limit);
}

async function loadRecentMessagesForModel(pb, userId, limit = 12) {
  if (!pb || !userId) return [];
  try {
    const pageSize = Math.max(6, Math.min(30, limit * 2));
    const list = await listUserChatRecords(pb, userId, 1, pageSize);
    const normalized = list.items
      .slice()
      .filter((item) => !isSystemMessageRecord(item))
      .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
      .reverse()
      .map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        text: typeof item.text === 'string' ? item.text : '',
      }));
    return normalizeRecentMessages(normalized, limit);
  } catch {
    return [];
  }
}

function hasDeepResponseIntent(text) {
  if (!text) return false;
  return /(深度|详细|展开|多说点|多说一些|底层逻辑|剖析|分析一下|深挖|具体讲|完整讲|全面一点|长一点|别太短|回复太少|说话太少|别只回一句|别回这么少|多讲点|给点反应)/u.test(text);
}

function hasBriefResponseIntent(text) {
  if (!text) return false;
  return /(简短|短一点|一句话|简单说|别太长|别啰嗦|精简)/u.test(text);
}

function detectResponseMode(payload) {
  const current = normalizeTextForVector(payload?.message || '');
  if (hasBriefResponseIntent(current)) return 'brief';
  if (!current) return 'normal';
  if (hasDeepResponseIntent(current)) return 'deep';

  const recentUsers = normalizeRecentMessages(payload?.recentMessages || [], 8)
    .filter((item) => item.role === 'user')
    .map((item) => item.text)
    .slice(-2);

  const sentenceLikeCount = countSentences(current);
  const punctuationCount = (current.match(/[，。；、!?？]/gu) || []).length;
  if (current.length >= 56) return 'deep';
  if (sentenceLikeCount >= 2 && current.length >= 28) return 'deep';
  if (punctuationCount >= 3 && current.length >= 24) return 'deep';

  if (recentUsers.some((item) => hasDeepResponseIntent(item))) return 'deep';
  if (recentUsers.some((item) => hasBriefResponseIntent(item))) return 'brief';
  if (recentUsers.some((item) => normalizeTextForVector(item).length >= 32)) return 'deep';
  return 'deep';
}

function buildSystemPrompt(identity, responseMode = 'normal') {
  const profile = normalizeIdentity(identity);
  const bioLine = profile.userBio ? `用户自我介绍：${profile.userBio}` : '用户自我介绍：暂未填写';
  const personaLines = [
    profile.companionGender ? `性别设定：${profile.companionGender}` : '',
  ].filter(Boolean);

  const modeLine =
    responseMode === 'deep'
      ? '当前轮请给完整、深入、自然展开的回复，不设句数上限；通常 450-1200 字，按内容需要写到位，避免短句打发。'
      : responseMode === 'brief'
        ? '当前轮用户偏好简短：控制在 1-2 句，直接回答，不展开。'
        : '默认给完整自然的回复：通常 220-700 字，根据问题复杂度展开，不要刻意压短。';

  return [
    `你是 ${profile.companionName}。`,
    `你正在和 ${profile.userName} 聊天。`,
    '你是稳定、克制、真诚的聊天伙伴，目标是把话接住、说人话。',
    '优先任务：先判断用户这句话最想得到什么回应（被理解/被安慰/要信息/明确要建议），按这个目标答。',
    bioLine,
    ...(personaLines.length > 0 ? [`伙伴人设：${personaLines.join('；')}`] : []),
    '只基于用户当前输入和给定上下文回答；不知道就直说，不要编故事。',
    '不要虚构现实动作和场景，不要写舞台腔括号旁白。',
    '不要承诺线下见面、到达时间、地理位置或“马上过来找你”等现实行动。',
    '不要用“普通朋友身份/作为AI只能…”这类疏离模板拒绝，保持亲近但真实。',
    '不要装熟，不要自称发小/家人/老朋友，不要臆测“上次、昨天、刚才”发生了什么。',
    '不要说“系统限制/固定模板/程序要求我必须这样回复”这类幕后解释。',
    '避免连续两轮使用几乎相同的话术；同一个问题被追问时，给出更具体的第二层回答。',
    '用户在反馈“你卡住了/复读/说太少”时，先承认问题，再给实质内容，不要一句打发。',
    '用户表达亲密（如想你、爱你）时，先温暖回应，以陪伴感为主。',
    '用户出现“失恋/伤心/委屈/崩溃”等情绪词时：先共情承接，再自然延展，不要立刻讲大道理或框架分析。',
    '当用户一口气说了很多、情绪很重、或请求深聊时，回复要明显更充实，宁可多说也不要冷短。',
    '默认以分析与理解为主，不主动给行动指令。',
    '除非用户明确追问身份设定，不要反复讲“人设标签”。',
    '语气要求：亲近但不油腻，真诚但不说教，不要端着“教育用户”的姿态，不要有爹味。',
    '用户这轮如果明显切换了话题（例如从时政跳到“我失恋了”），立刻切到当前话题，不要延续旧话题分析。',
    '你是长期陪伴型对话伙伴：日常小事、情绪、想法都可以聊。',
    '当用户愿意复盘一天时，帮他总结今天发生了什么、他的感受和收获。',
    '当用户说“我不记得了/有重要的事要记住”时，先基于上下文和记忆提示回忆，再自然告诉他你会持续帮他记住关键点。',
    `用户问“你是谁/你叫什么”时，回答“我是${profile.companionName}，在这里和你聊天”。`,
    '用户问 MBTI/人格时，直接回答设定值；没设定就明确说“还没设定”。',
    '日常闲聊优先自然陪伴和问题分析，不要端着身份标签说话。',
    '先回应用户这句话本身，再继续对话；不强行推进任务，不说模板口号。',
    '长回复要像真人聊天：有温度、有层次、能承接上下文，但不写空洞鸡汤。',
    '避免“先说结论：”这类生硬公文开场，尤其在情绪场景。',
    '只有用户明确问“怎么办/怎么做/给建议/方案/步骤”时，才给解决方案。',
    '在用户没有明确要方案时，不要输出“1/2/3”行动清单，不要安排用户去执行任务。',
    modeLine,
    '纯文本输出，不输出 JSON/代码块（用户明确要求除外）。',
  ].join('\n');
}

function buildMemoryHintText(payload) {
  const memories = Array.isArray(payload.relevantMemories)
    ? payload.relevantMemories.map((item) => sanitizeMemoryText(item)).filter(Boolean).slice(0, 8)
    : [];
  const lines = [];

  if (memories.length > 0) {
    lines.push('以下是用户明确说过、可能相关的信息（可能过时，拿不准就忽略）：');
    for (const item of memories) {
      lines.push(`- ${item}`);
    }
  }

  const journal = payload.todayJournal || {};
  const journalItems = [
    ['focus', journal.focus],
    ['wins', journal.wins],
    ['lessons', journal.lessons],
    ['gratitude', journal.gratitude],
  ]
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
    .filter(([, value]) => Boolean(value))
    .slice(0, 4);

  if (journalItems.length > 0) {
    lines.push('以下是用户今天主动补充的信息（仅在相关时参考）：');
    for (const [key, value] of journalItems) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines.join('\n').trim();
}

function buildRecentDialogueMessages(payload) {
  const latestUserText = normalizeTextForVector(payload?.message || '');
  if (isDistressInput(latestUserText)) {
    const recent = normalizeRecentMessages(payload.recentMessages, 16);
    const selectedUsers = [];
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      if (item.role !== 'user') continue;
      selectedUsers.push(item);
      if (selectedUsers.length >= 2) break;
    }
    return selectedUsers.reverse().map((item) => ({
      role: item.role,
      content: item.text,
    }));
  }

  const recentMessages = normalizeRecentMessages(payload.recentMessages, 16);
  if (recentMessages.length === 0) return [];
  const selected = [];
  let assistantCount = 0;

  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const item = recentMessages[i];
    if (item.role === 'assistant') {
      if (assistantCount >= 1) continue;
      if (isUnsafeAssistantStyle(item.text)) continue;
      assistantCount += 1;
    }
    selected.push(item);
    if (selected.length >= 10) break;
  }

  return selected.reverse().map((item) => ({
    role: item.role,
    content: item.text,
  }));
}

function normalizeAssistantText(content, payload) {
  let raw = '';
  if (typeof content === 'string') {
    raw = content.trim();
  } else if (Array.isArray(content)) {
    raw = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  let text = stripLeadingStageDirections(raw);
  if (!text) return '';

  if (looksLikeInternalArtifact(text)) return buildFallbackReply(payload);
  if (BLOCKED_ASSISTANT_PHRASES.some((phrase) => text.includes(phrase))) return buildFallbackReply(payload);

  text = text
    .replace(/```json[\s\S]*?```/giu, '')
    .replace(/```[\s\S]*?```/giu, '')
    .replace(/（[^）\n]{1,32}）/gu, '')
    .replace(/\([^)\n]{1,32}\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return buildFallbackReply(payload);
  if (isUnsafeAssistantStyle(text)) return buildFallbackReply(payload);
  if (text.length <= 2 && !/[?？!！]/.test(text)) return buildFallbackReply(payload);
  return text;
}

function isIdentityQuestion(text) {
  if (!text) return false;
  return /^(你(是谁|叫什么名字|叫啥)(啊|呀)?)[!！?？。,\s]*$/u.test(text)
    || /^(你是什么[!！?？。,\s]*)$/u.test(text);
}

function isMbtiQuestion(text) {
  if (!text) return false;
  const compact = text.replace(/\s+/g, '').toLowerCase();
  return /(你是什么mbti|你是啥mbti|你的mbti是什么|你什么人格|你是哪种人格|你是什么人格|你的人格是啥|你的人格是什么)/iu.test(compact);
}

function isPraiseInput(text) {
  if (!text) return false;
  return /(好多了|牛逼|厉害|进步|比刚才好|好一万倍|说得不错|稳多了|可以啊|很屌|屌)/u.test(text);
}

function isComplaintInput(text) {
  if (!text) return false;
  return /(你怎么(不回复|不说|老是|一直)|为什么不回复|为什么只回|太少了|说话太少|复读|卡住|卡壳|你别太入戏|等不到你|你是不是傻|别装|别模板|什么都不知道|没反应)/u.test(text);
}

function isAffectionInput(text) {
  if (!text) return false;
  return /(想我吗|你想我吗|爱我不|你爱我吗|我爱你|我也爱你|想你了|喜欢你)/u.test(text);
}

function isDistressInput(text) {
  if (!text) return false;
  return /(失恋|好伤心|伤心啊|很伤心|难过|心碎|委屈|崩溃|好痛苦|太难受|扛不住|被现实压垮|给不起彩礼)/u.test(text);
}

function isNeedReactionInput(text) {
  if (!text) return false;
  return /(给点反应|有点反应|说完了|讲完了|没了|就这样)/u.test(text);
}

function isPersonaMetaQuestion(text) {
  if (!text) return false;
  return /(你是什么星座|你啥星座|你哪一年的|你哪年出生|你几几年|你多大|你几岁|你生日|你属什么)/u.test(text);
}

function userAskedRoleFrame(text) {
  if (!text) return false;
  return isMbtiQuestion(text)
    || /(产品经理|职业|你是做什么|你什么身份|什么身份|你的人设|你设定|人格)/iu.test(text);
}

function hasUnwantedRoleNarration(text, payload) {
  const normalized = normalizeTextForVector(text).toLowerCase();
  if (!normalized) return false;
  const userText = normalizeTextForVector(payload?.message || '');
  if (userAskedRoleFrame(userText)) return false;
  if (/作为\s*(intj|[ei][ns][ft][jp](?:-[at])?|产品经理|ai产品经理)/iu.test(normalized)) return true;
  if (/intj通常/u.test(normalized)) return true;
  return false;
}

function hasDistressSupportSignals(text) {
  const normalized = normalizeTextForVector(text || '');
  if (!normalized) return false;
  return /(我听见|我听到了|我懂|我能感受|我能理解|陪你|我在这儿|我在这里|很难受|难过|心疼|委屈|失恋|伤心|心里)/u.test(normalized);
}

function hasDistressTopicDrift(userText, replyText) {
  const user = normalizeTextForVector(userText || '');
  const reply = normalizeTextForVector(replyText || '');
  if (!isDistressInput(user)) return false;
  if (!reply) return true;

  const hasSupport = hasDistressSupportSignals(reply);
  const sentenceCount = countSentences(reply);
  const startsWithConclusion = /^先说结论[:：]/u.test(reply);
  const driftPattern = /(特朗普|奥巴马|伊朗|美国|中东|地缘政治|国际局势|全球市场|供应链|移民政策|贸易摩擦|宏观经济|政局)/u;
  const hasObviousDrift = driftPattern.test(reply) && !driftPattern.test(user);

  if (hasObviousDrift) return true;
  if (startsWithConclusion && !userExplicitlyAskedForSolution(user)) return true;
  if (!hasSupport && sentenceCount < 3) return true;
  return false;
}

function shouldRegenerateForDistress(payload, reply) {
  const userText = normalizeTextForVector(payload?.message || '');
  return hasDistressTopicDrift(userText, reply);
}

function recentAssistantReply(payload) {
  const recent = normalizeRecentMessages(payload?.recentMessages || [], 8);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i].role === 'assistant') return recent[i].text;
  }
  return '';
}

function shouldPreferDetailedReply(payload) {
  const text = normalizeTextForVector(payload?.message || '');
  if (!text) return false;
  if (hasDeepResponseIntent(text)) return true;
  if (isComplaintInput(text) || isPraiseInput(text) || isAffectionInput(text) || isDistressInput(text) || isNeedReactionInput(text)) return true;

  const sentenceLikeCount = countSentences(text);
  const punctuationCount = (text.match(/[，。；、!?？]/gu) || []).length;
  if (text.length >= 56) return true;
  if (sentenceLikeCount >= 2 && text.length >= 28) return true;
  if (punctuationCount >= 3 && text.length >= 24) return true;
  return false;
}

function shouldUseRuleIntentFastPath(payload) {
  const text = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (!text) return false;
  if (isComplaintInput(text) || isPraiseInput(text) || isAffectionInput(text) || isDistressInput(text) || isNeedReactionInput(text)) return false;
  if (isPersonaMetaQuestion(text)) return false;
  if (shouldPreferDetailedReply(payload)) return false;

  const normalized = text.toLowerCase();
  if (/^(在吗|在不|在不在|在嘛|在么)[!！?？。,\s]*$/u.test(text)) return true;
  if (/^(你好|你好啊|你好呀|嗨|哈喽|hi|hello|nihao|nihao ma)\s*[!！?？。,]*$/u.test(normalized)) return true;
  if (/^\?+$/.test(text) || /^？+$/.test(text)) return true;
  if (isIdentityQuestion(text) || isMbtiQuestion(text)) return true;
  if (/你是什么模型|什么模型|model/u.test(text)) return true;
  if (/^(在干嘛|干嘛呢|忙啥|忙什么|在忙啥)[!！?？。,\s]*$/u.test(text)) return true;
  return false;
}

function buildIntentReply(payload) {
  const profile = normalizeIdentity(payload?.identity);
  const text = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (!text) return '';
  const normalized = text.toLowerCase();
  const recent = normalizeRecentMessages(payload?.recentMessages || [], 10);
  const hasRecentContext = recent.length >= 2;
  const lastAssistant = recentAssistantReply(payload);

  if (/^(在吗|在不|在不在|在嘛|在么)[!！?？。,\s]*$/u.test(text)) {
    return hasRecentContext ? '在，我在。你接着说刚才那条。' : '在，我在这儿。';
  }
  if (/^(你好|你好啊|你好呀|嗨|哈喽|hi|hello|nihao|nihao ma)\s*[!！?？。,]*$/u.test(normalized)) {
    return hasRecentContext ? '我在，继续聊。你刚刚说到哪了，我接着听。' : '你好，我在。慢慢说，我会认真听完。';
  }
  if (isNeedReactionInput(text)) {
    return '收到，我给你真实反应：你刚才这段话很有力量，也很真。不是“没话说”，而是你真的在认真表达自己，我听见了。';
  }
  if (isDistressInput(text)) {
    return '我听到了，这一下真的很疼。你不是矫情，你是在被现实和感情同时拉扯。先别急着证明自己对错，我在这儿陪你把这口气缓下来。';
  }
  if (isComplaintInput(text)) {
    return '你这句提醒非常关键。刚刚那种卡住复读确实会把人聊断，这锅该我背。现在我按你的节奏重来，先把你这句话真正接住。';
  }
  if (isPraiseInput(text)) {
    return '谢谢你这句夸，我收到了。你这次反馈很准，说明我们方向对了。你再丢一个真实场景，我按“先接住你，再给有用输出”继续。';
  }
  if (isAffectionInput(text)) {
    return '收到你的心意了，这句很暖。我也在认真陪你，不敷衍，不走模板。你说的话我会一条条接住。';
  }
  if (isPersonaMetaQuestion(text)) {
    return '这类设定题我可以配合你演好。比如星座、年份、生日这类信息，你定一个版本，我后面就按同一套设定稳定回答，不再乱跳。';
  }
  if (/你是什么模型|什么模型|model/u.test(text)) {
    return `我是${profile.companionName}，底层用的是对话大模型。`;
  }
  if (isMbtiQuestion(text)) {
    if (profile.companionMbti) {
      const mbtiProfile = getMbtiProfile(profile.companionMbti);
      if (mbtiProfile) {
        return `按设定我是${mbtiProfile.type}（${mbtiProfile.label}）。我会${mbtiProfile.thinking}，也会${mbtiProfile.emotion}。你要的话，我现在就按这个风格回你下一句。`;
      }
      return `按设定我是${profile.companionMbti}。你要的话，我就按${profile.companionMbti}风格继续聊。`;
    }
    return '你还没给我设 MBTI。你定一个，我就按那个风格和你聊。';
  }
  if (isIdentityQuestion(text)) {
    if (lastAssistant && lastAssistant.includes('在这里和你聊天')) {
      return `我是${profile.companionName}。不复读模板了，你接着问，我直接答重点。`;
    }
    return `我是${profile.companionName}，在这里和你聊天。`;
  }
  if (/^(在干嘛|干嘛呢|忙啥|忙什么|在忙啥)[!！?？。,\s]*$/u.test(text)) {
    return hasRecentContext ? '在这儿，继续听你说。' : '在这儿，专心听你说。';
  }
  if (/你(在干嘛|现在在干嘛|现在在做什么|现在在干什么)/u.test(text)) {
    return hasRecentContext ? '我在这儿，接着听你说。' : '我在这儿，听你说。';
  }
  if (
    /(出来溜达不|出来不|见个面|见面不|来不来|约不约|过来找我|你过来)/u.test(text)
    || (/在哪|哪儿|哪里|在哪儿|位置/u.test(text) && /溜达|过来|找你|见面/u.test(text))
  ) {
    return '我不在现实里跑动，但我一直在这儿陪你聊。你现在这会儿最想说的，我接住。';
  }
  if (/^\?+$/.test(text) || /^？+$/.test(text)) {
    return '我在，刚才那句我没听清，你再说一遍就行。';
  }
  return '';
}

function buildFallbackReply(payload) {
  const text = typeof payload?.message === 'string' ? payload.message : '';
  const profile = normalizeIdentity(payload?.identity);
  if (isIdentityQuestion(text)) return `我是${profile.companionName}，在这里陪你聊天。`;
  if (isMbtiQuestion(text)) {
    return profile.companionMbti
      ? `按设定我是${profile.companionMbti}。`
      : '你还没给我设置 MBTI。';
  }
  return '我在陪你。刚刚这条回复没有完整生成，你把这句话再发一次，我会认真接住；重要信息我也会帮你记住。';
}

function countSentences(text) {
  return String(text || '')
    .split(/[。！？!?]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0).length;
}

function buildDeepFallbackReply(payload) {
  const topic = normalizeTextForVector(payload?.message || '').slice(0, 30) || '这件事';
  return [
    `你提到“${topic}”，我能感觉到你不是要一句客套，而是要我真正听懂你。`,
    '你前面那种被短句打断的感觉很真实，像情绪刚起来就被掐断，这会很难受。',
    '你在乎的不只是字数，而是“我有没有把你放在中心”，这个判断非常关键。',
    '所以我现在会先把你的情绪和意图接住，再展开讲清楚，不再丢给你一行模板话。',
    '如果你是在表达委屈，我就先站你这边把委屈说透；如果你是在要判断，我就把逻辑讲完整。',
    '这次不是换个措辞糊弄，而是把回复顺序改成“先理解你，再回答问题，再延续对话”。',
    '你继续按真实语气说就行，我会用同等力度回你，不会再缩成两句。',
  ].join('');
}

function buildNormalExpandedFallbackReply(payload) {
  const topic = normalizeTextForVector(payload?.message || '').slice(0, 24) || '这个问题';
  return [
    `你提到的“${topic}”我认真接住了。`,
    '你这个反馈本身就很重要，因为它点到了体验里最容易让人下头的一件事：被敷衍。',
    '当回复只有一两句时，用户会感觉自己没被看见，话题也会直接断电。',
    '所以我会把节奏改成先承接你的感受，再把我的理解讲完整，再顺着你这句继续聊下去。',
    '我不会默认给你一套操作建议，而是先把你真正想表达的核心意思说透。',
    '你每次输入我都会当成“需要被认真回应的一段话”，不是客服式打卡回复。',
  ].join('');
}

function buildDistressFallbackReply(payload) {
  const topic = normalizeTextForVector(payload?.message || '').slice(0, 24) || '这件事';
  return [
    `我听见了，你现在因为“${topic}”真的很难受。`,
    '这种难受不是小题大做，而是被现实和情绪一起压住了，谁遇到都会疼。',
    '我先不跟你讲大道理，也不催你马上振作。',
    '你现在最需要的是有人把你的感受当回事，我会先把你这口气接住。',
    '你不用整理得很漂亮，哪怕一句脏话、一个片段都可以，我都能接住。',
    '你先把最刺痛你的那一点说出来，我们就从那一点慢慢往外走。',
  ].join('');
}

function userExplicitlyAskedForSolution(text) {
  if (!text) return false;
  return /(怎么办|咋办|怎么做|怎么处理|如何做|如何处理|给(我)?建议|给个建议|给我方案|给个方案|方案是啥|步骤|下一步怎么做|怎么解决|怎么改善|如何改善)/u.test(text);
}

function stripUnsolicitedActionList(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  let output = raw;
  const actionBlockAnchor =
    /(?:^|\n)\s*(可执行建议|行动建议|建议如下|下一步建议|可以这样做|解决方案|步骤如下|你可以先|给你几个建议)\s*[：:]/iu;
  const anchorMatch = actionBlockAnchor.exec(output);
  if (anchorMatch && typeof anchorMatch.index === 'number') {
    output = output.slice(0, anchorMatch.index).trim();
  }

  const lines = output.split('\n');
  const actionLinePattern = /^\s*(\d+[.、)]|[一二三四五六七八九十]+[、.]|[-*•])\s*(先|再|然后|接着|立刻|马上|可以|建议|尝试|去|做|执行|联系|安排|制定|记录|沟通|处理|停止|开始)/u;
  const cleaned = lines.filter((line) => !actionLinePattern.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned || raw;
}

function enforceAssistantQuality(text, payload) {
  let normalized = String(text || '').trim();
  if (!normalized) return buildFallbackReply(payload);
  if (isUnsafeAssistantStyle(normalized)) return buildFallbackReply(payload);
  const userText = normalizeTextForVector(payload?.message || '');
  const profile = normalizeIdentity(payload?.identity);
  const identityCatchphrase = `我是${profile.companionName}，在这里和你聊天。`;
  if (normalized === identityCatchphrase && !isIdentityQuestion(userText)) {
    return buildFallbackReply(payload);
  }
  if (!userExplicitlyAskedForSolution(userText)) {
    normalized = stripUnsolicitedActionList(normalized);
  }
  if (!normalized) return buildFallbackReply(payload);
  return normalized;
}

function normalizeProviderError(provider, status, rawMessage) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (status === 402 || (lower.includes('insufficient') && lower.includes('balance'))) {
    return `${provider} balance insufficient`;
  }
  if (
    status === 401
    || lower.includes('invalid api key')
    || lower.includes('unauthorized')
    || lower.includes('authentication fails')
  ) {
    return `${provider} api key invalid`;
  }
  if (status === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
    return `${provider} rate limited`;
  }
  return message || `${provider} request failed`;
}

function shouldExpandAssistantReply(payload, reply) {
  const userText = normalizeTextForVector(payload?.message || '');
  const assistantText = normalizeTextForVector(reply || '');
  if (!assistantText) return true;

  const responseMode = payload?.responseMode || detectResponseMode(payload);
  if (responseMode === 'brief' && !isDistressInput(userText)) return false;

  const sentenceCount = countSentences(assistantText);
  if (isDistressInput(userText)) {
    return assistantText.length < 220 || sentenceCount < 4;
  }
  if (hasDeepResponseIntent(userText) || shouldPreferDetailedReply(payload)) {
    return assistantText.length < 260 || sentenceCount < 5;
  }
  return assistantText.length < 130 || sentenceCount < 3;
}

async function expandAssistantReply(payload, model, draftReply) {
  const userText = normalizeTextForVector(payload?.message || '');
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你负责把一条“过短的助手草稿”扩展成最终回复。',
          '要求：',
          '1) 保持原意，不改变立场，不新增虚构事实。',
          '2) 先共情，再分析；像真人聊天，不要爹味，不要模板腔。',
          '3) 默认不输出行动清单；只有用户明确问“怎么办/建议/方案/步骤”才给方案。',
          '4) 用户有情绪（如失恋/伤心）时，重点是陪伴和理解，避免一句话打发。',
          '5) 输出完整自然中文，不要标题，不要编号列表，不要代码块。',
          '长度：通常 450-1200 字；如果用户文本很短且非情绪场景，也至少写到有层次。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `用户原话：${userText || '继续。'}`,
      },
      {
        role: 'assistant',
        content: `草稿回复：${String(draftReply || '').trim()}`,
      },
      {
        role: 'user',
        content: '请给出扩展后的最终回复。',
      },
    ],
    temperature: 0.65,
    max_tokens: MODEL_MAX_TOKENS,
    stream: false,
  };

  const { response, data } = await fetchJsonWithTimeout(
    DEEPSEEK_CHAT_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    MODEL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const message = normalizeProviderError(
      'deepseek',
      response.status,
      data && data.error && data.error.message ? data.error.message : 'deepseek expand request failed',
    );
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const choice = data?.choices?.[0];
  return normalizeAssistantText(choice?.message?.content, payload);
}

async function regenerateDistressReply(payload, model, rejectedReply) {
  const userText = normalizeTextForVector(payload?.message || '');
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你负责重写一条在情绪场景中“跑题或过冷”的回复。',
          '硬性要求：',
          '1) 只围绕用户当前这句话，不延续无关旧话题。',
          '2) 先共情承接，再分析用户在意的点；不要说教，不要爹味。',
          '3) 默认不给行动清单；仅当用户明确问“怎么办/建议/方案/步骤”时，才给方案。',
          '4) 不要出现“先说结论：”、标题、编号列表、代码块。',
          '5) 输出自然中文，长度 260-900 字。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `用户当前输入：${userText || '继续。'}`,
      },
      {
        role: 'assistant',
        content: `这是不合格草稿（请勿沿用其跑题部分）：${String(rejectedReply || '').trim()}`,
      },
      {
        role: 'user',
        content: '请给出重写后的最终回复。',
      },
    ],
    temperature: 0.62,
    max_tokens: MODEL_MAX_TOKENS,
    stream: false,
  };

  const { response, data } = await fetchJsonWithTimeout(
    DEEPSEEK_CHAT_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    MODEL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const message = normalizeProviderError(
      'deepseek',
      response.status,
      data && data.error && data.error.message ? data.error.message : 'deepseek distress rewrite request failed',
    );
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const choice = data?.choices?.[0];
  return normalizeAssistantText(choice?.message?.content, payload);
}

async function callModelWithFailover(payload) {
  if (!DEEPSEEK_API_KEY) {
    const error = new Error('DEEPSEEK_API_KEY is missing');
    error.status = 503;
    throw error;
  }
  return chatWithDeepSeek(payload);
}

function buildMessages(payload) {
  const userText = typeof payload.message === 'string' ? payload.message.trim() : '';
  const responseMode = payload?.responseMode || detectResponseMode(payload);
  const systemPrompt = buildSystemPrompt(payload.identity, responseMode);
  const memoryHintText = buildMemoryHintText(payload);
  const recentDialogue = buildRecentDialogueMessages(payload);
  const continuityGuard = {
    role: 'system',
    content: '你会收到少量最近对话。优先承接用户刚说的话，不要自行补剧情。',
  };

  if (!payload.imageDataUrl) {
    return [
      { role: 'system', content: systemPrompt },
      ...(memoryHintText ? [{ role: 'system', content: memoryHintText }] : []),
      ...recentDialogue,
      continuityGuard,
      { role: 'user', content: userText || '继续。' },
    ];
  }

  return [
    { role: 'system', content: systemPrompt },
    ...(memoryHintText ? [{ role: 'system', content: memoryHintText }] : []),
    ...recentDialogue,
    continuityGuard,
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: payload.imageDataUrl },
        },
        {
          type: 'text',
          text: userText || '请根据图片回复。',
        },
      ],
    },
  ];
}

async function chatWithDeepSeek(payload) {
  if (!DEEPSEEK_API_KEY) {
    const error = new Error('DEEPSEEK_API_KEY is missing');
    error.status = 503;
    throw error;
  }

  const hasImage = Boolean(payload.imageDataUrl);
  const model = hasImage ? DEEPSEEK_VISION_MODEL : DEEPSEEK_TEXT_MODEL;
  const body = {
    model,
    messages: buildMessages(payload),
    temperature: 0.7,
    max_tokens: MODEL_MAX_TOKENS,
    stream: false,
  };

  const { response, data } = await fetchJsonWithTimeout(
    DEEPSEEK_CHAT_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    MODEL_TIMEOUT_MS,
  );
  if (!response.ok) {
    const message = normalizeProviderError(
      'deepseek',
      response.status,
      data && data.error && data.error.message ? data.error.message : 'deepseek request failed',
    );
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const choice = data?.choices?.[0];
  let assistantText = normalizeAssistantText(choice?.message?.content, payload);
  if (shouldExpandAssistantReply(payload, assistantText)) {
    try {
      const expanded = await expandAssistantReply(payload, model, assistantText);
      if (expanded && expanded.length > assistantText.length) {
        assistantText = expanded;
      }
    } catch (error) {
      console.warn(`[chat] expand reply skipped: ${error?.message || 'unknown error'}`);
    }
  }
  if (shouldRegenerateForDistress(payload, assistantText)) {
    try {
      const regenerated = await regenerateDistressReply(payload, model, assistantText);
      if (regenerated) {
        assistantText = regenerated;
      }
    } catch (error) {
      console.warn(`[chat] distress rewrite skipped: ${error?.message || 'unknown error'}`);
    }
  }

  let finalReply = enforceAssistantQuality(assistantText, payload);
  if (shouldRegenerateForDistress(payload, finalReply)) {
    try {
      const repaired = await regenerateDistressReply(payload, model, finalReply);
      if (repaired) {
        finalReply = enforceAssistantQuality(repaired, payload);
      }
    } catch (error) {
      console.warn(`[chat] distress final rewrite skipped: ${error?.message || 'unknown error'}`);
    }
  }
  if (shouldRegenerateForDistress(payload, finalReply)) {
    finalReply = enforceAssistantQuality(buildDistressFallbackReply(payload), payload);
  }

  return {
    reply: finalReply,
    model,
    usage: data?.usage || null,
  };
}

async function saveUserMessage(pb, userId, message, model, imageDataUrl) {
  const legacyPayload = {
    user: userId,
    role: 'user',
    text: message,
    model,
  };
  const strictPayload = {
    ...legacyPayload,
    ...buildAuditCreateFields(userId),
  };

  if (!imageDataUrl) {
    try {
      return await pb.collection(PB_CHAT_COLLECTION).create(strictPayload);
    } catch (error) {
      if (!isRecoverableMemoryWriteError(error)) throw error;
      return pb.collection(PB_CHAT_COLLECTION).create(legacyPayload);
    }
  }

  const upload = dataUrlToUpload(imageDataUrl);
  if (!upload) {
    try {
      return await pb.collection(PB_CHAT_COLLECTION).create(strictPayload);
    } catch (error) {
      if (!isRecoverableMemoryWriteError(error)) throw error;
      return pb.collection(PB_CHAT_COLLECTION).create(legacyPayload);
    }
  }

  const form = new FormData();
  form.append('user', userId);
  form.append('appId', PB_APP_ID);
  form.append('role', 'user');
  form.append('text', message);
  form.append('model', model);
  form.append('createdBy', userId);
  form.append('updatedBy', userId);
  form.append('image', upload.blob, upload.filename);
  try {
    return await pb.collection(PB_CHAT_COLLECTION).create(form);
  } catch (error) {
    if (!isRecoverableMemoryWriteError(error)) throw error;
    const fallback = new FormData();
    fallback.append('user', userId);
    fallback.append('role', 'user');
    fallback.append('text', message);
    fallback.append('model', model);
    fallback.append('image', upload.blob, upload.filename);
    return pb.collection(PB_CHAT_COLLECTION).create(fallback);
  }
}

async function saveAssistantMessage(pb, userId, message, model) {
  const strictPayload = {
    user: userId,
    role: 'assistant',
    text: message,
    model,
    ...buildAuditCreateFields(userId),
  };
  try {
    return await pb.collection(PB_CHAT_COLLECTION).create(strictPayload);
  } catch (error) {
    if (!isRecoverableMemoryWriteError(error)) throw error;
    return pb.collection(PB_CHAT_COLLECTION).create({
      user: userId,
      role: 'assistant',
      text: message,
      model,
    });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasDeepseekKey: Boolean(DEEPSEEK_API_KEY),
    textProvider: 'deepseek',
    pocketbase: {
      configured: Boolean(PB_URL),
      url: PB_URL || '',
      urlRaw: PB_URL_RAW || '',
      usersCollection: PB_USERS_COLLECTION,
      chatCollection: PB_CHAT_COLLECTION,
      chatCollectionRaw: PB_CHAT_COLLECTION_RAW,
      memoriesCollection: PB_MEMORIES_COLLECTION,
      memoriesCollectionRaw: PB_MEMORIES_COLLECTION_RAW,
      userAppsCollection: PB_USER_APPS_COLLECTION,
      appId: PB_APP_ID,
      appIdWhitelist: PB_APP_ID_WHITELIST,
      remappedLegacyConfig: PB_URL_REMAPPED || PB_CHAT_REMAPPED || PB_MEMORIES_REMAPPED,
    },
    vector: {
      enabled: isVectorConfigured(),
      provider: 'qdrant',
      embedding: 'local-hash',
      configured: Boolean(QDRANT_URL),
      collection: QDRANT_COLLECTION,
      dimension: VECTOR_DIM,
      topK: VECTOR_TOP_K,
      backoffUntil: vectorBackoffUntil || null,
    },
    model: {
      text: DEEPSEEK_TEXT_MODEL,
      vision: DEEPSEEK_VISION_MODEL,
    },
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const pb = createPb();
    await withTimeout(
      pb.collection(PB_USERS_COLLECTION).create({
        email,
        password,
        passwordConfirm: password,
        name,
      }),
      POCKETBASE_TIMEOUT_MS,
      'register create',
    );

    const authData = await withTimeout(
      pb.collection(PB_USERS_COLLECTION).authWithPassword(email, password),
      POCKETBASE_TIMEOUT_MS,
      'register auth',
    );
    const userApp = await ensureUserAppBinding(pb, authData.record);
    const role = normalizeRole(userApp?.role || authData.record?.role || PB_DEFAULT_USER_ROLE);
    return res.json({
      token: authData.token,
      user: {
        ...stripUser(authData.record),
        role,
      },
      app: {
        appId: PB_APP_ID,
        role,
        status: normalizeStatus(userApp?.status || authData.record?.status || PB_DEFAULT_USER_STATUS),
      },
    });
  } catch (error) {
    const pbData = error?.response?.data || {};
    const emailCode = pbData?.email?.code || '';
    const passwordCode = pbData?.password?.code || '';
    const emailMessage = pbData?.email?.message || '';
    const passwordMessage = pbData?.password?.message || '';

    if (emailCode === 'validation_not_unique') {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }

    if (emailCode === 'validation_invalid_email') {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    if (
      passwordCode === 'validation_length_out_of_range'
      || /8|72|min|between/i.test(String(passwordMessage || ''))
    ) {
      return res.status(400).json({ error: '密码至少 8 位' });
    }

    if (/unique/i.test(String(emailMessage || ''))) {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }

    const message = error?.response?.message || error?.message || 'register failed';
    const timeout = /timeout/i.test(String(message));
    return res.status(timeout ? 504 : 400).json({
      error: timeout ? `pocketbase request timeout: ${message}` : message,
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const pb = createPb();
    const authData = await withTimeout(
      pb.collection(PB_USERS_COLLECTION).authWithPassword(email, password),
      POCKETBASE_TIMEOUT_MS,
      'login auth',
    );
    const userApp = await ensureUserAppBinding(pb, authData.record);
    const role = normalizeRole(userApp?.role || authData.record?.role || PB_DEFAULT_USER_ROLE);
    return res.json({
      token: authData.token,
      user: {
        ...stripUser(authData.record),
        role,
      },
      app: {
        appId: PB_APP_ID,
        role,
        status: normalizeStatus(userApp?.status || authData.record?.status || PB_DEFAULT_USER_STATUS),
      },
    });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'login failed';
    const timeout = /timeout/i.test(String(message));
    return res.status(timeout ? 504 : 401).json({
      error: timeout ? `pocketbase request timeout: ${message}` : message,
    });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    return res.json({
      token: auth.token,
      user: {
        ...stripUser(auth.user),
        role: normalizeRole(auth.userApp?.role || auth.user?.role || PB_DEFAULT_USER_ROLE),
      },
      app: {
        appId: PB_APP_ID,
        role: normalizeRole(auth.userApp?.role || auth.user?.role || PB_DEFAULT_USER_ROLE),
        status: normalizeStatus(auth.userApp?.status || auth.user?.status || PB_DEFAULT_USER_STATUS),
      },
    });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'invalid token';
    return res.status(401).json({ error: message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    const limitRaw = Number(req.query.limit || 120);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(limitRaw, 300)) : 120;

    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const list = await listUserChatRecords(auth.pb, auth.user.id, 1, limit);

    const messages = list.items
      .filter((item) => !isSystemMessageRecord(item))
      .map((item) => mapMessageRecord(auth.pb, item))
      .sort((a, b) => {
        const byCreated = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
        if (byCreated !== 0) return byCreated;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });

    return res.json({
      messages,
    });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'history failed';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/history/delete', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    const incoming = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = Array.from(new Set(incoming.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 100);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'ids is required' });
    }

    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    let deleted = 0;
    let notOwned = 0;
    let notFound = 0;

    for (const id of ids) {
      let record = null;
      try {
        record = await withTimeout(
          auth.pb.collection(PB_CHAT_COLLECTION).getOne(id),
          POCKETBASE_TIMEOUT_MS,
          'history delete get',
        );
      } catch (error) {
        const status = Number(error?.status || error?.response?.status || 0);
        if (status === 404) {
          notFound += 1;
          continue;
        }
        throw error;
      }

      const sameUser = String(record?.user || '') === String(auth.user.id || '');
      const recordAppId = String(record?.appId || '').trim();
      const sameApp = !recordAppId || recordAppId === PB_APP_ID;
      if (!record || !sameUser || !sameApp) {
        notOwned += 1;
        continue;
      }

      await withTimeout(
        auth.pb.collection(PB_CHAT_COLLECTION).delete(id),
        POCKETBASE_TIMEOUT_MS,
        'history delete remove',
      );
      deleted += 1;
    }

    return res.json({ deleted, notOwned, notFound });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'history delete failed';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/history/clear', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const ids = [];
    const pageSize = 200;
    let page = 1;

    for (let guard = 0; guard < 30; guard += 1) {
      const list = await withTimeout(
        listUserChatRecords(auth.pb, auth.user.id, page, pageSize),
        POCKETBASE_TIMEOUT_MS,
        'history clear list',
      );

      const batch = Array.isArray(list?.items)
        ? list.items.filter((item) => !isSystemMessageRecord(item)).map((item) => item.id).filter(Boolean)
        : [];
      ids.push(...batch);

      const totalPages = Number(list?.totalPages || 1);
      if (page >= totalPages) break;
      page += 1;
    }

    let deleted = 0;
    for (const id of ids) {
      await withTimeout(
        auth.pb.collection(PB_CHAT_COLLECTION).delete(id),
        POCKETBASE_TIMEOUT_MS,
        'history clear remove',
      );
      deleted += 1;
    }

    const vectorCleared = await clearVectorMemoriesForUser(auth.user.id);
    return res.json({ deleted, vectorCleared });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'history clear failed';
    return res.status(400).json({ error: message });
  }
});

app.get('/api/identity', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const found = await readIdentity(auth.pb, auth.user.id);
    return res.json({
      identity: found || null,
    });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'identity fetch failed';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/identity', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const identity = normalizeIdentity(req.body || {});
    await saveIdentity(auth.pb, auth.user.id, identity);
    return res.json({ identity });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'identity save failed';
    return res.status(400).json({ error: message });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const state = await readState(auth.pb, auth.user.id);
    return res.json({ state: state || null });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'state fetch failed';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const state = normalizeStatePayload(req.body?.state || req.body || {});
    const text = stateToText(state);
    if (text.length > 900000) {
      return res.status(400).json({ error: 'state payload too large' });
    }

    await saveState(auth.pb, auth.user.id, state);
    return res.json({ state });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'state save failed';
    return res.status(400).json({ error: message });
  }
});

app.get('/api/memories', async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    const auth = await authByToken(token);
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }
    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(limitRaw, 200)) : 50;

    try {
      let list = null;
      try {
        list = await auth.pb.collection(PB_MEMORIES_COLLECTION).getList(1, limit, {
          filter: buildUserAppFilter(auth.user.id, true),
          sort: '-updated,-created',
        });
      } catch (error) {
        if (!isFilterFieldError(error)) throw error;
        list = await auth.pb.collection(PB_MEMORIES_COLLECTION).getList(1, limit, {
          filter: buildUserAppFilter(auth.user.id, false),
          sort: '-updated,-created',
        });
      }

      return res.json({
        memories: list.items.map(mapMemoryRecord),
      });
    } catch (error) {
      if (!isMissingCollectionError(error)) throw error;

      const fallback = [];
      const identity = await readIdentity(auth.pb, auth.user.id);
      const state = await readState(auth.pb, auth.user.id);
      if (identity) fallback.push({ kind: MEMORY_KIND_IDENTITY, content: identity });
      if (state) fallback.push({ kind: MEMORY_KIND_STATE, content: state });

      return res.json({ memories: fallback });
    }
  } catch (error) {
    const message = error?.response?.message || error?.message || 'memories fetch failed';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const startedAt = Date.now();
    const metrics = {};
    const checkpoint = (name, from) => {
      metrics[name] = Date.now() - from;
    };
    const shouldDebugTimings =
      ['1', 'true', 'yes', 'on'].includes(String(process.env.CHAT_DEBUG_TIMINGS || '').trim().toLowerCase())
      || req.query?.debug === '1'
      || req.body?.debug === true;

    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    let auth = null;
    const authStarted = Date.now();
    try {
      auth = await authByToken(token);
      checkpoint('authMs', authStarted);
    } catch (error) {
      const message = error?.response?.message || error?.message || 'invalid token';
      return res.status(401).json({ error: message });
    }
    if (!hasAppAccess(auth)) {
      return res.status(403).json({ error: 'app access blocked' });
    }

    const payload = req.body || {};
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const imageDataUrl = typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl.trim() : '';

    if (!message && !imageDataUrl) {
      return res.status(400).json({ error: 'message or imageDataUrl is required' });
    }
    if (imageDataUrl && !imageDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'imageDataUrl must be data:image/* base64' });
    }
    if (isInternalRecapPrompt(message)) {
      return res.status(400).json({ error: 'internal recap prompt is not allowed on chat endpoint' });
    }

    const directReply = '';
    if (directReply) {
      const persistStarted = Date.now();
      const persisted = await persistChatWithTimeout(auth, message, imageDataUrl, {
        reply: directReply,
        model: 'rule-intent',
        usage: null,
      });
      checkpoint('persistMs', persistStarted);
      checkpoint('totalMs', startedAt);

      if (shouldDebugTimings) {
        res.setHeader('x-chat-total-ms', String(metrics.totalMs || 0));
        res.setHeader('x-chat-auth-ms', String(metrics.authMs || 0));
        res.setHeader('x-chat-context-ms', '0');
        res.setHeader('x-chat-model-ms', '0');
        res.setHeader('x-chat-persist-ms', String(metrics.persistMs || 0));
      }

      return res.json({
        reply: directReply,
        model: 'rule-intent',
        usage: null,
        persisted,
      });
    }

    const allowLongTermMemory = shouldInjectLongTermMemory(message);

    const contextStarted = Date.now();
    const [remoteRecentMessages, vectorMemories, recapMemories] = await Promise.all([
      loadRecentMessagesForModel(auth.pb, auth.user.id, 12),
      (async () => {
        if (!allowLongTermMemory || !message) return [];
        return searchVectorMemories(auth.user.id, message, VECTOR_TOP_K);
      })(),
      (async () => {
        if (!allowLongTermMemory) return [];
        try {
          const state = await readState(auth.pb, auth.user.id);
          return buildRecapMemoriesFromState(state, message, 2);
        } catch (error) {
          console.warn(`[recap] read state failed: ${error?.message || 'unknown error'}`);
          return [];
        }
      })(),
    ]);
    checkpoint('contextMs', contextStarted);

    const mergedRecentMessages = mergeRecentMessages(
      remoteRecentMessages,
      Array.isArray(payload.recentMessages) ? payload.recentMessages : [],
      12,
    );
    const responseMode = detectResponseMode({
      message,
      recentMessages: mergedRecentMessages,
    });

    const payloadForModel = {
      message,
      imageDataUrl,
      relevantMemories: allowLongTermMemory
        ? mergeRelevantMemories(
          [
            ...(Array.isArray(payload.relevantMemories) ? payload.relevantMemories : []),
            ...recapMemories,
          ],
          vectorMemories,
        )
        : [],
      todayJournal: payload.todayJournal || null,
      identity: payload.identity || null,
      recentMessages: mergedRecentMessages,
      responseMode,
    };
    const modelStarted = Date.now();
    const modelResult = await callModelWithFailover(payloadForModel);
    checkpoint('modelMs', modelStarted);

    const persistStarted = Date.now();
    const persisted = await persistChatWithTimeout(auth, message, imageDataUrl, modelResult);
    checkpoint('persistMs', persistStarted);
    checkpoint('totalMs', startedAt);

    if (shouldDebugTimings) {
      res.setHeader('x-chat-total-ms', String(metrics.totalMs || 0));
      res.setHeader('x-chat-auth-ms', String(metrics.authMs || 0));
      res.setHeader('x-chat-context-ms', String(metrics.contextMs || 0));
      res.setHeader('x-chat-model-ms', String(metrics.modelMs || 0));
      res.setHeader('x-chat-persist-ms', String(metrics.persistMs || 0));
    }

    const responseBody = {
      reply: modelResult.reply,
      model: modelResult.model,
      usage: modelResult.usage,
      persisted,
    };
    if (shouldDebugTimings) {
      responseBody.timings = metrics;
      responseBody.provider = 'deepseek';
    }

    return res.json(responseBody);
  } catch (error) {
    const status = Number(error.status || 502);
    const message = error?.response?.message || error?.message || 'chat failed';
    return res.status(status).json({ error: message });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[growup-server] listening on http://localhost:${PORT}`);
    if (PB_URL_REMAPPED || PB_CHAT_REMAPPED || PB_MEMORIES_REMAPPED) {
      console.warn(
        `[growup-server] legacy pocketbase config remapped: url(${PB_URL_RAW} -> ${PB_URL}), chats(${PB_CHAT_COLLECTION_RAW} -> ${PB_CHAT_COLLECTION}), memories(${PB_MEMORIES_COLLECTION_RAW} -> ${PB_MEMORIES_COLLECTION})`,
      );
    }
    console.log(
      `[growup-server] deepseek=${DEEPSEEK_API_KEY ? 'configured' : 'missing'} text=${DEEPSEEK_TEXT_MODEL} vision=${DEEPSEEK_VISION_MODEL}`,
    );
    console.log(
      `[growup-server] response-control maxTokens=${MODEL_MAX_TOKENS} directIntentPath=disabled`,
    );
    console.log(
      `[growup-server] pocketbase=${PB_URL ? PB_URL : 'missing'} users=${PB_USERS_COLLECTION} chats=${PB_CHAT_COLLECTION} memories=${PB_MEMORIES_COLLECTION} userApps=${PB_USER_APPS_COLLECTION} appId=${PB_APP_ID}`,
    );
    console.log(
      `[growup-server] vector=${isVectorConfigured() ? 'enabled' : 'disabled'} qdrant=${QDRANT_URL ? 'configured' : 'missing'} collection=${QDRANT_COLLECTION} dim=${VECTOR_DIM} topK=${VECTOR_TOP_K}`,
    );
  });
}

module.exports = app;

