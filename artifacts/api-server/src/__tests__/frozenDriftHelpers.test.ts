import { beforeAll, describe, expect, it } from "vitest";

let helpers: typeof import("../lib/registers/frozenDrift.js");

beforeAll(async () => {
  // Importing the DB schema only constructs a pool; these pure-helper tests do
  // not connect to it.
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
  helpers = await import("../lib/registers/frozenDrift.js");
});

describe("frozen drift evidence helpers", () => {
  it("uses the specified row/net threshold", () => {
    expect(helpers.isFrozenDrift(1, 0)).toBe(true);
    expect(helpers.isFrozenDrift(0, 1000)).toBe(false);
    expect(helpers.isFrozenDrift(0, -1000.01)).toBe(true);
  });

  it("keeps evidence to invoice differences with dates and side summaries", () => {
    const line = (invoiceNo: string, amount: string, invoiceDate = "2026-07-01") =>
      ({ lineUid: `${invoiceNo}-${amount}`, invoiceNo, amount, invoiceDate, code: "SKU", fy: "2026-27", source: "sheets" }) as any;
    const result = helpers.invoiceDifferences(
      [line("A", "100"), line("C", "20")],
      [line("A", "150"), line("B", "30")],
    );
    expect(result.additions).toEqual([{ invoice: "B", date: "2026-07-01", lineCount: 1, net: 30 }]);
    expect(result.removals).toEqual([{ invoice: "C", date: "2026-07-01", lineCount: 1, net: 20 }]);
    expect(result.changes[0]).toMatchObject({ invoice: "A", app: { net: 100 }, sheet: { net: 150 } });
  });

  it("binds preview hashes to app-line identity, not just app totals", () => {
    const line = (uid: string, invoiceNo: string) =>
      ({ lineUid: uid, invoiceNo, amount: "100", invoiceDate: "2026-07-01", code: "SKU", fy: "2026-27", source: "sheets" }) as any;
    const sheet = [line("sheet-1", "S")];
    const before = helpers.refreshPreviewHash("2026-27", "Jul-26", [line("app-1", "A")], sheet);
    const preservingTotalEdit = helpers.refreshPreviewHash("2026-27", "Jul-26", [line("app-2", "B")], sheet);
    expect(preservingTotalEdit).not.toBe(before);
  });

  it("binds every replacement-relevant field and ignores key/input order", () => {
    const base = {
      lineUid: "app-1", invoiceNo: "A", amount: "100", invoiceDate: "2026-07-01",
      code: "SKU", fy: "2026-27", source: "sheets", groupCanon: "CPVC",
      stateCanon: "RAJASTHAN", headCanon: "Head A", channel: "Retail", saleRate: "10",
    } as any;
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as any;
    expect(helpers.replacementLinesFingerprint([base])).toBe(
      helpers.replacementLinesFingerprint([reordered]),
    );
    const changedClassification = { ...base, channel: "Project" };
    expect(
      helpers.refreshPreviewHash("2026-27", "Jul-26", [changedClassification], [base]),
    ).not.toBe(
      helpers.refreshPreviewHash("2026-27", "Jul-26", [base], [base]),
    );
  });
});