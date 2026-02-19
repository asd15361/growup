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
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || '';
const TEXT_MODEL = process.env.ZHIPU_TEXT_MODEL || 'glm-4.7-flash';
const VISION_MODEL = process.env.ZHIPU_VISION_MODEL || 'glm-4.6v-flash';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const PB_URL = process.env.POCKETBASE_URL_NEW || process.env.POCKETBASE_URL || '';
const PB_USERS_COLLECTION = process.env.POCKETBASE_USERS_COLLECTION || 'users';
const PB_CHAT_COLLECTION = process.env.POCKETBASE_CHAT_COLLECTION || 'chat_messages';
const IDENTITY_PREFIX = '__identity__::';

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
  const authData = await pb.collection(PB_USERS_COLLECTION).authRefresh();
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

function buildSystemPrompt(identity) {
  const profile = normalizeIdentity(identity);
  const bioLine = profile.userBio ? `用户自我介绍：${profile.userBio}` : '用户自我介绍：暂未填写';
  return [
    `你是 ${profile.companionName}，是 GrowUp 的长期成长陪跑 AI。`,
    `你正在陪伴的用户是：${profile.userName}。`,
    `你必须始终清楚你是 ${profile.companionName}，并以生活伙伴口吻陪伴 ${profile.userName}。`,
    bioLine,
    '风格：真诚、具体、可执行，不空泛鸡汤。',
    '任务：帮助用户做复盘、梳理重点、给出三步行动。',
    '当用户焦虑时，先稳住节奏，再给最小下一步。',
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

  const response = await fetch(ZHIPU_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
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
    pocketbase: {
      configured: Boolean(PB_URL),
      url: PB_URL || '',
      usersCollection: PB_USERS_COLLECTION,
      chatCollection: PB_CHAT_COLLECTION,
    },
    model: {
      text: TEXT_MODEL,
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
    await pb.collection(PB_USERS_COLLECTION).create({
      email,
      password,
      passwordConfirm: password,
      name,
    });

    const authData = await pb.collection(PB_USERS_COLLECTION).authWithPassword(email, password);
    return res.json({
      token: authData.token,
      user: stripUser(authData.record),
    });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'register failed';
    return res.status(400).json({ error: message });
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
    const authData = await pb.collection(PB_USERS_COLLECTION).authWithPassword(email, password);
    return res.json({
      token: authData.token,
      user: stripUser(authData.record),
    });
  } catch (error) {
    const message = error?.response?.message || error?.message || 'login failed';
    return res.status(401).json({ error: message });
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
      sort: '+created',
    });

    return res.json({
      messages: list.items.map((item) => mapMessageRecord(auth.pb, item)),
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
    const list = await auth.pb.collection(PB_CHAT_COLLECTION).getList(1, 40, {
      filter: `user = "${auth.user.id}" && role = "system"`,
      sort: '-created',
    });
    const found = list.items
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

app.post('/api/chat', async (req, res) => {
  try {
    const payload = req.body || {};
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const imageDataUrl = typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl.trim() : '';

    if (!message && !imageDataUrl) {
      return res.status(400).json({ error: 'message or imageDataUrl is required' });
    }
    if (imageDataUrl && !imageDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'imageDataUrl must be data:image/* base64' });
    }

    const zhipu = await chatWithZhipu({
      message,
      imageDataUrl,
      relevantMemories: Array.isArray(payload.relevantMemories) ? payload.relevantMemories : [],
      todayJournal: payload.todayJournal || null,
      identity: payload.identity || null,
    });

    let persisted = false;
    const token = getBearerToken(req);
    if (token && PB_URL) {
      try {
        const auth = await authByToken(token);
        await saveUserMessage(auth.pb, auth.user.id, message || '[鍥剧墖]', zhipu.model, imageDataUrl);
        await saveAssistantMessage(auth.pb, auth.user.id, zhipu.reply, zhipu.model);
        persisted = true;
      } catch {
        persisted = false;
      }
    }

    return res.json({
      reply: zhipu.reply,
      model: zhipu.model,
      usage: zhipu.usage,
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
    console.log(`[growup-server] zhipu=${ZHIPU_API_KEY ? 'configured' : 'missing'} text=${TEXT_MODEL} vision=${VISION_MODEL}`);
    console.log(`[growup-server] pocketbase=${PB_URL ? PB_URL : 'missing'} users=${PB_USERS_COLLECTION} chats=${PB_CHAT_COLLECTION}`);
  });
}

module.exports = app;

