// Populate historical annotations in the isolated Console preview database.
// This command only opens a local SQLite file; it cannot access remote D1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { analyzeTrajectory } from '../../worker/api/src/trajectory.ts';

const [input, flag, replaceVersion, ...extra] = process.argv.slice(2);
if (!input || extra.length || (flag !== undefined && (flag !== '--replace-version' || !replaceVersion))) {
  console.error('Usage: node scripts/trajectory/backfill-local.mjs <analysis-directory> [--replace-version <old-version>]');
  process.exit(1);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const inputPath = resolve(input);
const d1Path = resolve(root, '.local/console-preview/d1/v3/d1/miniflare-D1DatabaseObject');
const paths = (await readdir(d1Path)).filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
assert.equal(paths.length, 1, 'Expected exactly one isolated Console preview database.');
const source = await readFile(resolve(inputPath, 'locations.json'));
const rows = JSON.parse(source);
const projects = JSON.parse(await readFile(resolve(inputPath, 'projects.json'), 'utf8'));
const analysis = JSON.parse(await readFile(resolve(inputPath, 'analysis.json'), 'utf8'));
const summary = JSON.parse(await readFile(resolve(inputPath, 'summary.json'), 'utf8'));
const inputSha256 = createHash('sha256').update(source).digest('hex');
assert.equal(inputSha256, summary.inputSha256, 'Snapshot differs from the analyzed input.');
assert.equal(rows.length, analysis.inputPoints);
const ids = new Set(rows.map(row => row.ID));
assert.equal(ids.size, rows.length, 'Snapshot IDs must be unique.');
if (replaceVersion) assert.notEqual(replaceVersion, analysis.version, 'Refusing to replace annotations with the same version.');
// Recheck with the shared detector before trusting previously saved findings.
assert.deepEqual(analyzeTrajectory(rows.map(row => ({ id: row.ID, device: row.Device,
  timestamp: row.Date, longitude: row.Longitude, latitude: row.Latitude }))), analysis,
  'Saved findings differ from the current detector. Generate and review a new analysis first.');

const byDevice = new Map();
for (const row of rows) {
  const times = byDevice.get(row.Device) ?? new Set();
  times.add(row.Date); byDevice.set(row.Device, times);
}
const trailingTimes = new Map(Array.from(byDevice, ([device, times]) =>
  [device, new Set(Array.from(times).sort((a, b) => b - a).slice(0, 2))]));
const checkedAt = Date.now();
const labels = new Map(rows.map(row => {
  const pending = trailingTimes.get(row.Device).has(row.Date);
  return [row.ID, { LocationID: row.ID, Status: pending ? 'pending' : 'retained',
    Reason: pending ? 'awaiting_context' : 'no_excursion_detected',
    AlgorithmVersion: analysis.version, CheckedAt: checkedAt, Evidence: {} }];
}));
function mark(pointIds, status, reason, evidence) {
  for (const id of pointIds) {
    assert(labels.has(id), `Finding references unknown point ${id}.`);
    Object.assign(labels.get(id), { Status: status, Reason: reason, Evidence: evidence });
  }
}
// A long sampling gap alone does not identify an erroneous endpoint. The
// complete gap list remains in analysis.json instead of inflating candidates.
for (const edge of analysis.unresolvedJumps)
  mark([edge.beforeId, edge.afterId], 'uncertain', 'unresolved_jump', edge);
for (const pointIds of analysis.conflictingTimestampGroups)
  mark(pointIds, 'uncertain', 'conflicting_timestamp', { pointIds });
mark(analysis.invalidPointIds, 'uncertain', 'invalid_observation', {});
for (const excursion of analysis.excursions)
  mark(excursion.pointIds, excursion.confidence === 'high' ? 'outlier' : 'review', excursion.reason, excursion);
for (const pointIds of analysis.duplicateGroups) {
  const representative = labels.get(pointIds[0]);
  assert(representative);
  for (const id of pointIds.slice(1)) {
    assert(labels.has(id)); labels.set(id, { ...representative, LocationID: id });
  }
}

const locationValues = list => list.map(row => [row.ID, row.Longitude, row.Latitude, row.City, row.Device, row.Date])
  .sort((a, b) => a[0] - b[0]);
const projectValues = list => list.map(row => [row.ID, row.Name, row.StartTime, row.EndTime]).sort((a, b) => a[0] - b[0]);
const expectedLocations = locationValues(rows), expectedProjects = projectValues(projects);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outputPath = resolve(root, '.local/console-preview/quality-backfill', new Date(checkedAt).toISOString().replaceAll(':', '-'));
const db = new DatabaseSync(resolve(d1Path, paths[0]));
db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
const checkSource = () => {
  assert.deepEqual(locationValues(db.prepare('SELECT * FROM Locations ORDER BY ID').all()), expectedLocations,
    'Local observations differ from the analyzed snapshot.');
  assert.deepEqual(projectValues(db.prepare('SELECT * FROM Projects ORDER BY ID').all()), expectedProjects,
    'Local projects differ from the analyzed snapshot.');
};
const readQuality = () => db.prepare('SELECT * FROM LocationQuality ORDER BY LocationID').all();
const readState = () => db.prepare('SELECT * FROM LocationAnalysisState ORDER BY Device').all();
let transaction = false;
try {
  checkSource();
  const previousQuality = readQuality(), previousState = readState();
  if (replaceVersion) {
    assert.equal(previousQuality.length, rows.length, 'Replacement requires a completely annotated snapshot.');
    assert(previousQuality.every(row => row.AlgorithmVersion === replaceVersion),
      'Refusing to overwrite annotations from another version.');
  } else assert.equal(previousQuality.length, 0, 'Refusing to overwrite existing annotations.');
  await mkdir(outputPath, { recursive: true, mode: 0o700 });
  const backupPath = resolve(outputPath, 'before.sqlite');
  await backup(db, backupPath); await chmod(backupPath, 0o600);
  db.exec('BEGIN IMMEDIATE;'); transaction = true;
  // Revalidate under the write lock, including arrivals since the backup.
  checkSource();
  assert.deepEqual(readQuality(), previousQuality, 'Annotations changed while preparing the backfill.');
  assert.deepEqual(readState(), previousState, 'Device revisions changed while preparing the backfill.');
  const state = db.prepare(`INSERT INTO LocationAnalysisState (Device, Revision) VALUES (?, 1)
    ON CONFLICT(Device) DO UPDATE SET Revision = Revision + 1 RETURNING Revision`);
  const revisions = new Map(Array.from(byDevice.keys(), device =>
    [device, device === null ? 0 : state.get(device).Revision]));
  const insert = db.prepare(`INSERT INTO LocationQuality
    (LocationID, Status, Reason, AlgorithmVersion, Revision, CheckedAt, Evidence) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(LocationID) DO UPDATE SET Status = excluded.Status, Reason = excluded.Reason,
      AlgorithmVersion = excluded.AlgorithmVersion, Revision = excluded.Revision,
      CheckedAt = excluded.CheckedAt, Evidence = excluded.Evidence`);
  for (const row of rows) {
    const label = labels.get(row.ID); label.Revision = revisions.get(row.Device);
    insert.run(label.LocationID, label.Status, label.Reason, label.AlgorithmVersion,
      label.Revision, label.CheckedAt, JSON.stringify(label.Evidence));
  }
  assert.equal(readQuality().length, rows.length);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  checkSource();
  db.exec('COMMIT;'); transaction = false;
  const counts = Object.fromEntries(db.prepare('SELECT Status, COUNT(*) AS total FROM LocationQuality GROUP BY Status').all()
    .map(row => [row.Status, row.total]));
  const manifest = { scope: 'local-console-preview', database: resolve(d1Path, paths[0]), backup: backupPath,
    inputPath, inputSha256, version: analysis.version, replacesVersion: replaceVersion ?? null,
    checkedAt, totalPoints: rows.length, counts,
    candidateIds: Object.fromEntries(['outlier', 'review', 'uncertain', 'pending'].map(status =>
      [status, Array.from(labels.values()).filter(label => label.Status === status).map(label => label.LocationID).sort((a, b) => a - b)])),
    rawLocationsSha256: hash(expectedLocations), rawProjectsSha256: hash(expectedProjects),
    rawRecordsUnchanged: true, samplingGapEdges: analysis.gaps.length,
    gapPolicy: 'Sampling gaps alone are not labeled as erroneous points; see the original analysis for gap evidence.' };
  await writeFile(resolve(outputPath, 'labels.json'), JSON.stringify(Array.from(labels.values()), null, 2), { mode: 0o600 });
  await writeFile(resolve(outputPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ totalPoints: rows.length, counts, rawRecordsUnchanged: true, output: outputPath }, null, 2));
} catch (error) {
  if (transaction) db.exec('ROLLBACK;');
  throw error;
} finally { db.close(); }
