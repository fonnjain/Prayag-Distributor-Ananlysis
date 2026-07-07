# Connecting Google Drive (service account)

The app reads your Prayag Sheets as a **Google service account** — a robot Google account the
server logs in as. Create it once, share the sheets with it, paste its key into Replit.

## 1. Create the service account (free, ~5 min)
1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → Library** → enable **Google Sheets API** (and **Google Drive API**).
3. **Credentials → Create credentials → Service account** (e.g. `prayag-replit`). Create.
4. Open it → **Keys → Add key → Create new key → JSON**. A `.json` downloads. Copy its
   `client_email` (looks like `prayag-replit@your-project.iam.gserviceaccount.com`).

## 2. Share the sheets with it
The service account only sees files shared with it.
- **Fast:** put all Prayag sheets in one folder and share that folder (**Viewer**) with the
  `client_email`.
- **Per file:** open each sheet → Share → add the `client_email` as Viewer.

The files needed are the ones in `config/sources.json` (registers, order book, rate master, and
the Cost Master once you create it).

## 3. Add the key to Replit
1. **Tools → Secrets**.
2. New secret `GOOGLE_SERVICE_ACCOUNT_JSON` = the **entire** JSON file contents (one paste).
3. Keep `ANTHROPIC_API_KEY` set too.
4. Press **Run**.

## 4. Test
- `GET /api/health` → `"driveConfigured": true`.
- Dashboard → **Refresh from Sheets**, or `POST /api/refresh {"year":"2025-26"}`.

No 10 MB cap applies — the app reads via the Sheets API (`values.get`), so the large registers
that block Drive *exports* read fine here.
