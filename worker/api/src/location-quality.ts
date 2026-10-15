import { analyzeTrajectory, DEFAULT_DETECTOR_OPTIONS, DETECTOR_VERSION, historicalExcludedIds, historicalSearchBounds,
  HISTORY_MIN_AGE_SECONDS, HISTORY_QUERY_LIMIT, matchHistoricalLocation, type TrackPoint, type TrajectoryAnalysis } from "./trajectory";
import type { LocationInput, LocationRow } from "./types";

export const QUALITY_VERSION = DETECTOR_VERSION;
const WINDOW_SIDE = 64;
// A pass can remove at most eight consecutive points around a candidate.
// Leave a wider guard on both sides of the points whose labels we update.
const UPDATE_SIDE = DEFAULT_DETECTOR_OPTIONS.maxBurstPoints * DEFAULT_DETECTOR_OPTIONS.maxPasses + 3;
const ANALYSIS_ATTEMPTS = 2;
// History is supplementary. Keep its request budget small even in a dense burst.
const HISTORY_LOOKUPS_PER_ATTEMPT = 2;

export type QualityStatus = "pending" | "retained" | "outlier" | "review" | "uncertain";
export interface QualityRow {
  LocationID: number;
  Status: QualityStatus;
  Reason: string;
  AlgorithmVersion: string;
  Revision: number;
  CheckedAt: number;
  Evidence: string;
}
export interface LocationWithQuality extends LocationRow {
  QualityStatus: QualityStatus | null;
  QualityReason: string | null;
  QualityVersion: string | null;
  QualityCheckedAt: number | null;
  QualityEvidence: string | null;
}
export const QUALITY_COLUMNS = `l.*, q.Status AS QualityStatus, q.Reason AS QualityReason,
  q.AlgorithmVersion AS QualityVersion, q.CheckedAt AS QualityCheckedAt, q.Evidence AS QualityEvidence`;
export const QUALITY_JOIN = "Locations l LEFT JOIN LocationQuality q ON q.LocationID = l.ID";

export function qualityJson(row: QualityRow | LocationWithQuality | null) {
  if (!row) return { status: "unassessed", reason: "not_analyzed", version: null, checkedAt: null, evidence: null };
  if ("LocationID" in row) return { status: row.Status, reason: row.Reason, version: row.AlgorithmVersion,
    checkedAt: row.CheckedAt, evidence: JSON.parse(row.Evidence) as unknown };
  return { status: row.QualityStatus ?? "unassessed", reason: row.QualityReason ?? "not_analyzed",
    version: row.QualityVersion, checkedAt: row.QualityCheckedAt,
    evidence: row.QualityEvidence === null ? null : JSON.parse(row.QualityEvidence) as unknown };
}

export async function ingestLocation(db: D1Database, input: LocationInput): Promise<LocationRow> {
  // D1 batch is a transaction: the observation, revision and pending annotation
  // either all commit or all roll back. Same-device arrivals advance a counter.
  const results = await db.batch<LocationRow & { Revision: number }>([
    db.prepare(`INSERT INTO LocationAnalysisState (Device, Revision) VALUES (?, 1)
      ON CONFLICT(Device) DO UPDATE SET Revision = Revision + 1 RETURNING Revision`).bind(input.device),
    db.prepare("INSERT INTO Locations (Longitude, Latitude, City, Device, Date, Timezone) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
      .bind(input.longitude, input.latitude, input.city, input.device, input.timestamp, input.timezone),
    db.prepare(`INSERT INTO LocationQuality (LocationID, Status, Reason, AlgorithmVersion, Revision, CheckedAt, Evidence)
      SELECT l.ID, 'pending', 'awaiting_context', ?, s.Revision, ?, '{}'
      FROM Locations l JOIN LocationAnalysisState s ON s.Device = l.Device
      WHERE l.Device = ? ORDER BY l.ID DESC LIMIT 1`).bind(QUALITY_VERSION, Date.now(), input.device),
  ]);
  const row = results[1].results[0];
  if (!row) throw new Error("Location insert did not return a row");
  return row;
}

interface WindowSnapshot {
  revision: number;
  rows: SnapshotRow[];
  targetIndex: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}

interface SnapshotRow extends LocationWithQuality {
  SnapshotRevision: number;
  QualityRevision: number | null;
}

interface HistoryRow extends LocationRow { ReferenceStatus: QualityStatus | null }

async function loadWindow(db: D1Database, target: LocationRow): Promise<WindowSnapshot> {
  // Both indexed ranges, revision and prior annotations come from one SQL
  // snapshot. Sorting is bounded to the two small ranges, not device history.
  const results = await db.batch<SnapshotRow>([
    db.prepare(`SELECT ${QUALITY_COLUMNS}, q.Revision AS QualityRevision,
      (SELECT Revision FROM LocationAnalysisState WHERE Device = ?) AS SnapshotRevision
      FROM (
        SELECT * FROM (SELECT * FROM Locations WHERE Device = ? AND (Date, ID) <= (?, ?)
          ORDER BY Date DESC, ID DESC LIMIT ?)
        UNION ALL
        SELECT * FROM (SELECT * FROM Locations WHERE Device = ? AND (Date, ID) > (?, ?)
          ORDER BY Date ASC, ID ASC LIMIT ?)
      ) l LEFT JOIN LocationQuality q ON q.LocationID = l.ID ORDER BY l.Date, l.ID`)
      .bind(target.Device, target.Device, target.Date, target.ID, WINDOW_SIDE + 2,
        target.Device, target.Date, target.ID, WINDOW_SIDE + 1),
  ]);
  const before = results[0].results.filter(row => row.Date < target.Date || (row.Date === target.Date && row.ID <= target.ID));
  const after = results[0].results.filter(row => row.Date > target.Date || (row.Date === target.Date && row.ID > target.ID));
  const left = before.slice(-(WINDOW_SIDE + 1)), right = after.slice(0, WINDOW_SIDE);
  const revision = left.at(-1)?.SnapshotRevision;
  if (!revision || left.at(-1)?.ID !== target.ID) throw new Error("Analysis snapshot is incomplete");
  return { revision, rows: [...left, ...right], targetIndex: left.length - 1,
    truncatedBefore: before.length > WINDOW_SIDE + 1, truncatedAfter: after.length > WINDOW_SIDE };
}

function stableJson(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, sorted(entry)])) : v;
  return JSON.stringify(sorted(value));
}

function parsedEvidence(value: string | null): Record<string, unknown> | null {
  try {
    const evidence: unknown = value === null ? null : JSON.parse(value);
    return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : null;
  } catch { return null; }
}

function priorLabel(row: SnapshotRow): QualityRow | null {
  if (row.QualityStatus === null) return null;
  return { LocationID: row.ID, Status: row.QualityStatus, Reason: row.QualityReason!,
    AlgorithmVersion: row.QualityVersion!, Revision: row.QualityRevision!,
    CheckedAt: row.QualityCheckedAt!, Evidence: row.QualityEvidence! };
}

function labelChanged(label: QualityRow, previous: QualityRow | null): boolean {
  return !previous || label.Status !== previous.Status || label.Reason !== previous.Reason
    || label.AlgorithmVersion !== previous.AlgorithmVersion
    || stableJson(parsedEvidence(label.Evidence)) !== stableJson(parsedEvidence(previous.Evidence));
}

function annotate(snapshot: WindowSnapshot): { analysis: TrajectoryAnalysis; labels: QualityRow[] } {
  const { rows, targetIndex, revision } = snapshot;
  const analysis = analyzeTrajectory(rows.map(row => ({ id: row.ID, device: row.Device,
    timestamp: row.Date, longitude: row.Longitude, latitude: row.Latitude })));
  const checkedAt = Date.now(), labels = new Map<number, QualityRow>();
  const timestamps = Array.from(new Set(rows.map(row => row.Date))).sort((a, b) => a - b);
  const timeIndex = new Map(timestamps.map((time, index) => [time, index]));
  for (let i = 0; i < rows.length; i++) {
    const pending = timeIndex.get(rows[i].Date)! >= timestamps.length - 2;
    labels.set(rows[i].ID, { LocationID: rows[i].ID, Status: pending ? "pending" : "retained",
      Reason: pending ? "awaiting_context" : "no_excursion_detected", AlgorithmVersion: QUALITY_VERSION,
      Revision: revision, CheckedAt: checkedAt, Evidence: "{}" });
  }
  const set = (ids: number[], status: QualityStatus, reason: string, evidence: unknown) => {
    for (const id of ids) {
      const label = labels.get(id);
      if (label) Object.assign(label, { Status: status, Reason: reason, Evidence: JSON.stringify(evidence) });
    }
  };
  for (const e of analysis.gaps) set([e.beforeId, e.afterId], "uncertain", "sampling_gap", e);
  for (const e of analysis.unresolvedJumps) set([e.beforeId, e.afterId], "uncertain", "unresolved_jump", e);
  for (const ids of analysis.conflictingTimestampGroups) set(ids, "uncertain", "conflicting_timestamp", { pointIds: ids });
  set(analysis.invalidPointIds, "uncertain", "invalid_observation", {});
  for (const c of analysis.excursions) set(c.pointIds, c.confidence === "high" ? "outlier" : "review", c.reason, c);
  // The detector collapses exact duplicates in its working view. Propagate the
  // representative's annotation so duplicates cannot bypass the filtered view.
  for (const ids of analysis.duplicateGroups) {
    const representative = labels.get(ids[0])!;
    for (const id of ids.slice(1)) labels.set(id, { ...representative, LocationID: id });
  }
  const core = rows.slice(Math.max(0, targetIndex - UPDATE_SIDE), targetIndex + UPDATE_SIDE + 1);
  const affected = new Set(core.map(row => row.ID));
  for (const ids of analysis.duplicateGroups) if (ids.some(id => affected.has(id))) for (const id of ids) affected.add(id);
  for (const ids of analysis.conflictingTimestampGroups) if (ids.some(id => affected.has(id))) for (const id of ids) affected.add(id);
  // Boundaries are conservative. Do not infer a normal observation where the
  // detector's possible supporting context was clipped by the query limit.
  for (const row of core) {
    const index = rows.indexOf(row), label = labels.get(row.ID)!;
    if ((snapshot.truncatedBefore && index < UPDATE_SIDE)
      || (snapshot.truncatedAfter && index >= rows.length - UPDATE_SIDE)) {
      Object.assign(label, { Status: "uncertain", Reason: "truncated_context", Evidence: "{}" });
    }
  }
  return { analysis, labels: Array.from(labels.values()).filter(label => affected.has(label.LocationID)) };
}

async function addHistoricalEvidence(db: D1Database, snapshot: WindowSnapshot, analysis: TrajectoryAnalysis, labels: QualityRow[]) {
  const previousRows = new Map(snapshot.rows.map(row => [row.ID, row]));
  const currentLabels = new Map(labels.map(label => [label.LocationID, label]));
  const excluded = historicalExcludedIds(analysis);
  for (const label of labels) if (label.Status !== "retained") excluded.add(label.LocationID);
  // A late report can add old visits or change their quality. Refresh history
  // then; otherwise reuse completed evidence for the same candidate segment.
  const lateReport = snapshot.rows.at(-1)?.ID !== snapshot.rows[snapshot.targetIndex].ID;
  const allCandidates = labels.filter(label => {
    if (label.Status !== "outlier" && label.Status !== "review") return false;
    const row = previousRows.get(label.LocationID)!;
    const previous = parsedEvidence(row.QualityEvidence), current = parsedEvidence(label.Evidence)!;
    const search = previous?.historicalSearch as { complete?: boolean } | null | undefined;
    const sameSegment = previous && previous.beforeId === current.beforeId && previous.afterId === current.afterId
      && stableJson(previous.pointIds) === stableJson(current.pointIds)
      && stableJson(previous.keptInteriorIds) === stableJson(current.keptInteriorIds);
    if (!lateReport && row.QualityVersion === QUALITY_VERSION && row.QualityReason === label.Reason
      && (row.QualityStatus === "outlier" || row.QualityStatus === "review") && sameSegment
      && Array.isArray(previous.historicalMatches) && (search === undefined || search?.complete === true)
      && previous.historicalMatches.every(m => m && typeof m === "object" && m.searchComplete === true
        && !excluded.has(m.previousId))) {
      label.Evidence = JSON.stringify({ ...current, historicalMatches: previous.historicalMatches,
        ...(previous.historicalSearch === undefined ? {} : { historicalSearch: previous.historicalSearch }) });
      return false;
    }
    return true;
  });
  if (!allCandidates.length) return;
  const indices = new Map(snapshot.rows.map((row, index) => [row.ID, index]));
  allCandidates.sort((a, b) => Math.abs(indices.get(a.LocationID)! - snapshot.targetIndex)
    - Math.abs(indices.get(b.LocationID)! - snapshot.targetIndex) || a.LocationID - b.LocationID);
  const candidates = allCandidates.slice(0, HISTORY_LOOKUPS_PER_ATTEMPT);
  for (const label of allCandidates.slice(HISTORY_LOOKUPS_PER_ATTEMPT)) {
    label.Evidence = JSON.stringify({ ...JSON.parse(label.Evidence), historicalMatches: [],
      historicalSearch: { complete: false, reason: "candidate_limit" } });
  }
  const toPoint = (row: LocationRow): TrackPoint => ({ id: row.ID, device: row.Device,
    timestamp: row.Date, longitude: row.Longitude, latitude: row.Latitude });
  const byId = new Map(snapshot.rows.map(row => [row.ID, toPoint(row)]));
  const results = await db.batch<HistoryRow>(candidates.map(label => {
    const point = byId.get(label.LocationID)!;
    const bounds = historicalSearchBounds(point);
    const longitudes = bounds.longitudeRanges.map(() => "l.Longitude BETWEEN ? AND ?").join(" OR ");
    // Index order avoids sorting the whole matching history. The sentinel row
    // records truncation; a limited search never claims a globally nearest match.
    // Limit raw spatial candidates before joining annotations. Filtering by
    // retained quality first could scan arbitrarily many rejected old fixes.
    return db.prepare(`SELECT l.*, q.Status AS ReferenceStatus FROM (
      SELECT l.* FROM Locations l INDEXED BY idx_locations_device_latitude_longitude_date
      WHERE l.Device = ? AND l.Latitude BETWEEN ? AND ? AND (${longitudes}) AND l.Date <= ?
      ORDER BY l.Latitude, l.Longitude, l.Date, l.ID LIMIT ?
      ) l LEFT JOIN LocationQuality q ON q.LocationID = l.ID`)
      .bind(point.device, bounds.minLatitude, bounds.maxLatitude, ...bounds.longitudeRanges.flat(),
        point.timestamp - HISTORY_MIN_AGE_SECONDS * 1000, HISTORY_QUERY_LIMIT + 1);
  }));
  for (let i = 0; i < candidates.length; i++) {
    const label = candidates[i], point = byId.get(label.LocationID)!;
    const rows = results[i].results, complete = rows.length <= HISTORY_QUERY_LIMIT;
    const match = matchHistoricalLocation(point, rows.slice(0, HISTORY_QUERY_LIMIT)
      .filter(row => (currentLabels.get(row.ID)?.Status ?? row.ReferenceStatus) === "retained" && !excluded.has(row.ID)).map(toPoint), complete);
    // Keep the per-point evidence small and relevant even for a multi-point burst.
    const evidence = JSON.parse(label.Evidence) as Record<string, unknown>;
    label.Evidence = JSON.stringify({ ...evidence, historicalMatches: match ? [match] : [],
      historicalSearch: { complete, candidateLimit: HISTORY_QUERY_LIMIT, returnedCandidates: Math.min(rows.length, HISTORY_QUERY_LIMIT) } });
  }
}

async function saveLabels(db: D1Database, device: string, revision: number, labels: QualityRow[]): Promise<boolean> {
  if (!labels.length) {
    // Even a no-op analysis validates its snapshot: a concurrent arrival may
    // already provide the missing future context and require a retry.
    const current = await db.prepare("SELECT Revision FROM LocationAnalysisState WHERE Device = ?").bind(device).first<{ Revision: number }>();
    return current?.Revision === revision;
  }
  // Check the device revision inside the write transaction. An older request
  // cannot overwrite labels computed after a newer observation arrived.
  const result = await db.prepare(`INSERT INTO LocationQuality
    (LocationID, Status, Reason, AlgorithmVersion, Revision, CheckedAt, Evidence)
    SELECT json_extract(value, '$.LocationID'), json_extract(value, '$.Status'),
      json_extract(value, '$.Reason'), json_extract(value, '$.AlgorithmVersion'),
      json_extract(value, '$.Revision'), json_extract(value, '$.CheckedAt'), json_extract(value, '$.Evidence')
    FROM json_each(?) WHERE (SELECT Revision FROM LocationAnalysisState WHERE Device = ?) = ?
    ON CONFLICT(LocationID) DO UPDATE SET Status = excluded.Status, Reason = excluded.Reason,
      AlgorithmVersion = excluded.AlgorithmVersion, Revision = excluded.Revision,
      CheckedAt = excluded.CheckedAt, Evidence = excluded.Evidence
    WHERE excluded.Revision >= LocationQuality.Revision`)
    .bind(JSON.stringify(labels), device, revision).run();
  return result.meta.changes > 0;
}

export async function analyzeRecentLocations(db: D1Database, target: LocationRow) {
  let state: "updated" | "deferred" = "deferred", windowPoints = 0, updatedPoints = 0;
  try {
    for (let attempt = 0; attempt < ANALYSIS_ATTEMPTS; attempt++) {
      const snapshot = await loadWindow(db, target);
      const { analysis, labels } = annotate(snapshot);
      windowPoints = snapshot.rows.length;
      try { await addHistoricalEvidence(db, snapshot, analysis, labels); }
      catch {
        // Optional history must not prevent the primary trajectory annotation.
        for (const label of labels) if (label.Status === "outlier" || label.Status === "review") {
          label.Evidence = JSON.stringify({ ...JSON.parse(label.Evidence), historicalMatches: [],
            historicalSearch: { complete: false, reason: "unavailable" } });
        }
      }
      const previous = new Map(snapshot.rows.map(row => [row.ID, priorLabel(row)]));
      const changed = labels.filter(label => labelChanged(label, previous.get(label.LocationID)!));
      if (await saveLabels(db, target.Device!, snapshot.revision, changed)) {
        const targetLabel = labels.find(label => label.LocationID === target.ID)!;
        const quality = labelChanged(targetLabel, previous.get(target.ID)!) ? targetLabel : previous.get(target.ID)!;
        // Return the accepted snapshot's annotation. A successful request does
        // not need another D1 read merely to fetch the label it just computed.
        return { quality: qualityJson(quality), analysis: { state: "updated" as const,
          windowPoints, updatedPoints: changed.length } };
      }
    }
  } catch {
    // An accepted raw observation must not become a 500 and invite a duplicate
    // retry merely because annotation failed. Its initial pending label remains.
    console.error("Location analysis deferred", { id: target.ID });
  }
  let quality: QualityRow | null = null;
  try { quality = await db.prepare("SELECT * FROM LocationQuality WHERE LocationID = ?").bind(target.ID).first<QualityRow>(); }
  catch { /* Preserve the successful ingest response if this read also fails. */ }
  return { quality: quality ? qualityJson(quality) : { status: "pending", reason: "awaiting_context",
    version: QUALITY_VERSION, checkedAt: null, evidence: null }, analysis: { state, windowPoints, updatedPoints } };
}
