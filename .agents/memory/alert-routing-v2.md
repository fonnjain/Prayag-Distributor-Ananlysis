---
name: Alert Routing v2 — 3-level escalation
description: Scope values, blank-contact skip, skip-empty-L2 logic, seeded recipients, migration 037
---

## Rules

- `scope_type` is `"state_head"` or `"all_india"` — never `"all"` (that was the old v1 value; migration 037 renamed it).
- `escalation_level` is 1, 2, or 3. Level 2 is intentionally left blank; alerts skip from L1 directly to L3 with a logged skip row (recipient_id=NULL, trigger_type='escalation', status='skipped').
- `alert_delivery.recipient_id` is NULLABLE as of migration 037 — required for the L2 skip row pattern.

## Escalation windows (configurable via alert_escalation_config)

| Level | Window severe | Window digest |
|-------|--------------|---------------|
|  L1→L2/L3 | 7 days | 14 days |
|  L2→L3    | 7 days | 7 days  |

## Seeded recipients (migration 037)

- 12 State Heads: L1, scope_type='state_head', scope_value=canonical name, channel='whatsapp'
- Deepak J: L1, scope_type='all_india', channel='whatsapp', contact=9910896007
- Level 2: intentionally blank (0 rows)
- Nitin Agarwal (CEO): L3, scope_type='all_india', channel='email', contact=ceo@prayagindia.com
- Sunil Mohanty: seeded with NULL contact — will always produce status=skipped until contact is filled via UI

## Blank-contact skip

In `notify.ts`: email and whatsapp recipients with null/blank contact produce a delivery row with:
- `status='skipped'`
- `skip_reason='blank contact — no mobile or email on file'`

They are never silently dropped.

## L2 bypass

In `escalate.ts`: when `countRecipientsAtLevel(2) === 0`, the runner:
1. Writes a NULL-recipient skip row at L2 documenting the bypass.
2. Calls `notifyAlert` targeting L3 immediately.
The result carries `skippedEmptyLevel=true` and `skipReason`.

## Why

The spec requires 3-level cadence with a deliberately empty L2 for future use. Empty levels must never silently stall escalation. Blank contacts must be visible in the delivery log (skip rows) so operators know to fill them in.
