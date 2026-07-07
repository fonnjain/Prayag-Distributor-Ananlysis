// src/analyst.js — the "Ask the Analyst" panel. Sends the current dataset + a Prayag brief
// to Claude and returns a specific, numbers-grounded answer.
const { callClaude } = require('./claude');
const store = require('./store');

const COMPANY_CONTEXT = `Prayag India makes plumbing & sanitaryware products (PTMT/faucets,
CP chrome-plated, CPVC/UPVC/SWR pipes & fittings, water tanks, sinks, sanitaryware, hardware).
Route to market: 11 State Heads -> ~604 distributors + ~169 dealers -> ~5,065 active retailers,
across 31 states. The goal is to GROW SALES. Revenue concentrates in PTMT, CP and Plumbing
(~85%). Per-partner productivity varies widely across State Heads — that spread is the primary
growth lever. Always answer with specific numbers from the dataset; never invent figures.`;

const MODES = {
  growth: 'Focus on where the next rupee of growth is: under-productive territories, coverage whitespace, and category mix. Be concrete and prioritized.',
  regional: 'Focus on State Head and state performance, partner productivity (Cr per partner), and coverage gaps.',
  product: 'Focus on item-wise and category sales, margin by group, and mix shifts.',
  margin: 'Focus on gross margin by category, cost coverage caveats, and pricing/mix levers.',
};

async function analyze({ mode = 'growth', question = '' }) {
  const dataset = store.load('dataset');
  if (!dataset) throw new Error('No dataset yet. POST /api/refresh first.');

  // Compact the dataset so the prompt stays small.
  const compact = {
    fy: dataset.fy,
    build_meta: dataset.build_meta,
    totals: dataset.totals,
    by_group: dataset.by_group,
    by_head: dataset.by_head,
    margin_by_group: dataset.margin_by_group,
    top_items: (dataset.items || []).slice(0, 20),
    orders: dataset.orders,
    by_state: (dataset.by_state || []).slice(0, 20),
  };

  const system = `${COMPANY_CONTEXT}\n\nAnalyst mode: ${MODES[mode] || MODES.growth}\n\n` +
    `You are given the current dataset as JSON. Ground every claim in it. If cost_coverage_pct ` +
    `is below ~0.75, caveat margin statements. Prefer crore (₹ Cr) for readability. Keep it tight.`;

  const user = `DATASET:\n${JSON.stringify(compact)}\n\nQUESTION:\n${question || 'Where should we focus to grow sales next quarter?'}`;

  return await callClaude({ system, user, maxTokens: 1200 });
}

module.exports = { analyze };
