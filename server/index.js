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
const MODEL_MAX_TOKENS = Number(process.env.MODEL_MAX_TOKENS || 512);
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

const PB_URL = (process.env.POCKETBASE_URL_NEW || process.env.POCKETBASE_URL || '').trim();
const PB_USERS_COLLECTION = (process.env.POCKETBASE_USERS_COLLECTION || 'users').trim();
const PB_CHAT_COLLECTION = (process.env.POCKETBASE_CHAT_COLLECTION || 'chat_messages').trim();
const PB_MEMORIES_COLLECTION = (process.env.POCKETBASE_MEMORIES_COLLECTION || 'memories').trim();
const IDENTITY_PREFIX = '__identity__::';
const STATE_PREFIX = '__app_state__::';
const STATE_MODEL = 'state-v1';
const MEMORY_KIND_IDENTITY = 'identity-v1';
const MEMORY_KIND_STATE = 'state-v1';

let vectorCollectionReady = false;
let vectorBackoffUntil = 0;
const authCache = new Map();

app.use(cors());
app.use(express.json({ limit: '25mb' }));

function createPb() {
  if (!PB_URL) {
    throw new Error('POCKETBASE_URL_NEW is missing');
  }
  return new PocketBase(PB_URL);
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

async function authByToken(token) {
  const now = Date.now();
  const cached = authCache.get(token);
  if (cached && cached.expiresAt > now) {
    const pbCached = createPb();
    pbCached.authStore.save(token, null);
    return {
      pb: pbCached,
      token,
      user: cached.user,
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
    };
    const expiresAt = Math.min(expMs, now + Math.max(30000, AUTH_CACHE_TTL_MS));
    authCache.set(token, { user, expiresAt });

    const pbFast = createPb();
    pbFast.authStore.save(token, null);
    return {
      pb: pbFast,
      token,
      user,
    };
  }

  const pb = createPb();
  pb.authStore.save(token, null);
  const authData = await withTimeout(pb.collection(PB_USERS_COLLECTION).authRefresh(), POCKETBASE_TIMEOUT_MS, 'auth refresh');
  const user = authData.record;
  if (user && user.id) {
    authCache.set(token, {
      user,
      expiresAt: now + Math.max(30000, AUTH_CACHE_TTL_MS),
    });
  }
  return {
    pb,
    token: authData.token || token,
    user,
  };
}

function mapMessageRecord(pb, record) {
  return {
    id: record.id,
    role: record.role || 'assistant',
    text: record.text || '',
    imageUri: fileUrl(pb, record, 'image') || undefined,
    createdAt: record.created || new Date().toISOString(),
  };
}

function isSystemMessageRecord(record) {
  return String(record?.role || '').toLowerCase() === 'system';
}

async function listUserChatRecords(pb, userId, page = 1, perPage = 120, sort = '-created') {
  return pb.collection(PB_CHAT_COLLECTION).getList(page, perPage, {
    filter: `user = "${userId}"`,
    sort,
  });
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
  const list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
    filter: `user = "${userId}" && role = "system"`,
  });
  return list.items
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    .find((item) => Boolean(textToIdentity(item.text))) || null;
}

async function findLegacyStateRecord(pb, userId) {
  const list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
    filter: `user = "${userId}" && role = "system" && model = "${STATE_MODEL}"`,
  });
  return (
    list.items.sort((a, b) =>
      (b.updated || b.created || '').localeCompare(a.updated || a.created || ''),
    )[0] || null
  );
}

async function findMemoryRecordByField(pb, userId, kind, field) {
  const list = await pb.collection(PB_MEMORIES_COLLECTION).getList(1, 1, {
    filter: `user = "${userId}" && ${field} = "${kind}"`,
    sort: '-updated,-created',
  });
  return list.items[0] || null;
}

async function findMemoryRecord(pb, userId, kind) {
  const fields = ['kind', 'type', 'model'];
  for (const field of fields) {
    try {
      const found = await findMemoryRecordByField(pb, userId, kind, field);
      if (found) return found;
    } catch (error) {
      if (isMissingCollectionError(error)) return null;
      if (isFilterFieldError(error)) continue;
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
  return [
    { user: userId, kind, content: raw },
    { user: userId, type: kind, content: raw },
    { user: userId, kind, text: raw },
    { user: userId, type: kind, text: raw },
    { user: userId, model: kind, text: raw },
    { user: userId, model: kind, payload: raw },
  ];
}

function buildMemoryUpdatePayloadFromRecord(record, kind, payload) {
  const raw = JSON.stringify(payload);
  const data = {};

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
    const smartPayload = buildMemoryUpdatePayloadFromRecord(existing, kind, payload);
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
    });
    return;
  }

  await pb.collection(PB_CHAT_COLLECTION).create({
    user: userId,
    role: 'system',
    model: STATE_MODEL,
    text,
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
];
const BLOCKED_ASSISTANT_STYLE_SNIPPETS = [
  '咱俩这关系',
  '我还以为你',
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
  /我昨晚.{0,10}(睡死|没回)/u,
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
    const list = await listUserChatRecords(pb, userId, 1, pageSize, '-created');
    const normalized = list.items
      .slice()
      .filter((item) => !isSystemMessageRecord(item))
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
  return /(深度|详细|展开|多说点|多说一些|底层逻辑|剖析|分析一下|深挖|具体讲|完整讲|全面一点|长一点)/u.test(text);
}

function hasBriefResponseIntent(text) {
  if (!text) return false;
  return /(简短|短一点|一句话|简单说|别太长|别啰嗦|精简)/u.test(text);
}

function detectResponseMode(payload) {
  const current = normalizeTextForVector(payload?.message || '');
  if (hasDeepResponseIntent(current)) return 'deep';
  if (hasBriefResponseIntent(current)) return 'brief';

  const recentUsers = normalizeRecentMessages(payload?.recentMessages || [], 8)
    .filter((item) => item.role === 'user')
    .map((item) => item.text)
    .slice(-2);

  if (recentUsers.some((item) => hasDeepResponseIntent(item))) return 'deep';
  if (recentUsers.some((item) => hasBriefResponseIntent(item))) return 'brief';
  return 'normal';
}

function buildSystemPrompt(identity, responseMode = 'normal') {
  const profile = normalizeIdentity(identity);
  const bioLine = profile.userBio ? `用户自我介绍：${profile.userBio}` : '用户自我介绍：暂未填写';
  const personaLines = [
    profile.companionGender ? `性别设定：${profile.companionGender}` : '',
    profile.companionMbti ? `MBTI设定：${profile.companionMbti}` : '',
    profile.companionProfession ? `职业设定：${profile.companionProfession}` : '',
  ].filter(Boolean);

  const modeLine =
    responseMode === 'deep'
      ? '当前轮用户明确要深入聊：请给 6-10 句、有结构的分析（可用“先说结论→再拆原因→最后给建议”）。'
      : responseMode === 'brief'
        ? '当前轮用户偏好简短：控制在 1-2 句，直接回答，不展开。'
        : '默认回复长度为 2-4 句，既不敷衍也不过长。';

  return [
    `你是 ${profile.companionName}。`,
    `你正在和 ${profile.userName} 聊天。`,
    '你是稳定、克制、真诚的聊天伙伴，目标是把话接住、说人话。',
    bioLine,
    ...(personaLines.length > 0 ? [`伙伴人设：${personaLines.join('；')}`] : []),
    '只基于用户当前输入和给定上下文回答；不知道就直说，不要编故事。',
    '不要虚构现实动作和场景，不要写舞台腔括号旁白。',
    '不要装熟，不要自称发小/家人/老朋友，不要臆测“上次、昨天、刚才”发生了什么。',
    '语气要求：亲近但不油腻，真诚但不说教，不要端着“教育用户”的姿态。',
    `用户问“你是谁/你叫什么”时，回答“我是${profile.companionName}，在这里和你聊天”。`,
    '用户提到专业问题时，优先用职业设定的视角回答；不确定就明确说不确定。',
    '先回应用户这句话本身，再继续对话；不强行推进任务，不说模板口号。',
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

function buildIntentReply(payload) {
  const profile = normalizeIdentity(payload?.identity);
  const text = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (!text) return '';
  const normalized = text.toLowerCase();

  if (/^(在吗|在不|在不在|在嘛|在么)[!！?？。,\s]*$/u.test(text)) {
    return '在，我在这儿。';
  }
  if (/^(你好|你好啊|你好呀|嗨|哈喽|hi|hello|nihao|nihao ma)\s*[!！?？。,]*$/u.test(normalized)) {
    return '你好，我在。你想聊点什么？';
  }
  if (/你(是谁|是什么|叫什么名字|叫啥|是谁啊|是谁呀)/u.test(text)) {
    return `我是${profile.companionName}，在这里和你聊天。`;
  }
  if (/你(在干嘛|现在在干嘛|现在在做什么|现在在干什么)/u.test(text)) {
    return '我在这儿，听你说。';
  }
  if (/你是什么模型|什么模型|model/u.test(text)) {
    return `我是${profile.companionName}，底层用的是对话大模型。`;
  }
  if (/^\?+$/.test(text) || /^？+$/.test(text)) {
    return '我在，刚才那句我没听清，你再说一遍就行。';
  }
  return '';
}

function buildFallbackReply(payload) {
  const text = typeof payload?.message === 'string' ? payload.message : '';
  const intentReply = buildIntentReply(payload);
  if (intentReply) return intentReply;
  if (/[睡困晚安休息]/.test(text)) {
    return '那就先睡吧，晚安。我在，明天再接着聊。';
  }
  if (/[累崩溃焦虑难受压力烦]/.test(text)) {
    return '听到了，你现在不好受。先缓一缓，我在这儿。';
  }
  return '我在，接着说。';
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
    `你这个话题（${topic}）值得认真拆开说。`,
    '先说结论：你现在更需要的是“被准确理解”，而不是一句空话安慰。',
    '再看原因：前面体验让你反复觉得它在自说自话，所以你会对敷衍特别敏感。',
    '可执行建议：我们继续用“你给真实对话→我按问题点逐条修”这套方式，很快能把质感拉上来。',
  ].join('');
}

function enforceAssistantQuality(text, payload) {
  const normalized = String(text || '').trim();
  if (!normalized) return buildFallbackReply(payload);
  if (isUnsafeAssistantStyle(normalized)) return buildFallbackReply(payload);

  const responseMode = payload?.responseMode || detectResponseMode(payload);
  if (responseMode === 'deep') {
    const sentenceSize = countSentences(normalized);
    if (normalized.length < 80 || sentenceSize < 3) {
      return buildDeepFallbackReply(payload);
    }
  }

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
  const assistantText = normalizeAssistantText(choice?.message?.content, payload);
  const finalReply = enforceAssistantQuality(assistantText || buildFallbackReply(payload), payload);
  return {
    reply: finalReply,
    model,
    usage: data?.usage || null,
  };
}

async function saveUserMessage(pb, userId, message, model, imageDataUrl) {
  if (!imageDataUrl) {
    const record = await pb.collection(PB_CHAT_COLLECTION).create({
      user: userId,
      role: 'user',
      text: message,
      model,
    });
    return record;
  }

  const upload = dataUrlToUpload(imageDataUrl);
  if (!upload) {
    const record = await pb.collection(PB_CHAT_COLLECTION).create({
      user: userId,
      role: 'user',
      text: message,
      model,
    });
    return record;
  }

  const form = new FormData();
  form.append('user', userId);
  form.append('role', 'user');
  form.append('text', message);
  form.append('model', model);
  form.append('image', upload.blob, upload.filename);
  return pb.collection(PB_CHAT_COLLECTION).create(form);
}

async function saveAssistantMessage(pb, userId, message, model) {
  return pb.collection(PB_CHAT_COLLECTION).create({
    user: userId,
    role: 'assistant',
    text: message,
    model,
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasDeepseekKey: Boolean(DEEPSEEK_API_KEY),
    textProvider: 'deepseek',
    pocketbase: {
      configured: Boolean(PB_URL),
      url: PB_URL || '',
      usersCollection: PB_USERS_COLLECTION,
      chatCollection: PB_CHAT_COLLECTION,
      memoriesCollection: PB_MEMORIES_COLLECTION,
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
    return res.json({
      token: authData.token,
      user: stripUser(authData.record),
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
    return res.json({
      token: authData.token,
      user: stripUser(authData.record),
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
    return res.json({
      token: auth.token,
      user: stripUser(auth.user),
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
    const list = await listUserChatRecords(auth.pb, auth.user.id, 1, limit, '-created');

    const messages = list.items
      .filter((item) => !isSystemMessageRecord(item))
      .map((item) => mapMessageRecord(auth.pb, item))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

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

      if (!record || String(record.user || '') !== String(auth.user.id || '')) {
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
    const ids = [];
    const pageSize = 200;
    let page = 1;

    for (let guard = 0; guard < 30; guard += 1) {
      const list = await withTimeout(
        listUserChatRecords(auth.pb, auth.user.id, page, pageSize, '-created'),
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
    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(limitRaw, 200)) : 50;

    try {
      const list = await auth.pb.collection(PB_MEMORIES_COLLECTION).getList(1, limit, {
        filter: `user = "${auth.user.id}"`,
        sort: '-updated,-created',
      });

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

    const directReply = !imageDataUrl
      ? buildIntentReply({ message, identity: payload.identity || null })
      : '';
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
    console.log(
      `[growup-server] deepseek=${DEEPSEEK_API_KEY ? 'configured' : 'missing'} text=${DEEPSEEK_TEXT_MODEL} vision=${DEEPSEEK_VISION_MODEL}`,
    );
    console.log(`[growup-server] pocketbase=${PB_URL ? PB_URL : 'missing'} users=${PB_USERS_COLLECTION} chats=${PB_CHAT_COLLECTION}`);
    console.log(
      `[growup-server] vector=${isVectorConfigured() ? 'enabled' : 'disabled'} qdrant=${QDRANT_URL ? 'configured' : 'missing'} collection=${QDRANT_COLLECTION} dim=${VECTOR_DIM} topK=${VECTOR_TOP_K}`,
    );
  });
}

module.exports = app;

