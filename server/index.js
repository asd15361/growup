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
const ZHIPU_API_KEY = (process.env.ZHIPU_API_KEY || '').trim();
const TEXT_MODEL = (process.env.ZHIPU_TEXT_MODEL || 'glm-4.7-flash').trim();
const VISION_MODEL = (process.env.ZHIPU_VISION_MODEL || 'glm-4.6v-flash').trim();
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_TEXT_MODEL = (process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-chat').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
const DEEPSEEK_CHAT_URL = `${DEEPSEEK_BASE_URL}/chat/completions`;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 45000);
const CHAT_PERSIST_TIMEOUT_MS = Number(process.env.CHAT_PERSIST_TIMEOUT_MS || 1500);
const POCKETBASE_TIMEOUT_MS = Number(process.env.POCKETBASE_TIMEOUT_MS || 15000);
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
const VECTOR_TIMEOUT_MS = Number(process.env.VECTOR_TIMEOUT_MS || 6000);
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

function isInternalRecapPrompt(message) {
  const text = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : '';
  return text.startsWith('请根据以下聊天记录生成')
    && text.includes('仅返回 JSON')
    && text.includes('"summary"')
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
  const pb = createPb();
  pb.authStore.save(token, null);
  const authData = await withTimeout(pb.collection(PB_USERS_COLLECTION).authRefresh(), POCKETBASE_TIMEOUT_MS, 'auth refresh');
  return {
    pb,
    token: authData.token || token,
    user: authData.record,
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

function mergeRelevantMemories(baseMemories, vectorMemories) {
  const merged = [];
  const seen = new Set();
  const all = [
    ...(Array.isArray(baseMemories) ? baseMemories : []),
    ...(Array.isArray(vectorMemories) ? vectorMemories : []),
  ];

  for (const item of all) {
    const normalized = normalizeTextForVector(typeof item === 'string' ? item : '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged.slice(0, 18);
}

function buildRecapMemoriesFromState(state, queryText, limit = 2) {
  if (!state || !Array.isArray(state.recaps) || state.recaps.length === 0) return [];

  const tokens = normalizeTextForVector(queryText)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 2);

  const dayRecaps = state.recaps
    .filter((item) => item && item.period === 'day')
    .sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')));

  const scored = dayRecaps
    .map((item, index) => {
      const summary = normalizeTextForVector(String(item.summary || ''));
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.map((x) => normalizeTextForVector(String(x || ''))).filter(Boolean)
        : [];
      const actions = Array.isArray(item.actions)
        ? item.actions.map((x) => normalizeTextForVector(String(x || ''))).filter(Boolean)
        : [];
      const corpus = [summary, ...highlights, ...actions].join(' ').toLowerCase();

      let score = index === 0 ? 0.25 : 0;
      for (const token of tokens) {
        if (corpus.includes(token)) score += 1;
      }

      return { item, summary, highlights, actions, score };
    })
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

function normalizeIdentity(identity) {
  const userName =
    identity && typeof identity.userName === 'string' && identity.userName.trim()
      ? identity.userName.trim()
      : '用户';
  const companionName =
    identity && typeof identity.companionName === 'string' && identity.companionName.trim()
      ? identity.companionName.trim()
      : '贾维斯';
  const userBio =
    identity && typeof identity.userBio === 'string' && identity.userBio.trim()
      ? identity.userBio.trim()
      : '';
  return { userName, companionName, userBio };
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

function buildSystemPrompt(identity) {
  const profile = normalizeIdentity(identity);
  const bioLine = profile.userBio ? `用户自我介绍：${profile.userBio}` : '用户自我介绍：暂未填写';
  return [
    `你是 ${profile.companionName}。`,
    `你正在和 ${profile.userName} 聊天。`,
    `你和 ${profile.userName} 是同一战线的真实朋友口吻。`,
    bioLine,
    '风格要求：自然、真诚、像发小/闺蜜；优先共情和理解，不端着。',
    '禁止事项：不要催用户做计划、不要打卡式提问、不要模板化“今天小成就”之类话术。',
    '禁止措辞：不要说“作为AI”“我是助手”“陪跑”等身份化表达。',
    '默认策略：先站在用户角度回应，再顺着用户语境继续聊；只有用户主动要建议时再给简短可落地建议。',
    '表达限制：少用空泛鸡汤，不要长篇说教，不要连续追问多个问题。',
    `当你需要表态时，用朋友口吻表达：我愿意做你真实的朋友，会站在你这边。`,
  ].join('\n');
}
function buildContextText(payload) {
  const profile = normalizeIdentity(payload.identity);
  const identityBlock = [
    '身份设定：',
    `- 用户名: ${profile.userName}`,
    `- 伙伴名: ${profile.companionName}`,
    `- 自我介绍: ${profile.userBio || '（未填写）'}`,
  ].join('\n');

  const memoryBlock =
    Array.isArray(payload.relevantMemories) && payload.relevantMemories.length > 0
      ? `已知用户记忆：\n- ${payload.relevantMemories.join('\n- ')}`
      : '已知用户记忆：暂无';

  const journal = payload.todayJournal || {};
  const journalBlock = [
    '今日日志：',
    `- focus: ${journal.focus || ''}`,
    `- wins: ${journal.wins || ''}`,
    `- lessons: ${journal.lessons || ''}`,
    `- gratitude: ${journal.gratitude || ''}`,
  ].join('\n');

  return `${identityBlock}\n\n${memoryBlock}\n\n${journalBlock}\n\n用户输入：${payload.message || ''}`;
}
function normalizeAssistantText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function buildMessages(payload) {
  const contextText = buildContextText(payload);
  const systemPrompt = buildSystemPrompt(payload.identity);
  if (!payload.imageDataUrl) {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextText },
    ];
  }

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: payload.imageDataUrl },
        },
        {
          type: 'text',
          text: contextText,
        },
      ],
    },
  ];
}

function buildTextMessages(payload) {
  const contextText = buildContextText(payload);
  const systemPrompt = buildSystemPrompt(payload.identity);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: contextText },
  ];
}

async function chatWithZhipu(payload) {
  if (!ZHIPU_API_KEY) {
    throw new Error('ZHIPU_API_KEY is missing');
  }
  const hasImage = Boolean(payload.imageDataUrl);
  const model = hasImage ? VISION_MODEL : TEXT_MODEL;
  const body = {
    model,
    messages: buildMessages(payload),
    temperature: 0.7,
    max_tokens: 1024,
  };

  const { response, data } = await fetchJsonWithTimeout(
    ZHIPU_CHAT_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ZHIPU_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    MODEL_TIMEOUT_MS,
  );
  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : 'zhipu request failed';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const choice = data?.choices?.[0];
  const assistantText = normalizeAssistantText(choice?.message?.content);
  return {
    reply: assistantText || '我收到了，我们继续推进今天的重点。',
    model,
    usage: data?.usage || null,
  };
}

async function chatWithDeepSeek(payload) {
  if (!DEEPSEEK_API_KEY) {
    const error = new Error('DEEPSEEK_API_KEY is missing');
    error.status = 503;
    throw error;
  }

  const body = {
    model: DEEPSEEK_TEXT_MODEL,
    messages: buildTextMessages(payload),
    temperature: 0.7,
    max_tokens: 1024,
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
    const message = data && data.error && data.error.message ? data.error.message : 'deepseek request failed';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const choice = data?.choices?.[0];
  const assistantText = normalizeAssistantText(choice?.message?.content);
  return {
    reply: assistantText || '我收到了，我们继续推进今天的重点。',
    model: DEEPSEEK_TEXT_MODEL,
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
    hasZhipuKey: Boolean(ZHIPU_API_KEY),
    hasDeepseekKey: Boolean(DEEPSEEK_API_KEY),
    textProvider: DEEPSEEK_API_KEY ? 'deepseek' : 'zhipu',
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
      text: DEEPSEEK_API_KEY ? DEEPSEEK_TEXT_MODEL : TEXT_MODEL,
      vision: VISION_MODEL,
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
    const list = await auth.pb.collection(PB_CHAT_COLLECTION).getList(1, limit, {
      filter: `user = "${auth.user.id}" && role != "system"`,
    });

    const messages = list.items
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
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    let auth = null;
    try {
      auth = await authByToken(token);
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

    const vectorMemories = message
      ? await searchVectorMemories(auth.user.id, message, VECTOR_TOP_K)
      : [];
    let recapMemories = [];
    try {
      const state = await readState(auth.pb, auth.user.id);
      recapMemories = buildRecapMemoriesFromState(state, message, 2);
    } catch (error) {
      console.warn(`[recap] read state failed: ${error?.message || 'unknown error'}`);
    }
    const payloadForModel = {
      message,
      imageDataUrl,
      relevantMemories: mergeRelevantMemories(
        [
          ...(Array.isArray(payload.relevantMemories) ? payload.relevantMemories : []),
          ...recapMemories,
        ],
        vectorMemories,
      ),
      todayJournal: payload.todayJournal || null,
      identity: payload.identity || null,
    };
    const modelResult =
      !imageDataUrl && DEEPSEEK_API_KEY
        ? await chatWithDeepSeek(payloadForModel)
        : await chatWithZhipu(payloadForModel);

    const persisted = await persistChatWithTimeout(auth, message, imageDataUrl, modelResult);

    return res.json({
      reply: modelResult.reply,
      model: modelResult.model,
      usage: modelResult.usage,
      persisted,
    });
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
      `[growup-server] zhipu=${ZHIPU_API_KEY ? 'configured' : 'missing'} deepseek=${DEEPSEEK_API_KEY ? 'configured' : 'missing'} text=${DEEPSEEK_API_KEY ? DEEPSEEK_TEXT_MODEL : TEXT_MODEL} vision=${VISION_MODEL}`,
    );
    console.log(`[growup-server] pocketbase=${PB_URL ? PB_URL : 'missing'} users=${PB_USERS_COLLECTION} chats=${PB_CHAT_COLLECTION}`);
    console.log(
      `[growup-server] vector=${isVectorConfigured() ? 'enabled' : 'disabled'} qdrant=${QDRANT_URL ? 'configured' : 'missing'} collection=${QDRANT_COLLECTION} dim=${VECTOR_DIM} topK=${VECTOR_TOP_K}`,
    );
  });
}

module.exports = app;

