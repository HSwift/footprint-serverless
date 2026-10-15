import type { Filters } from "./model";

export const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 31;
export type QuickRange = "today" | "week" | "month";
export type DayRange = [number, number];
export function aroundPointRange(timestamp: number) {
  const start = timestamp - DAY_MS, end = timestamp + DAY_MS;
  return { since: dayDate(calendarDay(start)), until: dayDate(calendarDay(end)), timeWindow: { start, end } };
}

// Calendar days in Shanghai, independent of the browser's local time zone.
export const calendarDay = (timestamp: number) => Math.floor((timestamp + 8 * 3_600_000) / DAY_MS);
export const dayDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
export function dateDay(date: string) {
  const timestamp = Date.parse(`${date}T00:00:00+08:00`);
  const day = calendarDay(timestamp);
  return Number.isFinite(day) && dayDate(day) === date ? day : NaN;
}
export function quickRange(preset: QuickRange, timestamp = Date.now()): DayRange {
  const today = calendarDay(timestamp), date = new Date(today * DAY_MS);
  if (preset === "today") return [today, today];
  if (preset === "week") {
    const monday = today - (date.getUTCDay() + 6) % 7;
    return [monday, monday + 6];
  }
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  return [Date.UTC(year, month, 1) / DAY_MS, Date.UTC(year, month + 1, 0) / DAY_MS];
}
export function drawableRange(filters: Pick<Filters, "since" | "until">): DayRange | null {
  if (!filters.since || !filters.until) return null;
  const start = dateDay(filters.since), end = dateDay(filters.until);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < MAX_RANGE_DAYS ? [start, end] : null;
}
export function shiftMonth(month: string, offset: number) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}
export function monthWindow(month: string): DayRange {
  const [year, number] = month.split("-").map(Number);
  // Always show three complete calendar months, including days without data.
  return [Date.UTC(year, number - 3, 1) / DAY_MS, Date.UTC(year, number, 0) / DAY_MS];
}
export function presetRange(end: number, days: number, minimum: number): DayRange {
  return [Math.max(minimum, end - Math.min(MAX_RANGE_DAYS, Math.max(1, days)) + 1), end];
}
export function panRange(range: DayRange, offset: number, minimum: number, maximum: number): DayRange {
  const span = Math.min(range[1] - range[0], maximum - minimum);
  const start = Math.max(minimum, Math.min(maximum - span, range[0] + offset));
  return [start, start + span];
}
export function panSelection(window: DayRange, selection: DayRange, offset: number, minimum: number, maximum: number) {
  const range = panRange(window, offset, minimum, maximum), shift = range[0] - window[0];
  return { range, selection: [selection[0] + shift, selection[1] + shift] as DayRange, shift };
}
export function selectionInWindow(selection: DayRange, previous: DayRange, next: DayRange): DayRange {
  const duration = selection[1] - selection[0];
  const fraction = (selection[0] - previous[0]) / Math.max(1, previous[1] - previous[0]);
  const start = Math.max(next[0], Math.min(next[1] - duration, Math.round(next[0] + fraction * (next[1] - next[0]))));
  return [start, start + duration];
}
export function constrainRange(next: number[], previous: DayRange, minimum: number, maximum: number): DayRange {
  // Keep the opposite endpoint fixed at the inclusive month-length limit.
  if (next[0] !== previous[0]) {
    const end = Math.min(maximum, Math.max(minimum, previous[1]));
    return [Math.max(minimum, end - MAX_RANGE_DAYS + 1, Math.min(end, next[0])), end];
  }
  const start = Math.min(maximum, Math.max(minimum, previous[0]));
  return [start, Math.min(maximum, start + MAX_RANGE_DAYS - 1, Math.max(start, next[1]))];
}
