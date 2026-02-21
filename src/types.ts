export type Role = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  imageUri?: string;
  imageMimeType?: string;
  createdAt: string;
  order?: number;
}

export type MemoryCategory =
  | 'goal'
  | 'habit'
  | 'identity'
  | 'relationship'
  | 'preference'
  | 'risk';

export interface MemoryFact {
  id: string;
  category: MemoryCategory;
  value: string;
  confidence: number;
  updatedAt: string;
}

export interface DailyJournal {
  id: string;
  dateKey: string;
  mood: number;
  wins: string;
  lessons: string;
  focus: string;
  gratitude: string;
}

export interface TaskItem {
  id: string;
  dateKey: string;
  title: string;
  done: boolean;
  fromImage?: boolean;
  createdAt: string;
}

export interface WeeklyDigest {
  id: string;
  weekLabel: string;
  summary: string;
  priorities: string[];
  createdAt: string;
}

export type RecapPeriod = 'day' | 'week' | 'month' | 'year';

export interface PeriodicRecap {
  id: string;
  period: RecapPeriod;
  label: string;
  startDate: string;
  endDate: string;
  summary: string;
  highlights: string[];
  lowlights: string[];
  actions: string[];
  milestones?: string[];
  growths?: string[];
  createdAt: string;
}

export interface AppState {
  messages: ChatMessage[];
  facts: MemoryFact[];
  journals: DailyJournal[];
  tasks: TaskItem[];
  digests: WeeklyDigest[];
  recaps: PeriodicRecap[];
  lastRolloverDate: string;
}
