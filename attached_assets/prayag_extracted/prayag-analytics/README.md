# Prayag Sales Intelligence

A sales dashboard for Prayag India that reads **live from your Google Sheets** and includes a
**Claude analyst** plus an automated **twice-daily sanity-check audit**.

**Design rule:** the only data seeded into the app is the **channel network** (distributors,
dealers, retailers — `config/channel.json`). Everything else — revenue, item-wise, regional,
coverage, orders, margin — is derived live from the Sheets. Nothing else is typed in.

## What's inside

```
server.js              Express API + static dashboard
src/
  drive.js             Google Sheets access (service account, values.get — no 10 MB cap)
  read.js              header-tolerant parsing of register / rate master / order book
  normalize.js         group/head/state maps + rate-master dedup
  compute.js           canonical dataset + build_meta + audit_inputs
  reconcile.js         Layer B: exact in-code invariants (the publish gate)
  pipeline.js          Layer A + B orchestration
  claude.js            Anthropic Messages API wrapper
  analyst.js           /api/analyze growth analyst
  audit.js             Layer C: independent Claude recompute + anomaly audit
  alert.js             Slack/console alerts
  store.js             JSON persistence (./data)
config/
  sources.json         Drive file IDs + read config (Cost Master id to be added)
  group_map.json       canonical 7-group taxonomy
  normalize.json       state-head + state normalization
  channel.json         SEEDED channel network (the only manual data)
public/index.html      dashboard (Overview / Regional / Products / Margins / Analyst / Audit)
```

## Run on Replit (5 min)

1. Import this folder into a Repl (**Import from upload**).
2. **Tools → Secrets** (see `.env.example`):
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — whole service-account key (see `SETUP_DRIVE.md`)
   - `ANTHROPIC_API_KEY` — from https://platform.claude.com
   - `DEFAULT_FY` — e.g. `2025-26`
   - `CRON_TOKEN` — any random string
   - *(optional)* `AUDIT_MODEL`, `SLACK_WEBHOOK_URL`
3. Press **Run**. Open the dashboard → **Refresh from Sheets**.

Locally: `cp .env.example .env`, fill it in, `npm install && npm start`, open http://localhost:3000.

## Endpoints

- `GET  /api/health` — config + last audit status
- `POST /api/refresh` `{ "year": "2025-26" }` — rebuild dataset from Sheets (Layer A+B)
- `GET  /api/data` — current dataset
- `POST /api/analyze` `{ "mode", "question" }` — ask the analyst
- `POST /api/audit` — run the Claude sanity-check now
- `GET  /cron/audit?token=CRON_TOKEN&year=2025-26` — refresh + audit + alert (for the scheduler)

## The three-layer sanity check

- **Layer A** (`pipeline.js`) — read → normalize → compute the dataset.
- **Layer B** (`reconcile.js`) — exact, deterministic invariants in code (cross-foot totals,
  mapping completeness, cost coverage). This is the gate; the LLM is never the calculator.
- **Layer C** (`audit.js`) — twice a day, Claude receives the **raw rollups + the app's outputs**,
  **independently re-derives** the headline numbers, spot-checks the mapping, flags anomalies vs
  the previous snapshot, and says which sheet to inspect. Verdict is stored; `warn`/`fail` alerts.

Wire the schedule with a **Replit Scheduled Deployment** (or external cron) hitting
`/cron/audit?token=...` at e.g. 06:00 and 18:00 IST.

## Before it produces margins

Create one **Cost Master** tab in Sheets (`Item Code → Finished-Good Cost`, fed from BOM/GP),
and put its file id in `config/sources.json → cost_master.id`. Until then the app falls back to
the deduped rate-master purchase price and flags low cost coverage. See the accompanying
data-layer spec for the full rationale.

## Notes

- The register file titled `2026-27` currently holds FY2025-26 rows — the parser keys the period
  off row-level dates, not the file name, so set `DEFAULT_FY` to the year you actually want.
- All Sheets/Claude calls run server-side; no keys reach the browser.
