#!/usr/bin/env node
// Growth Report guard regression check (Task 182 / Task 240).
//
// Asserts against the RUNNING api-server:
//   1. POST /api/ai/full-report/growth with scope=statehead returns HTTP 202 (or 200
//      on a cache hit). On 202 the script polls GET /api/ai/full-report/status/:jobId
//      every 3 s until status === "complete" or 300 s has elapsed.
//   2. deduplication.postDedupValue <= deduplication.preDedupValue.
//   3. CLOSE > RECOVER > ACTIVATE > WIDEN precedence is reflected in ledger:
//        a. precedenceRules lists all four levers in order.
//        b. No entity name appears with two different lever tags in the ledger
//           (i.e., deduplication actually ran — same entity is not double-counted).
//   4. whereNotToLook section is never empty (mandatoryNote must be present and
//      non-empty; the section is contractually mandatory per the route source).
//   5. guard.checked > 0 (numeric guard ran and evaluated at least one figure).
//
// Base URL: GROWTH_BASE_URL env, else https://$REPLIT_DEV_DOMAIN/api.
// Test head: GUARD_GROWTH_HEAD env (default "Anant Singh").
// Self-provisions a disposable api-server (port 5893) when none is reachable,
// following the same pattern as comparison-guard-check.mjs and
// distributor-tab-guard-check.mjs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REQUEST_TIMEOUT_MS = Number(process.env.GUARD_REQUEST_TIMEOUT_MS ?? 300000);
// Max time to poll for the async job to complete (default 300 s).
const POLL_TIMEOUT_MS = Number(process.env.GUARD_POLL_TIMEOUT_MS ?? 300000);
const POLL_INTERVAL_MS = 3000;
// Operator credentials so auth-gated routes respond 200 instead of 401.
const OPERATOR_HEADERS = process.env.ADMIN_SECRET
  ? { "X-Admin-Secret": process.env.ADMIN_SECRET }
  : {};

// ── Server resolution ─────────────────────────────────────────────────────────

async function probe(candidate) {
  try {
    const res = await fetch(`${candidate}/comparison/catalogue`, {
      headers: OPERATOR_HEADERS,
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
    process.env.GROWTH_BASE_URL,
    process.env.COMPARISON_BASE_URL,
    process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
      : null,
    // Reuse a server left alive by earlier guard scripts in the same chain.
    "http://127.0.0.1:5892/api",
    "http://127.0.0.1:5891/api",
  ].filter(Boolean);

  for (const c of candidates) {
    if (await probe(c)) return c;
  }

  if (process.env.GROWTH_BASE_URL || process.env.COMPARISON_BASE_URL) {
    const pinned = process.env.GROWTH_BASE_URL ?? process.env.COMPARISON_BASE_URL;
    console.error(`FATAL: pinned base URL ${pinned} is not responding`);
    process.exit(2);
  }

  // No reachable server — boot a disposable one on port 5893.
  const port = Number(process.env.GUARD_SERVER_PORT ?? 5893);
  const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    `INFO  no running api-server found — booting a disposable one on port ${port}`,
  );

  // Prefer pre-built dist/index.mjs (avoids a rebuild that conflicts with live
  // servers from earlier guard scripts). Fall back to a fresh build if missing.
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

/**
 * POST to the growth route, then poll until complete (or timeout).
 * Returns the final body object (the completed report payload).
 */
async function fetchGrowthReport(base, stateHead) {
  let resp;
  let body;

  // POST
  try {
    resp = await fetch(`${base}/ai/full-report/growth`, {
      method: "POST",
      headers: { ...OPERATOR_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "statehead", stateHead }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    try { body = await resp.json(); } catch { body = null; }
  } catch (err) {
    console.error(`FATAL: growth report POST failed: ${err?.message ?? err}`);
    process.exit(2);
  }

  // Synchronous cache hit — server returned the report directly.
  if (resp.status === 200) {
    console.log(`  INFO  POST returned 200 (cache hit) — skipping poll`);
    return { postStatus: 200, body };
  }

  // Expected async path: 202 with a jobId.
  if (resp.status === 202) {
    const jobId = body?.jobId;
    if (!jobId) {
      console.error(`FATAL: 202 response missing jobId — body: ${JSON.stringify(body)}`);
      process.exit(2);
    }
    console.log(`  INFO  POST returned 202, jobId=${jobId} — polling status…`);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let pollNum = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      pollNum++;
      let pollResp;
      let pollBody;
      try {
        pollResp = await fetch(`${base}/ai/full-report/status/${encodeURIComponent(jobId)}`, {
          headers: OPERATOR_HEADERS,
          signal: AbortSignal.timeout(15000),
        });
        try { pollBody = await pollResp.json(); } catch { pollBody = null; }
      } catch (err) {
        console.error(`FATAL: status poll #${pollNum} failed: ${err?.message ?? err}`);
        process.exit(2);
      }

      if (pollResp.status === 404) {
        console.error(`FATAL: jobId ${jobId} not found on server (404)`);
        process.exit(2);
      }

      const status = pollBody?.status;
      const elapsed = Math.round((Date.now() - (deadline - POLL_TIMEOUT_MS)) / 1000);
      console.log(`  INFO  poll #${pollNum} (${elapsed}s): status=${status}`);

      if (status === "complete") {
        // The report is nested under pollBody.report
        return { postStatus: 202, body: pollBody.report };
      }

      if (status === "failed") {
        console.error(`FATAL: job failed — ${pollBody?.error ?? "no error detail"}`);
        process.exit(2);
      }
      // status === "queued" | "running" — keep polling
    }

    console.error(`FATAL: job ${jobId} did not complete within ${POLL_TIMEOUT_MS / 1000}s`);
    process.exit(2);
  }

  // Unexpected status
  console.error(`FATAL: unexpected POST status ${resp.status} — body: ${JSON.stringify(body).slice(0, 400)}`);
  process.exit(2);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const base = await resolveBase();
console.log(`\nGrowth report guard checks against ${base}\n`);

const GUARD_HEAD = process.env.GUARD_GROWTH_HEAD ?? "Anant Singh";

const { postStatus, body } = await fetchGrowthReport(base, GUARD_HEAD);

// ── Check 1: POST returned 200 (cache) or 202 (async job started and completed) ─
check(
  `POST /ai/full-report/growth?scope=statehead&stateHead=${GUARD_HEAD} returned 200 or 202`,
  postStatus === 200 || postStatus === 202,
  `status=${postStatus} body=${JSON.stringify(body).slice(0, 400)}`,
);

if (body == null) {
  console.error("\nFATAL: cannot run further checks without a valid report payload.");
  process.exit(1);
}

// ── Check 2: post-dedup ≤ pre-dedup ──────────────────────────────────────────
const dedup = body.deduplication ?? {};
const preDedupValue  = typeof dedup.preDedupValue  === "number" ? dedup.preDedupValue  : null;
const postDedupValue = typeof dedup.postDedupValue === "number" ? dedup.postDedupValue : null;

check(
  "deduplication block is present with preDedupValue and postDedupValue",
  preDedupValue != null && postDedupValue != null,
  `deduplication=${JSON.stringify(dedup).slice(0, 200)}`,
);

if (preDedupValue != null && postDedupValue != null) {
  check(
    `postDedupValue (${postDedupValue}) ≤ preDedupValue (${preDedupValue})`,
    postDedupValue <= preDedupValue + 0.01, // 1-rupee tolerance for float rounding
    `pre=${preDedupValue} post=${postDedupValue} diff=${(postDedupValue - preDedupValue).toFixed(2)}`,
  );
}

// ── Check 3a: precedenceRules lists all four levers in CLOSE>RECOVER>ACTIVATE>WIDEN order ──
const EXPECTED_LEVERS = ["CLOSE", "RECOVER", "ACTIVATE", "WIDEN"];
const rules = dedup.precedenceRules ?? [];

check(
  "deduplication.precedenceRules lists all four levers",
  rules.length >= 4,
  `got ${rules.length} rules: ${JSON.stringify(rules)}`,
);

if (rules.length >= 4) {
  for (let i = 0; i < EXPECTED_LEVERS.length; i++) {
    const lever = EXPECTED_LEVERS[i];
    check(
      `precedenceRules[${i + 1}] references ${lever}`,
      String(rules[i]).toUpperCase().includes(lever),
      `got "${rules[i]}"`,
    );
  }
}

// ── Check 3b: no entity appears with two different lever tags in the ledger ──
const ledgerRows = body.opportunityLedger?.rows ?? [];
check(
  "opportunityLedger.rows is a non-empty array",
  Array.isArray(ledgerRows) && ledgerRows.length > 0,
  `rows=${JSON.stringify(ledgerRows).slice(0, 100)}`,
);

if (ledgerRows.length > 0) {
  // Build a map of entityName → levers it appears under.
  const entityLevers = new Map(); // entityName.toUpperCase() → Set<lever>
  for (const row of ledgerRows) {
    if (!row.entityName || !row.lever) continue;
    const key = String(row.entityName).toUpperCase();
    if (!entityLevers.has(key)) entityLevers.set(key, new Set());
    entityLevers.get(key).add(row.lever);
  }
  const doubleCountedEntities = [];
  for (const [name, levers] of entityLevers) {
    if (levers.size > 1) {
      doubleCountedEntities.push({ name, levers: [...levers] });
    }
  }
  check(
    "no entity appears under multiple lever tags in the ledger (deduplication enforced)",
    doubleCountedEntities.length === 0,
    doubleCountedEntities.length > 0
      ? `double-counted: ${JSON.stringify(doubleCountedEntities.slice(0, 5))}`
      : "",
  );

  // Verify all ledger rows carry one of the four known lever values.
  const unknownLevers = [...new Set(ledgerRows.map(r => r.lever))].filter(
    l => !EXPECTED_LEVERS.includes(l),
  );
  check(
    "all ledger lever tags are one of CLOSE | RECOVER | ACTIVATE | WIDEN",
    unknownLevers.length === 0,
    unknownLevers.length > 0 ? `unknown levers: ${JSON.stringify(unknownLevers)}` : "",
  );
}

// ── Check 4: whereNotToLook is never empty ────────────────────────────────────
const whereNotToLook = body.whereNotToLook ?? null;
check(
  "whereNotToLook section is present",
  whereNotToLook != null,
  "whereNotToLook key missing from response",
);

if (whereNotToLook != null) {
  check(
    "whereNotToLook.mandatoryNote is a non-empty string",
    typeof whereNotToLook.mandatoryNote === "string" && whereNotToLook.mandatoryNote.trim().length > 0,
    `mandatoryNote=${JSON.stringify(whereNotToLook.mandatoryNote)}`,
  );

  // The section must carry at least one of: projectGapNote or concentratedGaps
  // (even when empty, the projectGapNote explains why — it must not be missing).
  check(
    "whereNotToLook.projectGapNote is a non-empty string",
    typeof whereNotToLook.projectGapNote === "string" && whereNotToLook.projectGapNote.trim().length > 0,
    `projectGapNote=${JSON.stringify(whereNotToLook.projectGapNote)}`,
  );
}

// ── Check 5: numeric guard ran ────────────────────────────────────────────────
const guard = body.guard ?? null;
check(
  "guard block is present in response",
  guard != null,
  "guard key missing from response",
);

if (guard != null) {
  const checked = typeof guard.checked === "number" ? guard.checked : null;
  check(
    "guard.checked > 0 (numeric guard evaluated at least one figure)",
    checked != null && checked > 0,
    `guard.checked=${checked} guard=${JSON.stringify(guard).slice(0, 200)}`,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? "\nAll growth-report guard checks passed."
    : `\n${failures} growth-report guard check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
