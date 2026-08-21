# State Head FY2025-26 template fix handoff

## Purpose

This is a handoff for the person who maintains the State Head Google
workbooks. It is not an app-side workaround and it must not be applied by
Prayag or by this workspace: Drive is read-only here.

The FY2025-26 audit found one shared template defect copied into thirteen
workbooks. The historical raw layout is:

- raw tab: `Sheet1`
- transaction date: column `C`
- amount: column `F`
- FY label: column `M`
- current source construction: `=QUERY(Sheet1!A1:M)`

The query has no raw transaction-date bound. Twelve files therefore carry
rows dated 25-Apr-2026 through 25-Dec-2026 under an FY2025-26 label. KAKKAR
uses the same construction but is clean for this particular defect because it
has no rows in that leaked date range.

## Required shared-template correction

For FY2025-26, replace the unbounded source query with a date-bounded query:

```text
=QUERY(Sheet1!A1:M, "select * where C >= date '2025-04-01' and C < date '2026-04-01'", 0)
```

The historical `Sheet1` layout has no header row in the audited source, so
the header-count argument is `0`. If a future template introduces a real
header row, the maintainer must adjust that argument deliberately rather than
silently dropping the first transaction.

The date predicate is the authority. The FY label in column M remains useful
audit evidence, but must not widen the date range.

## Report-tab propagation

The correction must be made in the shared template, not as thirteen
independent workbook edits. All Report tabs must consume the bounded
`Sheet1` result. A Report tab must not continue to read the unbounded
`Sheet1!A1:M` range directly after the template correction.

If the template uses a helper result tab/range, the helper must be the single
bounded source for Report 1 through Report 6. Supporting date/FY helper data
may continue to derive from `Sheet1`, but it must not introduce transaction
amounts outside the bounded result.

## Affected workbook set

The audit found the same raw tab, legacy schema, and source construction in
all thirteen files:

1. `Rizvi ji JI 2025-26`
2. `Anant Singh JI 2025-26`
3. ` Pawan Kumar 2025-26`
4. ` Sandeep JI 2025-26`
5. ` Suresh Nair 2025-26`
6. `SULINDER PAL  2025-26`
7. `LALAN 2025-26`
8. `SUNIL PATEL 2025-26`
9. ` BIJJU 2025-26`
10. `NASIR HUSAIN  2025-26`
11. ` TAMILNADU & ANDMAN 2025-26`
12. `Copy of LALAN 2025-26`
13. `KAKKAR 2025-26`

`Copy of LALAN 2025-26` remains a content-identical duplicate and must still
be removed separately. Tamilnadu/Andman and Kakkar remain feeder/non-territory
classification decisions outside this template fix.

## Maintainer handoff boundary

- The maintainer applies the formula change in the Google Sheets template and
  lets the shared-template change propagate to the thirteen workbooks.
- This workspace does not write formulas, edit files, publish workbooks, or
  call a Drive mutation API.
- The Prayag app remains a read-only auditor and release gate.

## Post-maintainer validation

After the external maintainer applies the change, run:

```text
node artifacts/api-server/dist/stateHeadPackCheck.mjs --fy 2025-26 --json
```

For every workbook, confirm:

- `rawTab` remains `Sheet1`.
- `rawSchema` remains `state-head-register-legacy`.
- the recorded Report 1 source contains the bounded date predicate and is not
  the naked `QUERY(Sheet1!A1:M)`.
- `periodIntegrityByFy["2025-26"].outOfFyRows` is `0`.
- `periodIntegrityByFy["2025-26"].futureDatedRows` is `0`.

This validation only proves the template date-leak fix. The release gate may
still block for the duplicate LALAN file, mixed/non-territory feeders, or the
separate territorial under-coverage; those are intentionally outside this
handoff.