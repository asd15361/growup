import { AppState, ChatMessage, DailyJournal } from '../types';

export interface ChatApiRequest {
  message: string;
  imageDataUrl?: string;
  recentMessages?: Array<{
    role: 'user' | 'assistant';
    text: string;
  }>;
  relevantMemories: string[];
  todayJournal: DailyJournal | null;
  identity?: {
    userName: string;
    companionName: string;
    userBio?: string;
  };
}

export interface ChatApiResponse {
  reply: string;
  model: string;
  persisted?: boolean;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface IdentityPayload {
  userName: string;
  companionName: string;
  userBio?: string;
}

export type RemoteGrowthState = Pick<
  AppState,
  'facts' | 'journals' | 'tasks' | 'digests' | 'recaps' | 'lastRolloverDate'
>;

const FALLBACK_API_BASE_URL = 'https://growup-api-3c44t6.cloud.sealos.io';

export function getApiBaseUrl(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL || FALLBACK_API_BASE_URL;
}

function getApiBaseUrls(): string[] {
  const list = [process.env.EXPO_PUBLIC_API_BASE_URL, FALLBACK_API_BASE_URL]
    .map((item) => (item || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return Array.from(new Set(list));
}

function localizeApiError(raw: string): string {
  const message = (raw || '').trim();
  if (!message) return '请求失败，请稍后重试';
  if (/[\u4E00-\u9FFF]/.test(message)) return message;

  const lower = message.toLowerCase();
  if (lower.includes('aborted') || lower.includes('timeout')) {
    return '请求超时，请检查网络后重试';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('status 429')) {
    return '请求过于频繁，请稍后再试';
  }
  if (lower.includes('network request failed') || lower.includes('failed to fetch')) {
    return '网络连接失败，请检查网络后重试';
  }
  if (lower.includes('unauthorized') || lower.includes('authentication fails')) {
    return '鉴权失败，请重新登录';
  }
  if (lower.includes('insufficient') && lower.includes('balance')) {
    return '模型账户余额不足，请联系管理员';
  }
  if (lower.includes('deepseek api key invalid')) {
    return '模型 API Key 无效，请检查配置后重试';
  }
  if (lower.includes('deepseek rate limited')) {
    return '模型请求频率过高，请稍后再试';
  }

  if (lower.includes('email and password are required')) return '请输入邮箱和密码';
  if (lower.includes('validation_not_unique') || lower.includes('email already exists') || lower.includes('must be unique')) {
    return '该邮箱已注册，请直接登录';
  }
  if (lower.includes('invalid email') || lower.includes('validation_invalid_email')) {
    return '邮箱格式不正确';
  }
  if (
    lower.includes('validation_length_out_of_range')
    || lower.includes('min 8')
    || lower.includes('between 8 and 72')
    || lower.includes('password too short')
  ) {
    return '密码至少 8 位';
  }
  if (lower.includes('register failed')) return '注册失败，请稍后重试';
  if (lower.includes('login failed')) return '登录失败，请检查账号或密码';
  if (lower.includes('missing bearer token') || lower.includes('invalid token')) {
    return '登录已失效，请重新登录';
  }
  if (lower.includes('history failed')) return '读取聊天记录失败';
  if (lower.includes('identity fetch failed')) return '读取身份设定失败';
  if (lower.includes('identity save failed')) return '保存身份设定失败';
  if (lower.includes('state fetch failed')) return '读取成长数据失败';
  if (lower.includes('state save failed') || lower.includes('state payload too large')) {
    return '保存成长数据失败';
  }
  if (lower.includes('message or imagedataurl is required')) return '请输入消息或上传图片';
  if (lower.includes('imagedataurl must be data:image/* base64')) return '图片格式不正确，请重新选择';
  if (lower.includes('chat failed') || lower.includes('deepseek request failed')) {
    return '对话请求失败，请稍后重试';
  }
  if (lower.includes('pocketbase request timeout')) {
    return '账号服务响应超时，请稍后重试';
  }

  const statusMatch = lower.match(/status\s*(\d{3})/);
  if (statusMatch) return `请求失败（状态码 ${statusMatch[1]}）`;

  return '服务开小差了，请稍后再试';
}

async function callApi<T>(
  pathname: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    token?: string;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs || 45000;
  const baseUrls = getApiBaseUrls();
  const retryableErrors: string[] = [];

  for (let i = 0; i < baseUrls.length; i += 1) {
    const baseUrl = baseUrls[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;

    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: options.method || 'GET',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      clearTimeout(timer);
      const raw = error instanceof Error ? error.message : '';
      retryableErrors.push(localizeApiError(raw));
      continue;
    }
    clearTimeout(timer);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessageFromBody =
        data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string'
          ? ((data as { error: string }).error || '').trim()
          : '';

      const message = localizeApiError(
        errorMessageFromBody
          ? errorMessageFromBody
          : `request failed with status ${response.status}`,
      );

      const canFallback = (response.status >= 500 || response.status === 429) && i < baseUrls.length - 1;
      if (canFallback) {
        retryableErrors.push(message);
        continue;
      }
      throw new Error(message);
    }

    return data as T;
  }

  if (retryableErrors.length > 0) {
    const normalized = Array.from(new Set(retryableErrors));
    if (normalized.length === 1) throw new Error(normalized[0]);
    throw new Error(`网络连接不稳定（已尝试多个入口）：${normalized.join('；')}`);
  }

  throw new Error('请求失败，请稍后重试');
}

export async function authRegister(payload: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return callApi<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: payload,
    timeoutMs: 20000,
  });
}

export async function authLogin(payload: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return callApi<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: payload,
    timeoutMs: 20000,
  });
}

export async function authMe(token: string): Promise<AuthResponse> {
  return callApi<AuthResponse>('/api/auth/me', {
    method: 'GET',
    token,
  });
}

export async function fetchHistory(token: string, limit = 120): Promise<ChatMessage[]> {
  const data = await callApi<{
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      text: string;
      imageUri?: string;
      createdAt: string;
    }>;
  }>(`/api/history?limit=${limit}`, {
    method: 'GET',
    token,
  });

  return data.messages.map((item) => ({
    id: item.id,
    role: item.role,
    text: item.text,
    imageUri: item.imageUri,
    createdAt: item.createdAt,
  }));
}

export async function fetchIdentity(token: string): Promise<IdentityPayload | null> {
  const data = await callApi<{ identity: IdentityPayload | null }>('/api/identity', {
    method: 'GET',
    token,
  });
  if (!data.identity) return null;
  return {
    userName: data.identity.userName || '用户',
    companionName: data.identity.companionName || '贾维斯',
    userBio: data.identity.userBio || '',
  };
}

export async function saveIdentityRemote(token: string, payload: IdentityPayload): Promise<IdentityPayload> {
  const data = await callApi<{ identity: IdentityPayload }>('/api/identity', {
    method: 'POST',
    token,
    body: payload,
  });
  return {
    userName: data.identity.userName || '用户',
    companionName: data.identity.companionName || '贾维斯',
    userBio: data.identity.userBio || '',
  };
}

export async function requestAssistantReply(
  payload: ChatApiRequest,
  token?: string,
): Promise<ChatApiResponse> {
  return callApi<ChatApiResponse>('/api/chat', {
    method: 'POST',
    body: payload,
    token,
    timeoutMs: 70000,
  });
}

function normalizeRemoteGrowthState(input: unknown): RemoteGrowthState {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    facts: Array.isArray(source.facts) ? source.facts : [],
    journals: Array.isArray(source.journals) ? source.journals : [],
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    digests: Array.isArray(source.digests) ? source.digests : [],
    recaps: Array.isArray(source.recaps) ? source.recaps : [],
    lastRolloverDate: typeof source.lastRolloverDate === 'string' ? source.lastRolloverDate : '',
  };
}

export async function fetchRemoteState(token: string): Promise<RemoteGrowthState | null> {
  const data = await callApi<{ state: unknown | null }>('/api/state', {
    method: 'GET',
    token,
  });
  if (!data.state) return null;
  return normalizeRemoteGrowthState(data.state);
}

export async function saveRemoteState(token: string, state: RemoteGrowthState): Promise<RemoteGrowthState> {
  const data = await callApi<{ state: unknown }>('/api/state', {
    method: 'POST',
    token,
    body: { state },
  });
  return normalizeRemoteGrowthState(data.state);
}
