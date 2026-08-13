#!/usr/bin/env node
// Print verbatim column headers from one CP monthly file and show which column
// the NEW precision-ordered idx() resolves for each key field.
//
// Targets the first accepted CP monthly file found in Drive.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

// Known CP monthly file IDs (from prior Drive scan results)
// "CP SALE GP MARGIN Apr 25-26." 
const CP_TEST_FILES = [
  { id: "1BpBWpqb34MVEfMrg2LXz5wvNvU7lcEVY", name: "CP SALE GP MARGIN Apr 25-26." },
  { id: "1Nj0EJbGaM-DL20d91WApBe5e0gTitFHQ", name: "CP SALE GP MARGIN Apr 25-26" },
];

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

// Replicate the FIXED idx() logic (3-pass precision ordering)
function makeIdx(cells) {
  return (...patterns) => {
    // Pass 1: exact
    for (const p of patterns) {
      const i = cells.findIndex(c => c === p);
      if (i >= 0) return { col: i + 1, pass: 1, matchedPattern: p, matchedHeader: cells[i] };
    }
    // Pass 2: startsWith
    for (const p of patterns) {
      const i = cells.findIndex(c => c.startsWith(p));
      if (i >= 0) return { col: i + 1, pass: 2, matchedPattern: p, matchedHeader: cells[i] };
    }
    // Pass 3: includes, reject growth/%
    for (const p of patterns) {
      const i = cells.findIndex(c => c.includes(p) && !c.includes("GROWTH") && !c.includes("%"));
      if (i >= 0) return { col: i + 1, pass: 3, matchedPattern: p, matchedHeader: cells[i] };
    }
    return null;
  };
}

async function tryFile(fileId, fileName) {
  console.log(`\nFetching "${fileName}" (${fileId})...`);
  let sheets;
  try {
    sheets = await fetchWorkbook(fileId);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    return false;
  }

  console.log(`Tabs: ${sheets.map(s => s.name).join(" | ")}`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) continue;

    // Find header row (rows 0-11, i.e. rows 1-12 in 1-based like the loader)
    let headerIdx = -1;
    for (let ri = 0; ri < Math.min(12, rows.length); ri++) {
      const raw = rows[ri] ?? [];
      // Scan all 50 cols
      const cells = [];
      for (let ci = 0; ci < 50; ci++) {
        cells.push(String(raw[ci] ?? "").replace(/\s+/g, " ").trim().toUpperCase());
      }
      // Trim trailing empty
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();

      const colB = cells[1] ?? "";
      if (!colB.includes("CODE")) continue;

      const hasDiscount = cells.some(c => c === "DISCOUNT" || c.startsWith("DISCOUNT"));
      const hasBom = cells.some(c =>
        c.includes("BOM COST") || c.includes("BOMCOST") ||
        c.includes("PUR RATE") || c.includes("PURRATE")
      );
      if (hasDiscount && hasBom) { headerIdx = ri; break; }
    }

    if (headerIdx < 0) {
      console.log(`\nTab "${tabName}": no GP margin header found (rows 1-12)`);
      continue;
    }

    const rawHeader = rows[headerIdx] ?? [];
    const cells = [];
    for (let ci = 0; ci < 50; ci++) {
      cells.push(String(rawHeader[ci] ?? "").replace(/\s+/g, " ").trim().toUpperCase());
    }
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();

    console.log(`\n${"═".repeat(80)}`);
    console.log(`TAB: "${tabName}"  (header at row ${headerIdx + 1})`);
    console.log(`\nCOLUMN HEADERS (verbatim, after normalize):`);
    cells.forEach((h, i) => { if (h) console.log(`  col ${(i+1).toString().padStart(2)}: ${h}`); });

    const idx = makeIdx(cells);

    const avgSaleRes = idx("AVG SALE RATE", "AVG SALE", "AVGSALE");
    const bomCostRes = idx("BOM COST", "BOMCOST", "PUR RATE", "PURRATE");

    const avgSaleCol = avgSaleRes?.col ?? null;
    const bomCostCol = bomCostRes?.col ?? null;
    const sectionStart = Math.min(avgSaleCol ?? Infinity, bomCostCol ?? Infinity) - 1;

    // CODE: right-to-left from sectionStart
    let codeCol = 2;
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "CODE" || h === "ITEM CODE") { codeCol = i + 1; break; }
    }

    // QTY: right-to-left from sectionStart
    let qtyCol = 3;
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "QTY" || h.startsWith("QTY")) { qtyCol = i + 1; break; }
    }

    console.log(`\nCOLUMN RESOLUTION (FIXED precision-ordered idx):`);
    const show = (name, res) => {
      if (!res) { console.log(`  ${name.padEnd(12)}: NOT FOUND`); return; }
      const passLabel = ["", "exact", "startsWith", "includes"][res.pass];
      console.log(`  ${name.padEnd(12)}: col ${res.col}  "${res.matchedHeader}"  [${passLabel} on pattern "${res.matchedPattern}"]`);
    };
    console.log(`  code        : col ${codeCol}  "${cells[codeCol-1]}"`);
    console.log(`  qty         : col ${qtyCol}  "${cells[qtyCol-1]}"`);
    show("avgSale",    avgSaleRes);
    show("bomCost",    bomCostRes);
    show("discount",   idx("DISCOUNT"));
    show("mrp",        idx("MRP"));
    show("weight",     idx("TOTAL  WEIGHT", "TOTAL WEIGHT", "TOTALWEIGHT") ?? idx("WEIGHT"));

    console.log(`\nFIRST 3 DATA ROWS:`);
    let printed = 0;
    for (const row of rows.slice(headerIdx + 1)) {
      if (printed >= 3) break;
      const code = String(row?.[codeCol - 1] ?? "").trim();
      if (!code || code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND") || code.toUpperCase() === "CODE" || code.toUpperCase() === "ITEM CODE") continue;
      const avgSale = avgSaleCol ? (parseFloat(String(row?.[avgSaleCol - 1] ?? "").replace(/,/g,"")) || null) : null;
      const bomCost = bomCostCol ? (parseFloat(String(row?.[bomCostCol - 1] ?? "").replace(/,/g,"")) || null) : null;
      const bomPct  = avgSale && bomCost ? (bomCost / avgSale * 100).toFixed(1) : "?";
      console.log(`  code=${code}  avgSale=${avgSale?.toFixed(2) ?? "null"}  bomCost=${bomCost?.toFixed(6) ?? "null"}  BOM%=${bomPct}`);
      printed++;
    }
  }
  return true;
}

async function main() {
  let ok = false;
  for (const f of CP_TEST_FILES) {
    ok = await tryFile(f.id, f.name);
    if (ok) break;
  }
  if (!ok) console.log("\nAll CP test files failed. Need to discover CP file IDs from Drive.");
  console.log("\nDONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
