---
name: PA2 period labelling
description: How period coverage and mismatch detection flow through the AI Reports pipeline — from payload to route response to frontend banners and PDF exports.
---

## Rule
Every AI report API response carries five period fields; the frontend shows banners, routes period info into PDF covers/footers, and uses `periodCoveredShort` in filenames.

## Backend (API Server)

**`aiPayload.ts`** — `computePeriodCovered(cutoffDate: Date): PeriodCoverage`
- Derives `periodCoveredLabel` ("year to date, April to June 2026"), `periodCoveredShort` ("YTD-Apr-Jun-2026"), `periodFromFiscalMonth` (always 1), `periodToFiscalMonth` (e.g. 3).
- Both `buildMemberPayload` and `buildStateHeadPayload` spread the result into `identity`.

**`numericGuard.ts`** — `runPeriodGuard(sections, toFiscalMonth): PeriodGuardResult`
- For multi-month YTD reports, flags sentences containing "in/during/for [Month]" or "[Month] saw" near a numeric token.
- Also flags "Q1/Q2/Q3/Q4" near a number when `toFiscalMonth > 3`.

**Routes** (`aiReport.ts`, `aiArtifacts.ts` — all 6 AI routes)
- Import `runPeriodGuard, PeriodGuardResult` from `numericGuard.js`.
- Append a PERIOD COVERAGE RULE paragraph to system prompts (no numbering to avoid renumbering conflicts).
- After the numeric guard, call `runPeriodGuard(sections, payload.identity.periodToFiscalMonth)`.
- Every `res.json(...)` includes: `periodCoveredLabel`, `periodCoveredShort`, `selectedPeriod` (from `period` request param), `periodMismatch` (`period !== "ytd"`), `periodGuard`.

## Frontend (AiReports.tsx)

**Types**: `PeriodGuardResult`, `PeriodMeta` (5 optional fields), `PdfPeriodInfo`.
- `GenerationResult` union — all 5 non-distributor variants intersect with `PeriodMeta`.
- `BatchDoc` carries optional period fields populated from `event.result` in `doc_done`.

**Request**: `periodMode` from `useGlobalFilter()` is sent as `period` in both `generate()` and `runBatch()`.

**`PeriodMismatchBanner`** — shown after `GuardBanner`:
- Blue box when `periodMismatch && selectedPeriod !== "ytd"`.
- Amber box when `periodGuard.status === "requires_review"` (lists up to 3 flagged sentences).

**PDF helpers**: `makePeriodCoverHtml(pi)` / `makePeriodFooterText(pi)` build consistent HTML.
- `exportSectionsPdf`, `exportPerformanceReviewPdf`, `exportSuggestionsPdf`, `exportTravelPlanPdf` all accept optional `period?: PdfPeriodInfo`.
- Cover shows mismatch note (amber) + coverage line (blue); footer is "FY · label · data-to · generated".

**Filenames**: Batch zip uses `FY${fy}_${reportType}_${periodShort}` for folder and per-member files.

**`generateBatchDocHtml`**: includes period cover block and updated footer.

## Why
AI Reports is FY_ONLY — period pills are hidden, but `periodMode` can carry a stale non-YTD value from a FULL-capability page. The mismatch banner surfaces this to the user before they distribute a document with misleading metadata.

## How to apply
- Any new AI route must also add the period fields to its response and run `runPeriodGuard`.
- Any new PDF export function should accept `PdfPeriodInfo` and call `makePeriodCoverHtml` / `makePeriodFooterText`.
- The batch SSE endpoint itself needs no changes — period fields flow through in `event.result`.
