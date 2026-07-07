// src/reconcile.js — Layer B: exact, deterministic invariants. The LLM is NOT the
// calculator here. Any hard failure should block publish.
const TOL = 1; // ₹ rounding tolerance for cross-foot
const COST_COVERAGE_MIN = 0.75;

function reconcile(dataset) {
  const bm = dataset.build_meta;
  const checks = [];
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);

  const grand = bm.grand_total_amount;
  const groupSum = sum(dataset.by_group, 'amount');
  const headSum = sum(dataset.by_head, 'amount');
  const stateSum = sum(dataset.by_state, 'amount');

  checks.push(mk('crossfoot_group_vs_grand', Math.abs(groupSum - grand) <= TOL, { grand, groupSum }));
  checks.push(mk('crossfoot_head_vs_grand', Math.abs(headSum - grand) <= TOL, { grand, headSum }));
  checks.push(mk('crossfoot_state_vs_grand', Math.abs(stateSum - grand) <= TOL, { grand, stateSum }));

  checks.push(mk('no_unmapped_groups', bm.unmapped_groups.length === 0, { unmapped: bm.unmapped_groups }));
  checks.push(mk('no_unmapped_heads', bm.unmapped_heads.length === 0, { unmapped: bm.unmapped_heads }));

  const negatives = dataset.by_group.filter((g) => g.amount < 0 || g.qty < 0).map((g) => g.group);
  checks.push(mk('no_negative_group_totals', negatives.length === 0, { negatives }));

  checks.push(mk('cost_coverage_ok', bm.cost_coverage_pct >= COST_COVERAGE_MIN,
    { cost_coverage_pct: bm.cost_coverage_pct, threshold: COST_COVERAGE_MIN }));

  checks.push(mk('has_rows', bm.rows_aggregated > 0, { rows: bm.rows_aggregated }));

  const failed = checks.filter((c) => c.result === 'fail' && c.gate);
  const warned = checks.filter((c) => c.result === 'fail' && !c.gate);
  const status = failed.length ? 'fail' : warned.length ? 'warn' : 'pass';
  return { status, checks };
}

// Non-gating checks (warn only): cost coverage.
const NON_GATING = new Set(['cost_coverage_ok']);
function mk(name, ok, detail) {
  return { name, result: ok ? 'pass' : 'fail', gate: !NON_GATING.has(name), ...detail };
}

module.exports = { reconcile };
