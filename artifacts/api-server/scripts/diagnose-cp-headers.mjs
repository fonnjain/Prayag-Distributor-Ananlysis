#!/usr/bin/env node
// Read-only: print verbatim CP column headers and exact idx() resolution for cost.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

// Exact replica of idx() from loader.ts buildColMap
function idx(cells, ...patterns) {
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
  // CP monthly files from CP SALE GP MARGIN 25-26 folder (id=14UDrgE2Gw3s0wW3yIOux4GKS5aaqzq4r)
  // Pick Nov (first alphabetically that is monthly, not "Apr To Oct" cumulative)
  const CP_FILE_ID   = "15jzh-Ekmo0FnYi0ygv9KgLPDWzH4Ga9bq_mcMDWvbeg";
  const CP_FILE_NAME = "CP SALE GP MARGIN  Nov 25-26";

  console.log(`Fetching CP file: "${CP_FILE_NAME}" (${CP_FILE_ID})\n`);
  const sheets = await fetchWorkbook(CP_FILE_ID);
  console.log(`Tabs: ${sheets.map(s => s.name).join(" | ")}\n`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) { console.log(`Tab "${tabName}": empty\n`); continue; }

    // Find header row: col B must contain CODE, must have BOM/DISCOUNT
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
      const sample = (rows[0] ?? []).slice(0,8).map(c => String(c ?? "")).join(" | ");
      console.log(`Tab "${tabName}": no GP-margin header (no CODE+BOM+DISCOUNT row in first 12). Row 0 sample: ${sample.slice(0,100)}\n`);
      continue;
    }

    const rawCells = (rows[headerIdx] ?? []).slice(0, 50);
    const cells = rawCells.map(c => String(c ?? "").replace(/\s+/g, " ").trim().toUpperCase());

    console.log(`${"═".repeat(80)}`);
    console.log(`TAB: "${tabName}" — header at row ${headerIdx + 1}`);
    console.log("VERBATIM COLUMN HEADERS (all non-empty up to col 50):");
    cells.forEach((h, i) => { if (h) console.log(`  col ${String(i+1).padStart(2)}: "${h}"`); });

    const avgSaleResult = idx(cells, "AVG SALE RATE", "AVG SALE", "AVGSALE");
    const bomCostResult = idx(cells, "BOM COST", "BOMCOST", "PUR RATE", "PURRATE");

    console.log("\nIDX() RESOLUTION:");
    if (avgSaleResult) {
      console.log(`  avgSale → col ${avgSaleResult.col}  tier="${avgSaleResult.tier}"  header="${avgSaleResult.header}"`);
    } else {
      console.log(`  avgSale → NULL (not found)`);
    }
    if (bomCostResult) {
      console.log(`  bomCost → col ${bomCostResult.col}  tier="${bomCostResult.tier}"  header="${bomCostResult.header}"`);
      // Show ALL candidates that the includes pass would see (to expose any "Growth %" risk)
      const includesCandidates = cells.map((c, i) => ({ col: i+1, h: c })).filter(
        ({h}) => (h.includes("BOM COST") || h.includes("PUR RATE") || h.includes("BOMCOST") || h.includes("PURRATE"))
      );
      if (includesCandidates.length > 1) {
        console.log(`  All BOM COST / PUR RATE candidates in header row:`);
        for (const {col, h} of includesCandidates) {
          const rejected = h.includes("GROWTH") || h.includes("%");
          console.log(`    col ${String(col).padStart(2)}: "${h}" ${rejected ? "← REJECTED (growth/%) " : ""}`);
        }
      }
    } else {
      console.log(`  bomCost → NULL (not found)`);
    }

    // First 3 data rows using resolved columns
    const codeCol = 2; // CP is always single-section; col B = code
    const qtyCol  = 3;
    const avgSaleCol = avgSaleResult?.col;
    const bomCostCol = bomCostResult?.col;

    console.log("\nFIRST 3 DATA ROWS:");
    let printed = 0;
    for (const row of rows.slice(headerIdx + 1)) {
      if (printed >= 3) break;
      const code = String(row[codeCol - 1] ?? "").trim();
      if (!code || ["CODE","ITEM CODE"].includes(code.toUpperCase()) ||
          code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND")) continue;
      const qty     = row[qtyCol - 1];
      const avgSale = avgSaleCol ? row[avgSaleCol - 1] : null;
      const bomCost = bomCostCol ? row[bomCostCol - 1] : null;
      const pct     = (avgSale && bomCost && avgSale > 0) ? (bomCost/avgSale*100).toFixed(1)+"%" : "n/a";
      console.log(`  code="${code}"  qty=${qty}  avgSale=${typeof avgSale==="number" ? avgSale.toFixed(4) : avgSale}  bomCost=${typeof bomCost==="number" ? bomCost.toFixed(4) : bomCost}  BOM%=${pct}`);
      printed++;
    }
    console.log();
  }
  console.log("DONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
