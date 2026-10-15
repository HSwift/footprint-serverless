// Experimental detector shared by offline analysis and bounded ingest windows.
// Findings are candidates, never deletion
// instructions. Keep original coordinates and IDs for human review.
// The bounded longest-compatible-subsequence step adapts the minimum-fix idea
// from MTCSC-G (Zhang et al., 2024, https://arxiv.org/abs/2411.01214).
export interface TrackPoint {
  id: number;
  device: string | null;
  timestamp: number;
  longitude: number;
  latitude: number;
}

export interface DetectorOptions {
  maxGapSeconds: number;
  maxSpanSeconds: number;
  maxReturnSpanSeconds: number;
  maxReturnDistanceMeters: number;
  maxBurstPoints: number;
  minDeviationMeters: number;
  minDetourRatio: number;
  minSpeedKmh: number;
  highSpeedKmh: number;
  hardSpeedKmh: number;
  contextSpeedFactor: number;
  maxPasses: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  maxGapSeconds: 1800,
  maxSpanSeconds: 1800,
  maxReturnSpanSeconds: 10_800,
  maxReturnDistanceMeters: 1000,
  maxBurstPoints: 8,
  minDeviationMeters: 1000,
  minDetourRatio: 4,
  minSpeedKmh: 150,
  highSpeedKmh: 500,
  hardSpeedKmh: 1500,
  contextSpeedFactor: 3,
  maxPasses: 3,
};

export interface Excursion {
  pointIds: number[];
  keptInteriorIds: number[];
  device: string | null;
  beforeId: number;
  afterId: number;
  confidence: "high" | "review";
  reason: "return_spike" | "excursion_burst" | "long_return_spike" | "long_excursion_burst";
  entrySpeedKmh: number;
  exitSpeedKmh: number;
  bypassSpeedKmh: number;
  thresholdKmh: number;
  maxDeviationMeters: number;
  detourRatio: number;
  spanSeconds: number;
  trustedContextSides: number;
  pass: number;
  historicalMatches: HistoricalMatch[];
}

export interface HistoricalMatch {
  pointId: number;
  previousId: number;
  previousTimestamp: number;
  distanceMeters: number;
  ageSeconds: number;
  searchComplete: boolean;
}

// Supplementary evidence only. Recurring visits never create an excursion or
// change its confidence. A full day separates the reference from this episode.
export const HISTORY_RADIUS_METERS = 100;
export const HISTORY_MIN_AGE_SECONDS = 86_400;
export const HISTORY_QUERY_LIMIT = 64;

export interface TrackEdge {
  device: string | null;
  beforeId: number;
  afterId: number;
  seconds: number;
  distanceMeters: number;
  speedKmh: number | null;
}

export const DETECTOR_VERSION = "excursion-v3-experimental";

export interface TrajectoryAnalysis {
  version: typeof DETECTOR_VERSION;
  options: DetectorOptions;
  inputPoints: number;
  invalidPointIds: number[];
  duplicateGroups: number[][];
  conflictingTimestampGroups: number[][];
  excursions: Excursion[];
  unresolvedJumps: TrackEdge[];
  gaps: TrackEdge[];
}

const RAD = Math.PI / 180;
const EARTH_RADIUS = 6_371_008.8;

function validPoint(p: TrackPoint): boolean {
  return [p.latitude, p.longitude, p.timestamp].every(Number.isFinite) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180
    && Number.isSafeInteger(p.timestamp) && p.timestamp >= 0 && p.timestamp <= 8_640_000_000_000_000;
}

export function greatCircleDistance(a: Pick<TrackPoint, "latitude" | "longitude">, b: Pick<TrackPoint, "latitude" | "longitude">): number {
  const lat1 = a.latitude * RAD, lat2 = b.latitude * RAD;
  const dlat = lat2 - lat1, dlon = (b.longitude - a.longitude) * RAD;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}

export function matchHistoricalLocation(point: TrackPoint, history: readonly TrackPoint[], searchComplete = true): HistoricalMatch | null {
  if (point.device === null || !validPoint(point)) return null;
  let nearest: TrackPoint | null = null, distance = Infinity;
  for (const previous of history) {
    if (previous.id === point.id || previous.device !== point.device || !validPoint(previous)
      || point.timestamp - previous.timestamp < HISTORY_MIN_AGE_SECONDS * 1000) continue;
    const meters = greatCircleDistance(point, previous);
    if (meters > HISTORY_RADIUS_METERS) continue;
    if (meters < distance || (meters === distance && (!nearest || previous.timestamp > nearest.timestamp
      || (previous.timestamp === nearest.timestamp && previous.id < nearest.id)))) {
      distance = meters; nearest = previous;
    }
  }
  return nearest ? { pointId: point.id, previousId: nearest.id, previousTimestamp: nearest.timestamp,
    distanceMeters: distance, ageSeconds: (point.timestamp - nearest.timestamp) / 1000, searchComplete } : null;
}

// Bounding box for an indexed lookup, followed by an exact spherical check.
// Split longitude at the date line; a circle touching a pole spans all longitudes.
export function historicalSearchBounds(point: TrackPoint) {
  const angle = HISTORY_RADIUS_METERS / EARTH_RADIUS, latitudeDelta = angle / RAD;
  const minLatitude = Math.max(-90, point.latitude - latitudeDelta), maxLatitude = Math.min(90, point.latitude + latitudeDelta);
  const delta = minLatitude === -90 || maxLatitude === 90 ? 180 : Math.asin(Math.sin(angle) / Math.cos(point.latitude * RAD)) / RAD;
  const low = point.longitude - delta, high = point.longitude + delta;
  const longitudeRanges: [number, number][] = delta === 180 ? [[-180, 180]]
    : low < -180 ? [[-180, high], [low + 360, 180]]
    : high > 180 ? [[low, 180], [-180, high - 360]] : [[low, high]];
  return { minLatitude, maxLatitude, longitudeRanges };
}

export function historicalExcludedIds(analysis: TrajectoryAnalysis): Set<number> {
  const excluded = new Set([...analysis.invalidPointIds, ...analysis.conflictingTimestampGroups.flat(),
    ...analysis.excursions.flatMap(c => c.pointIds), ...analysis.unresolvedJumps.flatMap(e => [e.beforeId, e.afterId])]);
  for (const ids of analysis.duplicateGroups) if (ids.some(id => excluded.has(id))) for (const id of ids) excluded.add(id);
  return excluded;
}

// Time-weighted interpolation on the sphere, including date-line crossings.
function expectedPosition(a: TrackPoint, b: TrackPoint, time: number) {
  const vector = (p: TrackPoint) => [Math.cos(p.latitude * RAD) * Math.cos(p.longitude * RAD),
    Math.cos(p.latitude * RAD) * Math.sin(p.longitude * RAD), Math.sin(p.latitude * RAD)];
  const x = vector(a), y = vector(b);
  const angle = Math.acos(Math.max(-1, Math.min(1, x.reduce((sum, v, i) => sum + v * y[i], 0))));
  if (angle > Math.PI - 1e-6) return null; // An antipodal bridge is ambiguous.
  const fraction = (time - a.timestamp) / (b.timestamp - a.timestamp);
  const denominator = Math.sin(angle);
  const u = angle < 1e-8 ? 1 - fraction : Math.sin((1 - fraction) * angle) / denominator;
  const v = angle < 1e-8 ? fraction : Math.sin(fraction * angle) / denominator;
  const z = x.map((coordinate, i) => u * coordinate + v * y[i]);
  return { longitude: Math.atan2(z[1], z[0]) / RAD, latitude: Math.atan2(z[2], Math.hypot(z[0], z[1])) / RAD };
}

function edge(a: TrackPoint, b: TrackPoint): TrackEdge {
  const seconds = (b.timestamp - a.timestamp) / 1000;
  const distanceMeters = greatCircleDistance(a, b);
  return { device: a.device, beforeId: a.id, afterId: b.id, seconds, distanceMeters,
    speedKmh: seconds > 0 ? distanceMeters / seconds * 3.6 : null };
}

// Fixed endpoints and a speed constraint form a time-ordered DAG. Its longest
// path retains the most observations; distance breaks ties deterministically.
// This avoids assuming that every good observation lies on one straight line.
function compatiblePath(points: TrackPoint[], threshold: number, maxGapSeconds: number): TrackPoint[] | null {
  const lengths = points.map(() => 0), distances = points.map(() => Infinity), previous = points.map(() => -1);
  lengths[0] = 1; distances[0] = 0;
  for (let i = 1; i < points.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!lengths[j]) continue;
      const e = edge(points[j], points[i]);
      if (e.seconds <= 0 || e.seconds > maxGapSeconds || e.speedKmh! > threshold) continue;
      const length = lengths[j] + 1, distance = distances[j] + e.distanceMeters;
      if (length > lengths[i] || (length === lengths[i] && distance < distances[i])) {
        lengths[i] = length; distances[i] = distance; previous[i] = j;
      }
    }
  }
  if (!lengths.at(-1)) return null;
  const path: TrackPoint[] = [];
  for (let i = points.length - 1; i >= 0; i = previous[i]) path.push(points[i]);
  return path.reverse();
}

function candidate(points: TrackPoint[], start: number, end: number, options: DetectorOptions, pass: number): Excursion | null {
  const a = points[start - 1], b = points[end + 1];
  const spanSeconds = (b.timestamp - a.timestamp) / 1000;
  const window = points.slice(start - 1, end + 2);
  const longReturn = spanSeconds > options.maxSpanSeconds
    || window.slice(1).some((p, i) => (p.timestamp - window[i].timestamp) / 1000 > options.maxGapSeconds);
  const maxGapSeconds = longReturn ? options.maxReturnSpanSeconds : options.maxGapSeconds;
  if (spanSeconds <= 0 || spanSeconds > (longReturn ? options.maxReturnSpanSeconds : options.maxSpanSeconds)) return null;
  const entry = edge(a, points[start]), exit = edge(points[end], b), bypass = edge(a, b);
  if (entry.speedKmh === null || exit.speedKmh === null || bypass.speedKmh === null) return null;
  // Sparse observations can conceal a real trip or a flight. Attribute a long
  // return only when it returns near its origin and contains a physically
  // extreme boundary jump, rather than classifying ordinary fast travel.
  if (longReturn && (bypass.distanceMeters > options.maxReturnDistanceMeters
    || Math.max(entry.speedKmh, exit.speedKmh) <= options.hardSpeedKmh)) return null;
  const bridgeThreshold = Math.max(options.minSpeedKmh, bypass.speedKmh * options.contextSpeedFactor + 30);
  if (Math.min(entry.speedKmh, exit.speedKmh) <= bridgeThreshold) return null;

  const contexts: TrackEdge[] = [];
  if (start >= 2) contexts.push(edge(points[start - 2], a));
  if (end + 2 < points.length) contexts.push(edge(b, points[end + 2]));
  const nearbyContexts = contexts.filter(e => e.seconds > 0 && e.seconds <= maxGapSeconds);
  // An anchor adjacent to another jump is not reliable. Broaden the window
  // instead of labelling the good point between two bad clusters.
  const contextCap = Math.max(350, bypass.speedKmh * options.contextSpeedFactor + 30);
  if (nearbyContexts.some(e => e.speedKmh! > contextCap)) return null;
  // An old observation supports a long-return anchor only if it is also
  // spatially close. A low average speed across a long journey is insufficient.
  const trustedContexts = longReturn
    ? nearbyContexts.filter(e => e.distanceMeters <= options.maxReturnDistanceMeters) : nearbyContexts;
  if (longReturn && !trustedContexts.length) return null;
  const localSpeed = trustedContexts.length ? trustedContexts.reduce((sum, e) => sum + e.speedKmh!, 0) / trustedContexts.length : 0;
  const threshold = Math.max(bridgeThreshold, localSpeed * options.contextSpeedFactor + 30);
  if (Math.min(entry.speedKmh, exit.speedKmh) <= threshold) return null;

  const kept = compatiblePath(window, threshold, maxGapSeconds);
  if (!kept || kept.length === window.length) return null;
  const retained = new Set(kept.map(p => p.id));
  let rawDistance = 0, maxDeviation = 0, pathIndex = 0;
  const bad: TrackPoint[] = [];
  for (let i = start; i <= end + 1; i++) {
    const segment = edge(points[i - 1], points[i]);
    if (segment.seconds <= 0 || segment.seconds > maxGapSeconds) return null;
    rawDistance += segment.distanceMeters;
    if (i > end) break;
    if (retained.has(points[i].id)) continue;
    while (kept[pathIndex + 1].timestamp < points[i].timestamp) pathIndex++;
    const predicted = expectedPosition(kept[pathIndex], kept[pathIndex + 1], points[i].timestamp);
    if (!predicted) return null;
    const deviation = greatCircleDistance(points[i], predicted);
    maxDeviation = Math.max(maxDeviation, deviation);
    // Small differences are not sufficient evidence of a bad observation.
    if (deviation < options.minDeviationMeters) return null;
    bad.push(points[i]);
  }
  if (!bad.length || bad[0].id !== points[start].id || bad.at(-1)!.id !== points[end].id) return null;
  const detourRatio = rawDistance / Math.max(bypass.distanceMeters, 100);
  if (detourRatio < options.minDetourRatio) return null;
  const high = Math.min(entry.speedKmh, exit.speedKmh) >= Math.max(options.highSpeedKmh, threshold)
    && trustedContexts.length === 2;
  return {
    device: a.device, pointIds: bad.map(p => p.id), keptInteriorIds: kept.slice(1, -1).map(p => p.id),
    beforeId: a.id, afterId: b.id, confidence: high ? "high" : "review",
    reason: longReturn ? (bad.length === 1 ? "long_return_spike" : "long_excursion_burst")
      : (bad.length === 1 ? "return_spike" : "excursion_burst"), entrySpeedKmh: entry.speedKmh,
    exitSpeedKmh: exit.speedKmh, bypassSpeedKmh: bypass.speedKmh, thresholdKmh: threshold,
    maxDeviationMeters: maxDeviation, detourRatio, spanSeconds, trustedContextSides: trustedContexts.length, pass, historicalMatches: [],
  };
}

function candidates(points: TrackPoint[], options: DetectorOptions, pass: number): Excursion[] {
  const result: Excursion[] = [];
  for (let start = 1; start < points.length - 1; start++) {
    for (let end = start; end < Math.min(points.length - 1, start + options.maxBurstPoints); end++) {
      const finding = candidate(points, start, end, options, pass);
      if (finding) result.push(finding);
    }
  }
  const score = (c: Excursion) => Math.min(c.entrySpeedKmh, c.exitSpeedKmh) / c.thresholdKmh
    * Math.log1p(c.maxDeviationMeters / options.minDeviationMeters) * Math.log1p(c.detourRatio) / Math.sqrt(c.pointIds.length);
  return result.sort((a, b) => score(b) - score(a) || a.beforeId - b.beforeId || a.afterId - b.afterId);
}

function select(candidates: Excursion[], protectedIds: ReadonlySet<number>): Excursion[] {
  const selected: Excursion[] = [], flagged = new Set<number>(), anchors = new Set<number>();
  for (const c of candidates) {
    if ([c.beforeId, c.afterId, ...c.keptInteriorIds].some(id => flagged.has(id))
      || c.pointIds.some(id => flagged.has(id) || anchors.has(id) || protectedIds.has(id))) continue;
    selected.push(c);
    for (const id of c.pointIds) flagged.add(id);
    for (const id of [c.beforeId, c.afterId, ...c.keptInteriorIds]) anchors.add(id);
  }
  return selected;
}

export function analyzeTrajectory(input: readonly TrackPoint[], overrides: Partial<DetectorOptions> = {}): TrajectoryAnalysis {
  const options = { ...DEFAULT_DETECTOR_OPTIONS, ...overrides };
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid detector option: ${key}`);
  }
  if (!Number.isInteger(options.maxBurstPoints) || options.maxBurstPoints > 32 || !Number.isInteger(options.maxPasses) || options.maxPasses > 10) {
    throw new RangeError("Detector iteration/window bounds are invalid");
  }
  const result: TrajectoryAnalysis = { version: DETECTOR_VERSION, options, inputPoints: input.length,
    invalidPointIds: [], duplicateGroups: [], conflictingTimestampGroups: [], excursions: [], unresolvedJumps: [], gaps: [] };
  const groups = new Map<string | null, TrackPoint[]>();
  for (const p of input) {
    if (!validPoint(p)) {
      result.invalidPointIds.push(p.id); continue;
    }
    const group = groups.get(p.device) ?? [];
    group.push(p); groups.set(p.device, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    const tracks: TrackPoint[][] = [[]];
    for (let i = 0; i < group.length;) {
      let end = i + 1;
      while (end < group.length && group[end].timestamp === group[i].timestamp) end++;
      const sameTime = group.slice(i, end);
      if (sameTime.length === 1) tracks.at(-1)!.push(sameTime[0]);
      else if (sameTime.every(p => p.longitude === sameTime[0].longitude && p.latitude === sameTime[0].latitude)) {
        result.duplicateGroups.push(sameTime.map(p => p.id)); tracks.at(-1)!.push(sameTime[0]);
      } else {
        result.conflictingTimestampGroups.push(sameTime.map(p => p.id));
        tracks.push([]); // Conflicting observations cannot serve as a bridge.
      }
      i = end;
    }
    for (const points of tracks) {
      for (let i = 1; i < points.length; i++) {
        const e = edge(points[i - 1], points[i]);
        if (e.seconds > options.maxGapSeconds) result.gaps.push(e);
      }
      let working = points;
      const protectedIds = new Set<number>();
      const protect = (findings: Excursion[]) => {
        for (const c of findings) for (const id of [c.beforeId, c.afterId, ...c.keptInteriorIds]) protectedIds.add(id);
      };
      for (let pass = 1; pass <= options.maxPasses; pass++) {
        const high = select(candidates(working, options, pass).filter(c => c.confidence === "high"), protectedIds);
        if (!high.length) break;
        result.excursions.push(...high);
        protect(high);
        const flagged = new Set(high.flatMap(c => c.pointIds));
        working = working.filter(p => !flagged.has(p.id));
      }
      const review = select(candidates(working, options, options.maxPasses + 1), protectedIds);
      // The final pass can also contain high-confidence candidates if the bound
      // was reached. Nothing is written back to the input or the database.
      result.excursions.push(...review);
      const known = new Set(result.excursions.filter(c => c.device === group[0].device).flatMap(c => c.pointIds));
      for (let i = 1; i < working.length; i++) {
        const e = edge(working[i - 1], working[i]);
        if (e.speedKmh !== null && e.speedKmh > options.hardSpeedKmh && !known.has(e.beforeId) && !known.has(e.afterId)) result.unresolvedJumps.push(e);
      }
    }
  }
  // Attach history after all geometric decisions, so familiar locations cannot
  // bias candidate selection. Uncertain/candidate references are excluded.
  const excluded = historicalExcludedIds(result);
  const history = input.filter(p => !excluded.has(p.id));
  const byId = new Map(input.map(p => [p.id, p]));
  for (const excursion of result.excursions) {
    const ids = new Set(excursion.pointIds);
    for (const group of result.duplicateGroups) if (group.some(id => ids.has(id))) for (const id of group) ids.add(id);
    excursion.historicalMatches = [...ids].flatMap(id => {
      const match = matchHistoricalLocation(byId.get(id)!, history);
      return match ? [match] : [];
    });
  }
  return result;
}
