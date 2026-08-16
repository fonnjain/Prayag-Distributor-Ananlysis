// Red Alert — pre-fetch all DB data needed for detection.
// Called once; the result is shared across both calibration periods.

import type {
  DbPool,
  DetectionContext,
  CustomerSaleRow,
  CustomerCodeRow,
  CustomerMetaRow,
  RetailerSaleRow,
  RetailerSkuRow,
  SecHeadMonthRow,
  MrpHistoryRow,
  MarginFactRow,
  PersonRow,
  CustomerMasterRow,
} from "./types.js";
import { normSecKey } from "../mgmt/names.js";

export async function buildDetectionContext(pool: DbPool, fys: string[]): Promise<DetectionContext> {
  // We need 3 FYs of sale data: prior-prior, prior, current — for "sustained" checks.
  // Derive all needed FYs from the requested set.
  const allFys = new Set<string>();
  for (const fy of fys) {
    allFys.add(fy);
    allFys.add(prevFy(fy));
    allFys.add(prevFy(prevFy(fy)));
  }
  const fyList = [...allFys];
  const fyArr = `ARRAY[${fyList.map((_, i) => `$${i + 1}`).join(",")}]::text[]`;
  const fyParams = fyList;

  // Secondary FYs (secondary may lag by 1 FY behind primary in SKU data)
  const secFys = new Set<string>();
  for (const fy of fys) { secFys.add(fy); secFys.add(prevFy(fy)); secFys.add(prevFy(prevFy(fy))); }
  const secFyList = [...secFys];
  const secFyArr = `ARRAY[${secFyList.map((_, i) => `$${i + 1}`).join(",")}]::text[]`;

  const [
    saleRes,
    metaRes,
    codeRes,
    secHeadRes,
    mrpHistRes,
    mrpMasterRes,
    marginRes,
    personRes,
    custMasterRes,
    retailDistRes,
    frozenRes,
    secCompleteRes,
    retailerSaleRes,
    retailerSkuRes,
    retailerPrimaryDistRes,
    distSecMonthlyRes,
  ] = await Promise.all([
    // 1a. Customer sale aggregates — territory rows by fy/month/customer/group
    pool.query<{
      fy: string; month_label: string; customer: string;
      head_canon: string | null; state_canon: string | null;
      channel: string | null; group_canon: string | null;
      val: string; qty: string;
    }>(
      `SELECT fy, month_label, customer,
              head_canon, state_canon, channel, group_canon,
              SUM(amount)::float8::text AS val,
              COALESCE(SUM(qty),0)::float8::text AS qty
         FROM sale_line_current
        WHERE fy = ANY(${fyArr}) AND is_territory = true
          AND customer IS NOT NULL
        GROUP BY fy, month_label, customer, head_canon, state_canon, channel, group_canon`,
      fyParams,
    ),

    // 1b. Unfiltered channel/head metadata (NO is_territory filter) — Guard 1 only.
    // Customers reclassified to Project/Govt/non-territory vanish from 1a; this
    // separate query keeps them visible so Guard 1 can detect the reclassification.
    pool.query<{
      fy: string; month_label: string; customer: string;
      channel: string | null; head_canon: string | null;
    }>(
      `SELECT fy, month_label, customer, channel, head_canon
         FROM sale_line_current
        WHERE fy = ANY(${fyArr}) AND customer IS NOT NULL
        GROUP BY fy, month_label, customer, channel, head_canon`,
      fyParams,
    ),

    // 2. Customer item-code level (for MRP index, B5 code count, B4 segment)
    pool.query<{
      fy: string; month_label: string; customer: string;
      code: string; group_canon: string | null;
      qty: string; val: string; avg_rate: string | null;
    }>(
      `SELECT fy, month_label, customer, code,
              group_canon,
              COALESCE(SUM(qty),0)::float8::text AS qty,
              SUM(amount)::float8::text AS val,
              (SUM(amount)/NULLIF(SUM(qty),0))::float8::text AS avg_rate
         FROM sale_line_current
        WHERE fy = ANY(${fyArr}) AND is_territory = true
          AND customer IS NOT NULL AND code IS NOT NULL
        GROUP BY fy, month_label, customer, code, group_canon`,
      fyParams,
    ),

    // 3. Secondary head-month rows
    pool.query<{
      fy: string; head_canon: string; state_head: string | null;
      month_label: string; month_idx: string;
      plan_amount: string | null; ordered_amount: string | null;
      received_amount: string | null; not_yet_recorded: boolean;
      is_anomaly: boolean; ingested_at: Date | null;
    }>(
      `SELECT fy, head_canon, state_head, month_label, month_idx,
              plan_amount::float8::text,
              ordered_amount::float8::text,
              received_amount::float8::text,
              not_yet_recorded, is_anomaly, ingested_at
         FROM secondary_head_month
        WHERE fy = ANY(${secFyArr})`,
      secFyList,
    ),

    // 4. MRP history
    pool.query<{
      item_code: string; segment: string; mrp: string;
      effective_from: string; effective_to: string | null; is_current: boolean;
    }>(
      `SELECT item_code, segment, mrp::float8::text,
              effective_from::text, effective_to::text, is_current
         FROM mrp_history`,
      [],
    ),

    // 5. Ambiguous codes from mrp_master
    pool.query<{ item_code: string }>(
      `SELECT DISTINCT item_code FROM mrp_master WHERE is_ambiguous_code = true`,
      [],
    ),

    // 6. Margin fact (C4) — only rows with bom_cost
    pool.query<{
      fy: string; month_label: string; item_code: string; segment: string;
      qty: string; sale_value: string; bom_cost: string | null; avg_sale: string | null;
    }>(
      `SELECT fy, month_label, item_code, segment,
              COALESCE(qty,0)::float8::text AS qty,
              COALESCE(sale_value,0)::float8::text AS sale_value,
              bom_cost::float8::text,
              avg_sale::float8::text
         FROM margin_fact
        WHERE fy = ANY(${fyArr})`,
      fyParams,
    ),

    // 7. Person registry
    pool.query<{
      norm_key: string; canonical_name: string;
      state_head: string | null; is_state_head: boolean;
      hr_status: string | null; is_person: boolean;
    }>(
      `SELECT norm_key, canonical_name, state_head, is_state_head, hr_status, is_person
         FROM person_registry`,
      [],
    ),

    // 8. Customer master (entity type)
    pool.query<{ id: string; company: string; entity_type: string | null; state_head: string | null }>(
      `SELECT id, company, entity_type, state_head FROM customer_master`,
      [],
    ),

    // 9. Retailer-distributor mapping per month (for Guard 5).
    // month_label is preserved so guards compare only within the alert's window,
    // not across the full FY — a reassignment outside the window must not suppress
    // a valid within-window B3.
    pool.query<{ fy: string; month_label: string; retailer: string; distributor: string }>(
      `SELECT fy, month_label, retailer, distributor
         FROM secondary_sku_line
        WHERE fy = ANY(${secFyArr})
          AND retailer IS NOT NULL AND distributor IS NOT NULL
        GROUP BY fy, month_label, retailer, distributor`,
      secFyList,
    ),

    // 10. Frozen months (complete primary months — Guard 3)
    pool.query<{ fy: string; month_label: string }>(
      `SELECT fy, month_label FROM register_month_state WHERE frozen_at IS NOT NULL`,
      [],
    ),

    // 11. Secondary complete months per head per FY (for Guard 9 + A-engine completeness)
    pool.query<{ fy: string; head_canon: string; month_label: string }>(
      `SELECT fy, head_canon, month_label
         FROM secondary_head_month
        WHERE fy = ANY(${secFyArr}) AND not_yet_recorded = false`,
      secFyList,
    ),

    // 12. Retailer sale aggregates from secondary_sku_line — authoritative for B1–B5.
    // Retailers are not represented in sale_line_current (primary dispatch); their
    // sell-out transactions live only in secondary_sku_line.
    pool.query<{ fy: string; month_label: string; retailer: string; val: string }>(
      `SELECT fy, month_label, retailer, SUM(net_amount)::float8::text AS val
         FROM secondary_sku_line
        WHERE fy = ANY(${secFyArr}) AND retailer IS NOT NULL
        GROUP BY fy, month_label, retailer`,
      secFyList,
    ),

    // 13. Retailer SKU aggregates (for B4 segment dropout, B5 code breadth).
    pool.query<{
      fy: string; month_label: string; retailer: string;
      item_code: string; segment_canon: string | null; val: string;
    }>(
      `SELECT fy, month_label, retailer, item_code, segment_canon,
              SUM(net_amount)::float8::text AS val
         FROM secondary_sku_line
        WHERE fy = ANY(${secFyArr}) AND retailer IS NOT NULL AND item_code IS NOT NULL
        GROUP BY fy, month_label, retailer, item_code, segment_canon`,
      secFyList,
    ),

    // 14. Primary distributor per retailer per FY — for B3 rollup.
    // DISTINCT ON picks the highest-value distributor for each (fy, retailer) pair.
    pool.query<{ fy: string; retailer: string; distributor: string }>(
      `SELECT DISTINCT ON (fy, retailer)
              fy, retailer, distributor
         FROM secondary_sku_line
        WHERE fy = ANY(${secFyArr})
          AND retailer IS NOT NULL AND distributor IS NOT NULL
        GROUP BY fy, retailer, distributor
        ORDER BY fy, retailer, SUM(net_amount) DESC`,
      secFyList,
    ),

    // 15. Distributor monthly secondary sell-through — for S1 destocking.
    pool.query<{ fy: string; month_label: string; distributor: string; val: string }>(
      `SELECT fy, month_label, distributor, SUM(net_amount)::float8::text AS val
         FROM secondary_sku_line
        WHERE fy = ANY(${secFyArr}) AND distributor IS NOT NULL
        GROUP BY fy, month_label, distributor`,
      secFyList,
    ),
  ]);

  // ── Build typed arrays ──────────────────────────────────────────────────────

  const customerSale: CustomerSaleRow[] = saleRes.rows.map((r) => ({
    fy: r.fy,
    monthLabel: r.month_label,
    customer: r.customer,
    headCanon: r.head_canon,
    stateCanon: r.state_canon,
    channel: r.channel,
    groupCanon: r.group_canon,
    value: Number(r.val),
    qty: Number(r.qty),
  }));

  const customerMeta: CustomerMetaRow[] = metaRes.rows.map((r) => ({
    fy: r.fy,
    monthLabel: r.month_label,
    customer: r.customer,
    channel: r.channel,
    headCanon: r.head_canon,
  }));

  const customerCode: CustomerCodeRow[] = codeRes.rows.map((r) => ({
    fy: r.fy,
    monthLabel: r.month_label,
    customer: r.customer,
    code: r.code,
    groupCanon: r.group_canon,
    qty: Number(r.qty),
    value: Number(r.val),
    avgRate: r.avg_rate != null ? Number(r.avg_rate) : null,
  }));

  const secHeadMonths: SecHeadMonthRow[] = secHeadRes.rows.map((r) => ({
    fy: r.fy,
    headCanon: r.head_canon,
    stateHead: r.state_head,
    monthLabel: r.month_label,
    monthIdx: Number(r.month_idx),
    planAmount: r.plan_amount != null ? Number(r.plan_amount) : null,
    orderedAmount: r.ordered_amount != null ? Number(r.ordered_amount) : null,
    receivedAmount: r.received_amount != null ? Number(r.received_amount) : null,
    notYetRecorded: r.not_yet_recorded,
    isAnomaly: r.is_anomaly,
    ingestedAt: r.ingested_at,
  }));

  const mrpHistory: MrpHistoryRow[] = mrpHistRes.rows.map((r) => ({
    itemCode: r.item_code,
    segment: r.segment,
    mrp: Number(r.mrp),
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    isCurrent: r.is_current,
  }));

  const ambiguousCodes = new Set(mrpMasterRes.rows.map((r) => r.item_code));

  const marginFact: MarginFactRow[] = marginRes.rows.map((r) => ({
    fy: r.fy,
    monthLabel: r.month_label,
    itemCode: r.item_code,
    segment: r.segment,
    qty: Number(r.qty),
    saleValue: Number(r.sale_value),
    bomCost: r.bom_cost != null ? Number(r.bom_cost) : null,
    avgSale: r.avg_sale != null ? Number(r.avg_sale) : null,
  }));

  const persons: PersonRow[] = personRes.rows.map((r) => ({
    normKey: r.norm_key,
    canonicalName: r.canonical_name,
    stateHead: r.state_head,
    isStateHead: r.is_state_head,
    hrStatus: r.hr_status,
    isPerson: r.is_person,
  }));

  // Build a secondary lookup set for Guard 4.
  //
  // secondary_head_month.head_canon is written by the register ingest pipeline
  // using normSecKey(memberName): lowercase alphanumerics only, no spaces or
  // punctuation (src/lib/mgmt/names.ts).  person_registry.norm_key is either:
  //   (a) a numeric employee code ("788", "1001"), or
  //   (b) a collision-disambiguation string "basename:stateheadname"
  //       where basename = normSecKey(memberName).
  //
  // Guard 4 receives entityKey = head_canon.  It will never equal a numeric
  // employee code or a full collision key, so we need a secondary set indexed
  // by normSecKey(canonicalName) — which equals the base part of (b) and the
  // value that the pipeline would store as head_canon for (a).
  //
  // Using the shared normSecKey helper keeps this in sync with the pipeline.
  const personsByNameKey = new Set<string>();
  for (const p of persons) {
    if (!p.isPerson) continue;
    if (p.normKey.includes(":")) {
      // Collision-disambiguation format: "ashutoshkumarrudrapur:anantsingh"
      // The base part before ":" IS the head_canon key; extract it directly.
      const baseName = p.normKey.split(":")[0]!;
      if (baseName) personsByNameKey.add(baseName);
    } else {
      // Numeric employee-code format (e.g. "788") or a bare name key.
      // Derive the head_canon-equivalent key via normSecKey — the same function
      // the register pipeline uses when writing head_canon, so names with
      // parentheses ("Ashutosh Kumar (Rudrapur)"), hyphens, apostrophes, etc.
      // normalise identically in both directions.
      const nameKey = normSecKey(p.canonicalName);
      if (nameKey) personsByNameKey.add(nameKey);
    }
  }

  // Build customer master map keyed by UPPER(TRIM(company))
  const customerMaster = new Map<string, CustomerMasterRow>();
  for (const r of custMasterRes.rows) {
    customerMaster.set(r.company.toUpperCase().trim(), {
      id: r.id,
      company: r.company,
      entityType: r.entity_type,
      stateHead: r.state_head,
    });
  }

  const retailerSale: RetailerSaleRow[] = retailerSaleRes.rows.map((r) => ({
    fy: r.fy,
    monthLabel: r.month_label,
    retailer: r.retailer,
    value: Number(r.val),
  }));

  const retailerSku: RetailerSkuRow[] = retailerSkuRes.rows.map((r) => ({
    fy: r.fy,
    monthLabel: r.month_label,
    retailer: r.retailer,
    itemCode: r.item_code,
    segmentCanon: r.segment_canon,
    value: Number(r.val),
  }));

  // Build retailerPrimaryDist: fy → retailer → primary_distributor
  const retailerPrimaryDist = new Map<string, Map<string, string>>();
  for (const r of retailerPrimaryDistRes.rows) {
    if (!retailerPrimaryDist.has(r.fy)) retailerPrimaryDist.set(r.fy, new Map());
    retailerPrimaryDist.get(r.fy)!.set(r.retailer, r.distributor);
  }

  // Build distSecMonthly: `${distributor}|${fy}|${monthLabel}` → net_amount
  const distSecMonthly = new Map<string, number>();
  for (const r of distSecMonthlyRes.rows) {
    distSecMonthly.set(`${r.distributor}|${r.fy}|${r.month_label}`, Number(r.val));
  }

  // Build headToStateHead: LOWER(canonical_name) → state_head (from person_registry)
  const headToStateHead = new Map<string, string | null>();
  for (const p of persons) {
    headToStateHead.set(p.canonicalName.toLowerCase(), p.stateHead);
  }

  // ── Query 16: retailer → head_canon (for C6 territorial concentration) ────────
  // Highest-value transaction's head_canon for each (fy, retailer) pair.
  // Uses the same secondary FY list as other retailer queries.
  const retailerHeadRes = await pool.query<{ fy: string; retailer: string; head_canon: string }>(
    `SELECT DISTINCT ON (fy, retailer)
            fy, retailer, head_canon
       FROM secondary_sku_line
      WHERE fy = ANY(${secFyArr})
        AND retailer IS NOT NULL AND head_canon IS NOT NULL
      ORDER BY fy, retailer, net_amount DESC`,
    secFyList,
  );

  const retailerHeadCanon = new Map<string, Map<string, string>>();
  for (const r of retailerHeadRes.rows) {
    if (!retailerHeadCanon.has(r.fy)) retailerHeadCanon.set(r.fy, new Map());
    retailerHeadCanon.get(r.fy)!.set(r.retailer, r.head_canon);
  }

  // Build retailer → `${fy}|${monthLabel}` → Set<distributor>
  // Month-level granularity so Guard 5 can compare only within the alert window.
  const retailerDistributors = new Map<string, Map<string, Set<string>>>();
  for (const r of retailDistRes.rows) {
    if (!retailerDistributors.has(r.retailer)) retailerDistributors.set(r.retailer, new Map());
    const monthMap = retailerDistributors.get(r.retailer)!;
    const key = `${r.fy}|${r.month_label}`;
    if (!monthMap.has(key)) monthMap.set(key, new Set());
    monthMap.get(key)!.add(r.distributor);
  }

  // Build frozen months: fy → Set<monthLabel>
  const frozenMonths = new Map<string, Set<string>>();
  for (const r of frozenRes.rows) {
    if (!frozenMonths.has(r.fy)) frozenMonths.set(r.fy, new Set());
    frozenMonths.get(r.fy)!.add(r.month_label);
  }

  // Build secondary complete months: fy → headCanon → string[]
  const secCompleteMonths = new Map<string, Map<string, string[]>>();
  for (const r of secCompleteRes.rows) {
    if (!secCompleteMonths.has(r.fy)) secCompleteMonths.set(r.fy, new Map());
    const hMap = secCompleteMonths.get(r.fy)!;
    if (!hMap.has(r.head_canon)) hMap.set(r.head_canon, []);
    hMap.get(r.head_canon)!.push(r.month_label);
  }

  // Build last sheet read per member
  const lastSheetRead = new Map<string, Date>();
  for (const r of secHeadMonths) {
    if (r.ingestedAt == null) continue;
    const prev = lastSheetRead.get(r.headCanon);
    if (prev == null || r.ingestedAt > prev) lastSheetRead.set(r.headCanon, r.ingestedAt);
  }

  return {
    pool,
    customerSale,
    customerMeta,
    customerCode,
    retailerSale,
    retailerSku,
    secHeadMonths,
    mrpHistory,
    ambiguousCodes,
    marginFact,
    persons,
    customerMaster,
    retailerDistributors,
    frozenMonths,
    secCompleteMonths,
    lastSheetRead,
    personsByNameKey,
    retailerPrimaryDist,
    distSecMonthly,
    headToStateHead,
    retailerHeadCanon,
  };
}

// "2026-27" → "2025-26"
function prevFy(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10);
  return `${start - 1}-${String(start % 100).padStart(2, "0")}`;
}
