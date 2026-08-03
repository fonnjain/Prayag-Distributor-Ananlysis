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

export function formatCompact(value: number): string {
  if (value >= 10000000) {
    return formatCrore(value);
  } else if (value >= 100000) {
    return formatLakh(value);
  }
  return formatINR(value);
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
