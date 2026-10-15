import type { LocationPoint } from "./model";
export interface LocalPointTime {
  date: string; time: string; timezone: number | null; offset: string;
}

export function getPointLocalTime(point: Pick<LocationPoint, "timestamp" | "timezone">): LocalPointTime | null {
  if (!Number.isFinite(point.timestamp)) return null;
  const value = point.timezone;
  const recorded = typeof value === "number" && Number.isFinite(value) && value >= -12 && value <= 14;
  const minutes = recorded ? Math.round(value * 60) : 0;
  // The offset belongs to this observation. Formatting in UTC avoids applying
  // the browser's timezone or another round of daylight-saving conversion.
  const date = new Date(point.timestamp + minutes * 60_000);
  if (Number.isNaN(date.getTime())) return null;
  const clock = date.toISOString(), absolute = Math.abs(minutes);
  const offset = `UTC${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return { date: clock.slice(0, 10).replaceAll("-", "."), time: clock.slice(11, 19), timezone: recorded ? minutes / 60 : null, offset };
}
