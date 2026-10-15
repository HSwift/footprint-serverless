import { describe, expect, it } from "vitest";
import { projectDateTime, projectDraft, projectInput, projectPointCount } from "../src/project";

describe("project time windows", () => {
  const original = { id: 1, name: "旅程", startTime: Date.parse("2026-09-30T16:00:00.123Z"), endTime: Date.parse("2026-10-02T07:23:45.678Z") };
  it("displays and parses Shanghai time, including a UTC date rollover", () => {
    expect(projectDateTime(original.startTime)).toBe("2026-10-01T00:00:00");
    expect(projectInput({ name: "  新项目  ", start: "2026-10-01T00:00", end: "2026-10-02T15:23:45" })).toEqual({
      name: "新项目", startTime: Date.parse("2026-09-30T16:00:00Z"), endTime: Date.parse("2026-10-02T07:23:45Z"),
    });
  });
  it("preserves both millisecond boundaries when only the name is edited", () => {
    expect(projectInput({ ...projectDraft(original), name: "改名", start: "2026-10-01T00:00" }, original)).toEqual({
      name: "改名", startTime: original.startTime, endTime: original.endTime,
    });
  });
  it("changes only the edited time and allows projects spanning multiple months", () => {
    expect(projectInput({ ...projectDraft(original), end: "2026-12-01T23:59:59" }, original)).toEqual({
      name: original.name, startTime: original.startTime, endTime: Date.parse("2026-12-01T23:59:59+08:00"),
    });
  });
  it.each([
    { name: " " }, { name: "x".repeat(201) }, { start: "" }, { start: "2026-02-30T12:00" },
    { end: "2026-10-03T24:00" }, { end: "2026-09-01T00:00" },
  ])("rejects invalid drafts: %j", changes => {
    expect(() => projectInput({ ...projectDraft(original), ...changes })).toThrow();
  });
  it("counts inclusive windows with repeated timestamps without counting gaps", () => {
    const times = [1000, 2000, 2000, 3000, 5000];
    expect(projectPointCount(times, { ...original, startTime: 2000, endTime: 3000 })).toBe(3);
    expect(projectPointCount(times, { ...original, startTime: 2000, endTime: 2000 })).toBe(2);
    expect(projectPointCount(times, { ...original, startTime: 3001, endTime: 4999 })).toBe(0);
    expect(projectPointCount([], original)).toBe(0);
  });
});
