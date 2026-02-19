import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthUser } from './api';

export interface AuthSession {
  token: string;
  user: AuthUser;
}

const SESSION_KEY = 'growup.auth.session.v1';

export async function saveSession(session: AuthSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function loadSession(): Promise<AuthSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || !parsed.token || !parsed.user?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}
