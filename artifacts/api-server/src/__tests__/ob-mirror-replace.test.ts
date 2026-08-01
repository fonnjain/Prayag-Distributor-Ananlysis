// Unit tests for the OB mirror replace-mode reconciliation logic.
// computeOrphanTabs decides which primary_order_line source_tabs must be
// deleted after a replace-mode ingest: any tab present in the DB mirror but
// absent from the successfully-read monthly tab set is an orphan (the tab was
// deleted or renamed in the sheet).
//
// The per-tab semantics under test (mirroring ingestOrderBookingFy):
//   - non-empty tab  → replaced (delete + re-insert), stays in kept set
//   - emptied tab    → still read → stays in kept set (its rows are deleted
//                      by the per-tab replace, NOT by orphan cleanup)
//   - deleted tab    → not in kept set → orphan → rows removed
//   - renamed tab    → old title orphaned (rows removed), new title kept

import { describe, expect, it } from "vitest";
import { computeOrphanTabs } from "../lib/mgmt/primarySheets.js";

describe("computeOrphanTabs", () => {
  it("non-empty tabs present in both DB and sheet are never orphaned", () => {
    expect(computeOrphanTabs(["Apr", "May", "Jun", "July"], ["Apr", "May", "Jun", "July"]))
      .toEqual([]);
  });

  it("an emptied monthly tab is still in the kept set — not an orphan", () => {
    // The tab was read (0 rows emitted) so replace mode still lists it as
    // replaced; its stale rows are removed by the per-tab delete, and the
    // orphan cleanup must NOT double-handle it.
    const kept = ["Apr", "May", "Jun", "July"]; // July read but yielded 0 rows
    expect(computeOrphanTabs(["Apr", "May", "Jun", "July"], kept)).toEqual([]);
  });

  it("a tab deleted from the sheet is orphaned and scheduled for removal", () => {
    expect(computeOrphanTabs(["Apr", "May", "Jun", "July"], ["Apr", "May", "Jun"]))
      .toEqual(["July"]);
  });

  it("a renamed tab orphans the OLD title only; the new title is kept", () => {
    // "July" renamed to "Jul" in the sheet: old rows must go, new rows arrive
    // under the new source_tab via the per-tab replace.
    expect(computeOrphanTabs(["Apr", "May", "Jun", "July"], ["Apr", "May", "Jun", "Jul"]))
      .toEqual(["July"]);
  });

  it("trims whitespace on both sides before comparing", () => {
    expect(computeOrphanTabs([" Apr ", "May"], ["Apr", " May"])).toEqual([]);
  });

  it("empty DB mirror yields no orphans", () => {
    expect(computeOrphanTabs([], ["Apr"])).toEqual([]);
  });
});
