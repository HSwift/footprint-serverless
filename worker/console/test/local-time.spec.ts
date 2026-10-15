import { describe, expect, it } from "vitest";
import { getPointLocalTime } from "../src/local-time";

const timestamp = Date.parse("2025-09-30T20:15:16.123Z");
describe("stored point timezone", () => {
  it("uses UTC hour offsets and rolls over the local date", () => {
    expect(getPointLocalTime({ timestamp, timezone: 8 })).toEqual({ date: "2025.10.01", time: "04:15:16", timezone: 8, offset: "UTC+08:00" });
  });
  it("preserves the summer or winter offset reported for each observation", () => {
    expect(getPointLocalTime({ timestamp: Date.parse("2025-07-01T12:00:00Z"), timezone: 2 })).toMatchObject({ time: "14:00:00", offset: "UTC+02:00" });
    expect(getPointLocalTime({ timestamp: Date.parse("2025-01-01T12:00:00Z"), timezone: 1 })).toMatchObject({ time: "13:00:00", offset: "UTC+01:00" });
  });
  it("distinguishes repeated clock hours using each record's stored offset", () => {
    expect(getPointLocalTime({ timestamp: Date.parse("2025-11-02T05:30:00Z"), timezone: -4 })).toMatchObject({ time: "01:30:00", offset: "UTC-04:00" });
    expect(getPointLocalTime({ timestamp: Date.parse("2025-11-02T06:30:00Z"), timezone: -5 })).toMatchObject({ time: "01:30:00", offset: "UTC-05:00" });
  });
  it("supports positive and negative fractional-hour offsets", () => {
    expect(getPointLocalTime({ timestamp, timezone: 5.5 })).toMatchObject({ time: "01:45:16", offset: "UTC+05:30" });
    expect(getPointLocalTime({ timestamp, timezone: 5.75 })).toMatchObject({ time: "02:00:16", offset: "UTC+05:45" });
    expect(getPointLocalTime({ timestamp, timezone: -3.5 })).toMatchObject({ time: "16:45:16", offset: "UTC-03:30" });
  });
  it("accepts UTC zero and handles midnight and offset limits", () => {
    expect(getPointLocalTime({ timestamp: 0, timezone: 0 })).toMatchObject({ date: "1970.01.01", time: "00:00:00", timezone: 0 });
    expect(getPointLocalTime({ timestamp: 0, timezone: -12 })).toMatchObject({ date: "1969.12.31", time: "12:00:00" });
    expect(getPointLocalTime({ timestamp: 0, timezone: 14 })).toMatchObject({ time: "14:00:00" });
  });
  it.each([null, undefined, NaN, 15])("labels missing or invalid offsets as unrecorded UTC: %s", timezone => {
    expect(getPointLocalTime({ timestamp, timezone })).toEqual({ date: "2025.09.30", time: "20:15:16", timezone: null, offset: "UTC+00:00" });
  });
  it("does not produce a clock for invalid timestamps", () => {
    expect(getPointLocalTime({ timestamp: NaN, timezone: 8 })).toBeNull();
    expect(getPointLocalTime({ timestamp: 8_640_000_000_000_001, timezone: 8 })).toBeNull();
  });
});
