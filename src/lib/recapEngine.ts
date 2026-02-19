import { DailyJournal, PeriodicRecap, RecapPeriod } from '../types';
import { toDateKey, toWeekLabel } from './date';

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toMonthLabel(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}

function toYearLabel(date: Date): string {
  return `${date.getFullYear()}`;
}

function parseDateKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00`);
}

function clampList(items: string[], limit = 3): string[] {
  const normalized = items
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, idx, arr) => arr.indexOf(item) === idx);
  return normalized.slice(0, limit);
}

function buildSummary(period: RecapPeriod, journals: DailyJournal[]): string {
  const moodAvg = journals.reduce((sum, item) => sum + (item.mood || 0), 0) / Math.max(1, journals.length);
  const moodText = moodAvg.toFixed(1);
  if (period === 'day') {
    const [item] = journals;
    return `今天情绪均值 ${moodText} / 5，重点是：${item?.focus?.trim() || '明确明天最重要的一件事'}。`;
  }
  if (period === 'week') {
    return `本周记录 ${journals.length} 天，情绪均值 ${moodText} / 5，建议继续稳定输出。`;
  }
  if (period === 'month') {
    return `本月记录 ${journals.length} 天，情绪均值 ${moodText} / 5，建议聚焦主线并减少分心。`;
  }
  return `今年累计记录 ${journals.length} 天，情绪均值 ${moodText} / 5，保持长期主义节奏。`;
}

function buildRecap(
  period: RecapPeriod,
  label: string,
  journals: DailyJournal[],
  createdAt: string,
): PeriodicRecap | null {
  if (journals.length === 0) return null;
  const ordered = [...journals].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const startDate = ordered[0].dateKey;
  const endDate = ordered[ordered.length - 1].dateKey;

  const highlights = clampList(ordered.map((item) => item.wins || ''));
  const lowlights = clampList(ordered.map((item) => item.lessons || ''));
  const actions = clampList(ordered.map((item) => item.focus || ''));
  const summary = buildSummary(period, ordered);

  return {
    id: createId(`recap-${period}`),
    period,
    label,
    startDate,
    endDate,
    summary,
    highlights,
    lowlights,
    actions,
    createdAt,
  };
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const key = getKey(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

const periodOrder: Record<RecapPeriod, number> = {
  year: 0,
  month: 1,
  week: 2,
  day: 3,
};

function sortRecaps(recaps: PeriodicRecap[]): PeriodicRecap[] {
  return recaps.sort((a, b) => {
    const endDiff = parseDateKey(b.endDate).getTime() - parseDateKey(a.endDate).getTime();
    if (endDiff !== 0) return endDiff;
    return periodOrder[a.period] - periodOrder[b.period];
  });
}

export function buildPeriodicRecaps(journals: DailyJournal[], nowIso = new Date().toISOString()): PeriodicRecap[] {
  const effective = journals
    .filter((item) => [item.focus, item.wins, item.lessons, item.gratitude].some((v) => (v || '').trim()))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  if (effective.length === 0) return [];

  const dayRecaps = effective
    .map((item) => buildRecap('day', item.dateKey, [item], nowIso))
    .filter(Boolean) as PeriodicRecap[];

  const weekGroups = groupBy(effective, (item) => toWeekLabel(parseDateKey(item.dateKey)));
  const weekRecaps = Object.keys(weekGroups)
    .sort()
    .map((label) => buildRecap('week', label, weekGroups[label], nowIso))
    .filter(Boolean) as PeriodicRecap[];

  const monthGroups = groupBy(effective, (item) => toMonthLabel(parseDateKey(item.dateKey)));
  const monthRecaps = Object.keys(monthGroups)
    .sort()
    .map((label) => buildRecap('month', label, monthGroups[label], nowIso))
    .filter(Boolean) as PeriodicRecap[];

  const yearGroups = groupBy(effective, (item) => toYearLabel(parseDateKey(item.dateKey)));
  const yearRecaps = Object.keys(yearGroups)
    .sort()
    .map((label) => buildRecap('year', label, yearGroups[label], nowIso))
    .filter(Boolean) as PeriodicRecap[];

  return sortRecaps([...dayRecaps, ...weekRecaps, ...monthRecaps, ...yearRecaps]).slice(0, 220);
}

export function buildRolloverPrompt(companionName: string, recaps: PeriodicRecap[]): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday);
  const dayRecap = recaps.find((item) => item.period === 'day' && item.label === yesterdayKey);

  if (!dayRecap) {
    return `${companionName} 在。新的一天开始了，我们今晚做一次日复盘。`;
  }

  const topAction = dayRecap.actions[0] || '明确今天最重要的一件事';
  const topHighlight = dayRecap.highlights[0] || '你有在持续推进';
  return `${companionName} 的零点复盘：昨天亮点「${topHighlight}」，今天先做「${topAction}」。`;
}
