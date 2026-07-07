import rawData from './prayag_data.json';

export const data = rawData.data;
export const manifest = rawData.manifest;

export function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatCrore(value: number): string {
  return `₹${(value / 10000000).toFixed(2)} Cr`;
}

export function formatLakh(value: number): string {
  return `₹${(value / 100000).toFixed(2)} L`;
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
