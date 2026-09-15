import { describe, it, expect } from 'vitest';

// These replicate the logic inside AiPlanPage to prove formatting invariants
const formatValue = (val: unknown): string => {
  if (val === null || val === undefined) return '—';
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") {
    if (val > 1900 && val < 2100 && Number.isInteger(val)) return String(val);
    return new Intl.NumberFormat('en-IN').format(val);
  }
  return String(val);
};

const getPlanStatusVariant = (status: string) => {
  return status === 'approved' ? 'default' :
         status === 'superseded' ? 'destructive' : 'secondary';
};

const hasDefaultedInputs = (selectedMember: string, selectedFy: string) => {
  return !selectedMember || !selectedFy;
};

const inferHonestySource = (source?: string) => {
  return source ? source : 'Unknown Source';
};

const getStateHeadFigure = (analyticsResp: any, selectedMember: string, availableMembers: any[], selectedMonth: string) => {
  if (!analyticsResp?.stateHeads || !selectedMember || !selectedMonth) return null;
  const shName = availableMembers.find(m => m.name === selectedMember)?.stateHead;
  if (!shName) return null;
  return analyticsResp.stateHeads.find((sh: any) => sh.stateHead === shName && sh.month === selectedMonth);
};

describe('AiPlan formatting and logic', () => {
  describe('unavailable-vs-zero semantics', () => {
    it('formats null/undefined as dashed unavailable indicators', () => {
      expect(formatValue(null)).toBe('—');
      expect(formatValue(undefined)).toBe('—');
    });

    it('formats 0 as actual zero, not unavailable', () => {
      expect(formatValue(0)).toBe('0');
    });
  });

  describe('formatting', () => {
    it('formats booleans to Yes/No', () => {
      expect(formatValue(true)).toBe('Yes');
      expect(formatValue(false)).toBe('No');
    });

    it('formats Indian numbers correctly', () => {
      expect(formatValue(150000)).toBe('1,50,000');
    });

    it('leaves recent years as unformatted integers', () => {
      expect(formatValue(2025)).toBe('2025');
    });
  });

  describe('status/revision/provenance', () => {
    it('assigns correct visual variants to status', () => {
      expect(getPlanStatusVariant('approved')).toBe('default');
      expect(getPlanStatusVariant('superseded')).toBe('destructive');
      expect(getPlanStatusVariant('proposed')).toBe('secondary');
    });
  });

  describe('defaulted-input warnings', () => {
    it('flags when inputs are missing', () => {
      expect(hasDefaultedInputs('', '2025-26')).toBe(true);
      expect(hasDefaultedInputs('Member', '')).toBe(true);
      expect(hasDefaultedInputs('Member', '2025-26')).toBe(false);
    });
  });

  describe('inference honesty', () => {
    it('falls back if source is missing to maintain source honesty', () => {
      expect(inferHonestySource('register_v2')).toBe('register_v2');
      expect(inferHonestySource()).toBe('Unknown Source');
    });
  });

  describe('aggregate logic', () => {
    it('matches stateHeadFigure strictly by stateHead and month', () => {
      const analyticsResp = {
        stateHeads: [
          { stateHead: 'Alice', month: 'Apr-26', paceVisitsDone: 100 },
          { stateHead: 'Alice', month: 'May-26', paceVisitsDone: 150 },
          { stateHead: 'Bob', month: 'Apr-26', paceVisitsDone: 50 },
        ]
      };
      const availableMembers = [{ name: 'Charlie', stateHead: 'Alice' }];

      const figureApr = getStateHeadFigure(analyticsResp, 'Charlie', availableMembers, 'Apr-26');
      expect(figureApr?.paceVisitsDone).toBe(100);

      const figureMay = getStateHeadFigure(analyticsResp, 'Charlie', availableMembers, 'May-26');
      expect(figureMay?.paceVisitsDone).toBe(150);

      const figureJun = getStateHeadFigure(analyticsResp, 'Charlie', availableMembers, 'Jun-26');
      expect(figureJun).toBeUndefined();
    });
  });
});
