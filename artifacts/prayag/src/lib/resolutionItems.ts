export type ResolutionType = "HOLD" | "PENDING";
export type ResolutionStatus = "open" | "answered" | "resolved" | "accepted-as-is";

export interface ResolutionItem {
  id: string | number;
  code: string;
  type: ResolutionType;
  title: string;
  category: string;
  fiscalYear: string | null;
  month: string | null;
  scopeProduct: string | null;
  scopeMeasure: string | null;
  reason: string;
  evidence: string;
  valueAtStake: number | null;
  raisedOn: string;
  raisedBy: string;
  owner: string;
  status: ResolutionStatus;
  resolvedOn?: string | null;
  resolvedBy?: string | null;
  resolutionNote?: string | null;
  blocksApi: boolean;
  daysOpen: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export type ResolutionSort = "days-open" | "value-at-stake";

export interface ResolutionFilters {
  owner?: string;
  category?: string;
  type?: string;
}

const STATUS_ORDER: Record<ResolutionStatus, number> = {
  open: 0,
  answered: 1,
  resolved: 2,
  "accepted-as-is": 3,
};

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize the API's camelCase response while retaining nullable values. */
export function normalizeResolutionItem(raw: Record<string, unknown>): ResolutionItem {
  return {
    id: (raw.id ?? "") as string | number,
    code: String(raw.code ?? ""),
    type: String(raw.type ?? "PENDING").toUpperCase() as ResolutionType,
    title: String(raw.title ?? ""),
    category: String(raw.category ?? ""),
    fiscalYear: (raw.fiscalYear ?? null) as string | null,
    month: (raw.month ?? null) as string | null,
    scopeProduct: (raw.scopeProduct ?? null) as string | null,
    scopeMeasure: (raw.scopeMeasure ?? null) as string | null,
    reason: String(raw.reason ?? ""),
    evidence: String(raw.evidence ?? ""),
    valueAtStake: numberValue(raw.valueAtStake),
    raisedOn: String(raw.raisedOn ?? ""),
    raisedBy: String(raw.raisedBy ?? ""),
    owner: String(raw.owner ?? ""),
    status: String(raw.status ?? "open") as ResolutionStatus,
    resolvedOn: (raw.resolvedOn ?? null) as string | null,
    resolvedBy: (raw.resolvedBy ?? null) as string | null,
    resolutionNote: (raw.resolutionNote ?? null) as string | null,
    blocksApi: Boolean(raw.blocksApi),
    daysOpen: numberValue(raw.daysOpen),
    createdAt: raw.createdAt as string | undefined,
    updatedAt: raw.updatedAt as string | undefined,
  };
}

export function sortResolutionItems(items: ResolutionItem[], sort: ResolutionSort = "days-open"): ResolutionItem[] {
  return [...items].sort((a, b) => {
    const statusDelta = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (statusDelta) return statusDelta;
    const aValue = sort === "value-at-stake" ? (a.valueAtStake ?? -Infinity) : (a.daysOpen ?? -Infinity);
    const bValue = sort === "value-at-stake" ? (b.valueAtStake ?? -Infinity) : (b.daysOpen ?? -Infinity);
    return bValue - aValue || a.title.localeCompare(b.title);
  });
}

export function filterResolutionItems(items: ResolutionItem[], filters: ResolutionFilters = {}): ResolutionItem[] {
  return items.filter((item) =>
    (!filters.owner || filters.owner === "all" || item.owner === filters.owner) &&
    (!filters.category || filters.category === "all" || item.category === filters.category) &&
    (!filters.type || filters.type === "all" || item.type === filters.type),
  );
}

export interface ResolutionExportRow {
  category: string;
  code: string;
  title: string;
  owner: string;
  type: string;
  status: string;
  daysOpen: number | null;
  valueAtStake: number | null;
  fiscalYear: string;
  month: string;
  scopeProduct: string;
  scopeMeasure: string;
  reason: string;
  evidence: string;
  blocksApi: string;
}

/** Create stable grouped-export rows from the currently filtered open items. */
export function toResolutionExportRows(items: ResolutionItem[], sort: ResolutionSort = "days-open"): ResolutionExportRow[] {
  return [...items]
    .filter((item) => item.status === "open")
    .sort((a, b) => {
      const aValue = sort === "value-at-stake" ? (a.valueAtStake ?? -Infinity) : (a.daysOpen ?? -Infinity);
      const bValue = sort === "value-at-stake" ? (b.valueAtStake ?? -Infinity) : (b.daysOpen ?? -Infinity);
      return a.category.localeCompare(b.category) || bValue - aValue || a.title.localeCompare(b.title);
    })
    .map((item) => ({
      category: item.category,
      code: item.code,
      title: item.title,
      owner: item.owner,
      type: item.type,
      status: item.status,
      daysOpen: item.daysOpen,
      valueAtStake: item.valueAtStake,
      fiscalYear: item.fiscalYear ?? "",
      month: item.month ?? "",
      scopeProduct: item.scopeProduct ?? "",
      scopeMeasure: item.scopeMeasure ?? "",
      reason: item.reason,
      evidence: item.evidence,
      blocksApi: item.blocksApi ? "Yes" : "No",
    }));
}

export interface ResolutionExportContext {
  owner: string;
  category: string;
  type: string;
  search: string;
  sort: ResolutionSort;
  generatedAt: string;
}

export interface ResolutionExportDocument {
  title: string;
  generatedAt: string;
  filterContext: string;
  sections: Array<{ category: string; rows: ResolutionExportRow[] }>;
}

export const RESOLUTION_EXPORT_HEADERS = [
  "Code", "Title", "Type", "Reason", "Evidence", "Value at stake", "Days open",
  "Owner", "Status", "FY", "Month", "Product", "Measure", "Blocks API",
] as const;

export function buildResolutionExportDocument(
  items: ResolutionItem[],
  context: ResolutionExportContext,
): ResolutionExportDocument {
  const rows = toResolutionExportRows(items, context.sort);
  const sections = new Map<string, ResolutionExportRow[]>();
  for (const row of rows) sections.set(row.category, [...(sections.get(row.category) ?? []), row]);
  const filterContext = [
    `Owner: ${context.owner === "all" ? "All" : context.owner}`,
    `Category: ${context.category === "all" ? "All" : context.category}`,
    `Type: ${context.type === "all" ? "All" : context.type}`,
    context.search ? `Search: ${context.search}` : "Search: None",
    `Sort: ${context.sort === "value-at-stake" ? "Value at stake" : "Days open"}`,
  ].join(" · ");
  return {
    title: "Open resolution items",
    generatedAt: context.generatedAt,
    filterContext,
    sections: [...sections.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, categoryRows]) => ({ category, rows: categoryRows })),
  };
}

/** The row order used by both spreadsheet and print renderers. */
export function buildResolutionExportLayout(document: ResolutionExportDocument): string[][] {
  const rows: string[][] = [
    [document.title],
    [`Generated: ${document.generatedAt}`],
    [`Filters: ${document.filterContext}`],
  ];
  for (const section of document.sections) {
    rows.push([`Category: ${section.category}`], [...RESOLUTION_EXPORT_HEADERS]);
    for (const item of section.rows) {
      rows.push([
        item.code, item.title, item.type, item.reason, item.evidence,
        item.valueAtStake === null ? "" : String(item.valueAtStake),
        item.daysOpen === null ? "" : String(item.daysOpen), item.owner, item.status,
        item.fiscalYear, item.month, item.scopeProduct, item.scopeMeasure, item.blocksApi,
      ]);
    }
  }
  return rows;
}

export function groupResolutionItems(
  items: ResolutionItem[],
  sort: ResolutionSort = "days-open",
): Array<{ partition: "open" | "closed"; category: string; items: ResolutionItem[] }> {
  const result: Array<{ partition: "open" | "closed"; category: string; items: ResolutionItem[] }> = [];
  for (const partition of ["open", "closed"] as const) {
    const groups = new Map<string, ResolutionItem[]>();
    for (const item of items) {
      if ((partition === "open") !== (item.status === "open")) continue;
      groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
    }
    for (const [category, grouped] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      result.push({ partition, category, items: sortResolutionItems(grouped, sort) });
    }
  }
  return result;
}