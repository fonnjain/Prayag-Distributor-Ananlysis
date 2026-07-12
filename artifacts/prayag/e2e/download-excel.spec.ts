// End-to-end test for the Download Excel button on the Sales > Reports view.
//
// Uses the dev-only fixture rep (__fixture key) seeded by the API server when
// Google Sheets is unavailable, so no external dependencies are required.
// Exercises the REAL backend route without any network mocking:
//
//   browser click  →  handleDownload()  →  fetch(/api/salespeople/__fixture/...)
//   →  real Content-Type / Content-Disposition from the server
//   →  blob URL  →  <a> click  →  browser download event
//
// What this catches that the vitest workbook-builder unit test cannot:
//   - Route wiring bugs (wrong URL, missing route registration)
//   - Missing or mis-spelled Content-Disposition header from the server
//   - Broken blob / createObjectURL handling in the frontend
//   - The <a>.download attribute being ignored (blank filename)
//
// Prerequisites:
//   - Dev API server running at localhost:80/api (NODE_ENV != "production")
//   - Frontend dev server running at localhost:80
import { test, expect } from "@playwright/test";

test.describe("Sales Reports — Download Excel", () => {
  test("clicking Download Excel delivers a non-empty xlsx from the real API", async ({ page }) => {
    await page.goto("/sales");

    // The API falls back to fixture tree when Google Sheets is unavailable in
    // dev.  The fixture rep is named "Fixture Rep (Test Only)".
    await expect(page.getByText("Fixture Rep (Test Only)")).toBeVisible({ timeout: 15_000 });

    // Select the fixture rep in the reporting tree.
    await page.getByText("Fixture Rep (Test Only)").first().click();

    // Wait for the per-rep subtab toggle (Overview / Reports) to appear on
    // the right panel.  Locate it precisely to avoid matching the sidebar
    // "Reports" nav item.
    const subTabGroup = page
      .locator("div.inline-flex.rounded-md.border.overflow-hidden")
      .filter({ has: page.getByRole("button", { name: "Overview" }) });
    await expect(subTabGroup).toBeVisible({ timeout: 10_000 });
    await subTabGroup.getByRole("button", { name: "Reports" }).click();

    // Wait for the SalesReports component to finish loading report data from
    // the real /api/salespeople/__fixture/reports endpoint.
    const downloadBtn = page.getByRole("button", { name: /Download Excel/i });
    await expect(downloadBtn).toBeVisible({ timeout: 20_000 });
    await expect(downloadBtn).toBeEnabled();

    // Intercept the browser download triggered by the <a>.click() inside
    // handleDownload().  The file comes from the REAL server endpoint
    // /api/salespeople/__fixture/reports/download which streams a genuine
    // ExcelJS workbook.
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await downloadBtn.click();
    const download = await downloadPromise;

    // 1. Filename must end with .xlsx (proves Content-Disposition was set and
    //    parsed correctly by the frontend).
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);

    // 2. Filename should contain the fixture rep name or FY.
    expect(download.suggestedFilename()).toContain("FY");

    // 3. Saved file must be non-trivially sized (real xlsx, not empty/corrupt).
    //    buildRepReportWorkbook with fixture data produces ~30 KB.
    const savedPath = await download.path();
    expect(savedPath).toBeTruthy();

    const { statSync } = await import("node:fs");
    const stat = statSync(savedPath!);
    expect(stat.size).toBeGreaterThan(5_000);

    // 4. No error banner on the page.
    await expect(page.locator("text=Download failed")).not.toBeVisible();
    await expect(page.locator("text=failed")).not.toBeVisible();
  });
});
