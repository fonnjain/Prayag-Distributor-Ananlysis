// Worker thread for GP Margin spreadsheet fetches.
//
// Spawned by loader.ts for each GP MARGIN monthly file.
//
// The main-thread setTimeout mechanism is unreliable in this environment when
// concurrent Sheets API work overloads the main event loop's timer phase.
// Solution: manage the timeout INSIDE the worker, where the event loop has no
// competing work and setTimeout fires reliably within ±100 ms.
//
// When the worker-internal timer fires it postMessages { ok: false, error }
// and exits — the main thread's 'message' handler (which fires via I/O callbacks,
// unaffected by the timer-phase backlog) sees the failure and rejects normally.
//
// workerData: { fileId: string; timeoutMs?: number }
// postMessage:
//   { ok: true,  sheets: Array<{ name: string; rows: (string|number|boolean|null)[][] }> }
//   { ok: false, error: string }

import { workerData, parentPort } from "node:worker_threads";
import { listSheetTabs, readAllTabRows } from "./lib/registers/sheetsApi.js";

const { fileId, timeoutMs = 90_000 } = workerData as { fileId: string; timeoutMs?: number };

// ── Worker-internal timeout ──────────────────────────────────────────────────
// The worker's event loop has no competing HTTP server, no parallel sheet
// loads, no timers from other requests — just this one fetch.  setTimeout
// fires reliably here even when the main thread's timer phase is saturated.
let timeoutFired = false;
const internalTimer = setTimeout(() => {
  timeoutFired = true;
  parentPort!.postMessage({
    ok: false,
    error: `Sheets fetch timed out after ${timeoutMs}ms inside worker (fileId=${fileId})`,
  });
  // Give the postMessage a moment to be delivered before hard-exiting.
  // The main thread will call worker.terminate() after receiving the message,
  // so we don't need to linger.
  setTimeout(() => process.exit(0), 500);
}, timeoutMs);

async function run(): Promise<void> {
  const tabs = await listSheetTabs(fileId);
  const sheets: Array<{ name: string; rows: (string | number | boolean | null)[][] }> = [];
  for (const tab of tabs) {
    const rows = await readAllTabRows(fileId, tab.title);
    sheets.push({ name: tab.title, rows: rows as (string | number | boolean | null)[][] });
  }
  if (timeoutFired) return; // safety: don't postMessage after timeout already did
  clearTimeout(internalTimer);
  parentPort!.postMessage({ ok: true, sheets });
}

run().catch((err: unknown) => {
  if (timeoutFired) return;
  clearTimeout(internalTimer);
  parentPort!.postMessage({ ok: false, error: String(err) });
});
