// Offline timezone backfill for the isolated Console preview database.
// Writes only with --apply-local; never opens a remote connection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
assert(args.length <= 1 && (!args.length || args[0] === '--apply-local'), 'Usage: node scripts/trajectory/backfill-timezone.mjs [--apply-local]');
const apply = args[0] === '--apply-local';
const require = createRequire(resolve(root, 'worker/package.json'));
const { find } = require('geo-tz');
const version = JSON.parse(await readFile(resolve(root, 'worker/node_modules/geo-tz/package.json'), 'utf8')).version;
const d1Path = resolve(root, '.local/console-preview/d1/v3/d1/miniflare-D1DatabaseObject');
const paths = (await readdir(d1Path)).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
assert.equal(paths.length, 1, 'Expected one isolated Console preview database.');
const db = new DatabaseSync(resolve(d1Path, paths[0]), { readOnly: !apply });
db.exec('PRAGMA busy_timeout = 5000;');
const rows = () => db.prepare('SELECT ID, Longitude, Latitude, City, Device, Date, Timezone FROM Locations ORDER BY ID').all();
const rawValues = rows => rows.map(({ Timezone, ...raw }) => raw);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const otherValues = () => ['Projects', 'LocationQuality', 'LocationAnalysisState'].map(table =>
  db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'LocationQuality' ? 'LocationID' : table === 'LocationAnalysisState' ? 'Device' : 'ID'}`).all());
const formatters = new Map();
function offset(timestamp, zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' });
    formatters.set(zone, formatter);
  }
  const label = formatter.formatToParts(timestamp).find(part => part.type === 'timeZoneName').value;
  if (label === 'GMT') return 0;
  const match = label.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  assert(match, `Unsupported UTC offset: ${label}`);
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) / 60;
}
let transaction = false;
try {
  assert(db.prepare('PRAGMA table_info(Locations)').all().some(column => column.name === 'Timezone'), 'Apply migration 0004_location_timezone.sql first.');
  const original = rows(), originalHash = hash(original), rawHash = hash(rawValues(original)), othersHash = hash(otherValues());
  const pending = original.filter(row => row.Timezone === null), updates = [], unresolved = [];
  for (const row of pending) {
    if (!Number.isFinite(row.Latitude) || !Number.isFinite(row.Longitude) || Math.abs(row.Latitude) > 90 || Math.abs(row.Longitude) > 180
      || !Number.isSafeInteger(row.Date) || Number.isNaN(new Date(row.Date).getTime())) {
      unresolved.push({ id: row.ID, reason: 'invalid_observation' }); continue;
    }
    try {
      const zones = find(row.Latitude, row.Longitude);
      // Overlapping Xinjiang conventions have two offsets; use Beijing time
      // for Chinese historical records when that zone is among the candidates.
      const zone = zones.includes('Asia/Shanghai') ? 'Asia/Shanghai' : zones[0];
      const candidates = zones.map(timeZone => ({ timeZone, timezone: offset(row.Date, timeZone) }));
      if (!zone || (!zones.includes('Asia/Shanghai') && new Set(candidates.map(candidate => candidate.timezone)).size > 1)) {
        unresolved.push({ id: row.ID, reason: 'ambiguous_timezone', candidates }); continue;
      }
      const timezone = offset(row.Date, zone);
      assert(timezone >= -12 && timezone <= 14);
      updates.push({ id: row.ID, timezone, timeZone: zone, timestamp: row.Date, latitude: row.Latitude, longitude: row.Longitude });
    } catch (error) { unresolved.push({ id: row.ID, reason: 'lookup_failed', message: error.message }); }
    if ((updates.length + unresolved.length) % 5000 === 0) console.log(JSON.stringify({ processed: updates.length + unresolved.length, total: pending.length }));
  }
  const output = resolve(root, '.local/console-preview/timezone-backfill', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sql = updates.map(row => `UPDATE Locations SET Timezone = ${row.timezone} WHERE ID = ${row.id} AND Date = ${row.timestamp} AND Longitude = ${row.longitude} AND Latitude = ${row.latitude} AND Timezone IS NULL;`).join('\n') + '\n';
  await writeFile(resolve(output, 'offsets.json'), JSON.stringify(updates, null, 2), { mode: 0o600 });
  await writeFile(resolve(output, 'backfill.sql'), sql, { mode: 0o600 });
  let backupPath = null;
  if (apply && updates.length) {
    backupPath = resolve(output, 'before.sqlite');
    await backup(db, backupPath); await chmod(backupPath, 0o600);
    db.exec('BEGIN IMMEDIATE;'); transaction = true;
    assert.equal(hash(rows()), originalHash, 'Locations changed while calculating timezones. Run again.');
    assert.equal(hash(otherValues()), othersHash, 'Related records changed while calculating timezones. Run again.');
    const update = db.prepare('UPDATE Locations SET Timezone = ? WHERE ID = ? AND Date = ? AND Longitude = ? AND Latitude = ? AND Timezone IS NULL');
    for (const row of updates) assert.equal(update.run(row.timezone, row.id, row.timestamp, row.longitude, row.latitude).changes, 1);
    assert.equal(hash(rawValues(rows())), rawHash, 'Original locations must remain unchanged.');
    assert.equal(hash(otherValues()), othersHash, 'Projects and quality analysis must remain unchanged.');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.exec('COMMIT;'); transaction = false;
  }
  const counts = {};
  for (const row of updates) counts[row.timezone] = (counts[row.timezone] ?? 0) + 1;
  const manifest = { scope: 'local-console-preview', applied: apply, total: original.length, alreadyRecorded: original.length - pending.length,
    calculated: updates.length, unresolved, counts, lookup: 'geo-tz', version, node: process.version, tzdb: process.versions.tz,
    originalLocationsSha256: rawHash, originalRecordsUnchanged: true, backup: backupPath };
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ applied: apply, total: original.length, alreadyRecorded: manifest.alreadyRecorded,
    calculated: updates.length, unresolved: unresolved.length, counts, output }, null, 2));
} catch (error) {
  if (transaction) db.exec('ROLLBACK;'); throw error;
} finally { db.close(); }
