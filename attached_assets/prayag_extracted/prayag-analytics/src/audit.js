// src/audit.js — Layer C. Sends Claude the raw-ish rollups + the app's outputs and asks it
// to INDEPENDENTLY re-derive the headline numbers and flag anomalies. Runs twice a day.
const { callClaude, extractJson } = require('./claude');
const store = require('./store');

const AUDIT_SYSTEM = `You are an independent data auditor for Prayag India's sales dashboard.
You are given RAW rollups (register rolled to code x head x group x month) and the app's
COMPUTED outputs. Your job is to catch pipeline errors and anomalies — you do NOT trust the
app's numbers; you re-derive them yourself from the raw rollup.

Do this:
1) RECOMPUTE from raw_rollup: grand total amount; amount by group; amount by head. Compare to
   the app's app_outputs within 0.5% tolerance. Report exact figures and delta%.
2) MARGIN check: using cost_master (code->cost) and the rollup quantities, sanity-check each
   margin_by_group gp_pct. Flag any negative or >70% gross margin, or any group whose revenue
   has little/no cost coverage.
3) MAPPING spot-check: apply the provided group_map to the register_sample rows; confirm the
   app's group/head assignment is consistent. Flag mismatches.
4) ANOMALIES vs prev_snapshot: category GP swing > 5 points; cost-coverage drop; a state head
   collapsing to ~0; new codes/groups absent from the map; implausible month-on-month jumps.

Return ONLY a JSON object, no prose, of this exact shape:
{
  "status": "pass" | "warn" | "fail",
  "recompute_match": boolean,
  "checks": [{"name": str, "result": "pass"|"warn"|"fail", "app": number|null, "claude": number|null, "delta_pct": number|null}],
  "anomalies": [{"severity": "low"|"medium"|"high", "what": str, "likely_cause": str, "inspect": str}],
  "summary_for_human": str
}
Rules: status is "fail" if recompute mismatches beyond tolerance or a gate invariant is broken;
"warn" for soft anomalies only; "pass" if clean. Be precise and terse.`;

function buildUserPayload(audit, prev) {
  return JSON.stringify({
    build_meta: audit.build_meta,
    app_outputs: audit.app_outputs,
    raw_rollup_csv: audit.rollupCsv,
    rate_master_csv: audit.rateCsv,
    cost_master_csv: audit.costCsv,
    register_sample: audit.sample,
    group_map: require('../config/group_map.json').canonical,
    prev_snapshot: prev ? { by_group: prev.by_group, cost_coverage_pct: prev.cost_coverage_pct } : null,
  });
}

async function runAudit() {
  const audit = store.load('audit_inputs');
  const dataset = store.load('dataset');
  if (!audit || !dataset) throw new Error('No dataset yet. POST /api/refresh first.');

  const prev = store.load('snapshot');
  const model = process.env.AUDIT_MODEL || process.env.ANTHROPIC_MODEL;
  const text = await callClaude({
    system: AUDIT_SYSTEM,
    user: buildUserPayload(audit, prev),
    model,
    maxTokens: 2000,
  });

  let verdict;
  try { verdict = extractJson(text); }
  catch (e) { verdict = { status: 'fail', recompute_match: false, checks: [], anomalies: [{ severity: 'high', what: 'Audit reply was not valid JSON', likely_cause: String(e.message), inspect: 'audit model output' }], summary_for_human: 'Audit could not be parsed.' }; }

  verdict.audited_at = new Date().toISOString();
  verdict.fy = dataset.fy;
  store.save('last_audit', verdict);

  // Persist a compact snapshot for next run's drift comparison.
  store.save('snapshot', {
    fy: dataset.fy,
    by_group: dataset.by_group.map((g) => ({ group: g.group, amount: g.amount })),
    margin_by_group: dataset.margin_by_group,
    cost_coverage_pct: dataset.build_meta.cost_coverage_pct,
    at: verdict.audited_at,
  });

  return verdict;
}

module.exports = { runAudit };
