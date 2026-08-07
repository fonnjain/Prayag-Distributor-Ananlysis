import { trunc2, t2n } from "@/lib/trunc";
import rawData from './prayag_data.json';

export const data = rawData.data;
export const manifest = rawData.manifest;

export function formatINR(value: number): string {
  // No rounding: truncate to 2 decimals first, always show exactly 2.
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(t2n(value));
}

export function formatCrore(value: number): string {
  return `₹${trunc2((value / 10000000))} Cr`;
}

export function formatLakh(value: number): string {
  return `₹${trunc2((value / 100000))} L`;
}

/** Adaptive Indian-format amount: ₹2.14 Cr / ₹4.35 L / ₹12.5 K / ₹850.
 *  Tier chosen on magnitude, so negatives (e.g. flow gaps) format correctly. */
export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 10000000) return sign + formatCrore(abs);
  if (abs >= 100000) return sign + formatLakh(abs);
  if (abs >= 1000) return `${sign}₹${trunc2(abs / 1000)} K`;
  // Truncate (never round) like every other tier, and normalise -0 → 0 so a
  // tiny negative never renders as "-₹0".
  const t = Math.trunc(abs);
  return `${t === 0 ? "" : sign}₹${t.toLocaleString("en-IN")}`;
}

export const CHART_COLORS = {
  blue: "#0079F2",
  purple: "#795EFF",
  green: "#009118",
  red: "#A60808",
  pink: "#ec4899",
};

export const CHART_COLOR_LIST = [
  CHART_COLORS.blue,
  CHART_COLORS.purple,
  CHART_COLORS.green,
  CHART_COLORS.red,
  CHART_COLORS.pink,
];
