import { toWeekLabel } from './date';
import { DailyJournal, MemoryCategory, MemoryFact, WeeklyDigest } from '../types';

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

const factRules: Array<{ category: MemoryCategory; keywords: string[] }> = [
  { category: 'goal', keywords: ['目标', '计划', '想要', '打算', '今年'] },
  { category: 'habit', keywords: ['每天', '习惯', '坚持', '打卡', '规律'] },
  { category: 'identity', keywords: ['我是', '性格', '擅长', '不擅长'] },
  { category: 'relationship', keywords: ['家人', '朋友', '同事', '伴侣'] },
  { category: 'preference', keywords: ['喜欢', '讨厌', '偏好', '想吃'] },
  { category: 'risk', keywords: ['焦虑', '压力', '拖延', '睡不好', '失眠'] },
];

function normalize(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!\n]/g)
    .map((item) => normalize(item))
    .filter((item) => item.length > 4);
}

function detectCategory(sentence: string): MemoryCategory | null {
  for (const rule of factRules) {
    if (rule.keywords.some((k) => sentence.includes(k))) {
      return rule.category;
    }
  }
  return null;
}

export function extractFacts(text: string, nowIso: string): MemoryFact[] {
  const result: MemoryFact[] = [];
  for (const sentence of splitSentences(text)) {
    const category = detectCategory(sentence);
    if (!category) {
      continue;
    }
    result.push({
      id: createId('fact'),
      category,
      value: sentence.slice(0, 90),
      confidence: 0.65,
      updatedAt: nowIso,
    });
  }
  return result;
}

export function mergeFacts(existing: MemoryFact[], incoming: MemoryFact[]): MemoryFact[] {
  const merged = [...existing];
  for (const fact of incoming) {
    const index = merged.findIndex(
      (item) => item.category === fact.category && (item.value.includes(fact.value) || fact.value.includes(item.value)),
    );
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        value: merged[index].value.length >= fact.value.length ? merged[index].value : fact.value,
        confidence: Math.min(0.98, merged[index].confidence + 0.07),
        updatedAt: fact.updatedAt,
      };
      continue;
    }
    merged.push(fact);
  }
  return merged
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 120);
}

export function findRelevantFacts(facts: MemoryFact[], query: string, limit = 4): MemoryFact[] {
  const lowered = normalize(query).toLowerCase();
  const tokens = lowered.split(/[,\s，。！？!]/g).filter(Boolean);
  return [...facts]
    .map((fact) => {
      let score = fact.confidence;
      for (const token of tokens) {
        if (token.length >= 2 && fact.value.toLowerCase().includes(token)) {
          score += 1;
        }
      }
      return { fact, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.fact);
}

export function upsertWeeklyDigest(digests: WeeklyDigest[], journal: DailyJournal, nowIso: string): WeeklyDigest[] {
  const weekLabel = toWeekLabel(new Date(`${journal.dateKey}T00:00:00`));
  const summary = [
    journal.wins ? `本周亮点：${journal.wins}` : '',
    journal.lessons ? `主要反思：${journal.lessons}` : '',
    journal.focus ? `当前重点：${journal.focus}` : '',
  ]
    .filter(Boolean)
    .join('；');

  const priorities = [journal.focus, journal.lessons, journal.wins]
    .filter(Boolean)
    .map((item) => item.slice(0, 24))
    .slice(0, 3);

  const index = digests.findIndex((item) => item.weekLabel === weekLabel);
  if (index >= 0) {
    const updated = [...digests];
    updated[index] = {
      ...updated[index],
      summary: updated[index].summary ? `${updated[index].summary}\n${summary}`.trim() : summary,
      priorities: Array.from(new Set([...updated[index].priorities, ...priorities])).slice(0, 5),
      createdAt: nowIso,
    };
    return updated.slice(-12);
  }

  return [
    ...digests,
    {
      id: createId('digest'),
      weekLabel,
      summary,
      priorities,
      createdAt: nowIso,
    },
  ].slice(-12);
}

export function categoryLabel(category: MemoryCategory): string {
  if (category === 'goal') return '目标';
  if (category === 'habit') return '习惯';
  if (category === 'identity') return '身份认知';
  if (category === 'relationship') return '关系';
  if (category === 'preference') return '偏好';
  return '风险提醒';
}
