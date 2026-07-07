// server.js — Prayag Analytics API + static dashboard.
const express = require('express');
const path = require('path');
const { driveConfigured } = require('./src/drive');
const { refresh } = require('./src/pipeline');
const { analyze } = require('./src/analyst');
const { runAudit } = require('./src/audit');
const { alert } = require('./src/alert');
const store = require('./src/store');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

// Health / config status.
app.get('/api/health', wrap(async (req, res) => {
  res.json({
    ok: true,
    driveConfigured: await driveConfigured(),
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    defaultFy: process.env.DEFAULT_FY || '2025-26',
    hasDataset: store.exists('dataset'),
    lastAudit: store.load('last_audit'),
  });
}));

// Rebuild the dataset from Sheets (Layer A + B). body: { year }
app.post('/api/refresh', wrap(async (req, res) => {
  const fy = (req.body && req.body.year) || process.env.DEFAULT_FY || '2025-26';
  const out = await refresh(fy);
  res.json(out);
}));

// Serve the current dataset to the dashboard.
app.get('/api/data', wrap(async (req, res) => {
  const d = store.load('dataset');
  if (!d) return res.status(404).json({ error: 'No dataset. POST /api/refresh (needs Drive creds) first.' });
  res.json(d);
}));

// Ask-the-Analyst. body: { mode, question }
app.post('/api/analyze', wrap(async (req, res) => {
  const { mode, question } = req.body || {};
  res.json({ answer: await analyze({ mode, question }) });
}));

// Run the Claude sanity-check audit on demand.
app.post('/api/audit', wrap(async (req, res) => {
  const verdict = await runAudit();
  if (verdict.status !== 'pass') await alert(verdict);
  res.json(verdict);
}));

// Scheduled entry point — Replit Scheduled Deployment / cron hits this 2x/day.
// GET /cron/audit?token=CRON_TOKEN[&year=2025-26]
app.get('/cron/audit', wrap(async (req, res) => {
  if ((req.query.token || '') !== (process.env.CRON_TOKEN || '')) {
    return res.status(403).json({ error: 'bad token' });
  }
  const fy = req.query.year || process.env.DEFAULT_FY || '2025-26';
  const build = await refresh(fy);            // Layer A + B (gate)
  const verdict = await runAudit();           // Layer C (Claude)
  if (build.reconcile.status !== 'pass' || verdict.status !== 'pass') {
    await alert({ ...verdict, summary_for_human:
      `reconcile=${build.reconcile.status}; ${verdict.summary_for_human || ''}` });
  }
  res.json({ reconcile: build.reconcile, audit: verdict });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Prayag Analytics on :${PORT}`));
