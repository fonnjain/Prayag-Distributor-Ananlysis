#!/usr/bin/env node
// Fetch one Plumbing monthly file and print column headers + values.
// File: "PLUMBING SALE GP Margin Apr 25-26." (id=1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g)
// from the "Plumbing GP MARGIN 25-26" folder.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

function fetchWorkbook(fileId) {
  return new Promise((resolve, reject) => {
    execFile("timeout", ["120", NODE, "--enable-source-maps", FETCHER, fileId],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        if (stdout) {
          try {
            const r = JSON.parse(stdout);
            if (r.ok) { resolve(r.sheets); return; }
            reject(new Error(r.error)); return;
          } catch {}
        }
        reject(err ?? new Error("no output"));
      }
    );
  });
}

async function main() {
  // Monthly Plumbing files from "Plumbing GP MARGIN 25-26" sub-folder (inside GP MARGIN FY 25-26):
  // "PLUMBING SALE GP Margin Apr 25-26."  id=1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g
  const fileId = "1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g";
  const fileName = "PLUMBING SALE GP Margin Apr 25-26.";
  console.log(`Fetching "${fileName}" (${fileId})...`);

  let sheets;
  try {
    sheets = await fetchWorkbook(fileId);
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return;
  }

  console.log(`Tabs: ${sheets.map(s => s.name).join(" | ")}`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) { console.log(`  Tab "${tabName}": empty`); continue; }

    // Find header row (rows 0-9): col B must contain CODE
    let headerIdx = -1;
    for (let ri = 0; ri < Math.min(10, rows.length); ri++) {
      const colB = String(rows[ri]?.[1] ?? "").toUpperCase().replace(/\s+/g," ").trim();
      if (colB.includes("CODE") || colB.includes("ITEM CODE")) { headerIdx = ri; break; }
    }

    if (headerIdx < 0) {
      const sample = (rows[0] ?? []).map(c => String(c ?? "")).join(" | ");
      console.log(`\nTab "${tabName}": no CODE header found. Row 0: ${sample.slice(0, 120)}`);
      continue;
    }

    const headers = rows[headerIdx].map(c => String(c ?? "").replace(/\s+/g, " ").trim());
    const hasBom = headers.some(h =>
      h.toUpperCase().includes("BOM COST") || h.toUpperCase().includes("PUR RATE") || h.toUpperCase().includes("PURRATE")
    );
    const hasDiscount = headers.some(h => h.toUpperCase().startsWith("DISCOUNT"));

    console.log(`\n${"═".repeat(80)}`);
    console.log(`TAB: "${tabName}" — hasBom=${hasBom} hasDiscount=${hasDiscount} → ${(hasBom && hasDiscount) ? "DETECTED" : "SKIPPED"}`);
    console.log("COLUMN HEADERS:");
    headers.forEach((h, i) => { if (h) console.log(`  col ${(i+1).toString().padStart(2)}: ${h}`); });

    if (!hasBom || !hasDiscount) continue;

    console.log("\nFIRST 3 DATA ROWS:");
    let printed = 0;
    for (const row of rows.slice(headerIdx + 1)) {
      if (printed >= 3) break;
      const code = String(row[1] ?? "").trim();
      if (!code || code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND") || code.toUpperCase() === "CODE") continue;
      console.log(`\n  Code: ${code}`);
      row.forEach((v, i) => {
        const h = headers[i];
        if (h && v !== null && v !== "" && v !== undefined)
          console.log(`    col ${(i+1).toString().padStart(2)} [${h}]: ${typeof v === "number" ? v.toLocaleString("en-IN", {maximumFractionDigits: 6}) : v}`);
      });
      printed++;
    }
  }

  console.log("\nDONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
