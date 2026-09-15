import { describe, it, expect } from 'vitest';
import { generatorSchema, buildQueryParams } from '../HistoricalBasisTab';

describe('HistoricalBasisTab logic', () => {
  describe('buildQueryParams', () => {
    it('omits "all" values from filters', () => {
      const params = buildQueryParams('all', 'all', 'all', 'all');
      expect(params).toEqual({});
    });

    it('includes specific filter values', () => {
      const params = buildQueryParams('2024', 'Pipes', 'HIGH', 'North');
      expect(params).toEqual({
        year: '2024',
        itemGroup: 'Pipes',
        skuBand: 'HIGH',
        territory: 'North'
      });
    });
  });

  describe('generatorSchema validation', () => {
    const baseValidInput = {
      territory: 'North',
      marginCapPct: 5,
      breadthOpportunityRetailers: 100,
      categoryGrossMarginInr: 50000,
      grossMarginRatePct: 15,
    };

    it('fails if neither itemGroup nor skuBand is provided', () => {
      const invalid = generatorSchema.safeParse({
        ...baseValidInput,
        itemGroup: '',
        skuBand: 'all'
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0].message).toMatch(/Exactly one of Item Group or SKU Band must be provided/i);
      }
    });

    it('fails if both itemGroup and skuBand are provided', () => {
      const invalid = generatorSchema.safeParse({
        ...baseValidInput,
        itemGroup: 'Pipes',
        skuBand: 'HIGH'
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0].message).toMatch(/Exactly one of Item Group or SKU Band must be provided/i);
      }
    });

    it('passes with only itemGroup provided', () => {
      const valid = generatorSchema.safeParse({
        ...baseValidInput,
        itemGroup: 'Pipes',
        skuBand: 'all'
      });
      expect(valid.success).toBe(true);
    });

    it('passes with only skuBand provided', () => {
      const valid = generatorSchema.safeParse({
        ...baseValidInput,
        itemGroup: '',
        skuBand: 'HIGH'
      });
      expect(valid.success).toBe(true);
    });

    it('enforces positive inputs', () => {
      const invalid = generatorSchema.safeParse({
        ...baseValidInput,
        itemGroup: 'Pipes',
        marginCapPct: -5,
        breadthOpportunityRetailers: 0,
        categoryGrossMarginInr: -1,
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        const paths = invalid.error.issues.map(i => i.path.join('.'));
        expect(paths).toContain('marginCapPct');
        expect(paths).toContain('breadthOpportunityRetailers');
        expect(paths).toContain('categoryGrossMarginInr');
      }
    });
  });
});
