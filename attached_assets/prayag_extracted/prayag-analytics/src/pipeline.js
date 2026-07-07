// src/pipeline.js — Layer A + Layer B. Reads Sheets, builds the dataset, runs the
// reconciliation gate, and persists dataset + audit_inputs.
const sources = require('../config/sources.json');
const { readRegister, readRateMaster, readCostMaster, readOrderBook } = require('./read');
const { dedupeRateMaster } = require('./normalize');
const { compute } = require('./compute');
const { reconcile } = require('./reconcile');
const store = require('./store');

async function refresh(fy) {
  fy = fy || process.env.DEFAULT_FY || '2025-26';

  const regId = sources.sale_register.files_by_year[fy];
  if (!regId) throw new Error(`No sale_register file configured for FY ${fy} (config/sources.json).`);

  // Read (server-side; no context limits, no 10 MB export cap).
  const reg = await readRegister(regId, sources.sale_register.tab, fy);
  const rateRows = await readRateMaster(sources.rate_master.id, sources.rate_master.tab);
  const cost = await readCostMaster(sources.cost_master.id, sources.cost_master.tab, sources.cost_master.columns);

  let orders = [];
  const obId = sources.order_book.files_by_year[fy];
  if (obId) {
    try { orders = await readOrderBook(obId, sources.order_book.monthly_tabs); }
    catch (e) { orders = []; }
  }

  // Normalize the rate master (dedup -> one cost-ish row per code).
  const { byCode: rateByCode, coverage: rateCoverage } = dedupeRateMaster(rateRows);

  // Cost source priority: explicit Cost Master, else deduped rate master purchase price.
  const costByCode = { ...Object.fromEntries(Object.entries(rateByCode)
    .filter(([, v]) => v.purchase > 0).map(([c, v]) => [c, v.purchase])), ...cost };

  const { dataset, audit_inputs } = compute({ fy, register: reg.rows, orders, rateByCode, costByCode });
  dataset.build_meta.register_tab = reg.tab;
  dataset.build_meta.rows_read = reg.stats.read;
  dataset.build_meta.rows_off_fy = reg.stats.offFy;
  dataset.build_meta.rate_master_code_coverage = +rateCoverage.toFixed(4);
  dataset.build_meta.cost_master_used = Object.keys(cost).length > 0;

  const recon = reconcile(dataset);
  dataset.reconcile = recon;

  store.save('dataset', dataset);
  store.save('audit_inputs', audit_inputs);

  return { build_meta: dataset.build_meta, reconcile: recon };
}

module.exports = { refresh };
