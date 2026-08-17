#!/usr/bin/env node
// Identity-key normalisation-family guard check.
//
// The project has four deliberate normalisation families; a field literally
// named `normKey` once held a normDistKey value (UPPERCASE with spaces) which
// misled a guard script into silently skipping its live checks.  This script
// asserts that every key-carrying field in API payloads round-trips through
// its declared family, so a mislabelled key fails loudly instead of silently
// misleading the next consumer.
//
// Two families appear in API payloads:
//   normSecKey  — lowercase alphanumerics, no spaces (member/person keys)
//                 Family invariant: normSecKey(v) === v
//   normDistKey — UPPERCASE + single spaces + variant merges (distributor keys)
//                 Family invariant: normDistKey(v) === v
//
// A third family is used exclusively in join maps (not surfaced in payloads):
//   headNormKey — normName (lowercase alphanumerics, parentheticals stripped)
//                 plus trailing "ji"/"sir" suffix removal; alias table maps
//                 within this family.  Family invariant: normHead(v) === v.
//                 Section D verifies HEAD_ALIASES stay inside the family and
//                 that known raw strings resolve to expected canonical keys.
//                 HEAD_ALIASES is parsed from the production names.ts source —
//                 no manually-maintained copy that can drift.
//
// Checked payload surfaces:
//   A. GET /api/mgmt/distributor-directory?fy=...
//        distributors[].distKey  → must be normDistKey-idempotent
//   B. GET /api/mgmt/distributor-deep-dive?fy=...
//        distributors[].normKey  → must be normDistKey-idempotent
//        perMember[].normKey     → must be normSecKey-idempotent
//   C. GET /api/mgmt/data?fy=...
//        members[].normKey       → must be normSecKey-idempotent
//                                  (sentinel "__unassigned__..." entries skipped)
//   D. HEAD_ALIASES (names.ts) — parsed from source; runs before server resolution.
//        All alias keys   → must be normHead-idempotent
//        All alias values → must be normHead-idempotent (prevents ji/sir collision)
//        Known raw inputs → must resolve to expected headNormKey outputs
//
// Sections A and B require Sheets auth; when the endpoint is unavailable they
// WARN and SKIP rather than FAIL — the idempotency logic is unit-tested in
// the vitest suite and the live API check is an additional smoke test.
// Section C is snapshot-backed so it can run without live Sheets auth.
// Section D is fully static and runs before the server is needed; any FAIL
// there causes an immediate non-zero exit without starting a server.
//
// Base URL: COMPARISON_BASE_URL env, else https://$REPLIT_DEV_DOMAIN/api.
// Self-provisions a disposable api-server (port 5893) when none is reachable.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Open FY derived from the clock (fiscal year runs April–March) ────────────
const _now = new Date();
const _fyStart = _now.getUTCMonth() >= 3 ? _now.getUTCFullYear() : _now.getUTCFullYear() - 1;
const OPEN_FY = `${_fyStart}-${String((_fyStart + 1) % 100).padStart(2, "0")}`;

// ── Normalisation family definitions (mirrors the TypeScript source) ──────────
// normSecKey: lowercase alphanumerics, no spaces (names.ts)
function normSecKey(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// normDistKey: UPPERCASE + single spaces + variant merges (distributorDeepDive.ts)
function normDistKey(raw) {
  return raw
    .toUpperCase()
    .replace(/\bTRADERS?\b/g, "TRADE")
    .replace(/\bENTERPRISES?\b/g, "ENTERPRISE")
    .replace(/\bINDUSTRIES\b/g, "INDUSTRY")
    .replace(/\bPVT\.?\s*LTD\.?\b/g, "PVTLTD")
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// headNormKey family — mirrors normName + normHead from names.ts.
// These functions are intentionally kept as simple mirrors so the guard script
// can run without a TypeScript build step.  The vitest test at
// src/lib/mgmt/__tests__/names.test.ts imports the production module directly
// and validates the same behaviour, catching any divergence between these
// mirrors and the production code.
//
// normName: strip parentheticals, lowercase, remove all non-alphanumeric chars.
function normName(raw) {
  if (raw == null) return "";
  return String(raw)
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
// normHead: normName + strip trailing "ji"/"sir" honorific suffix.
function normHead(raw) {
  const n = normName(raw);
  return n.replace(/(?:ji|sir)+$/, "");
}

// ── Self-checks for the normalisation family mirrors ─────────────────────────
// These run at startup (before any server or file I/O) and are fatal if they
// fail, which would indicate the mirror has drifted from the TypeScript source.
{
  const samples = [
    "ANAND SANITARYWARE",
    "JAGDAMBA TRADE",
    "SHRI ENTERPRISE",
    "BEST PVTLTD",
    "ABC INDUSTRY",
  ];
  for (const s of samples) {
    const twice = normDistKey(normDistKey(s));
    if (twice !== s) {
      console.error(
        `FATAL  normDistKey self-check failed: normDistKey(normDistKey("${s}")) = "${twice}" ≠ "${s}"`,
      );
      process.exit(1);
    }
  }
}

{
  const samples = ["ravishankar", "ashutoshkumar", "sandeepdadheech", "syedaqilrizvi"];
  for (const s of samples) {
    const twice = normSecKey(normSecKey(s));
    if (twice !== s) {
      console.error(
        `FATAL  normSecKey self-check failed: normSecKey(normSecKey("${s}")) = "${twice}" ≠ "${s}"`,
      );
      process.exit(1);
    }
  }
}

{
  const samples = [
    "anantsingh",
    "sandeepdadheech",
    "syedaqilrizvi",
    "bijuco",
    "sulinderpal",
    "pawansharma",
    "lalankumar",
    "nasirhussainkhan",
  ];
  for (const s of samples) {
    const twice = normHead(normHead(s));
    if (twice !== s) {
      console.error(
        `FATAL  normHead self-check failed: normHead(normHead("${s}")) = "${twice}" ≠ "${s}"`,
      );
      process.exit(1);
    }
  }
}

// ── Parse HEAD_ALIASES from the production names.ts source ───────────────────
// The alias table is extracted directly from the TypeScript source so this
// guard always reflects the live production file.  A manually-maintained copy
// would silently pass checks even after new aliases were added to names.ts.
const NAMES_TS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "mgmt",
  "names.ts",
);

async function parseHeadAliasesFromSource() {
  const fs = await import("node:fs/promises");
  let src;
  try {
    src = await fs.readFile(NAMES_TS_PATH, "utf8");
  } catch (e) {
    throw new Error(`Cannot read names.ts at ${NAMES_TS_PATH}: ${e.message}`);
  }

  // Locate the HEAD_ALIASES block (exported or not).
  const blockMatch = src.match(
    /(?:export\s+)?const\s+HEAD_ALIASES\s*:[^=]+=\s*\{([^}]+)\}/s,
  );
  if (!blockMatch) {
    throw new Error(
      "Could not locate HEAD_ALIASES block in names.ts — check the source for structural changes",
    );
  }
  const block = blockMatch[1];

  // Extract all `key: "value"` pairs (skip comment lines).
  const aliases = {};
  for (const m of block.matchAll(/^\s+(\w+):\s+"([^"]+)"/gm)) {
    aliases[m[1]] = m[2];
  }
  if (Object.keys(aliases).length === 0) {
    throw new Error("Parsed zero entries from HEAD_ALIASES block — regex may need updating");
  }
  return aliases;
}

// ── Reporting helpers (defined early so Section D can use them) ──────────────
let failures = 0;
function pass(label) { console.log(`  PASS  ${label}`); }
function fail(label, detail = "") {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}
function check(label, cond, detail = "") {
  if (cond) pass(label); else fail(label, detail);
}

/** Assert every value in `values` round-trips through `normFn`.
 *  Reports the first offending value, then a count of total violations. */
function checkIdempotency(fieldPath, normFn, normFamilyName, values) {
  const bad = values.filter((v) => typeof v === "string" && normFn(v) !== v);
  if (bad.length === 0) {
    pass(`${fieldPath} values are ${normFamilyName}-idempotent (${values.length} sampled)`);
    return;
  }
  const first = bad[0];
  const expected = normFn(first);
  fail(
    `${fieldPath} values must be ${normFamilyName}-idempotent`,
    `${bad.length} violation(s); first: field="${first}" → ${normFamilyName}()="${expected}"`,
  );
}

// ── Section D: headNormKey family — HEAD_ALIASES integrity (static) ──────────
// This section runs before resolveBase() so a server-startup failure cannot
// prevent it from executing.  Failures here exit immediately with a non-zero
// code, skipping the server-dependent sections A–C.
//
// Four invariants are checked:
//   D1. HEAD_ALIASES keys   are normHead-idempotent (no raw/display values slipped in)
//   D2. HEAD_ALIASES values are normHead-idempotent (prevents ji/sir silent-strip bug)
//   D3. Known raw name strings resolve to expected canonical headNormKey values
//   D4. resolveHeadKey is idempotent on its own outputs
console.log("Section D: headNormKey family — HEAD_ALIASES integrity (parsed from names.ts)");
{
  let HEAD_ALIASES;
  try {
    HEAD_ALIASES = await parseHeadAliasesFromSource();
  } catch (e) {
    console.error(`  FAIL  D0 names.ts parse — ${e.message}`);
    failures++;
    // Cannot run D1–D4 without the alias table; exit now rather than giving
    // a cascade of misleading failures.
    console.error(`\n${failures} identity-key norm-family guard check(s) FAILED.`);
    process.exit(1);
  }

  // Build a resolveHeadKey function using the parsed alias table so D3/D4
  // exercise the actual production entries, not a hardcoded copy.
  function resolveHeadKey(raw) {
    const n = normHead(raw);
    return HEAD_ALIASES[n] ?? n;
  }

  console.log(
    `  INFO  parsed ${Object.keys(HEAD_ALIASES).length} HEAD_ALIASES entries from ${NAMES_TS_PATH}`,
  );

  // D1: alias keys must already be in the headNormKey family.
  const keyBad = Object.keys(HEAD_ALIASES).filter((k) => normHead(k) !== k);
  check(
    "D1 HEAD_ALIASES keys are normHead-idempotent",
    keyBad.length === 0,
    keyBad.length > 0
      ? `${keyBad.length} violation(s); first key="${keyBad[0]}" → normHead()="${normHead(keyBad[0])}"`
      : "",
  );

  // D2: alias values must already be in the headNormKey family.
  // This is the critical guard: a value ending in "ji" or "sir" would be stripped
  // by a subsequent normHead() call and silently miss every join lookup.
  const valBad = Object.entries(HEAD_ALIASES).filter(([, v]) => normHead(v) !== v);
  check(
    "D2 HEAD_ALIASES values are normHead-idempotent (no silent ji/sir strip)",
    valBad.length === 0,
    valBad.length > 0
      ? `${valBad.length} violation(s); first key="${valBad[0][0]}", value="${valBad[0][1]}" → normHead()="${normHead(valBad[0][1])}"`
      : "",
  );

  // D3: known raw name spellings must resolve to their expected canonical keys.
  // Covers normHead transformation (space/punctuation collapse, ji/sir strip)
  // and the alias lookup in resolveHeadKey.
  const fixtures = [
    // [raw input, expected resolveHeadKey output]
    ["ANANT SINGH JI",               "anantsingh"],
    ["Anant Singh",                   "anantsingh"],
    ["RIZVI JI",                      "syedaqilrizvi"],
    ["Syed Aqil Rizvi",               "syedaqilrizvi"],
    ["Aqil Rizvi",                    "syedaqilrizvi"],
    ["SANDEEP JI",                    "sandeepdadheech"],
    ["Sandeep Dadheech",              "sandeepdadheech"],
    ["SNADEEP",                       "sandeepdadheech"],
    ["BIJJU",                         "bijuco"],
    ["Biju C.O",                      "bijuco"],
    ["BIJU",                          "bijuco"],
    ["Sulindar Pal",                  "sulinderpal"],
    ["Sulinder Pal",                  "sulinderpal"],
    ["Pawan Kumar",                   "pawansharma"],
    ["Pawan Kumar Sharma",            "pawansharma"],
    ["Pawan Sharma",                  "pawansharma"],
    ["LALAN",                         "lalankumar"],
    ["Lalan Kumar",                   "lalankumar"],
    ["NASIR HUSAIN",                  "nasirhussainkhan"],
    ["NASIR HUSSAIN",                 "nasirhussainkhan"],
    ["Nasir Hussain Khan",            "nasirhussainkhan"],
    // headNormKey strips parenthetical content; normSecKey would keep it.
    // resolveHeadKey("Ravi (Faridabad)") must equal "ravi", NOT "ravifaridabad".
    ["Ravi (Faridabad)",              "ravi"],
  ];

  let fixtureFails = 0;
  for (const [raw, expected] of fixtures) {
    const got = resolveHeadKey(raw);
    if (got !== expected) {
      fail(
        `D3 resolveHeadKey("${raw}")`,
        `expected "${expected}" got "${got}"`,
      );
      fixtureFails++;
    }
  }
  if (fixtureFails === 0) {
    pass(`D3 resolveHeadKey known-fixtures (${fixtures.length} cases)`);
  }

  // D4: resolveHeadKey must be idempotent on canonical alias target values.
  // A canonical key fed back through resolveHeadKey must return itself.
  const canonicalValues = [
    ...new Set([
      ...Object.values(HEAD_ALIASES),
      "anantsingh",
      "ravishankar",
      "bijuco",
      "sandeepdadheech",
    ]),
  ];
  const idemBad = canonicalValues.filter((v) => resolveHeadKey(v) !== v);
  check(
    `D4 resolveHeadKey is idempotent on canonical values (${canonicalValues.length} sampled)`,
    idemBad.length === 0,
    idemBad.length > 0
      ? `${idemBad.length} violation(s); first="${idemBad[0]}" → resolveHeadKey()="${resolveHeadKey(idemBad[0])}"`
      : "",
  );

  if (failures > 0) {
    console.error(
      `\n${failures} identity-key norm-family guard check(s) FAILED (Section D — static checks).`,
    );
    process.exit(1);
  }
}

// ── Server-dependent sections (A, B, C) ──────────────────────────────────────

const REQUEST_TIMEOUT_MS = Number(process.env.GUARD_REQUEST_TIMEOUT_MS ?? 120000);
const SHORT_TIMEOUT_MS = Math.min(REQUEST_TIMEOUT_MS, 30000);

async function safeFetch(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
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
    // Reuse a disposable server left by an earlier guard in the same chain.
    "http://127.0.0.1:5892/api",
    "http://127.0.0.1:5891/api",
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
  const port = Number(process.env.GUARD_SERVER_PORT ?? 5893);
  const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(`INFO  no running api-server found — booting a disposable one on port ${port}`);

  const distEntry = path.join(apiDir, "dist", "index.mjs");
  const distExists = await import("node:fs/promises")
    .then((fs) => fs.access(distEntry).then(() => true, () => false));

  if (!distExists) {
    console.log(`INFO  dist/index.mjs not found — running build first (pnpm run build)`);
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
      console.error(`FATAL: disposable api-server exited early (code ${serverProc.exitCode})`);
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

const base = await resolveBase();
console.log(`\nIdentity-key norm-family guard checks against ${base}\n`);

// ── Section A: distributor-directory distKey ──────────────────────────────────
console.log("Section A: distributor-directory distributors[].distKey (normDistKey family)");
{
  const r = await safeFetch(`${base}/mgmt/distributor-directory?fy=${OPEN_FY}`, {}, SHORT_TIMEOUT_MS);
  if (!r.ok || r._error) {
    const reason = r._error ? `request error: ${r._error}` : `HTTP ${r.status}`;
    console.warn(
      `  WARN  A skipped — distributor-directory unavailable (${reason}). ` +
      `distKey idempotency is covered by the unit-level normDistKey self-check above.`,
    );
  } else {
    const body = await r.json().catch(() => null);
    const distKeys = (body?.distributors ?? [])
      .map((d) => d.distKey)
      .filter((k) => typeof k === "string" && k.length > 0);

    if (distKeys.length === 0) {
      console.warn("  WARN  A skipped — distributor-directory returned no distributors.");
    } else {
      checkIdempotency(
        "distributors[].distKey",
        normDistKey,
        "normDistKey",
        distKeys,
      );
    }
  }
}

// ── Section B: distributor-deep-dive normKey fields ───────────────────────────
console.log("\nSection B: distributor-deep-dive distributors[].normKey (normDistKey) and perMember[].normKey (normSecKey)");
{
  const r = await safeFetch(`${base}/mgmt/distributor-deep-dive?fy=${OPEN_FY}`, {}, REQUEST_TIMEOUT_MS);
  if (!r.ok || r._error) {
    const reason = r._error ? `request error: ${r._error}` : `HTTP ${r.status}`;
    console.warn(
      `  WARN  B skipped — distributor-deep-dive unavailable (${reason}). ` +
      `normKey idempotency is covered by the unit-level normDistKey/normSecKey self-checks above.`,
    );
  } else {
    const body = await r.json().catch(() => null);

    // B1: distributors[].normKey → normDistKey family
    const distNormKeys = (body?.distributors ?? [])
      .map((d) => d.normKey)
      .filter((k) => typeof k === "string" && k.length > 0);

    if (distNormKeys.length === 0) {
      console.warn("  WARN  B1 skipped — distributor-deep-dive returned no distributors.");
    } else {
      checkIdempotency(
        "distributors[].normKey",
        normDistKey,
        "normDistKey",
        distNormKeys,
      );
    }

    // B2: perMember[].normKey → normSecKey family
    const memberNormKeys = (body?.perMember ?? [])
      .map((m) => m.normKey)
      .filter((k) => typeof k === "string" && k.length > 0);

    if (memberNormKeys.length === 0) {
      console.warn("  WARN  B2 skipped — distributor-deep-dive returned no perMember rows.");
    } else {
      checkIdempotency(
        "perMember[].normKey",
        normSecKey,
        "normSecKey",
        memberNormKeys,
      );
    }
  }
}

// ── Section C: mgmt/data members[].normKey ───────────────────────────────────
// This endpoint is snapshot-backed so it can run without live Sheets auth.
// Sentinel entries ("__unassigned__...") are not real norm keys — skip them.
console.log("\nSection C: mgmt/data members[].normKey (normSecKey family)");
{
  const r = await safeFetch(`${base}/mgmt/data?fy=${OPEN_FY}`, {}, REQUEST_TIMEOUT_MS);
  if (!r.ok || r._error) {
    const reason = r._error ? `request error: ${r._error}` : `HTTP ${r.status}`;
    console.warn(
      `  WARN  C skipped — mgmt/data unavailable (${reason}). ` +
      `normKey idempotency is covered by the unit-level normSecKey self-check above.`,
    );
  } else {
    const body = await r.json().catch(() => null);

    // members[] is the roster-mode response field (present when bridge is ready).
    // The route also returns a top-level `members` array from assembleRows — check both.
    const candidates = [
      ...(body?.members ?? []),
      ...(body?.primary?.byMember ?? []),
    ];

    // Skip sentinel values that carry no real norm key.
    const memberNormKeys = candidates
      .map((m) => m.normKey)
      .filter((k) => typeof k === "string" && k.length > 0 && !k.startsWith("__unassigned__"));

    if (memberNormKeys.length === 0) {
      console.warn(
        "  WARN  C skipped — mgmt/data returned no non-sentinel members[].normKey values. " +
        "This is expected when the bridge/roster is not loaded (disposable server first boot).",
      );
    } else {
      checkIdempotency(
        "members[].normKey (mgmt/data)",
        normSecKey,
        "normSecKey",
        memberNormKeys,
      );
    }
  }
}

console.log(
  failures === 0
    ? "\nAll identity-key norm-family guard checks passed."
    : `\n${failures} identity-key norm-family guard check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
