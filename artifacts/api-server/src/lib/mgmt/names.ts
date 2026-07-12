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

// Party (customer/distributor) name normalization for the register <-> bridge
// join. Register customers carry city suffixes ("LOHIA & SONS (GHAZIABAD)")
// and casing/punctuation noise; bridge party names carry the same city inline
// ("P S Corporation(Calicut)"). Both collapse to lowercase alphanumerics with
// every parenthetical segment removed.
export function normParty(raw: unknown): string {
  if (raw == null) return "";
  return String(raw)
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/\bm\/s\.?\s*/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

// Head-name key: normName plus stripping the honorific "ji"/"sir" suffix, so
// "ANANT SINGH JI" (register) and "Anant Singh" (bridge/roster) share a key.
export function normHead(raw: unknown): string {
  const n = normName(raw);
  return n.replace(/(?:ji|sir)+$/, "");
}

// Explicit head aliases (normHead key -> normHead key) for spellings that no
// mechanical rule can align, e.g. the register says "RIZVI JI" but the roster
// says "Syed Aqil Rizvi". Extend as new spellings appear in the logs.
const HEAD_ALIASES: Record<string, string> = {
  rizvi: "syedaqilrizvi",
  aqilrizvi: "syedaqilrizvi",
  sandeep: "sandeepdadheech",
  snadeep: "sandeepdadheech",
  // Register spells "BIJJU"; roster / State Head Dashboard spell "Biju C.O".
  // Without this alias normHead("BIJJU")="bijju" has no substring overlap with
  // normHead("Biju C.O")="bijuco", so the head silently gets zero sale.
  bijju: "bijuco",
  biju: "bijuco",
};

// Resolves head-name spellings from any source (register, bridge, folder
// names) to the canonical display used by the provided reference set
// (normally the roster's State Head column). Matching order: exact normHead,
// explicit alias, then unique substring containment ("aqilrizvi" is contained
// in "syedaqilrizvi"). Returns null when no unambiguous match exists.
export function buildHeadResolver(
  canonicalHeads: Iterable<string>,
): (raw: unknown) => string | null {
  const byKey = new Map<string, string>();
  for (const display of canonicalHeads) {
    const key = normHead(display);
    if (key && !byKey.has(key)) byKey.set(key, display);
  }
  const keys = [...byKey.keys()];
  return (raw: unknown): string | null => {
    let key = normHead(raw);
    if (!key) return null;
    key = HEAD_ALIASES[key] ?? key;
    const exact = byKey.get(key);
    if (exact) return exact;
    if (key.length >= 5) {
      const contains = keys.filter(
        (k) => k.includes(key) || key.includes(k),
      );
      if (contains.length === 1) return byKey.get(contains[0]) ?? null;
    }
    return null;
  };
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

// Order sheet dates arrive as dd-mm-yyyy OR dd-mm-yy strings, or Excel serials.
// The live 2025-26 file mixes serials (older rows) with dd-mm-yy strings like
// "18-04-25"/"31-07-25" (newer rows) — a two-digit year MUST be accepted or
// ~28k genuine FY rows (~₹14 Cr) silently drop. Returns an Excel serial day
// number, or null when unparseable.
export function parseOrderDate(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 20_000 && v < 80_000 ? Math.round(v) : null;
  }
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(String(v).trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += 2000; // "25" -> 2025
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

// Management-report month index (Apr->0 .. Mar->11) by MONTH-OF-YEAR only.
//
// The per-FY secondary order file is counted the way the company counts it: its
// own printed grand total and the signed-off per-head figures are Σ of every
// "Sub Total" row, regardless of the row's year. The file carries a messy tail
// of off-year dates (prior-quarter Jan-Mar and stray prior-FY rows) that the
// company's total INCLUDES, so we bucket purely by calendar month and never
// drop a dated row for being out of the fiscal year. This keeps the monthly
// columns footing to the annual total that reconciles to the anchors.
export function mgmtMonthIndex(serial: number): number {
  const d = serialToDate(serial);
  return (d.getUTCMonth() - 3 + 12) % 12; // Jan=9,Feb=10,Mar=11,Apr=0,...
}
