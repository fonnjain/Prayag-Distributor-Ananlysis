#!/usr/bin/env node
// Discover CP GP MARGIN folders + files from Drive, then fetch one monthly
// file and print column headers + idx() resolution using the FIXED 3-pass logic.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

// ── reuse the compiled dist's Drive helpers via dynamic import ──────────────
async function listDriveFiles(q) {
  const { listDriveFiles } = await import(path.join(DIST_DIR, "index.mjs"));
  return listDriveFiles({ q });
}
async function listDriveFolder(id) {
  const { listDriveFolder } = await import(path.join(DIST_DIR, "index.mjs"));
  return listDriveFolder(id);
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

// Replicate FIXED idx() — 3-pass precision ordering
function makeIdx(cells) {
  return (...patterns) => {
    for (const p of patterns) {
      const i = cells.findIndex(c => c === p);
      if (i >= 0) return { col: i+1, pass: 1, pat: p, header: cells[i] };
    }
    for (const p of patterns) {
      const i = cells.findIndex(c => c.startsWith(p));
      if (i >= 0) return { col: i+1, pass: 2, pat: p, header: cells[i] };
    }
    for (const p of patterns) {
      const i = cells.findIndex(c => c.includes(p) && !c.includes("GROWTH") && !c.includes("%"));
      if (i >= 0) return { col: i+1, pass: 3, pat: p, header: cells[i] };
    }
    return null;
  };
}

function describeRes(name, res) {
  if (!res) return `  ${name.padEnd(12)}: NOT FOUND`;
  const pl = ["","exact","startsWith","includes"][res.pass];
  return `  ${name.padEnd(12)}: col ${String(res.col).padStart(2)}  "${res.header}"  [${pl} → "${res.pat}"]`;
}

async function inspectFile(fileId, fileName) {
  console.log(`\nFetching "${fileName}" ...`);
  let sheets;
  try { sheets = await fetchWorkbook(fileId); }
  catch (err) { console.log(`  ERROR: ${err.message}`); return false; }

  console.log(`Tabs: ${sheets.map(s=>s.name).join(" | ")}`);

  let found = false;
  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) continue;

    let headerIdx = -1;
    let headerCells = null;
    for (let ri = 0; ri < Math.min(12, rows.length); ri++) {
      const raw = rows[ri] ?? [];
      const cells = [];
      for (let ci = 0; ci < 50; ci++)
        cells.push(String(raw[ci] ?? "").replace(/\s+/g," ").trim().toUpperCase());
      while (cells.length > 0 && cells[cells.length-1] === "") cells.pop();

      if (!cells[1]?.includes("CODE")) continue;
      const hasDiscount = cells.some(c => c === "DISCOUNT" || c.startsWith("DISCOUNT"));
      const hasBom = cells.some(c =>
        c.includes("BOM COST") || c.includes("BOMCOST") ||
        c.includes("PUR RATE") || c.includes("PURRATE"));
      if (hasDiscount && hasBom) { headerIdx = ri; headerCells = cells; break; }
    }

    if (headerIdx < 0) continue;
    found = true;

    console.log(`\n${"═".repeat(80)}`);
    console.log(`TAB: "${tabName}"  (header at row ${headerIdx+1})`);
    console.log("\nCOLUMN HEADERS (verbatim, normalized):");
    headerCells.forEach((h, i) => { if (h) console.log(`  col ${String(i+1).padStart(2)}: ${h}`); });

    const idx = makeIdx(headerCells);
    const avgSaleRes = idx("AVG SALE RATE", "AVG SALE", "AVGSALE");
    const bomCostRes = idx("BOM COST", "BOMCOST", "PUR RATE", "PURRATE");
    const avgSaleCol = avgSaleRes?.col ?? null;
    const bomCostCol = bomCostRes?.col ?? null;
    const sectionStart = Math.min(avgSaleCol ?? Infinity, bomCostCol ?? Infinity) - 1;

    let codeCol = 2;
    for (let i = sectionStart-1; i >= 0; i--) {
      const h = headerCells[i];
      if (h === "CODE" || h === "ITEM CODE") { codeCol = i+1; break; }
    }
    let qtyCol = 3;
    for (let i = sectionStart-1; i >= 0; i--) {
      const h = headerCells[i];
      if (h === "QTY" || h.startsWith("QTY")) { qtyCol = i+1; break; }
    }

    console.log("\nCOLUMN RESOLUTION (fixed 3-pass idx):");
    console.log(`  code        : col ${String(codeCol).padStart(2)}  "${headerCells[codeCol-1]}"`);
    console.log(`  qty         : col ${String(qtyCol).padStart(2)}  "${headerCells[qtyCol-1]}"`);
    console.log(describeRes("avgSale", avgSaleRes));
    console.log(describeRes("bomCost", bomCostRes));
    console.log(describeRes("discount", idx("DISCOUNT")));
    console.log(describeRes("mrp",      idx("MRP")));
    const wRes = idx("TOTAL  WEIGHT","TOTAL WEIGHT","TOTALWEIGHT") ?? idx("WEIGHT");
    console.log(describeRes("weight",   wRes));

    console.log("\nFIRST 3 DATA ROWS:");
    let printed = 0;
    for (const row of rows.slice(headerIdx+1)) {
      if (printed >= 3) break;
      const code = String(row?.[codeCol-1] ?? "").trim();
      if (!code || /^(TOTAL|GRAND|CODE|ITEM CODE)/i.test(code)) continue;
      const avgSale = avgSaleCol ? parseFloat(String(row?.[avgSaleCol-1]??"").replace(/,/g,"")) || null : null;
      const bomCost = bomCostCol ? parseFloat(String(row?.[bomCostCol-1]??"").replace(/,/g,"")) || null : null;
      const bomPct  = avgSale && bomCost ? (bomCost/avgSale*100).toFixed(2) : "?";
      console.log(`  code=${code}  avgSale=${avgSale?.toFixed(2)??"null"}  bomCost=${bomCost?.toFixed(6)??"null"}  BOM%=${bomPct}`);
      printed++;
    }
  }
  if (!found) console.log(`  No GP margin tabs detected in any sheet.`);
  return found;
}

async function main() {
  console.log("=== CP GP MARGIN — Drive discovery ===\n");

  const result = await listDriveFiles("GP MARGIN");
  const cpFolders = result.files.filter(f =>
    f.mimeType === "application/vnd.google-apps.folder" &&
    /cp|chrome/i.test(f.name) &&
    /25-26|2025-26|26-27|2026-27/.test(f.name)
  );

  if (cpFolders.length === 0) {
    console.log("No CP FY folders found in listDriveFiles result. Listing all folders:");
    result.files.filter(f => f.mimeType === "application/vnd.google-apps.folder")
      .forEach(f => console.log(`  "${f.name}" (${f.id})`));
    return;
  }

  console.log(`CP folders found: ${cpFolders.length}`);
  cpFolders.forEach(f => console.log(`  "${f.name}" (${f.id})`));

  // List contents of first CP folder
  const firstFolder = cpFolders[0];
  console.log(`\nContents of "${firstFolder.name}":`);
  const children = await listDriveFolder(firstFolder.id);
  const sheets = children.filter(c =>
    c.mimeType === "application/vnd.google-apps.spreadsheet" &&
    !/( to | qtr | quarter|summary|month on month)/i.test(c.name) &&
    /apr|may|jun|jul|aug|sep|oct|nov|dec|jan|feb|mar/i.test(c.name)
  );
  sheets.slice(0, 5).forEach(f => console.log(`  "${f.name}" (${f.id})`));

  if (sheets.length === 0) {
    console.log("No monthly spreadsheets found.");
    return;
  }

  // Try to fetch the first monthly file
  const target = sheets[0];
  await inspectFile(target.id, target.name);
  console.log("\nDONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
