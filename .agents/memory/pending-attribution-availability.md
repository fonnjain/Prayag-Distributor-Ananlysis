---
name: Pending attribution availability
description: Fail-closed rules for pending-order assignment coverage and hierarchy exports.
---

Pending-order assignment data and the Attribution Conflicts report form one atomic attribution basis. If either dependency is unavailable, preserve factory head, party, product-group, and total quantities as source-only data, but do not calculate or display candidate coverage, safe coverage, or known-zero attribution gaps. Do not generate an attributed hierarchy export.

**Why:** An assignment can look uniquely active until the conflict report applies a hold. Treating a missing conflict report as an empty report silently overstates safe coverage.

**How to apply:** Any pending attribution page, API response, cache, or export must carry an explicit availability state. Only complete assignment-plus-conflict loads may publish coverage or member buckets; dependency failure must return nullable metrics and source-only rows.