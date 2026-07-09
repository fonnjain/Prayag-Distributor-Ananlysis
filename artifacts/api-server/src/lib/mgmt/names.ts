// Name and state normalization for the management report join model.
//
// The order-booking export and the roster spell team member names with
// different casing, extra spaces, dots, and suffixes like "(Off Roll)".
// Matching happens on a normalized key: lowercase alphanumerics only, with
// parenthetical suffixes removed.

export function normName(raw: unknown): string {
  if (raw == null) return "";
  return String(raw)
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function normState(raw: unknown): string {
  if (raw == null) return "";
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Excel serial (1900 system) -> JS Date (UTC midnight).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function serialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial) * MS_PER_DAY);
}

export function dateToSerial(d: Date): number {
  return Math.round((d.getTime() - EXCEL_EPOCH_MS) / MS_PER_DAY);
}

// Order sheet dates arrive either as dd-mm-yyyy strings or Excel serials.
// Returns an Excel serial day number, or null when unparseable.
export function parseOrderDate(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 20_000 && v < 80_000 ? Math.round(v) : null;
  }
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(String(v).trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return dateToSerial(new Date(Date.UTC(year, month - 1, day)));
}

// Fiscal year helpers. fy is "2026-27"; fiscal months are Apr(0)..Mar(11).
export function fyStartYear(fy: string): number {
  return Number(fy.slice(0, 4));
}

export function fyShort(fy: string): string {
  return `${fy.slice(2, 4)}-${fy.slice(5, 7)}`;
}

export function priorFy(fy: string): string {
  const y = fyStartYear(fy) - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export function fyBoundsSerial(fy: string): { start: number; end: number } {
  const y = fyStartYear(fy);
  return {
    start: dateToSerial(new Date(Date.UTC(y, 3, 1))),
    end: dateToSerial(new Date(Date.UTC(y + 1, 2, 31))),
  };
}

// Fiscal month index for a serial date within the fy, or null if outside.
export function fiscalMonthIndex(serial: number, fy: string): number | null {
  const d = serialToDate(serial);
  const y = fyStartYear(fy);
  const idx = (d.getUTCFullYear() - y) * 12 + d.getUTCMonth() - 3;
  return idx >= 0 && idx < 12 ? idx : null;
}
