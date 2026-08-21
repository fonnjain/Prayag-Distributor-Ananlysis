// One-off: read the 15 "Sate Head 2026-27" folder spreadsheets (all tabs, A:O),
// load into a scratch table statehead_file_line for attribution analysis.
// Columns positional, no header row:
// A invoice, B date, C customer, D code, E dispatch date, F qty, G rate,
// H amount, I group, J station, K STATE, L STATE HEAD, M product group, N FY, O FY
import { listSheetTabs, readAllTabRows } from "../src/lib/registers/sheetsApi";
import { pool } from "@workspace/db";
import {
  classifyStateHeadPackFile,
  configuredStateHeadPackPolicy,
} from "../src/lib/mgmt/stateHeadPack";

const FILES: Array<[string, string]> = [
  ["1G3z_gOk5JR8yFmcVCadFCgpltjY1y0pI4ZBmGwrF2pU", "Anant Singh JI 2026-27"],
  ["1nkdjYIVKtVTE9xO29CvAL9-2An3Yk0xirio8J4GW1mM", "ANUJ SHARMA 2026-27"],
  ["1km-8e4Jw3X_1BoKJDeSTps6h9j3_o7m0g1TdrQzkVA4", "AP TELENGANA 2026-27"],
  ["1bq6XgCIt6_-tBW3m3c_quqz1Hrbg1xVA-0X8Ve-E4H8", "BIJJU  2026-27"],
  ["1ZkddXZhhC3OpK4fUGiDf64LrlAKrXIUGW4NzgxaYaJo", "LALAN 2026-27"],
  ["1NpKmHT-AgsEoTaYmpl7FrsqkRjqrnNYB6KJlXcMD4Y4", "NARENDRA SHARMA 2026-27"],
  ["1OI6q1QYaoSfY7fC4QcwvYeGEV6q6CRX6hTlFaVFmqFM", "Nasir JI 2026-27"],
  ["1ITKHwizpmqMNPA5D0eI2dJhzGhTGra0flEcn2fcSDew", "Other 2026-27"],
  ["1H7zfz2BQyy5n5SJAAKfm9S3VJw89LF8dcU9GVgk-J8Q", "Pawan JI 2026-27"],
  ["12rxWN5Wyh3J_z5PyLpyGFWkIibzlkHfsD2VDkt-NXFI", "PROJECT 2026-27"],
  ["19mz3gsT70ai4T2YYT029gZBKfz-YewQjT14sI-wshzI", "RIZVI JI JI 2026-27"],
  ["18zT-a0a8d7rDIy2UpJGWyrWivFGKkBwdyRocPzgg8EA", "Snadeep ji  2026-27"],
  ["1zX1UEQAiOSAeafRx9WKchi2BGbsrxp5_k11TXAn_p6U", "SULINDER PAL JI 2026-27"],
  ["1nOEDqVQ0X1eYSbDhq-9x5yoBWTFJm9VpX9tjptDV4m8", "Sunil Patel  2026-27"],
  ["1kATkh-w4zebYIzlyoK0_GzPR1DD1n0ryEow4Ng26bH8", "Tamilnadu  2026-27"],
];

// This diagnostic loader historically summed every workbook in its list. Keep
// the scratch analysis safe when a temporary/duplicate workbook is added to
// the source list; the release check has the same policy and also classifies
// mixed feeders before publishing totals.
const PACK_FILES = FILES.filter(([id, name]) => {
  const manifest = classifyStateHeadPackFile({
    fileId: id,
    fileName: name,
    evidence: [],
    policy: configuredStateHeadPackPolicy(),
  });
  if (manifest.classification === "excluded") {
    console.warn(`EXCLUDED from state-head scratch load: ${manifest.reason}`);
    return false;
  }
  return true;
});

function s(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}
function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function main() {
  await pool.query(`DROP TABLE IF EXISTS statehead_file_line`);
  await pool.query(`CREATE TABLE statehead_file_line (
    src_file text, src_tab text, invoice_no text, customer text, code text,
    qty numeric, rate numeric, amount numeric, group_raw text, station text,
    state_raw text, head_raw text, product_group text, fy1 text, fy2 text
  )`);

  let total = 0;
  for (const [id, name] of PACK_FILES) {
    let tabs;
    try {
      tabs = await listSheetTabs(id);
    } catch (e) {
      console.error(`FAILED to open ${name}: ${(e as Error).message}`);
      continue;
    }
    for (const tab of tabs) {
      const rows = await readAllTabRows(id, tab.title, 15);
      const vals: any[] = [];
      for (const r of rows) {
        const amount = n(r[7]);
        const customer = s(r[2]);
        if (customer == null && amount == null) continue;
        vals.push([
          name, tab.title, s(r[0]), customer, s(r[3]), n(r[5]), n(r[6]), amount,
          s(r[8]), s(r[9]), s(r[10]), s(r[11]), s(r[12]), s(r[13]), s(r[14]),
        ]);
      }
      // batch insert
      for (let i = 0; i < vals.length; i += 1000) {
        const chunk = vals.slice(i, i + 1000);
        const params: any[] = [];
        const ph = chunk.map((row, j) => {
          row.forEach((c: any) => params.push(c));
          const base = j * 15;
          return `(${Array.from({ length: 15 }, (_, k) => `$${base + k + 1}`).join(",")})`;
        });
        await pool.query(
          `INSERT INTO statehead_file_line VALUES ${ph.join(",")}`,
          params,
        );
      }
      total += vals.length;
      console.log(`${name} :: ${tab.title} -> ${vals.length} rows (running total ${total})`);
    }
  }
  console.log(`DONE total=${total}`);
  
}
main().catch((e) => { console.error(e); process.exit(1); });
