#!/usr/bin/env node
// Fetch one Sanitaryware GP margin monthly file and print column headers + values.

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

async function main() {
  const token = await getToken();

  // Known Sanitaryware GP MARGIN 25-26 folder IDs from the discovery run:
  //   "SANITARYWARE SALE GP MARGIN 25-26" → 1ESyPNAWA7q-gfBHZ57T8ZQC43OjcpeLA
  //   "Sanitaryware GP MARGIN 25-26"       → 1v5gaLoYU1aIViYp0rW_BlKOzXC8A7g6B
  const folderIds = [
    "1ESyPNAWA7q-gfBHZ57T8ZQC43OjcpeLA",
    "1v5gaLoYU1aIViYp0rW_BlKOzXC8A7g6B",
  ];

  let targetId = null, targetName = null;
  for (const fid of folderIds) {
    const res = await listFolder(token, fid);
    console.log(`\nFolder ${fid} contents:`);
    for (const f of res.files) {
      console.log(`  ${f.mimeType === "application/vnd.google-apps.spreadsheet" ? "SHEET" : "OTHER"} "${f.name}" id=${f.id}`);
    }
    // Pick first monthly spreadsheet (not cumulative, not 1st Qtr)
    const monthly = res.files.find(f =>
      f.mimeType === "application/vnd.google-apps.spreadsheet" &&
      !f.name.toLowerCase().includes("qtr") &&
      !f.name.toLowerCase().includes(" to ") &&
      !f.name.toLowerCase().includes("quarter")
    );
    if (monthly && !targetId) {
      targetId = monthly.id;
      targetName = monthly.name;
    }
  }

  if (!targetId) { console.log("No monthly Sanitaryware file found."); return; }

  console.log(`\n\nFetching: "${targetName}" (${targetId})`);
  const sheets = await fetchWorkbook(targetId);
  console.log(`Tabs: ${sheets.map(s => s.name).join(", ")}`);

  for (const { name: tabName, rows } of sheets) {
    if (!rows || rows.length < 2) continue;
    // Find header row
    let headerIdx = -1;
    for (let ri = 0; ri < Math.min(10, rows.length); ri++) {
      const colB = String(rows[ri]?.[1] ?? "").toUpperCase().trim();
      if (colB.includes("CODE") || colB.includes("ITEM")) { headerIdx = ri; break; }
    }
    if (headerIdx < 0) continue;
    const headers = rows[headerIdx].map(c => String(c ?? "").replace(/\s+/g, " ").trim());
    const hasBom = headers.some(h => h.toUpperCase().includes("BOM") || h.toUpperCase().includes("PUR RATE"));
    const hasDiscount = headers.some(h => h.toUpperCase().startsWith("DISCOUNT"));
    if (!hasBom && !hasDiscount) {
      console.log(`\nTab "${tabName}": no BOM/Discount column — SKIPPING (headers: ${headers.filter(Boolean).join(" | ")})`);
      continue;
    }

    console.log(`\n${"═".repeat(90)}`);
    console.log(`TAB: ${tabName}`);
    console.log("COLUMN HEADERS:");
    headers.forEach((h, i) => { if (h) console.log(`  col ${(i+1).toString().padStart(2)}: ${h}`); });

    console.log("\nFIRST 3 DATA ROWS:");
    let printed = 0;
    for (const row of rows.slice(headerIdx + 1)) {
      if (printed >= 3) break;
      const code = String(row[1] ?? "").trim();
      if (!code || code.toUpperCase().startsWith("TOTAL") || code.toUpperCase().startsWith("GRAND") || code.toUpperCase() === "CODE" || code.toUpperCase().includes("ITEM")) continue;
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
