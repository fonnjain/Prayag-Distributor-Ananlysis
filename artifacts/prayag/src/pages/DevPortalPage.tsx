import { useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Play, Loader2, Copy, Check } from "lucide-react";

// ── Static API catalogue extracted from openapi.yaml ─────────────────────────

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ParamDef {
  name: string;
  in: "query" | "path" | "header";
  required: boolean;
  description: string;
  schema: { type?: string; enum?: string[]; pattern?: string };
}

interface Operation {
  operationId: string;
  method: Method;
  path: string;
  summary: string;
  description: string;
  parameters: ParamDef[];
  requestBody?: {
    required: boolean;
    contentType: string;
    placeholder: string;
  };
  responses: { status: string; description: string }[];
}

interface TagGroup {
  tag: string;
  description: string;
  operations: Operation[];
}

const API_GROUPS: TagGroup[] = [
  {
    tag: "health",
    description: "Health operations",
    operations: [
      {
        operationId: "healthCheck",
        method: "GET",
        path: "/healthz",
        summary: "Health check",
        description: "Returns server health status.",
        parameters: [],
        responses: [{ status: "200", description: "Healthy" }],
      },
    ],
  },
  {
    tag: "analyst",
    description: "AI sales analyst operations",
    operations: [
      {
        operationId: "analyzeSales",
        method: "POST",
        path: "/analyze",
        summary: "Ask the AI sales analyst",
        description:
          "Sends a natural-language question about Prayag India sales, orders, coverage, and product data to the AI analyst and returns a markdown answer grounded in the embedded dataset.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "question": "What were total sales in FY25-26?"\n}',
        },
        responses: [{ status: "200", description: "Analyst answer" }],
      },
    ],
  },
  {
    tag: "drive",
    description: "Google Drive file operations",
    operations: [
      {
        operationId: "listDriveFiles",
        method: "GET",
        path: "/drive/files",
        summary: "List Google Drive files",
        description:
          "Lists files from the connected Google Drive account, optionally filtered by a search query. Results are ordered by most recently modified.",
        parameters: [
          { name: "q", in: "query", required: false, description: "Optional search text matched against file names.", schema: { type: "string" } },
          { name: "pageToken", in: "query", required: false, description: "Token for fetching the next page of results.", schema: { type: "string" } },
        ],
        responses: [{ status: "200", description: "List of Drive files" }],
      },
    ],
  },
  {
    tag: "dashboard",
    description: "Live dashboard data operations",
    operations: [
      {
        operationId: "getDashboard",
        method: "GET",
        path: "/dashboard",
        summary: "Get the latest dashboard snapshot",
        description:
          "Returns the most recent aggregated dashboard dataset, built from the connected Google Sheets. Falls back to a seeded baseline before the first live sync completes.",
        parameters: [],
        responses: [{ status: "200", description: "Dashboard snapshot" }],
      },
      {
        operationId: "refreshDashboard",
        method: "POST",
        path: "/dashboard/refresh",
        summary: "Rebuild the dashboard from Google Sheets",
        description:
          "Re-reads the source Google Sheets, rebuilds the aggregate dataset, and stores a new snapshot. If the refresh fails, the last good snapshot is returned with a refreshError message.",
        parameters: [],
        responses: [{ status: "200", description: "Refreshed dashboard snapshot" }],
      },
      {
        operationId: "getDashboardXlsxUploadUrl",
        method: "GET",
        path: "/dashboard/xlsx/upload-url",
        summary: "Get a presigned PUT URL for uploading a dashboard xlsx",
        description: "Returns a short-lived presigned PUT URL for direct browser-to-storage upload.",
        parameters: [],
        responses: [
          { status: "200", description: "Presigned upload URL" },
          { status: "500", description: "Could not create upload URL" },
        ],
      },
      {
        operationId: "getDashboardXlsxStatus",
        method: "GET",
        path: "/dashboard/xlsx/status",
        summary: "Get parse status for an uploaded dashboard xlsx",
        description: "Returns the parse status for a previously uploaded dashboard xlsx.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2026-27.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Parse status" },
          { status: "404", description: "No xlsx uploaded for this FY" },
        ],
      },
      {
        operationId: "registerDashboardXlsx",
        method: "POST",
        path: "/dashboard/xlsx/register",
        summary: "Register an uploaded dashboard xlsx",
        description: "Parses and persists an uploaded dashboard xlsx file.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "uploadUrl": "...",\n  "fy": "2026-27"\n}',
        },
        responses: [
          { status: "200", description: "Parse summary" },
          { status: "400", description: "Invalid request" },
        ],
      },
    ],
  },
  {
    tag: "verify",
    description: "Data health and reconciliation operations",
    operations: [
      {
        operationId: "getVerifyReport",
        method: "GET",
        path: "/verify",
        summary: "Data health reconciliation report",
        description:
          "Compares three sources for the same fiscal year — xlsx as ingested, live Google Sheets read now, and the database — reporting row counts, amount sums, distinct invoices/customers, by-group and by-head breakdowns, deltas over 0.5%, and live rows missing from the database.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year, e.g. 2026-27 (default).", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        ],
        responses: [
          { status: "200", description: "Verification report" },
          { status: "400", description: "Unknown fiscal year" },
          { status: "502", description: "Report could not be built" },
        ],
      },
      {
        operationId: "runVerifyBackfill",
        method: "POST",
        path: "/verify/backfill",
        summary: "Backfill rows missing from the database",
        description:
          "Re-reads the live register for the fiscal year and inserts any lines whose uid is not yet in the database. Idempotent.",
        parameters: [],
        requestBody: {
          required: false,
          contentType: "application/json",
          placeholder: '{\n  "fy": "2026-27"\n}',
        },
        responses: [
          { status: "200", description: "Backfill result" },
          { status: "400", description: "Unknown fiscal year" },
          { status: "502", description: "Backfill failed" },
        ],
      },
      {
        operationId: "getAnalytics",
        method: "GET",
        path: "/analytics",
        summary: "Corrected analytics on the invoice-line register",
        description:
          "Year-over-year growth over complete months only (partial months flagged and excluded), split into territory vs institutional business, plus per-head totals, customer retention over the comparable period, and margins (empty until a cost master is loaded).",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year, e.g. 2026-27 (default).", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
          { name: "compare", in: "query", required: false, description: "Comparison fiscal year (defaults to the prior year).", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        ],
        responses: [
          { status: "200", description: "Analytics report" },
          { status: "400", description: "Bad fiscal year" },
          { status: "500", description: "Analytics could not be computed" },
        ],
      },
    ],
  },
  {
    tag: "mgmt",
    description: "Management report generation",
    operations: [
      {
        operationId: "getMgmtOptions",
        method: "GET",
        path: "/mgmt/options",
        summary: "Filter options for management reports",
        description:
          "Returns the available fiscal years, region-to-state map, roster states, and the connection status of each data source used by the STATE HEAD DASHBOARD report.",
        parameters: [],
        responses: [
          { status: "200", description: "Report filter options" },
          { status: "500", description: "Options could not be loaded" },
        ],
      },
      {
        operationId: "generateMgmtReport",
        method: "POST",
        path: "/mgmt/report",
        summary: "Generate the STATE HEAD DASHBOARD Excel report",
        description:
          "Builds the STATE HEAD DASHBOARD workbook from live Google Sheets for the selected fiscal year and scope, and streams it as an xlsx download. Columns whose source is not connected are left blank with a grey fill.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "fy": "2025-26",\n  "stateHeads": [],\n  "regions": []\n}',
        },
        responses: [
          { status: "200", description: "Excel workbook (xlsx)" },
          { status: "400", description: "Invalid filters" },
          { status: "422", description: "No team members match the filters" },
          { status: "500", description: "Report generation failed" },
        ],
      },
      {
        operationId: "verifyMgmtReport",
        method: "GET",
        path: "/mgmt/verify",
        summary: "Reconcile the computed report against signed-off dashboard anchors",
        description:
          "Compares the app's computed secondary-order-booking report for the requested fiscal year against the approved dashboard anchors. Returns per-check pass/warn/fail with app value vs expected vs delta%.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2025-26. Defaults to 2025-26.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Verification result" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "422", description: "No anchors configured for the fiscal year" },
          { status: "500", description: "Verification failed" },
        ],
      },
      {
        operationId: "getTargets",
        method: "GET",
        path: "/targets",
        summary: "Team members with saved targets for a fiscal year",
        description:
          "Returns the active roster (optionally scoped to one State Head) with each member's prior-year order actuals and any targets already saved in the Prayag Target Master sheet.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2026-27. Defaults to the current FY.", schema: { type: "string" } },
          { name: "stateHead", in: "query", required: false, description: "Limit rows to one State Head's team.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Roster with saved targets" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "500", description: "Targets could not be loaded" },
        ],
      },
      {
        operationId: "saveTargets",
        method: "POST",
        path: "/targets",
        summary: "Save targets to the Target Master sheet",
        description:
          "Validates and upserts one row per team member into the Prayag Target Master Google Sheet, keyed by fiscal year and team member.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "fy": "2026-27",\n  "rows": []\n}',
        },
        responses: [
          { status: "200", description: "Save result" },
          { status: "400", description: "Invalid request" },
          { status: "422", description: "Validation failed" },
          { status: "500", description: "Save failed" },
        ],
      },
      {
        operationId: "getTargetSplitPreview",
        method: "GET",
        path: "/targets/split-preview",
        summary: "Pro-rata split of State Head totals across team members",
        description:
          "Splits annual totals across the selected State Head's active team members pro-rata by each member's prior-year order actuals. Members with no prior-year data receive an average-sized share.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2026-27.", schema: { type: "string" } },
          { name: "stateHead", in: "query", required: true, description: "State Head name.", schema: { type: "string" } },
          { name: "primary", in: "query", required: false, description: "Primary target amount.", schema: { type: "number" } },
          { name: "secondary", in: "query", required: false, description: "Secondary target amount.", schema: { type: "number" } },
          { name: "directDealer", in: "query", required: false, description: "Direct dealer target amount.", schema: { type: "number" } },
          { name: "businessPlan", in: "query", required: false, description: "Business plan amount.", schema: { type: "number" } },
        ],
        responses: [
          { status: "200", description: "Split preview" },
          { status: "400", description: "Invalid parameters" },
          { status: "422", description: "No active team members for the State Head" },
          { status: "500", description: "Split could not be computed" },
        ],
      },
      {
        operationId: "getPrimaryTargets",
        method: "GET",
        path: "/primary-targets",
        summary: "Load DB-persisted primary target entries for a fiscal year",
        description:
          "Returns the roster (state heads + primary team members) for the FY and any primary target entries saved in the database. Each entry includes a precomputed monthlyExpanded array (12 values, Apr-Mar).",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2026-27. Defaults to 2026-27.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Roster with saved primary target entries" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "500", description: "Load failed" },
        ],
      },
      {
        operationId: "savePrimaryTargets",
        method: "POST",
        path: "/primary-targets",
        summary: "Save primary target entries to the database",
        description:
          "Upserts primary target rows, keyed by fiscal year and name. Seasonal splitting is applied server-side when targets are read back.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "fy": "2026-27",\n  "rows": []\n}',
        },
        responses: [
          { status: "200", description: "Save result" },
          { status: "400", description: "Invalid request" },
          { status: "500", description: "Save failed" },
        ],
      },
      {
        operationId: "getSalesPeopleTree",
        method: "GET",
        path: "/salespeople/tree",
        summary: "Reporting tree of State Heads and their sales people",
        description:
          "Returns the roster-derived reporting tree (State Heads as roots, sales people nested underneath by Reporting Manager) with each node's own and rolled-up team NET secondary order booking for the fiscal year.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2025-26. Defaults to 2025-26.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Reporting tree" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "500", description: "Tree could not be built" },
        ],
      },
      {
        operationId: "getSalesPersonDeepDive",
        method: "GET",
        path: "/salespeople/deep-dive",
        summary: "Per-rep deep dive with FY-vs-FY breakdowns",
        description:
          "Headline tiles plus By State, By Party, By Group and By Segment tables (this FY vs last FY, with diff, growth% and share%), plus top movers, for one sales person's own book or their own + rolled-up team.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2025-26.", schema: { type: "string" } },
          { name: "repKey", in: "query", required: true, description: "Normalised rep key from the tree node.", schema: { type: "string" } },
          { name: "scope", in: "query", required: false, description: "own = this rep only; team = rep plus rolled-up juniors.", schema: { type: "string", enum: ["own", "team"] } },
        ],
        responses: [
          { status: "200", description: "Deep dive" },
          { status: "400", description: "Invalid parameters" },
          { status: "500", description: "Deep dive could not be computed" },
        ],
      },
      {
        operationId: "getSalesPersonReports",
        method: "GET",
        path: "/salespeople/{key}/reports",
        summary: "Full per-salesperson report payload (secondary + primary)",
        description:
          "Returns monthly booking (team-rolled up), secondary order-booking breakdowns (by state/group/segment/parties/movers), and primary dispatched-sale data. Used to render the Reports tab and to generate the Excel workbook.",
        parameters: [
          { name: "key", in: "path", required: true, description: "Normalised rep key from the tree node.", schema: { type: "string" } },
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2025-26.", schema: { type: "string" } },
          { name: "scope", in: "query", required: false, description: "own or team.", schema: { type: "string", enum: ["own", "team"] } },
          { name: "basis", in: "query", required: false, description: "secondary or primary.", schema: { type: "string", enum: ["secondary", "primary"] } },
          { name: "state", in: "query", required: false, description: "Optional state filter.", schema: { type: "string" } },
          { name: "party", in: "query", required: false, description: "Optional party filter.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Sales rep report" },
          { status: "400", description: "Invalid parameters" },
          { status: "500", description: "Report could not be built" },
        ],
      },
      {
        operationId: "getSalesPersonReportsDownload",
        method: "GET",
        path: "/salespeople/{key}/reports/download",
        summary: "Download per-salesperson report workbook (xlsx)",
        description:
          "Builds a 9-tab Excel workbook (Cover, Monthly Booking, By State, By Group, By Segment, Top Parties, New Parties, Churned Parties, Movers) for the selected salesperson and fiscal year.",
        parameters: [
          { name: "key", in: "path", required: true, description: "Normalised rep key from the tree node.", schema: { type: "string" } },
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2025-26.", schema: { type: "string" } },
          { name: "basis", in: "query", required: false, description: "secondary or primary.", schema: { type: "string", enum: ["secondary", "primary"] } },
          { name: "scope", in: "query", required: false, description: "own or team.", schema: { type: "string", enum: ["own", "team"] } },
        ],
        responses: [
          { status: "200", description: "Excel workbook stream" },
          { status: "400", description: "Invalid parameters" },
          { status: "500", description: "Workbook could not be built" },
        ],
      },
      {
        operationId: "verifySalesPeople",
        method: "GET",
        path: "/salespeople/verify",
        summary: "Reconcile sales-people rollups against locked head anchors",
        description:
          "Cross-foots each head's rolled-up rep total against the signed-off net anchors, reports name-match coverage between the file and the roster, and lists unmatched names in both directions.",
        parameters: [
          { name: "fy", in: "query", required: false, description: "Fiscal year like 2025-26.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Verification result" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "500", description: "Verification failed" },
        ],
      },
      {
        operationId: "analyzeSalesPerson",
        method: "POST",
        path: "/salesperson/analyze",
        summary: "AI narrative or head-level comparison for sales people",
        description:
          "In narrative mode, produces an executive summary for one sales person (or their team). In compare mode, ranks and contrasts the sales people under one State Head. Grounded strictly in the passed net numbers.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "mode": "narrative",\n  "repKey": "..."\n}',
        },
        responses: [
          { status: "200", description: "Analysis" },
          { status: "400", description: "Invalid request" },
          { status: "502", description: "The analyst is temporarily unavailable" },
        ],
      },
      {
        operationId: "getMgmtDashboardXlsxUploadUrl",
        method: "GET",
        path: "/mgmt/dashboard-xlsx/upload-url",
        summary: "Get a presigned PUT URL for uploading a STATE HEAD DASHBOARD xlsx",
        description:
          "Returns a short-lived presigned PUT URL. The browser uploads the xlsx file directly to object storage; the API never buffers it.",
        parameters: [],
        responses: [
          { status: "200", description: "Presigned upload URL" },
          { status: "500", description: "Could not create an upload URL" },
        ],
      },
      {
        operationId: "registerMgmtDashboardXlsx",
        method: "POST",
        path: "/mgmt/dashboard-xlsx/register",
        summary: "Parse and persist an uploaded STATE HEAD DASHBOARD xlsx",
        description:
          "Downloads the just-uploaded xlsx from object storage, parses the Data tab, and stores the result. Subsequent report requests for the same FY will draw targets and stateHead from this data.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "uploadUrl": "...",\n  "fy": "2026-27"\n}',
        },
        responses: [
          { status: "200", description: "Parse summary" },
          { status: "400", description: "Invalid request" },
          { status: "404", description: "Uploaded file not found" },
          { status: "500", description: "Parse failed" },
        ],
      },
      {
        operationId: "getMgmtDashboardXlsxStatus",
        method: "GET",
        path: "/mgmt/dashboard-xlsx/{fy}",
        summary: "Get parse status for an uploaded STATE HEAD DASHBOARD xlsx",
        description: "Returns the parse status for a previously uploaded STATE HEAD DASHBOARD xlsx file.",
        parameters: [
          { name: "fy", in: "path", required: true, description: "Fiscal year like 2026-27.", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        ],
        responses: [
          { status: "200", description: "Parse status" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "404", description: "No dashboard xlsx uploaded for this FY yet" },
          { status: "500", description: "Error" },
        ],
      },
    ],
  },
  {
    tag: "sap",
    description: "SAP primary-sales upload, reconciliation, and cutover",
    operations: [
      {
        operationId: "getSapUploadUrl",
        method: "POST",
        path: "/sap/upload-url",
        summary: "Get a signed URL for uploading a SAP file",
        description:
          "Returns a short-lived signed PUT URL. The browser uploads the SAP primary-sales xlsx directly to object storage; the API never buffers it.",
        parameters: [],
        responses: [
          { status: "200", description: "Signed upload URL" },
          { status: "500", description: "Could not create an upload URL" },
        ],
      },
      {
        operationId: "registerSapUpload",
        method: "POST",
        path: "/sap/register",
        summary: "Process an uploaded SAP primary-sales file",
        description:
          "Streams the just-uploaded SAP xlsx for the given fiscal year and month, enriches each line via the rate list, derives the per-month summary, and stores it. Re-uploading the same month overwrites the previous import.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "fy": "2026-27",\n  "month": "Apr-26",\n  "uploadUrl": "..."\n}',
        },
        responses: [
          { status: "200", description: "Per-month summary and FY verification report" },
          { status: "400", description: "Invalid request" },
          { status: "404", description: "Uploaded file not found" },
          { status: "422", description: "No data rows found in the file" },
          { status: "500", description: "Processing failed" },
        ],
      },
      {
        operationId: "getSapVerify",
        method: "GET",
        path: "/sap/verify",
        summary: "SAP reconciliation and verified-gate report",
        description:
          "Reconciles all uploaded SAP months for a fiscal year: customer match rate, the Apr-Jul benchmark against the signed-off total, the cross-foot (group = head = state = grand), unmatched customers, and unmapped groups.",
        parameters: [
          { name: "fy", in: "query", required: true, description: "Fiscal year, e.g. 2026-27.", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        ],
        responses: [
          { status: "200", description: "Verification report" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "500", description: "Report could not be built" },
        ],
      },
      {
        operationId: "getSapStatus",
        method: "GET",
        path: "/sap/status",
        summary: "Uploaded SAP months for a fiscal year",
        description:
          "Lists which months have a SAP file uploaded (with row count, amount, and upload time), the full month roster for the year, and whether the SAP source is verified.",
        parameters: [
          { name: "fy", in: "query", required: true, description: "Fiscal year, e.g. 2026-27.", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        ],
        responses: [
          { status: "200", description: "Import status" },
          { status: "400", description: "Invalid fiscal year" },
          { status: "500", description: "Status could not be loaded" },
        ],
      },
      {
        operationId: "deleteSapUpload",
        method: "DELETE",
        path: "/sap/upload",
        summary: "Delete an uploaded SAP month",
        description:
          "Removes the stored SAP file and its cached summary for one month, then returns the refreshed FY verification report.",
        parameters: [
          { name: "fy", in: "query", required: true, description: "Fiscal year, e.g. 2026-27.", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
          { name: "month", in: "query", required: true, description: "Month label like Apr-26.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Delete result and refreshed report" },
          { status: "400", description: "Invalid request" },
          { status: "500", description: "Delete failed" },
        ],
      },
    ],
  },
  {
    tag: "customer-master",
    description: "Customer master — editable attribution table with change history and mismatch review queue",
    operations: [
      {
        operationId: "listCustomerMaster",
        method: "GET",
        path: "/customer-master",
        summary: "List customer master records with optional filters",
        description:
          "Returns a paginated list of customer master records, filterable by type, state head, state, status, confidence, and free-text search.",
        parameters: [
          { name: "type", in: "query", required: false, description: "Customer type.", schema: { type: "string", enum: ["Distributor", "Direct Dealer", "Retailer"] } },
          { name: "stateHead", in: "query", required: false, description: "Filter by state head.", schema: { type: "string" } },
          { name: "state", in: "query", required: false, description: "Filter by state.", schema: { type: "string" } },
          { name: "status", in: "query", required: false, description: "Filter by status.", schema: { type: "string", enum: ["Active", "Inactive", "Closed", "Converted"] } },
          { name: "confidence", in: "query", required: false, description: "Filter by confidence.", schema: { type: "string", enum: ["Confirmed", "Guessed"] } },
          { name: "q", in: "query", required: false, description: "Free-text search.", schema: { type: "string" } },
          { name: "limit", in: "query", required: false, description: "Page size.", schema: { type: "integer" } },
          { name: "offset", in: "query", required: false, description: "Page offset.", schema: { type: "integer" } },
        ],
        responses: [
          { status: "200", description: "Paginated list of customer master records" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "exportCustomerMaster",
        method: "GET",
        path: "/customer-master/export",
        summary: "Export customer master as xlsx",
        description: "Exports filtered customer master records as an xlsx file download.",
        parameters: [
          { name: "type", in: "query", required: false, description: "Customer type filter.", schema: { type: "string" } },
          { name: "stateHead", in: "query", required: false, description: "State head filter.", schema: { type: "string" } },
          { name: "state", in: "query", required: false, description: "State filter.", schema: { type: "string" } },
          { name: "status", in: "query", required: false, description: "Status filter.", schema: { type: "string" } },
          { name: "confidence", in: "query", required: false, description: "Confidence filter.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "xlsx file download" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "previewCustomerMasterImport",
        method: "POST",
        path: "/customer-master/import/preview",
        summary: "Parse an xlsx file and return a diff preview (does not write to DB)",
        description:
          "Accepts a raw xlsx binary, parses it, and returns a diff preview showing what would be created, updated, or unchanged. Does not write to the database.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/octet-stream",
          placeholder: "<raw xlsx binary>",
        },
        responses: [
          { status: "200", description: "Import diff preview" },
          { status: "400", description: "Bad request" },
          { status: "422", description: "Unprocessable file" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "commitCustomerMasterImport",
        method: "POST",
        path: "/customer-master/import/commit",
        summary: "Commit a previewed import to the database",
        description:
          "Applies a previously previewed import to the database. Accepts the preview rows and writes them in bulk.",
        parameters: [],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "rows": [],\n  "source": "xlsx"\n}',
        },
        responses: [
          { status: "200", description: "Import result" },
          { status: "400", description: "Bad request" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "getCustomerMismatchCount",
        method: "GET",
        path: "/customer-master/mismatch/count",
        summary: "Number of unresolved head-attribution mismatches",
        description: "Returns the count of pending (unresolved) head-attribution mismatches in the queue.",
        parameters: [],
        responses: [
          { status: "200", description: "Count of pending mismatches" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "listCustomerMismatches",
        method: "GET",
        path: "/customer-master/mismatch",
        summary: "List head-attribution mismatch queue",
        description: "Returns all rows in the mismatch queue, optionally filtered to only pending (unresolved) items.",
        parameters: [
          { name: "pending", in: "query", required: false, description: "If true, return only unresolved mismatches.", schema: { type: "boolean" } },
        ],
        responses: [
          { status: "200", description: "Mismatch queue rows" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "resolveCustomerMismatch",
        method: "POST",
        path: "/customer-master/mismatch/{mid}/resolve",
        summary: "Approve or dismiss a head-attribution mismatch",
        description:
          "Approves or dismisses a mismatch row. Approving overwrites the customer master record's stateHead field.",
        parameters: [
          { name: "mid", in: "path", required: true, description: "Mismatch row ID.", schema: { type: "integer" } },
        ],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "action": "approve"\n}',
        },
        responses: [
          { status: "200", description: "Resolution result" },
          { status: "400", description: "Bad request" },
          { status: "404", description: "Not found" },
          { status: "409", description: "Already resolved" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "getCustomerMasterRecord",
        method: "GET",
        path: "/customer-master/{id}",
        summary: "Get a single customer master record with change history",
        description:
          "Returns the full record for one customer plus the complete audit log of all changes made to it.",
        parameters: [
          { name: "id", in: "path", required: true, description: "Customer ID.", schema: { type: "string" } },
        ],
        responses: [
          { status: "200", description: "Record and change log" },
          { status: "404", description: "Not found" },
          { status: "500", description: "Server error" },
        ],
      },
      {
        operationId: "updateCustomerMasterRecord",
        method: "PUT",
        path: "/customer-master/{id}",
        summary: "Update a customer master record (inline edit)",
        description:
          "Updates one or more fields on a customer master record. All changes are logged with timestamp and user.",
        parameters: [
          { name: "id", in: "path", required: true, description: "Customer ID.", schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          contentType: "application/json",
          placeholder: '{\n  "stateHead": "...",\n  "state": "...",\n  "type": "Distributor"\n}',
        },
        responses: [
          { status: "200", description: "Updated record" },
          { status: "400", description: "Validation error" },
          { status: "404", description: "Not found" },
          { status: "500", description: "Server error" },
        ],
      },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<Method, string> = {
  GET:    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  POST:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  PUT:    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  PATCH:  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
};

const STATUS_COLORS: Record<string, string> = {
  "200": "text-emerald-600 dark:text-emerald-400",
  "201": "text-emerald-600 dark:text-emerald-400",
  "400": "text-amber-600 dark:text-amber-400",
  "404": "text-amber-600 dark:text-amber-400",
  "409": "text-amber-600 dark:text-amber-400",
  "422": "text-amber-600 dark:text-amber-400",
  "500": "text-red-600 dark:text-red-400",
  "502": "text-red-600 dark:text-red-400",
};

function statusColor(s: string) {
  return STATUS_COLORS[s] ?? "text-muted-foreground";
}

function buildUrl(
  path: string,
  pathVals: Record<string, string>,
  queryVals: Record<string, string>,
) {
  let resolved = path;
  for (const [k, v] of Object.entries(pathVals)) {
    if (v) resolved = resolved.replace(`{${k}}`, encodeURIComponent(v));
  }
  const qs = Object.entries(queryVals)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `/api${resolved}${qs ? `?${qs}` : ""}`;
}

// ── TryItPanel ────────────────────────────────────────────────────────────────

interface TryState {
  status: number | null;
  body: string;
  loading: boolean;
  error: string | null;
}

function TryItPanel({ op }: { op: Operation }) {
  const pathParams = op.parameters.filter((p) => p.in === "path");
  const queryParams = op.parameters.filter((p) => p.in === "query");

  const [pathVals, setPathVals] = useState<Record<string, string>>(
    () => Object.fromEntries(pathParams.map((p) => [p.name, ""])),
  );
  const [queryVals, setQueryVals] = useState<Record<string, string>>(
    () => Object.fromEntries(queryParams.map((p) => [p.name, ""])),
  );
  const [bodyVal, setBodyVal] = useState(op.requestBody?.placeholder ?? "");
  const [result, setResult] = useState<TryState>({ status: null, body: "", loading: false, error: null });
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setResult({ status: null, body: "", loading: true, error: null });

    const url = buildUrl(op.path, pathVals, queryVals);
    try {
      const headers: Record<string, string> = {};
      let body: BodyInit | undefined;
      if (op.requestBody && op.method !== "GET" && op.method !== "DELETE") {
        headers["Content-Type"] = op.requestBody.contentType;
        body = bodyVal;
      }
      const res = await fetch(url, { method: op.method, signal: ctrl.signal, headers, body });
      const ct = res.headers.get("content-type") ?? "";
      let text = "";
      if (ct.includes("json")) {
        text = JSON.stringify(await res.json(), null, 2);
      } else {
        text = await res.text();
      }
      setResult({ status: res.status, body: text, loading: false, error: null });
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") return;
      setResult({ status: null, body: "", loading: false, error: String(e) });
    }
  }

  function copy() {
    navigator.clipboard.writeText(result.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-4">
      {pathParams.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Path parameters</p>
          <div className="grid gap-2">
            {pathParams.map((p) => (
              <div key={p.name} className="flex items-start gap-3">
                <div className="w-32 shrink-0 pt-1">
                  <span className="text-xs font-mono font-medium">{p.name}</span>
                  {p.required && <span className="ml-1 text-[10px] text-red-500">*</span>}
                </div>
                <input
                  className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder={p.description}
                  value={pathVals[p.name] ?? ""}
                  onChange={(e) => setPathVals((v) => ({ ...v, [p.name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {queryParams.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Query parameters</p>
          <div className="grid gap-2">
            {queryParams.map((p) => (
              <div key={p.name} className="flex items-start gap-3">
                <div className="w-32 shrink-0 pt-1">
                  <span className="text-xs font-mono font-medium">{p.name}</span>
                  {p.required && <span className="ml-1 text-[10px] text-red-500">*</span>}
                </div>
                <div className="flex-1">
                  {p.schema.enum ? (
                    <select
                      className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                      value={queryVals[p.name] ?? ""}
                      onChange={(e) => setQueryVals((v) => ({ ...v, [p.name]: e.target.value }))}
                    >
                      <option value="">(any)</option>
                      {p.schema.enum.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={p.description}
                      value={queryVals[p.name] ?? ""}
                      onChange={(e) => setQueryVals((v) => ({ ...v, [p.name]: e.target.value }))}
                    />
                  )}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{p.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {op.requestBody && op.method !== "GET" && (
        <section>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Request body
            <span className="ml-2 font-mono font-normal normal-case text-[11px] text-muted-foreground/70">
              {op.requestBody.contentType}
            </span>
          </p>
          <textarea
            className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            rows={5}
            value={bodyVal}
            onChange={(e) => setBodyVal(e.target.value)}
          />
        </section>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={result.loading}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {result.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Send
        </button>
        {result.status !== null && (
          <span className={cn("text-xs font-mono font-bold", statusColor(String(result.status)))}>
            {result.status}
          </span>
        )}
      </div>

      {(result.body || result.error) && (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Response</p>
            {result.body && (
              <button
                type="button"
                onClick={copy}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-muted/50 p-3 text-xs font-mono">
            {result.error ? (
              <span className="text-red-500">{result.error}</span>
            ) : (
              result.body
            )}
          </pre>
        </section>
      )}
    </div>
  );
}

// ── EndpointRow ───────────────────────────────────────────────────────────────

function EndpointRow({ op }: { op: Operation }) {
  const [open, setOpen] = useState(false);
  const [tryIt, setTryIt] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        <span
          className={cn(
            "w-14 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-bold font-mono uppercase",
            METHOD_COLORS[op.method],
          )}
        >
          {op.method}
        </span>
        <span className="flex-1 min-w-0 font-mono text-sm">{op.path}</span>
        <span className="hidden sm:block max-w-xs truncate text-xs text-muted-foreground">
          {op.summary}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-5 border-t border-border bg-muted/20 px-4 py-4">
          <div>
            <p className="mb-0.5 text-sm font-semibold">{op.summary}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{op.description}</p>
          </div>

          {op.parameters.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Parameters</p>
              <div className="overflow-hidden rounded border border-border text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/60 text-left">
                      <th className="w-32 px-3 py-1.5 font-semibold text-muted-foreground">Name</th>
                      <th className="w-16 px-3 py-1.5 font-semibold text-muted-foreground">In</th>
                      <th className="w-16 px-3 py-1.5 font-semibold text-muted-foreground">Type</th>
                      <th className="w-12 px-3 py-1.5 font-semibold text-muted-foreground">Req</th>
                      <th className="px-3 py-1.5 font-semibold text-muted-foreground">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {op.parameters.map((p) => (
                      <tr key={`${p.in}-${p.name}`} className="align-top">
                        <td className="px-3 py-1.5 font-mono font-medium">{p.name}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{p.in}</td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">{p.schema.type ?? "string"}</td>
                        <td className="px-3 py-1.5">
                          {p.required ? (
                            <span className="font-semibold text-red-500">yes</span>
                          ) : (
                            <span className="text-muted-foreground">no</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 leading-snug text-muted-foreground">
                          {p.description}
                          {p.schema.enum && (
                            <span className="ml-1 font-mono text-[11px]">
                              ({p.schema.enum.join(", ")})
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {op.requestBody && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Request body
                {op.requestBody.required && (
                  <span className="ml-1 font-normal normal-case text-[11px] text-red-500">required</span>
                )}
              </p>
              <p className="mb-1 font-mono text-[11px] text-muted-foreground/70">{op.requestBody.contentType}</p>
              <pre className="rounded border border-border bg-muted/50 px-3 py-2 text-xs font-mono text-muted-foreground">
                {op.requestBody.placeholder}
              </pre>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Responses</p>
            <div className="flex flex-wrap gap-2">
              {op.responses.map((r) => (
                <span key={r.status} className="rounded border border-border bg-background px-2 py-0.5 text-xs">
                  <span className={cn("mr-1 font-mono font-bold", statusColor(r.status))}>{r.status}</span>
                  <span className="text-muted-foreground">{r.description}</span>
                </span>
              ))}
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setTryIt((v) => !v)}
              className="text-xs font-semibold text-primary hover:underline"
            >
              {tryIt ? "Hide Try It" : "Try It"}
            </button>
            {tryIt && (
              <div className="mt-3 rounded border border-border bg-background p-4">
                <TryItPanel op={op} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── DevPortalPage ─────────────────────────────────────────────────────────────

export default function DevPortalPage() {
  const [activeTag, setActiveTag] = useState<string>(API_GROUPS[0].tag);

  const totalOps = API_GROUPS.reduce((n, g) => n + g.operations.length, 0);
  const activeGroup = API_GROUPS.find((g) => g.tag === activeTag) ?? API_GROUPS[0];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold tracking-tight">API Portal</h1>
          <span className="text-xs text-muted-foreground">
            {totalOps} operations · {API_GROUPS.length} groups
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse, read docs, and fire live requests against the{" "}
          <span className="font-mono text-xs">/api</span> server.
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden w-44 shrink-0 flex-col overflow-y-auto border-r py-3 md:flex">
          {API_GROUPS.map((g) => (
            <button
              key={g.tag}
              type="button"
              onClick={() => setActiveTag(g.tag)}
              className={cn(
                "flex items-center justify-between px-4 py-2 text-left text-sm transition-colors",
                activeTag === g.tag
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <span className="font-mono">{g.tag}</span>
              <span className="tabular-nums text-[11px] opacity-60">{g.operations.length}</span>
            </button>
          ))}
        </aside>

        <div className="flex w-full flex-col overflow-hidden md:hidden">
          <div className="border-b px-4 py-2">
            <select
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none"
              value={activeTag}
              onChange={(e) => setActiveTag(e.target.value)}
            >
              {API_GROUPS.map((g) => (
                <option key={g.tag} value={g.tag}>
                  {g.tag} ({g.operations.length})
                </option>
              ))}
            </select>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-4">
            <h2 className="font-mono text-base font-bold">{activeGroup.tag}</h2>
            <p className="text-sm text-muted-foreground">{activeGroup.description}</p>
          </div>
          <div className="space-y-3">
            {activeGroup.operations.map((op) => (
              <EndpointRow key={op.operationId} op={op} />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
