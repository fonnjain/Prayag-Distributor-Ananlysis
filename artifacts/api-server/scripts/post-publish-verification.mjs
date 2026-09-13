const token = String(process.env.VERIFICATION_SERVICE_TOKEN ?? "").trim();
const rawBaseUrl = String(process.env.VERIFICATION_BASE_URL ?? "").trim().replace(/\/+$/, "");

if (token.length < 32) {
  throw new Error("VERIFICATION_SERVICE_TOKEN must be configured with at least 32 characters");
}
let baseUrl;
try {
  const parsed = new URL(rawBaseUrl);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("published verification requires HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("base URL must not include credentials, query parameters, or fragments");
  }
  baseUrl = parsed.toString().replace(/\/+$/, "");
} catch (err) {
  throw new Error(
    `VERIFICATION_BASE_URL must be a valid HTTPS API base URL: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const headers = { Authorization: `Bearer ${token}` };
const JSON_CONTENT_TYPE = "application/json";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  return response;
}

function statusCounts(checks) {
  const counts = {};
  for (const check of checks) {
    const status = String(check?.status ?? "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function evaluationCounts(checks) {
  const counts = { evaluated: 0, not_evaluated: 0 };
  for (const check of checks) {
    const evaluation = String(check?.evaluation ?? "unknown");
    if (evaluation in counts) counts[evaluation]++;
  }
  return counts;
}

async function jsonCheck(path, summarize) {
  const response = await get(path);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.json().catch(() => null);
  const valid = response.ok && contentType.includes(JSON_CONTENT_TYPE) && body;
  console.log(JSON.stringify({
    path,
    status: response.status,
    contentType,
    summary: valid ? summarize(body) : { error: "Unexpected response" },
  }, null, 2));
  if (!valid) process.exitCode = 1;
}

await jsonCheck("/verify", (body) => ({
  fy: body.fy ?? null,
  notApplicable: body.notApplicable ?? false,
  topLevelFields: Object.keys(body).sort(),
}));
await jsonCheck("/mgmt/verify", (body) => ({
  fy: body.fy ?? null,
  available: body.available ?? null,
  overall: body.overall ?? null,
  checks: Array.isArray(body.checks) ? body.checks.length : 0,
  checkStatuses: statusCounts(Array.isArray(body.checks) ? body.checks : []),
}));
await jsonCheck("/audit", (body) => {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const checks = groups.flatMap((group) => Array.isArray(group?.checks) ? group.checks : []);
  const validEvaluations = checks.every(
    (check) => check?.evaluation === "evaluated" || check?.evaluation === "not_evaluated",
  );
  const groupManifestsConsistent = groups.every((group) => {
    const expectedKeys = Array.isArray(group?.expectedKeys) ? group.expectedKeys : [];
    const groupChecks = Array.isArray(group?.checks) ? group.checks : [];
    const totals = group?.totals;
    return expectedKeys.length === groupChecks.length &&
      totals?.expected === expectedKeys.length &&
      totals?.evaluated + totals?.notEvaluated === totals?.expected;
  });
  const totalsConsistent = Boolean(
    body.totals &&
    body.totals.expected === checks.length &&
    body.totals.evaluated + body.totals.notEvaluated === body.totals.expected,
  );
  if (!validEvaluations || !groupManifestsConsistent || !totalsConsistent) {
    throw new Error(
      `Audit manifest invariant failed: validEvaluations=${validEvaluations}, ` +
      `groupManifestsConsistent=${groupManifestsConsistent}, totalsConsistent=${totalsConsistent}`,
    );
  }
  return {
    fy: body.fy ?? null,
    overall: body.overall ?? null,
    groups: groups.length,
    checks: checks.length,
    totals: body.totals ?? null,
    checkStatuses: statusCounts(checks),
    evaluationCounts: evaluationCounts(checks),
    validEvaluations,
    groupManifestsConsistent,
    totalsConsistent,
  };
});

const download = await get("/audit/download");
const bytes = Buffer.from(await download.arrayBuffer());
const contentType = download.headers.get("content-type") ?? "";
const validDownload =
  download.ok &&
  contentType.includes(XLSX_CONTENT_TYPE) &&
  bytes.length > 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b;
console.log(JSON.stringify({
  path: "/audit/download",
  status: download.status,
  contentType,
  contentDisposition: download.headers.get("content-disposition"),
  bytes: bytes.length,
  validXlsx: validDownload,
}, null, 2));
if (!validDownload) process.exitCode = 1;