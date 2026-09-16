import {
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normParty } from "./names.js";

const COMMERCIAL_SHEET_ID = "1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY";
const COMMERCIAL_TAB = "Distributor wise order booking ";

export const PENDING_COMMERCIAL_SOURCE =
  "STATE HEAD DASHBOARD 2025-26 — Distributor wise order booking";

export type PendingCommercialRow = {
  party: string;
  totalOrder: number;
  sale: number;
  difference: number;
  differencePct: number | null;
  assignedMembers: number;
  avgOrderBooking: number | null;
  perPersonPerMonth: number | null;
};

export type PendingCommercialData = {
  byParty: Map<string, PendingCommercialRow[]>;
  sourceRows: number;
  source: typeof PENDING_COMMERCIAL_SOURCE;
};

function text(value: SheetCellValue | undefined): string {
  return String(value ?? "").trim();
}

function numberOrNull(value: SheetCellValue | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[,\s₹%]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function headerKey(value: SheetCellValue | undefined): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function buildPendingCommercialData(
  rows: SheetCellValue[][],
): PendingCommercialData {
  let headerIndex = -1;
  let partyIndex = -1;
  let orderIndex = -1;
  let saleIndex = -1;
  let assignedIndex = -1;

  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex++) {
    const keys = rows[rowIndex].map(headerKey);
    const party = keys.findIndex((key) => key === "DISTRIBUTORNAME");
    const order = keys.findIndex((key) => key === "TOTALORDER");
    const sale = keys.findIndex((key) => /^SALE\d*$/.test(key));
    const assigned = keys.findIndex((key) => key === "ASSIGNEDTEAMMEMBERCOUNT");
    if (party >= 0 && order >= 0 && sale >= 0 && assigned >= 0) {
      headerIndex = rowIndex;
      partyIndex = party;
      orderIndex = order;
      saleIndex = sale;
      assignedIndex = assigned;
      break;
    }
  }

  if (headerIndex < 0) {
    throw new Error(
      `${PENDING_COMMERCIAL_SOURCE}: required distributor/order/sale/member-count headers not found`,
    );
  }

  const byParty = new Map<string, PendingCommercialRow[]>();
  let sourceRows = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const party = text(row[partyIndex]);
    if (!party || /^total$/i.test(party)) continue;
    const totalOrder = numberOrNull(row[orderIndex]);
    const sale = numberOrNull(row[saleIndex]);
    const assignedMembers = numberOrNull(row[assignedIndex]);
    if (totalOrder == null || sale == null || assignedMembers == null) continue;

    const difference = totalOrder - sale;
    const differencePct = totalOrder !== 0 ? difference / totalOrder : null;
    const avgOrderBooking =
      assignedMembers > 0 ? totalOrder / assignedMembers : null;
    const commercial: PendingCommercialRow = {
      party,
      totalOrder,
      sale,
      difference,
      differencePct,
      assignedMembers,
      avgOrderBooking,
      perPersonPerMonth:
        avgOrderBooking == null ? null : avgOrderBooking / 12,
    };
    const key = normParty(party);
    if (!key) continue;
    const matches = byParty.get(key) ?? [];
    matches.push(commercial);
    byParty.set(key, matches);
    sourceRows++;
  }

  return { byParty, sourceRows, source: PENDING_COMMERCIAL_SOURCE };
}

export async function loadPendingCommercialData(): Promise<PendingCommercialData> {
  const rows: SheetCellValue[][] = [];
  await readTabRowsChunked(COMMERCIAL_SHEET_ID, COMMERCIAL_TAB, (chunk) => {
    rows.push(...chunk);
  });
  return buildPendingCommercialData(rows);
}