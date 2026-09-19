export type ApprovedProductWiseManifest = {
  version: string;
  sourceSha256: string;
  month: "Sep-26";
  cutoff: string;
  completeness: "partial" | "complete";
  freezeAt: string;
  rows: number;
  rejectedRows: number;
  orders: number;
  dateMin: string;
  dateMax: string;
  basic: number;
  inclusive: number;
  gst: number;
  valueToleranceCents: number;
  retailers: number;
  distributors: number;
  codes: number;
  salesUsers: number;
  statuses: readonly ["APPROVED"];
  discountMin: number;
  discountMedian: number;
  discountMax: number;
  discountNulls: number;
  cityUnavailableLiterals: number;
  blankGstTypes: number;
  absentOrderId: string;
};

export const APPROVED_PRODUCT_WISE_MANIFESTS: readonly ApprovedProductWiseManifest[] = [
  {
    version: "sep26-partial-v1",
    sourceSha256: "14ac994927c3137db0354fb654afca3946057d7dfd26b0dfeb48b59e7a0800f4",
    month: "Sep-26",
    cutoff: "2026-09-17T23:46:26+05:30",
    completeness: "partial",
    freezeAt: "2027-01-01T00:00:00+05:30",
    rows: 8437,
    rejectedRows: 0,
    orders: 1338,
    dateMin: "2026-09-01T00:00:26+05:30",
    dateMax: "2026-09-17T23:46:26+05:30",
    basic: 61305811,
    inclusive: 72137897.6878,
    gst: 10974385.4472,
    valueToleranceCents: 0.01,
    retailers: 1094,
    distributors: 119,
    codes: 1545,
    salesUsers: 116,
    statuses: ["APPROVED"],
    discountMin: 6,
    discountMedian: 47.46,
    discountMax: 70.8,
    discountNulls: 0,
    cityUnavailableLiterals: 160,
    blankGstTypes: 110,
    absentOrderId: "SORD-161782",
  },
];

export function resolveApprovedProductWiseManifest(sourceSha256: string): ApprovedProductWiseManifest {
  const manifest = APPROVED_PRODUCT_WISE_MANIFESTS.find((candidate) => candidate.sourceSha256 === sourceSha256);
  if (!manifest) throw new Error(`No approved Product-Wise manifest matches workbook SHA ${sourceSha256}.`);
  return manifest;
}