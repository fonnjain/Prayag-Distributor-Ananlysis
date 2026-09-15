import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { HistoricalBasisTab } from '../HistoricalBasisTab';

// Mock the API client
vi.mock('@workspace/api-client-react', () => ({
  useGetAiSchemesHistory: vi.fn(() => ({
    isLoading: false,
    isError: false,
    data: {
      readOnly: true,
      source: "mock-source",
      sourceLabels: { "E1": "Test Label" },
      schemes: [{
        schemeId: "s1",
        name: "Test Scheme",
        periodFrom: "Jan 2024",
        periodTo: "Dec 2024",
        itemGroups: ["Tanks"],
        audience: [],
        observedStructure: { slabCount: 2 },
        slabs: []
      }],
      filters: {
        applied: {},
        metadata: { itemGroups: ["Tanks"], skuBands: ["HIGH"], territories: [{ raw: "T1", label: "Territory 1" }] }
      },
      timeline: { statement: "Timeline statement", gaps: [], observedPeriods: [] },
      observedGrammar: {
        statement: "Grammar statement",
        qualificationBases: [], settlementModes: [], thresholdUnits: [], rewardForms: {}
      },
      historySummary: {
        schemeCount: 19,
        currentlyLiveCount: 5,
        historicalCount: 14,
        source: "Summary Source"
      },
      itemGroupCoverage: {
        allItemGroups: ["Pipes", "Tanks"],
        covered: ["Tanks"],
        neverCovered: ["Pipes"],
        statement: "Group Coverage Statement",
        source: "Group Source"
      },
      coverage: {
        raw: {}, canonical: {},
        statement: "Coverage honesty statement"
      },
      outcomeAvailability: {
        available: false,
        statement: "Outcomes Unavailable",
        evidenceBasis: "None"
      },
      precedentBounds: {}
    }
  })),
  useGenerateAiSchemesHistory: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: true,
    data: {
      source: "mock-source",
      margin: {},
      breakevenLiftRequired: {
        value: 150000,
        statement: "Modeled breakeven lift required"
      },
      proposal: { 
        name: "Test Precedent",
        estimatedCostInr: 50000,
        costAsMarginPct: 15.5,
        modeledCostAssumption: "Modeled cost assumption text",
        duration: { periodFrom: "2024" },
        slabs: [{ thresholdFrom: 1000, ratePct: 5 }]
      },
      closestPrecedent: {
        name: "Closest",
        schemeId: "C1"
      },
      flags: { 
        beyondPrecedent: true,
        modeledRateCeilingApplied: true,
        modeledRateCeilingBinding: true,
        historicalCostCeilingAvailable: false,
        historicalCostComparisonPerformed: false,
        statement: "Flag statement"
      },
      guardrails: { 
        sourceHonesty: "Guardrail honesty" 
      }
    }
  })),
  GenerateAiSchemesHistoryRequestSkuBand: { HIGH: 'HIGH' }
}));

describe('HistoricalBasisTab UI rendering', () => {
  it('renders absence statement, coverage, and generator output with specific data-testids', () => {
    // Need to silence useLayoutEffect warnings from SSR
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const html = renderToString(React.createElement(HistoricalBasisTab));
    
    // Explicit absence statement
    expect(html).toContain('Outcomes Unavailable');
    expect(html).toMatch(/Evidence Basis:.*None/);
    
    // Coverage honesty statement & history summary
    expect(html).toContain('Coverage honesty statement');
    expect(html).toMatch(/data-testid="status-scheme-count"[^>]*>19/);
    expect(html).toMatch(/data-testid="status-live-count"[^>]*>5/);
    expect(html).toMatch(/data-testid="status-historical-count"[^>]*>14/);
    expect(html).toContain('Pipes'); // never covered
    
    // Source labels
    expect(html).toMatch(/Source.*mock-source/);
    expect(html).toMatch(/E1.*Test Label/);
    
    // Generator Result & Guardrails
    expect(html).toContain('Guardrails Applied');
    expect(html).toMatch(/data-testid="badge-persisted"[^>]*>Persisted: False/);
    
    // Formatted modeled values
    expect(html).toMatch(/data-testid="result-modeled-cost"[^>]*>.*50.00K/);
    expect(html).toMatch(/data-testid="result-cost-pct"[^>]*>.*15.5%/);
    expect(html).toMatch(/data-testid="result-cost-assumption"[^>]*>Modeled cost assumption text/);
    expect(html).toMatch(/data-testid="result-breakeven"[^>]*>.*1.50L/);
    expect(html).toContain('Modeled rate ceiling');
    expect(html).toContain('not an observed historical cost ceiling');
    expect(html).toContain('no proposal-cost comparison against historical spend was performed');
    
    consoleSpy.mockRestore();
  });
});
