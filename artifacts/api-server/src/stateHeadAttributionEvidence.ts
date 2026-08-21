/**
 * Prints the row-level evidence behind the read-only State Head attribution
 * review. It does not write to Drive, the database, or any coverage table.
 */
import { pool } from "@workspace/db";
import { loadStateHeadAttributionConflicts } from "./lib/mgmt/stateHeadAttributionConflicts.js";
import {
  getGoogleAccessToken,
  listSheetTabs,
  readTabFormulaSample,
} from "./lib/registers/sheetsApi.js";
import { mgmtSources } from "./lib/mgmt/roster.js";

type DriveFile = { id: string; name: string };

async function listPackFiles(): Promise<DriveFile[]> {
  const token = await getGoogleAccessToken();
  const folderId = mgmtSources().state_head_registers.folderId;
  const query = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
  );
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Drive listing failed (${response.status}).`);
  const body = (await response.json()) as { files?: DriveFile[] };
  return body.files ?? [];
}

async function reportTabAudit() {
  const files = await listPackFiles();
  const audits = await Promise.all(files.map(async (file) => {
    const reportTabs = (await listSheetTabs(file.id))
      .filter((tab) => /\breport\b/i.test(tab.title));
    return Promise.all(reportTabs.map(async (tab) => {
      const formulas = (await readTabFormulaSample(file.id, tab.title, "A1:AZ120"))
        .flat()
        .map((value) => String(value ?? ""))
        .filter((value) => value.startsWith("="));
      return {
        title: tab.title,
        rows: tab.rowCount,
        formulaSamples: [...new Set(formulas)].slice(0, 20),
      };
    })).then((tabs) => ({ file: file.name, tabs }));
  }));
  return audits.filter((audit) => audit.tabs.length > 0);
}

async function main(): Promise<void> {
  const [report, reportTabs] = await Promise.all([
    loadStateHeadAttributionConflicts(),
    reportTabAudit(),
  ]);
  console.log("__ATTRIBUTION_EVIDENCE_JSON__");
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    fy: report.fy,
    coverageScope: report.coverageScope,
    reportTabs,
    conflicts: report.conflicts.map((conflict) => ({
      state: conflict.state,
      customer: conflict.customer,
      workbookHeads: conflict.workbookHeads,
      derivedRegisterHeads: conflict.derivedRegisterHeads,
      workbookNet: conflict.workbookNet,
      registerNet: conflict.registerNet,
      packToRegisterRatio: conflict.packToRegisterRatio,
      crossHeadComparisons: conflict.crossHeadComparisons,
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });