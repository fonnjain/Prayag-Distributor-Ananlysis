#!/usr/bin/env node
// Read-only: show resolved column indices for ALL detected Plumbing tabs.

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

// Exact replica of idx() from loader.ts buildColMap
function resolveIdx(cells, ...patterns) {
  for (const p of patterns) {
    const i = cells.findIndex(c => c === p);
    if (i >= 0) return { col: i + 1, tier: "exact", header: cells[i] };
  }
  for (const p of patterns) {
    const i = cells.findIndex(c => c.startsWith(p));
    if (i >= 0) return { col: i + 1, tier: "startsWith", header: cells[i] };
  }
  for (const p of patterns) {
    const i = cells.findIndex(
      c => c.includes(p) && !c.includes("GROWTH") && !c.includes("%")
    );
    if (i >= 0) return { col: i + 1, tier: "includes", header: cells[i] };
  }
  return null;
}

async function main() {
  // PLUMBING SALE GP Margin Apr 25-26. (id known from previous run)
  const FILE_ID   = "1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g";
  const FILE_NAME = "PLUMBING SALE GP Margin Apr 25-26.";

  console.log(`File: "${FILE_NAME}" (${FILE_ID})\n`);
  const sheets = await fetchWorkbook(FILE_ID);
  console.log(`Tabs (${sheets.length}): ${sheets.map(s => s.name).join(" | ")}\n`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) { console.log(`Tab "${tabName}": empty`); continue; }

    // Scan rows 0-11 for header (col B must contain CODE)
    let headerIdx = -1;
    for (let ri = 0; ri < Math.min(12, rows.length); ri++) {
      const colB = String(rows[ri]?.[1] ?? "").toUpperCase().replace(/\s+/g," ").trim();
      if (!colB.includes("CODE")) continue;
      const up = (rows[ri] ?? []).slice(0, 50).map(c => String(c ?? "").toUpperCase().replace(/\s+/g," ").trim());
      const hasBom = up.some(c => c.includes("BOM COST") || c.includes("PUR RATE") || c.includes("BOMCOST"));
      const hasDis = up.some(c => c === "DISCOUNT" || c.startsWith("DISCOUNT"));
      if (hasBom && hasDis) { headerIdx = ri; break; }
    }

    if (headerIdx < 0) {
      // Print first row so we can see why it was skipped
      const r0 = (rows[0] ?? []).slice(0,6).map(c => String(c ?? "").trim()).join(" | ");
      console.log(`Tab "${tabName}": NOT DETECTED (row 0: ${r0.slice(0,80)})`);
      continue;
    }

    const rawCells = (rows[headerIdx] ?? []).slice(0, 50);
    const cells = rawCells.map(c => String(c ?? "").replace(/\s+/g, " ").trim().toUpperCase());

    // Resolve the key columns
    const avgSaleR = resolveIdx(cells, "AVG SALE RATE", "AVG SALE", "AVGSALE");
    const bomCostR = resolveIdx(cells, "BOM COST", "BOMCOST", "PUR RATE", "PURRATE");

    const avgSaleCol = avgSaleR?.col ?? null;
    const bomCostCol = bomCostR?.col ?? null;

    const sectionStart =
      avgSaleCol != null || bomCostCol != null
        ? Math.min(avgSaleCol ?? Infinity, bomCostCol ?? Infinity) - 1
        : cells.length;

    // Right-to-left CODE search
    let codeCol = 2;
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "CODE" || h === "ITEM CODE") { codeCol = i + 1; break; }
    }

    // Right-to-left QTY search
    let qtyCol = 3;
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "QTY" || h.startsWith("QTY")) { qtyCol = i + 1; break; }
    }

    // Left-section boundary = last non-empty col before the gap (heuristic: highest col ≤13 with content)
    const leftSectionEnd = Math.max(...cells.slice(0,13).map((h,i) => h ? i+1 : 0));

    console.log(`\n${"═".repeat(70)}`);
    console.log(`TAB: "${tabName}" — header at row ${headerIdx + 1}`);
    console.log("VERBATIM HEADERS (non-empty cols 1-50):");
    cells.forEach((h, i) => { if (h) console.log(`  col ${String(i+1).padStart(2)}: "${h}"`); });
    console.log("\nRESOLVED COLUMNS:");
    console.log(`  sectionStart = ${sectionStart}  (right-to-left CODE/QTY search is cols 1..${sectionStart})`);
    console.log(`  codeCol      = ${codeCol}  → "${cells[codeCol-1]}"  |  in right-hand section (col > ${leftSectionEnd})? ${codeCol > leftSectionEnd ? "YES ✓" : "NO ✗ — left section"}`);
    console.log(`  qtyCol       = ${qtyCol}  → "${cells[qtyCol-1]}"  |  in right-hand section? ${qtyCol > leftSectionEnd ? "YES ✓" : "NO ✗ — left section"}`);
    console.log(`  avgSaleCol   = ${avgSaleCol}  → "${avgSaleR?.header ?? "NULL"}"  tier="${avgSaleR?.tier ?? "not found"}"`);
    console.log(`  bomCostCol   = ${bomCostCol}  → "${bomCostR?.header ?? "NULL"}"  tier="${bomCostR?.tier ?? "not found"}"`);

    // Show first 3 data rows
    console.log("\nFIRST 3 DATA ROWS (codeCol, qtyCol, avgSaleCol, bomCostCol):");
    let printed = 0;
    for (const row of rows.slice(headerIdx + 1)) {
      if (printed >= 3) break;
      const code = String(row[codeCol - 1] ?? "").trim();
      if (!code || ["CODE","ITEM CODE"].includes(code.toUpperCase()) ||
          code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND")) continue;
      const qty     = row[qtyCol - 1];
      const avgSale = avgSaleCol ? row[avgSaleCol - 1] : null;
      const bomCost = bomCostCol ? row[bomCostCol - 1] : null;
      const pct     = (typeof avgSale === "number" && typeof bomCost === "number" && avgSale > 0)
                      ? (bomCost/avgSale*100).toFixed(1)+"%" : "n/a";
      console.log(`  code="${code}"  qty=${qty}  avgSale=${typeof avgSale==="number" ? avgSale.toFixed(4) : avgSale}  bomCost=${typeof bomCost==="number" ? bomCost.toFixed(4) : bomCost}  BOM%=${pct}`);
      printed++;
    }
  }
  console.log("\nDONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
