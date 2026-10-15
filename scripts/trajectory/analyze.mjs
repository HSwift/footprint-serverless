import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { analyzeTrajectory, greatCircleDistance, HISTORY_MIN_AGE_SECONDS, HISTORY_RADIUS_METERS } from '../../worker/api/src/trajectory.ts';

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) {
  console.error('Usage: node scripts/trajectory/analyze.mjs <locations.json> <output-directory>');
  process.exit(1);
}
const inputPath = resolve(input), outputPath = resolve(output);
const source = await readFile(inputPath);
const parsed = JSON.parse(source.toString('utf8'));
const rows = Array.isArray(parsed) ? parsed : parsed.locations;
if (!Array.isArray(rows)) throw new TypeError('Expected an array of locations or { locations: [...] }');
const points = rows.map(row => 'ID' in row
  ? { id: row.ID, device: row.Device, timestamp: row.Date, longitude: row.Longitude, latitude: row.Latitude }
  : { id: row.id, device: row.device, timestamp: row.timestamp, longitude: row.longitude, latitude: row.latitude });
const ids = new Set();
for (const p of points) {
  if (!Number.isSafeInteger(p.id) || ids.has(p.id)) throw new TypeError('Location IDs must be unique integers');
  if (p.device !== null && typeof p.device !== 'string') throw new TypeError(`Invalid device for ID ${p.id}`);
  ids.add(p.id);
}
const started = performance.now();
const analysis = analyzeTrajectory(points);
const elapsedMs = performance.now() - started;
const byId = new Map(points.map(p => [p.id, p]));
const count = result => {
  const high = result.excursions.filter(c => c.confidence === 'high');
  const review = result.excursions.filter(c => c.confidence === 'review');
  return { highSegments: high.length, highPoints: high.flatMap(c => c.pointIds).length,
    reviewSegments: review.length, reviewPoints: review.flatMap(c => c.pointIds).length,
    unresolvedEdges: result.unresolvedJumps.length };
};
const quantiles = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return Object.fromEntries([0.1, 0.5, 0.9, 0.95, 0.99, 0.999].map(q => {
    const index = (sorted.length - 1) * q, lo = Math.floor(index), hi = Math.ceil(index);
    return [`p${q * 100}`, sorted.length ? sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo) : null];
  }));
};
const devices = new Map();
const invalid = new Set(analysis.invalidPointIds);
for (const p of points) {
  if (invalid.has(p.id)) continue;
  const group = devices.get(p.device) ?? [];
  group.push(p); devices.set(p.device, group);
}
const allEdges = [], naiveSpikes = [];
const stats = Array.from(devices, ([device, group]) => {
  group.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const edges = group.slice(1).map((p, i) => {
    const seconds = (p.timestamp - group[i].timestamp) / 1000;
    const distanceMeters = greatCircleDistance(group[i], p);
    return { device, beforeId: group[i].id, afterId: p.id, seconds, distanceMeters,
      speedKmh: seconds > 0 ? distanceMeters / seconds * 3.6 : null };
  });
  allEdges.push(...edges);
  for (let i = 1; i < group.length - 1; i++) {
    const incoming = edges[i - 1], outgoing = edges[i];
    if (incoming.seconds <= 0 || outgoing.seconds <= 0 || Math.max(incoming.seconds, outgoing.seconds) > 1800) continue;
    const bypassDistance = greatCircleDistance(group[i - 1], group[i + 1]);
    const bypassSpeed = bypassDistance / (incoming.seconds + outgoing.seconds) * 3.6;
    const ratio = (incoming.distanceMeters + outgoing.distanceMeters) / Math.max(bypassDistance, 100);
    if (Math.min(incoming.distanceMeters, outgoing.distanceMeters) > 1000
      && Math.min(incoming.speedKmh, outgoing.speedKmh) > 150 && bypassSpeed < 150 && ratio > 4) naiveSpikes.push(group[i].id);
  }
  return { device, points: group.length, firstTime: new Date(group[0].timestamp).toISOString(),
    lastTime: new Date(group.at(-1).timestamp).toISOString(),
    intervalsSeconds: quantiles(edges.filter(e => e.seconds > 0).map(e => e.seconds)),
    speedsKmh: quantiles(edges.filter(e => e.speedKmh !== null).map(e => e.speedKmh)),
    gapsOver30Minutes: edges.filter(e => e.seconds > 1800).length };
});
const sensitivity = [100, 150, 250, 350, 500].map(minSpeedKmh => {
  const result = analyzeTrajectory(points, { minSpeedKmh });
  return { minSpeedKmh, ...count(result), highPointIds: result.excursions.filter(c => c.confidence === 'high').flatMap(c => c.pointIds).toSorted((a, b) => a - b) };
});
const summary = { version: analysis.version, generatedAt: new Date().toISOString(), inputSha256: createHash('sha256').update(source).digest('hex'),
  totalPoints: points.length, devices: stats, options: analysis.options, elapsedMs, ...count(analysis),
  invalidPoints: analysis.invalidPointIds.length, duplicateGroups: analysis.duplicateGroups, conflictingTimestampGroups: analysis.conflictingTimestampGroups,
  gapEdges: analysis.gaps.length,
  baseline: { speedOnly: [150, 300, 500, 1000, 1500].map(thresholdKmh => ({ thresholdKmh,
    edges: allEdges.filter(e => e.speedKmh !== null && e.speedKmh > thresholdKmh).length })), naiveThreePointIds: naiveSpikes },
  sensitivity,
  historicalLocationMatches: { radiusMeters: HISTORY_RADIUS_METERS, minAgeSeconds: HISTORY_MIN_AGE_SECONDS,
    highPoints: analysis.excursions.filter(c => c.confidence === 'high').flatMap(c => c.historicalMatches).length,
    reviewPoints: analysis.excursions.filter(c => c.confidence === 'review').flatMap(c => c.historicalMatches).length },
  limitations: ['No ground-truth labels: candidate counts are not precision/recall.',
    'Only bounded return excursions are assigned to individual points; sparse returns additionally require near-origin anchors and an extreme jump.',
    'Unexplained sampling gaps and one-sided jumps do not identify an erroneous endpoint.',
    'Small drift, long erroneous clusters, and physically plausible errors can remain undetected.',
    'Historical-location proximity is supplementary evidence only; normal revisits are common and no confidence is upgraded by this signal.',
    'No changes are made to the database, original coordinates, or original IDs.'] };
const findings = analysis.excursions.flatMap((c, index) => c.pointIds.map(id => ({
  segment: index + 1, confidence: c.confidence, reason: c.reason, ...byId.get(id),
  beforeId: c.beforeId, afterId: c.afterId, keptInteriorIds: c.keptInteriorIds.join('|'),
  entrySpeedKmh: c.entrySpeedKmh, exitSpeedKmh: c.exitSpeedKmh, bypassSpeedKmh: c.bypassSpeedKmh,
  thresholdKmh: c.thresholdKmh, maxDeviationMeters: c.maxDeviationMeters, detourRatio: c.detourRatio,
  spanSeconds: c.spanSeconds, trustedContextSides: c.trustedContextSides, pass: c.pass,
  previousLocationId: c.historicalMatches.find(m => m.pointId === id)?.previousId,
  historicalDistanceMeters: c.historicalMatches.find(m => m.pointId === id)?.distanceMeters,
  historicalAgeSeconds: c.historicalMatches.find(m => m.pointId === id)?.ageSeconds,
}))).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
function csv(rows, keys) {
  const cell = value => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    const escaped = typeof value === 'string' && /^[=+\-@]/.test(str) ? `'${str}` : str;
    return `"${escaped.replaceAll('"', '""')}"`;
  };
  return [keys.join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\n') + '\n';
}
await mkdir(outputPath, { recursive: true, mode: 0o700 });
const files = {
  'analysis.json': JSON.stringify(analysis, null, 2),
  'summary.json': JSON.stringify(summary, null, 2),
  'findings.csv': csv(findings, ['id', 'device', 'timestamp', 'longitude', 'latitude', 'confidence', 'reason', 'segment',
    'beforeId', 'afterId', 'keptInteriorIds', 'entrySpeedKmh', 'exitSpeedKmh', 'bypassSpeedKmh', 'thresholdKmh',
    'maxDeviationMeters', 'detourRatio', 'spanSeconds', 'trustedContextSides', 'pass',
    'previousLocationId', 'historicalDistanceMeters', 'historicalAgeSeconds']),
  'unresolved.csv': csv(analysis.unresolvedJumps, ['device', 'beforeId', 'afterId', 'seconds', 'distanceMeters', 'speedKmh']),
};
for (const [name, content] of Object.entries(files)) {
  const path = resolve(outputPath, name);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
console.log(JSON.stringify({ totalPoints: points.length, ...count(analysis), elapsedMs: +elapsedMs.toFixed(1), output: outputPath }, null, 2));
