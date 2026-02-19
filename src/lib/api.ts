import { ChatMessage, DailyJournal } from '../types';

export interface ChatApiRequest {
  message: string;
  imageDataUrl?: string;
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

export function getApiBaseUrl(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8787';
}

async function callApi<T>(
  pathname: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    token?: string;
  } = {},
): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data.error === 'string' && data.error.trim()
        ? data.error
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

export async function authRegister(payload: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthResponse> {
  return callApi<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: payload,
  });
}

export async function authLogin(payload: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return callApi<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: payload,
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
  });
}
