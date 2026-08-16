---
name: Alert Routing v2
description: Cadence rules, pattern syntax, scope matching, and on_raise delivery path for the alert routing system.
---

## Rules

**Pattern matching** (`patterns.ts`): `'*'` matches all codes; `'S*'` matches any code starting with S; `'B3'` is exact match. No regex, no SQL LIKE — plain JS startsWith.

**Cadence**:
- `on_raise` recipients at L1: notified immediately when `notifyAlert(triggerType='on_raise')` is called.
- `weekly` recipients: only reached by the weekly digest route.
- `on_raise` at L2/L3 is silently skipped on initial raise — only L1 fires on_raise.

**Scope types**: `all_india` always matches; `state_head` matches when alert entity's state head equals `scope_value` (person alerts: DB lookup; non-person: reads `detail.extraForReport.stateHead`). Do NOT use `scope_type='all'` — the column value is `'all_india'`.

**Decoupled from detection**: `POST /api/alerts/detect` saves alerts to DB but never calls `notifyAlert`. Routing must be triggered separately via `POST /api/alert-routing/notify/:alertId`. Delivery rows are only written when notify is called explicitly.

**Idempotency**: In production (`dryRun=false`), skips if a delivery row already exists for `(alert_id, recipient_id, trigger_type)`. Dry-run bypasses this check — each dry-run call writes new rows.

## Recipient table state (Aug 2026)

| ids | pattern | scope | cadence | level |
|---|---|---|---|---|
| 17–28 | `*` | state_head | weekly | 1 |
| 29, 30 | `*` | all_india | weekly | 1 (Deepak), 3 (Nitin) |
| 41, 42 | `S*`, `C*` | all_india | on_raise | 1 (Deepak J, whatsapp 9910896007) |
| 43, 44 | `S*`, `C*` | all_india | on_raise | 1 (Nitin Agarwal, email ceo@prayagindia.com) |

State heads receive S/C alerts only via weekly digest, not immediately.
All-india gets S and C immediately (L1 on_raise) plus digest (L1/L3 weekly).

**Why:** State head rows were incorrectly seeded as `on_raise` (migration 036); corrected to `weekly` in migration 039. All-india on_raise added for S/C only — A/B go digest-only.

## Test path

To verify the on_raise path works:
```bash
curl -X POST "http://localhost:8080/api/alert-routing/notify/<alertId>" \
  -H "X-Admin-Secret: $SESSION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```
Expected: delivery rows for Deepak J (whatsapp, skip_reason="no provider configured") and Nitin Agarwal (email, skip_reason="dry run"), zero rows for state heads.

Tested Aug 2026 against S1 alert id=33 — 2 rows written, 0 state head rows.
