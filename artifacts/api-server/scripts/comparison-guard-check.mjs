#!/usr/bin/env node
// Comparison-page guard regression check (Task: guard regressions must not ship silently).
//
// Asserts, against the RUNNING api-server:
//   1. Ravi (Faridabad) costRatioOb ≈ 39.45 and costRatioSales is UNDEFINED
//      (null value with the UNDEFINED note) — zero sales must never yield 0 or Infinity.
//   2. A period-pair measure (newCustomersCount) with a single period and NO
//      baseline returns a disabled note (value null), never zero.
//   3. A head request with a member-only measure returns HTTP 400 with the
//      invalid-measure error that lists the valid measures.
//   4. Head cost ratios keep the FULL-TEAM denominator: a real multi-member
//      head's ratio must cross-foot as recoveredCost ÷ ALL members' OB, and any
//      head with partially missing cost must carry the full-team wording. The
//      partially-missing-cost fixture itself is deterministic in the unit test
//      src/lib/comparison/costCell.test.ts (run alongside this script by the
//      'comparison-guards' validation step) because live data currently
//      records cost for every member.
//
// Base URL: COMPARISON_BASE_URL env, else https://$REPLIT_DEV_DOMAIN/api
// Tolerance for the Ravi ratio: RAVI_RATIO_EXPECTED / RAVI_RATIO_TOL envs
// (defaults 39.45 ± 0.5). The figure is FY-to-date; if underlying data is
// re-ingested legitimately, update the env or the default here consciously.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Every request is bounded — a validation step must terminate deterministically.
const REQUEST_TIMEOUT_MS = Number(process.env.GUARD_REQUEST_TIMEOUT_MS ?? 120000);
const bounded = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// ── Base URL resolution: use a reachable server, else boot a disposable one ──
// Candidates (in order): COMPARISON_BASE_URL, the workspace preview proxy.
// If none respond, spawn the api-server on a private port and wait for it.
async function probe(candidate) {
  try {
    const res = await fetch(`${candidate}/comparison/catalogue`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

let serverProc = null;
async function resolveBase() {
  const candidates = [
    process.env.COMPARISON_BASE_URL,
    process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}/api` : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (await probe(c)) return c;
  }
  if (process.env.COMPARISON_BASE_URL) {
    console.error(`FATAL configuration error: COMPARISON_BASE_URL=${process.env.COMPARISON_BASE_URL} is not responding`);
    process.exit(2);
  }
  // No reachable server — provision a disposable one from this repo.
  const port = Number(process.env.GUARD_SERVER_PORT ?? 5891);
  const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(`INFO  no running api-server found — booting a disposable one on port ${port} (pnpm run dev in ${apiDir})`);
  serverProc = spawn("pnpm", ["run", "dev"], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"], // server stdout is noisy; failures surface via stderr + readiness timeout
    detached: true,
  });
  const local = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + Number(process.env.GUARD_SERVER_BOOT_MS ?? 300000);
  while (Date.now() < deadline) {
    if (serverProc.exitCode != null) {
      console.error(`FATAL: disposable api-server exited with code ${serverProc.exitCode} before becoming ready`);
      process.exit(2);
    }
    if (await probe(local)) return local;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error("FATAL: disposable api-server did not become ready in time");
  process.exit(2);
}

function shutdownServer() {
  if (serverProc && serverProc.exitCode == null) {
    try { process.kill(-serverProc.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
process.on("exit", shutdownServer);

const base = await resolveBase();
console.log(`INFO  running comparison guard checks against ${base}`);

const EXPECTED_RATIO = Number(process.env.RAVI_RATIO_EXPECTED ?? 39.45);
const RATIO_TOL = Number(process.env.RAVI_RATIO_TOL ?? 0.5);

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function post(body) {
  // One retry on timeout: a freshly-booted disposable server may spend the
  // first request cold-loading member sheets from Google Sheets; the retry
  // hits warm caches and finishes fast. A second timeout is a real failure.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await bounded(`${base}/comparison`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let json = null;
      try { json = await res.json(); } catch { /* leave null */ }
      return { status: res.status, json };
    } catch (err) {
      if (attempt === 0 && err?.name === "TimeoutError") {
        console.log("INFO  request timed out on cold server — retrying once against warm caches");
        continue;
      }
      throw err;
    }
  }
}

function cell(json, measure, entity) {
  const row = (json?.matrix ?? []).find(
    (r) => r.measure === measure && (entity == null || r.entity === entity),
  );
  return row?.cells?.[0] ?? null;
}

// ── 1. Ravi (Faridabad): costRatioOb ≈ expected, costRatioSales UNDEFINED ──
{
  const { status, json } = await post({
    entityType: "member",
    entities: ["Ravi (Faridabad)"],
    periods: [{ kind: "ytd", fy: "2026-27" }],
    measures: ["costRatioOb", "costRatioSales"],
  });
  check("ravi request returns 200", status === 200, `status=${status} body=${JSON.stringify(json).slice(0, 300)}`);
  const ob = cell(json, "costRatioOb", "Ravi (Faridabad)");
  const sales = cell(json, "costRatioSales", "Ravi (Faridabad)");
  check(
    `ravi costRatioOb ≈ ${EXPECTED_RATIO} (±${RATIO_TOL})`,
    typeof ob?.value === "number" && Math.abs(ob.value - EXPECTED_RATIO) <= RATIO_TOL,
    `got ${JSON.stringify(ob)}`,
  );
  check(
    "ravi costRatioSales is UNDEFINED (null value, UNDEFINED note), not 0",
    sales != null && sales.value === null && /UNDEFINED/.test(sales.note ?? ""),
    `got ${JSON.stringify(sales)}`,
  );
}

// ── 2. Period-pair without baseline → disabled note, never zero ──
{
  const { status, json } = await post({
    entityType: "member",
    entities: ["Rahul Singh"],
    periods: [{ kind: "ytd", fy: "2026-27" }],
    measures: ["newCustomersCount"],
  });
  check("period-pair request returns 200", status === 200, `status=${status}`);
  const c = cell(json, "newCustomersCount");
  check(
    "newCustomersCount without baseline is disabled (null + baseline note), not 0",
    c != null && c.value === null && /baseline/i.test(c.note ?? "") && /disabled|no earlier baseline/i.test(c.note ?? ""),
    `got ${JSON.stringify(c)}`,
  );
}

// ── 3. Head + member-only measure → 400 listing valid measures ──
{
  // Fixed fixture head — deterministic and bounded; the check must never fan
  // out over every head (per-head deep-dive loads make the run unbounded).
  const FIXTURE_HEAD = process.env.GUARD_HEAD ?? "Syed Aqil Rizvi";
  const headsRes = await bounded(`${base}/comparison/entities?type=head`);
  const heads = (await headsRes.json())?.entities ?? [];
  check("head entity list is non-empty", heads.length > 0, "no heads returned");
  check(`fixture head '${FIXTURE_HEAD}' exists in the head list`, heads.includes(FIXTURE_HEAD), `heads=${JSON.stringify(heads)}`);
  const { status, json } = await post({
    entityType: "head",
    entities: [FIXTURE_HEAD],
    periods: [{ kind: "ytd", fy: "2026-27" }],
    measures: ["activeRetailerShare"], // memberOnly measure
  });
  check("head + member-only measure returns 400", status === 400, `status=${status} body=${JSON.stringify(json).slice(0, 300)}`);
  check(
    "400 error names the measure and lists valid measures",
    /activeRetailerShare/.test(json?.error ?? "") &&
      /not valid for entity type 'head'/.test(json?.error ?? "") &&
      /Valid measures:/.test(json?.error ?? ""),
    `got error=${JSON.stringify(json?.error)}`,
  );

  // ── 4. Head cost ratio keeps the FULL-TEAM denominator ──
  // Deterministic and bounded: ONE fixed head, cross-footed against its own
  // members' ratios. The partially-missing-cost path is enforced by the unit
  // test src/lib/comparison/costCell.test.ts (synthetic fixture — live data
  // currently records cost for every member).
  const r2 = await post({
    entityType: "head",
    entities: [FIXTURE_HEAD],
    periods: [{ kind: "ytd", fy: "2026-27" }],
    measures: ["costRatioOb"],
  });
  check("fixture-head costRatioOb request returns 200", r2.status === 200, `status=${r2.status} body=${JSON.stringify(r2.json).slice(0, 300)}`);
  const MISS_RE = /cost missing for (\d+) of (\d+) members/;
  const headRows = (r2.json?.matrix ?? []).filter((r) => r.measure === "costRatioOb");
  for (const r of headRows) {
    const note = r.cells?.[0]?.note ?? "";
    if (MISS_RE.test(note)) {
      check(
        `head '${r.entity}' with missing cost carries the full-team-denominator wording`,
        /denominator still covers all members/.test(note),
        `got note=${JSON.stringify(note)}`,
      );
    }
  }
  // Cross-foot the fixture head against its own members' ratios. The fixture
  // head must be cross-footable (every cost-recorded member has OB > 0) —
  // if the data changes, point GUARD_HEAD at another cross-footable head.
  const fx = headRows.find((r) => r.entity === FIXTURE_HEAD && typeof r.cells?.[0]?.value === "number");
  check(`fixture head '${FIXTURE_HEAD}' returned a numeric costRatioOb`, fx != null, `rows=${JSON.stringify(headRows).slice(0, 300)}`);
  let crossFooted = false;
  if (fx) {
    const fxCell = fx.cells[0];
    const memberHeads = (await (await bounded(`${base}/comparison/entities?type=member`)).json())?.memberHeads ?? [];
    const teamNames = [...new Set(memberHeads.filter((m) => m.stateHead === FIXTURE_HEAD).map((m) => m.name))];
    check(`fixture head '${FIXTURE_HEAD}' has members in the roster`, teamNames.length > 0, "no members found for the fixture head");
    const rm = await post({
      entityType: "member",
      entities: teamNames,
      periods: [{ kind: "ytd", fy: "2026-27" }],
      measures: ["costRatioOb", "secondaryOb"],
      context: { stateHead: FIXTURE_HEAD },
    });
    check("fixture members request returns 200", rm.status === 200, `status=${rm.status} body=${JSON.stringify(rm.json).slice(0, 300)}`);
    let recoveredCost = 0;      // Σ memberRatio × memberOb / 100 (members with recorded cost AND OB > 0)
    let fullTeamOb = 0;         // Σ OB over ALL members — the correct denominator
    let recordedOnlyOb = 0;     // Σ OB over cost-recorded members only — the WRONG denominator
    let unrecoverable = 0;      // recorded cost but OB = 0 → cost not recoverable from the ratio
    for (const name of teamNames) {
      const rc = cell(rm.json, "costRatioOb", name);
      const oc = cell(rm.json, "secondaryOb", name);
      const ob = typeof oc?.value === "number" ? oc.value : 0;
      fullTeamOb += ob;
      if (typeof rc?.value === "number") {
        recoveredCost += (rc.value * ob) / 100;
        recordedOnlyOb += ob;
      } else if (/UNDEFINED/.test(rc?.note ?? "") && !/not recorded/.test(rc?.note ?? "")) {
        unrecoverable++; // has cost, but OB = 0 — ratio cannot reveal the cost
      }
    }
    if (unrecoverable === 0 && fullTeamOb > 0 && rm.status === 200) {
      const expectedFull = (recoveredCost / fullTeamOb) * 100;
      const wrongRecordedOnly = (recoveredCost / recordedOnlyOb) * 100;
      check(
        `head '${FIXTURE_HEAD}' costRatioOb cross-foots on the FULL-TEAM denominator (expected ≈ ${expectedFull.toFixed(2)})`,
        Number.isFinite(expectedFull) && Math.abs(fxCell.value - expectedFull) <= Math.max(0.06, expectedFull * 0.002),
        `head=${fxCell.value} expectedFull=${expectedFull.toFixed(4)} wrongRecordedOnly=${wrongRecordedOnly.toFixed(4)}`,
      );
      if (Math.abs(wrongRecordedOnly - expectedFull) > 0.2) {
        check(
          `head '${FIXTURE_HEAD}' ratio does NOT match the wrong recorded-members-only denominator`,
          Math.abs(fxCell.value - wrongRecordedOnly) > 0.1,
          `head=${fxCell.value} wrongRecordedOnly=${wrongRecordedOnly.toFixed(4)} — denominator regression`,
        );
      }
      crossFooted = true;
    }
  }
  check(
    `fixture head '${FIXTURE_HEAD}' cross-footed numerically on the full-team denominator`,
    crossFooted,
    "fixture head not cross-footable (a cost-recorded member has zero OB, or the request failed) — point GUARD_HEAD at a cross-footable head; do not accept silently",
  );
}

console.log(failures === 0 ? "\nAll comparison guard checks passed." : `\n${failures} comparison guard check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
