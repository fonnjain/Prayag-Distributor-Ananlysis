export type ProductWiseOrderIdentity = {
  orderId: string;
  productCode: string;
  occurrence: number;
};

export type ProductWiseOrderMonthPlan = {
  month: string;
  action: "replace" | "protected" | "frozen";
  removeKeys: string[];
  insertKeys: string[];
  unchangedKeys: string[];
  freezeAt: Date | null;
  startUtc: Date;
  endUtc: Date;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function indiaMonthLabel(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return `${MONTHS[month - 1]}-${String(year % 100).padStart(2, "0")}`;
}

function monthBounds(month: string): { startUtc: Date; endUtc: Date } {
  const match = month.match(/^([A-Z][a-z]{2})-(\d{2})$/);
  const monthIndex = match ? MONTHS.indexOf(match[1]!) : -1;
  if (monthIndex < 0 || !match) throw new Error(`Invalid India-calendar month: ${month}`);
  const year = 2000 + Number(match[2]);
  const startUtc = new Date(Date.UTC(year, monthIndex, 1, -5, -30));
  const endUtc = new Date(Date.UTC(year, monthIndex + 1, 1, -5, -30));
  return { startUtc, endUtc };
}

function identityKey(row: ProductWiseOrderIdentity): string {
  return `${row.orderId}\u0000${row.productCode}\u0000${row.occurrence}`;
}

export function productWiseOrderMonthPlan(input: {
  month: string;
  incoming: ProductWiseOrderIdentity[];
  existing: ProductWiseOrderIdentity[];
  now?: Date;
}): ProductWiseOrderMonthPlan {
  const { startUtc, endUtc } = monthBounds(input.month);
  const now = input.now ?? new Date();
  const monthYear = Number(input.month.slice(-2));
  const isAugust = input.month === "Aug-26";
  const freezeAt = input.month.startsWith("Sep-") || monthYear > 26
    ? new Date(Date.UTC(2000 + monthYear + 1, 0, 1, -5, -30))
    : null;
  if (isAugust) {
    return { month: input.month, action: "protected", removeKeys: [], insertKeys: [], unchangedKeys: [], freezeAt: null, startUtc, endUtc };
  }
  if (freezeAt && now >= freezeAt) {
    return { month: input.month, action: "frozen", removeKeys: [], insertKeys: [], unchangedKeys: [], freezeAt, startUtc, endUtc };
  }
  const incoming = new Set(input.incoming.map(identityKey));
  const existing = new Set(input.existing.map(identityKey));
  return {
    month: input.month,
    action: "replace",
    removeKeys: [...existing].filter((key) => !incoming.has(key)).sort(),
    insertKeys: [...incoming].filter((key) => !existing.has(key)).sort(),
    unchangedKeys: [...incoming].filter((key) => existing.has(key)).sort(),
    freezeAt,
    startUtc,
    endUtc,
  };
}

export function assertGenericProductWiseOrderMonth(month: string): void {
  if (month === "Aug-26") {
    throw new Error("Aug-26 is protected and must be replaced through the guarded Product-Wise August flow.");
  }
}