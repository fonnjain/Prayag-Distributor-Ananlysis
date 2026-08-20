/**
 * Read-only client for prayag-price.com, the authoritative current-price
 * catalogue.  This deliberately exposes no mutation helpers: the source
 * application must never be changed from Distributor Analysis.
 */

const AUTHORITY_BASE = "https://prayag-price.com/api";
const PAGE_SIZE = 500;

export type AuthoritativeProduct = {
  sourceId: number;
  itemCode: string;
  productName: string | null;
  divisionRaw: string;
  seriesRange: string | null;
  size: string | null;
  uom: string | null;
  isActive: boolean;
  discontinuedFrom: string | null;
  mrp: number | null;
  priceInForceSince: string | null;
  previousMrp: number | null;
  status: "revised" | "unchanged" | "new" | "discontinued";
  colourVariants: string[];
  sourceBatchId: string | null;
  sourceReviewStatus: string | null;
  sourceReviewReasons: string[];
};

type SourceRow = {
  id: number;
  itemCode: string;
  productName?: string | null;
  division?: string | null;
  seriesRange?: string | null;
  size?: string | null;
  uom?: string | null;
  isActive?: boolean;
  dataFlag?: string | null;
  discontinuedFrom?: string | null;
  currentMrp?: number | null;
  effectiveDate?: string | null;
  // Optional fields are accepted when the upstream catalogue API exposes
  // its review/history projection. They are not fabricated if absent.
  previousMrp?: number | null;
  status?: string | null;
  colourVariants?: string[] | null;
  sourceBatchId?: string | number | null;
  reviewStatus?: string | null;
  reviewReasons?: string[] | null;
};

type SourcePage = {
  rows: SourceRow[];
  total: number;
  page: number;
  pageSize: number;
};

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function productStatus(row: SourceRow, previousMrp: number | null): AuthoritativeProduct["status"] {
  if (row.isActive === false || row.discontinuedFrom) return "discontinued";
  if (row.status === "revised" || previousMrp != null) return "revised";
  if (row.status === "new") return "new";
  return "unchanged";
}

export function normaliseAuthoritativeProduct(row: SourceRow): AuthoritativeProduct {
  const itemCode = nullableText(row.itemCode)?.toUpperCase();
  const divisionRaw = nullableText(row.division);
  if (!itemCode) throw new Error("Authoritative product row has no itemCode");
  if (!divisionRaw) throw new Error(`Authoritative product ${itemCode} has no division`);

  const previousMrp = finiteNumber(row.previousMrp);
  return {
    sourceId: row.id,
    itemCode,
    productName: nullableText(row.productName),
    divisionRaw,
    seriesRange: nullableText(row.seriesRange),
    size: nullableText(row.size),
    uom: nullableText(row.uom),
    isActive: row.isActive !== false,
    discontinuedFrom: nullableText(row.discontinuedFrom),
    mrp: finiteNumber(row.currentMrp),
    priceInForceSince: nullableText(row.effectiveDate),
    previousMrp,
    status: productStatus(row, previousMrp),
    colourVariants: Array.isArray(row.colourVariants)
      ? row.colourVariants.map(nullableText).filter((v): v is string => v != null)
      : [],
    sourceBatchId: row.sourceBatchId == null ? null : String(row.sourceBatchId),
    // dataFlag is retained as source metadata, but an absent flag is not
    // misrepresented as an approved review.
    sourceReviewStatus: nullableText(row.reviewStatus) ?? nullableText(row.dataFlag),
    sourceReviewReasons: Array.isArray(row.reviewReasons)
      ? row.reviewReasons.map(nullableText).filter((v): v is string => v != null)
      : [],
  };
}

export async function fetchAuthoritativeProducts(): Promise<{
  rows: AuthoritativeProduct[];
  fetchedAt: Date;
  sourceTotal: number;
}> {
  const key = process.env.COMPETITION_API_KEY;
  if (!key) throw new Error("COMPETITION_API_KEY is not configured");

  const rows: AuthoritativeProduct[] = [];
  let expectedTotal: number | null = null;
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${AUTHORITY_BASE}/v1/products?page=${page}&pageSize=${PAGE_SIZE}`,
      {
        method: "GET",
        headers: { "X-API-Key": key },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Authoritative MRP API ${response.status}: ${response.statusText}`);
    }
    const data = await response.json() as SourcePage;
    if (!Array.isArray(data.rows) || !Number.isInteger(data.total) || data.total < 1) {
      throw new Error("Authoritative MRP API returned an invalid paginated payload");
    }
    expectedTotal ??= data.total;
    if (data.total !== expectedTotal) {
      throw new Error("Authoritative MRP API changed total while paging; refresh aborted");
    }
    rows.push(...data.rows.map(normaliseAuthoritativeProduct));
    if (rows.length >= expectedTotal || data.rows.length === 0) break;
  }
  if (rows.length !== expectedTotal) {
    throw new Error(`Authoritative MRP API incomplete: expected ${expectedTotal}, received ${rows.length}`);
  }
  return { rows, fetchedAt: new Date(), sourceTotal: expectedTotal };
}