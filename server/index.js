const fs = require('fs');
const path = require('path');
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

const PB_URL = (process.env.POCKETBASE_URL_NEW || process.env.POCKETBASE_URL || '').trim();
const PB_USERS_COLLECTION = (process.env.POCKETBASE_USERS_COLLECTION || 'users').trim();
const PB_CHAT_COLLECTION = (process.env.POCKETBASE_CHAT_COLLECTION || 'chat_messages').trim();
const IDENTITY_PREFIX = '__identity__::';
const STATE_PREFIX = '__app_state__::';
const STATE_MODEL = 'state-v1';

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

async function persistChatWithTimeout(auth, message, imageDataUrl, modelResult) {
  if (!auth || !PB_URL) return false;
  const persistTask = (async () => {
    await saveUserMessage(auth.pb, auth.user.id, message || '[图片]', modelResult.model, imageDataUrl);
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

async function findStateRecord(pb, userId) {
  const list = await pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
    filter: `user = "${userId}" && role = "system" && model = "${STATE_MODEL}"`,
  });
  return (
    list.items.sort((a, b) =>
      (b.updated || b.created || '').localeCompare(a.updated || a.created || ''),
    )[0] || null
  );
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
    const list = await auth.pb.collection(PB_CHAT_COLLECTION).getList(1, 120, {
      filter: `user = "${auth.user.id}" && role = "system"`,
    });
    const found = list.items
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
      .map((item) => textToIdentity(item.text))
      .find((item) => item && item.userName && item.companionName);
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
    await auth.pb.collection(PB_CHAT_COLLECTION).create({
      user: auth.user.id,
      role: 'system',
      text: identityToText(identity),
      model: 'identity-v1',
    });
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
    const record = await findStateRecord(auth.pb, auth.user.id);
    const state = record ? textToState(record.text) : null;
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

    const existing = await findStateRecord(auth.pb, auth.user.id);
    if (existing) {
      await auth.pb.collection(PB_CHAT_COLLECTION).update(existing.id, {
        role: 'system',
        model: STATE_MODEL,
        text,
      });
    } else {
      await auth.pb.collection(PB_CHAT_COLLECTION).create({
        user: auth.user.id,
        role: 'system',
        model: STATE_MODEL,
        text,
      });
    }
    return res.json({ state });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'state save failed';
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

    const payloadForModel = {
      message,
      imageDataUrl,
      relevantMemories: Array.isArray(payload.relevantMemories) ? payload.relevantMemories : [],
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
  });
}

module.exports = app;

