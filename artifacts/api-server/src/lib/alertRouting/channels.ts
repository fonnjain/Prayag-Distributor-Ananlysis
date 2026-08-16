/**
 * Channel dispatch interface.
 *
 * Three channels are defined:
 *   in_app    — records the delivery row; the notification bell already reflects
 *               the open alert count.  No external call.
 *   email     — builds and transmits via nodemailer when SMTP_HOST is set;
 *               falls back to "no email provider configured" otherwise.
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
 * @param channel 'in_app' | 'email' | 'whatsapp'
 * @param contact phone or email address (null / unused for in_app)
 * @param body    rendered message body (always stored for audit)
 * @param dryRun  if true, never transmit; record delivery as 'sent' (dry run)
 */
export async function dispatch(
  channel: "in_app" | "email" | "whatsapp",
  contact: string | null,
  body: string,
  dryRun: boolean,
): Promise<ChannelResult> {
  if (dryRun) {
    logger.info(
      { channel, contact: contact ?? "(in_app)", bodyLength: body.length },
      "[alertRouting] dry-run — message body prepared, not transmitted",
    );
    // WhatsApp is always pending even in dry-run, to demonstrate the status.
    if (channel === "whatsapp") {
      return { status: "pending", skipReason: "no provider configured" };
    }
    // For email and in_app in dry-run, mark skip_reason so V9 can confirm
    // no real transmission occurred.
    return { status: "sent", skipReason: "dry run" };
  }

  switch (channel) {
    case "in_app":
      // The notification bell already reflects the open alert count.
      // Recording the delivery row is the full in-app action.
      return { status: "sent", skipReason: null };

    case "email": {
      const host = process.env["SMTP_HOST"];
      if (!host) {
        logger.warn(
          { channel: "email", contact },
          "[alertRouting] no SMTP provider configured — email delivery skipped",
        );
        return { status: "failed", skipReason: "no email provider configured" };
      }
      try {
        // Dynamic import so the server starts even when nodemailer is absent.
        const nodemailer = await import("nodemailer" as any);
        const transporter = nodemailer.createTransport({
          host,
          port: Number(process.env["SMTP_PORT"] ?? 587),
          auth:
            process.env["SMTP_USER"]
              ? { user: process.env["SMTP_USER"], pass: process.env["SMTP_PASS"] }
              : undefined,
        });
        await transporter.sendMail({
          from: process.env["SMTP_FROM"] ?? "alerts@prayag",
          to: contact ?? "",
          subject: "Prayag Red Alert",
          text: body,
        });
        logger.info({ channel: "email", contact }, "[alertRouting] email sent");
        return { status: "sent", skipReason: null };
      } catch (err) {
        logger.error({ err, channel: "email", contact }, "[alertRouting] email send failed");
        return { status: "failed", skipReason: String(err) };
      }
    }

    case "whatsapp":
      // No provider configured yet.  Write the delivery row as pending so it
      // is visible in the log with a readable reason.  Never silently skipped.
      logger.info(
        { contact },
        "[alertRouting] whatsapp: no provider configured — delivery row written as pending",
      );
      return { status: "pending", skipReason: "no provider configured" };
  }
}
