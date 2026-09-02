---
name: Legacy Segment date import split
description: Source-specific evidence for interpreting numeric dates in historical Segment Wise order workbooks.
---

**Rule:** Treat numeric date cells in the FY2024–25 and FY2025–26 Segment Wise Google Sheets as day/month-swapped imports, while keeping text dates and all FY2021–22 through FY2023–24 Segment Wise dates literal. PSCode XLSX dates also remain literal.

**Why:** In FY2024–25 and FY2025–26, every numeric serial decodes to a day at most 12, every text date starts above 12, and transposing every numeric date removes every out-of-FY row. Earlier Segment sheets and PSCode archives contain many valid dates above day 12, proving the behavior is source-generation-specific rather than a universal parser rule.

**How to apply:** Any implementation must use an explicit FY-and-source-format rule, preserve raw values and anomaly evidence, and never infer a transpose merely from FY bounds. Rebuild affected monthly, quarterly, and retailer-first outputs only under separately authorized work.