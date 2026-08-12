#!/usr/bin/env node
// Scheme nudge guard — confirms the nudge engine reads real Q2 DB data
// after the JSON retirement.
//
// Asserts against a running api-server:
//   1. GET /api/schemes/master returns _source="database" and contains the
//      real Q2 scheme IDs (CP_LALAN, PTMT_WAHID) — proving the DB is
//      populated and the master route is not falling back to anything else.
//
//   2. GET /api/schemes/nudge?fy=2026-27&q=Q2 returns HTTP 200 with the
//      expected envelope fields (fy, quarter, nudges).
//
//   3. Every nudge row's schemeId is drawn from the known Q2 cumulative-
//      quarterly scheme set — no unknown or legacy placeholder IDs appear.
//
//   4. The two needs_clarification slabs (PTMT_CP_AP_TEL slab 8 and
//      PTMT_CP_WB slab 8 — both at threshold 1,500,000) never appear as a
//      nudge target: no NUDGE row for those schemes has nextSlab >= 1,500,000.
//
// If the DB is unpopulated the guard calls POST /api/admin/schemes/load
// (idempotent) to seed it before running assertions, using SESSION_SECRET.
// This is the correct state the server should be in after deployment; if
// SESSION_SECRET is absent the guard fails loudly so the omission is not
// masked.
//
// Runs cleanly without Claude credentials. No AI calls are made.
//
// Base URL: SCHEMES_BASE_URL env, else REPLIT_DEV_DOMAIN, else tries the
// ports used by earlier guards (5891–5893), else boots a disposable server
// on port 5894.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Request timeout ───────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = Number(process.env.GUARD_REQUEST_TIMEOUT_MS ?? 60000);
const bounded = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// ── Server resolution ─────────────────────────────────────────────────────────

async function probe(candidate) {
  try {
    const res = await fetch(`${candidate}/schemes/master`, {
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let serverProc = null;
async function resolveBase() {
  const candidates = [
    process.env.SCHEMES_BASE_URL,
    process.env.COMPARISON_BASE_URL,
    process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
      : null,
    // Reuse servers left alive by earlier guard scripts in the same chain.
    "http://127.0.0.1:5893/api",
    "http://127.0.0.1:5892/api",
    "http://127.0.0.1:5891/api",
  ].filter(Boolean);

  for (const c of candidates) {
    if (await probe(c)) return c;
  }

  if (process.env.SCHEMES_BASE_URL || process.env.COMPARISON_BASE_URL) {
    const pinned = process.env.SCHEMES_BASE_URL ?? process.env.COMPARISON_BASE_URL;
    console.error(`FATAL: pinned base URL ${pinned} is not responding`);
    process.exit(2);
  }

  // No reachable server — boot a disposable one on port 5894.
  const port = Number(process.env.GUARD_SERVER_PORT ?? 5894);
  const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    `INFO  no running api-server found — booting a disposable one on port ${port}`,
  );

  // Prefer pre-built dist/index.mjs (avoids a rebuild conflict with live servers
  // from earlier guard scripts in the same chain). Build if missing.
  const distEntry = path.join(apiDir, "dist", "index.mjs");
  const distExists = await import("node:fs/promises")
    .then((fs) => fs.access(distEntry).then(() => true, () => false));

  if (!distExists) {
    console.log(`INFO  dist/index.mjs not found — running build first`);
    const { execSync } = await import("node:child_process");
    try {
      execSync("pnpm run build", { cwd: apiDir, stdio: "inherit" });
    } catch {
      console.error("FATAL: build step failed — cannot start disposable api-server");
      process.exit(2);
    }
  }

  serverProc = spawn(
    "node",
    ["--enable-source-maps", "./dist/index.mjs"],
    {
      cwd: apiDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    },
  );

  const local = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + Number(process.env.GUARD_SERVER_BOOT_MS ?? 300000);
  while (Date.now() < deadline) {
    if (serverProc.exitCode != null) {
      console.error(
        `FATAL: disposable api-server exited early (code ${serverProc.exitCode})`,
      );
      process.exit(2);
    }
    if (await probe(local)) return local;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error("FATAL: disposable api-server did not become ready in time");
  process.exit(2);
}

function shutdownServer() {
  if (serverProc) {
    try { process.kill(-serverProc.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
process.on("exit", shutdownServer);
process.on("SIGINT", () => { shutdownServer(); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

// The full set of cumulative-quarterly scheme IDs in the Q2 FY2026-27 seed.
// Nudge rows must only ever reference IDs from this set (or the annual ANNUAL_WB
// for the annual tracker, which does not appear in quarterly nudges).
// Any schemeId outside this set means either (a) a legacy placeholder slipped
// through, or (b) a new scheme was added without updating this guard.
const Q2_QUARTERLY_SCHEME_IDS = new Set([
  "CP_LALAN",
  "CP_KL_KA",
  "CP_WAHID",
  "PTMT_LALAN",
  "PTMT_KL_KA",
  "PTMT_WAHID",
  "PTMT_CP_AP_TEL",
  "PTMT_CP_WB",
]);

// Schemes that have a needs_clarification slab at threshold 1,500,000.
// That slab is excluded from the DB (reward_status filter in nudge.ts), so
// no nudge row should ever target threshold >= 1,500,000 for these schemes.
const NEEDS_CLARIFICATION_SCHEMES = new Set(["PTMT_CP_AP_TEL", "PTMT_CP_WB"]);
const NEEDS_CLARIFICATION_THRESHOLD = 1_500_000;

// ── Main ──────────────────────────────────────────────────────────────────────

const base = await resolveBase();
console.log(`\nScheme nudge guard checks against ${base}\n`);

// ── Guard 1: scheme master reads from DB and contains Q2 IDs ─────────────────

console.log("Guard 1 — scheme master is DB-backed and populated with Q2 IDs");
const masterRes = await bounded(`${base}/schemes/master`);
check(
  "GET /api/schemes/master returns HTTP 200",
  masterRes.ok,
  `status=${masterRes.status}`,
);
const masterBody = await masterRes.json().catch(() => null);
check(
  "scheme master body is present",
  masterBody != null,
  "response body was not valid JSON",
);
check(
  '_source field equals "database" (not a JSON fallback)',
  masterBody?._source === "database",
  `_source=${JSON.stringify(masterBody?._source)}`,
);

const masterSchemeIds = new Set((masterBody?.schemes ?? []).map((s) => s.scheme_id));

// If the DB is empty, seed it now before running the nudge assertions.
// An empty DB is not a regression by itself (it means the admin seed route
// was not yet called after a fresh deploy), but the nudge assertions below
// must run against a populated DB to be meaningful.
if (masterSchemeIds.size === 0) {
  console.log("\nINFO  scheme master is empty — seeding via POST /api/admin/schemes/load");
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (!sessionSecret) {
    console.error(
      "FATAL: SESSION_SECRET is not set — cannot seed scheme tables; " +
      "set SESSION_SECRET so the admin seed route can be called",
    );
    process.exit(2);
  }
  const seedRes = await bounded(`${base}/admin/schemes/load`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": sessionSecret,
    },
  });
  check(
    "POST /api/admin/schemes/load (seed) returned HTTP 200",
    seedRes.ok,
    `status=${seedRes.status} body=${JSON.stringify(await seedRes.json().catch(() => null)).slice(0, 300)}`,
  );
  if (!seedRes.ok) {
    // Seeding failed — no point running further assertions.
    console.error("\nFATAL: cannot proceed without scheme data in DB");
    process.exit(failures === 0 ? 2 : 1);
  }

  // Re-fetch master to populate masterSchemeIds for the assertions below.
  const masterRes2 = await bounded(`${base}/schemes/master`);
  const masterBody2 = await masterRes2.json().catch(() => null);
  (masterBody2?.schemes ?? []).forEach((s) => masterSchemeIds.add(s.scheme_id));
  console.log(`INFO  seed complete — ${masterSchemeIds.size} scheme(s) now in DB\n`);
}

check(
  "scheme master contains CP_LALAN (Q2 territory scheme)",
  masterSchemeIds.has("CP_LALAN"),
  `scheme IDs present: ${[...masterSchemeIds].join(", ")}`,
);
check(
  "scheme master contains PTMT_WAHID (Q2 territory scheme)",
  masterSchemeIds.has("PTMT_WAHID"),
  `scheme IDs present: ${[...masterSchemeIds].join(", ")}`,
);

// ── Guard 2: nudge endpoint responds correctly for Q2 ─────────────────────────

console.log("\nGuard 2 — nudge endpoint returns a well-formed Q2 envelope");
const nudgeRes = await bounded(`${base}/schemes/nudge?fy=2026-27&q=Q2`);
check(
  "GET /api/schemes/nudge?fy=2026-27&q=Q2 returns HTTP 200",
  nudgeRes.ok,
  `status=${nudgeRes.status}`,
);
const nudgeBody = await nudgeRes.json().catch(() => null);
check(
  "nudge response body is valid JSON",
  nudgeBody != null,
  "response was not valid JSON",
);
check(
  "nudge envelope has fy field = '2026-27'",
  nudgeBody?.fy === "2026-27",
  `fy=${JSON.stringify(nudgeBody?.fy)}`,
);
check(
  "nudge envelope has quarter field = 'Q2'",
  nudgeBody?.quarter === "Q2",
  `quarter=${JSON.stringify(nudgeBody?.quarter)}`,
);
check(
  "nudge envelope has nudges array",
  Array.isArray(nudgeBody?.nudges),
  `nudges=${JSON.stringify(nudgeBody?.nudges)?.slice(0, 100)}`,
);
check(
  "nudge envelope has months array with 3 entries (Jul/Aug/Sep)",
  Array.isArray(nudgeBody?.months) && nudgeBody.months.length === 3,
  `months=${JSON.stringify(nudgeBody?.months)}`,
);

// ── Guard 3: all nudge schemeIds are in the known Q2 set ─────────────────────

console.log("\nGuard 3 — every nudge schemeId is from the real Q2 seed (no legacy IDs)");
const nudges = nudgeBody?.nudges ?? [];
const unknownIds = new Set();
for (const n of nudges) {
  if (!Q2_QUARTERLY_SCHEME_IDS.has(n.schemeId)) {
    unknownIds.add(n.schemeId);
  }
}
check(
  "all nudge schemeIds are in the Q2 quarterly scheme set",
  unknownIds.size === 0,
  unknownIds.size > 0
    ? `unknown IDs found: ${[...unknownIds].join(", ")} — legacy placeholder or unlisted scheme`
    : "",
);
console.log(
  `  INFO  ${nudges.length} nudge row(s) checked; ${Q2_QUARTERLY_SCHEME_IDS.size} valid scheme IDs in set`,
);

// ── Guard 4: needs_clarification slabs do not appear in any nudge ────────────

console.log("\nGuard 4 — needs_clarification slabs absent from nudge targets");

// The two ambiguous slabs (PTMT_CP_AP_TEL slab 8, PTMT_CP_WB slab 8) have
// threshold_from = 1,500,000 and reward_status = 'needs_clarification'.
// The DB loader excludes them (WHERE reward_status != 'needs_clarification'),
// so they must never appear as a nudge target (nextSlab).
const clarificationLeaks = nudges.filter(
  (n) =>
    NEEDS_CLARIFICATION_SCHEMES.has(n.schemeId) &&
    typeof n.nextSlab === "number" &&
    n.nextSlab >= NEEDS_CLARIFICATION_THRESHOLD,
);
check(
  "no nudge targets the needs_clarification threshold (≥1,500,000) for PTMT_CP_AP_TEL or PTMT_CP_WB",
  clarificationLeaks.length === 0,
  clarificationLeaks.length > 0
    ? `leaked rows: ${JSON.stringify(clarificationLeaks.map((n) => ({ customer: n.customer, schemeId: n.schemeId, nextSlab: n.nextSlab })))}`
    : "",
);

// Also confirm no nudge row has a null/undefined schemeId (a sign of fallback
// behaviour where a customer was matched but the scheme lookup failed silently).
const missingSchemeId = nudges.filter((n) => !n.schemeId);
check(
  "no nudge row has a missing or empty schemeId",
  missingSchemeId.length === 0,
  missingSchemeId.length > 0
    ? `${missingSchemeId.length} row(s) with empty schemeId — DB or territory routing may have fallen back silently`
    : "",
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(
  failures === 0
    ? "\nAll scheme nudge guard checks passed."
    : `\n${failures} scheme nudge guard check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
