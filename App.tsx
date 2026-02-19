import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import {
  PlayfairDisplay_700Bold,
  useFonts as useTitleFonts,
} from '@expo-google-fonts/playfair-display';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_700Bold,
  useFonts as useBodyFonts,
} from '@expo-google-fonts/space-grotesk';
import { buildJournalRecordedReply, generateCoachReply } from './src/lib/assistant';
import {
  authLogin,
  authMe,
  authRegister,
  AuthUser,
  fetchIdentity,
  fetchHistory,
  getApiBaseUrl,
  requestAssistantReply,
  saveIdentityRemote,
} from './src/lib/api';
import { formatClock, toDateKey, toWeekLabel } from './src/lib/date';
import {
  categoryLabel,
  extractFacts,
  findRelevantFacts,
  mergeFacts,
  upsertWeeklyDigest,
} from './src/lib/memoryEngine';
import { buildPeriodicRecaps, buildRolloverPrompt } from './src/lib/recapEngine';
import { IdentityProfile, loadIdentity, saveIdentity } from './src/lib/identity';
import { clearSession, loadSession, saveSession } from './src/lib/session';
import { loadAppState, saveAppState } from './src/lib/storage';
import { AppState, ChatMessage, DailyJournal, MemoryFact, RecapPeriod, TaskItem } from './src/types';

type TabKey = 'chat' | 'journal' | 'memory' | 'recap';
type AuthMode = 'login' | 'register';

interface PickedImage {
  uri: string;
  mimeType: string;
  dataUrl: string;
}

interface AuthSession {
  token: string;
  user: AuthUser;
}

const moodOptions = [
  { score: 1, label: '浣庤惤' },
  { score: 2, label: '一般' },
  { score: 3, label: '绋冲畾' },
  { score: 4, label: '绉瀬' },
  { score: 5, label: '浜㈠' },
];

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function defaultState(): AppState {
  return {
    messages: [
      {
        id: createId('msg'),
        role: 'assistant',
        text: '欢迎来到 GrowUp。登录后我会帮你长期保存聊天和图片记录。',
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

function makeDraft(dateKey: string): DailyJournal {
  return {
    id: createId('journal'),
    dateKey,
    mood: 3,
    wins: '',
    lessons: '',
    focus: '',
    gratitude: '',
  };
}

function upsertJournal(journals: DailyJournal[], item: DailyJournal): DailyJournal[] {
  const index = journals.findIndex((journal) => journal.dateKey === item.dateKey);
  if (index < 0) return [...journals, item].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const next = [...journals];
  next[index] = { ...item, id: journals[index].id };
  return next;
}

function summary(journal: DailyJournal): string {
  return [journal.focus, journal.wins, journal.lessons, journal.gratitude].filter(Boolean).join('；').slice(0, 240);
}

function factColor(fact: MemoryFact): string {
  if (fact.category === 'goal') return '#1D4ED8';
  if (fact.category === 'habit') return '#15803D';
  if (fact.category === 'identity') return '#C2410C';
  if (fact.category === 'relationship') return '#BE185D';
  if (fact.category === 'preference') return '#6D28D9';
  return '#B91C1C';
}

interface TaskBoardStats {
  yesterdayDone: number;
  weekDone: number;
  monthDone: number;
  yearDone: number;
}

function parseDateKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00`);
}

function toMonthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

function toYearKey(dateKey: string): string {
  return dateKey.slice(0, 4);
}

function previousDateKey(dateKey: string): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() - 1);
  return toDateKey(date);
}

function buildTaskBoardStats(tasks: TaskItem[], todayDateKey: string): TaskBoardStats {
  const yesterdayKey = previousDateKey(todayDateKey);
  const weekLabel = toWeekLabel(parseDateKey(todayDateKey));
  const monthKey = toMonthKey(todayDateKey);
  const yearKey = toYearKey(todayDateKey);
  const done = tasks.filter((item) => item.done);
  return {
    yesterdayDone: done.filter((item) => item.dateKey === yesterdayKey).length,
    weekDone: done.filter((item) => toWeekLabel(parseDateKey(item.dateKey)) === weekLabel).length,
    monthDone: done.filter((item) => toMonthKey(item.dateKey) === monthKey).length,
    yearDone: done.filter((item) => toYearKey(item.dateKey) === yearKey).length,
  };
}

function buildTaskInsight(tasks: TaskItem[], stats: TaskBoardStats): { solved: string; next: string; cheer: string } {
  const done = tasks.filter((item) => item.done).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = tasks.filter((item) => !item.done).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const solved =
    done.length > 0
      ? `最近完成：${done.slice(0, 3).map((item) => `「${item.title}」`).join('、')}。`
      : '最近还没有已完成任务，先完成一个最小任务建立节奏。';
  const next = pending.length > 0 ? `下一步建议：优先推进「${pending[0].title}」。` : '下一步建议：创建一个可在今天完成的具体任务。';
  const cheer =
    stats.weekDone >= 7
      ? '这周执行力很强，保持这个节奏。'
      : stats.weekDone >= 3
      ? '这周推进稳定，再加一到两个关键任务会更好。'
      : '先把本周最重要的一件事做完，完成感会明显提升。';
  return { solved, next, cheer };
}

export default function App() {
  const [titleLoaded] = useTitleFonts({ PlayfairDisplay_700Bold });
  const [bodyLoaded] = useBodyFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
  });

  const [tab, setTab] = useState<TabKey>('chat');
  const [state, setState] = useState<AppState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [selectedImage, setSelectedImage] = useState<PickedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [identity, setIdentity] = useState<IdentityProfile | null>(null);
  const [identityUserName, setIdentityUserName] = useState('');
  const [identityCompanionName, setIdentityCompanionName] = useState('贾维斯');
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityUserBio, setIdentityUserBio] = useState('');
  const [recapPeriod, setRecapPeriod] = useState<RecapPeriod>('day');
  const [taskEditorOpen, setTaskEditorOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskImage, setTaskImage] = useState<PickedImage | null>(null);
  const [taskAnalyzing, setTaskAnalyzing] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskAiSummary, setTaskAiSummary] = useState('');
  const [taskAiBusy, setTaskAiBusy] = useState(false);
  const taskAiSignatureRef = useRef('');
  const todayKey = toDateKey();
  const todayJournal = useMemo(
    () => state.journals.find((item) => item.dateKey === todayKey) ?? null,
    [state.journals, todayKey],
  );
  const [draft, setDraft] = useState<DailyJournal>(makeDraft(todayKey));

  useEffect(() => {
    let alive = true;
    (async () => {
      const [savedAppState, savedSession] = await Promise.all([loadAppState(), loadSession()]);
      if (!alive) return;

      if (savedAppState) {
        const normalized: AppState = {
          ...defaultState(),
          ...savedAppState,
          recaps:
            Array.isArray(savedAppState.recaps) && savedAppState.recaps.length > 0
              ? savedAppState.recaps
              : buildPeriodicRecaps(savedAppState.journals || []),
          lastRolloverDate:
            typeof savedAppState.lastRolloverDate === 'string' && savedAppState.lastRolloverDate
              ? savedAppState.lastRolloverDate
              : toDateKey(),
        };
        setState(normalized);
      }

      if (savedSession) {
        try {
          const refreshed = await authMe(savedSession.token);
          if (!alive) return;
          const nextSession: AuthSession = { token: refreshed.token, user: refreshed.user };
          setAuthSession(nextSession);
          await saveSession(nextSession);
          await loadOrInitIdentity(nextSession.user, nextSession.token);
          if (!alive) return;
          const messages = await fetchHistory(nextSession.token, 180);
          if (!alive) return;
          if (messages.length > 0) {
            setState((prev) => ({ ...prev, messages }));
          }
        } catch {
          await clearSession();
          if (alive) {
            setIdentity(null);
          }
        }
      }

      setHydrated(true);
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveAppState(state).catch(() => undefined);
  }, [state, hydrated]);

  useEffect(() => {
    if (todayJournal) setDraft(todayJournal);
    else setDraft(makeDraft(todayKey));
  }, [todayJournal, todayKey]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!hydrated || !identity?.ready) return;
    setState((prev) => {
      if (prev.lastRolloverDate === todayKey) return prev;
      const rolloverMessage: ChatMessage = {
        id: createId('rollover'),
        role: 'assistant',
        text: buildRolloverPrompt(identity.companionName, prev.recaps),
        createdAt: new Date().toISOString(),
      };
      return {
        ...prev,
        lastRolloverDate: todayKey,
        messages: [...prev.messages, rolloverMessage].slice(-240),
      };
    });
  }, [hydrated, identity?.ready, identity?.companionName, todayKey]);

  const metrics = useMemo(
    () => ({
      facts: state.facts.length,
      journals: state.journals.length,
      recaps: state.recaps.length,
      focus: todayJournal?.focus || '鍏堝畾涔変粖澶╂渶閲嶈鐨勪竴浠朵簨',
    }),
    [state.facts.length, state.journals.length, state.recaps.length, todayJournal],
  );

  const visibleRecaps = useMemo(
    () => state.recaps.filter((item) => item.period === recapPeriod).slice(0, 24),
    [state.recaps, recapPeriod],
  );
  const todayTasks = useMemo(
    () => state.tasks.filter((item) => item.dateKey === todayKey).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.tasks, todayKey],
  );
  const taskBoardStats = useMemo(() => buildTaskBoardStats(state.tasks, todayKey), [state.tasks, todayKey]);
  const taskInsight = useMemo(() => buildTaskInsight(state.tasks, taskBoardStats), [state.tasks, taskBoardStats]);

  useEffect(() => {
    if (!authSession || !identity?.ready) return;

    const doneTitles = state.tasks.filter((item) => item.done).map((item) => item.title);
    const pendingTitles = state.tasks.filter((item) => !item.done).map((item) => item.title);
    const signature = `${todayKey}|${doneTitles.join('|')}|${pendingTitles.join('|')}`;
    if (taskAiSignatureRef.current === signature) return;
    taskAiSignatureRef.current = signature;

    if (doneTitles.length === 0 && pendingTitles.length === 0) {
      setTaskAiSummary('先创建今天的第一个任务，我会根据你的完成情况给你复盘建议。');
      return;
    }

    let cancelled = false;
    (async () => {
      setTaskAiBusy(true);
      try {
        const result = await requestAssistantReply(
          {
            message: [
              '请你基于我的任务清单做一次简短复盘（3 行内）：',
              `昨天完成：${taskBoardStats.yesterdayDone}`,
              `本周完成：${taskBoardStats.weekDone}`,
              `本月完成：${taskBoardStats.monthDone}`,
              `今年完成：${taskBoardStats.yearDone}`,
              `最近完成任务：${doneTitles.slice(-8).join('；') || '暂无'}`,
              `未完成任务：${pendingTitles.slice(0, 6).join('；') || '暂无'}`,
              '请输出：1) 最近解决了什么问题 2) 当前节奏评价 3) 下一步最优先动作',
            ].join('\n'),
            relevantMemories: [],
            todayJournal,
            identity: {
              userName: identity.userName,
              companionName: identity.companionName,
              userBio: identity.userBio,
            },
          },
          authSession.token,
        );
        if (!cancelled) {
          setTaskAiSummary(result.reply.trim());
        }
      } catch {
        if (!cancelled) {
          setTaskAiSummary(`${taskInsight.solved}\n${taskInsight.next}`);
        }
      } finally {
        if (!cancelled) {
          setTaskAiBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authSession,
    identity,
    state.tasks,
    taskBoardStats.yesterdayDone,
    taskBoardStats.weekDone,
    taskBoardStats.monthDone,
    taskBoardStats.yearDone,
    taskInsight.solved,
    taskInsight.next,
    todayJournal,
    todayKey,
  ]);

  const bodyFont = { fontFamily: 'SpaceGrotesk_400Regular' as const };
  const bodyMedium = { fontFamily: 'SpaceGrotesk_500Medium' as const };
  const bodyBold = { fontFamily: 'SpaceGrotesk_700Bold' as const };
  const titleFont = { fontFamily: 'PlayfairDisplay_700Bold' as const };

  const inferUserName = (user: AuthUser): string => {
    if (user.name && user.name.trim()) return user.name.trim();
    if (user.email.includes('@')) return user.email.split('@')[0];
    return '鏈嬪弸';
  };

  const loadOrInitIdentity = async (user: AuthUser, token?: string): Promise<IdentityProfile> => {
    if (token) {
      try {
        const remote = await fetchIdentity(token);
        if (remote) {
          const synced: IdentityProfile = {
            userId: user.id,
            userName: remote.userName,
            companionName: remote.companionName,
            userBio: remote.userBio || '',
            ready: true,
          };
          setIdentity(synced);
          setIdentityUserName(synced.userName);
          setIdentityCompanionName(synced.companionName);
          setIdentityUserBio(synced.userBio);
          await saveIdentity(synced);
          return synced;
        }
      } catch {
        // ignore remote errors and fallback to local identity
      }
    }

    const loaded = await loadIdentity(user.id);
    if (loaded) {
      setIdentity(loaded);
      setIdentityUserName(loaded.userName || inferUserName(user));
      setIdentityCompanionName(loaded.companionName || '贾维斯');
      setIdentityUserBio(loaded.userBio || '');
      return loaded;
    }
    const created: IdentityProfile = {
      userId: user.id,
      userName: inferUserName(user),
      companionName: '贾维斯',
      userBio: '',
      ready: false,
    };
    setIdentity(created);
    setIdentityUserName(created.userName);
    setIdentityCompanionName(created.companionName);
    setIdentityUserBio(created.userBio);
    await saveIdentity(created);
    return created;
  };

  const loadCloudHistory = async (token: string) => {
    const messages = await fetchHistory(token, 180);
    if (messages.length === 0) return;
    setState((prev) => ({
      ...prev,
      messages,
    }));
  };

  const submitAuth = async () => {
    const email = authEmail.trim();
    const password = authPassword;
    const name = authName.trim();

    if (!email || !password) {
      setAuthError('璇疯緭鍏ラ偖绠卞拰瀵嗙爜');
      return;
    }
    if (authMode === 'register' && password.length < 6) {
      setAuthError('密码至少 6 位');
      return;
    }

    await Haptics.selectionAsync();
    setAuthBusy(true);
    setAuthError('');

    try {
      const result =
        authMode === 'register'
          ? await authRegister({ email, password, name })
          : await authLogin({ email, password });
      const session: AuthSession = { token: result.token, user: result.user };
      setAuthSession(session);
      await saveSession(session);
      await loadOrInitIdentity(session.user, session.token);
      await loadCloudHistory(session.token);
      setNotice('鐧诲綍鎴愬姛锛屼簯绔褰曞凡杩炴帴');
    } catch (error) {
      const message = error instanceof Error ? error.message : '鐧诲綍澶辫触';
      setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await clearSession();
    setAuthSession(null);
    setAuthPassword('');
    setAuthEmail('');
    setIdentity(null);
    setIdentityUserName('');
    setIdentityCompanionName('贾维斯');
    setIdentityUserBio('');
    setState(defaultState());
    setNotice('已退出登录');
  };

  const submitIdentity = async () => {
    if (!authSession) return;
    const userName = identityUserName.trim() || inferUserName(authSession.user);
    const companionName = identityCompanionName.trim() || '贾维斯';
    const userBio = identityUserBio.trim();
    if (!identity) return;

    setIdentityBusy(true);
    try {
      const next: IdentityProfile = {
        ...identity,
        userName,
        companionName,
        userBio,
        ready: true,
      };
      setIdentity(next);
      setIdentityUserName(next.userName);
      setIdentityCompanionName(next.companionName);
      setIdentityUserBio(next.userBio);
      await saveIdentity(next);
      if (authSession?.token) {
        await saveIdentityRemote(authSession.token, {
          userName: next.userName,
          companionName: next.companionName,
          userBio: next.userBio,
        });
      }

      const nowIso = new Date().toISOString();
      const assistantAsk: ChatMessage = {
        id: createId('identity-ask'),
        role: 'assistant',
        text: `你好，我是${companionName}。我想先了解你：希望我怎么称呼你？也可以介绍一下你自己。`,
        createdAt: nowIso,
      };
      const userIntroText = userBio
        ? `你可以叫我${userName}。我的自我介绍：${userBio}`
        : `你可以叫我${userName}。`;
      const userIntroMessage: ChatMessage = {
        id: createId('identity-user'),
        role: 'user',
        text: userIntroText,
        createdAt: nowIso,
      };
      const assistantAck: ChatMessage = {
        id: createId('identity-ack'),
        role: 'assistant',
        text: `记住了，${userName}。从今天开始我会像生活搭子一样陪你，每天一起复盘并推进重点。`,
        createdAt: nowIso,
      };
      const introFacts = extractFacts(`我叫${userName}。我的AI伙伴叫${companionName}。${userBio}`, nowIso);

      setState((prev) => ({
        ...prev,
        facts: mergeFacts(prev.facts, introFacts),
        messages: [...prev.messages, assistantAsk, userIntroMessage, assistantAck].slice(-240),
      }));
      setNotice(`设定完成：${companionName} 已上线`);
    } finally {
      setIdentityBusy(false);
    }
  };

  const pickImage = async () => {
    await Haptics.selectionAsync();
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice('请允许相册权限。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.72,
      base64: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset.base64) {
      setNotice('图片读取失败，请重试。');
      return;
    }
    const mimeType = asset.mimeType || 'image/jpeg';
    setSelectedImage({
      uri: asset.uri,
      mimeType,
      dataUrl: `data:${mimeType};base64,${asset.base64}`,
    });
  };

  const analyzeTaskFromImage = async (image: PickedImage) => {
    if (!authSession) return;
    setTaskAnalyzing(true);
    try {
      const result = await requestAssistantReply(
        {
          message: '请基于这张图片生成一个今天可执行的任务名，20字以内，只返回任务名称。',
          imageDataUrl: image.dataUrl,
          relevantMemories: [],
          todayJournal,
          identity: identity
            ? {
                userName: identity.userName,
                companionName: identity.companionName,
                userBio: identity.userBio,
              }
            : undefined,
        },
        authSession.token,
      );
      const parsed = result.reply.replace(/[\r\n]+/g, ' ').replace(/[。！!]/g, '').trim();
      if (parsed) {
        setTaskTitle(parsed.slice(0, 28));
      } else {
        setNotice('图片分析结果为空，请手动填写任务名');
      }
    } catch {
      setNotice('图片分析失败，请手动填写任务名');
    } finally {
      setTaskAnalyzing(false);
    }
  };

  const pickTaskImage = async (source: 'library' | 'camera') => {
    await Haptics.selectionAsync();
    if (source === 'library') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setNotice('请允许相册权限。');
        return;
      }
    } else {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setNotice('请允许相机权限。');
        return;
      }
    }

    const result =
      source === 'library'
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.72,
            base64: true,
          })
        : await ImagePicker.launchCameraAsync({
            quality: 0.72,
            base64: true,
          });

    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset.base64) {
      setNotice('图片读取失败，请重试。');
      return;
    }

    const mimeType = asset.mimeType || 'image/jpeg';
    const picked: PickedImage = {
      uri: asset.uri,
      mimeType,
      dataUrl: `data:${mimeType};base64,${asset.base64}`,
    };
    setTaskImage(picked);
    await analyzeTaskFromImage(picked);
  };

  const saveTask = async () => {
    const title = taskTitle.trim();
    if (!title) {
      setNotice('请填写任务名称');
      return;
    }

    setTaskSaving(true);
    try {
      const nextTask: TaskItem = {
        id: createId('task'),
        dateKey: todayKey,
        title,
        done: false,
        fromImage: Boolean(taskImage),
        createdAt: new Date().toISOString(),
      };
      setState((prev) => ({
        ...prev,
        tasks: [...prev.tasks, nextTask].slice(-240),
      }));
      setTaskTitle('');
      setTaskImage(null);
      setTaskEditorOpen(false);
      setNotice('任务已保存');
    } finally {
      setTaskSaving(false);
    }
  };

  const toggleTaskDone = (taskId: string) => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((item) => (item.id === taskId ? { ...item, done: !item.done } : item)),
    }));
  };

  const onSend = async () => {
    if (!authSession) {
      setNotice('请先登录后发送');
      return;
    }
    if (!identity || !identity.ready) {
      setNotice('先完成伙伴命名后再开始聊天');
      return;
    }

    const text = input.trim();
    if ((!text && !selectedImage) || busy) return;

    await Haptics.selectionAsync();
    setBusy(true);
    setInput('');

    const nowIso = new Date().toISOString();
    const userText = text || '请帮我分析这张图片，并给出成长建议。';
    const extracted = extractFacts(text, nowIso);
    const nextFacts = mergeFacts(state.facts, extracted);
    const relevant = findRelevantFacts(nextFacts, text || '鍥剧墖鍒嗘瀽', 5);

    const userMessage: ChatMessage = {
      id: createId('local-user'),
      role: 'user',
      text: text || '[鍥剧墖]',
      imageUri: selectedImage?.uri,
      imageMimeType: selectedImage?.mimeType,
      createdAt: nowIso,
    };

    setState((prev) => ({
      ...prev,
      facts: mergeFacts(prev.facts, extracted),
      messages: [...prev.messages, userMessage].slice(-240),
    }));

    try {
      const result = await requestAssistantReply(
        {
          message: userText,
          imageDataUrl: selectedImage?.dataUrl,
          relevantMemories: relevant.map((item) => `${categoryLabel(item.category)}: ${item.value}`),
          todayJournal,
          identity: {
            userName: identity.userName,
            companionName: identity.companionName,
            userBio: identity.userBio,
          },
        },
        authSession.token,
      );

      const assistantMessage: ChatMessage = {
        id: createId('local-assistant'),
        role: 'assistant',
        text: result.reply,
        createdAt: new Date().toISOString(),
      };

      setState((prev) => ({
        ...prev,
        facts: nextFacts,
        messages: [...prev.messages, assistantMessage].slice(-240),
      }));
    } catch (error) {
      const fallback = generateCoachReply(userText, relevant, todayJournal, identity || undefined);
      const assistantMessage: ChatMessage = {
        id: createId('fallback-assistant'),
        role: 'assistant',
        text: `${fallback}\n\n(鍚庣璋冪敤澶辫触锛屽凡鍥為€€鏈湴妯″紡)`,
        createdAt: new Date().toISOString(),
      };
      setState((prev) => ({
        ...prev,
        facts: nextFacts,
        messages: [...prev.messages, assistantMessage].slice(-240),
      }));
      setNotice(error instanceof Error ? error.message : '璇锋眰澶辫触');
    } finally {
      setSelectedImage(null);
      setBusy(false);
    }
  };

  const onSaveJournal = async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const clean: DailyJournal = {
      ...draft,
      wins: draft.wins.trim(),
      lessons: draft.lessons.trim(),
      focus: draft.focus.trim(),
      gratitude: draft.gratitude.trim(),
    };
    const nowIso = new Date().toISOString();
    const extracted = extractFacts(`${clean.focus}。${clean.wins}。${clean.lessons}。${clean.gratitude}`, nowIso);
    setState((prev) => {
      const journals = upsertJournal(prev.journals, clean);
      const digests = upsertWeeklyDigest(prev.digests, clean, nowIso);
      const facts = mergeFacts(prev.facts, extracted);
      const recaps = buildPeriodicRecaps(journals, nowIso);
      const assistantMessage: ChatMessage = {
        id: createId('journal-assistant'),
        role: 'assistant',
        text: buildJournalRecordedReply(summary(clean) || '日志已记录。'),
        createdAt: nowIso,
      };
      return {
        ...prev,
        journals,
        digests,
        recaps,
        facts,
        messages: [...prev.messages, assistantMessage].slice(-240),
      };
    });
    setTab('chat');
  };

  if (!titleLoaded || !bodyLoaded || !hydrated) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#0F172A" />
      </View>
    );
  }

  if (!authSession) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        name={authName}
        setName={setAuthName}
        email={authEmail}
        setEmail={setAuthEmail}
        password={authPassword}
        setPassword={setAuthPassword}
        busy={authBusy}
        error={authError}
        onSubmit={submitAuth}
        titleFont={titleFont}
        bodyFont={bodyFont}
        bodyMedium={bodyMedium}
        bodyBold={bodyBold}
      />
    );
  }

  if (!identity || !identity.ready) {
    return (
      <IdentitySetupScreen
        userName={identityUserName}
        setUserName={setIdentityUserName}
        companionName={identityCompanionName}
        setCompanionName={setIdentityCompanionName}
        userBio={identityUserBio}
        setUserBio={setIdentityUserBio}
        busy={identityBusy}
        onSubmit={submitIdentity}
        titleFont={titleFont}
        bodyFont={bodyFont}
        bodyMedium={bodyMedium}
        bodyBold={bodyBold}
      />
    );
  }

  return (
    <LinearGradient colors={['#FCEEDA', '#ECF7F1', '#EAF1FF']} style={styles.root}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View>
            <Text style={[styles.brand, titleFont]}>GrowUp</Text>
            <Text style={[styles.sub, bodyMedium]}>
              {identity?.ready ? `${identity.companionName} 陪跑中 · 云端同步已连接` : 'AI 记忆陪跑 · 云端同步已连接'}
            </Text>
          </View>
          <View style={styles.userWrap}>
            <Text style={[styles.userName, bodyMedium]} numberOfLines={1}>
              {authSession.user.name || authSession.user.email}
            </Text>
            <Pressable style={styles.logoutBtn} onPress={logout}>
              <Ionicons name="log-out-outline" size={16} color="#7F1D1D" />
            </Pressable>
          </View>
          <View style={styles.metricRow}>
            <Metric label="记忆" value={`${metrics.facts}`} font={bodyMedium} />
            <Metric label="日志" value={`${metrics.journals}`} font={bodyMedium} />
            <Metric label="复盘" value={`${metrics.recaps}`} font={bodyMedium} />
          </View>
        </View>

        <View style={styles.panel}>
          {tab === 'chat' ? (
            <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', android: undefined })} style={styles.flex}>
              <LinearGradient colors={['#0F172A', '#1E293B']} style={styles.hero}>
                <Text style={[styles.heroText, bodyBold]}>{metrics.focus}</Text>
              </LinearGradient>

              <ScrollView style={styles.flex} contentContainerStyle={styles.chatList}>
                {state.messages.map((msg) => (
                  <View key={msg.id} style={[styles.msgRow, msg.role === 'assistant' ? styles.left : styles.right]}>
                    <View style={[styles.msgBubble, msg.role === 'assistant' ? styles.assistant : styles.user]}>
                      {msg.imageUri ? <Image source={{ uri: msg.imageUri }} style={styles.msgImage} /> : null}
                      <Text style={[styles.msgText, msg.role === 'assistant' ? styles.dark : styles.light, bodyFont]}>
                        {msg.text}
                      </Text>
                      <Text style={[styles.msgTime, msg.role === 'assistant' ? styles.darkSoft : styles.lightSoft, bodyFont]}>
                        {formatClock(msg.createdAt)}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>

              <BlurView intensity={30} tint="light" style={styles.composer}>
                {selectedImage ? (
                  <View style={styles.previewBox}>
                    <Image source={{ uri: selectedImage.uri }} style={styles.previewImg} />
                    <Pressable style={styles.previewClose} onPress={() => setSelectedImage(null)}>
                      <Ionicons name="close-circle" size={20} color="#E2E8F0" />
                    </Pressable>
                  </View>
                ) : null}

                <TextInput
                  value={input}
                  onChangeText={setInput}
                  style={[styles.input, bodyFont]}
                  placeholder={selectedImage ? '鍙ˉ鍏呮弿杩板悗鍙戦€?..' : '鍙戜竴鍙ヤ粖澶╃殑鐘舵€侊紝鎴栫洿鎺ュ彂鍥?..'}
                  placeholderTextColor="#64748B"
                  multiline
                />

                <View style={styles.actions}>
                  <Pressable style={styles.mediaBtn} onPress={pickImage}>
                    <Ionicons name="images-outline" size={16} color="#0F172A" />
                  </Pressable>
                  <Pressable style={[styles.sendBtn, busy ? styles.sendBusy : null]} onPress={onSend}>
                    {busy ? (
                      <ActivityIndicator size="small" color="#F8FAFC" />
                    ) : (
                      <Ionicons name="paper-plane" size={17} color="#F8FAFC" />
                    )}
                  </Pressable>
                </View>
              </BlurView>

              <Text style={[styles.hint, bodyFont]}>API: {getApiBaseUrl()}/api/chat</Text>
              {notice ? <Text style={[styles.notice, bodyFont]}>{notice}</Text> : null}
            </KeyboardAvoidingView>
          ) : null}

          {tab === 'journal' ? (
            <ScrollView style={styles.flex}>
              <View style={styles.card}>
                <Text style={[styles.title, bodyBold]}>今日日记</Text>
                <Text style={[styles.hint, bodyFont]}>{todayKey}</Text>
                <View style={styles.moodRow}>
                  {moodOptions.map((item) => (
                    <Pressable
                      key={item.score}
                      style={[styles.mood, draft.mood === item.score ? styles.moodActive : null]}
                      onPress={() => setDraft((prev) => ({ ...prev, mood: item.score }))}
                    >
                      <Text style={[styles.moodText, draft.mood === item.score ? styles.moodTextActive : null, bodyFont]}>
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.taskBlock}>
                  <Text style={[styles.taskTitle, bodyBold]}>今日任务</Text>
                  {todayTasks.length === 0 ? <Text style={[styles.hint, bodyFont]}>先点中间 + 添加一个任务。</Text> : null}
                  {todayTasks.map((task) => (
                    <Pressable key={task.id} style={styles.taskRow} onPress={() => toggleTaskDone(task.id)}>
                      <Ionicons
                        name={task.done ? 'checkmark-circle' : 'ellipse-outline'}
                        size={18}
                        color={task.done ? '#0F766E' : '#64748B'}
                      />
                      <Text
                        style={[
                          styles.taskText,
                          task.done ? styles.taskTextDone : null,
                          bodyFont,
                        ]}
                      >
                        {task.title}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    style={styles.addTaskCenterBtn}
                    onPress={() => {
                      setTaskEditorOpen((prev) => !prev);
                      if (taskEditorOpen) {
                        setTaskTitle('');
                        setTaskImage(null);
                      }
                    }}
                  >
                    <Ionicons name={taskEditorOpen ? 'remove' : 'add'} size={24} color="#F8FAFC" />
                  </Pressable>
                </View>

                {taskEditorOpen ? (
                  <View style={styles.taskEditorCard}>
                    <View style={styles.taskImageActions}>
                      <Pressable style={styles.taskIconBtn} onPress={() => pickTaskImage('library')} disabled={taskAnalyzing}>
                        <Ionicons name="images-outline" size={18} color="#0F172A" />
                      </Pressable>
                      <Pressable style={styles.taskIconBtn} onPress={() => pickTaskImage('camera')} disabled={taskAnalyzing}>
                        <Ionicons name="camera-outline" size={18} color="#0F172A" />
                      </Pressable>
                    </View>

                    {taskImage ? <Image source={{ uri: taskImage.uri }} style={styles.taskPreviewImage} /> : null}
                    {taskAnalyzing ? (
                      <View style={styles.taskAnalyzingRow}>
                        <ActivityIndicator size="small" color="#0F766E" />
                        <Text style={[styles.taskAnalyzingText, bodyFont]}>AI 正在自动分析图片并生成任务...</Text>
                      </View>
                    ) : null}

                    <TextInput
                      value={taskTitle}
                      onChangeText={setTaskTitle}
                      placeholder="任务名称（可手动修改）"
                      placeholderTextColor="#94A3B8"
                      style={[styles.taskInput, bodyFont]}
                    />

                    <Pressable onPress={saveTask} disabled={taskSaving || taskAnalyzing}>
                      <LinearGradient colors={['#0F766E', '#0EA5E9']} style={styles.taskSaveBtn}>
                        {taskSaving ? (
                          <ActivityIndicator size="small" color="#F8FAFC" />
                        ) : (
                          <Text style={[styles.taskSaveText, bodyBold]}>保存</Text>
                        )}
                      </LinearGradient>
                    </Pressable>
                  </View>
                ) : null}

                <Field label="今天做成了什么" value={draft.wins} onChange={(text) => setDraft((prev) => ({ ...prev, wins: text }))} font={bodyFont} />
                <Field label="今天的反思" value={draft.lessons} onChange={(text) => setDraft((prev) => ({ ...prev, lessons: text }))} font={bodyFont} />
                <Field label="鏄庡ぉ鏈€閲嶈鐨勪簨" value={draft.focus} onChange={(text) => setDraft((prev) => ({ ...prev, focus: text }))} font={bodyFont} />
                <Field label="鎰熸仼璁板綍" value={draft.gratitude} onChange={(text) => setDraft((prev) => ({ ...prev, gratitude: text }))} font={bodyFont} />
                <Pressable onPress={onSaveJournal}>
                  <LinearGradient colors={['#0F766E', '#155E75']} style={styles.save}>
                    <Text style={[styles.saveText, bodyBold]}>保存并生成成长记录</Text>
                  </LinearGradient>
                </Pressable>
              </View>
            </ScrollView>
          ) : null}

          {tab === 'memory' ? (
            <ScrollView style={styles.flex}>
              <Text style={[styles.title, bodyBold]}>闀挎湡璁板繂</Text>
              {state.facts.length === 0 ? <Text style={[styles.hint, bodyFont]}>暂无记忆片段，先去聊天或写日记。</Text> : null}
              {state.facts.slice(0, 24).map((fact) => (
                <View key={fact.id} style={styles.fact}>
                  <Text style={[styles.factTag, { color: factColor(fact) }, bodyMedium]}>{categoryLabel(fact.category)}</Text>
                  <Text style={[styles.factText, bodyFont]}>{fact.value}</Text>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {tab === 'recap' ? (
            <ScrollView style={styles.flex}>
              <Text style={[styles.title, bodyBold]}>复盘中心</Text>
              <Text style={[styles.hint, bodyFont]}>按日/周/月/年查看成长轨迹与下一步行动</Text>
              <View style={styles.taskBoardCard}>
                <Text style={[styles.taskBoardTitle, bodyBold]}>任务看板</Text>
                <View style={styles.taskBoardGrid}>
                  <TaskBoardMetric label="昨天完成" value={taskBoardStats.yesterdayDone} font={bodyMedium} />
                  <TaskBoardMetric label="本周完成" value={taskBoardStats.weekDone} font={bodyMedium} />
                  <TaskBoardMetric label="本月完成" value={taskBoardStats.monthDone} font={bodyMedium} />
                  <TaskBoardMetric label="今年完成" value={taskBoardStats.yearDone} font={bodyMedium} />
                </View>
                <Text style={[styles.taskBoardCheer, bodyMedium]}>{taskInsight.cheer}</Text>
                <Text style={[styles.taskBoardLine, bodyFont]}>{taskInsight.solved}</Text>
                <Text style={[styles.taskBoardLine, bodyFont]}>{taskInsight.next}</Text>
                <View style={styles.taskBoardAiWrap}>
                  <Text style={[styles.taskBoardAiTitle, bodyBold]}>AI 复盘建议</Text>
                  {taskAiBusy ? <ActivityIndicator size="small" color="#0F766E" /> : null}
                  <Text style={[styles.taskBoardAiText, bodyFont]}>
                    {taskAiSummary || '整理中...'}
                  </Text>
                </View>
              </View>
              <View style={styles.recapFilters}>
                <RecapFilterButton
                  label="日"
                  active={recapPeriod === 'day'}
                  onPress={() => setRecapPeriod('day')}
                  font={bodyMedium}
                />
                <RecapFilterButton
                  label="周"
                  active={recapPeriod === 'week'}
                  onPress={() => setRecapPeriod('week')}
                  font={bodyMedium}
                />
                <RecapFilterButton
                  label="月"
                  active={recapPeriod === 'month'}
                  onPress={() => setRecapPeriod('month')}
                  font={bodyMedium}
                />
                <RecapFilterButton
                  label="年"
                  active={recapPeriod === 'year'}
                  onPress={() => setRecapPeriod('year')}
                  font={bodyMedium}
                />
              </View>

              {visibleRecaps.length === 0 ? (
                <Text style={[styles.hint, bodyFont]}>先写几条日记，系统会自动生成日周月年复盘。</Text>
              ) : null}
              {visibleRecaps.map((item) => (
                <View key={item.id} style={styles.recapCard}>
                  <LinearGradient colors={['#DBEAFE', '#ECFEFF']} style={styles.recapHead}>
                    <Text style={[styles.recapLabel, bodyBold]}>{item.label}</Text>
                    <Text style={[styles.recapMeta, bodyFont]}>
                      {item.startDate === item.endDate ? item.startDate : `${item.startDate} ~ ${item.endDate}`}
                    </Text>
                  </LinearGradient>
                  <Text style={[styles.recapSummary, bodyFont]}>{item.summary}</Text>
                  <RecapList title="亮点" items={item.highlights} font={bodyFont} />
                  <RecapList title="低谷/卡点" items={item.lowlights} font={bodyFont} />
                  <RecapList title="下一步" items={item.actions} font={bodyFont} />
                </View>
              ))}
            </ScrollView>
          ) : null}
        </View>

        <BlurView intensity={35} tint="light" style={styles.tabs}>
          <Tab label="鑱婂ぉ" icon="chatbubble-ellipses-outline" active={tab === 'chat'} onPress={() => setTab('chat')} font={bodyMedium} />
          <Tab label="鏃ヨ" icon="create-outline" active={tab === 'journal'} onPress={() => setTab('journal')} font={bodyMedium} />
          <Tab label="璁板繂" icon="albums-outline" active={tab === 'memory'} onPress={() => setTab('memory')} font={bodyMedium} />
          <Tab label="复盘" icon="stats-chart-outline" active={tab === 'recap'} onPress={() => setTab('recap')} font={bodyMedium} />
        </BlurView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function AuthScreen({
  mode,
  setMode,
  name,
  setName,
  email,
  setEmail,
  password,
  setPassword,
  busy,
  error,
  onSubmit,
  titleFont,
  bodyFont,
  bodyMedium,
  bodyBold,
}: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  name: string;
  setName: (value: string) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  busy: boolean;
  error: string;
  onSubmit: () => void;
  titleFont: { fontFamily: string };
  bodyFont: { fontFamily: string };
  bodyMedium: { fontFamily: string };
  bodyBold: { fontFamily: string };
}) {
  return (
    <LinearGradient colors={['#0B1220', '#1E293B', '#0F172A']} style={styles.authRoot}>
      <StatusBar style="light" />
      <View style={[styles.authOrb, styles.authOrbA]} />
      <View style={[styles.authOrb, styles.authOrbB]} />
      <SafeAreaView style={styles.authSafe}>
        <Text style={[styles.authBrand, titleFont]}>GrowUp</Text>
        <Text style={[styles.authTagline, bodyMedium]}>Your AI Companion For Lifelong Growth</Text>

        <BlurView intensity={40} tint="dark" style={styles.authCard}>
          <View style={styles.authMode}>
            <Pressable
              style={[styles.authModeBtn, mode === 'login' ? styles.authModeBtnActive : null]}
              onPress={() => setMode('login')}
            >
              <Text style={[styles.authModeLabel, mode === 'login' ? styles.authModeLabelActive : null, bodyMedium]}>
                鐧诲綍
              </Text>
            </Pressable>
            <Pressable
              style={[styles.authModeBtn, mode === 'register' ? styles.authModeBtnActive : null]}
              onPress={() => setMode('register')}
            >
              <Text
                style={[
                  styles.authModeLabel,
                  mode === 'register' ? styles.authModeLabelActive : null,
                  bodyMedium,
                ]}
              >
                娉ㄥ唽
              </Text>
            </Pressable>
          </View>

          {mode === 'register' ? (
            <AuthInput
              icon="person-outline"
              placeholder="浣犵殑鏄电О锛堝彲閫夛級"
              value={name}
              onChange={setName}
              bodyFont={bodyFont}
            />
          ) : null}
          <AuthInput icon="mail-outline" placeholder="閭" value={email} onChange={setEmail} bodyFont={bodyFont} />
          <AuthInput
            icon="lock-closed-outline"
            placeholder="瀵嗙爜"
            value={password}
            onChange={setPassword}
            bodyFont={bodyFont}
            secureTextEntry
          />

          {error ? <Text style={[styles.authError, bodyFont]}>{error}</Text> : null}

          <Pressable onPress={onSubmit} disabled={busy}>
            <LinearGradient colors={['#06B6D4', '#0EA5E9']} style={styles.authSubmit}>
              {busy ? (
                <ActivityIndicator size="small" color="#F8FAFC" />
              ) : (
                <Text style={[styles.authSubmitLabel, bodyBold]}>
                  {mode === 'register' ? '创建并进入' : '登录并进入'}
                </Text>
              )}
            </LinearGradient>
          </Pressable>

          <Text style={[styles.authHint, bodyFont]}>你的图片与聊天会按账号隔离存储在云端 PocketBase。</Text>
        </BlurView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function IdentitySetupScreen({
  userName,
  setUserName,
  companionName,
  setCompanionName,
  userBio,
  setUserBio,
  busy,
  onSubmit,
  titleFont,
  bodyFont,
  bodyMedium,
  bodyBold,
}: {
  userName: string;
  setUserName: (value: string) => void;
  companionName: string;
  setCompanionName: (value: string) => void;
  userBio: string;
  setUserBio: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
  titleFont: { fontFamily: string };
  bodyFont: { fontFamily: string };
  bodyMedium: { fontFamily: string };
  bodyBold: { fontFamily: string };
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const companion = companionName.trim() || '贾维斯';

  const onNext = () => {
    if (!companionName.trim()) {
      setCompanionName('贾维斯');
    }
    setStep(2);
  };

  return (
    <LinearGradient colors={['#0F172A', '#1F2937', '#111827']} style={styles.identityRoot}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.identitySafe}>
        <Text style={[styles.identityBrand, titleFont]}>First Ritual</Text>
        <Text style={[styles.identitySub, bodyMedium]}>
          先完成第一次对话，你和伙伴就正式上线了
        </Text>

        <BlurView intensity={36} tint="dark" style={styles.identityCard}>
          {step === 1 ? (
            <>
              <Text style={[styles.identityTitle, bodyBold]}>先给你的 AI 伙伴取个名字</Text>
              <AuthInput
                icon="sparkles-outline"
                placeholder="推荐：贾维斯"
                value={companionName}
                onChange={setCompanionName}
                bodyFont={bodyFont}
              />
              <Text style={[styles.identityHint, bodyFont]}>
                名字会被长期记住，后续所有聊天都会用这个身份陪伴你。
              </Text>
              <Pressable onPress={onNext} disabled={busy}>
                <LinearGradient colors={['#14B8A6', '#0EA5E9']} style={styles.identitySubmit}>
                  <Text style={[styles.identitySubmitLabel, bodyBold]}>下一步</Text>
                </LinearGradient>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.identityBotBubble}>
                <Text style={[styles.identityBotText, bodyFont]}>
                  {`你好，我是${companion}。我想更了解你：希望我怎么称呼你？也请介绍一下你自己。`}
                </Text>
              </View>

              <Text style={[styles.identityTitle, bodyBold]}>你希望我怎么称呼你？</Text>
              <AuthInput
                icon="person-outline"
                placeholder="比如：阿森 / 小雨"
                value={userName}
                onChange={setUserName}
                bodyFont={bodyFont}
              />

              <Text style={[styles.identityTitle, bodyBold]}>再介绍一下你自己（可选）</Text>
              <TextInput
                value={userBio}
                onChangeText={setUserBio}
                multiline
                placeholder="比如：我目前最想提升执行力，容易拖延..."
                placeholderTextColor="#64748B"
                style={[styles.identityBioInput, bodyFont]}
              />

              <Pressable onPress={onSubmit} disabled={busy}>
                <LinearGradient colors={['#14B8A6', '#0EA5E9']} style={styles.identitySubmit}>
                  {busy ? (
                    <ActivityIndicator size="small" color="#F8FAFC" />
                  ) : (
                    <Text style={[styles.identitySubmitLabel, bodyBold]}>确认并开始</Text>
                  )}
                </LinearGradient>
              </Pressable>
            </>
          )}
        </BlurView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function AuthInput({
  icon,
  placeholder,
  value,
  onChange,
  bodyFont,
  secureTextEntry,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  placeholder: string;
  value: string;
  onChange: (text: string) => void;
  bodyFont: { fontFamily: string };
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.authInputWrap}>
      <Ionicons name={icon} size={16} color="#94A3B8" />
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

function Metric({ label, value, font }: { label: string; value: string; font: { fontFamily: string } }) {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricLabel, font]}>{label}</Text>
      <Text style={[styles.metricValue, font]}>{value}</Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  font,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  font: { fontFamily: string };
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { fontFamily: 'SpaceGrotesk_500Medium' }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline
        placeholder="鍐欎笅浣犵殑鐪熷疄鎯虫硶..."
        placeholderTextColor="#94A3B8"
        style={[styles.fieldInput, font]}
      />
    </View>
  );
}

function Tab({
  label,
  icon,
  active,
  onPress,
  font,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  font: { fontFamily: string };
}) {
  return (
    <Pressable style={[styles.tab, active ? styles.tabActive : null]} onPress={onPress}>
      <Ionicons name={icon} size={17} color={active ? '#F8FAFC' : '#0F172A'} />
      <Text style={[styles.tabLabel, { color: active ? '#F8FAFC' : '#0F172A' }, font]}>{label}</Text>
    </Pressable>
  );
}

function RecapFilterButton({
  label,
  active,
  onPress,
  font,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  font: { fontFamily: string };
}) {
  return (
    <Pressable style={[styles.recapFilterBtn, active ? styles.recapFilterBtnActive : null]} onPress={onPress}>
      <Text style={[styles.recapFilterLabel, active ? styles.recapFilterLabelActive : null, font]}>{label}</Text>
    </Pressable>
  );
}

function RecapList({
  title,
  items,
  font,
}: {
  title: string;
  items: string[];
  font: { fontFamily: string };
}) {
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.recapSection}>
      <Text style={[styles.recapSectionTitle, font]}>{title}</Text>
      {items.map((item) => (
        <Text key={`${title}-${item}`} style={[styles.recapItem, font]}>
          • {item}
        </Text>
      ))}
    </View>
  );
}

function TaskBoardMetric({
  label,
  value,
  font,
}: {
  label: string;
  value: number;
  font: { fontFamily: string };
}) {
  return (
    <View style={styles.taskBoardMetric}>
      <Text style={[styles.taskBoardMetricValue, font]}>{value}</Text>
      <Text style={[styles.taskBoardMetricLabel, font]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1, padding: 12 },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
  },
  authRoot: { flex: 1 },
  authSafe: { flex: 1, justifyContent: 'center', paddingHorizontal: 18 },
  authOrb: { position: 'absolute', borderRadius: 999 },
  authOrbA: {
    width: 280,
    height: 280,
    backgroundColor: 'rgba(6,182,212,0.24)',
    right: -100,
    top: -60,
  },
  authOrbB: {
    width: 220,
    height: 220,
    backgroundColor: 'rgba(249,115,22,0.20)',
    left: -90,
    bottom: -30,
  },
  authBrand: { fontSize: 46, color: '#F8FAFC', textAlign: 'center' },
  authTagline: {
    fontSize: 13,
    color: '#E2E8F0',
    textAlign: 'center',
    letterSpacing: 0.4,
    marginTop: 4,
    marginBottom: 16,
  },
  authCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    backgroundColor: 'rgba(15,23,42,0.46)',
    padding: 14,
    gap: 10,
  },
  authMode: {
    flexDirection: 'row',
    backgroundColor: 'rgba(15,23,42,0.65)',
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  authModeBtn: {
    flex: 1,
    borderRadius: 9,
    paddingVertical: 8,
    alignItems: 'center',
  },
  authModeBtnActive: {
    backgroundColor: 'rgba(14,165,233,0.75)',
  },
  authModeLabel: {
    color: '#CBD5E1',
    fontSize: 13,
  },
  authModeLabelActive: {
    color: '#F8FAFC',
  },
  authInputWrap: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    backgroundColor: 'rgba(15,23,42,0.65)',
    paddingHorizontal: 10,
    height: 46,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  authInput: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 14,
  },
  authError: {
    color: '#FCA5A5',
    fontSize: 12,
  },
  authSubmit: {
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
  },
  authSubmitLabel: {
    color: '#F8FAFC',
    fontSize: 14,
  },
  authHint: {
    fontSize: 11,
    color: '#CBD5E1',
    lineHeight: 16,
  },
  identityRoot: { flex: 1 },
  identitySafe: { flex: 1, justifyContent: 'center', paddingHorizontal: 18 },
  identityBrand: { fontSize: 44, color: '#F8FAFC', textAlign: 'center' },
  identitySub: {
    fontSize: 13,
    color: '#E2E8F0',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  identityCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    backgroundColor: 'rgba(15,23,42,0.46)',
    padding: 14,
    gap: 10,
  },
  identityTitle: {
    marginTop: 2,
    fontSize: 14,
    color: '#F8FAFC',
  },
  identityHint: {
    fontSize: 11,
    color: '#CBD5E1',
    lineHeight: 16,
  },
  identityBotBubble: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(125,211,252,0.45)',
    backgroundColor: 'rgba(30,41,59,0.75)',
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 2,
  },
  identityBotText: {
    fontSize: 12,
    color: '#E2E8F0',
    lineHeight: 18,
  },
  identityBioInput: {
    minHeight: 90,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    backgroundColor: 'rgba(15,23,42,0.65)',
    color: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 10,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  identitySubmit: {
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
    marginTop: 4,
  },
  identitySubmitLabel: {
    color: '#F8FAFC',
    fontSize: 14,
  },
  header: { paddingHorizontal: 6, paddingBottom: 8 },
  brand: { fontSize: 36, color: '#111827' },
  sub: { fontSize: 13, color: '#334155' },
  userWrap: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  userName: {
    flex: 1,
    fontSize: 12,
    color: '#1E293B',
  },
  logoutBtn: {
    width: 30,
    height: 30,
    borderRadius: 999,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricRow: { marginTop: 10, flexDirection: 'row', gap: 8 },
  metric: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  metricLabel: { fontSize: 12, color: '#64748B' },
  metricValue: { fontSize: 13, color: '#0F172A', marginTop: 2 },
  panel: {
    flex: 1,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
    padding: 10,
  },
  flex: { flex: 1 },
  hero: { borderRadius: 16, padding: 12, marginBottom: 8 },
  heroText: { color: '#F8FAFC', fontSize: 15, lineHeight: 21 },
  chatList: { gap: 8, paddingBottom: 10 },
  msgRow: { flexDirection: 'row' },
  left: { justifyContent: 'flex-start' },
  right: { justifyContent: 'flex-end' },
  msgBubble: { maxWidth: '86%', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8 },
  assistant: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderTopLeftRadius: 6,
  },
  user: { backgroundColor: '#0F766E', borderTopRightRadius: 6 },
  msgImage: { width: 168, height: 168, borderRadius: 8, marginBottom: 8 },
  msgText: { fontSize: 14, lineHeight: 20 },
  dark: { color: '#0F172A' },
  light: { color: '#F8FAFC' },
  msgTime: { marginTop: 6, fontSize: 10 },
  darkSoft: { color: '#94A3B8' },
  lightSoft: { color: '#D1FAE5' },
  composer: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.06)',
    padding: 8,
    gap: 8,
  },
  previewBox: {
    width: 80,
    height: 80,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  previewImg: { width: '100%', height: '100%' },
  previewClose: { position: 'absolute', top: 2, right: 2 },
  input: { minHeight: 42, maxHeight: 120, fontSize: 14, color: '#0F172A' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  mediaBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#0F766E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBusy: { opacity: 0.72 },
  hint: { marginTop: 4, fontSize: 11, color: '#64748B' },
  notice: { marginTop: 2, fontSize: 11, color: '#B91C1C' },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
  },
  title: { fontSize: 20, color: '#0F172A' },
  moodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 10 },
  mood: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  moodActive: { backgroundColor: '#0F766E', borderColor: '#0F766E' },
  moodText: { fontSize: 12, color: '#0F172A' },
  moodTextActive: { color: '#ECFEFF' },
  taskBlock: {
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    padding: 10,
  },
  taskTitle: {
    fontSize: 14,
    color: '#0F172A',
    marginBottom: 6,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
  },
  taskText: {
    flex: 1,
    fontSize: 13,
    color: '#0F172A',
  },
  taskTextDone: {
    color: '#64748B',
    textDecorationLine: 'line-through',
  },
  addTaskCenterBtn: {
    alignSelf: 'center',
    width: 52,
    height: 52,
    borderRadius: 999,
    marginTop: 6,
    backgroundColor: '#0F766E',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  taskEditorCard: {
    marginBottom: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#FFFFFF',
    padding: 10,
  },
  taskImageActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 8,
  },
  taskIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskPreviewImage: {
    width: '100%',
    height: 150,
    borderRadius: 10,
    marginBottom: 8,
  },
  taskAnalyzingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  taskAnalyzingText: {
    fontSize: 12,
    color: '#0F766E',
  },
  taskInput: {
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    color: '#0F172A',
    marginBottom: 10,
  },
  taskSaveBtn: {
    alignSelf: 'center',
    width: '76%',
    height: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskSaveText: {
    fontSize: 15,
    color: '#F8FAFC',
  },
  field: { marginBottom: 10 },
  fieldLabel: { marginBottom: 5, fontSize: 13, color: '#0F172A' },
  fieldInput: {
    minHeight: 74,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 9,
    textAlignVertical: 'top',
  },
  save: { borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  saveText: { fontSize: 14, color: '#F8FAFC' },
  fact: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 10,
    marginTop: 8,
  },
  factTag: { fontSize: 12 },
  factText: { marginTop: 4, fontSize: 13, color: '#0F172A', lineHeight: 18 },
  taskBoardCard: {
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    backgroundColor: '#EEF2FF',
    padding: 10,
  },
  taskBoardTitle: {
    fontSize: 15,
    color: '#111827',
  },
  taskBoardGrid: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  taskBoardMetric: {
    width: '48%',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  taskBoardMetricValue: {
    fontSize: 18,
    color: '#0F172A',
  },
  taskBoardMetricLabel: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  taskBoardCheer: {
    marginTop: 10,
    fontSize: 12,
    color: '#0F766E',
  },
  taskBoardLine: {
    marginTop: 5,
    fontSize: 12,
    color: '#334155',
    lineHeight: 18,
  },
  taskBoardAiWrap: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    backgroundColor: '#ECFDF5',
    padding: 8,
    gap: 4,
  },
  taskBoardAiTitle: {
    fontSize: 12,
    color: '#065F46',
  },
  taskBoardAiText: {
    fontSize: 12,
    color: '#134E4A',
    lineHeight: 18,
  },
  recapFilters: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  recapFilterBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  recapFilterBtnActive: {
    backgroundColor: '#0F766E',
    borderColor: '#0F766E',
  },
  recapFilterLabel: {
    fontSize: 12,
    color: '#0F172A',
  },
  recapFilterLabelActive: {
    color: '#F8FAFC',
  },
  recapCard: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  recapHead: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  recapLabel: {
    fontSize: 14,
    color: '#0F172A',
  },
  recapMeta: {
    fontSize: 11,
    color: '#334155',
    marginTop: 2,
  },
  recapSummary: {
    marginTop: 8,
    marginHorizontal: 10,
    fontSize: 13,
    color: '#0F172A',
    lineHeight: 19,
  },
  recapSection: {
    marginTop: 8,
    marginHorizontal: 10,
    marginBottom: 2,
  },
  recapSectionTitle: {
    fontSize: 12,
    color: '#475569',
  },
  recapItem: {
    fontSize: 12,
    color: '#0F172A',
    marginTop: 3,
    lineHeight: 18,
  },
  tabs: {
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.08)',
    padding: 6,
    flexDirection: 'row',
    gap: 6,
  },
  tab: {
    flex: 1,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 8,
  },
  tabActive: { backgroundColor: '#0F766E' },
  tabLabel: { fontSize: 12 },
});



