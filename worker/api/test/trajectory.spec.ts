import { describe, expect, it } from "vitest";
import { analyzeTrajectory, greatCircleDistance, historicalSearchBounds, matchHistoricalLocation, type TrackPoint } from "../src/trajectory";

function point(id: number, longitude: number, seconds: number, device = "phone", latitude = 30): TrackPoint {
  return { id, longitude, latitude, timestamp: seconds * 1000, device };
}

describe("historical-location evidence", () => {
  const day = 86_400;
  it("matches a previous visit without upgrading a moderate return excursion", () => {
    const recent = [point(3, 120, day * 2), point(4, 120, day * 2 + 30), point(5, 120.05, day * 2 + 90),
      point(6, 120, day * 2 + 150), point(7, 120, day * 2 + 180)];
    const baseline = analyzeTrajectory(recent).excursions[0];
    const result = analyzeTrajectory([point(1, 120.05, 0), point(2, 120.05, 30), ...recent]).excursions[0];
    expect(baseline.confidence).toBe("review");
    expect(result).toMatchObject({ pointIds: baseline.pointIds, confidence: "review", historicalMatches: [
      { pointId: 5, previousId: 2, distanceMeters: 0, previousTimestamp: 30_000, ageSeconds: day * 2 + 60, searchComplete: true },
    ] });
  });
  it("does not flag a normal return to an old location", () => {
    expect(analyzeTrajectory([point(1, 120, 0), point(2, 120.05, 3600),
      point(3, 120.05, day * 2), point(4, 120, day * 2 + 3600)]).excursions).toEqual([]);
  });
  it("uses only sufficiently old observations of the same known device", () => {
    const target = point(10, 120, day * 2);
    expect(matchHistoricalLocation(target, [point(1, 120, day * 3), point(2, 120, day * 2 - 1),
      point(3, 120, day * 2, "watch"), { ...point(4, 120, 0), latitude: NaN }])).toBeNull();
    expect(matchHistoricalLocation(target, [point(5, 120, day)])).toMatchObject({ previousId: 5, ageSeconds: day });
    expect(matchHistoricalLocation({ ...target, device: null }, [{ ...point(1, 120, 0), device: null }])).toBeNull();
  });
  it("does not recycle earlier anomalies or their duplicate observations as visit evidence", () => {
    const first = [point(1, 120, 0), point(2, 120, 30), point(3, 121, 60), point(9, 121, 60),
      point(4, 120, 90), point(5, 120, 120)];
    const later = [point(10, 120, day * 2), point(11, 120, day * 2 + 30), point(12, 121, day * 2 + 60),
      point(13, 120, day * 2 + 90), point(14, 120, day * 2 + 120)];
    const result = analyzeTrajectory([...first, ...later]);
    expect(result.duplicateGroups).toContainEqual([3, 9]);
    expect(result.excursions.find(c => c.pointIds.includes(12))?.historicalMatches).toEqual([]);
  });
  it("records history for duplicate candidate IDs too", () => {
    const result = analyzeTrajectory([point(1, 121, 0), point(2, 121, 30), point(3, 120, day * 2),
      point(4, 120, day * 2 + 30), point(5, 121, day * 2 + 60), point(6, 121, day * 2 + 60),
      point(7, 120, day * 2 + 90), point(8, 120, day * 2 + 120)]);
    expect(result.excursions[0].historicalMatches.map(m => m.pointId)).toEqual([5, 6]);
  });
  it("checks spherical distances across the date line and around a pole", () => {
    const target = point(2, -179.9999, day * 2, "phone", 0);
    expect(matchHistoricalLocation(target, [point(1, 179.9999, 0, "phone", 0)])?.distanceMeters).toBeLessThan(30);
    expect(historicalSearchBounds(target).longitudeRanges).toHaveLength(2);
    const pole = point(2, 150, day * 2, "phone", 90);
    expect(historicalSearchBounds(pole).longitudeRanges).toEqual([[-180, 180]]);
    expect(matchHistoricalLocation(pole, [point(1, -30, 0, "phone", 90)])?.distanceMeters).toBeLessThan(0.01);
  });
  it("rejects the bounding-box corners outside the actual radius and preserves limited-search metadata", () => {
    const target = point(2, 120, day * 2);
    const bounds = historicalSearchBounds(target);
    expect(matchHistoricalLocation(target, [point(1, bounds.longitudeRanges[0][1], 0, "phone", bounds.maxLatitude)])).toBeNull();
    expect(matchHistoricalLocation(target, [point(1, 120, 0)], false)).toMatchObject({ searchComplete: false });
  });
});

describe("experimental trajectory detector", () => {
  it("flags a distant return spike without changing original points", () => {
    const points = [point(1, 120, 0), point(2, 120, 30), point(3, 121, 60), point(4, 120, 90), point(5, 120, 120)];
    const original = JSON.stringify(points);
    const result = analyzeTrajectory(points);
    expect(result.excursions).toHaveLength(1);
    expect(result.excursions[0]).toMatchObject({ pointIds: [3], confidence: "high", beforeId: 2, afterId: 4 });
    expect(JSON.stringify(points)).toBe(original);
  });

  it("handles repeated bad coordinates with a good point inside the excursion", () => {
    const points = [point(1, 120, 0), point(2, 120, 30), point(3, 120, 60, "phone", 26),
      point(4, 120, 90, "phone", 26), point(5, 120, 120), point(6, 120, 150, "phone", 26), point(7, 120, 180), point(8, 120, 210)];
    const result = analyzeTrajectory(points);
    const flagged = result.excursions.flatMap(c => c.pointIds);
    expect(flagged.sort()).toEqual([3, 4, 6]);
    expect(flagged).not.toContain(5);
    expect(result.excursions.some(c => c.keptInteriorIds.includes(5))).toBe(true);
  });

  it("retains plausible interior motion even away from the endpoint interpolation", () => {
    const points = [point(1, 120, 0), point(2, 120, 30), point(3, 120, 60, "phone", 26),
      point(4, 120, 90, "phone", 26), point(5, 120.02, 210), point(6, 120, 240, "phone", 26),
      point(7, 120, 270), point(8, 120, 300)];
    const result = analyzeTrajectory(points);
    expect(result.excursions.flatMap(c => c.pointIds).sort()).toEqual([3, 4, 6]);
    expect(result.excursions[0].keptInteriorIds).toContain(5);
  });

  it("keeps a continuous high-speed flight", () => {
    const result = analyzeTrajectory(Array.from({ length: 10 }, (_, i) => point(i + 1, 100 + i * 0.1, i * 40)));
    expect(result.excursions).toEqual([]);
    expect(result.unresolvedJumps).toEqual([]);
  });

  it("keeps a real slow out-and-back trip and small stationary noise", () => {
    const slow = [point(1, 120, 0), point(2, 120, 300), point(3, 120.02, 600), point(4, 120, 900), point(5, 120, 1200)];
    expect(analyzeTrajectory(slow).excursions).toEqual([]);
    const noise = Array.from({ length: 10 }, (_, i) => point(i + 1, 120 + (i % 2) * 0.0005, i * 10));
    expect(analyzeTrajectory(noise).excursions).toEqual([]);
  });

  it("does not join different devices into a path", () => {
    const points = [point(1, 120, 0), point(2, 120, 30), point(3, 100, 60, "tablet"), point(4, 120, 90), point(5, 120, 120)];
    expect(analyzeTrajectory(points).excursions).toEqual([]);
  });

  it("attributes a physically extreme return across a long sampling gap", () => {
    const points = [point(1, 120, 0), point(2, 120, 30), point(3, 100, 4000), point(4, 120, 4030), point(5, 120, 4060)];
    const result = analyzeTrajectory(points);
    expect(result.excursions).toMatchObject([{ pointIds: [3], confidence: "high", reason: "long_return_spike" }]);
    expect(result.gaps).toHaveLength(1);
    expect(result.unresolvedJumps).toEqual([]);
  });

  it("uses stable older anchors when an outbound leg could be a flight but the return cannot", () => {
    const points = [point(1, 120, 0), point(2, 120.002, 8400), point(3, 100, 14400),
      point(4, 120.003, 14700), point(5, 120.0031, 14760)];
    const result = analyzeTrajectory(points);
    expect(result.excursions).toMatchObject([{ pointIds: [3], confidence: "high", reason: "long_return_spike",
      beforeId: 2, afterId: 4, trustedContextSides: 2, spanSeconds: 6300 }]);
    expect(result.unresolvedJumps).toEqual([]);
    expect(result.excursions[0].entrySpeedKmh).toBeLessThan(1500);
    expect(result.excursions[0].exitSpeedKmh).toBeGreaterThan(1500);
  });

  it("keeps a plausible sparse flight out and back within the long-return horizon", () => {
    const points = [point(1, 120, 0), point(2, 120, 30), point(3, 112, 3530),
      point(4, 120, 7030), point(5, 120, 7060)];
    const result = analyzeTrajectory(points);
    expect(result.gaps).toHaveLength(2);
    expect(result.excursions).toEqual([]);
    expect(result.unresolvedJumps).toEqual([]);
  });

  it("retains one-sided jumps and returns beyond the supported horizon for review", () => {
    const oneSided = [point(1, 120, 0), point(2, 120, 30), point(3, 100, 4000), point(4, 100, 4030)];
    const result = analyzeTrajectory(oneSided);
    expect(result.excursions).toEqual([]);
    expect(result.unresolvedJumps).toMatchObject([{ beforeId: 2, afterId: 3 }]);
    const lateReturn = [point(1, 120, 0), point(2, 120, 30), point(3, 100, 12000),
      point(4, 120, 12030), point(5, 120, 12060)];
    expect(analyzeTrajectory(lateReturn).excursions).toEqual([]);
  });

  it("requires spatially stable outer observations to call a sparse return high confidence", () => {
    const points = [point(1, 122, 0), point(2, 120, 8400), point(3, 100, 14400),
      point(4, 120, 14700), point(5, 120, 14760)];
    expect(analyzeTrajectory(points).excursions).toMatchObject([{ pointIds: [3], confidence: "review", trustedContextSides: 1 }]);
    // A return with no outer observations cannot reliably identify an endpoint.
    expect(analyzeTrajectory(points.slice(1, 4)).excursions).toEqual([]);
  });

  it("preserves a good interior observation in a long erroneous burst", () => {
    const points = [point(1, 120, 0), point(2, 120, 8400), point(3, 100, 14400),
      point(4, 120.002, 14460), point(5, 100, 14520), point(6, 120, 14700), point(7, 120, 14760)];
    const result = analyzeTrajectory(points);
    expect(result.excursions.flatMap(c => c.pointIds).sort()).toEqual([3, 5]);
    expect(result.excursions.some(c => c.keptInteriorIds.includes(4))).toBe(true);
    expect(result.excursions.some(c => c.reason === "long_excursion_burst")).toBe(true);
  });

  it("records exact duplicates and conflicting timestamps separately", () => {
    const result = analyzeTrajectory([point(1, 120, 0), point(2, 120, 0), point(3, 120, 30), point(4, 121, 30)]);
    expect(result.duplicateGroups).toEqual([[1, 2]]);
    expect(result.conflictingTimestampGroups).toEqual([[3, 4]]);
    expect(result.excursions).toEqual([]);
  });

  it("does not infer a return excursion across conflicting observations", () => {
    const result = analyzeTrajectory([point(1, 120, 0), point(2, 120, 30), point(3, 121, 60),
      point(4, 120, 90), point(5, 121, 90), point(6, 120, 120), point(7, 120, 150)]);
    expect(result.conflictingTimestampGroups).toEqual([[4, 5]]);
    expect(result.excursions).toEqual([]);
  });

  it("handles invalid coordinates, empty and very short tracks", () => {
    expect(analyzeTrajectory([]).excursions).toEqual([]);
    const result = analyzeTrajectory([point(1, 120, 0), point(2, NaN, 30), point(3, 181, 60)]);
    expect(result.invalidPointIds).toEqual([2, 3]);
    expect(result.excursions).toEqual([]);
  });

  it("calculates distance across the date line without a world-sized jump", () => {
    expect(greatCircleDistance(point(1, 179.9, 0, "phone", 0), point(2, -179.9, 30, "phone", 0))).toBeCloseTo(22239.016, 2);
    expect(analyzeTrajectory([point(1, 179.7, 0), point(2, 179.8, 100), point(3, 179.9, 200), point(4, -180, 300), point(5, -179.9, 400)]).excursions).toEqual([]);
  });

  it("rejects unbounded or nonsensical configuration", () => {
    expect(() => analyzeTrajectory([], { maxBurstPoints: 1000 })).toThrow(RangeError);
    expect(() => analyzeTrajectory([], { minDeviationMeters: 0 })).toThrow(RangeError);
  });
});
