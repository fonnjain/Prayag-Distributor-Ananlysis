// competitionClient.ts — server-side only fetcher for the Prayag Competition Analysis app.
//
// Auth: X-API-Key header (COMPETITION_API_KEY env var). Never exposed to the client bundle.
// Endpoint: GET /v1/comparison — paginates automatically; returns all rows in one call
// since the total is small (~150 rows at pageSize=200).
//
// The competition app has no Prayag-code mapping. prayag_item_code is always NULL at import
// and set via our own mapping UI.
//
// "net price" is NOT observed — it is computed as mrp × (1 − DISCOUNT_PCT/100).
// Label every derived net price as "derived" in the UI; never present it as a street price.

const COMPETITION_BASE = "https://prayag-competition-analysis.replit.app/api";
export const ASSUMED_DISCOUNT_PCT = 40; // flat default the competition app applies

export interface CompetitionApiRow {
  id: number;
  competitor: string;
  category: string;
  description: string;
  size: string | null;
  competitorPrice: number | null; // their MRP
  effectiveDate: string;          // "YYYY-MM-DD"
}

interface ApiPage {
  rows: CompetitionApiRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CompetitionFetchResult {
  rows: CompetitionApiRow[];
  fetchedAt: Date;
  total: number;
}

export async function fetchCompetitionData(): Promise<CompetitionFetchResult> {
  const key = process.env.COMPETITION_API_KEY ?? "";
  if (!key) throw new Error("COMPETITION_API_KEY is not configured");

  const allRows: CompetitionApiRow[] = [];
  let page = 1;
  const pageSize = 200;

  for (;;) {
    const url = `${COMPETITION_BASE}/v1/comparison?page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Competition API ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`,
      );
    }
    const data = (await res.json()) as ApiPage;
    allRows.push(...data.rows);
    if (allRows.length >= data.total || data.rows.length === 0) break;
    page++;
  }

  return { rows: allRows, fetchedAt: new Date(), total: allRows.length };
}
