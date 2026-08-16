/**
 * Channel dispatch interface.
 *
 * Three channels are defined:
 *   in_app    — records the delivery row; the notification bell already reflects
 *               the open alert count.  No external call.
 *   email     — sends via Resend HTTP API when RESEND_API_KEY is set (preferred);
 *               falls back to nodemailer + SMTP when SMTP_HOST is set;
 *               records a failed delivery row if neither is configured.
 *   whatsapp  — records the delivery row as status=pending with skip_reason
 *               "no provider configured".  Never transmits.  When a provider
 *               is chosen it drops in behind this interface unchanged.
 */

import { logger } from "../logger.js";

export type ChannelResult = {
  status: "pending" | "sent" | "failed" | "skipped";
  skipReason: string | null;
};

/**
 * Dispatch a prepared message to the given channel.
 *
 * @param channel  'in_app' | 'email' | 'whatsapp'
 * @param contact  phone or email address (null / unused for in_app)
 * @param body     rendered message body (always stored for audit)
 * @param dryRun   if true, never transmit; record delivery as 'sent' (dry run)
 * @param opts     optional: override the email subject line
 */
export async function dispatch(
  channel: "in_app" | "email" | "whatsapp",
  contact: string | null,
  body: string,
  dryRun: boolean,
  opts?: { subject?: string },
): Promise<ChannelResult> {
  if (dryRun) {
    logger.info(
      { channel, contact: contact ?? "(in_app)", bodyLength: body.length },
      "[alertRouting] dry-run — message body prepared, not transmitted",
    );
    if (channel === "whatsapp") {
      return { status: "pending", skipReason: "no provider configured" };
    }
    return { status: "sent", skipReason: "dry run" };
  }

  switch (channel) {
    case "in_app":
      return { status: "sent", skipReason: null };

    case "email": {
      const subject = opts?.subject ?? "Prayag Alerts";
      const from = process.env["RESEND_FROM"] ?? "onboarding@resend.dev";

      // ── Option 1: Resend HTTP API (preferred — no SMTP setup needed) ──────
      const resendKey = process.env["RESEND_API_KEY"];
      if (resendKey) {
        try {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from,
              to: [contact ?? ""],
              subject,
              text: body,
            }),
          });
          if (resp.ok) {
            logger.info({ channel: "email", contact, provider: "resend" }, "[alertRouting] email sent via Resend");
            return { status: "sent", skipReason: null };
          }
          const errBody = await resp.text().catch(() => "");
          const reason = `Resend ${resp.status}: ${errBody.slice(0, 200)}`;
          logger.error({ channel: "email", contact, reason }, "[alertRouting] Resend email failed");
          return { status: "failed", skipReason: reason };
        } catch (err) {
          const reason = `Resend fetch error: ${String(err)}`;
          logger.error({ err, channel: "email", contact }, "[alertRouting] Resend fetch error");
          return { status: "failed", skipReason: reason };
        }
      }

      // ── Option 2: nodemailer + SMTP fallback ──────────────────────────────
      const host = process.env["SMTP_HOST"];
      if (host) {
        try {
          const nodemailer = await import("nodemailer" as any);
          const transporter = nodemailer.createTransport({
            host,
            port: Number(process.env["SMTP_PORT"] ?? 587),
            auth: process.env["SMTP_USER"]
              ? { user: process.env["SMTP_USER"], pass: process.env["SMTP_PASS"] }
              : undefined,
          });
          await transporter.sendMail({
            from: process.env["SMTP_FROM"] ?? "alerts@prayag",
            to: contact ?? "",
            subject,
            text: body,
          });
          logger.info({ channel: "email", contact, provider: "smtp" }, "[alertRouting] email sent via SMTP");
          return { status: "sent", skipReason: null };
        } catch (err) {
          logger.error({ err, channel: "email", contact }, "[alertRouting] SMTP send failed");
          return { status: "failed", skipReason: String(err) };
        }
      }

      // ── No provider configured ─────────────────────────────────────────────
      logger.warn({ channel: "email", contact }, "[alertRouting] no email provider — set RESEND_API_KEY or SMTP_HOST");
      return { status: "failed", skipReason: "no email provider configured (set RESEND_API_KEY or SMTP_HOST)" };
    }

    case "whatsapp":
      logger.info({ contact }, "[alertRouting] whatsapp: no provider configured — delivery row written as pending");
      return { status: "pending", skipReason: "no provider configured" };
  }
}

/**
 * Send a one-off test email to verify the email provider is working.
 * Returns the channel result directly without writing a delivery row.
 */
export async function sendTestEmail(to: string, subject: string, body: string): Promise<ChannelResult> {
  return dispatch("email", to, body, false, { subject });
}
