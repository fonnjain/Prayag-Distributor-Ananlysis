#!/usr/bin/env node
// Diagnosis script — prints GP margin workbook column headers + sample values
// for Garden Pipe, Sanitaryware, PTMT and the full Plumbing folder discovery.
// Read-only. Does not touch the database.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "/dist");
const FETCHER  = path.join(DIST_DIR, "gpMarginFetcher.mjs");
const NODE     = process.execPath;

// ── Auth ────────────────────────────────────────────────────────────────────

async function getToken() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) throw new Error("REPLIT_CONNECTORS_HOSTNAME not set");

  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
    ? `depl ${process.env.WEB_REPL_RENEWAL}`
    : null;
  if (!xReplitToken) throw new Error("No Replit identity token");

  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
  );
  const data = await res.json();
  const item = (data.items ?? []).find((c) => c.connector_name === "google-drive");
  const token = item?.settings?.access_token ?? item?.access_token;
  if (!token) throw new Error("google-drive access_token not found in connection");
  return token;
}

// ── Drive helpers ────────────────────────────────────────────────────────────

async function driveGet(token, path_, params = {}) {
  const url = new URL(`https://www.googleapis.com/drive/v3${path_}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive ${path_} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function listByName(token, nameFragment) {
  const escaped = nameFragment.replace(/'/g, "\\'");
  return driveGet(token, "/files", {
    q: `name contains '${escaped}' and trashed = false`,
    pageSize: "100",
    orderBy: "folder,modifiedTime desc",
    spaces: "drive",
    fields: "files(id,name,mimeType,modifiedTime)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
}

async function listFolder(token, folderId) {
  return driveGet(token, "/files", {
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: "200",
    orderBy: "name",
    spaces: "drive",
    fields: "files(id,name,mimeType,modifiedTime)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
}

// ── Fetcher wrapper ──────────────────────────────────────────────────────────

function fetchWorkbook(fileId) {
  return new Promise((resolve, reject) => {
    execFile(
      "timeout", ["120", NODE, "--enable-source-maps", FETCHER, fileId],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        if (stdout) {
          try {
            const r = JSON.parse(stdout);
            if (r.ok) { resolve(r.sheets); return; }
            reject(new Error(r.error));
            return;
          } catch {}
        }
        reject(err ?? new Error(`no output for ${fileId}`));
      }
    );
  });
}

// ── Column analysis ──────────────────────────────────────────────────────────

function analyzeWorkbook(sheets, filename) {
  const result = [];
  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) continue;

    // Find header row (rows 1-8): col B must contain CODE
    let headerRowIdx = -1;
    for (let ri = 0; ri < Math.min(8, rows.length); ri++) {
      const colB = String(rows[ri]?.[1] ?? "").toUpperCase().replace(/\s+/g," ").trim();
      if (colB.includes("CODE")) { headerRowIdx = ri; break; }
    }
    if (headerRowIdx < 0) continue;

    const headerCells = rows[headerRowIdx].map((c) =>
      String(c ?? "").replace(/\s+/g, " ").trim()
    );
    const hasBom = headerCells.some(c =>
      c.toUpperCase().includes("BOM") || c.toUpperCase().includes("PUR RATE") || c.toUpperCase().includes("PURRATE")
    );
    const hasDiscount = headerCells.some(c => c.toUpperCase().startsWith("DISCOUNT"));
    if (!hasBom && !hasDiscount) continue; // not a GP margin tab

    result.push({ tabName, headerRowIdx, headerCells, dataRows: rows.slice(headerRowIdx + 1) });
  }
  return result;
}

function printTab(tabAnalysis, filename, maxCodes = 3) {
  console.log(`\n${"═".repeat(90)}`);
  console.log(`FILE: ${filename}`);
  console.log(`TAB:  ${tabAnalysis.tabName}`);
  console.log(`${"─".repeat(90)}`);

  console.log("\nCOLUMN HEADERS (position → header text):");
  tabAnalysis.headerCells.forEach((h, i) => {
    if (h) console.log(`  col ${(i+1).toString().padStart(2)}: ${h}`);
  });

  console.log(`\nFIRST ${maxCodes} DATA ROWS:`);
  let printed = 0;
  for (const row of tabAnalysis.dataRows) {
    if (printed >= maxCodes) break;
    const code = String(row[1] ?? "").trim();
    if (!code || code.toUpperCase() === "CODE" || code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND")) continue;
    console.log(`\n  Code: ${code}`);
    row.forEach((v, i) => {
      const header = tabAnalysis.headerCells[i];
      if (!header) return;
      if (v !== null && v !== "" && v !== undefined) {
        const display = typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 6 }) : String(v);
        console.log(`    col ${(i+1).toString().padStart(2)} [${header}]: ${display}`);
      }
    });
    printed++;
  }
}

// ── Segment target files ─────────────────────────────────────────────────────

// We'll pick ONE file per segment from Drive (no trailing period, FY2025-26, monthly).
// Targets chosen to match what we know is in the DB.
const SEGMENT_TARGETS = [
  { segment: "Garden Pipe",  nameFragment: "GARDEN PIPE SALE GP MARGIN  Apr 25-26", fy: "2025-26" },
  { segment: "Sanitaryware", nameFragment: "SANITARYWARE",                           fy: "2025-26" },
  { segment: "PTMT",         nameFragment: "PTMT SALE GP MARGIN APR 25-26",          fy: "2025-26" },
];

// ── Plumbing discovery ───────────────────────────────────────────────────────

function detectFy(name) {
  if (/25-26|2025-26/.test(name)) return "2025-26";
  if (/26-27|2026-27/.test(name)) return "2026-27";
  return null;
}

function canonicalSegment(name) {
  if (/waste\s*pipe/i.test(name))  return "Waste Pipe & Connection";
  if (/garden\s*pipe/i.test(name)) return "Garden Pipe";
  if (/sanitar/i.test(name))       return "Sanitaryware";
  if (/plumb/i.test(name))         return "Plumbing";
  if (/hardware/i.test(name))      return "Hardware";
  if (/ptmt/i.test(name))          return "PTMT";
  if (/\bcp\b|chrome/i.test(name)) return "CP";
  if (/sink/i.test(name))          return "Sink";
  return "UNKNOWN";
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = await getToken();
  console.log("OAuth token obtained.");

  // ── PART 1: Plumbing / cumulative discovery ─────────────────────────────
  console.log("\n" + "█".repeat(90));
  console.log("PART 1 — FULL DISCOVERY: listDriveFiles(q='GP MARGIN')");
  console.log("█".repeat(90));

  const allGp = await listByName(token, "GP MARGIN");
  console.log(`\nTotal items returned: ${allGp.files.length}`);

  const folders = allGp.files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
  const nonFolders = allGp.files.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

  console.log(`\nFOLDERS (${folders.length}):`);
  for (const f of folders) {
    const fy = detectFy(f.name);
    const seg = canonicalSegment(f.name);
    const accepted = fy !== null;
    console.log(`  [${accepted ? "ACCEPT" : "REJECT"}] name="${f.name}" fy=${fy ?? "null"} segment=${seg} id=${f.id}`);
  }

  console.log(`\nNON-FOLDER files returned directly (${nonFolders.length}):`);
  for (const f of nonFolders) {
    console.log(`  name="${f.name}" mime=${f.mimeType}`);
  }

  // For each ACCEPTED folder, list its contents (to find Plumbing files)
  const acceptedFolders = folders.filter(f => detectFy(f.name) !== null);

  // Specifically look for Plumbing
  console.log("\n── CHECKING EACH ACCEPTED FOLDER FOR CONTENTS ──");
  for (const folder of acceptedFolders) {
    const fy = detectFy(folder.name);
    const seg = canonicalSegment(folder.name);
    const children = await listFolder(token, folder.id);
    const spreadsheets = children.files.filter(f =>
      f.mimeType === "application/vnd.google-apps.spreadsheet" ||
      /\.(xlsx|xls)$/i.test(f.name)
    );
    const subFolders = children.files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
    console.log(`\n  Folder: "${folder.name}" (fy=${fy}, segment=${seg})`);
    console.log(`    → ${spreadsheets.length} spreadsheets, ${subFolders.length} sub-folders`);
    for (const sf of subFolders) {
      console.log(`    sub-folder: "${sf.name}"`);
      // recurse one level
      const grandchildren = await listFolder(token, sf.id);
      const gc_sheets = grandchildren.files.filter(f =>
        f.mimeType === "application/vnd.google-apps.spreadsheet" ||
        /\.(xlsx|xls)$/i.test(f.name)
      );
      console.log(`      → ${gc_sheets.length} spreadsheets inside`);
      for (const gs of gc_sheets.slice(0, 5)) console.log(`        "${gs.name}"`);
    }
    // print first 5 spreadsheet names
    for (const s of spreadsheets.slice(0, 5)) {
      console.log(`    file: "${s.name}"`);
    }
    if (spreadsheets.length > 5) console.log(`    ... and ${spreadsheets.length - 5} more`);
  }

  // Also search specifically for "Plumbing" to catch any folder the GP MARGIN search missed
  console.log("\n── SEPARATE SEARCH: listDriveFiles(q='Plumbing GP MARGIN') ──");
  const plumbSearch = await listByName(token, "Plumbing GP MARGIN");
  console.log(`Results: ${plumbSearch.files.length}`);
  for (const f of plumbSearch.files) {
    const fy = detectFy(f.name);
    console.log(`  [${fy ? "ACCEPT" : "REJECT"}] name="${f.name}" mime=${f.mimeType} fy=${fy ?? "null"} id=${f.id}`);
  }

  // Also search for "Plumbing" alone
  console.log("\n── SEPARATE SEARCH: listDriveFiles(q='Plumbing') ──");
  const plumbOnly = await listByName(token, "Plumbing");
  console.log(`Results: ${plumbOnly.files.length}`);
  for (const f of plumbOnly.files.slice(0, 20)) {
    const fy = detectFy(f.name);
    console.log(`  name="${f.name}" mime=${f.mimeType} fy=${fy ?? "null"}`);
  }

  // ── PART 2: Column inspection for 3 segments ────────────────────────────
  console.log("\n\n" + "█".repeat(90));
  console.log("PART 2 — WORKBOOK COLUMN INSPECTION");
  console.log("█".repeat(90));

  // Find the actual file IDs for our target files
  const targets = [];

  // Garden Pipe: search by exact name
  for (const t of SEGMENT_TARGETS) {
    const search = await listByName(token, t.nameFragment.trim());
    const candidates = search.files.filter(f =>
      f.mimeType === "application/vnd.google-apps.spreadsheet" &&
      f.name.trim().toLowerCase().startsWith(t.nameFragment.trim().toLowerCase().slice(0, 20))
    );
    // If exact not found, broaden
    let fileId = null;
    let fileName = null;
    if (candidates.length > 0) {
      // Prefer the one WITHOUT trailing period
      const noPeriod = candidates.find(f => !f.name.trim().endsWith("."));
      const chosen = noPeriod ?? candidates[0];
      fileId = chosen.id;
      fileName = chosen.name;
    } else {
      // Try broader search
      const broader = await listByName(token, t.nameFragment.trim().split(" ").slice(0, 4).join(" "));
      const b2 = broader.files.filter(f =>
        f.mimeType === "application/vnd.google-apps.spreadsheet"
      );
      if (b2.length > 0) {
        const noPeriod = b2.find(f => !f.name.trim().endsWith("."));
        const chosen = noPeriod ?? b2[0];
        fileId = chosen.id;
        fileName = chosen.name;
      }
    }
    targets.push({ ...t, fileId, fileName });
    console.log(`\nTarget for ${t.segment}: fileId=${fileId ?? "NOT FOUND"} name="${fileName ?? "—"}"`);
  }

  for (const t of targets) {
    if (!t.fileId) {
      console.log(`\n[SKIP] ${t.segment}: no file ID found`);
      continue;
    }
    console.log(`\nFetching ${t.segment} workbook (id=${t.fileId})...`);
    let sheets;
    try {
      sheets = await fetchWorkbook(t.fileId);
    } catch (err) {
      console.log(`  ERROR fetching: ${err.message}`);
      continue;
    }
    const tabs = analyzeWorkbook(sheets, t.fileName);
    if (tabs.length === 0) {
      console.log(`  No GP margin tabs detected. All tabs: ${sheets.map(s => s.name).join(", ")}`);
      continue;
    }
    for (const tab of tabs) {
      printTab(tab, t.fileName);
    }
  }

  console.log("\n\nDONE.");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
