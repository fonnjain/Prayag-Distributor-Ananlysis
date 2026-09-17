const token = String(process.env.VERIFICATION_SERVICE_TOKEN ?? "").trim();
const productionBase = String(process.env.VERIFICATION_BASE_URL ?? "").trim().replace(/\/+$/, "");
const developmentBase = String(
  process.env.DEVELOPMENT_VERIFICATION_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}/api` : ""),
).trim().replace(/\/+$/, "");

if (token.length < 32) throw new Error("VERIFICATION_SERVICE_TOKEN must be configured");
if (!productionBase || !developmentBase) {
  throw new Error("Both VERIFICATION_BASE_URL and DEVELOPMENT_VERIFICATION_BASE_URL (or REPLIT_DEV_DOMAIN) are required");
}

async function snapshot(baseUrl, environment) {
  const response = await fetch(`${baseUrl}/verify/environment-parity`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${environment} parity endpoint returned HTTP ${response.status}`);
  return response.json();
}

function compare(key, development, production, zeroVsPopulatedIsFailure = false) {
  const delta = development - production;
  const deltaPct = production === 0 ? (development === 0 ? 0 : null) : delta / production * 100;
  const material = Math.abs(delta) >= 100 && (deltaPct == null || Math.abs(deltaPct) >= 5);
  const zeroMismatch = (development === 0) !== (production === 0);
  return {
    key,
    status: zeroMismatch && zeroVsPopulatedIsFailure ? "fail" : material ? "warn" : "pass",
    development,
    production,
    delta,
    deltaPct,
  };
}

const [development, production] = await Promise.all([
  snapshot(developmentBase, "development"),
  snapshot(productionBase, "production"),
]);
const prodByTable = new Map(production.metrics.map((metric) => [metric.table, metric]));
const checks = [];
for (const dev of development.metrics) {
  const prod = prodByTable.get(dev.table);
  if (!prod) {
    checks.push({ key: `${dev.table}.counterpart`, status: "fail", development: dev.rowCount, production: null });
    continue;
  }
  checks.push(compare(`${dev.table}.row_count`, dev.rowCount, prod.rowCount));
  checks.push(compare(`${dev.table}.distinct_keys`, dev.distinctKeys, prod.distinctKeys));
  checks.push(compare(`${dev.table}.${dev.materialColumn}.population`, dev.populatedMaterial, prod.populatedMaterial, true));
  checks.push(compare(`${dev.table}.${dev.materialColumn}.vocabulary`, dev.distinctMaterial, prod.distinctMaterial, true));
}
const summary = {
  source: "development and production PostgreSQL via verification-service read-only endpoints",
  queriedAt: new Date().toISOString(),
  developmentQueriedAt: development.queriedAt,
  productionQueriedAt: production.queriedAt,
  pass: checks.filter((check) => check.status === "pass").length,
  warn: checks.filter((check) => check.status === "warn").length,
  fail: checks.filter((check) => check.status === "fail").length,
};
console.log(JSON.stringify({ summary, checks }, null, 2));
if (summary.warn > 0 || summary.fail > 0) process.exitCode = 1;