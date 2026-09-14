import { describe, it, expect } from 'vitest';

const formatNumber = (num: number | null | undefined, decimals: number = 0) => {
  if (num === null || num === undefined) return '—';
  if (num === 0) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(num);
};

const formatPct = (num: number | null | undefined, decimals: number = 1) => {
  if (num === null || num === undefined) return '—';
  if (num === 0) return '0.0%';
  return new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(num / 100);
};

const formatIndianCurrency = (num: number | null | undefined) => {
  if (num === null || num === undefined) return '—';
  if (num === 0) return '₹0';

  const abs = Math.abs(num);
  if (abs >= 10000000) return `₹${(num / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000) return `₹${(num / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `₹${(num / 1000).toFixed(2)}K`;
  return `₹${num.toFixed(0)}`;
};

describe('AiSchemes formatting', () => {
  it('formats zeros as genuine zeros', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatPct(0)).toBe('0.0%');
    expect(formatIndianCurrency(0)).toBe('₹0');
  });

  it('formats null/undefined as dashes', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatPct(undefined)).toBe('—');
    expect(formatIndianCurrency(null)).toBe('—');
  });

  it('formats Indian currency adaptively for all distribution ranges', () => {
    expect(formatIndianCurrency(500)).toBe('₹500');       // e.g. p10
    expect(formatIndianCurrency(1500)).toBe('₹1.50K');    // e.g. p25
    expect(formatIndianCurrency(150000)).toBe('₹1.50L');  // e.g. p75
    expect(formatIndianCurrency(15000000)).toBe('₹1.50Cr'); // e.g. p90
    expect(formatIndianCurrency(-15000000)).toBe('₹-1.50Cr');
  });
});
