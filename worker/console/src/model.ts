import type { FeatureCollection, LineString, Point } from "geojson";

export type QualityStatus = "pending" | "retained" | "outlier" | "review" | "uncertain" | "unassessed";
export interface LocationPoint {
  id: number; longitude: number; latitude: number; timestamp: number;
  device: string | null; city: string | null;
  timezone?: number | null;
  quality: { status: QualityStatus; reason: string; version: string | null;
    checkedAt: number | null; evidence: unknown };
}
export interface Project { id: number; name: string; startTime: number; endTime: number }
export interface ConsoleConfig { mapboxToken: string; mapboxStyle: string; localPreview: boolean }
export interface Filters { project: string; since: string; until: string; filtered: boolean;
  timeWindow?: { start: number; end: number } }
export const EMPTY_FILTERS: Filters = { project: "", since: "", until: "", filtered: true };
const HIDDEN_QUALITY = new Set<QualityStatus>(["outlier", "review", "uncertain"]);
export const isTrajectoryPoint = (point: LocationPoint) => !HIDDEN_QUALITY.has(point.quality.status);
const dateFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const formatDate = (time: number) => dateFormat.format(time).replaceAll("/", ".");
export const formatTime = (time: number) => timeFormat.format(time);
export const count = (n: number) => n.toLocaleString("en-US");
export const sortPoints = (points: LocationPoint[]) => [...points].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
export function validCoordinate(point: Pick<LocationPoint, "longitude" | "latitude">) {
  return Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180
    && Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90;
}
export function filterPoints(points: LocationPoint[], filters: Filters, projects: Project[]) {
  const project = projects.find(p => String(p.id) === filters.project);
  const start = filters.timeWindow?.start ?? (filters.since ? Date.parse(`${filters.since}T00:00:00+08:00`) : -Infinity);
  const end = filters.timeWindow?.end ?? (filters.until ? Date.parse(`${filters.until}T23:59:59.999+08:00`) : Infinity);
  return points.filter(p => p.timestamp >= start && p.timestamp <= end
    && (!project || (p.timestamp >= project.startTime && p.timestamp <= project.endTime))
    && (!filters.filtered || isTrajectoryPoint(p)));
}
export function pointGeoJSON(points: LocationPoint[]): FeatureCollection<Point> {
  return { type: "FeatureCollection", features: points.filter(validCoordinate).map(p => ({
    type: "Feature", id: p.id, properties: { id: p.id },
    geometry: { type: "Point", coordinates: [mapCoordinate(p.longitude), mapCoordinate(p.latitude)] },
  })) };
}
const mapCoordinate = (value: number) => Math.round(value * 1e6) / 1e6;
export function lineGeoJSON(points: LocationPoint[]): FeatureCollection<LineString> {
  const coordinates: number[][] = [];
  for (const p of sortPoints(points).filter(validCoordinate)) {
    const position = [mapCoordinate(p.longitude), mapCoordinate(p.latitude)], last = coordinates.at(-1);
    if (!last || position[0] !== last[0] || position[1] !== last[1]) coordinates.push(position);
  }
  // The selected interval is one continuous chronological path, including
  // sampling gaps and device changes. Raw observations remain unchanged.
  return { type: "FeatureCollection", features: coordinates.length > 1 ? [{
    type: "Feature", id: 0, properties: {}, geometry: { type: "LineString", coordinates },
  }] : [] };
}
