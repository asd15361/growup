import { useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState as RNAppState,
  BackHandler,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { lightColors, darkColors, Colors } from './src/theme';
import { PlayfairDisplay_700Bold, useFonts as useTitleFonts } from '@expo-google-fonts/playfair-display';
import {
  NotoSansSC_400Regular,
  NotoSansSC_500Medium,
  NotoSansSC_700Bold,
  useFonts as useBodyFonts,
} from '@expo-google-fonts/noto-sans-sc';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts as useDMSansFonts,
} from '@expo-google-fonts/dm-sans';
import {
  authLogin,
  authMe,
  authRegister,
  AuthUser,
  clearHistoryMessages,
  deleteHistoryMessages,
  fetchHistory,
  fetchIdentity,
  fetchRemoteState,
  requestAssistantReply,
  saveIdentityRemote,
  saveRemoteState,
} from './src/lib/api';
import { formatClock, toDateKey, toWeekLabel } from './src/lib/date';
import { categoryLabel, extractFacts, findRelevantFacts, mergeFacts } from './src/lib/memoryEngine';
import { buildPeriodicRecaps, buildRolloverPrompt } from './src/lib/recapEngine';
import { IdentityProfile, loadIdentity, saveIdentity } from './src/lib/identity';
import { clearSession, loadSession, saveSession } from './src/lib/session';
import { AppState, ChatMessage, PeriodicRecap, RecapPeriod } from './src/types';
import RobotIcon, { RobotIconName } from './src/components/RobotIcon';

type TabKey = 'home' | 'chat' | 'recap' | 'me';
type AuthMode = 'login' | 'register';
type FontStyle = { fontFamily?: string };
type QuoteRole = 'user' | 'assistant';

interface QuoteDraft {
  messageId: string;
  role: QuoteRole;
  text: string;
}

interface ParsedQuotedMessage {
  body: string;
  quote: {
    role: QuoteRole;
    text: string;
  } | null;
}

interface AuthSession {
  token: string;
  user: AuthUser;
}

type GrowthStateSlices = Pick<AppState, 'facts' | 'journals' | 'tasks' | 'digests' | 'recaps' | 'lastRolloverDate'>;

const ACCENT = '#FF6B35';

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeQuoteSnippet(text: string, maxLen = 80): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/」/g, '”')
    .trim()
    .slice(0, maxLen);
}

function parseQuotedMessageText(text: string): ParsedQuotedMessage {
  const raw = String(text || '');
  const match = /^回复「(AI|我)：([^\n]{1,220})」\n?([\s\S]*)$/u.exec(raw);
  if (!match) {
    return { body: raw, quote: null };
  }
  const role: QuoteRole = match[1] === 'AI' ? 'assistant' : 'user';
  const quoteText = sanitizeQuoteSnippet(match[2], 220);
  const body = String(match[3] || '').trimStart();
  return {
    body,
    quote: quoteText ? { role, text: quoteText } : null,
  };
}

function buildQuotedMessageText(body: string, draft: QuoteDraft | null): string {
  const normalizedBody = String(body || '').trim();
  if (!normalizedBody) return '';
  if (!draft) return normalizedBody;
  const roleLabel = draft.role === 'assistant' ? 'AI' : '我';
  const snippet = sanitizeQuoteSnippet(draft.text, 120);
  if (!snippet) return normalizedBody;
  return `回复「${roleLabel}：${snippet}」\n${normalizedBody}`;
}

function textForModelFromMessageText(text: string): string {
  const parsed = parseQuotedMessageText(text);
  if (!parsed.quote) return (text || '').trim();
  const roleLabel = parsed.quote.role === 'assistant' ? 'AI' : '我';
  const body = parsed.body.trim();
  return [`引用${roleLabel}：${parsed.quote.text}`, body].filter(Boolean).join('\n');
}

function displayTextFromMessageText(text: string): string {
  const parsed = parseQuotedMessageText(text);
  if (parsed.body.trim()) return parsed.body.trim();
  if (parsed.quote?.text) return parsed.quote.text;
  return String(text || '').trim();
}

function defaultState(): AppState {
  return {
    messages: [
      {
        id: createId('msg'),
        role: 'assistant',
        text: '嗨，我在这儿。想聊什么就说，我都会认真听。',
        createdAt: new Date().toISOString(),
      },
    ],
    facts: [],
    journals: [],
    tasks: [],
    digests: [],
    recaps: [],
    lastRolloverDate: toDateKey(),
  };
}

function normalizeGrowthStateSlices(input: Partial<GrowthStateSlices> | null | undefined): GrowthStateSlices {
  const journals = Array.isArray(input?.journals) ? input.journals : [];
  return {
    facts: Array.isArray(input?.facts) ? input.facts : [],
    journals,
    tasks: Array.isArray(input?.tasks) ? input.tasks : [],
    digests: Array.isArray(input?.digests) ? input.digests : [],
    recaps: Array.isArray(input?.recaps) && input.recaps.length > 0 ? input.recaps : buildPeriodicRecaps(journals),
    lastRolloverDate:
      typeof input?.lastRolloverDate === 'string' && input.lastRolloverDate.trim()
        ? input.lastRolloverDate.trim()
        : toDateKey(),
  };
}

function periodLabel(period: RecapPeriod, date: Date): string {
  if (period === 'day') return toDateKey(date);
  if (period === 'week') return toWeekLabel(date);
  if (period === 'month') return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
  return `${date.getFullYear()}`;
}

function periodRange(period: RecapPeriod, date: Date): { startDate: string; endDate: string } {
  if (period === 'day') {
    const key = toDateKey(date);
    return { startDate: key, endDate: key };
  }

  if (period === 'week') {
    const day = new Date(date);
    const weekday = day.getDay();
    const shift = weekday === 0 ? 6 : weekday - 1;
    day.setDate(day.getDate() - shift);
    const startDate = toDateKey(day);
    const end = new Date(day);
    end.setDate(end.getDate() + 6);
    return { startDate, endDate: toDateKey(end) };
  }

  if (period === 'month') {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { startDate: toDateKey(start), endDate: toDateKey(end) };
  }

  const start = new Date(date.getFullYear(), 0, 1);
  const end = new Date(date.getFullYear(), 11, 31);
  return { startDate: toDateKey(start), endDate: toDateKey(end) };
}

function messagesInPeriod(messages: ChatMessage[], period: RecapPeriod, now: Date): ChatMessage[] {
  const label = periodLabel(period, now);
  return messages.filter((item) => {
    const date = new Date(item.createdAt);
    if (Number.isNaN(date.getTime())) return false;
    if (period === 'day') return toDateKey(date) === label;
    if (period === 'week') return toWeekLabel(date) === label;
    if (period === 'month') return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}` === label;
    return `${date.getFullYear()}` === label;
  });
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim();
  const fenced = /```json\s*([\s\S]*?)```/i.exec(cleaned);
  const candidate = fenced ? fenced[1] : cleaned;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isInternalRecapPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.startsWith('请根据以下聊天记录生成')
    && normalized.includes('仅返回 JSON')
    && normalized.includes('"summary"')
    && normalized.includes('"important"')
    && normalized.includes('"todo"');
}

function isInternalRecapJsonReply(text: string): boolean {
  const parsed = extractJsonObject(text);
  if (!parsed) return false;
  return typeof parsed.summary === 'string'
    && Array.isArray(parsed.important)
    && Array.isArray(parsed.todo);
}

function stripInternalRecapMessages(messages: ChatMessage[]): ChatMessage[] {
  const cleaned: ChatMessage[] = [];
  let waitingRecapReply = false;

  for (const message of messages) {
    if (message.role === 'user' && isInternalRecapPrompt(message.text)) {
      waitingRecapReply = true;
      continue;
    }

    if (waitingRecapReply && message.role === 'assistant' && isInternalRecapJsonReply(message.text)) {
      waitingRecapReply = false;
      continue;
    }

    waitingRecapReply = false;
    cleaned.push(message);
  }

  return cleaned;
}

function fallbackRecapDraft(logs: ChatMessage[]): {
  summary: string;
  important: string[];
  todo: string[];
  milestones: string[];
  growths: string[];
} {
  const userLogs = logs.filter((item) => item.role === 'user');
  const summary =
    userLogs.length > 0
      ? `最近你主要在做：${userLogs
          .slice(-3)
          .map((item) => item.text.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('；')
          .slice(0, 120)}`
      : '当前记录较少，建议先明确最重要的一件事。';
  const important = userLogs
    .slice(-5)
    .map((item) => item.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3);
  return {
    summary,
    important,
    todo: ['把下一步拆成今天可执行的动作', '做完后继续复盘反馈'],
    milestones: ['保持持续记录'],
    growths: ['表达更具体，目标更清晰'],
  };
}

function upsertRecap(recaps: PeriodicRecap[], incoming: PeriodicRecap): PeriodicRecap[] {
  const index = recaps.findIndex((item) => item.period === incoming.period && item.label === incoming.label);
  const next = [...recaps];
  if (index >= 0) next[index] = incoming;
  else next.push(incoming);
  return next
    .sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime())
    .slice(0, 240);
}

function relevantDayRecapMemories(recaps: PeriodicRecap[], query: string, limit = 2): string[] {
  const normalized = (query || '').trim().toLowerCase();
  const tokens = normalized.split(/[\s,，。！？；、]+/g).filter((item) => item.length >= 2);

  const scored = recaps
    .filter((item) => item.period === 'day')
    .map((item) => {
      const text = [item.summary, ...item.highlights, ...item.actions].join(' ').toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (text.includes(token)) score += 1;
      }
      return { item, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.item.endDate).getTime() - new Date(a.item.endDate).getTime();
    })
    .slice(0, Math.max(1, limit));

  const memories: string[] = [];
  for (const entry of scored) {
    const recap = entry.item;
    memories.push(`日复盘(${recap.label})：${(recap.summary || '').slice(0, 120)}`);
    if (recap.highlights && recap.highlights.length > 0) {
      memories.push(`日亮点(${recap.label})：${(recap.highlights[0] || '').slice(0, 80)}`);
    }
    if (recap.actions && recap.actions.length > 0) {
      memories.push(`日行动(${recap.label})：${(recap.actions[0] || '').slice(0, 80)}`);
    }
  }

  return memories.slice(0, 6);
}

function buildClipboardFromMessages(messages: ChatMessage[]): string {
  if (!messages || messages.length === 0) return '';
  return messages
    .map((msg) => {
      const speaker = msg.role === 'user' ? '我' : 'AI';
      const parsed = parseQuotedMessageText(msg.text || '');
      const mainText = (parsed.body || '').trim();
      const quoteText = parsed.quote ? `（引用${parsed.quote.role === 'assistant' ? 'AI' : '我'}：${parsed.quote.text}）` : '';
      const text = [quoteText, mainText].filter(Boolean).join(' ');
      const imageTag = msg.imageUri ? ' [图片]' : '';
      const content = text || (msg.imageUri ? '（图片）' : '');
      return `${speaker} ${formatClock(msg.createdAt)}: ${content}${imageTag}`;
    })
    .join('\n');
}

function sortMessagesChronologically(messages: ChatMessage[]): ChatMessage[] {
  return [...(messages || [])].sort((a, b) => {
    const aOrder = Number(a?.order);
    const bOrder = Number(b?.order);
    const aHasOrder = Number.isFinite(aOrder);
    const bHasOrder = Number.isFinite(bOrder);

    if (aHasOrder && bHasOrder && aOrder !== bOrder) return aOrder - bOrder;
    if (aHasOrder && !bHasOrder) return -1;
    if (!aHasOrder && bHasOrder) return 1;

    const aTime = Date.parse(String(a?.createdAt || ''));
    const bTime = Date.parse(String(b?.createdAt || ''));
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);

    if (aValid && bValid && aTime !== bTime) return aTime - bTime;

    const byCreated = String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''));
    if (byCreated !== 0) return byCreated;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

export default function App() {
  const [titleLoaded, titleFontError] = useTitleFonts({ PlayfairDisplay_700Bold });
  const [bodyLoaded, bodyFontError] = useBodyFonts({
    NotoSansSC_400Regular,
    NotoSansSC_500Medium,
    NotoSansSC_700Bold,
  });
  const [dmLoaded, dmFontError] = useDMSansFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });
  const fontsReady = (titleLoaded || Boolean(titleFontError)) && (bodyLoaded || Boolean(bodyFontError)) && (dmLoaded || Boolean(dmFontError));

  const [tab, setTab] = useState<TabKey>('home');
  const [state, setState] = useState<AppState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [networkStateLoaded, setNetworkStateLoaded] = useState(false);

  const [input, setInput] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [chatSelectionMode, setChatSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [chatActionBusy, setChatActionBusy] = useState(false);
  const [quoteDraft, setQuoteDraft] = useState<QuoteDraft | null>(null);

  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const [identity, setIdentity] = useState<IdentityProfile | null>(null);
  const [identityUserName, setIdentityUserName] = useState('');
  const [identityCompanionName, setIdentityCompanionName] = useState('贾维斯');
  const [identityCompanionGender, setIdentityCompanionGender] = useState('中性');
  const [identityCompanionMbti, setIdentityCompanionMbti] = useState('');
  const [identityCompanionProfession, setIdentityCompanionProfession] = useState('');
  const [identityUserBio, setIdentityUserBio] = useState('');
  const [identityBusy, setIdentityBusy] = useState(false);
  const [forceIdentitySetup, setForceIdentitySetup] = useState(false);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [identitySetupReturnTab, setIdentitySetupReturnTab] = useState<TabKey>('home');

  // 主题状态
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('light');
  const isDark = themeMode === 'dark';

  // 动态主题颜色 - 使用完整的主题系统
  const colors = useMemo(() => isDark ? darkColors : lightColors, [isDark]);

  const toggleTheme = () => setThemeMode(prev => prev === 'light' ? 'dark' : 'light');

  const [recapPeriod, setRecapPeriod] = useState<RecapPeriod>('day');
  const recapBootRef = useRef<{ signature: string; lastRunAt: number }>({
    signature: '',
    lastRunAt: 0,
  });
  const chatScrollRef = useRef<ScrollView | null>(null);
  const composerInputRef = useRef<TextInput | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const hasChatLaidOutRef = useRef(false);

  const todayKey = toDateKey();
  const bodyFont: FontStyle = fontsReady ? { fontFamily: 'NotoSansSC_500Medium' } : {};
  const bodyMedium: FontStyle = fontsReady ? { fontFamily: 'NotoSansSC_700Bold' } : {};
  const bodyBold: FontStyle = fontsReady ? { fontFamily: 'NotoSansSC_700Bold' } : {};
  const titleFont: FontStyle = fontsReady ? { fontFamily: 'PlayfairDisplay_700Bold' } : {};
  const chatBottomPadding = isKeyboardVisible
    ? (quoteDraft ? 188 : 142)
    : (quoteDraft ? 132 : 90);
  const selectedMessageIdSet = useMemo(() => new Set(selectedMessageIds), [selectedMessageIds]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setBootTimedOut(true);
      setHydrated((prev) => (prev ? prev : true));
    }, 12000);
    return () => clearTimeout(timer);
  }, []);

  const inferUserName = (user: AuthUser): string => {
    if (user.name && user.name.trim()) return user.name.trim();
    if (user.email.includes('@')) return user.email.split('@')[0];
    return '朋友';
  };

  const loadOrInitIdentity = async (user: AuthUser, token?: string): Promise<IdentityProfile> => {
    const local = await loadIdentity(user.id);

    if (token) {
      try {
        const remote = await fetchIdentity(token);
        if (remote) {
          const synced: IdentityProfile = {
            userId: user.id,
            userName: remote.userName,
            companionName: remote.companionName,
            companionGender: remote.companionGender || '中性',
            companionMbti: remote.companionMbti || '',
            companionProfession: remote.companionProfession || '',
            userBio: remote.userBio || '',
            userAvatarUrl: local?.userAvatarUrl,
            ready: true,
          };
          setIdentity(synced);
          setIdentityUserName(synced.userName);
          setIdentityCompanionName(synced.companionName);
          setIdentityCompanionGender(synced.companionGender || '中性');
          setIdentityCompanionMbti(synced.companionMbti || '');
          setIdentityCompanionProfession(synced.companionProfession || '');
          setIdentityUserBio(synced.userBio);
          setForceIdentitySetup(!synced.ready);
          await saveIdentity(synced);
          return synced;
        }
      } catch {
        // ignore
      }
    }

    if (local) {
      setIdentity(local);
      setIdentityUserName(local.userName || inferUserName(user));
      setIdentityCompanionName(local.companionName || '贾维斯');
      setIdentityCompanionGender(local.companionGender || '中性');
      setIdentityCompanionMbti(local.companionMbti || '');
      setIdentityCompanionProfession(local.companionProfession || '');
      setIdentityUserBio(local.userBio || '');
      setForceIdentitySetup(!local.ready);
      return local;
    }

    const created: IdentityProfile = {
      userId: user.id,
      userName: inferUserName(user),
      companionName: '贾维斯',
      companionGender: '中性',
      companionMbti: '',
      companionProfession: '',
      userBio: '',
      ready: false,
    };
    setIdentity(created);
    setIdentityUserName(created.userName);
    setIdentityCompanionName(created.companionName);
    setIdentityCompanionGender(created.companionGender);
    setIdentityCompanionMbti(created.companionMbti);
    setIdentityCompanionProfession(created.companionProfession);
    setIdentityUserBio(created.userBio);
    setForceIdentitySetup(true);
    await saveIdentity(created);
    return created;
  };

  const loadCloudData = async (token: string): Promise<{ issues: string[] }> => {
    const [messagesResult, remoteStateResult] = await Promise.allSettled([
      fetchHistory(token, 180),
      fetchRemoteState(token),
    ]);

    const issues: string[] = [];
    const messages = messagesResult.status === 'fulfilled' ? messagesResult.value : null;
    const remoteState = remoteStateResult.status === 'fulfilled' ? remoteStateResult.value : null;

    if (messagesResult.status === 'rejected') {
      issues.push(messagesResult.reason instanceof Error ? messagesResult.reason.message : '读取聊天记录失败');
    }
    if (remoteStateResult.status === 'rejected') {
      issues.push(remoteStateResult.reason instanceof Error ? remoteStateResult.reason.message : '读取成长数据失败');
    }

    setState((prev) => {
      let next = prev;
      if (remoteState) {
        const slices = normalizeGrowthStateSlices(remoteState);
        next = { ...next, ...slices };
      }
      if (messages && messages.length > 0) {
        const cleanedMessages = sortMessagesChronologically(stripInternalRecapMessages(messages));
        if (cleanedMessages.length > 0) {
          next = { ...next, messages: cleanedMessages };
        }
      }
      return next;
    });

    return { issues };
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const session = await loadSession();
      if (!active) return;

      if (!session) {
        setHydrated(true);
        return;
      }

      try {
        const refreshed = await authMe(session.token);
        if (!active) return;

        const nextSession: AuthSession = { token: refreshed.token, user: refreshed.user };
        setAuthSession(nextSession);
        await saveSession(nextSession);

        const identityProfile = await loadOrInitIdentity(nextSession.user, nextSession.token);
        if (!active) return;

        const cloudResult = await loadCloudData(nextSession.token);
        if (!active) return;

        setForceIdentitySetup(!identityProfile.ready);
        setNetworkStateLoaded(true);
        if (cloudResult.issues.length > 0) {
          setNotice('已进入应用，云端数据将稍后继续同步');
        }
      } catch {
        await clearSession();
        if (!active) return;
        setAuthSession(null);
        setIdentity(null);
        setForceIdentitySetup(false);
      } finally {
        if (active) setHydrated(true);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onShow = () => {
      setIsKeyboardVisible(true);
      requestAnimationFrame(() => {
        chatScrollRef.current?.scrollToEnd({ animated: true });
      });
      setTimeout(() => {
        chatScrollRef.current?.scrollToEnd({ animated: true });
      }, 80);
    };

    const onHide = () => {
      setIsKeyboardVisible(false);
      setInputFocused(false);
    };

    const showSub = Keyboard.addListener('keyboardDidShow', onShow);
    const hideSub = Keyboard.addListener('keyboardDidHide', onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (forceIdentitySetup) {
        if (!identity?.ready) return true;
        setForceIdentitySetup(false);
        setTab(identitySetupReturnTab);
        return true;
      }
      if (tab !== 'home') {
        setTab('home');
        return true;
      }
      return false;
    });

    return () => {
      subscription.remove();
    };
  }, [forceIdentitySetup, identity?.ready, identitySetupReturnTab, tab]);

  useEffect(() => {
    if (!hydrated || !identity?.ready) return;
    setState((prev) => {
      if (prev.lastRolloverDate === todayKey) return prev;
      const assistant: ChatMessage = {
        id: createId('rollover'),
        role: 'assistant',
        text: buildRolloverPrompt(identity.companionName, prev.recaps),
        createdAt: new Date().toISOString(),
      };
      return {
        ...prev,
        lastRolloverDate: todayKey,
        messages: [...prev.messages, assistant].slice(-240),
      };
    });
  }, [hydrated, identity?.ready, identity?.companionName, todayKey]);

  // 每小时自动复盘 - 仅前台运行
  const lastRecapHourRef = useRef<number>(-1);
  
  useEffect(() => {
    if (!hydrated || !identity?.ready || !authSession) return;

    const appStateSub = RNAppState.addEventListener('change', (nextAppState) => {
      // 进入前台时重置定时器检查
      if (nextAppState === 'active') {
        lastRecapHourRef.current = -1;
      }
    });

    const interval = setInterval(() => {
      // 只在前台运行
      if (RNAppState.currentState !== 'active') return;
      
      const now = new Date();
      const currentHour = now.getHours();
      
      // 每小时只执行一次
      if (currentHour === lastRecapHourRef.current) return;
      lastRecapHourRef.current = currentHour;

      // 生成当日复盘（静默更新）
      setState((prev) => {
        const todayMessages = messagesInPeriod(prev.messages, 'day', now);
        if (todayMessages.length < 3) return prev; // 消息太少不生成

        const todayKey = toDateKey(now);
        const todayRecap: PeriodicRecap = {
          id: `auto-recap-${todayKey}-${currentHour}`,
          period: 'day',
          label: todayKey,
          startDate: todayKey,
          endDate: todayKey,
          summary: `今日${todayMessages.length}条对话，持续记录中...`,
          highlights: ['自动记录中'],
          lowlights: [],
          actions: [],
          milestones: [],
          growths: [],
          createdAt: new Date().toISOString(),
        };

        // 覆盖当天的复盘
        const otherRecaps = prev.recaps.filter(r => !(r.period === 'day' && r.label === todayKey));
        
        return {
          ...prev,
          recaps: [...otherRecaps, todayRecap],
        };
      });
    }, 60 * 60 * 1000); // 每小时检查一次

    return () => {
      appStateSub.remove();
      clearInterval(interval);
    };
  }, [hydrated, identity?.ready, authSession]);

  const remoteGrowthState = useMemo<GrowthStateSlices>(
    () => ({
      facts: state.facts,
      journals: state.journals,
      tasks: state.tasks,
      digests: state.digests,
      recaps: state.recaps,
      lastRolloverDate: state.lastRolloverDate,
    }),
    [state.facts, state.journals, state.tasks, state.digests, state.recaps, state.lastRolloverDate],
  );

  useEffect(() => {
    if (!hydrated || !authSession || !networkStateLoaded) return;
    const timer = setTimeout(() => {
      saveRemoteState(authSession.token, remoteGrowthState).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [hydrated, authSession, networkStateLoaded, remoteGrowthState]);

  useEffect(() => {
    if (!hydrated || !authSession || !identity?.ready || !networkStateLoaded) return;
    const snapshot = state.messages.slice(-240);
    const userMessages = snapshot.filter((item) => item.role === 'user');
    if (userMessages.length === 0) return;

    const lastUserMessage = userMessages[userMessages.length - 1];
    const signaturePrefix = `${authSession.user.id}|${todayKey}|`;
    const runSignature = `${signaturePrefix}${lastUserMessage.id}`;
    const nowMs = Date.now();

    if (recapBootRef.current.signature === runSignature) return;
    if (
      recapBootRef.current.signature.startsWith(signaturePrefix)
      && nowMs - recapBootRef.current.lastRunAt < 60000
    ) {
      return;
    }
    recapBootRef.current = { signature: runSignature, lastRunAt: nowMs };

    const periods: RecapPeriod[] = ['day', 'week', 'month', 'year'];
    const now = new Date();
    let cancelled = false;

    (async () => {
      for (const period of periods) {
        if (cancelled) return;
        const logs = messagesInPeriod(snapshot, period, now).slice(-48);
        if (logs.filter((x) => x.role === 'user').length === 0) continue;

        const fallback = fallbackRecapDraft(logs);
        let summary = fallback.summary;
        let important = fallback.important;
        let todo = fallback.todo;
        let milestones = fallback.milestones;
        let growths = fallback.growths;

        const label = periodLabel(period, now);
        const range = periodRange(period, now);
        const recap: PeriodicRecap = {
          id: createId(`recap-${period}`),
          period,
          label,
          startDate: range.startDate,
          endDate: range.endDate,
          summary,
          highlights: important,
          lowlights: [],
          actions: todo,
          milestones,
          growths,
          createdAt: new Date().toISOString(),
        };

        if (!cancelled) {
          setState((prev) => ({ ...prev, recaps: upsertRecap(prev.recaps, recap) }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, authSession, identity, networkStateLoaded, todayKey, state.messages]);

  const visibleRecaps = useMemo(
    () => state.recaps.filter((item) => item.period === recapPeriod).slice(0, 24),
    [state.recaps, recapPeriod],
  );

  const submitAuth = async () => {
    const email = authEmail.trim();
    const password = authPassword;

    if (!email || !password) {
      setAuthError('请输入邮箱和密码');
      return;
    }
    if (authMode === 'register' && password.length < 8) {
      setAuthError('密码至少 8 位');
      return;
    }

    await Haptics.selectionAsync();
    setAuthBusy(true);
    setAuthError('');
    setNetworkStateLoaded(false);

    try {
      const result = authMode === 'register' ? await authRegister({ email, password }) : await authLogin({ email, password });
      const session: AuthSession = { token: result.token, user: result.user };
      setAuthSession(session);
      await saveSession(session);
      const identityProfile = await loadOrInitIdentity(session.user, session.token);
      const cloudResult = await loadCloudData(session.token);
      setForceIdentitySetup(!identityProfile.ready);
      setNetworkStateLoaded(true);
      if (cloudResult.issues.length > 0) {
        setNotice('登录成功，云端数据正在同步');
      } else {
        setNotice('登录成功，云端数据已连接');
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败');
    } finally {
      setAuthBusy(false);
    }
  };
  const logout = async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await clearSession();
    setAuthSession(null);
    setAuthMode('login');
    setAuthEmail('');
    setAuthPassword('');
    setAuthError('');
    setIdentity(null);
    setIdentityUserName('');
    setIdentityCompanionName('贾维斯');
    setIdentityCompanionGender('中性');
    setIdentityCompanionMbti('');
    setIdentityCompanionProfession('');
    setIdentityUserBio('');
    setForceIdentitySetup(false);
    setIdentitySetupReturnTab('home');
    setIsKeyboardVisible(false);
    setTab('home');
    setInput('');
    setBusy(false);
    setNotice('已退出登录');
    setState(defaultState());
    setNetworkStateLoaded(false);
    recapBootRef.current = { signature: '', lastRunAt: 0 };
  };

  const submitIdentity = async () => {
    if (!authSession) {
      setNotice('登录状态失效，请重新登录');
      return;
    }
    if (!identity) {
      setNotice('资料还在加载，请稍后再试');
      return;
    }
    if (identityBusy) return;

    const userName = identityUserName.trim() || inferUserName(authSession.user);
    const companionName = identityCompanionName.trim() || '贾维斯';
    const companionGender = identityCompanionGender.trim() || '中性';
    const companionMbti = '';
    const companionProfession = '';
    const userBio = identityUserBio.trim();
    const editingExistingIdentity = identity.ready;
    const nextIdentityPayload = {
      userName,
      companionName,
      companionGender,
      companionMbti,
      companionProfession,
      userBio,
    };

    setIdentityBusy(true);
    try {
      const next: IdentityProfile = {
        ...identity,
        userName,
        companionName,
        companionGender,
        companionMbti,
        companionProfession,
        userBio,
        ready: true,
      };
      setIdentity(next);
      setIdentityUserName(next.userName);
      setIdentityCompanionName(next.companionName);
      setIdentityCompanionGender(next.companionGender || '中性');
      setIdentityCompanionMbti('');
      setIdentityCompanionProfession('');
      setIdentityUserBio(next.userBio);
      await saveIdentity(next);

      if (editingExistingIdentity) {
        const nowIso = new Date().toISOString();
        const updateFacts = extractFacts(
          `我叫${userName}。我的伙伴叫${companionName}，性别${companionGender}。${userBio}`,
          nowIso,
        );
        const roleChangedTip: ChatMessage = {
          id: createId('identity-updated'),
          role: 'assistant',
          text: `角色已更新：从现在开始我会以「${companionName}」这个设定和你聊天，新的名字和性别都已经生效。`,
          createdAt: new Date(Date.now() + 1).toISOString(),
        };
        setState((prev) => ({
          ...prev,
          facts: mergeFacts(prev.facts, updateFacts),
          messages: [...prev.messages, roleChangedTip].slice(-240),
        }));
      } else {
        const nowIso = new Date().toISOString();
        const ask: ChatMessage = {
          id: createId('identity-ask'),
          role: 'assistant',
          text: `你好，我是${companionName}。希望我怎么称呼你？也可以介绍一下你自己。`,
          createdAt: nowIso,
        };
        const intro: ChatMessage = {
          id: createId('identity-user'),
          role: 'user',
          text: userBio ? `你可以叫我${userName}。我的自我介绍：${userBio}` : `你可以叫我${userName}。`,
          createdAt: nowIso,
        };
        const ack: ChatMessage = {
          id: createId('identity-ack'),
          role: 'assistant',
          text: `记住了，${userName}。以后你随时找我，我们在一边。`,
          createdAt: nowIso,
        };

        const introFacts = extractFacts(
          `我叫${userName}。我的伙伴叫${companionName}，性别${companionGender}。${userBio}`,
          nowIso,
        );
        setState((prev) => ({
          ...prev,
          facts: mergeFacts(prev.facts, introFacts),
          messages: [...prev.messages, ask, intro, ack].slice(-240),
        }));
      }
      setForceIdentitySetup(false);
      setTab(identitySetupReturnTab);
      setNotice(editingExistingIdentity ? '资料已更新' : `设定完成：${companionName} 已上线`);

      void saveIdentityRemote(authSession.token, nextIdentityPayload).catch(() => {
        setNotice('资料本地已保存，云端同步失败（可稍后再进设置保存一次）');
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败，请稍后重试');
    } finally {
      setIdentityBusy(false);
    }
  };

  const focusComposer = () => {
    if (chatSelectionMode) {
      setNotice('请先退出多选模式再输入');
      return;
    }
    shouldAutoScrollRef.current = true;
    requestAnimationFrame(() => {
      chatScrollRef.current?.scrollToEnd({ animated: true });
      setTimeout(() => composerInputRef.current?.focus(), 10);
    });
  };

  const pickUserAvatar = async () => {
    if (!identity) return;
    await Haptics.selectionAsync();

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice('请允许相册权限后再设置头像');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.72,
    });

    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.uri) {
      setNotice('头像读取失败，请重试');
      return;
    }

    const nextIdentity: IdentityProfile = {
      ...identity,
      userAvatarUrl: asset.uri,
    };
    setIdentity(nextIdentity);
    await saveIdentity(nextIdentity);
    setNotice('头像已更新');
  };

  const exitChatSelectionMode = () => {
    setChatSelectionMode(false);
    setSelectedMessageIds([]);
  };

  const toggleSelectMessage = (messageId: string) => {
    setSelectedMessageIds((prev) => {
      if (prev.includes(messageId)) {
        const next = prev.filter((id) => id !== messageId);
        if (next.length === 0) {
          setChatSelectionMode(false);
        }
        return next;
      }
      return [...prev, messageId];
    });
  };

  const dismissComposerKeyboard = () => {
    if (!isKeyboardVisible && !inputFocused) return;
    Keyboard.dismiss();
    setInputFocused(false);
  };

  const startQuoteReply = (messageId: string) => {
    const target = state.messages.find((item) => item.id === messageId);
    if (!target) return;
    if (target.text === '正在输入...') {
      setNotice('这条消息还在生成中，暂时不能引用');
      return;
    }
    const displayText = displayTextFromMessageText(target.text);
    const snippet = sanitizeQuoteSnippet(displayText, 120);
    if (!snippet) {
      setNotice('这条消息暂时不能引用');
      return;
    }

    setQuoteDraft({
      messageId: target.id,
      role: target.role === 'assistant' ? 'assistant' : 'user',
      text: snippet,
    });
    setChatSelectionMode(false);
    setSelectedMessageIds([]);
    setNotice(`已引用${target.role === 'assistant' ? 'AI' : '我'}的消息`);
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  };

  const enterSelectionModeWithMessage = async (messageId: string) => {
    await Haptics.selectionAsync();
    setChatSelectionMode(true);
    setQuoteDraft(null);
    setInputFocused(false);
    Keyboard.dismiss();
    setSelectedMessageIds((prev) => (prev.includes(messageId) ? prev : [...prev, messageId]));
  };

  const onMessageLongPress = async (messageId: string) => {
    if (chatSelectionMode) {
      toggleSelectMessage(messageId);
      return;
    }

    Alert.alert(
      '消息操作',
      '选择你要执行的操作',
      [
        {
          text: '引用回复',
          onPress: () => startQuoteReply(messageId),
        },
        {
          text: '多选',
          onPress: () => {
            void enterSelectionModeWithMessage(messageId);
          },
        },
        { text: '取消', style: 'cancel' },
      ],
      { cancelable: true },
    );
  };

  const onMessagePress = (messageId: string) => {
    if (!chatSelectionMode) {
      dismissComposerKeyboard();
      return;
    }
    toggleSelectMessage(messageId);
  };

  const copySelectedMessages = async () => {
    if (selectedMessageIds.length === 0) {
      setNotice('请先选中消息');
      return;
    }
    const selectedMessages = state.messages.filter((item) => selectedMessageIdSet.has(item.id));
    const text = buildClipboardFromMessages(selectedMessages);
    if (!text.trim()) {
      setNotice('选中的消息没有可复制内容');
      return;
    }

    await Clipboard.setStringAsync(text);
    setNotice(`已复制 ${selectedMessages.length} 条消息`);
    exitChatSelectionMode();
  };

  const copyAllMessages = async () => {
    if (chatSelectionMode) {
      setNotice('请先退出多选模式');
      return;
    }

    const exportMessages = state.messages.filter((item) => {
      const text = (item.text || '').trim();
      if (!text && !item.imageUri) return false;
      if (text === '正在输入...') return false;
      if (isInternalRecapPrompt(text) || isInternalRecapJsonReply(text)) return false;
      return true;
    });

    const text = buildClipboardFromMessages(exportMessages);
    if (!text.trim()) {
      setNotice('当前没有可复制的聊天记录');
      return;
    }

    await Haptics.selectionAsync();
    await Clipboard.setStringAsync(text);
    setNotice(`已复制全部聊天记录（${exportMessages.length} 条）`);
  };

  const performClearAllMessages = async () => {
    if (chatActionBusy) return;
    setChatActionBusy(true);
    try {
      let cloudFailed = false;
      let cloudDeleted = 0;
      if (authSession) {
        try {
          const result = await clearHistoryMessages(authSession.token);
          cloudDeleted = Number(result.deleted || 0);
        } catch {
          cloudFailed = true;
        }
      }

      const starter: ChatMessage = {
        id: createId('msg'),
        role: 'assistant',
        text: `嗨，我是${identity?.companionName || '伙伴'}。我们重新开始聊吧。`,
        createdAt: new Date().toISOString(),
      };

      setState((prev) => ({
        ...prev,
        messages: [starter],
        facts: [],
      }));
      setQuoteDraft(null);
      exitChatSelectionMode();
      setNotice(
        cloudFailed
          ? '已清空本地聊天记录（云端稍后再同步）'
          : `已清空聊天记录${cloudDeleted > 0 ? `（云端删除 ${cloudDeleted} 条）` : ''}`,
      );
    } finally {
      setChatActionBusy(false);
    }
  };

  const clearAllMessages = () => {
    if (chatSelectionMode) {
      setNotice('请先退出多选模式');
      return;
    }
    Alert.alert(
      '清空聊天记录',
      '会删除当前账号的全部聊天记录，并清理聊天记忆。这个操作不能撤销。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认清空',
          style: 'destructive',
          onPress: () => {
            void performClearAllMessages();
          },
        },
      ],
    );
  };

  const deleteSelectedMessages = async () => {
    if (selectedMessageIds.length === 0) {
      setNotice('请先选中消息');
      return;
    }
    if (chatActionBusy) return;

    setChatActionBusy(true);
    try {
      let cloudDeleteFailed = false;
      if (authSession) {
        try {
          const result = await deleteHistoryMessages(authSession.token, selectedMessageIds);
          if (result.notOwned > 0) {
            setNotice('有部分消息不属于当前账号，已跳过');
          }
        } catch {
          cloudDeleteFailed = true;
        }
      }

      setState((prev) => ({
        ...prev,
        messages: prev.messages.filter((item) => !selectedMessageIdSet.has(item.id)).slice(-240),
      }));
      if (quoteDraft && selectedMessageIdSet.has(quoteDraft.messageId)) {
        setQuoteDraft(null);
      }
      setNotice(
        cloudDeleteFailed
          ? `已删除本地 ${selectedMessageIds.length} 条消息（云端稍后再同步）`
          : `已删除 ${selectedMessageIds.length} 条消息`,
      );
      exitChatSelectionMode();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败，请稍后重试');
    } finally {
      setChatActionBusy(false);
    }
  };

  const onSend = async () => {
    if (chatSelectionMode) {
      setNotice('请先退出多选模式');
      return;
    }
    if (!authSession) {
      setNotice('请先登录后发送');
      return;
    }
    if (!identity || !identity.ready) {
      setNotice('请先完成伙伴设定');
      return;
    }

    const text = input.trim();
    if (!text || busy) return;
    const activeQuoteDraft = quoteDraft;
    const composedUserText = buildQuotedMessageText(text, activeQuoteDraft);
    if (!composedUserText) return;

    await Haptics.selectionAsync();
    setBusy(true);
    setInput('');
    setQuoteDraft(null);

    const nowIso = new Date().toISOString();
    const userText = composedUserText;
    const recentMessages = state.messages
      .filter((item) => item.text && item.text.trim())
      .filter((item) => !isInternalRecapPrompt(item.text))
      .filter((item) => !isInternalRecapJsonReply(item.text))
      .filter((item) => item.text !== '正在输入...')
      .slice(-12);
    const extracted = extractFacts(text, nowIso);
    const mergedFacts = mergeFacts(state.facts, extracted);
    const relevantFacts = findRelevantFacts(mergedFacts, text, 5);
    const relevantRecaps = relevantDayRecapMemories(state.recaps, text, 2);
    const relevantMemories = [
      ...relevantFacts.map((item) => `${categoryLabel(item.category)}：${item.value}`),
      ...relevantRecaps,
    ].slice(0, 10);
    const modelRecentMessages = recentMessages.map((item) => ({
      role: item.role,
      text: textForModelFromMessageText(item.text),
    }));

    const userMessage: ChatMessage = {
      id: createId('local-user'),
      role: 'user',
      text: composedUserText,
      createdAt: nowIso,
    };
    const thinkingId = createId('assistant-thinking');
    const thinkingMessage: ChatMessage = {
      id: thinkingId,
      role: 'assistant',
      text: '正在输入...',
      createdAt: nowIso,
    };

    setState((prev) => ({
      ...prev,
      facts: mergeFacts(prev.facts, extracted),
      messages: [...prev.messages, userMessage, thinkingMessage].slice(-240),
    }));

    try {
      const result = await requestAssistantReply(
        {
          message: textForModelFromMessageText(userText),
          recentMessages: modelRecentMessages,
          relevantMemories,
          todayJournal: null,
          identity: {
            userName: identity.userName,
            companionName: identity.companionName,
            companionGender: identity.companionGender,
            companionMbti: '',
            companionProfession: '',
            userBio: identity.userBio,
          },
        },
        authSession.token,
      );

      setState((prev) => {
        const assistant: ChatMessage = {
          id: thinkingId,
          role: 'assistant',
          text: result.reply,
          createdAt: new Date().toISOString(),
        };
        let replaced = false;
        const patched = prev.messages.map((item) => {
          if (item.id !== thinkingId) return item;
          replaced = true;
          return assistant;
        });
        const nextMessages = replaced ? patched : [...patched, assistant];
        return {
          ...prev,
          facts: mergedFacts,
          messages: nextMessages.slice(-240),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络失败，请稍后重试';
      setState((prev) => {
        const errorTip: ChatMessage = {
          id: thinkingId,
          role: 'assistant',
          text: `网络失败：${message}`,
          createdAt: new Date().toISOString(),
        };
        let replaced = false;
        const patched = prev.messages.map((item) => {
          if (item.id !== thinkingId) return item;
          replaced = true;
          return errorTip;
        });
        const nextMessages = replaced ? patched : [...patched, errorTip];
        return {
          ...prev,
          messages: nextMessages.slice(-240),
        };
      });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  };

  const onChatScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    shouldAutoScrollRef.current = distanceFromBottom <= 96;
  };

  const onChatContentSizeChange = () => {
    if (!shouldAutoScrollRef.current) return;
    requestAnimationFrame(() => {
      chatScrollRef.current?.scrollToEnd({ animated: hasChatLaidOutRef.current });
    });
  };

  const onChatLayout = () => {
    if (hasChatLaidOutRef.current) return;
    hasChatLaidOutRef.current = true;
    requestAnimationFrame(() => {
      chatScrollRef.current?.scrollToEnd({ animated: false });
    });
  };

  useEffect(() => {
    if (tab !== 'chat' || !isKeyboardVisible) return;
    requestAnimationFrame(() => {
      chatScrollRef.current?.scrollToEnd({ animated: true });
    });
  }, [isKeyboardVisible, tab]);

  useEffect(() => {
    if (tab !== 'chat') return;
    if (chatSelectionMode) return;
    const timer = setTimeout(() => {
      focusComposer();
    }, 80);
    return () => clearTimeout(timer);
  }, [tab, chatSelectionMode]);

  useEffect(() => {
    if (tab === 'chat') return;
    if (!chatSelectionMode && selectedMessageIds.length === 0) return;
    setChatSelectionMode(false);
    setSelectedMessageIds([]);
  }, [tab, chatSelectionMode, selectedMessageIds.length]);

  const openIdentitySetup = (returnTab: TabKey = tab) => {
    if (!authSession || !identity) return;
    setIdentityBusy(false);
    setIdentitySetupReturnTab(returnTab);
    setIdentityUserName(identity.userName || inferUserName(authSession.user));
    setIdentityCompanionName(identity.companionName || '贾维斯');
    setIdentityCompanionGender(identity.companionGender || '中性');
    setIdentityCompanionMbti(identity.companionMbti || '');
    setIdentityCompanionProfession(identity.companionProfession || '');
    setIdentityUserBio(identity.userBio || '');
    setForceIdentitySetup(true);
  };

  const cancelIdentitySetup = () => {
    if (!identity?.ready) return;
    setIdentityBusy(false);
    setIdentityUserName(identity.userName || '朋友');
    setIdentityCompanionName(identity.companionName || '贾维斯');
    setIdentityCompanionGender(identity.companionGender || '中性');
    setIdentityCompanionMbti(identity.companionMbti || '');
    setIdentityCompanionProfession(identity.companionProfession || '');
    setIdentityUserBio(identity.userBio || '');
    setForceIdentitySetup(false);
    setTab(identitySetupReturnTab);
  };

  if ((!fontsReady || !hydrated) && !bootTimedOut) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  if (!authSession) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        email={authEmail}
        setEmail={setAuthEmail}
        password={authPassword}
        setPassword={setAuthPassword}
        busy={authBusy}
        error={authError}
        onSubmit={submitAuth}
        bodyFont={bodyFont}
        bodyMedium={bodyMedium}
        bodyBold={bodyBold}
      />
    );
  }

  if (!identity || !identity.ready || forceIdentitySetup) {
    return (
      <IdentitySetupScreen
        userName={identityUserName}
        setUserName={setIdentityUserName}
        companionName={identityCompanionName}
        setCompanionName={setIdentityCompanionName}
        companionGender={identityCompanionGender}
        setCompanionGender={setIdentityCompanionGender}
        userBio={identityUserBio}
        setUserBio={setIdentityUserBio}
        busy={identityBusy}
        onSubmit={submitIdentity}
        allowCancel={Boolean(identity?.ready)}
        onCancel={cancelIdentitySetup}
        titleFont={titleFont}
        bodyFont={bodyFont}
        bodyMedium={bodyMedium}
        bodyBold={bodyBold}
      />
    );
  }
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <SafeAreaView
        style={[
          styles.safe,
          {
            paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight || 0) + 6 : 6,
            paddingBottom: isKeyboardVisible ? 0 : 10,
          },
        ]}
      >
        <View style={styles.flex}>
          {tab === 'home' ? (
            <View style={styles.homeScreen}>
              <View style={[styles.homeTopNav, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Pressable style={styles.homeNavItem} onPress={() => setTab('chat')}>
                  <RobotIcon name="robot" size={16} color="#FF6B35" />
                  <Text style={[styles.homeNavLabel, bodyMedium, { color: colors.textPrimary }]}>{identity?.companionName || '伙伴'}</Text>
                </Pressable>
                <Pressable style={styles.homeNavItem} onPress={() => setTab('recap')}>
                  <RobotIcon name="recap" size={16} color="#FF6B35" />
                  <Text style={[styles.homeNavLabel, bodyMedium, { color: colors.textPrimary }]}>复盘</Text>
                </Pressable>
                <Pressable style={styles.homeNavItem} onPress={() => setTab('me')}>
                  <RobotIcon name="profile" size={16} color="#FF6B35" />
                  <Text style={[styles.homeNavLabel, bodyMedium, { color: colors.textPrimary }]}>我的</Text>
                </Pressable>
              </View>
              <View style={styles.homeCenter}>
                <Text style={[styles.homeTitle, bodyBold, { color: colors.textPrimary }]}>欢迎回来，{identity?.userName || inferUserName(authSession.user)}</Text>
                <Text style={[styles.homeDesc, bodyFont, { color: colors.textSecondary }]}>
                  {`点上面的「${identity?.companionName || '伙伴'}」，直接进入聊天输入。`}
                </Text>
              </View>
              {notice ? <Text style={[styles.notice, bodyFont]}>{notice}</Text> : null}
            </View>
          ) : null}

          {tab === 'chat' ? (
            <KeyboardAvoidingView
              style={styles.flex}
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 18 : 24}
            >
              <View style={styles.chatTopBar}>
                {chatSelectionMode ? (
                  <View style={styles.chatSelectionBar}>
                    <Text style={[styles.chatSelectionCount, bodyBold, { color: colors.textPrimary }]}>
                      已选 {selectedMessageIds.length} 条
                    </Text>
                    <View style={styles.chatSelectionActions}>
                      <Pressable style={styles.chatSelectionBtn} onPress={copySelectedMessages} disabled={chatActionBusy}>
                        <Text style={[styles.chatSelectionBtnText, bodyFont, { color: '#FF6B35' }]}>复制</Text>
                      </Pressable>
                      <Pressable style={styles.chatSelectionBtn} onPress={deleteSelectedMessages} disabled={chatActionBusy}>
                        <Text style={[styles.chatSelectionBtnText, bodyFont, { color: '#FF6B35' }]}>删除</Text>
                      </Pressable>
                      <Pressable style={styles.chatSelectionBtn} onPress={exitChatSelectionMode} disabled={chatActionBusy}>
                        <Text style={[styles.chatSelectionBtnText, bodyFont, { color: colors.textSecondary }]}>取消</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={styles.chatTopSimple}>
                    <Pressable style={styles.iconBlack} onPress={() => setTab('home')}>
                      <RobotIcon name="back" size={15} color="#FF6B35" />
                    </Pressable>
                    <Text style={[styles.chatTopTitle, bodyBold, { color: colors.textPrimary }]}>{identity?.companionName || '伙伴'}</Text>
                    <View style={styles.chatTopRight}>
                      <Pressable style={styles.chatTopCopyBtn} onPress={copyAllMessages}>
                        <Text style={[styles.chatTopCopyText, bodyMedium, { color: '#FF6B35' }]}>复制全部</Text>
                      </Pressable>
                      <Pressable style={[styles.chatTopCopyBtn, styles.chatTopDangerBtn]} onPress={clearAllMessages} disabled={chatActionBusy}>
                        <Text style={[styles.chatTopCopyText, bodyMedium, { color: '#DC2626' }]}>清空</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>

              <View style={styles.chatStage}>
                <ScrollView
                  ref={chatScrollRef}
                  style={styles.flex}
                  contentContainerStyle={[styles.chatList, { paddingBottom: chatBottomPadding }]}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                  onTouchStart={() => {
                    dismissComposerKeyboard();
                  }}
                  onLayout={onChatLayout}
                  onScroll={onChatScroll}
                  onContentSizeChange={onChatContentSizeChange}
                  scrollEventThrottle={16}
                >
                  {state.messages.length <= 1 ? (
                    <View style={styles.emptyChatState}>
                      <LinearGradient
                        colors={['#FFFFFF', '#FFF4EF']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.emptyChatIcon}
                      >
                        <RobotIcon name="robot" size={34} color="#FF6B35" />
                      </LinearGradient>
                      <Text style={[styles.emptyChatTitle, bodyBold, { color: colors.textPrimary }]}>和{identity?.companionName || '伙伴'}聊聊吧</Text>
                      <Text style={[styles.emptyChatDesc, bodyFont, { color: colors.textSecondary }]}>分享你的想法、感受{'\n'}我会认真倾听并陪你成长</Text>
                    </View>
                  ) : null}
                  {state.messages.map((msg, index) => (
                    <MessageBubble
                      key={msg.id}
                      msg={msg}
                      isNew={index === state.messages.length - 1}
                      selectionMode={chatSelectionMode}
                      selected={selectedMessageIdSet.has(msg.id)}
                      onPress={onMessagePress}
                      onLongPress={onMessageLongPress}
                      colors={colors}
                      bodyFont={bodyFont}
                      isDark={isDark}
                      userAvatarUrl={identity?.userAvatarUrl}
                    />
                  ))}
                </ScrollView>

                {!chatSelectionMode ? (
                  <BlurView
                    intensity={20}
                    tint={isDark ? 'dark' : 'light'}
                    style={[
                      styles.composerDockClosed,
                      isKeyboardVisible ? styles.composerDockRaised : null,
                      {
                        borderColor: colors.border,
                        backgroundColor: isDark ? 'rgba(20, 20, 20, 0.94)' : 'rgba(255, 255, 255, 0.96)',
                      },
                    ]}
                  >
                    {quoteDraft ? (
                      <View style={styles.quoteDraftBar}>
                        <View style={styles.quoteDraftTextWrap}>
                          <Text style={[styles.quoteDraftLabel, bodyMedium, { color: '#FF6B35' }]}>
                            回复{quoteDraft.role === 'assistant' ? ' AI' : ' 我'}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={[styles.quoteDraftText, bodyFont, { color: colors.textSecondary }]}
                          >
                            {quoteDraft.text}
                          </Text>
                        </View>
                        <Pressable
                          style={styles.quoteDraftCloseBtn}
                          onPress={() => setQuoteDraft(null)}
                          hitSlop={8}
                        >
                          <Text style={[styles.quoteDraftCloseText, bodyMedium]}>取消</Text>
                        </Pressable>
                      </View>
                    ) : null}
                    <TextInput
                      ref={composerInputRef}
                      value={input}
                      onChangeText={setInput}
                      style={[
                        styles.input,
                        bodyFont,
                        {
                          color: colors.textPrimary,
                          borderColor: inputFocused ? '#FF6B35' : colors.border,
                          backgroundColor: isDark ? '#161616' : '#F5F5F5',
                        },
                      ]}
                      placeholder="发消息…（回车发送）"
                      placeholderTextColor={colors.textTertiary}
                      autoFocus={tab === 'chat'}
                      multiline={false}
                      returnKeyType="send"
                      blurOnSubmit={false}
                      onSubmitEditing={onSend}
                      onFocus={() => {
                        setInputFocused(true);
                        shouldAutoScrollRef.current = true;
                        requestAnimationFrame(() => {
                          chatScrollRef.current?.scrollToEnd({ animated: true });
                        });
                      }}
                      onBlur={() => setInputFocused(false)}
                    />
                  </BlurView>
                ) : null}
              </View>

              {notice ? <Text style={[styles.notice, bodyFont]}>{notice}</Text> : null}
            </KeyboardAvoidingView>
          ) : null}

          {tab === 'recap' ? (
            <View style={[styles.flex, { backgroundColor: colors.background }]}>
              <View style={[styles.recapTopBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
                <Pressable style={styles.iconBlack} onPress={() => setTab('home')}>
                  <RobotIcon name="back" size={16} color="#FF6B35" />
                </Pressable>
                <Text style={[styles.recapTopTitle, bodyMedium, { color: colors.textPrimary }]}>复盘</Text>
                <View style={styles.recapTopSpacer} />
              </View>

              <ScrollView style={styles.flex} contentContainerStyle={styles.recapContainer}>
                <View style={[styles.recapFilters, { backgroundColor: isDark ? colors.surface : '#F5F5F5' }]}>
                  <RecapFilterButton label="日" active={recapPeriod === 'day'} onPress={() => setRecapPeriod('day')} font={bodyMedium} isDark={isDark} colors={colors} />
                  <RecapFilterButton label="周" active={recapPeriod === 'week'} onPress={() => setRecapPeriod('week')} font={bodyMedium} isDark={isDark} colors={colors} />
                  <RecapFilterButton label="月" active={recapPeriod === 'month'} onPress={() => setRecapPeriod('month')} font={bodyMedium} isDark={isDark} colors={colors} />
                  <RecapFilterButton label="年" active={recapPeriod === 'year'} onPress={() => setRecapPeriod('year')} font={bodyMedium} isDark={isDark} colors={colors} />
                </View>

                {visibleRecaps.length === 0 ? <Text style={[styles.emptyText, bodyFont, { color: colors.textTertiary }]}>先聊几句，系统会自动生成复盘。</Text> : null}

                {visibleRecaps.map((item) => (
                  <RecapCard key={item.id} item={item} colors={colors} bodyFont={bodyFont} bodyBold={bodyBold} isDark={isDark} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {tab === 'me' ? (
            <View style={[styles.flex, { backgroundColor: colors.background }]}>
              <View style={[styles.recapTopBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
                <Pressable style={styles.iconBlack} onPress={() => setTab('home')}>
                  <RobotIcon name="back" size={16} color="#FF6B35" />
                </Pressable>
                <Text style={[styles.recapTopTitle, bodyMedium, { color: colors.textPrimary }]}>我的</Text>
                <View style={styles.recapTopSpacer} />
              </View>

              <ScrollView style={styles.flex} contentContainerStyle={styles.profileContainer}>
                <View style={[styles.profileCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Pressable style={styles.profileAvatarWrap} onPress={pickUserAvatar}>
                    {identity?.userAvatarUrl ? (
                      <Image source={{ uri: identity.userAvatarUrl }} style={styles.profileAvatarImage} />
                    ) : (
                      <View style={styles.profileAvatarPlaceholder}>
                        <RobotIcon name="profile" size={30} color="#FF6B35" />
                      </View>
                    )}
                    <View style={styles.profileAvatarBadge}>
                      <RobotIcon name="camera" size={12} color="#FF6B35" />
                    </View>
                  </Pressable>
                  <Text style={[styles.profileName, bodyBold, { color: colors.textPrimary }]}>{identity?.userName || inferUserName(authSession.user)}</Text>
                  <Text style={[styles.profileEmail, bodyFont, { color: colors.textSecondary }]}>{authSession.user.email}</Text>
                  <Pressable style={[styles.profilePrimaryAction, { backgroundColor: colors.accent }]} onPress={pickUserAvatar}>
                    <Text style={[styles.profilePrimaryActionLabel, bodyMedium]}>更换头像</Text>
                  </Pressable>
                </View>

                <View style={[styles.profileCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <ProfileRow label="你的称呼" value={identity?.userName || inferUserName(authSession.user)} font={bodyFont} colors={colors} />
                  <ProfileRow label="伙伴名字" value={identity?.companionName || '贾维斯'} font={bodyFont} colors={colors} />
                  <ProfileRow label="伙伴性别" value={identity?.companionGender || '中性'} font={bodyFont} colors={colors} />
                  <ProfileRow label="自我介绍" value={identity?.userBio || '未填写'} font={bodyFont} colors={colors} />
                  <Pressable style={[styles.profileSecondaryAction, { borderColor: colors.border }]} onPress={() => openIdentitySetup('me')}>
                    <Text style={[styles.profileSecondaryActionLabel, bodyMedium, { color: colors.textPrimary }]}>编辑信息</Text>
                  </Pressable>
                </View>

                <View style={[styles.profileCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Pressable style={styles.profileActionRow} onPress={toggleTheme}>
                    <View style={styles.profileActionIcon}>
                      <RobotIcon name={isDark ? 'sun' : 'moon'} size={13} color="#FF6B35" />
                    </View>
                    <Text style={[styles.profileActionLabel, bodyFont, { color: colors.textPrimary }]}>{isDark ? '切换到浅色模式' : '切换到深色模式'}</Text>
                  </Pressable>
                  <Pressable style={styles.profileActionRow} onPress={logout}>
                    <View style={styles.profileActionIcon}>
                      <RobotIcon name="logout" size={13} color="#FF6B35" />
                    </View>
                    <Text style={[styles.profileActionLabel, bodyFont, { color: colors.textPrimary }]}>退出登录</Text>
                  </Pressable>
                </View>
              </ScrollView>
              {notice ? <Text style={[styles.notice, bodyFont]}>{notice}</Text> : null}
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

function AuthScreen({
  mode,
  setMode,
  email,
  setEmail,
  password,
  setPassword,
  busy,
  error,
  onSubmit,
  bodyFont,
  bodyMedium,
  bodyBold,
}: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  busy: boolean;
  error: string;
  onSubmit: () => void;
  bodyFont: FontStyle;
  bodyMedium: FontStyle;
  bodyBold: FontStyle;
}) {
  // 淡入动画
  const fadeAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <View style={styles.authRoot}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.authSafe}>
        <Animated.View style={{ opacity: fadeAnim, flex: 1, justifyContent: 'center' }}>
          {/* 品牌区域 */}
          <View style={styles.authBrandWrap}>
            <LinearGradient
              colors={['#0A0A0A', '#262626']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.authLogo}
            >
              {/* 机械感机器人图标 */}
              <View style={styles.robotIcon}>
                <View style={styles.robotHead}>
                  <View style={styles.robotEye} />
                  <View style={styles.robotEye} />
                </View>
                <View style={styles.robotMouth} />
              </View>
            </LinearGradient>
            <Text style={[styles.authBrand, bodyBold]}>TIANBO robot</Text>
            <Text style={[styles.authTagline, bodyMedium]}>你的AI伙伴，陪伴成长</Text>
            <Text style={[styles.authTaglineSub, bodyFont]}>—— 陪伴你成长的AI伙伴 ——</Text>
          </View>

          {/* 玻璃拟态卡片 */}
          <View style={styles.authCard}>
            <View style={styles.authMode}>
              <Pressable style={[styles.authModeBtn, mode === 'login' ? styles.authModeBtnActive : null]} onPress={() => setMode('login')}>
                <Text style={[styles.authModeLabel, mode === 'login' ? styles.authModeLabelActive : null, bodyMedium]}>登录</Text>
              </Pressable>
              <Pressable style={[styles.authModeBtn, mode === 'register' ? styles.authModeBtnActive : null]} onPress={() => setMode('register')}>
                <Text style={[styles.authModeLabel, mode === 'register' ? styles.authModeLabelActive : null, bodyMedium]}>注册</Text>
              </Pressable>
            </View>

            <AuthInput icon="mail" placeholder="邮箱" value={email} onChange={setEmail} bodyFont={bodyFont} />
            <AuthInput icon="lock" placeholder="密码" value={password} onChange={setPassword} bodyFont={bodyFont} secureTextEntry />

            {error ? <Text style={[styles.authError, bodyFont]}>{error}</Text> : null}

            <Pressable onPress={onSubmit} disabled={busy}>
              <LinearGradient
                colors={['#0A0A0A', '#262626']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.authSubmit}
              >
                    {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={[styles.authSubmitLabel, bodyBold]}>{mode === 'register' ? '创建账号' : '进入TIANBO'}</Text>}
              </LinearGradient>
            </Pressable>

            <Text style={[styles.authHint, bodyFont]}>聊天、图片和复盘会按账号隔离保存。</Text>
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}
function IdentitySetupScreen({
  userName,
  setUserName,
  companionName,
  setCompanionName,
  companionGender,
  setCompanionGender,
  userBio,
  setUserBio,
  busy,
  onSubmit,
  allowCancel,
  onCancel,
  titleFont,
  bodyFont,
  bodyMedium,
  bodyBold,
}: {
  userName: string;
  setUserName: (value: string) => void;
  companionName: string;
  setCompanionName: (value: string) => void;
  companionGender: string;
  setCompanionGender: (value: string) => void;
  userBio: string;
  setUserBio: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
  allowCancel: boolean;
  onCancel: () => void;
  titleFont: FontStyle;
  bodyFont: FontStyle;
  bodyMedium: FontStyle;
  bodyBold: FontStyle;
}) {
  const partner = companionName.trim() || '贾维斯';
  const genderOptions = ['男', '女', '中性'];
  const onConfirmSubmit = () => {
    if (busy) return;
    Keyboard.dismiss();
    requestAnimationFrame(() => onSubmit());
  };
  
  // 淡入动画
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <View style={styles.identityRoot}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.identitySafe}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 18 : 0}
        >
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.identityScrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
            <Animated.View style={[styles.identityContentWrap, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
              {/* 品牌标识 */}
              <View style={styles.identityLogoWrap}>
                <LinearGradient
                  colors={['#0A0A0A', '#262626']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.identityLogo}
                >
                  {/* 机械感机器人图标 */}
                  <View style={styles.robotIcon}>
                    <View style={styles.robotHead}>
                      <View style={styles.robotEye} />
                      <View style={styles.robotEye} />
                    </View>
                    <View style={styles.robotMouth} />
                  </View>
                </LinearGradient>
                <Text style={[styles.identityBrand, titleFont]}>{allowCancel ? '资料设置' : '首次设定'}</Text>
                <Text style={[styles.identitySub, bodyMedium]}>{allowCancel ? '修改后将立即生效' : '完成设定后，你的伙伴就正式上线啦'}</Text>
              </View>

              <View style={styles.identityCard}>
                {allowCancel ? (
                  <Pressable style={styles.identityBackBtn} onPress={onCancel}>
                    <RobotIcon name="back" size={14} color="#FF6B35" />
                    <Text style={[styles.identityBackLabel, bodyFont]}>返回聊天</Text>
                  </Pressable>
                ) : null}
                <Text style={[styles.identityTitle, bodyBold]}>先给你的伙伴取个名字</Text>
                <AuthInput icon="sparkles" placeholder="推荐：贾维斯" value={companionName} onChange={setCompanionName} bodyFont={bodyFont} />

                <Text style={[styles.identityTitle, bodyBold]}>Ta 的性别设定</Text>
                <View style={styles.identityOptionRow}>
                  {genderOptions.map((option) => {
                    const active = (companionGender || '中性') === option;
                    return (
                      <Pressable
                        key={option}
                        style={[styles.identityOptionChip, active ? styles.identityOptionChipActive : null]}
                        onPress={() => setCompanionGender(option)}
                        disabled={busy}
                      >
                        <Text style={[styles.identityOptionChipText, bodyFont, active ? styles.identityOptionChipTextActive : null]}>{option}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={[styles.identityBubble, { backgroundColor: '#FFF4EF', borderColor: '#FF6B35' }]}>
                  <Text style={[styles.identityBubbleText, bodyFont]}>
                    {`你好，我是${partner}。我想更了解你：希望我怎么称呼你？也请介绍一下你自己。`}
                  </Text>
                </View>

                <Text style={[styles.identityTitle, bodyBold]}>你希望我怎么称呼你？</Text>
                <AuthInput icon="profile" placeholder="比如：阿森 / 小雨" value={userName} onChange={setUserName} bodyFont={bodyFont} />

                <Text style={[styles.identityTitle, bodyBold]}>再介绍一下你自己（可选）</Text>
                <TextInput
                  value={userBio}
                  onChangeText={setUserBio}
                  multiline
                  placeholder="比如：我现在最想提升执行力，容易拖延…"
                  placeholderTextColor="#A3A3A3"
                  style={[styles.identityBioInput, bodyFont]}
                />

                <Text style={[styles.identityHint, bodyFont]}>这个名字会被长期记住，后续聊天都会使用这个身份。</Text>

                <Pressable onPress={onConfirmSubmit} disabled={busy}>
                  <LinearGradient
                    colors={['#0A0A0A', '#262626']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.identitySubmit}
                  >
                    {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={[styles.identitySubmitLabel, bodyBold]}>确认并开始</Text>}
                  </LinearGradient>
                </Pressable>
              </View>
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

// 消息气泡组件 - 带头像
const MessageBubble = memo(function MessageBubble({ 
  msg, 
  isNew,
  selectionMode,
  selected,
  onPress,
  onLongPress,
  colors, 
  bodyFont, 
  isDark,
  userAvatarUrl
}: { 
  msg: ChatMessage; 
  isNew: boolean;
  selectionMode: boolean;
  selected: boolean;
  onPress: (messageId: string) => void;
  onLongPress: (messageId: string) => void;
  colors: Colors; 
  bodyFont: FontStyle; 
  isDark: boolean;
  userAvatarUrl?: string;
}) {
  const fadeAnim = useRef(new Animated.Value(isNew ? 0 : 1)).current;
  const parsedMessage = parseQuotedMessageText(msg.text || '');
  const renderedText = parsedMessage.body || msg.text;

  useEffect(() => {
    if (isNew) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [isNew]);

  const isAi = msg.role === 'assistant';
  
  const bubbleContent = (
    <>
      {parsedMessage.quote ? (
        <View style={[styles.msgQuoteBlock, isAi ? styles.msgQuoteBlockAi : styles.msgQuoteBlockUser]}>
          <Text style={[styles.msgQuoteLabel, bodyFont, isAi ? styles.msgQuoteLabelAi : styles.msgQuoteLabelUser]}>
            回复{parsedMessage.quote.role === 'assistant' ? 'AI' : '我'}
          </Text>
          <Text
            numberOfLines={2}
            style={[styles.msgQuoteText, bodyFont, isAi ? styles.msgQuoteTextAi : styles.msgQuoteTextUser]}
          >
            {parsedMessage.quote.text}
          </Text>
        </View>
      ) : null}
      {msg.imageUri ? <Image source={{ uri: msg.imageUri }} style={styles.msgImage} /> : null}
      <Text style={[styles.msgText, isAi ? styles.aiText : styles.userText, bodyFont]}>{renderedText}</Text>
      <Text style={[styles.msgTime, isAi ? styles.aiTime : styles.userTime, bodyFont]}>
        {formatClock(msg.createdAt)}
      </Text>
    </>
  );

  // AI头像 - 机器人图标
  const aiAvatar = (
    <View style={styles.avatarContainer}>
      <View style={styles.aiAvatar}>
        <View style={styles.avatarRobotIcon}>
          <View style={styles.avatarRobotHead}>
            <View style={styles.avatarRobotEye} />
            <View style={styles.avatarRobotEye} />
          </View>
          <View style={styles.avatarRobotMouth} />
        </View>
      </View>
    </View>
  );

  // 用户头像
  const userAvatar = (
    <View style={styles.avatarContainer}>
      {userAvatarUrl ? (
        <Image source={{ uri: userAvatarUrl }} style={styles.userAvatarImage} />
      ) : (
        <View style={styles.defaultUserAvatar}>
          <RobotIcon name="profile" size={16} color="#FF6B35" />
        </View>
      )}
    </View>
  );

  const selectionMarker = selectionMode ? (
    <View style={[styles.msgSelectMark, selected ? styles.msgSelectMarkActive : null]}>
      {selected ? <View style={styles.msgSelectMarkDot} /> : null}
    </View>
  ) : null;

  return (
    <Pressable onPress={() => onPress(msg.id)} onLongPress={() => onLongPress(msg.id)} delayLongPress={260}>
      <Animated.View
        style={[
          styles.msgRowWithAvatar,
          isAi ? styles.left : styles.right,
          { opacity: fadeAnim },
        ]}
      >
        {isAi ? (
          <>
            {selectionMarker}
            {aiAvatar}
            <View style={selected ? styles.msgBubbleSelectedWrap : null}>
              <LinearGradient
                colors={isDark ? ['#1A1A1A', '#0A0A0A'] : ['#0A0A0A', '#262626']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.msgBubble, styles.aiBubble]}
              >
                {bubbleContent}
              </LinearGradient>
            </View>
          </>
        ) : (
          <>
            <View
              style={[
                styles.msgBubble,
                styles.userBubble,
                {
                  backgroundColor: colors.surface,
                  borderColor: selected ? '#FF6B35' : colors.border,
                },
              ]}
            >
              {bubbleContent}
            </View>
            {userAvatar}
            {selectionMarker}
          </>
        )}
      </Animated.View>
    </Pressable>
  );
});

function AuthInput({
  icon,
  placeholder,
  value,
  onChange,
  bodyFont,
  secureTextEntry,
}: {
  icon: RobotIconName;
  placeholder: string;
  value: string;
  onChange: (text: string) => void;
  bodyFont: FontStyle;
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.authInputWrap}>
      <RobotIcon name={icon} size={16} color="#FF6B35" />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#64748B"
        style={[styles.authInput, bodyFont]}
        autoCapitalize="none"
        secureTextEntry={secureTextEntry}
      />
    </View>
  );
}

function ProfileRow({
  label,
  value,
  font,
  colors,
}: {
  label: string;
  value: string;
  font: FontStyle;
  colors: Colors;
}) {
  return (
    <View style={[styles.profileRow, { borderBottomColor: colors.borderLight }]}>
      <Text style={[styles.profileRowLabel, font, { color: colors.textTertiary }]}>{label}</Text>
      <Text style={[styles.profileRowValue, font, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

function RecapFilterButton({
  label,
  active,
  onPress,
  font,
  isDark,
  colors,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  font: FontStyle;
  isDark: boolean;
  colors: Colors;
}) {
  return (
    <Pressable 
      style={[
        styles.recapFilterBtn, 
        active ? styles.recapFilterBtnActive : null,
        active && { backgroundColor: colors.surface }
      ]} 
      onPress={onPress}
    >
      {active ? (
        <LinearGradient
          colors={['#0A0A0A', '#262626']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.recapFilterGradient}
        >
          <Text style={[styles.recapFilterLabelActive, font]}>{label}</Text>
        </LinearGradient>
      ) : (
        <Text style={[styles.recapFilterLabel, { color: colors.textSecondary }, font]}>{label}</Text>
      )}
    </Pressable>
  );
}

// 复盘卡片组件
function RecapCard({ 
  item, 
  colors, 
  bodyFont, 
  bodyBold, 
  isDark 
}: { 
  item: PeriodicRecap; 
  colors: Colors; 
  bodyFont: FontStyle;
  bodyBold: FontStyle;
  isDark: boolean;
}) {
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View style={{ opacity: fadeAnim }}>
      <View style={[styles.recapCard, { 
        backgroundColor: colors.surface, 
        borderColor: colors.border 
      }]}>
        <LinearGradient
          colors={isDark ? ['#1A1A1A', '#0A0A0A'] : ['#FAFAFA', '#F5F5F5']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.recapHead}
        >
          <Text style={[styles.recapLabel, bodyBold, { color: colors.textPrimary }]}>{item.label}</Text>
          <Text style={[styles.recapMeta, bodyFont, { color: colors.textTertiary }]}>
            {item.startDate === item.endDate ? item.startDate : `${item.startDate} - ${item.endDate}`}
          </Text>
        </LinearGradient>
        <RecapList title="这一天干了什么" items={[item.summary]} font={bodyFont} colors={colors} />
        <RecapList title="重要的事" items={item.highlights} font={bodyFont} colors={colors} />
        <RecapList title="要做的事情" items={item.actions} font={bodyFont} colors={colors} />
        <RecapList title="里程碑" items={item.milestones || []} font={bodyFont} colors={colors} />
        <RecapList title="有哪些成长" items={item.growths || []} font={bodyFont} colors={colors} />
      </View>
    </Animated.View>
  );
}

function RecapList({ title, items, font, colors }: { title: string; items: string[]; font: FontStyle; colors: Colors }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.recapSection}>
      <Text style={[styles.recapSectionTitle, font]}>{title}</Text>
      {items.map((item) => (
        <Text key={`${title}-${item}`} style={[styles.recapItem, font, { color: colors.textPrimary }]}>
          • {item}
        </Text>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5F5F7' },

  authRoot: { flex: 1, backgroundColor: '#FFFFFF' },
  authSafe: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 20 },
  // 品牌区域
  authBrandWrap: { alignItems: 'center', marginBottom: 8 },
  authLogo: { 
    width: 72, 
    height: 72, 
    borderRadius: 36, 
    backgroundColor: '#FFFFFF', 
    alignItems: 'center', 
    justifyContent: 'center',
    marginBottom: 16,
    shadowColor: '#FF6B35',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    borderWidth: 2,
    borderColor: '#FF6B35',
  },
  // 机械感机器人图标
  robotIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  robotHead: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6,
  },
  robotEye: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: '#FF6B35',
  },
  robotMouth: {
    width: 20,
    height: 4,
    borderRadius: 1,
    backgroundColor: '#FF6B35',
  },
  authBrand: { fontSize: 32, color: '#0A0A0A', textAlign: 'center', letterSpacing: 0.5, fontWeight: '700' },
  authTagline: { fontSize: 14, color: '#525252', textAlign: 'center', letterSpacing: 0.3, marginTop: 8 },
  authTaglineSub: { fontSize: 12, color: '#A3A3A3', textAlign: 'center', marginTop: 6, marginBottom: 28 },
  // 玻璃拟态卡片
  authCard: {
    borderRadius: 28,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    padding: 22,
    gap: 14,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  authMode: { flexDirection: 'row', backgroundColor: '#F5F5F5', borderRadius: 16, padding: 4, gap: 4 },
  authModeBtn: { flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  authModeBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#FF6B35',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  authModeLabel: { color: '#525252', fontSize: 14 },
  authModeLabelActive: { color: '#FF6B35', fontWeight: '600' },
  // 输入框 - 玻璃质感
  authInputWrap: {
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#E5E5E5',
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 14,
    paddingVertical: 0,
    height: 52,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  authInput: {
    flex: 1,
    color: '#2D3436',
    fontSize: 15,
    lineHeight: 20,
    paddingVertical: 0,
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  authError: { color: '#E17055', fontSize: 12, marginLeft: 2 },
  // 强调色按钮
  authSubmit: { 
    borderRadius: 16, 
    alignItems: 'center', 
    justifyContent: 'center', 
    height: 54, 
    backgroundColor: '#0A0A0A',
    shadowColor: '#FF6B35',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  authSubmitLabel: { color: '#FFFFFF', fontSize: 16, letterSpacing: 0.5, fontWeight: '600' },
  authHint: { fontSize: 12, color: '#A3A3A3', lineHeight: 18, textAlign: 'center' },

  identityRoot: { flex: 1, backgroundColor: '#FFFFFF' },
  identitySafe: { flex: 1, paddingHorizontal: 24 },
  identityScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingTop: 12,
    paddingBottom: 24,
  },
  identityContentWrap: {
    width: '100%',
  },
  // 品牌标识
  identityLogoWrap: { alignItems: 'center', marginBottom: 20 },
  identityLogo: { 
    width: 64, 
    height: 64, 
    borderRadius: 32, 
    backgroundColor: '#FFFFFF', 
    alignItems: 'center', 
    justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#FF6B35',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
    borderWidth: 2,
    borderColor: '#FF6B35',
  },
  identityBrand: { fontSize: 36, color: '#0A0A0A', textAlign: 'center', marginBottom: 6, fontWeight: '700' },
  identitySub: { fontSize: 14, color: '#525252', textAlign: 'center', marginBottom: 24 },
  // 玻璃卡片
  identityCard: {
    borderRadius: 28,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    padding: 20,
    gap: 12,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  identityTitle: { fontSize: 15, color: '#0A0A0A', marginTop: 4, marginBottom: 8, fontWeight: '600' },
  identityHint: { fontSize: 12, color: '#A3A3A3', lineHeight: 18 },
  identityOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  identityOptionChip: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#D4D4D4',
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  identityOptionChipActive: {
    borderColor: '#FF6B35',
    backgroundColor: '#FFF4EF',
  },
  identityOptionChipText: {
    fontSize: 13,
    color: '#525252',
  },
  identityOptionChipTextActive: {
    color: '#FF6B35',
    fontWeight: '700',
  },
  // 伙伴对话气泡 - 橙色系
  identityBubble: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  identityBubbleText: { fontSize: 14, lineHeight: 20, color: '#0A0A0A' },
  // 输入框
  identityBioInput: {
    minHeight: 100,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#E5E5E5',
    backgroundColor: '#FAFAFA',
    color: '#0A0A0A',
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  // 强调色按钮
  identitySubmit: { 
    borderRadius: 16, 
    alignItems: 'center', 
    justifyContent: 'center', 
    height: 50, 
    marginTop: 6,
    backgroundColor: '#0A0A0A',
    shadowColor: '#FF6B35',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  identitySubmitLabel: { color: '#FFFFFF', fontSize: 15, letterSpacing: 0.5, fontWeight: '600' },
  identityBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginBottom: 6,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  identityBackLabel: { fontSize: 12, color: '#0A0A0A' },
  identitySecondaryAction: {
    marginTop: 2,
    marginBottom: 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    backgroundColor: '#FAFAFA',
  },
  identitySecondaryActionLabel: { fontSize: 13, color: '#525252' },

  flex: { flex: 1 },
  homeScreen: {
    flex: 1,
  },
  homeTopNav: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 6,
    marginBottom: 12,
  },
  homeNavItem: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  homeNavLabel: { fontSize: 14, fontWeight: '600' },
  homeCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingTop: 74,
  },
  homeTitle: { fontSize: 24, lineHeight: 32, textAlign: 'center', marginBottom: 8 },
  homeDesc: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  chatTopBar: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: 6,
    marginBottom: 6,
  },
  chatTopSimple: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chatTopTitle: { fontSize: 18, fontWeight: '700' },
  chatTopCopyBtn: {
    minWidth: 72,
    height: 32,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#FF6B35',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  chatTopDangerBtn: {
    borderColor: '#FCA5A5',
  },
  chatTopCopyText: { fontSize: 12, fontWeight: '700' },
  chatSelectionBar: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  chatSelectionCount: {
    fontSize: 14,
  },
  chatSelectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chatSelectionBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D4D4D4',
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatSelectionBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  chatTopRight: {
    flexDirection: 'row',
    gap: 8,
  },
  chatStage: { flex: 1, position: 'relative' },
  chatList: { gap: 8, paddingTop: 2, paddingHorizontal: 4 },
  emptyChatState: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 },
  emptyChatIcon: { 
    width: 72, 
    height: 72, 
    borderRadius: 36, 
    backgroundColor: '#FFFFFF', 
    alignItems: 'center', 
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 2,
    borderColor: '#FF6B35',
  },
  emptyChatTitle: { fontSize: 18, color: '#0A0A0A', marginBottom: 8, textAlign: 'center', fontWeight: '600' },
  emptyChatDesc: { fontSize: 14, color: '#525252', textAlign: 'center', lineHeight: 21 },
  msgRow: { flexDirection: 'row' },
  msgRowWithAvatar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  msgSelectMark: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.2,
    borderColor: '#C4C4C4',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  msgSelectMarkActive: {
    borderColor: '#FF6B35',
    backgroundColor: '#FFF4EF',
  },
  msgSelectMarkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FF6B35',
  },
  msgBubbleSelectedWrap: {
    borderWidth: 1.2,
    borderColor: '#FF6B35',
    borderRadius: 21,
  },
  left: { justifyContent: 'flex-start' },
  right: { justifyContent: 'flex-end' },
  // 头像样式
  avatarContainer: {
    marginBottom: 4,
  },
  aiAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#0A0A0A',
  },
  avatarRobotIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarRobotHead: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 2,
  },
  avatarRobotEye: {
    width: 5,
    height: 5,
    borderRadius: 1,
    backgroundColor: '#FF6B35',
  },
  avatarRobotMouth: {
    width: 10,
    height: 2,
    borderRadius: 0.5,
    backgroundColor: '#FF6B35',
  },
  userAvatarImage: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E5E5E5',
  },
  defaultUserAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.2,
    borderColor: '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  msgBubble: { maxWidth: '80%', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  // AI气泡 - 暖灰渐变感
  aiBubble: {
    backgroundColor: '#2D3436',
    borderTopLeftRadius: 8,
    shadowColor: '#2D3436',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  // 用户气泡 - 白色带微妙阴影
  userBubble: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8E8E8',
    borderTopRightRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  msgImage: { width: 168, height: 168, borderRadius: 14, marginBottom: 8 },
  msgQuoteBlock: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  msgQuoteBlockAi: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderColor: 'rgba(255,255,255,0.22)',
  },
  msgQuoteBlockUser: {
    backgroundColor: '#FFF4EF',
    borderColor: '#FFD7C6',
  },
  msgQuoteLabel: {
    fontSize: 11,
    marginBottom: 2,
  },
  msgQuoteLabelAi: { color: '#FFD7C6' },
  msgQuoteLabelUser: { color: '#FF6B35' },
  msgQuoteText: {
    fontSize: 12,
    lineHeight: 17,
  },
  msgQuoteTextAi: { color: '#F9FAFB' },
  msgQuoteTextUser: { color: '#525252' },
  msgText: { fontSize: 15, lineHeight: 22 },
  msgTime: { marginTop: 6, fontSize: 11 },
  aiText: { color: '#FFFFFF' },
  userText: { color: '#2D3436' },
  aiTime: { color: '#B2BEC3' },
  userTime: { color: '#B2BEC3' },

  // 输入区域：底部常驻 + 键盘弹层
  composerDockClosed: {
    position: 'absolute',
    left: 2,
    right: 2,
    bottom: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E8E8E8',
    padding: 10,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  composerDockRaised: {
    bottom: 42,
  },
  quoteDraftBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FFD7C6',
    backgroundColor: '#FFF4EF',
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
    gap: 8,
  },
  quoteDraftTextWrap: { flex: 1, gap: 2 },
  quoteDraftLabel: { fontSize: 12, fontWeight: '700' },
  quoteDraftText: { fontSize: 12, lineHeight: 16 },
  quoteDraftCloseBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FFB899',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  quoteDraftCloseText: { fontSize: 11, color: '#FF6B35', fontWeight: '700' },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 42,
    borderWidth: 1.5,
    color: '#2D3436',
    fontSize: 15,
    lineHeight: 21,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  iconBlack: { 
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFFFFF', 
    borderWidth: 1.2,
    borderColor: '#FF6B35',
    alignItems: 'center', 
    justifyContent: 'center',
    shadowColor: '#FF6B35',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  iconSoft: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.1,
    borderColor: '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPressed: { transform: [{ scale: 0.92 }], opacity: 0.8 },
  iconDisabled: { backgroundColor: '#F3F4F6', borderColor: '#D4D4D8' },
  opacityWeak: { opacity: 0.7 },
  notice: { marginTop: 8, fontSize: 12, color: '#FF6B35', textAlign: 'center', backgroundColor: '#FFF4EF', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  profileContainer: { paddingHorizontal: 16, paddingBottom: 20, gap: 12 },
  profileCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  profileAvatarWrap: {
    width: 90,
    height: 90,
    borderRadius: 45,
    alignSelf: 'center',
    marginBottom: 10,
  },
  profileAvatarImage: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#E5E5E5',
  },
  profileAvatarPlaceholder: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileAvatarBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FF6B35',
  },
  profileName: { fontSize: 18, textAlign: 'center', marginBottom: 4, fontWeight: '600' },
  profileEmail: { fontSize: 12, textAlign: 'center', marginBottom: 10 },
  profilePrimaryAction: {
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
  },
  profilePrimaryActionLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  profileSecondaryAction: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
  },
  profileSecondaryActionLabel: { fontSize: 14, fontWeight: '500' },
  profileRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
  },
  profileRowLabel: { fontSize: 12, marginBottom: 4 },
  profileRowValue: { fontSize: 14, lineHeight: 20 },
  profileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  profileActionIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileActionLabel: { fontSize: 14 },
  recapTopBar: {
    minHeight: 44,
    paddingHorizontal: 8,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  recapTopTitle: { fontSize: 17, color: '#0A0A0A', fontWeight: '600' },
  recapTopSpacer: { width: 30, height: 30 },

  recapContainer: { paddingBottom: 20, paddingHorizontal: 16 },
  recapFilters: { 
    flexDirection: 'row', 
    gap: 8, 
    marginBottom: 16, 
    backgroundColor: '#F5F5F5',
    padding: 4,
    borderRadius: 12,
  },
  recapFilterBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  recapFilterBtnActive: { 
    backgroundColor: '#FFFFFF',
    shadowColor: '#FF6B35',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  recapFilterGradient: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  recapFilterLabel: { fontSize: 13, color: '#525252', fontWeight: '500' },
  recapFilterLabelActive: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  emptyText: { marginTop: 40, color: '#A3A3A3', fontSize: 14, textAlign: 'center' },
  // 复盘卡片 - 日记风格
  recapCard: {
    marginTop: 0,
    marginBottom: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  // 卡片头部 - 带日期
  recapHead: { 
    backgroundColor: '#FAFAFA', 
    borderBottomWidth: 1, 
    borderBottomColor: '#E5E5E5', 
    paddingHorizontal: 16, 
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  recapLabel: { fontSize: 16, color: '#0A0A0A', fontWeight: '600' },
  recapMeta: { fontSize: 12, color: '#A3A3A3' },
  // 卡片内容区
  recapSection: { marginTop: 14, marginHorizontal: 16, marginBottom: 8 },
  recapSectionTitle: { 
    fontSize: 12, 
    color: '#FF6B35', 
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  recapItem: { 
    fontSize: 14, 
    color: '#0A0A0A', 
    marginTop: 6, 
    lineHeight: 20,
    paddingLeft: 4,
  },
});

