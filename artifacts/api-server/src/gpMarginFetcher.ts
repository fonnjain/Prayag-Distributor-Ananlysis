// Standalone fetcher script for GP Margin spreadsheet data.
//
// Called by loader.ts via the OS `timeout` command:
//   timeout 90 node --enable-source-maps gpMarginFetcher.mjs <fileId>
//
// When the OS `timeout` command kills this process after 90 s the parent's
// execFile callback fires via pipe-close (I/O event) — guaranteed to work
// even when the parent's timer phase is saturated.
//
// Exit 0 + stdout JSON  : { ok: true, sheets: [...] }
// Exit 0 + stdout JSON  : { ok: false, error: "<msg>" }
// Exit non-0 / no output: parent treats as fetch failure

import { listSheetTabs, readAllTabRows } from "./lib/registers/sheetsApi.js";

const fileId = process.argv[2];
if (!fileId) {
  process.stderr.write("gpMarginFetcher: missing fileId argument\n");
  process.exit(1);
}

async function run(): Promise<void> {
  const tabs = await listSheetTabs(fileId);
  const sheets: Array<{ name: string; rows: (string | number | boolean | null)[][] }> = [];
  for (const tab of tabs) {
    const rows = await readAllTabRows(fileId, tab.title);
    sheets.push({ name: tab.title, rows: rows as (string | number | boolean | null)[][] });
  }
  // Write as a single synchronous write so it is atomic before exit.
  process.stdout.write(JSON.stringify({ ok: true, sheets }));
}

run().catch((err: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
});
