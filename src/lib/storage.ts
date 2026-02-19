import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from '../types';

const STORAGE_KEY = 'growup.app.state.v1';

export async function saveAppState(state: AppState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export async function loadAppState(): Promise<AppState | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      journals: Array.isArray(parsed.journals) ? parsed.journals : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      digests: Array.isArray(parsed.digests) ? parsed.digests : [],
      recaps: Array.isArray(parsed.recaps) ? parsed.recaps : [],
      lastRolloverDate: typeof parsed.lastRolloverDate === 'string' ? parsed.lastRolloverDate : '',
    };
  } catch {
    return null;
  }
}
