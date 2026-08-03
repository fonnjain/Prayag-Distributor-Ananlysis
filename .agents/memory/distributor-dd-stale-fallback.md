---
name: Distributor Deep Dive stale fallback
description: Why member-sheet Sheets failures surface as 200 payloads, and the snapshot-persistence rule for the resilient loader.
---
Rule: on /api/mgmt/distributor-deep-dive, transient Sheets failures usually do NOT throw — loadMemberSheet catches and Promise.allSettled absorbs the rest, so failures surface as a 200 payload with membersFailed > 0 (or membersLoaded=0 + error). The resilient wrapper (loadDistributorDeepDiveResilientWith) must treat that degraded payload — not just exceptions — as the transient signal and serve the route_payload_snapshot ("dist-deep-dive|fy|STATEHEAD") with stale=true.

**Why:** a code-review rejection: catching only thrown errors misses the primary failure path, and persisting partial loads overwrites the last known-good snapshot with incomplete figures.

**How to apply:** only persist snapshots when isCompleteLoad (membersFailed=0, membersLoaded>0, no error); any similar per-member fan-out loader needs the same completeness gate before caching.

**Aug 2026 incident:** "0 member sheets loaded, 2 not yet mapped" for a 12-member head looked like a broken or duplicate sheet map. It wasn't — Sales and Distributor deep dives share ONE resolver (Data-tab roster + member_sheet_map.json); the symptom was a cold Sheets-quota pass where every mapped read failed and the frontend hid `membersFailed`. Rule: when a Sheets-backed page "works for one head only", re-fetch warm and check membersFailed before suspecting the mapping. Fixes: frontend surfaces membersFailed (optional field — old snapshots lack it); a degraded first-ever load with no snapshot retries the build once before serving a partial.
