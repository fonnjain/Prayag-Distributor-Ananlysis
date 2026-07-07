// src/compute.js — aggregate normalized register lines into the dashboard dataset,
// plus build_meta (for the reconciliation gate) and audit_inputs (for the Claude audit).
const { normalizeGroup, normalizeHead, normalizeState } = require('./normalize');
const channel = require('../config/channel.json');

const round = (n) => Math.round(n);
const cr = (n) => +(n / 1e7).toFixed(2); // INR -> crore

function compute({ fy, register, orders, rateByCode, costByCode }) {
  const byGroup = {}, byHead = {}, byState = {}, byMonth = {}, byCode = {};
  const unmappedGroups = new Set(), unmappedHeads = new Set(), unmappedStates = new Set();
  let grandAmount = 0, grandQty = 0;
  let revenueWithCost = 0, totalRevenue = 0;
  const marginByGroup = {};

  const invByMonth = {}, custByMonth = {};

  for (const line of register) {
    grandAmount += line.amount; grandQty += line.qty; totalRevenue += line.amount;

    const g = normalizeGroup(line.group);
    if (!g && line.group) unmappedGroups.add(line.group);
    const gk = g || `(unmapped) ${line.group || '—'}`;
    (byGroup[gk] ||= { group: gk, amount: 0, qty: 0 });
    byGroup[gk].amount += line.amount; byGroup[gk].qty += line.qty;

    const h = normalizeHead(line.head);
    if (h.head == null && line.head) unmappedHeads.add(line.head);
    const hk = h.head || `(unmapped) ${line.head}`;
    (byHead[hk] ||= { head: hk, amount: 0, qty: 0, territory: h.territory });
    byHead[hk].amount += line.amount; byHead[hk].qty += line.qty;

    const st = normalizeState(line.state);
    (byState[st.state] ||= { state: st.state, head: hk, amount: 0, qty: 0 });
    byState[st.state].amount += line.amount; byState[st.state].qty += line.qty;

    const mk = line.month || '—';
    (byMonth[mk] ||= { month: mk, amount: 0, qty: 0, lines: 0 });
    byMonth[mk].amount += line.amount; byMonth[mk].qty += line.qty; byMonth[mk].lines += 1;
    (invByMonth[mk] ||= new Set()).add(line.invoice);
    (custByMonth[mk] ||= new Set()).add(line.customer);

    (byCode[line.code] ||= { code: line.code, group: gk, qty: 0, amount: 0 });
    byCode[line.code].qty += line.qty; byCode[line.code].amount += line.amount;

    // Margin (only where a clean cost exists).
    const cost = costByCode[line.code];
    if (cost != null && cost > 0) {
      revenueWithCost += line.amount;
      (marginByGroup[gk] ||= { group: gk, revenue: 0, cost: 0 });
      marginByGroup[gk].revenue += line.amount;
      marginByGroup[gk].cost += line.qty * cost;
    }
  }

  for (const m of Object.values(byMonth)) {
    m.docs = invByMonth[m.month] ? invByMonth[m.month].size : 0;
    m.customers = custByMonth[m.month] ? custByMonth[m.month].size : 0;
  }

  const seedHead = Object.fromEntries(channel.heads.map((h) => [h.head, h]));
  const headsOut = Object.values(byHead)
    .map((h) => {
      const seed = seedHead[h.head] || {};
      return {
        head: h.head,
        amount: round(h.amount), amount_cr: cr(h.amount),
        qty: round(h.qty),
        partners: seed.partners || 0,
        distributors: seed.distributors || 0,
        dealers: seed.dealers || 0,
        cr_per_partner: seed.partners ? +(h.amount / 1e7 / seed.partners).toFixed(3) : null,
        territory: h.territory,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const marginOut = Object.values(marginByGroup).map((m) => ({
    group: m.group,
    revenue: round(m.revenue), cost: round(m.cost),
    gp: round(m.revenue - m.cost),
    gp_pct: m.revenue ? +((m.revenue - m.cost) / m.revenue).toFixed(4) : null,
  })).sort((a, b) => b.revenue - a.revenue);

  const groupsOut = Object.values(byGroup)
    .map((g) => ({ group: g.group, amount: round(g.amount), amount_cr: cr(g.amount), qty: round(g.qty),
                   share: grandAmount ? +(g.amount / grandAmount).toFixed(4) : 0 }))
    .sort((a, b) => b.amount - a.amount);

  const monthOrder = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  const monthsOut = Object.values(byMonth)
    .map((m) => ({ ...m, amount: round(m.amount), amount_cr: cr(m.amount), qty: round(m.qty) }))
    .sort((a, b) => monthOrder.indexOf((a.month || '').slice(0,3)) - monthOrder.indexOf((b.month || '').slice(0,3)));

  const itemsOut = Object.values(byCode)
    .map((c) => ({ ...c, name: (rateByCode[c.code] && rateByCode[c.code].group) || '', amount: round(c.amount), amount_cr: cr(c.amount), qty: round(c.qty) }))
    .sort((a, b) => b.amount - a.amount);

  const statesOut = Object.values(byState)
    .map((s) => ({ ...s, amount: round(s.amount), amount_cr: cr(s.amount), qty: round(s.qty) }))
    .sort((a, b) => b.amount - a.amount);

  const cost_coverage_pct = totalRevenue ? +(revenueWithCost / totalRevenue).toFixed(4) : 0;

  const build_meta = {
    fy,
    period: `FY${fy}`,
    rows_aggregated: register.length,
    grand_total_amount: round(grandAmount),
    grand_total_amount_cr: cr(grandAmount),
    grand_total_qty: round(grandQty),
    cost_coverage_pct,
    unmapped_groups: [...unmappedGroups],
    unmapped_heads: [...unmappedHeads],
    unmapped_states: [...unmappedStates],
    generated_at: new Date().toISOString(),
  };

  // Compact inputs the Claude audit re-derives from (rollups, not raw lines).
  const rollup = {};
  for (const line of register) {
    const g = normalizeGroup(line.group) || `(unmapped) ${line.group}`;
    const h = normalizeHead(line.head).head || `(unmapped) ${line.head}`;
    const key = `${line.code}|${h}|${g}|${line.month}`;
    (rollup[key] ||= { code: line.code, head: h, group: g, month: line.month, qty: 0, amount: 0 });
    rollup[key].qty += line.qty; rollup[key].amount += line.amount;
  }
  const rollupCsv = ['code,head,group,month,qty,amount']
    .concat(Object.values(rollup).map((r) => `${r.code},${r.head},${r.group},${r.month},${round(r.qty)},${round(r.amount)}`))
    .join('\n');

  const rateCsv = ['code,item_group,purchase,mrp']
    .concat(Object.values(rateByCode).map((r) => `${r.code},${(r.group||'').replace(/,/g,' ')},${r.purchase},${r.mrp}`))
    .join('\n');

  const costCsv = ['code,cost'].concat(Object.entries(costByCode).map(([c, v]) => `${c},${v}`)).join('\n');

  const sample = register
    .map((l) => ({ ...l }))
    .sort(() => Math.random() - 0.5)
    .slice(0, 20);

  const dataset = {
    fy,
    generated_at: build_meta.generated_at,
    build_meta,
    totals: {
      grand_total_amount: build_meta.grand_total_amount,
      grand_total_amount_cr: build_meta.grand_total_amount_cr,
      ...channel.totals,
    },
    by_group: groupsOut,
    by_head: headsOut,
    by_state: statesOut,
    by_month: monthsOut,
    items: itemsOut.slice(0, 100),
    margin_by_group: marginOut,
    orders: orders || [],
    channel: channel.heads,
    coverage_totals: channel.totals,
  };

  const audit_inputs = { rollupCsv, rateCsv, costCsv, sample, build_meta,
    app_outputs: { by_group: groupsOut, by_head: headsOut, margin_by_group: marginOut } };

  return { dataset, audit_inputs };
}

module.exports = { compute };
