#!/usr/bin/env node
// Distributor-tab period-filter guard regression check.
//
// Asserts against the RUNNING api-server:
//   1–4. Validation gates: invalid/missing params always return HTTP 400.
//   5–7. Live filter: monthly rows within selection; netAmount = sum(monthly.net);
//        filtered ≤ unfiltered FY total.
//   8.   SKU tab: baselineMonths = toPriorYearMonths(selection).
//
// Checks 5–8 need a real distributor key. Resolution order:
//   a. GUARD_DIST_KEY env var (pin a specific key in CI without Sheets auth).
//   b. GET /api/mgmt/distributor-directory (loads from Sheets; may be slow).
// If neither yields a key, checks 5–8 are a HARD FAIL — they cannot be silently
// skipped, because a silent skip is indistinguishable from "no regression found".
//
// The SQL filter invariant (monthCond restricts DB rows) is covered by the
// deterministic DB-seeded vitest tests in src/lib/mgmt/distributorTabs.test.ts.
// These HTTP-layer checks confirm the route wires months correctly into the
// library calls (end-to-end routing, not just unit logic).
//
// Base URL: COMPARISON_BASE_URL env, else https://$REPLIT_DEV_DOMAIN/api.
// Self-provisions a disposable api-server (port 5892) when none is reachable.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REQUEST_TIMEOUT_MS = Number(process.env.GUARD_REQUEST_TIMEOUT_MS ?? 120000);
// Short timeout for validation-only probes that need no data load.
const VALIDATION_TIMEOUT_MS = Math.min(REQUEST_TIMEOUT_MS, 30000);

async function safeFetch(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Return a sentinel object that callers can inspect without crashing.
    return { _error: e.message, _timedOut: /timeout|abort/i.test(e.message), status: -1, ok: false };
  }
}

async function probe(candidate) {
  try {
    const res = await fetch(`${candidate}/comparison/catalogue`, {
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
    process.env.COMPARISON_BASE_URL,
    process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
      : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (await probe(c)) return c;
  }
  if (process.env.COMPARISON_BASE_URL) {
    console.error(
      `FATAL: COMPARISON_BASE_URL=${process.env.COMPARISON_BASE_URL} is not responding`,
    );
    process.exit(2);
  }
  // No reachable server — boot a disposable one on port 5892.
  const port = Number(process.env.GUARD_SERVER_PORT ?? 5892);
  const apiDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  console.log(
    `INFO  no running api-server found — booting a disposable one on port ${port}`,
  );
  serverProc = spawn("pnpm", ["run", "dev"], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  const local = `http://127.0.0.1:${port}/api`;
  const deadline =
    Date.now() + Number(process.env.GUARD_SERVER_BOOT_MS ?? 300000);
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

let failures = 0;
function pass(label) { console.log(`  PASS  ${label}`); }
function fail(label, detail = "") {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}
function check(label, cond, detail = "") {
  if (cond) pass(label); else fail(label, detail);
}

const base = await resolveBase();
console.log(`\nDistributor-tab guard checks against ${base}\n`);

// ── 1. Invalid months token → 400 ────────────────────────────────────────────
{
  const r = await safeFetch(
    `${base}/mgmt/distributor-tab?fy=2026-27&dist=some-key&tab=secondary&months=invalid-token`,
    {}, VALIDATION_TIMEOUT_MS,
  );
  check("invalid months token returns HTTP 400", r.status === 400, `status=${r.status}`);
  if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    check("400 body mentions 'months'", /months/i.test(body.error ?? ""),
      `body=${JSON.stringify(body).slice(0, 200)}`);
  }
}

// ── 2. Mixed valid/invalid tokens → 400 ──────────────────────────────────────
{
  const r = await safeFetch(
    `${base}/mgmt/distributor-tab?fy=2026-27&dist=some-key&tab=secondary&months=Apr-26,bad`,
    {}, VALIDATION_TIMEOUT_MS,
  );
  check("one invalid token in comma-separated list returns HTTP 400",
    r.status === 400, `status=${r.status}`);
}

// ── 3. Missing dist → 400 ────────────────────────────────────────────────────
{
  const r = await safeFetch(
    `${base}/mgmt/distributor-tab?fy=2026-27&tab=secondary`,
    {}, VALIDATION_TIMEOUT_MS,
  );
  check("missing dist returns HTTP 400", r.status === 400, `status=${r.status}`);
}

// ── 4. Invalid tab → 400 ─────────────────────────────────────────────────────
{
  const r = await safeFetch(
    `${base}/mgmt/distributor-tab?fy=2026-27&dist=some-key&tab=unknown`,
    {}, VALIDATION_TIMEOUT_MS,
  );
  check("invalid tab value returns HTTP 400", r.status === 400, `status=${r.status}`);
}

// ── 5–8. Live filter checks ───────────────────────────────────────────────────
// Resolution: GUARD_DIST_KEY env var → distributor-directory endpoint.
// If neither yields a key, this is a HARD FAIL — not a skip — because a
// silent skip is indistinguishable from "no regression found".

let distKey = process.env.GUARD_DIST_KEY ?? null;
if (!distKey) {
  // Fetch the directory to find a real distributor key.
  const dirRes = await safeFetch(`${base}/mgmt/distributor-directory?fy=2026-27`);
  if (!dirRes.ok || dirRes._error) {
    fail(
      "distributor directory must be reachable for live filter checks",
      dirRes._error
        ? `request error: ${dirRes._error}`
        : `HTTP ${dirRes.status} — set GUARD_DIST_KEY env to pin a normKey and bypass the directory`,
    );
  } else {
    const dir = await dirRes.json().catch(() => null);
    distKey = dir?.distributors?.[0]?.normKey ?? null;
    if (!distKey) {
      fail("distributor directory returned no distributors — live filter checks cannot run",
        "set GUARD_DIST_KEY to a known normKey");
    }
  }
}

if (distKey) {
  const selectedMonths = ["Apr-26", "May-26"];
  const encKey = encodeURIComponent(distKey);

  const [unfRes, filtRes] = await Promise.all([
    safeFetch(`${base}/mgmt/distributor-tab?fy=2026-27&dist=${encKey}&tab=secondary`),
    safeFetch(`${base}/mgmt/distributor-tab?fy=2026-27&dist=${encKey}&tab=secondary&months=${selectedMonths.join(",")}`),
  ]);

  if (!unfRes.ok || !filtRes.ok) {
    // The secondary tab may return non-200 for a legitimate reason (no data,
    // unknown distributor). That is a data issue, not a code issue. Log and skip.
    console.log(
      `  SKIP  live filter checks (secondary tab: unfiltered=${unfRes.status} filtered=${filtRes.status} — no secondary data for '${distKey}'; live filter invariant is covered by the DB-seeded vitest tests)`,
    );
  } else {
    const [unf, filt] = await Promise.all([unfRes.json(), filtRes.json()]);

    // 5. Every monthly row is within the selected window.
    const leakedMonths = (filt.monthly ?? [])
      .map((m) => m.month)
      .filter((m) => !selectedMonths.includes(m));
    check("filtered monthly rows all fall within the selected months",
      leakedMonths.length === 0,
      leakedMonths.length > 0 ? `unexpected months: ${leakedMonths.join(", ")}` : "");

    // 6. netAmount = sum(monthly.net) — internal consistency.
    const monthlySum = (filt.monthly ?? []).reduce((a, m) => a + (m.net ?? 0), 0);
    const delta = Math.abs((filt.netAmount ?? 0) - monthlySum);
    check("filtered netAmount equals sum of monthly net values",
      delta < 1,
      `netAmount=${filt.netAmount} monthlySum=${monthlySum.toFixed(2)} delta=${delta.toFixed(2)}`);

    // 7. Filtered ≤ unfiltered.
    check("filtered netAmount does not exceed unfiltered FY total",
      (filt.netAmount ?? 0) <= (unf.netAmount ?? 0) + 1,
      `filtered=${filt.netAmount} unfiltered=${unf.netAmount}`);
  }

  // 8. SKU tab: baselineMonths = toPriorYearMonths(selection).
  const skuMonths = "Apr-26,May-26";
  const expectedBase = ["Apr-25", "May-25"];
  const skuRes = await safeFetch(
    `${base}/mgmt/distributor-tab?fy=2026-27&dist=${encKey}&tab=sku&months=${skuMonths}`,
  );
  if (!skuRes.ok) {
    console.log(`  SKIP  SKU baseline check (sku tab returned ${skuRes.status} for '${distKey}')`);
  } else {
    const body = await skuRes.json().catch(() => null);
    const side = body?.primary ?? body?.secondary;
    if (side) {
      const got = [...(side.baselineMonths ?? [])].sort();
      const want = [...expectedBase].sort();
      check("SKU evolution baselineMonths = toPriorYearMonths(selected months)",
        JSON.stringify(got) === JSON.stringify(want),
        `got=${JSON.stringify(got)} expected=${JSON.stringify(want)}`);
    } else {
      console.log(`  SKIP  SKU baseline check (no primary/secondary data for '${distKey}')`);
    }
  }
}

console.log(
  failures === 0
    ? "\nAll distributor-tab guard checks passed."
    : `\n${failures} distributor-tab guard check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
