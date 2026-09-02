/**
 * Prompt 56 legacy CRM parser.  Segment Wise and PSCode 3 deliberately use
 * this one parser; only the origin of the team member differs.
 */
import {
  parseOrderDate,
  serialToDate,
  type SegmentWiseDateSignature,
} from "../mgmt/names.js";
import type { SheetCellValue } from "../registers/sheetsApi.js";

export type TeamMemberStrategy =
  | { kind: "column" }
  | { kind: "filename"; teamMember: string };

export type LegacyOrderLine = {
  orderId: string;
  productCode: string;
  orderDatetime: Date;
  fiscalYear: string;
  salesUserName: string | null;
  customerName: string | null;
  dealerId: string;
  cpName: string | null;
  categoryName: string | null;
  qty: number | null;
  basicOrderValue: number | null;
  sourceRowNumber: number;
};

type Columns = Record<string, number>;
const text = (v: unknown): string => String(v ?? "").trim();
const numberOrNull = (v: unknown): number | null => {
  const raw = text(v).replace(/[₹,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Exact, literal date interpretation only. Never transpose day/month. */
export function literalParseOrderDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const serial = parseOrderDate(value);
  if (serial == null) return null;
  const date = serialToDate(serial);
  if (typeof value === "string") {
    const match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(value.trim());
    if (match) {
      const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== Number(match[2]) - 1 ||
          date.getUTCDate() !== Number(match[1])) return null;
    }
  }
  return date;
}

/** Product-Wise includes an explicit India-local time component. */
export function literalProductOrderDatetime(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const match = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(text(value));
  if (!match) return literalParseOrderDate(value);
  const [, dd, mm, yyyy, hh, mi, ss] = match;
  const date = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isPrompt56AugustDate(date: Date): boolean {
  return date.getTime() >= Date.UTC(2026, 6, 31, 18, 30) &&
    date.getTime() < Date.UTC(2026, 7, 19, 18, 30);
}

export function fiscalYearForLiteralDate(date: Date): string {
  const y = date.getUTCFullYear() - (date.getUTCMonth() < 3 ? 1 : 0);
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

function columnsFor(row: SheetCellValue[]): Columns {
  const c: Columns = {};
  row.forEach((value, i) => {
    const key = text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key && c[key] == null) c[key] = i;
  });
  return c;
}
function find(c: Columns, ...names: string[]): number {
  return names.map((n) => c[n]).find((n) => n != null) ?? -1;
}

/**
 * Parses physical rows in source order. Blank order-header cells are
 * forward-filled, as in the CRM's discount blocks. `rawRows` must include the
 * header row; the returned signature is passed unchanged to the existing
 * assertSegmentWiseDateSignature guard by the caller.
 */
export function parseLegacyV1Rows(
  rawRows: SheetCellValue[][],
  strategy: TeamMemberStrategy,
): { lines: LegacyOrderLine[]; signature: SegmentWiseDateSignature } {
  let cols: Columns | null = null;
  // Preserve numeric Excel dates while forward-filling; stringifying a serial
  // would make literal parseOrderDate reject it.
  const carry: Record<string, unknown> = {};
  const signature: SegmentWiseDateSignature = {
    numericSerialRows: 0, numericSerialDayAbove12: 0, textDateRows: 0,
    textDateFirstComponentAtMost12: 0, literalOutsideFiscalYearRows: 0,
  };
  const lines: LegacyOrderLine[] = [];
  for (let rowNumber = 0; rowNumber < rawRows.length; rowNumber++) {
    const row = rawRows[rowNumber] ?? [];
    if (!cols) {
      const candidate = columnsFor(row);
      // Segment Wise identifies the product line as Segment in some exports;
      // PSCode 3 uses Item Code.  Header detection must accept both shapes.
      if (find(candidate, "date", "orderdate") >= 0 &&
          (strategy.kind === "filename" || find(candidate, "teammembername", "teammember") >= 0) &&
          find(candidate, "subtotal", "netamount", "net", "ordervalue") >= 0 &&
          find(candidate, "segment", "productcode", "itemcode", "item", "product", "catno") >= 0 &&
          find(candidate, "retailerid", "retid", "id", "retailers", "retailer") >= 0) cols = candidate;
      continue;
    }
    const dateIndex = find(cols, "date", "orderdate");
    const orderIndex = find(cols, "orderid", "orderno", "sordno", "sord");
    const productIndex = find(cols, "productcode", "itemcode", "item", "product", "catno", "segment");
    const dealerIndex = find(cols, "retailerid", "retid", "id", "retailer");
    const teamIndex = find(cols, "teammembername", "teammember");
    const setCarry = (key: string, index: number) => {
      if (index >= 0 && text(row[index])) carry[key] = key === "date" ? row[index] : text(row[index]);
    };
    setCarry("date", dateIndex); setCarry("order", orderIndex); setCarry("dealer", dealerIndex);
    if (strategy.kind === "column") setCarry("team", teamIndex);
    const rawDate = carry.date;
    if (typeof row[dateIndex] === "number") {
      signature.numericSerialRows++;
      if (literalParseOrderDate(row[dateIndex])?.getUTCDate()! > 12) signature.numericSerialDayAbove12++;
    } else if (/^(\d{1,2})[-/]/.test(text(row[dateIndex]))) {
      signature.textDateRows++;
      if (Number(/^(\d{1,2})/.exec(text(row[dateIndex]))?.[1]) <= 12) signature.textDateFirstComponentAtMost12++;
    }
    const date = literalParseOrderDate(rawDate);
    const productCode = text(productIndex >= 0 ? row[productIndex] : null);
    const orderId = text(carry.order), dealerId = text(carry.dealer);
    if (!date || !orderId || !productCode || !dealerId) continue;
    const fy = fiscalYearForLiteralDate(date);
    lines.push({
      orderId, productCode, orderDatetime: date, fiscalYear: fy,
      salesUserName: strategy.kind === "filename" ? strategy.teamMember : (text(carry.team) || null),
      customerName: text(row[find(cols, "retailername", "customer", "customername")]) || null,
      dealerId,
      cpName: text(row[find(cols, "distributor", "distributorname")]) || null,
      categoryName: text(row[find(cols, "segment", "category", "categoryname")]) || null,
      qty: numberOrNull(row[find(cols, "qty", "quantity")]),
      basicOrderValue: numberOrNull(row[find(cols, "subtotal", "netamount", "net")]),
      sourceRowNumber: rowNumber + 1,
    });
  }
  return { lines, signature };
}