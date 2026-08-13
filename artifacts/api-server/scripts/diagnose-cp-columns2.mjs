#!/usr/bin/env node
// Inspect a CP GP MARGIN monthly file.
// Uses the same raw Drive API token pattern as diagnose-sanit-columns.mjs.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

async function getToken() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
    ? `depl ${process.env.WEB_REPL_RENEWAL}`
    : null;
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
  );
  const data = await res.json();
  const item = (data.items ?? []).find((c) => c.connector_name === "google-drive");
  return item?.settings?.access_token ?? item?.access_token;
}

async function driveSearch(token, q) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  Object.entries({
    q: `name contains '${q}' and trashed = false`,
    pageSize: "50", orderBy: "name", spaces: "drive",
    fields: "files(id,name,mimeType)",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

async function listFolder(token, folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  Object.entries({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: "100", orderBy: "name", spaces: "drive",
    fields: "files(id,name,mimeType)",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
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

// FIXED 3-pass idx()
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

async function main() {
  const token = await getToken();
  console.log("=== CP GP MARGIN — Drive discovery ===\n");

  // Search for CP GP MARGIN folders
  const res = await driveSearch(token, "CP SALE GP MARGIN");
  const cpFolders = (res.files ?? []).filter(f =>
    f.mimeType === "application/vnd.google-apps.folder" &&
    /25-26|2025-26|26-27|2026-27/.test(f.name)
  );

  console.log(`Found ${cpFolders.length} CP FY folder(s):`);
  cpFolders.forEach(f => console.log(`  "${f.name}" (${f.id})`));

  // Also look for "CP GP MARGIN"
  const res2 = await driveSearch(token, "CP GP MARGIN");
  const cpFolders2 = (res2.files ?? []).filter(f =>
    f.mimeType === "application/vnd.google-apps.folder" &&
    /25-26|2025-26|26-27|2026-27/.test(f.name)
  );
  cpFolders2.forEach(f => {
    if (!cpFolders.find(x => x.id === f.id)) {
      cpFolders.push(f);
      console.log(`  "${f.name}" (${f.id})  [from CP GP MARGIN search]`);
    }
  });

  if (cpFolders.length === 0) {
    console.log("\nNo CP FY folders — listing ALL folder results from both searches:");
    [...(res.files??[]), ...(res2.files??[])]
      .filter(f => f.mimeType === "application/vnd.google-apps.folder")
      .forEach(f => console.log(`  "${f.name}" (${f.id})`));
    return;
  }

  // Get contents of first CP folder
  let targetFile = null;
  for (const folder of cpFolders.slice(0, 2)) {
    console.log(`\nContents of "${folder.name}":`);
    const kids = await listFolder(token, folder.id);
    (kids.files ?? []).slice(0, 8).forEach(f =>
      console.log(`  ${f.mimeType === "application/vnd.google-apps.spreadsheet" ? "SHEET" : "OTHER"} "${f.name}" (${f.id})`)
    );
    if (!targetFile) {
      targetFile = (kids.files ?? []).find(f =>
        f.mimeType === "application/vnd.google-apps.spreadsheet" &&
        !/ to /i.test(f.name) && !/qtr/i.test(f.name) && !/quarter/i.test(f.name) &&
        !/summary/i.test(f.name) &&
        /apr|may|jun|jul|aug|sep|oct|nov|dec|jan|feb|mar/i.test(f.name)
      );
    }
  }

  if (!targetFile) { console.log("No monthly CP file found."); return; }

  console.log(`\n\nFetching: "${targetFile.name}" (${targetFile.id})`);
  let sheets;
  try { sheets = await fetchWorkbook(targetFile.id); }
  catch (err) { console.log(`ERROR: ${err.message}`); return; }

  console.log(`Tabs: ${sheets.map(s => s.name).join(" | ")}`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) continue;

    // Find header row (rows 1-12)
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

    if (!headerCells) {
      // Still print headers for any tab with CODE in col B
      let anyHeaderIdx = -1;
      for (let ri = 0; ri < Math.min(12, rows.length); ri++) {
        const colB = String((rows[ri] ?? [])[1] ?? "").toUpperCase().trim();
        if (colB.includes("CODE")) { anyHeaderIdx = ri; break; }
      }
      if (anyHeaderIdx >= 0) {
        const hdr = (rows[anyHeaderIdx] ?? []).map(c => String(c??"").replace(/\s+/g," ").trim());
        console.log(`\nTab "${tabName}" (no BOM+discount detected): ${hdr.filter(Boolean).join(" | ")}`);
      }
      continue;
    }

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

    let codeCol = 2, qtyCol = 3;
    for (let i = sectionStart-1; i >= 0; i--) {
      const h = headerCells[i];
      if (codeCol === 2 && (h === "CODE" || h === "ITEM CODE")) { codeCol = i+1; }
    }
    for (let i = sectionStart-1; i >= 0; i--) {
      const h = headerCells[i];
      if (qtyCol === 3 && (h === "QTY" || h.startsWith("QTY"))) { qtyCol = i+1; }
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
  console.log("\nDONE.");
}

main().catch(e => { console.error(e); process.exit(1); });
