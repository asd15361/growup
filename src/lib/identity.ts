import AsyncStorage from '@react-native-async-storage/async-storage';

export interface IdentityProfile {
  userId: string;
  userName: string;
  companionName: string;
  userBio: string;
  ready: boolean;
}

function keyFor(userId: string): string {
  return `growup.identity.v1.${userId}`;
}

export async function loadIdentity(userId: string): Promise<IdentityProfile | null> {
  const raw = await AsyncStorage.getItem(keyFor(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<IdentityProfile> | null;
    if (!parsed || parsed.userId !== userId) return null;
    return {
      userId: parsed.userId,
      userName: typeof parsed.userName === 'string' ? parsed.userName : '',
      companionName: typeof parsed.companionName === 'string' ? parsed.companionName : '',
      userBio: typeof parsed.userBio === 'string' ? parsed.userBio : '',
      ready: Boolean(parsed.ready),
    };
  } catch {
    return null;
  }
}

export async function saveIdentity(profile: IdentityProfile): Promise<void> {
  await AsyncStorage.setItem(keyFor(profile.userId), JSON.stringify(profile));
}
