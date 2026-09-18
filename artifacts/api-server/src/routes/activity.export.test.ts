import { describe, expect, it } from "vitest";
import { buildActivityWorkbook } from "./activity.js";

const report = {
  timezone: "Asia/Kolkata",
  from: "2026-09-01",
  to: "2026-09-07",
  summaries: [{
    userId: 7,
    displayName: "Test User",
    email: "test@example.com",
    role: "normal",
    isActive: true,
    activeMs: 7_200_000,
    idleMs: 1_800_000,
    totalMs: 9_000_000,
    firstSeenAt: "2026-09-01T04:30:00.000Z",
    lastSeenAt: "2026-09-07T11:30:00.000Z",
    pageViews: 12,
    actionCount: 4,
    current: false,
    days: [{
      date: "2026-09-01",
      activeMs: 7_200_000,
      idleMs: 1_800_000,
      totalMs: 9_000_000,
      firstSeenAt: "2026-09-01T04:30:00.000Z",
      lastSeenAt: "2026-09-01T07:00:00.000Z",
      pageViews: 12,
      actionCount: 4,
    }],
  }],
  detail: {
    pages: [{ path: "/growth", views: 6, lastSeenAt: "2026-09-07T11:30:00.000Z" }],
    events: [{
      occurredAt: "2026-09-07T11:30:00.000Z",
      kind: "action",
      path: "/growth",
      action: "filter.period",
      state: "active",
    }],
  },
};

describe("user activity Excel export", () => {
  it("includes the all-users summary and daily sheets", () => {
    const workbook = buildActivityWorkbook(report);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Info",
      "User Summary",
      "Daily Activity",
    ]);
    expect(workbook.getWorksheet("User Summary")?.getRow(2).getCell("A").value).toBe("Test User");
    expect(workbook.getWorksheet("User Summary")?.getRow(2).getCell("F").value).toBe(2);
    expect(workbook.getWorksheet("Daily Activity")?.getRow(2).getCell("C").value).toBe("2026-09-01");
  });

  it("adds page and event detail for an individual", async () => {
    const workbook = buildActivityWorkbook(report, 7);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Info",
      "User Summary",
      "Daily Activity",
      "Page Activity",
      "Recent Events",
    ]);
    expect(workbook.getWorksheet("Page Activity")?.getRow(2).getCell("A").value).toBe("/growth");
    expect(workbook.getWorksheet("Recent Events")?.getRow(2).getCell("D").value).toBe("filter.period");
    const bytes = await workbook.xlsx.writeBuffer();
    expect(bytes.byteLength).toBeGreaterThan(1_000);
  });
});