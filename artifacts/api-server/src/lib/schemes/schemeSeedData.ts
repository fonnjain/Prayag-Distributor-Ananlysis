// Q2 FY2026-27 Scheme seed data.
//
// Parsed from attached_assets/QTR._2_Schemes_Summary_1786446995201.xlsx.
// The load route POST /api/admin/schemes/load truncates and re-inserts all
// tables from this module — idempotent.
//
// AMBIGUOUS SLABS (needs_clarification):
//   PTMT_CP_AP_TEL / PTMT_CP_WB — Rs.15,00,000 & Above
//   ANNUAL_WB — Rs.25 Lac–Rs.49.99 Lac
// These have rate=null and are excluded from nudge/Extra Earn/achievement.
//
// NETT BILLING: stored in special_pricing, not scheme tables.

export interface TerritoryGroupRow {
  groupRaw: string;
  label: string;
  states: string[];
}

export interface SchemeRow {
  schemeId: string;
  name: string;
  audience: string[];
  settlement: string;
  qualificationBasis: string;
  territoryGroup: string | null;
  productScope: string | null;
  periodFrom: string;
  periodTo: string | null;
  periodNote: string | null;
  audienceSourceTerm: string | null;
  fundingNote: string | null;
}

export interface SchemeSlabRow {
  schemeId: string;
  slabOrder: number;
  thresholdFrom: string;
  thresholdTo: string | null;
  unit: string;
  rate: string | null;
  altReward: string | null;
  freeGoods: string | null;
  rewardStatus: string;
  rawText: string | null;
}

export interface SchemeItemGroupRow {
  itemGroup: string;
  schemeId: string;
}

export interface SpecialPricingRow {
  customerName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  rateRows: object;
}

// ── Territory Groups ──────────────────────────────────────────────────────────

export const TERRITORY_GROUPS: TerritoryGroupRow[] = [
  {
    groupRaw: "Delhi/ NCR/ W.UP/ UK/ RAJ/ HR/PB/ HP/ GUJRAT/ MAH (Mr. Lalan)",
    label: "Lalan Territory (CP/PTMT)",
    states: ["Delhi", "NCR", "WUP", "UK", "RAJ", "HR", "PB", "HP", "GUJ", "MAH-Lalan"],
  },
  {
    groupRaw: "E.UP/MP/CHTS/MAH (WAHID MKT.)",
    label: "Wahid Territory — CP variant",
    states: ["EUP", "MP", "CHTS", "MAH-Wahid"],
  },
  {
    groupRaw: "E.UP/CHTS/MP/MAH (WAHID MKT.)",
    label: "Wahid Territory — PTMT variant",
    states: ["EUP", "CHTS", "MP", "MAH-Wahid"],
  },
  {
    groupRaw: "KERALA/KARNATAKA",
    label: "Kerala / Karnataka",
    states: ["KERALA", "KARNATAKA"],
  },
  {
    groupRaw: "KERALA & KARNATAKA",
    label: "Kerala & Karnataka (Single Bill Qty)",
    states: ["KERALA", "KARNATAKA"],
  },
  {
    groupRaw: "A.P. AND TELENGANA",
    label: "AP and Telangana",
    states: ["AP", "TELANGANA"],
  },
  {
    groupRaw: "W.B./BIHAR/JHARKHAND/ORISSA/NE",
    label: "WB / Bihar / Jharkhand / Orissa / NE",
    states: ["WB", "BIHAR", "JHARKHAND", "ORISSA", "NE"],
  },
  {
    groupRaw: "WB/ORISSA/NE/BIHAR/JHARKHAND",
    label: "WB / Orissa / NE / Bihar / Jharkhand (Annual)",
    states: ["WB", "ORISSA", "NE", "BIHAR", "JHARKHAND"],
  },
  {
    groupRaw: "All States",
    label: "All States",
    states: ["ALL"],
  },
  {
    groupRaw: "All States Except KERALA/KARNATAKA/TN/AP",
    label: "All States Except KL/KA/TN/AP",
    states: ["ALL_EXCEPT_KL_KA_TN_AP"],
  },
  {
    groupRaw: "BIHAR/JHARKHAND",
    label: "Bihar / Jharkhand",
    states: ["BIHAR", "JHARKHAND"],
  },
  {
    groupRaw: "ORISSA/NE/W.B./AP/TEL",
    label: "Orissa / NE / WB / AP / Telangana",
    states: ["ORISSA", "NE", "WB", "AP", "TEL"],
  },
  {
    groupRaw: "DEL/W.UP/UK/PB/HR/HP/RAJ/J&K/GUJ/MAH (Mr. Lalan)",
    label: "Lalan Territory (Free Qty PVC)",
    states: ["Delhi", "WUP", "UK", "PB", "HR", "HP", "RAJ", "JK", "GUJ", "MAH-Lalan"],
  },
  {
    groupRaw: "E.UP/MP/CHTS/WAHID MKT., NAGPUR",
    label: "Wahid Territory (Free Qty PVC)",
    states: ["EUP", "MP", "CHTS", "NAGPUR"],
  },
  {
    groupRaw: "KARNATAKA",
    label: "Karnataka only",
    states: ["KARNATAKA"],
  },
];

// ── Schemes ───────────────────────────────────────────────────────────────────

export const SCHEMES: SchemeRow[] = [
  // ── CP quarterly schemes (3 territory groups) ─────────────────────────────
  {
    schemeId: "CP_LALAN",
    name: "Quarterly CP/Sink/Sanitaryware — Lalan Territory",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "Delhi/ NCR/ W.UP/ UK/ RAJ/ HR/PB/ HP/ GUJRAT/ MAH (Mr. Lalan)",
    productScope: "CP (All Series) / SINK & SANITARYWARE",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },
  {
    schemeId: "CP_KL_KA",
    name: "Quarterly CP/Sink — Kerala/Karnataka",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "KERALA/KARNATAKA",
    productScope: "CP BATH FITTINGS & SINK",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },
  {
    schemeId: "CP_WAHID",
    name: "Quarterly CP/Sink/Sanitaryware — Wahid Territory",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "E.UP/MP/CHTS/MAH (WAHID MKT.)",
    productScope: "CP (All Series) / SINK /SANITARYWARE",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },

  // ── PTMT quarterly schemes (3 territory groups) ───────────────────────────
  {
    schemeId: "PTMT_LALAN",
    name: "Quarterly PTMT/Connection/Waste Pipe — Lalan Territory",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "Delhi/ NCR/ W.UP/ UK/ RAJ/ HR/PB/ HP/ GUJRAT/ MAH (Mr. Lalan)",
    productScope: "PTMT/Connection/Waste Pipe & Inlet/Outlet Pipes",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },
  {
    schemeId: "PTMT_KL_KA",
    name: "Quarterly All PTMT Products — Kerala/Karnataka",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "KERALA/KARNATAKA",
    productScope: "ALL PTMT PRODUCTS INCLUDING CISTERN & SEAT COVERS & TEFLON TAPE",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },
  {
    schemeId: "PTMT_WAHID",
    name: "Quarterly PTMT/Connection/Waste Pipe — Wahid Territory",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "E.UP/CHTS/MP/MAH (WAHID MKT.)",
    productScope: "PTMT/Connection/Waste Pipe & Inlet/Outlet Pipes/Cistern & Seat Cover",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },

  // ── PTMT-CP combined quarterly schemes (2 territory groups) ───────────────
  {
    schemeId: "PTMT_CP_AP_TEL",
    name: "Quarterly PTMT+CP/Sink/Sanitaryware — AP & Telangana",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "A.P. AND TELENGANA",
    productScope: "On PTMT/Cistern/Seat Cover/CP/Sanitaryware/All Type of Sink",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },
  {
    schemeId: "PTMT_CP_WB",
    name: "Quarterly PTMT+CP/Sink/Sanitaryware — WB/Bihar/Jharkhand/Orissa/NE",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "W.B./BIHAR/JHARKHAND/ORISSA/NE",
    productScope: "On PTMT/Cistern/Seat Cover/CP/Sanitaryware/All Type of Sink",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "QUARTERLY SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },

  // ── Single Bill Quantity schemes ──────────────────────────────────────────
  {
    schemeId: "SBQ_SUPER_KL_KA",
    name: "Single Bill Qty PTMT & Tubes — Super Distributor (Kerala & Karnataka)",
    audience: ["super_distributor"],
    settlement: "company",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "KERALA & KARNATAKA",
    productScope: "PTMT & TUBES",
    periodFrom: "2026-08-01",
    periodTo: null,
    periodNote: "01-08-2026 Till further Change",
    audienceSourceTerm: "FOR SUPER DISTRIBUTOR",
    fundingNote: null,
  },
  {
    schemeId: "SBQ_DIST_KL_KA",
    name: "Single Bill Qty PTMT & Tubes — Distributor by Super Distributor (Kerala & Karnataka)",
    audience: ["distributor_by_super_distributor"],
    settlement: "pass_through",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "KERALA & KARNATAKA",
    productScope: "PTMT & TUBES",
    periodFrom: "2026-08-01",
    periodTo: null,
    periodNote: "01-08-2026 Till further Change",
    audienceSourceTerm: "FOR DISTRIBUTOR BY SUPER DISTRIBUTOR",
    fundingNote: null,
  },
  {
    schemeId: "SBQ_SUB_KA",
    name: "Single Bill Qty PTMT & Tubes — Sub-Dealer by Distributor (Karnataka)",
    audience: ["sub_dealer"],
    settlement: "pass_through",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "KARNATAKA",
    productScope: "PTMT & TUBES",
    periodFrom: "2026-08-01",
    periodTo: null,
    periodNote: "01-08-2026 Till further Change",
    audienceSourceTerm: "FOR SUB - DEALER BY DISTRIBUTOR",
    fundingNote: null,
  },

  // ── Single Bill Scheme (value-based, KL/KA, CP) ───────────────────────────
  {
    schemeId: "SB_CP_KL_KA",
    name: "Single Bill CP Bath Fittings & Sink — Kerala/Karnataka",
    audience: ["sub_dealer"],
    settlement: "company",
    qualificationBasis: "single_bill_value",
    territoryGroup: "KERALA/KARNATAKA",
    productScope: "CP BATH FITTINGS & SINK",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    periodNote: "01-07-2026 to 30-09-2026",
    audienceSourceTerm: "SINGLE BILL SCHEME FOR SUB- DEALERS",
    fundingNote: null,
  },

  // ── Mirror Cabinet ────────────────────────────────────────────────────────
  {
    schemeId: "MIRROR_CABINET",
    name: "Mirror Cabinets (All Varieties) — All States Except KL/KA/TN/AP",
    audience: ["distributor", "direct_dealer"],
    settlement: "company",
    qualificationBasis: "single_bill_value",
    territoryGroup: "All States Except KERALA/KARNATAKA/TN/AP",
    productScope: "Mirror Cabinets – All Varieties",
    periodFrom: "2026-07-28",
    periodTo: null,
    periodNote: "From 28-07-2026 onwards",
    audienceSourceTerm: "FOR DISTRIBUTORS/DIRECT DEALERS",
    fundingNote: null,
  },

  // ── PPR Free Scheme ───────────────────────────────────────────────────────
  {
    schemeId: "PPR_FREE",
    name: "Free Scheme on PPR Pipes & Fittings — All States",
    audience: ["distributor", "direct_dealer"],
    settlement: "primary",
    qualificationBasis: "single_bill_value",
    territoryGroup: "All States",
    productScope: "PPR Pipes & Fittings",
    periodFrom: "2026-07-01",
    periodTo: "2026-12-31",
    periodNote: "01-07-2026 to 31-12-2026",
    audienceSourceTerm: "Sub: Free Scheme on PPR Pipes & Fittings for Distributors/Direct Dealers",
    fundingNote: null,
  },

  // ── Free Quantity PVC Schemes (4 territory groups) ────────────────────────
  {
    schemeId: "PVC_FREE_LALAN",
    name: "Free Qty PVC Connection/Waste Pipe by Distributor — Lalan Territory",
    audience: ["sub_dealer"],
    settlement: "pass_through",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "DEL/W.UP/UK/PB/HR/HP/RAJ/J&K/GUJ/MAH (Mr. Lalan)",
    productScope: "ON PVC CONNECTION/ WASTE PIPE",
    periodFrom: "2026-07-27",
    periodTo: "2026-07-31",
    periodNote: "27-07-2026 TO 31-07-2026",
    audienceSourceTerm: "FREE QUANTITY SCHEME BY DISTRIBUTOR TO SUB – DEALERS",
    fundingNote: "TRADE DISCOUNT: PVC CONNECTION/WASTE PIPE 50%+4% Additional Discount; 8% Additional Discount in bill for free qty",
  },
  {
    schemeId: "PVC_FREE_WAHID",
    name: "Free Qty PVC Connection/Waste Pipe by Distributor — Wahid Territory",
    audience: ["sub_dealer"],
    settlement: "pass_through",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "E.UP/MP/CHTS/WAHID MKT., NAGPUR",
    productScope: "ON PVC CONNECTION/ WASTE PIPE",
    periodFrom: "2026-07-27",
    periodTo: "2026-07-31",
    periodNote: "27-07-2026 TO 31-07-2026",
    audienceSourceTerm: "FREE QUANTITY SCHEME BY DISTRIBUTOR TO SUB – DEALERS",
    fundingNote: "TRADE DISCOUNT: PVC CONNECTION/WASTE PIPE 50%+4% Additional Discount; 8% Additional Discount in bill for free qty",
  },
  {
    schemeId: "PVC_FREE_BIHAR_JH",
    name: "Free Qty PVC Connection/Waste Pipe by Distributor — Bihar/Jharkhand",
    audience: ["sub_dealer"],
    settlement: "pass_through",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "BIHAR/JHARKHAND",
    productScope: "ON PVC CONNECTION/ WASTE PIPE",
    periodFrom: "2026-07-27",
    periodTo: "2026-07-31",
    periodNote: "27-07-2026 TO 31-07-2026",
    audienceSourceTerm: "FREE QUANTITY SCHEME BY DISTRIBUTOR TO SUB – DEALERS",
    fundingNote: "TRADE DISCOUNT: PVC CONNECTION/WASTE PIPE 50%+12% Additional Discount",
  },
  {
    schemeId: "PVC_FREE_ORISSA",
    name: "Free Qty PVC Connection/Waste Pipe by Distributor — Orissa/NE/WB/AP/Tel",
    audience: ["sub_dealer"],
    settlement: "pass_through",
    qualificationBasis: "single_bill_quantity",
    territoryGroup: "ORISSA/NE/W.B./AP/TEL",
    productScope: "ON PVC CONNECTION/ WASTE PIPE",
    periodFrom: "2026-07-27",
    periodTo: "2026-07-31",
    periodNote: "27-07-2026 TO 31-07-2026",
    audienceSourceTerm: "FREE QUANTITY SCHEME BY DISTRIBUTOR TO SUB – DEALERS",
    fundingNote: "TRADE DISCOUNT: PVC CONNECTION/WASTE PIPE 50%; 12% Additional Discount in bill for free qty",
  },

  // ── Annual Scheme (dual audience) ─────────────────────────────────────────
  {
    schemeId: "ANNUAL_WB",
    name: "Annual Scheme All Products (excl. Water Tank/Garden Pipe/QUAA & FERN) — WB/Orissa/NE/Bihar/Jharkhand",
    audience: ["direct_dealer", "sub_dealer"],
    settlement: "company",
    qualificationBasis: "cumulative_value",
    territoryGroup: "WB/ORISSA/NE/BIHAR/JHARKHAND",
    productScope: "ON ALL PRODUCTS EXCEPT - WATER TANK / GARDEN PIPE / QUAA & FERN",
    periodFrom: "2026-04-01",
    periodTo: "2027-03-31",
    periodNote: "1st April 2026 to 31st March 2027",
    audienceSourceTerm: "ANNUAL SCHEME FOR DIRECT DEALERS / SUB- DEALERS",
    fundingNote: null,
  },
];

// ── Scheme Slabs ──────────────────────────────────────────────────────────────

export const SCHEME_SLABS: SchemeSlabRow[] = [
  // ── CP_LALAN (6 slabs) ────────────────────────────────────────────────────
  { schemeId: "CP_LALAN", slabOrder: 1, thresholdFrom: "30000",  thresholdTo: "59999",  unit: "rupees", rate: "0.025",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.30,000 to Rs.59,999" },
  { schemeId: "CP_LALAN", slabOrder: 2, thresholdFrom: "60000",  thresholdTo: "99999",  unit: "rupees", rate: "0.03",   altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.60,000 to Rs.99,999" },
  { schemeId: "CP_LALAN", slabOrder: 3, thresholdFrom: "100000", thresholdTo: "199999", unit: "rupees", rate: "0.035",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,00,000 to Rs.1,99,999" },
  { schemeId: "CP_LALAN", slabOrder: 4, thresholdFrom: "200000", thresholdTo: "399999", unit: "rupees", rate: "0.0425", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.2,00,000 to Rs.3,99,999" },
  { schemeId: "CP_LALAN", slabOrder: 5, thresholdFrom: "400000", thresholdTo: "599999", unit: "rupees", rate: "0.05",   altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.4,00,000 to Rs.5,99,999" },
  { schemeId: "CP_LALAN", slabOrder: 6, thresholdFrom: "600000", thresholdTo: null,     unit: "rupees", rate: "0.06",   altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.6,00,000 & Above" },

  // ── CP_KL_KA (4 slabs) ───────────────────────────────────────────────────
  { schemeId: "CP_KL_KA", slabOrder: 1, thresholdFrom: "50000",  thresholdTo: "99999",  unit: "rupees", rate: "0.03",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.50,000 to Rs.99,999" },
  { schemeId: "CP_KL_KA", slabOrder: 2, thresholdFrom: "100000", thresholdTo: "199999", unit: "rupees", rate: "0.04",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,00,000 to Rs.1,99,999" },
  { schemeId: "CP_KL_KA", slabOrder: 3, thresholdFrom: "200000", thresholdTo: "499999", unit: "rupees", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.2,00,000 to Rs.4,99,999" },
  { schemeId: "CP_KL_KA", slabOrder: 4, thresholdFrom: "500000", thresholdTo: null,     unit: "rupees", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.5,00,000 & Above" },

  // ── CP_WAHID (6 slabs) ────────────────────────────────────────────────────
  { schemeId: "CP_WAHID", slabOrder: 1, thresholdFrom: "40000",  thresholdTo: "74999",  unit: "rupees", rate: "0.025",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.40,000 to Rs.74,999" },
  { schemeId: "CP_WAHID", slabOrder: 2, thresholdFrom: "75000",  thresholdTo: "149999", unit: "rupees", rate: "0.03",   altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.75,000 to Rs.1,49,999" },
  { schemeId: "CP_WAHID", slabOrder: 3, thresholdFrom: "150000", thresholdTo: "249999", unit: "rupees", rate: "0.035",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,50,000 to Rs.2,49,999" },
  { schemeId: "CP_WAHID", slabOrder: 4, thresholdFrom: "250000", thresholdTo: "399999", unit: "rupees", rate: "0.0425", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.2,50,000 to Rs.3,99,999" },
  { schemeId: "CP_WAHID", slabOrder: 5, thresholdFrom: "400000", thresholdTo: "599999", unit: "rupees", rate: "0.05",   altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.4,00,000 to Rs.5,99,999" },
  { schemeId: "CP_WAHID", slabOrder: 6, thresholdFrom: "600000", thresholdTo: null,     unit: "rupees", rate: "0.06",   altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.6,00,000 & Above" },

  // ── PTMT_LALAN (8 slabs) ─────────────────────────────────────────────────
  { schemeId: "PTMT_LALAN", slabOrder: 1, thresholdFrom: "25000",   thresholdTo: "74999",   unit: "rupees", rate: "0.025", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.25,000 to Rs.74,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 2, thresholdFrom: "75000",   thresholdTo: "149999",  unit: "rupees", rate: "0.03",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.75,000 to Rs.1,49,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 3, thresholdFrom: "150000",  thresholdTo: "249999",  unit: "rupees", rate: "0.035", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,50,000 to Rs.2,49,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 4, thresholdFrom: "250000",  thresholdTo: "399999",  unit: "rupees", rate: "0.04",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.2,50,000 to Rs.3,99,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 5, thresholdFrom: "400000",  thresholdTo: "599999",  unit: "rupees", rate: "0.045", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.4,00,000 to Rs.5,99,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 6, thresholdFrom: "600000",  thresholdTo: "999999",  unit: "rupees", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.6,00,000 to Rs.9,99,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 7, thresholdFrom: "1000000", thresholdTo: "1499999", unit: "rupees", rate: "0.055", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.10,00,000 to Rs.14,99,999" },
  { schemeId: "PTMT_LALAN", slabOrder: 8, thresholdFrom: "1500000", thresholdTo: null,      unit: "rupees", rate: "0.065", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.15,00,000 & Above" },

  // ── PTMT_KL_KA (6 slabs) ─────────────────────────────────────────────────
  { schemeId: "PTMT_KL_KA", slabOrder: 1, thresholdFrom: "40000",  thresholdTo: "74999",  unit: "rupees", rate: "0.025", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.40,000 to Rs.74,999" },
  { schemeId: "PTMT_KL_KA", slabOrder: 2, thresholdFrom: "75000",  thresholdTo: "149999", unit: "rupees", rate: "0.03",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.75,000 to Rs.1,49,999" },
  { schemeId: "PTMT_KL_KA", slabOrder: 3, thresholdFrom: "150000", thresholdTo: "299999", unit: "rupees", rate: "0.04",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,50,000 to Rs.2,99,999" },
  { schemeId: "PTMT_KL_KA", slabOrder: 4, thresholdFrom: "300000", thresholdTo: "599999", unit: "rupees", rate: "0.045", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.3,00,000 to Rs.5,99,999" },
  { schemeId: "PTMT_KL_KA", slabOrder: 5, thresholdFrom: "600000", thresholdTo: "799999", unit: "rupees", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.6,00,000 to Rs.7,99,999" },
  { schemeId: "PTMT_KL_KA", slabOrder: 6, thresholdFrom: "800000", thresholdTo: null,     unit: "rupees", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.8,00,000 & Above" },

  // ── PTMT_WAHID (8 slabs) ─────────────────────────────────────────────────
  { schemeId: "PTMT_WAHID", slabOrder: 1, thresholdFrom: "30000",   thresholdTo: "74999",   unit: "rupees", rate: "0.025", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.30,000 to Rs.74,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 2, thresholdFrom: "75000",   thresholdTo: "149999",  unit: "rupees", rate: "0.03",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.75,000 to Rs.1,49,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 3, thresholdFrom: "150000",  thresholdTo: "249999",  unit: "rupees", rate: "0.035", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,50,000 to Rs.2,49,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 4, thresholdFrom: "250000",  thresholdTo: "399999",  unit: "rupees", rate: "0.04",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.2,50,000 to Rs.3,99,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 5, thresholdFrom: "400000",  thresholdTo: "599999",  unit: "rupees", rate: "0.045", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.4,00,000 to Rs.5,99,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 6, thresholdFrom: "600000",  thresholdTo: "999999",  unit: "rupees", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.6,00,000 to Rs.9,99,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 7, thresholdFrom: "1000000", thresholdTo: "1499999", unit: "rupees", rate: "0.055", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.10,00,000 to Rs.14,99,999" },
  { schemeId: "PTMT_WAHID", slabOrder: 8, thresholdFrom: "1500000", thresholdTo: null,      unit: "rupees", rate: "0.065", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.15,00,000 & Above" },

  // ── PTMT_CP_AP_TEL (8 slabs, last is needs_clarification) ────────────────
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 1, thresholdFrom: "50000",   thresholdTo: "149999",  unit: "rupees", rate: "0.02",   altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.50,000 to Rs.1,49,999" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 2, thresholdFrom: "150000",  thresholdTo: "249999",  unit: "rupees", rate: "0.0275", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.1,50,000 to Rs.2,49,999" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 3, thresholdFrom: "250000",  thresholdTo: "399999",  unit: "rupees", rate: "0.0325", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.2,50,000 to Rs.3,99,999" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 4, thresholdFrom: "400000",  thresholdTo: "599999",  unit: "rupees", rate: "0.0375", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.4,00,000 to Rs.5,99,999" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 5, thresholdFrom: "600000",  thresholdTo: "799999",  unit: "rupees", rate: "0.0425", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.6,00,000 to Rs.7,99,999" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 6, thresholdFrom: "800000",  thresholdTo: "1099999", unit: "rupees", rate: "0.05",   altReward: "Trip to Goa – 1 Person (3 Nights/4 Days)",     freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.8,00,000 to Rs.10,99,999 — Trip to Goa OR 5%" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 7, thresholdFrom: "1100000", thresholdTo: "1499999", unit: "rupees", rate: "0.055",  altReward: "Trip to Thailand – 1 Person (3 Nights/4 Days)", freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.11,00,000 to Rs.14,99,999 — Trip to Thailand OR 5.5%" },
  { schemeId: "PTMT_CP_AP_TEL", slabOrder: 8, thresholdFrom: "1500000", thresholdTo: null,      unit: "rupees", rate: null,     altReward: "Trip to Vietnam – 1 Person (3 Nights/4 Days)", freeGoods: null, rewardStatus: "needs_clarification",    rawText: "On Billing of Rs.15,00,000 & Above — Trip to Vietnam PLUS 5% on Sale Value Above Rs.15.00 Lac OR 6% on Rs.15.00 Lac & Above Plus 5% on Sale Value Above Rs.15.00 Lac" },

  // ── PTMT_CP_WB (8 slabs, last is needs_clarification) ────────────────────
  { schemeId: "PTMT_CP_WB", slabOrder: 1, thresholdFrom: "99000",   thresholdTo: "149999",  unit: "rupees", rate: "0.02",   altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.99,000 to Rs.1,49,999" },
  { schemeId: "PTMT_CP_WB", slabOrder: 2, thresholdFrom: "150000",  thresholdTo: "249999",  unit: "rupees", rate: "0.0275", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.1,50,000 to Rs.2,49,999" },
  { schemeId: "PTMT_CP_WB", slabOrder: 3, thresholdFrom: "250000",  thresholdTo: "399999",  unit: "rupees", rate: "0.0325", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.2,50,000 to Rs.3,99,999" },
  { schemeId: "PTMT_CP_WB", slabOrder: 4, thresholdFrom: "400000",  thresholdTo: "599999",  unit: "rupees", rate: "0.0375", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.4,00,000 to Rs.5,99,999" },
  { schemeId: "PTMT_CP_WB", slabOrder: 5, thresholdFrom: "600000",  thresholdTo: "799999",  unit: "rupees", rate: "0.0425", altReward: null,                                             freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.6,00,000 to Rs.7,99,999" },
  { schemeId: "PTMT_CP_WB", slabOrder: 6, thresholdFrom: "800000",  thresholdTo: "1099999", unit: "rupees", rate: "0.05",   altReward: "Trip to Goa – 1 Person (3 Nights/4 Days)",     freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.8,00,000 to Rs.10,99,999 — Trip to Goa OR 5%" },
  { schemeId: "PTMT_CP_WB", slabOrder: 7, thresholdFrom: "1100000", thresholdTo: "1499999", unit: "rupees", rate: "0.055",  altReward: "Trip to Thailand – 1 Person (3 Nights/4 Days)", freeGoods: null, rewardStatus: "ok",                   rawText: "On Billing of Rs.11,00,000 to Rs.14,99,999 — Trip to Thailand OR 5.5%" },
  { schemeId: "PTMT_CP_WB", slabOrder: 8, thresholdFrom: "1500000", thresholdTo: null,      unit: "rupees", rate: null,     altReward: "Trip to Vietnam – 1 Person (3 Nights/4 Days)", freeGoods: null, rewardStatus: "needs_clarification",    rawText: "On Billing of Rs.15,00,000 & Above — Trip to Vietnam PLUS 5% on Sale Value Above Rs.15.00 Lac OR 6% on Rs.15.00 Lac & Above Plus 5% on Sale Value Above Rs.15.00 Lac" },

  // ── SBQ_SUPER_KL_KA (11 product-level slabs) ─────────────────────────────
  // Each product is one slab; threshold_from = master cartons or pieces required.
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 1,  thresholdFrom: "10",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Health faucet 187 & 188 — 10 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 2,  thresholdFrom: "10",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Mirror cabinet 551 — 10 Master Cartons" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 3,  thresholdFrom: "20",  thresholdTo: null, unit: "master_cartons", rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Connection Tubes — 20 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 4,  thresholdFrom: "10",  thresholdTo: null, unit: "master_cartons", rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Waste Pipe 327/3272/328 — 10 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 5,  thresholdFrom: "5",   thresholdTo: null, unit: "master_cartons", rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All W/Machine inlets/Outlet — 5 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 6,  thresholdFrom: "5",   thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Line filters — 5 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 7,  thresholdFrom: "1",   thresholdTo: null, unit: "master_cartons", rate: "0.05", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Crystal series — 1 Master Carton of Each Cat. No." },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 8,  thresholdFrom: "15",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Float Valves 151/152 & 153 — 15 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 9,  thresholdFrom: "10",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "T Taps — 10 Master Cartons Mix Match" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 10, thresholdFrom: "100", thresholdTo: null, unit: "pieces",         rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Cistern — 100 Pc" },
  { schemeId: "SBQ_SUPER_KL_KA", slabOrder: 11, thresholdFrom: "100", thresholdTo: null, unit: "pieces",         rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Seat Cover — 100 Pc" },

  // ── SBQ_DIST_KL_KA (11 slabs) ────────────────────────────────────────────
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 1,  thresholdFrom: "3",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Health faucet 187 & 188 — 3 Master Cartons Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 2,  thresholdFrom: "4",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Mirror cabinet 551 — 4 Master Cartons" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 3,  thresholdFrom: "4",  thresholdTo: null, unit: "master_cartons", rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Connection Tubes — 4 Master Cartons Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 4,  thresholdFrom: "3",  thresholdTo: null, unit: "master_cartons", rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Waste Pipe 327/3272/328 — 3 Master Cartons Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 5,  thresholdFrom: "1",  thresholdTo: null, unit: "master_cartons", rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All W/Machine inlets/Outlet — 1 Master Carton Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 6,  thresholdFrom: "1",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Line filters — 1 Master Carton Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 7,  thresholdFrom: "1",  thresholdTo: null, unit: "master_cartons", rate: "0.05", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Crystal series — 1 Master Carton of Each Cat. No." },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 8,  thresholdFrom: "4",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Float Valves 151/152 & 153 — 4 Master Cartons Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 9,  thresholdFrom: "1",  thresholdTo: null, unit: "master_cartons", rate: "0.10", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "T Taps — 1 Master Carton Mix Match" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 10, thresholdFrom: "20", thresholdTo: null, unit: "pieces",         rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Cistern — 20 Pc" },
  { schemeId: "SBQ_DIST_KL_KA", slabOrder: 11, thresholdFrom: "20", thresholdTo: null, unit: "pieces",         rate: "0.06", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Seat Cover — 20 Pc" },

  // ── SBQ_SUB_KA — complete from workbook (Single Bill Qty sheet R41-R68)
  //    10 products, 28 slabs. Cistern and Seat Cover have 2 tiers; others 3.
  //    Source: "FOR SUB - DEALER BY DISTRIBUTOR / STATE: KARNATAKA / 01-08-2026"
  { schemeId: "SBQ_SUB_KA", slabOrder: 1,  thresholdFrom: "22",  thresholdTo: null, unit: "pieces", rate: "0.10",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Health faucet – 187 & 188 — 22 NOS → 10%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 2,  thresholdFrom: "15",  thresholdTo: null, unit: "pieces", rate: "0.075", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Health faucet – 187 & 188 — 15 NOS → 7.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 3,  thresholdFrom: "10",  thresholdTo: null, unit: "pieces", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Health faucet – 187 & 188 — 10 NOS → 6%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 4,  thresholdFrom: "12",  thresholdTo: null, unit: "pieces", rate: "0.10",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Mirror cabinet 551 — 12 NOS → 10%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 5,  thresholdFrom: "6",   thresholdTo: null, unit: "pieces", rate: "0.075", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Mirror cabinet 551 — 6 NOS → 7.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 6,  thresholdFrom: "3",   thresholdTo: null, unit: "pieces", rate: "0.04",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Mirror cabinet 551 — 3 NOS → 4%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 7,  thresholdFrom: "100", thresholdTo: null, unit: "pieces", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Connection Tubes — 100 NOS → 6%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 8,  thresholdFrom: "60",  thresholdTo: null, unit: "pieces", rate: "0.035", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Connection Tubes — 60 NOS → 3.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 9,  thresholdFrom: "30",  thresholdTo: null, unit: "pieces", rate: "0.01",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Connection Tubes — 30 NOS → 1%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 10, thresholdFrom: "100", thresholdTo: null, unit: "pieces", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Waste Pipe — 100 NOS → 6%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 11, thresholdFrom: "60",  thresholdTo: null, unit: "pieces", rate: "0.035", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Waste Pipe — 60 NOS → 3.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 12, thresholdFrom: "30",  thresholdTo: null, unit: "pieces", rate: "0.01",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Waste Pipe — 30 NOS → 1%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 13, thresholdFrom: "100", thresholdTo: null, unit: "pieces", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All W/Machine inlets/Outlets — 100 NOS → 6%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 14, thresholdFrom: "60",  thresholdTo: null, unit: "pieces", rate: "0.035", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All W/Machine inlets/Outlets — 60 NOS → 3.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 15, thresholdFrom: "30",  thresholdTo: null, unit: "pieces", rate: "0.01",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All W/Machine inlets/Outlets — 30 NOS → 1%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 16, thresholdFrom: "50",  thresholdTo: null, unit: "pieces", rate: "0.10",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Line filters — 50 NOS → 10%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 17, thresholdFrom: "30",  thresholdTo: null, unit: "pieces", rate: "0.075", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Line filters — 30 NOS → 7.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 18, thresholdFrom: "15",  thresholdTo: null, unit: "pieces", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "All Line filters — 15 NOS → 5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 19, thresholdFrom: "100", thresholdTo: null, unit: "pieces", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Crystal series — 100 NOS → 5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 20, thresholdFrom: "50",  thresholdTo: null, unit: "pieces", rate: "0.035", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Crystal series — 50 NOS → 3.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 21, thresholdFrom: "20",  thresholdTo: null, unit: "pieces", rate: "0.02",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Crystal series — 20 NOS → 2%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 22, thresholdFrom: "10",  thresholdTo: null, unit: "pieces", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Cistern — 10 NOS → 6%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 23, thresholdFrom: "5",   thresholdTo: null, unit: "pieces", rate: "0.02",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Cistern — 5 NOS → 2%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 24, thresholdFrom: "10",  thresholdTo: null, unit: "pieces", rate: "0.06",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Seat Cover — 10 NOS → 6%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 25, thresholdFrom: "5",   thresholdTo: null, unit: "pieces", rate: "0.02",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Seat Cover — 5 NOS → 2%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 26, thresholdFrom: "50",  thresholdTo: null, unit: "pieces", rate: "0.10",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Float Valves — 50 NOS → 10%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 27, thresholdFrom: "30",  thresholdTo: null, unit: "pieces", rate: "0.075", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Float Valves — 30 NOS → 7.5%" },
  { schemeId: "SBQ_SUB_KA", slabOrder: 28, thresholdFrom: "15",  thresholdTo: null, unit: "pieces", rate: "0.05",  altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Float Valves — 15 NOS → 5%" },

  // ── SB_CP_KL_KA (4 slabs) ────────────────────────────────────────────────
  { schemeId: "SB_CP_KL_KA", slabOrder: 1, thresholdFrom: "20000",  thresholdTo: "39999",  unit: "rupees", rate: "0.02", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.20,000 to Rs.39,999" },
  { schemeId: "SB_CP_KL_KA", slabOrder: 2, thresholdFrom: "40000",  thresholdTo: "74999",  unit: "rupees", rate: "0.03", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.40,000 to Rs.74,999" },
  { schemeId: "SB_CP_KL_KA", slabOrder: 3, thresholdFrom: "75000",  thresholdTo: "124999", unit: "rupees", rate: "0.04", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.75,000 to Rs.1,24,999" },
  { schemeId: "SB_CP_KL_KA", slabOrder: 4, thresholdFrom: "125000", thresholdTo: null,     unit: "rupees", rate: "0.05", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "On Billing of Rs.1,25,000 & Above" },

  // ── MIRROR_CABINET (1 flat slab) ──────────────────────────────────────────
  { schemeId: "MIRROR_CABINET", slabOrder: 1, thresholdFrom: "1", thresholdTo: null, unit: "rupees", rate: "0.05", altReward: null, freeGoods: null, rewardStatus: "ok", rawText: "Mirror Cabinets (All Varieties) — 5% on Taxable Amount" },

  // ── PPR_FREE (1 slab — free goods) ────────────────────────────────────────
  { schemeId: "PPR_FREE", slabOrder: 1, thresholdFrom: "75000", thresholdTo: null, unit: "rupees", rate: null, altReward: null, freeGoods: "1 Pc of PPR Welding Machine", rewardStatus: "ok", rawText: "On Purchase of Rs.75,000/- (Taxable) of PPR Pipes & Fittings" },

  // ── PVC_FREE_LALAN (4 slabs — free pieces) ───────────────────────────────
  { schemeId: "PVC_FREE_LALAN", slabOrder: 1, thresholdFrom: "200",  thresholdTo: "499",  unit: "pieces", rate: null, altReward: null, freeGoods: "12 Pcs",  rewardStatus: "ok", rawText: "On off-take of 200 Pcs" },
  { schemeId: "PVC_FREE_LALAN", slabOrder: 2, thresholdFrom: "500",  thresholdTo: "749",  unit: "pieces", rate: null, altReward: null, freeGoods: "40 Pcs",  rewardStatus: "ok", rawText: "On off-take of 500 Pcs" },
  { schemeId: "PVC_FREE_LALAN", slabOrder: 3, thresholdFrom: "750",  thresholdTo: "999",  unit: "pieces", rate: null, altReward: null, freeGoods: "70 Pcs",  rewardStatus: "ok", rawText: "On off-take of 750 Pcs" },
  { schemeId: "PVC_FREE_LALAN", slabOrder: 4, thresholdFrom: "1000", thresholdTo: null,   unit: "pieces", rate: null, altReward: null, freeGoods: "110 Pcs", rewardStatus: "ok", rawText: "On off-take of 1000 Pcs" },

  // ── PVC_FREE_WAHID (4 slabs) ──────────────────────────────────────────────
  { schemeId: "PVC_FREE_WAHID", slabOrder: 1, thresholdFrom: "200",  thresholdTo: "499",  unit: "pieces", rate: null, altReward: null, freeGoods: "12 Pcs",  rewardStatus: "ok", rawText: "On off-take of 200 Pcs" },
  { schemeId: "PVC_FREE_WAHID", slabOrder: 2, thresholdFrom: "500",  thresholdTo: "749",  unit: "pieces", rate: null, altReward: null, freeGoods: "40 Pcs",  rewardStatus: "ok", rawText: "On off-take of 500 Pcs" },
  { schemeId: "PVC_FREE_WAHID", slabOrder: 3, thresholdFrom: "750",  thresholdTo: "999",  unit: "pieces", rate: null, altReward: null, freeGoods: "70 Pcs",  rewardStatus: "ok", rawText: "On off-take of 750 Pcs" },
  { schemeId: "PVC_FREE_WAHID", slabOrder: 4, thresholdFrom: "1000", thresholdTo: null,   unit: "pieces", rate: null, altReward: null, freeGoods: "110 Pcs", rewardStatus: "ok", rawText: "On off-take of 1000 Pcs" },

  // ── PVC_FREE_BIHAR_JH (4 slabs) ───────────────────────────────────────────
  { schemeId: "PVC_FREE_BIHAR_JH", slabOrder: 1, thresholdFrom: "200",  thresholdTo: "499",  unit: "pieces", rate: null, altReward: null, freeGoods: "12 Pcs",  rewardStatus: "ok", rawText: "On off-take of 200 Pcs" },
  { schemeId: "PVC_FREE_BIHAR_JH", slabOrder: 2, thresholdFrom: "500",  thresholdTo: "749",  unit: "pieces", rate: null, altReward: null, freeGoods: "40 Pcs",  rewardStatus: "ok", rawText: "On off-take of 500 Pcs" },
  { schemeId: "PVC_FREE_BIHAR_JH", slabOrder: 3, thresholdFrom: "750",  thresholdTo: "999",  unit: "pieces", rate: null, altReward: null, freeGoods: "70 Pcs",  rewardStatus: "ok", rawText: "On off-take of 750 Pcs" },
  { schemeId: "PVC_FREE_BIHAR_JH", slabOrder: 4, thresholdFrom: "1000", thresholdTo: null,   unit: "pieces", rate: null, altReward: null, freeGoods: "110 Pcs", rewardStatus: "ok", rawText: "On off-take of 1000 Pcs" },

  // ── PVC_FREE_ORISSA (4 slabs) ─────────────────────────────────────────────
  { schemeId: "PVC_FREE_ORISSA", slabOrder: 1, thresholdFrom: "200",  thresholdTo: "499",  unit: "pieces", rate: null, altReward: null, freeGoods: "12 Pcs",  rewardStatus: "ok", rawText: "On off-take of 200 Pcs" },
  { schemeId: "PVC_FREE_ORISSA", slabOrder: 2, thresholdFrom: "500",  thresholdTo: "749",  unit: "pieces", rate: null, altReward: null, freeGoods: "40 Pcs",  rewardStatus: "ok", rawText: "On off-take of 500 Pcs" },
  { schemeId: "PVC_FREE_ORISSA", slabOrder: 3, thresholdFrom: "750",  thresholdTo: "999",  unit: "pieces", rate: null, altReward: null, freeGoods: "70 Pcs",  rewardStatus: "ok", rawText: "On off-take of 750 Pcs" },
  { schemeId: "PVC_FREE_ORISSA", slabOrder: 4, thresholdFrom: "1000", thresholdTo: null,   unit: "pieces", rate: null, altReward: null, freeGoods: "110 Pcs", rewardStatus: "ok", rawText: "On off-take of 1000 Pcs" },

  // ── ANNUAL_WB (6 slabs, 3rd is needs_clarification) ──────────────────────
  { schemeId: "ANNUAL_WB", slabOrder: 1, thresholdFrom: "600000",   thresholdTo: "999999",   unit: "rupees", rate: "0.01",   altReward: null,                                                 freeGoods: null, rewardStatus: "ok",                  rawText: "Rs.6.00 Lac to Rs.9.99 Lac — 1%" },
  { schemeId: "ANNUAL_WB", slabOrder: 2, thresholdFrom: "1000000",  thresholdTo: "2499999",  unit: "rupees", rate: "0.0125", altReward: null,                                                 freeGoods: null, rewardStatus: "ok",                  rawText: "Rs.10.00 Lac to Rs.24.99 Lac — 1.25%" },
  { schemeId: "ANNUAL_WB", slabOrder: 3, thresholdFrom: "2500000",  thresholdTo: "4999999",  unit: "rupees", rate: null,     altReward: null,                                                 freeGoods: null, rewardStatus: "needs_clarification", rawText: "Rs.25.00 Lac to Rs.49.99 Lac — 1.50% OR TON Branded Air Conditioner + Above Rs.25.00 Lac 1.50%" },
  { schemeId: "ANNUAL_WB", slabOrder: 4, thresholdFrom: "5000000",  thresholdTo: "7499999",  unit: "rupees", rate: "0.0165", altReward: "Trip to Vietnam – 1 Person (3N/4D)",                freeGoods: null, rewardStatus: "ok",                  rawText: "Rs.50.00 Lac to Rs.74.99 Lac — 1.65% OR Trip to Vietnam. Plus 1.65% on Sale above Rs.50.00 Lac" },
  { schemeId: "ANNUAL_WB", slabOrder: 5, thresholdFrom: "7500000",  thresholdTo: "9999999",  unit: "rupees", rate: "0.018",  altReward: "Trip to Mauritius – 1 Person (3N/4D)",              freeGoods: null, rewardStatus: "ok",                  rawText: "Rs.75.00 Lac to Rs.99.99 Lac — 1.80% OR Trip to Mauritius. Plus 1.80% on Sale above Rs.75.00 Lac" },
  { schemeId: "ANNUAL_WB", slabOrder: 6, thresholdFrom: "10000000", thresholdTo: null,       unit: "rupees", rate: "0.02",   altReward: "Trip to Singapore for Couple (4N/5D)",               freeGoods: null, rewardStatus: "ok",                  rawText: "Rs.1.00 Cr & Above — 2% OR Trip to Singapore for Couple (4N/5D)" },
];

// ── Scheme Item Group (basket map) ────────────────────────────────────────────
// Maps sale_line.group_raw values → scheme_id.
// Territory-split schemes (CP, PTMT, PTMT-CP) have multiple entries per item group
// so the nudge engine can pick the correct scheme via territory matching.

export const SCHEME_ITEM_GROUPS: SchemeItemGroupRow[] = [
  // CP family → all 3 CP territory schemes
  { itemGroup: "CP",           schemeId: "CP_LALAN" },
  { itemGroup: "CP",           schemeId: "CP_KL_KA" },
  { itemGroup: "CP",           schemeId: "CP_WAHID" },
  { itemGroup: "C P",          schemeId: "CP_LALAN" },
  { itemGroup: "C P",          schemeId: "CP_KL_KA" },
  { itemGroup: "C P",          schemeId: "CP_WAHID" },
  { itemGroup: "CP ACCESSORIES", schemeId: "CP_LALAN" },
  { itemGroup: "CP ACCESSORIES", schemeId: "CP_KL_KA" },
  { itemGroup: "CP ACCESSORIES", schemeId: "CP_WAHID" },
  { itemGroup: "CP ALLIED",    schemeId: "CP_LALAN" },
  { itemGroup: "CP ALLIED",    schemeId: "CP_KL_KA" },
  { itemGroup: "CP ALLIED",    schemeId: "CP_WAHID" },
  { itemGroup: "SINK",         schemeId: "CP_LALAN" },
  { itemGroup: "SINK",         schemeId: "CP_KL_KA" },
  { itemGroup: "SINK",         schemeId: "CP_WAHID" },
  { itemGroup: "SANITARYWARE", schemeId: "CP_LALAN" },
  { itemGroup: "SANITARYWARE", schemeId: "CP_KL_KA" },
  { itemGroup: "SANITARYWARE", schemeId: "CP_WAHID" },
  { itemGroup: "PLATE RACK",   schemeId: "CP_LALAN" },
  { itemGroup: "PLATE RACK",   schemeId: "CP_KL_KA" },
  { itemGroup: "PLATE RACK",   schemeId: "CP_WAHID" },
  { itemGroup: "GLASS",        schemeId: "CP_LALAN" },
  { itemGroup: "GLASS",        schemeId: "CP_KL_KA" },
  { itemGroup: "GLASS",        schemeId: "CP_WAHID" },

  // PTMT family → all 3 PTMT territory schemes
  { itemGroup: "PTMT",        schemeId: "PTMT_LALAN" },
  { itemGroup: "PTMT",        schemeId: "PTMT_KL_KA" },
  { itemGroup: "PTMT",        schemeId: "PTMT_WAHID" },
  { itemGroup: "CISTERN",     schemeId: "PTMT_LALAN" },
  { itemGroup: "CISTERN",     schemeId: "PTMT_KL_KA" },
  { itemGroup: "CISTERN",     schemeId: "PTMT_WAHID" },
  { itemGroup: "SEAT COVER",  schemeId: "PTMT_LALAN" },
  { itemGroup: "SEAT COVER",  schemeId: "PTMT_KL_KA" },
  { itemGroup: "SEAT COVER",  schemeId: "PTMT_WAHID" },
  { itemGroup: "WASTE PIPE",  schemeId: "PTMT_LALAN" },
  { itemGroup: "WASTE PIPE",  schemeId: "PTMT_KL_KA" },
  { itemGroup: "WASTE PIPE",  schemeId: "PTMT_WAHID" },
  { itemGroup: "CABINET",     schemeId: "PTMT_LALAN" },
  { itemGroup: "CABINET",     schemeId: "PTMT_KL_KA" },
  { itemGroup: "CABINET",     schemeId: "PTMT_WAHID" },
  { itemGroup: "FLOOR TRAP",  schemeId: "PTMT_LALAN" },
  { itemGroup: "FLOOR TRAP",  schemeId: "PTMT_KL_KA" },
  { itemGroup: "FLOOR TRAP",  schemeId: "PTMT_WAHID" },
  { itemGroup: "QUAA",        schemeId: "PTMT_LALAN" },
  { itemGroup: "QUAA",        schemeId: "PTMT_KL_KA" },
  { itemGroup: "QUAA",        schemeId: "PTMT_WAHID" },

  // AP/Tel and WB regions: combined PTMT+CP schemes
  { itemGroup: "CP",          schemeId: "PTMT_CP_AP_TEL" },
  { itemGroup: "CP",          schemeId: "PTMT_CP_WB" },
  { itemGroup: "PTMT",        schemeId: "PTMT_CP_AP_TEL" },
  { itemGroup: "PTMT",        schemeId: "PTMT_CP_WB" },
  { itemGroup: "CISTERN",     schemeId: "PTMT_CP_AP_TEL" },
  { itemGroup: "CISTERN",     schemeId: "PTMT_CP_WB" },
  { itemGroup: "SEAT COVER",  schemeId: "PTMT_CP_AP_TEL" },
  { itemGroup: "SEAT COVER",  schemeId: "PTMT_CP_WB" },
  { itemGroup: "SINK",        schemeId: "PTMT_CP_AP_TEL" },
  { itemGroup: "SINK",        schemeId: "PTMT_CP_WB" },
  { itemGroup: "SANITARYWARE",schemeId: "PTMT_CP_AP_TEL" },
  { itemGroup: "SANITARYWARE",schemeId: "PTMT_CP_WB" },

  // Annual WB
  { itemGroup: "CP",          schemeId: "ANNUAL_WB" },
  { itemGroup: "PTMT",        schemeId: "ANNUAL_WB" },
  { itemGroup: "CISTERN",     schemeId: "ANNUAL_WB" },
  { itemGroup: "SEAT COVER",  schemeId: "ANNUAL_WB" },
  { itemGroup: "SINK",        schemeId: "ANNUAL_WB" },
  { itemGroup: "SANITARYWARE",schemeId: "ANNUAL_WB" },
  { itemGroup: "WASTE PIPE",  schemeId: "ANNUAL_WB" },
  { itemGroup: "CABINET",     schemeId: "ANNUAL_WB" },
  { itemGroup: "FLOOR TRAP",  schemeId: "ANNUAL_WB" },
  { itemGroup: "CPVC",        schemeId: "ANNUAL_WB" },
  { itemGroup: "UPVC",        schemeId: "ANNUAL_WB" },
  { itemGroup: "SWR",         schemeId: "ANNUAL_WB" },
  { itemGroup: "PPR",         schemeId: "ANNUAL_WB" },
  { itemGroup: "AGRI",        schemeId: "ANNUAL_WB" },
  { itemGroup: "CONNECTION",  schemeId: "ANNUAL_WB" },
  { itemGroup: "CONECTION",   schemeId: "ANNUAL_WB" },

  // PPR Free Scheme
  { itemGroup: "PPR",         schemeId: "PPR_FREE" },

  // Mirror Cabinet
  { itemGroup: "CABINET",     schemeId: "MIRROR_CABINET" },
];

// ── Special Pricing ───────────────────────────────────────────────────────────

export const SPECIAL_PRICING: SpecialPricingRow[] = [
  {
    customerName: "GRAHAA PRIYA ENTERPRISES",
    effectiveFrom: "2026-07-01",
    effectiveTo: "2026-09-30",
    note: "Nett Billing Rates — w.e.f. 01-07-2026 to 30-09-2026",
    rateRows: [
      { serialNo: 1, model: "All Syphonic ONE PIECE (Nova, Casa, Milano, Dune, Urbona, Crystal)", netRatePlusGst: "Rs.5600/-" },
      { serialNo: 2, model: "All Non Syphonic ONE PIECE (Diamond, Spa, Marcus, Artisian, Aquifer, Swirl, Picasso, Neon, Blaze, Delta, Majestic, Milano, Athos & Prime)", netRatePlusGst: "Rs.5200/-" },
      { serialNo: 3, model: "Non Syphonic Economy (Astro, Marco, Matrix, Ultra & Midas)", netRatePlusGst: "Rs.4900/-" },
    ],
  },
];
