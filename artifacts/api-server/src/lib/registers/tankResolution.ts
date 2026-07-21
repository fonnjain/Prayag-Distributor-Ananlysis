// Canonical tank size map and resolution logic for WATER TANK group rows.
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS THE SINGLE SOURCE OF TRUTH for per-tank litres by code suffix.
// All code must import from here. Never define a local copy.
//
// The problem:
//   The live SALE SHEET stores tank quantities as TOTAL LITRES, not pieces.
//   The loader must translate: qty = pieces, qty_ltr = total litres.
//
// The one rule (eliminates all ambiguity):
//   For WATER TANK group rows, the sheet quantity is ALWAYS total litres.
//   Pieces are ALWAYS derived (SAP if available, else exact integer division).
//   qty_ltr is ALWAYS the litre figure.
//   If a future sheet starts storing pieces instead of litres, the ingest
//   assertion (assertTankQtyLtr) will fire — fail loudly, never absorb silently.
//
// Two resolution routes, chosen per row:
//   Route 1 — SAP available: qty = SAP QUANTITY (pieces), qty_ltr = qty × perTankLitres
//   Route 2 — SAP not available: qty = sheetLitres / perTankLitres (exact integer only)
//
// Non-tank rows and accessory codes (unmapped suffix) pass through untouched.

import { listSheetTabs, readTabRowsChunked } from "./sheetsApi.js";

// ── Canonical size map ────────────────────────────────────────────────────────
// Maps the two-digit suffix of a WT/WCT code to its per-tank capacity in litres.
//
// "01" is intentionally absent: WT-001 = "PLASTIC LIDS HEAVY" (lid accessory,
// confirmed from SAP description). Lid qty is already pieces; qty_ltr stays NULL.
// If a new size code appears with an unmapped suffix, ingest will flag it rather
// than silently absorbing the wrong unit.
export const TANK_SIZE_MAP: Record<string, number> = {
  "02": 200,
  "03": 300,   // confirmed: 1800/300=6; map previously had 1500 (wrong, now fixed)
  "05": 500,
  "07": 750,
  "10": 1000,
  "15": 1500,
  "20": 2000,
  "25": 2500,
  "30": 3000,
  "50": 5000,
};

// Returns per-tank litre capacity for a WT/WCT code suffix, or null for
// accessories (WT-001 lids) and codes with unrecognized suffixes.
export function tankLitresFromCode(code: string): number | null {
  const m = code.match(/-(\d{2})$/);
  if (!m) return null;
  return TANK_SIZE_MAP[m[1]] ?? null;
}

// Generates the SQL VALUES clause from the canonical map.
// Usage in raw SQL CTEs:
//   SELECT suffix, ltr FROM (VALUES ${tankSizeMapSql()}) AS t(suffix, ltr)
export function tankSizeMapSql(): string {
  return Object.entries(TANK_SIZE_MAP)
    .map(([suffix, litres]) => `('${suffix}',${litres})`)
    .join(",");
}

// ── Resolution types ──────────────────────────────────────────────────────────

export type TankResolveFlag =
  | "route1-sap"           // qty = SAP pieces; qty_ltr = qty × perTankLitres
  | "route2-division"      // qty = sheetLitres / perTankLitres (exact integer)
  | "sap-ghost"            // SAP configured + invoice present but no match; provisional via division
  | "non-clean-division"   // sheetLitres % perTankLitres ≠ 0; qty = NULL, qty_ltr = sheetLitres
  | "unmapped-suffix"      // suffix not in TANK_SIZE_MAP (accessory); row left untouched
  | "non-tank-group";      // GROUP ≠ WATER TANK; row left untouched

export type TankResolveResult = {
  qty: string | null;       // pieces, or original sheet value for non-tank / unmapped
  qtyLtr: string | null;    // litres, or NULL for non-tank / unmapped / non-clean (no litres)
  flag: TankResolveFlag;
  perTankLitres: number | null;
  sheetQty: number | null;  // raw qty from sheet (litres for tanks, pieces for accessories)
  sapQty: number | null;    // SAP QUANTITY column (actual integer from SAP sheet) if Route 1; null otherwise
  sapAmt: number | null;    // SAP TAXABLEAMOUNT column for the matched entry; proves which SAP row was selected
};

// ── SAP lookup map ────────────────────────────────────────────────────────────

export type SapEntry = { sapQty: number; sapAmt: number };

// Key: `${INVOICENO}|${CODE}` — both normalised (trimmed + uppercased).
// Value: list of {sapQty, sapAmt} for that invoice + code combination.
// Multiple entries occur when the same invoice has the same code in multiple colours.
export type SapLookupMap = Map<string, SapEntry[]>;

// ── Resolution logic ──────────────────────────────────────────────────────────

// Canonical group name for water tanks — must match the key in group_map.json.
const WATER_TANK_CANON = "WATER TANK";

// Amount tolerance for SAP matching: ≤ Rs.5 difference is a match.
const SAP_AMT_TOLERANCE = 5;

export function resolveWaterTankRow(opts: {
  code: string;
  groupCanon: string | null;
  sheetQty: number | null;
  invoiceNo: string | null;
  amount: number;
  sapLookup: SapLookupMap | null;
  hasSapSource: boolean;
}): TankResolveResult {
  const { code, groupCanon, sheetQty, invoiceNo, amount, sapLookup, hasSapSource } = opts;

  // Non-WATER-TANK group: pass through completely untouched.
  if (groupCanon !== WATER_TANK_CANON) {
    return {
      qty: sheetQty != null ? String(sheetQty) : null,
      qtyLtr: null,
      flag: "non-tank-group",
      perTankLitres: null,
      sheetQty,
      sapQty: null,
      sapAmt: null,
    };
  }

  const perTankLitres = tankLitresFromCode(code);

  // Unmapped suffix (e.g. WT-001 lids): pass through untouched.
  // qty is already in pieces for these codes; qty_ltr stays NULL.
  if (perTankLitres == null) {
    return {
      qty: sheetQty != null ? String(sheetQty) : null,
      qtyLtr: null,
      flag: "unmapped-suffix",
      perTankLitres: null,
      sheetQty,
      sapQty: null,
      sapAmt: null,
    };
  }

  const sheetLitres = sheetQty;

  // Route 1: SAP lookup available and invoice_no present.
  if (sapLookup != null && invoiceNo != null && invoiceNo.trim() !== "") {
    const sapKey = `${invoiceNo.trim().toUpperCase()}|${code.trim().toUpperCase()}`;
    const entries = sapLookup.get(sapKey);
    if (entries && entries.length > 0) {
      // Pick the entry whose amount is closest to the register amount, within tolerance.
      let best: SapEntry | null = null;
      let bestDiff = Infinity;
      for (const entry of entries) {
        const diff = Math.abs(entry.sapAmt - amount);
        if (diff <= SAP_AMT_TOLERANCE && diff < bestDiff) {
          best = entry;
          bestDiff = diff;
        }
      }
      if (best != null) {
        const sapQty = best.sapQty;
        return {
          qty: String(sapQty),
          qtyLtr: String(sapQty * perTankLitres),
          flag: "route1-sap",
          perTankLitres,
          sheetQty,
          sapQty,
          sapAmt: best.sapAmt,
        };
      }
    }

    // Invoice present and SAP loaded, but no match found within tolerance.
    // This is a SAP ghost: the invoice hasn't landed in SAP yet (timing lag)
    // or is a genuine mismatch. Fall through to division as provisional, but flag it.
    if (hasSapSource) {
      return resolveByDivision(sheetLitres, perTankLitres, "sap-ghost");
    }
  }

  // Route 2: no SAP source for this FY, or no invoice_no on the row.
  return resolveByDivision(sheetLitres, perTankLitres, "route2-division");
}

function resolveByDivision(
  sheetLitres: number | null,
  perTankLitres: number,
  divisionFlag: "route2-division" | "sap-ghost",
): TankResolveResult {
  if (sheetLitres == null) {
    return {
      qty: null,
      qtyLtr: null,
      flag: divisionFlag,
      perTankLitres,
      sheetQty: null,
      sapQty: null,
      sapAmt: null,
    };
  }

  // Clean integer division → derive piece count.
  if (Number.isInteger(sheetLitres / perTankLitres)) {
    const pieces = sheetLitres / perTankLitres;
    return {
      qty: String(pieces),
      qtyLtr: String(sheetLitres),
      flag: divisionFlag,
      perTankLitres,
      sheetQty: sheetLitres,
      sapQty: null,
      sapAmt: null,
    };
  }

  // Non-clean division: cannot derive a reliable piece count.
  // Store the sheet litres in qty_ltr; leave qty NULL; caller must log/flag for review.
  return {
    qty: null,
    qtyLtr: String(sheetLitres),
    flag: "non-clean-division",
    perTankLitres,
    sheetQty: sheetLitres,
    sapQty: null,
    sapAmt: null,
  };
}

// ── SAP lookup builder ────────────────────────────────────────────────────────
// Reads the SAP Combined tab for a FY and returns an in-memory lookup map.
// Reuses the same header-detection logic as the Tier A fix routes.
export async function buildSapLookupMap(sapId: string): Promise<SapLookupMap> {
  const normH = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toUpperCase();
  const strV = (v: unknown) => String(v ?? "").trim();
  const numV = (v: unknown) => {
    const n = parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : 0;
  };

  const tabs = await listSheetTabs(sapId);
  const combined = tabs.find((t) => t.title.toLowerCase().includes("combined"));
  if (!combined) {
    throw new Error(`buildSapLookupMap: no Combined tab in SAP source ${sapId}`);
  }

  let invIdx = -1, codeIdx = -1, qtyIdx = -1, amtIdx = -1;
  let headerFound = false;
  const map: SapLookupMap = new Map();

  await readTabRowsChunked(sapId, combined.title, (chunk, startRow) => {
    for (let ri = 0; ri < chunk.length; ri++) {
      const row = chunk[ri];
      const globalRow = startRow + ri;

      if (!headerFound) {
        if (globalRow > 30) continue;
        const hd = row.map(normH);
        const qI = ["QTY", "QUANTITY", "BILLQTY", "BILLINGQTY"]
          .reduce((b: number, a) => (b >= 0 ? b : hd.indexOf(a)), -1);
        const aI = ["TAXABLEAMOUNT", "TAXABLEVALUE", "TAXABLE", "NETVALUE", "AMOUNT"]
          .reduce((b: number, a) => (b >= 0 ? b : hd.indexOf(a)), -1);
        if (qI >= 0 && aI >= 0) {
          qtyIdx = qI;
          amtIdx = aI;
          invIdx = [
            "DOCUMENTNUMBER", "INVOICENO", "INVOICENUMBER",
            "BILLINGDOCUMENT", "DOCUMENTNO", "BILLNO",
          ].reduce((b: number, a) => (b >= 0 ? b : hd.indexOf(a)), -1);
          codeIdx = [
            "OLDITEMCODE", "ITEMCODE", "CODE", "MATERIAL", "MATERIALCODE", "PRODUCTCODE",
          ].reduce((b: number, a) => (b >= 0 ? b : hd.indexOf(a)), -1);
          headerFound = true;
        }
        continue;
      }

      if (invIdx < 0 || codeIdx < 0) continue;
      const inv = strV(row[invIdx]).toUpperCase();
      const code = strV(row[codeIdx]).toUpperCase();
      if (!inv || !code) continue;

      const key = `${inv}|${code}`;
      const entry: SapEntry = { sapQty: numV(row[qtyIdx]), sapAmt: numV(row[amtIdx]) };
      const existing = map.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(key, [entry]);
      }
    }
  });

  if (!headerFound) {
    throw new Error(
      `buildSapLookupMap: header not found in Combined tab of SAP source ${sapId}. ` +
        `Tab title: "${combined.title}". Check that the tab has QUANTITY and TAXABLEAMOUNT columns.`,
    );
  }

  return map;
}

// ── Ingest assertion ──────────────────────────────────────────────────────────
// After resolving a tank row, verify qty × perTankLitres === qty_ltr.
// Returns null on pass, or a failure description on fail.
// Only applies to sized-tank flags (route1-sap, route2-division, sap-ghost).
// sap-ghost is provisional but still verifiable.
export function assertTankQtyLtr(resolved: TankResolveResult): string | null {
  const { flag, perTankLitres, qty, qtyLtr } = resolved;
  if (flag === "non-tank-group" || flag === "unmapped-suffix" || flag === "non-clean-division") {
    return null;
  }
  if (perTankLitres == null) return null;
  const q = qty != null ? parseFloat(qty) : null;
  const ltr = qtyLtr != null ? parseFloat(qtyLtr) : null;
  if (q == null || ltr == null) return "qty or qty_ltr is null after resolution";
  if (Math.round(q * perTankLitres) !== Math.round(ltr)) {
    return `${q} × ${perTankLitres} = ${q * perTankLitres} ≠ ${ltr}`;
  }
  return null;
}
