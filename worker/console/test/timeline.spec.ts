import { describe, expect, it } from "vitest";
import { aroundPointRange, calendarDay, constrainRange, dateDay, dayDate, drawableRange, monthWindow, panRange, panSelection, presetRange, quickRange, selectionInWindow, shiftMonth } from "../src/timeline";

describe("timeline selection", () => {
  it("centers an exact 48-hour window on a point across midnight and year boundaries", () => {
    const timestamp = Date.parse("2026-01-01T00:15:23.456+08:00");
    expect(aroundPointRange(timestamp)).toEqual({ since: "2025-12-31", until: "2026-01-02",
      timeWindow: { start: timestamp - 86_400_000, end: timestamp + 86_400_000 } });
  });
  it("uses Shanghai day boundaries even when UTC is on the previous date", () => {
    const midnight = Date.parse("2026-10-01T00:00:00+08:00");
    expect(dayDate(calendarDay(midnight - 1))).toBe("2026-09-30");
    expect(dayDate(calendarDay(midnight))).toBe("2026-10-01");
  });
  it("allows an inclusive 31-day month but rejects 32 days and incomplete or invalid dates", () => {
    expect(drawableRange({ since: "2026-10-01", until: "2026-10-31" })).toEqual([dateDay("2026-10-01"), dateDay("2026-10-31")]);
    for (const range of [
      { since: "2026-09-20", until: "2026-10-21" }, { since: "2026-10-02", until: "2026-10-01" },
      { since: "", until: "2026-10-01" }, { since: "2026-02-30", until: "2026-03-01" },
    ]) expect(drawableRange(range)).toBeNull();
    expect(drawableRange({ since: "2024-02-29", until: "2024-02-29" })).not.toBeNull();
  });
  it("stops either handle at 31 days without shifting the opposite handle or crossing it", () => {
    expect(constrainRange([0, 90], [80, 90], 0, 100)).toEqual([60, 90]);
    expect(constrainRange([10, 99], [10, 20], 0, 100)).toEqual([10, 40]);
    expect(constrainRange([95, 90], [80, 90], 0, 100)).toEqual([90, 90]);
    expect(constrainRange([10, 0], [10, 20], 0, 100)).toEqual([10, 10]);
  });
  it("selects today's Shanghai calendar date across UTC midnight", () => {
    expect(quickRange("today", Date.parse("2026-12-31T16:00:00Z"))).toEqual([dateDay("2027-01-01"), dateDay("2027-01-01")]);
  });
  it("selects the current Monday-to-Sunday week, including a year boundary", () => {
    for (const date of ["2026-10-12", "2026-10-18"])
      expect(quickRange("week", Date.parse(`${date}T12:00:00+08:00`))).toEqual([dateDay("2026-10-12"), dateDay("2026-10-18")]);
    expect(quickRange("week", Date.parse("2027-01-01T12:00:00+08:00"))).toEqual([dateDay("2026-12-28"), dateDay("2027-01-03")]);
  });
  it("selects complete calendar months including 31 days and leap years", () => {
    for (const [date, since, until] of [["2026-10-13", "2026-10-01", "2026-10-31"],
      ["2024-02-15", "2024-02-01", "2024-02-29"], ["2026-02-15", "2026-02-01", "2026-02-28"]]) {
      const range = quickRange("month", Date.parse(`${date}T12:00:00+08:00`));
      expect(range).toEqual([dateDay(since), dateDay(until)]);
      expect(drawableRange({ since: dayDate(range[0]), until: dayDate(range[1]) })).toEqual(range);
    }
  });
  it("clips presets at available history and includes the ending day", () => {
    expect(presetRange(100, 30, 0)).toEqual([71, 100]);
    expect(presetRange(100, 30, 95)).toEqual([95, 100]);
    expect(presetRange(100, 1, 0)).toEqual([100, 100]);
  });
  it("pans the visible window without changing its length and stops at either history boundary", () => {
    expect(panRange([40, 80], -10, 0, 100)).toEqual([30, 70]);
    expect(panRange([40, 80], -100, 0, 100)).toEqual([0, 40]);
    expect(panRange([40, 80], 100, 0, 100)).toEqual([60, 100]);
  });
  it("shows three complete calendar months across year and leap-year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(monthWindow("2026-10")).toEqual([dateDay("2026-08-01"), dateDay("2026-10-31")]);
    expect(monthWindow("2024-04")).toEqual([dateDay("2024-02-01"), dateDay("2024-04-30")]);
    expect(monthWindow("2026-01")).toEqual([dateDay("2025-11-01"), dateDay("2026-01-31")]);
  });
  it("moves the selection with the viewport continuously and preserves its relative position at both bounds", () => {
    for (const offset of [-100, -10.25, 12.75, 100]) {
      const next = panSelection([40, 80], [50, 65], offset, 0, 100);
      expect(next.selection[0] - next.range[0]).toBe(10);
      expect(next.selection[1] - next.range[0]).toBe(25);
      expect(next.selection[1] - next.selection[0]).toBe(15);
      expect(next.range[0]).toBeGreaterThanOrEqual(0);
      expect(next.range[1]).toBeLessThanOrEqual(100);
    }
    expect(panSelection([40, 80], [50, 65], -10.25, 0, 100).selection).toEqual([39.75, 54.75]);
  });
  it("keeps a 30-day selection visible when jumping to a shorter three-month window", () => {
    expect(selectionInWindow([61, 90], [0, 90], [100, 188])).toEqual([159, 188]);
    expect(selectionInWindow([0, 29], [0, 90], [100, 188])).toEqual([100, 129]);
  });
});
