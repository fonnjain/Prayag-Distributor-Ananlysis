---
name: Weekly digest scheduler and email
description: Architecture of the weekly alert digest scheduler and email dispatch via Resend.
---

## Scheduler (migration 041 + alertRouting/scheduler.ts)

- `alert_scheduler` singleton table (id=1) stores `last_digest_at` so the dedup guard survives restarts.
- `startWeeklyDigestScheduler(fy)` in scheduler.ts: setInterval 15 min; fires when UTC day=1 (Monday) AND hour 02-04 (= IST 07:30-09:30) AND >=24h since last_digest_at.
- Wired in index.ts at startup alongside cleanupOrphanedJobs.
- `runWeeklyDigestNow({ dryRun, fy, force })` exported for the admin route — `force=true` bypasses the 24h dedup guard (default true for manual triggers).

## Admin routes (alerts.ts)

- POST /api/admin/alerts/digest — manual trigger (body: { dryRun, fy, force })
- GET  /api/admin/alerts/scheduler-status — { inFlight, lastDigestAt, nextWindowUTC, schedulerFy }
- POST /api/admin/alerts/test-email — { to, subject?, body? } → dispatches via channels.ts; use to verify email provider works

## Email dispatch (channels.ts)

Priority order:
1. RESEND_API_KEY set → fetch to https://api.resend.com/emails (preferred)
2. SMTP_HOST set → nodemailer fallback
3. Neither → status='failed', skipReason='no email provider configured'

RESEND_FROM env var: defaults to onboarding@resend.dev (Resend sandbox, only delivers to account owner's email).
For production delivery to ceo@prayagindia.com, RESEND_FROM must be set to a Resend-verified domain (e.g. alerts@prayagindia.com).

## Dry-run verification (Aug 2026)

- Deepak J (all-india, whatsapp): 37 delivery rows — 33 new + 4 cleared = matches alerts page open:32+ack:1+cleared:4 ✓
- Nitin Agarwal (all-india, email): 37 delivery rows, status=sent/dry run ✓
- 11 state heads skipped (no alerts scoped to their territory currently) ✓
- Sandeep Dadheech: 1 row (C6 cleared in his scope) ✓

## Real email not yet verified

Resend connector needs to be connected (RESEND_API_KEY) before any real transmission occurs.
After connecting: POST /api/admin/alerts/test-email with to=ceo@prayagindia.com to confirm delivery.

## on_raise fanout not yet exercised

new=0 in all detection runs so far. The next time a detection cycle finds a genuinely new fingerprint,
check `SELECT * FROM alert_delivery WHERE trigger_type='on_raise' ORDER BY created_at DESC LIMIT 10`
to verify automatic delivery rows were written and their statuses.
