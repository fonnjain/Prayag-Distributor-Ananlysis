---
name: Secondary arrears persistence
description: Why arrears-month flags must survive persistence and how to interpret the resulting alert-volume correction.
---

Persisted secondary month status must preserve the live loader's arrears decision even after the calendar month closes. Open months and loader-flagged arrears months both remain unrecorded until the source is sufficiently populated.

**Why:** A closed-month persistence rule once discarded the live arrears flag, treating a largely unfilled August sheet as confirmed zero booking. This produced more than one hundred false A2 alerts. Their later resolution reflects corrected data-quality classification, not improved business performance, suppression, or acknowledgement.

**How to apply:** When changing secondary ingestion, alert trends, or recorded-month logic, verify that loader status survives persistence and that achievement numerators and denominators use the same recorded month set. Explain any corresponding alert-volume cliff as a persistence correction.