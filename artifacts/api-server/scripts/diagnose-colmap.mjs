#!/usr/bin/env node
// Read-only diagnostic: replicate buildColMap exactly and report resolved
// column indices for one Plumbing file and one CP file.
//
// Usage: node artifacts/api-server/scripts/diagnose-colmap.mjs

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

// ── Exact replica of buildColMap from loader.ts ────────────────────────────
function buildColMap(cells) {
  const idx = (...patterns) => {
    // Pass 1: exact
    for (const p of patterns) {
      const i = cells.findIndex(c => c === p);
      if (i >= 0) return i + 1;
    }
    // Pass 2: startsWith
    for (const p of patterns) {
      const i = cells.findIndex(c => c.startsWith(p));
      if (i >= 0) return i + 1;
    }
    // Pass 3: includes — skip growth/percentage columns
    for (const p of patterns) {
      const i = cells.findIndex(
        c => c.includes(p) && !c.includes("GROWTH") && !c.includes("%")
      );
      if (i >= 0) return i + 1;
    }
    return null;
  };

  const avgSaleCol = idx("AVG SALE RATE", "AVG SALE", "AVGSALE");
  const bomCostCol = idx("BOM COST", "BOMCOST", "PUR RATE", "PURRATE");

  const sectionStart =
    avgSaleCol != null || bomCostCol != null
      ? Math.min(avgSaleCol ?? Infinity, bomCostCol ?? Infinity) - 1
      : cells.length;

  const codeCol = (() => {
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "CODE" || h === "ITEM CODE") return i + 1;
    }
    return 2;
  })();

  const qtyCol = (() => {
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "QTY" || h.startsWith("QTY")) return i + 1;
    }
    return 3;
  })();

  return { codeCol, qtyCol, avgSaleCol, bomCostCol, sectionStart };
}

// ── Subprocess fetch ───────────────────────────────────────────────────────
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

// ── Analyse one workbook ───────────────────────────────────────────────────
function analyseWorkbook(sheets, label) {
  console.log(`\n${"═".repeat(90)}`);
  console.log(`FILE: ${label}`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) { console.log(`  Tab "${tabName}": empty`); continue; }

    // Find header row (rows 0-11, matching detectGpMarginTabs)
    let headerIdx = -1;
    for (let ri = 0; ri < Math.min(12, rows.length); ri++) {
      // col B (index 1) must contain CODE
      const colB = String(rows[ri]?.[1] ?? "").toUpperCase().replace(/\s+/g, " ").trim();
      if (!colB.includes("CODE")) continue;
      // must have BOM/PUR RATE and DISCOUNT somewhere in the row (cols 1-50)
      const up50 = (rows[ri] ?? []).slice(0, 50).map(c => String(c ?? "").replace(/\s+/g," ").trim().toUpperCase());
      const hasBom = up50.some(c => c.includes("BOM COST") || c.includes("PUR RATE") || c.includes("BOMCOST") || c.includes("PURRATE"));
      const hasDiscount = up50.some(c => c === "DISCOUNT" || c.startsWith("DISCOUNT"));
      if (!hasBom || !hasDiscount) continue;
      headerIdx = ri;
      break;
    }

    if (headerIdx < 0) {
      const sample = (rows[0] ?? []).slice(0,10).map(c => String(c ?? "")).join(" | ");
      console.log(`\nTab "${tabName}": no header detected. Row 0 sample: ${sample.slice(0,120)}`);
      continue;
    }

    const rawCells = (rows[headerIdx] ?? []).slice(0, 50);
    const cells = rawCells.map(c => String(c ?? "").replace(/\s+/g, " ").trim().toUpperCase());

    console.log(`\nTab "${tabName}" — header at row ${headerIdx + 1}`);
    console.log("VERBATIM HEADERS (non-empty cols 1-50):");
    cells.forEach((h, i) => { if (h) console.log(`  col ${(i+1).toString().padStart(2)}: ${h}`); });

    const cm = buildColMap(cells);
    console.log("\nCOLMAP RESOLUTION:");
    console.log(`  sectionStart  = ${cm.sectionStart}  (right-to-left CODE/QTY search stops here)`);
    console.log(`  codeCol       = ${cm.codeCol}  → header: "${cells[cm.codeCol - 1] ?? "(none)"}"`);
    console.log(`  qtyCol        = ${cm.qtyCol}  → header: "${cells[cm.qtyCol - 1] ?? "(none)"}"`);
    console.log(`  avgSaleCol    = ${cm.avgSaleCol}  → header: "${cm.avgSaleCol ? (cells[cm.avgSaleCol - 1] ?? "(none)") : "NULL"}"`);
    console.log(`  bomCostCol    = ${cm.bomCostCol}  → header: "${cm.bomCostCol ? (cells[cm.bomCostCol - 1] ?? "(none)") : "NULL"}"`);
    console.log(`  → code in right-hand section (col > sectionStart)? ${cm.codeCol > cm.sectionStart ? "YES ✓" : "NO — col " + cm.codeCol + " ≤ sectionStart " + cm.sectionStart + " ✗"}`);

    // First 3 data rows
    console.log("\nFIRST 3 DATA ROWS (resolved columns only):");
    let printed = 0;
    for (const row of rows.slice(headerIdx + 1)) {
      if (printed >= 3) break;
      const code = String(row[cm.codeCol - 1] ?? "").trim();
      if (!code || ["CODE","ITEM CODE"].includes(code.toUpperCase()) ||
          code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND")) continue;
      const qty     = row[cm.qtyCol - 1];
      const avgSale = cm.avgSaleCol ? row[cm.avgSaleCol - 1] : null;
      const bomCost = cm.bomCostCol ? row[cm.bomCostCol - 1] : null;
      console.log(`  code="${code}"  qty=${qty}  avgSale=${avgSale}  bomCost=${bomCost}`);
      printed++;
    }
    if (printed === 0) console.log("  (no data rows found)");
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const targets = [
    // Plumbing monthly file (Apr 25-26) — previously found in diagnose-plumbing-file.mjs
    { id: "1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g", label: "PLUMBING – Apr 25-26 (monthly)" },
    // CP monthly file — May 25-26 from CP SALE GP MARGIN 25-26 folder
    { id: null, label: "CP — will be fetched from folder" },
  ];

  // For CP use one of the known file IDs from the recent reload status:
  // "CP SALE GP MARGIN May 25-26" appeared in filesCumulative — but we need a monthly one.
  // Use the CP SALE GP MARGIN 25-26 folder id=14UDrgE2Gw3s0wW3yIOux4GKS5aaqzq4r
  // and pick first monthly file from it.
  const CP_FOLDER_ID = "14UDrgE2Gw3s0wW3yIOux4GKS5aaqzq4r";
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
    ? `depl ${process.env.WEB_REPL_RENEWAL}`
    : null;
  const tokenRes = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
  );
  const tokenData = await tokenRes.json();
  const driveItem = (tokenData.items ?? []).find(c => c.connector_name === "google-drive");
  const accessToken = driveItem?.settings?.access_token ?? driveItem?.access_token;

  // List the CP folder to find a monthly file
  const cpFolderUrl = new URL("https://www.googleapis.com/drive/v3/files");
  Object.entries({
    q: `'${CP_FOLDER_ID}' in parents and trashed = false`,
    pageSize: "50", orderBy: "name", spaces: "drive",
    fields: "files(id,name,mimeType)",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  }).forEach(([k, v]) => cpFolderUrl.searchParams.set(k, v));
  const cpFolderResp = await fetch(cpFolderUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const cpFolder = await cpFolderResp.json();
  console.log("\nCP folder contents:");
  for (const f of (cpFolder.files ?? [])) {
    console.log(`  ${f.mimeType === "application/vnd.google-apps.spreadsheet" ? "SHEET" : "OTHER"} "${f.name}" id=${f.id}`);
  }
  const cpMonthly = (cpFolder.files ?? []).find(f =>
    f.mimeType === "application/vnd.google-apps.spreadsheet" &&
    !f.name.toLowerCase().includes(" to ") &&
    !f.name.toLowerCase().includes("qtr") &&
    !f.name.toLowerCase().includes("quarter")
  );
  if (!cpMonthly) { console.log("No CP monthly file found."); return; }
  console.log(`\nSelected CP file: "${cpMonthly.name}" (${cpMonthly.id})`);

  // Fetch both in parallel
  const [plumbingSheets, cpSheets] = await Promise.all([
    fetchWorkbook("1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g"),
    fetchWorkbook(cpMonthly.id),
  ]);

  analyseWorkbook(plumbingSheets, "PLUMBING – Apr 25-26 (id=1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g)");
  analyseWorkbook(cpSheets,      `CP – "${cpMonthly.name}" (${cpMonthly.id})`);

  console.log("\nDONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
