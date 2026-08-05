// PSCode_3 pre-flight duplicate + State-Head checker.
//
// Run this BEFORE any load script to catch:
//   1. Duplicate-export pairs — two files whose data rows overlap ≥ OVERLAP_THRESHOLD.
//      The export tool periodically emits the same Order IDs under two salesperson
//      names; loading both doubles that person's figures.
//   2. State-Head filenames — a file whose name matches a known pure roll-up head.
//      These heads have no individual PS code; their presence as a PSCode_3 file
//      means the export has mislabelled a rep's data under the head's name.
//      → exit 1 (blocking)
//   3. Dual-role names — heads who also operate as field reps and legitimately
//      appear in PSCode_3 exports.  Flagged with a clarification warning so the
//      loader author confirms the file is personal sales, not a roll-up.
//      → warning only, no exit 1
//   4. Watch-list names — former or unresolved heads whose status is not settled.
//      Flagged with a warning so each drop is deliberately reviewed.
//      → warning only, no exit 1
//
// Usage:
//   node dist/pscode3-preflight.mjs --dir /tmp/jul26/PSCode\ 3\ NEW\ REPORTS\ JULY2026
//   node dist/pscode3-preflight.mjs --dir /tmp/pscode3/PSCODE\ 3\ NEW\ REPORT
//   node dist/pscode3-preflight.mjs --dir <path> --overlap 80  (change threshold)
//   node dist/pscode3-preflight.mjs --dir <path> --report-only (exit 0 even if issues)
//
// Exit codes:
//   0 — no blocking issues (or --report-only); warnings may still be printed
//   1 — one or more duplicate pairs or pure-State-Head filenames found
//
// Fingerprint: for each data row, we hash (date-month, retailer-name, item-code,
// net-amount).  Two files are duplicate-flagged when the smaller file's fingerprint
// set overlaps the larger's by ≥ OVERLAP_THRESHOLD %.  This is stable because the
// only difference between duplicate exports is the salesperson name (= filename).
//
// No database connection required.  Reads xlsx only.

import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argDir = args.find((_, i) => args[i - 1] === "--dir");
if (!argDir) {
  console.error("Usage: node dist/pscode3-preflight.mjs --dir <xlsx-directory>");
  process.exit(2);
}
const DIR = argDir;
const argOverlap = args.find((_, i) => args[i - 1] === "--overlap");
const OVERLAP_THRESHOLD = argOverlap ? parseFloat(argOverlap) : 85;
const REPORT_ONLY = args.includes("--report-only");

// ── Helpers ───────────────────────────────────────────────────────────────────
const str = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "result" in (v as Record<string, unknown>))
    return String((v as Record<string, unknown>).result ?? "").trim();
  return String(v).trim();
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
function monthStr(v: unknown): string {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "number" && v > 20000) d = new Date((v - 25569) * 86400000);
  else if (typeof v === "string") {
    const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(v.trim());
    if (m) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  }
  if (!d || isNaN(d.getTime())) return "";
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${M[d.getUTCMonth()]}-${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}
/** Normalise to bare-alphanumeric lowercase for stable cross-name comparison. */
const normAlpha = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ── Name lists ─────────────────────────────────────────────────────────────────
//
// KNOWN_STATE_HEADS — 12 pure roll-up heads (no individual PS code).
//   A PSCode_3 file under any of these names is a mislabelled export.
//   → blocking (exit 1)
//
//   To refresh, run:
//     psql $DATABASE_URL -c "SELECT DISTINCT head_canon FROM sale_line
//       WHERE head_canon IS NOT NULL
//       AND head_canon != 'Non-territory / Project / Govt' ORDER BY 1;"
//   Note: Shailesh Sharma appears in the State Head workbooks for FY2026-27
//   but has no primary register rows yet for that FY; include him here until
//   his position is formally confirmed as departed.
//
const KNOWN_STATE_HEADS: string[] = [
  "Anant Singh",
  "Biju C.O",
  "Lalan Kumar",
  "Narendra Sharma",
  "Nasir Hussain Khan",
  "Pawan Sharma",
  "Sandeep Dadheech",
  "Shailesh Sharma",   // in FY26-27 State Head workbooks; no primary rows yet
  "Sulinder Pal",
  "Sunil Patel",
  "Syed Aqil Rizvi",
];

// DUAL_ROLE_HEADS — heads who also operate as field reps and legitimately
//   hold an individual PS code.  Their PSCode_3 file is NOT automatically a
//   mislabelling — it may represent their own personal field sales.
//   → warning only: loader author must confirm before adding to DUP_DROP
//
//   Anuj Sharma: head_canon in sale_line FY2026-27 AND in member_sheet_map.json
//   (has his own member working sheet).  His file is legitimate if it contains
//   his own retailer visits; mislabelled if it duplicates a team member's data.
//   Check against his known customer list or compare with other members' files
//   before deciding.
//
const DUAL_ROLE_HEADS: string[] = [
  "Anuj Sharma",
];

// WATCH_LIST — former heads or heads with unresolved status.
//   Their appearance in a PSCode_3 drop is unexpected and should be
//   reviewed, but does not block loading.
//   → warning only (no exit 1)
//
//   Babu: Tamil Nadu + Andaman head through FY2024-25; zero FY2025-26 or
//     FY2026-27 primary register rows.  Status unresolved — verify with Deepak
//     whether he has territory in the current FY before accepting his file.
//
//   Suresh Nair: AP / Telangana / Karnataka head through FY2025-26.  Status
//     unresolved — 5 customers in the Suresh Nair file for FY2025-26 also
//     appear in the Sandeep Dadheech AP TELENGANA file; territory overlap not
//     yet resolved.  Verify before accepting.
//
const WATCH_LIST: string[] = [
  "Babu",
  "Suresh Nair",
];

const stateHeadNorms  = new Set(KNOWN_STATE_HEADS.map(normAlpha));
const dualRoleNorms   = new Set(DUAL_ROLE_HEADS.map(normAlpha));
const watchNorms      = new Set(WATCH_LIST.map(normAlpha));

console.log(
  `Name lists: ${stateHeadNorms.size} blocking heads, ` +
  `${dualRoleNorms.size} dual-role (warn), ` +
  `${watchNorms.size} watch (warn).`,
);

// ── Discover xlsx files ───────────────────────────────────────────────────────
const allFiles = readdirSync(DIR)
  .filter((f) => f.startsWith("PSCode_3_New_Report ") && f.endsWith(".xlsx"))
  .sort();
if (allFiles.length === 0) {
  console.error(`No PSCode_3_New_Report *.xlsx files found in: ${DIR}`);
  process.exit(2);
}
console.log(`\nFiles found: ${allFiles.length}`);

// ── Build fingerprint sets ────────────────────────────────────────────────────
// Fingerprint = SHA1 of "month|retailer|itemCode|net" for each data row.
// Stable across files because those 4 fields are independent of the salesperson name.
type FileInfo = {
  name: string;          // raw filename
  member: string;        // name extracted from filename
  memberNorm: string;    // normAlpha'd for State Head lookup
  fps: Set<string>;      // fingerprint set
  rows: number;          // data rows counted
  net: number;           // total net
};

const files: FileInfo[] = [];
let totalRows = 0;

console.log(`\nReading ${allFiles.length} files to build fingerprints…`);
for (const fname of allFiles) {
  const rawMember = fname.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR, fname));
  const fps = new Set<string>();
  let rowCount = 0;
  let fileNet = 0;

  wb.worksheets[0].eachRow((row, rn) => {
    if (rn <= 2) return;
    const c = (i: number) => row.getCell(i).value as unknown;
    if (str(c(1)).toUpperCase().startsWith("TOTAL")) return;
    const net = num(c(13));
    const gross = num(c(10));
    if (gross == null && net == null) return;
    const retailer = str(c(4));
    const itemCode = str(c(7));
    const month = monthStr(c(2));
    // Fingerprint: month + retailer + itemCode + net (all 4 together are near-unique per row)
    const fp = crypto
      .createHash("sha1")
      .update(`${month}|${retailer}|${itemCode}|${net ?? ""}`)
      .digest("hex");
    fps.add(fp);
    rowCount++;
    fileNet += net ?? 0;
  });

  files.push({
    name: fname,
    member: rawMember,
    memberNorm: normAlpha(rawMember),
    fps,
    rows: rowCount,
    net: fileNet,
  });
  totalRows += rowCount;
}
console.log(`Fingerprints built. Total data rows: ${totalRows.toLocaleString()}`);

// ── Check 1: Duplicate-export pairs ──────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`CHECK 1: Duplicate exports (overlap ≥ ${OVERLAP_THRESHOLD}%)`);
console.log(`${"─".repeat(60)}`);

type DupPair = {
  a: FileInfo;
  b: FileInfo;
  overlapPct: number;
  sharedFps: number;
};
const dupPairs: DupPair[] = [];

for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    const a = files[i];
    const b = files[j];
    // Intersection size
    const smaller = a.fps.size <= b.fps.size ? a : b;
    const larger  = a.fps.size <= b.fps.size ? b : a;
    if (smaller.fps.size === 0) continue;
    let shared = 0;
    for (const fp of smaller.fps) {
      if (larger.fps.has(fp)) shared++;
    }
    const overlapPct = (shared / smaller.fps.size) * 100;
    if (overlapPct >= OVERLAP_THRESHOLD) {
      dupPairs.push({ a, b, overlapPct, sharedFps: shared });
    }
  }
}

if (dupPairs.length === 0) {
  console.log("✓ No duplicate-export pairs detected.");
} else {
  // Group overlapping files into clusters
  console.log(`⚠  ${dupPairs.length} duplicate-export pair(s) found:\n`);
  for (const p of dupPairs.sort((x, y) => y.overlapPct - x.overlapPct)) {
    const smaller = p.a.fps.size <= p.b.fps.size ? p.a : p.b;
    const larger  = p.a.fps.size <= p.b.fps.size ? p.b : p.a;
    console.log(
      `  ${p.overlapPct.toFixed(1)}% overlap — KEEP one, DROP the other:`,
    );
    console.log(
      `    larger  (${larger.rows} rows, ₹${(larger.net / 1e7).toFixed(2)} Cr): "${larger.member}"`,
    );
    console.log(
      `    smaller (${smaller.rows} rows, ₹${(smaller.net / 1e7).toFixed(2)} Cr): "${smaller.member}"`,
    );
    console.log(
      `    shared fingerprints: ${p.sharedFps} / ${smaller.fps.size}`,
    );
    console.log();
  }
  // Suggested DUP_DROP entries.
  // When one file is clearly smaller (fewer unique fingerprints) it is almost
  // always the one to drop.  When both files have the same fingerprint count
  // the export tool emitted two equal copies — the keeper must be identified
  // from the roster; no automatic recommendation is made for those pairs.
  const clearDrops = new Set<string>();
  const equalPairs: Array<[string, string]> = [];
  for (const p of dupPairs) {
    if (p.a.fps.size !== p.b.fps.size) {
      const smaller = p.a.fps.size < p.b.fps.size ? p.a : p.b;
      clearDrops.add(smaller.member);
    } else {
      // Equal size — cannot determine keeper automatically; skip the 3-way
      // cases where one file already appears as a clear drop in another pair.
      equalPairs.push([p.a.member, p.b.member]);
    }
  }
  if (clearDrops.size > 0) {
    console.log("  Suggested DUP_DROP entries — smaller file in each pair (review before adding):");
    for (const m of [...clearDrops].sort()) {
      console.log(`    "${m}",`);
    }
  }
  // Pairs where fingerprint counts are identical — no size-based drop recommendation.
  // The export tool emitted two files with the same content under different names.
  // Check each name against the SOBR roster and add the non-roster name to DUP_DROP.
  // De-duplicate: if name A already appears as a clear drop from another pair, skip.
  const ambiguous = equalPairs.filter(
    ([a, b]) => !clearDrops.has(a) && !clearDrops.has(b),
  );
  // Collect unique names that appear in equal pairs (deduped for 3-way groups).
  if (ambiguous.length > 0) {
    // Build a de-duped set of (smaller-alphabetically, larger-alphabetically) pairs
    // so 3-way groups (A=B=C) show as 3 pairs but names only appear once in context.
    console.log("\n  Identical-content pairs — check each name against SOBR roster, drop the one not listed:");
    const seen = new Set<string>();
    for (const [a, b] of ambiguous) {
      const key = [a, b].sort().join(" ↔ ");
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    "${a}"  ↔  "${b}"`);
    }
    console.log("  (For 3-way groups: keep one, drop two.)");
  }
}

// ── Check 2: State Head filenames (blocking) ───────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log("CHECK 2: Pure State Head names appearing as salesperson files (blocking)");
console.log(`${"─".repeat(60)}`);

type NameMatch = { member: string; rows: number; net: number };
const stateHeadMatches: NameMatch[] = [];
const dualRoleMatches:  NameMatch[] = [];
const watchMatches:     NameMatch[] = [];

for (const f of files) {
  const m: NameMatch = { member: f.member, rows: f.rows, net: f.net };
  if (stateHeadNorms.has(f.memberNorm))  stateHeadMatches.push(m);
  else if (dualRoleNorms.has(f.memberNorm)) dualRoleMatches.push(m);
  else if (watchNorms.has(f.memberNorm))    watchMatches.push(m);
}

if (stateHeadMatches.length === 0) {
  console.log("✓ No pure State Head names found in file list.");
} else {
  console.log(`⚠  ${stateHeadMatches.length} blocking State Head file(s):\n`);
  for (const m of stateHeadMatches) {
    console.log(`  "${m.member}"  (${m.rows} rows, ₹${(m.net / 1e7).toFixed(2)} Cr)`);
    console.log(`  → Pure roll-up head — has no individual PS code.`);
    console.log(`    File is a mislabelled export of a team member's data.`);
    console.log(`    Add to DUP_DROP and load the correctly-named duplicate if one exists.`);
    console.log();
  }
}

// ── Check 3: Dual-role names (warn) ───────────────────────────────────────────
console.log(`${"─".repeat(60)}`);
console.log("CHECK 3: Dual-role names — head AND field rep (warning, not blocking)");
console.log(`${"─".repeat(60)}`);

if (dualRoleMatches.length === 0) {
  console.log("✓ No dual-role names found in file list.");
} else {
  console.log(`⚠  ${dualRoleMatches.length} dual-role file(s) — manual confirmation required:\n`);
  for (const m of dualRoleMatches) {
    console.log(`  "${m.member}"  (${m.rows} rows, ₹${(m.net / 1e7).toFixed(2)} Cr)`);
    console.log(`  → Registered as both a State Head and a field rep (has own member sheet).`);
    console.log(`    File is LEGITIMATE if it contains personal field sales.`);
    console.log(`    File is MISLABELLED if its rows duplicate a team member's data.`);
    console.log(`    Run Check 1 overlap comparison against team members' files to decide.`);
    console.log();
  }
}

// ── Check 4: Watch-list names (warn) ──────────────────────────────────────────
console.log(`${"─".repeat(60)}`);
console.log("CHECK 4: Watch-list names — former or unresolved heads (warning, not blocking)");
console.log(`${"─".repeat(60)}`);

if (watchMatches.length === 0) {
  console.log("✓ No watch-list names found in file list.");
} else {
  console.log(`⚠  ${watchMatches.length} watch-list file(s) — verify before accepting:\n`);
  for (const m of watchMatches) {
    const note =
      normAlpha(m.member) === normAlpha("Babu")
        ? "Tamil Nadu + Andaman head through FY2024-25; zero rows in FY2025-26 or FY2026-27 register. " +
          "Confirm with Deepak whether he has active territory in this FY before loading."
        : normAlpha(m.member) === normAlpha("Suresh Nair")
        ? "AP / Telangana / Karnataka head through FY2025-26; status unresolved. " +
          "His FY2025-26 customers overlap with the Sandeep Dadheech AP TELENGANA file. " +
          "Confirm territory ownership before loading."
        : "Status unresolved — verify before accepting.";
    console.log(`  "${m.member}"  (${m.rows} rows, ₹${(m.net / 1e7).toFixed(2)} Cr)`);
    console.log(`  → ${note}`);
    console.log();
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`${"─".repeat(60)}`);
const blockingIssues = dupPairs.length + stateHeadMatches.length;
const warnings       = dualRoleMatches.length + watchMatches.length;

if (blockingIssues === 0 && warnings === 0) {
  console.log("✓ Pre-flight passed — no issues or warnings.");
  process.exit(0);
} else if (blockingIssues === 0) {
  console.log(
    `✓ No blocking issues.  ${warnings} warning(s) above — review before loading.`,
  );
  process.exit(0);
} else {
  console.log(
    `⚠  ${blockingIssues} blocking issue(s)` +
    (warnings > 0 ? ` + ${warnings} warning(s)` : "") +
    `.  ` +
    (REPORT_ONLY
      ? "Exiting 0 (--report-only)."
      : "Resolve blocking issues before loading. Pass --report-only to suppress exit code."),
  );
  process.exit(REPORT_ONLY ? 0 : 1);
}
