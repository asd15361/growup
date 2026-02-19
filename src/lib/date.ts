export function toDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  return `${hh}:${mm}`;
}

export function toWeekLabel(date = new Date()): string {
  const oneJan = new Date(date.getFullYear(), 0, 1);
  const dayMs = 24 * 60 * 60 * 1000;
  const week = Math.ceil(((date.getTime() - oneJan.getTime()) / dayMs + oneJan.getDay() + 1) / 7);
  return `${date.getFullYear()}-W${`${week}`.padStart(2, '0')}`;
}
