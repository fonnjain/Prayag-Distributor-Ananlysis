import type { AlertRow } from "./types.js";

function fmtCr(rupees: number): string {
  if (rupees === 0) return "₹0";
  const cr = rupees / 1e7;
  if (cr >= 1) return `₹${cr.toFixed(2)} Cr`;
  return `₹${(rupees / 1e5).toFixed(1)} L`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function renderOnRaiseBody(alert: AlertRow, recipientName: string): string {
  const isSevere =
    alert.code.startsWith("S") ||
    alert.code.startsWith("C") ||
    alert.code === "B3";

  const numbers = (alert.detail as Record<string, unknown>).numbers as
    | Record<string, unknown>
    | undefined;
  const extra = (alert.detail as Record<string, unknown>).extraForReport as
    | Record<string, unknown>
    | undefined;

  const numLines = numbers
    ? Object.entries(numbers)
        .filter(([, v]) => v != null && v !== "")
        .slice(0, 6)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")
    : "";

  return [
    `🔴 Red Alert — ${alert.code} [${isSevere ? "SEVERE" : "ALERT"}]`,
    `Recipient: ${recipientName}`,
    `Entity: ${alert.entity}`,
    alert.rupeesAtStake > 0 ? `₹ at stake: ${fmtCr(alert.rupeesAtStake)}` : "",
    `Period: ${alert.periodLabel}`,
    `Raised: ${fmtDate(alert.firstSeenAt)}`,
    numLines ? `\nDetail:\n${numLines}` : "",
    extra?.stateHead ? `State Head: ${String(extra.stateHead)}` : "",
    "",
    "This is an automated alert from Prayag Sales Intelligence.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function renderEscalationBody(
  alert: AlertRow,
  recipientName: string,
  daysSinceRaised: number,
): string {
  return [
    `⚠️ ESCALATION — ${alert.code} unacknowledged for ${daysSinceRaised} days`,
    `Recipient (Level 2): ${recipientName}`,
    `Entity: ${alert.entity}`,
    alert.rupeesAtStake > 0 ? `₹ at stake: ${fmtCr(alert.rupeesAtStake)}` : "",
    `Period: ${alert.periodLabel}`,
    `Originally raised: ${fmtDate(alert.firstSeenAt)}`,
    `Days open: ${daysSinceRaised}`,
    "",
    "Level 1 has not acknowledged this alert within the escalation window.",
    "Level 1 still holds this alert and should continue to act on it.",
    "",
    "This is an automated escalation from Prayag Sales Intelligence.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function renderDigestBody(
  recipientName: string,
  scope: string,
  sections: {
    newAlerts: AlertRow[];
    stillOpen: AlertRow[];
    cleared: AlertRow[];
    escalating: Array<{ alert: AlertRow; daysSinceRaised: number }>;
  },
): string {
  const date = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const alertLine = (a: AlertRow, extra?: string) =>
    `  • [${a.code}] ${a.entity} — ${fmtCr(a.rupeesAtStake)} at stake` +
    (extra ? ` — ${extra}` : "");

  const lines: string[] = [
    `🔴 Red Alert Weekly Digest — ${date}`,
    `Recipient: ${recipientName}`,
    scope ? `Scope: ${scope}` : "",
    "",
    `NEW ALERTS (${sections.newAlerts.length}):`,
    ...(sections.newAlerts.length === 0
      ? ["  (none)"]
      : sections.newAlerts.map((a) => alertLine(a))),
    "",
    `STILL OPEN (${sections.stillOpen.length}):`,
    ...(sections.stillOpen.length === 0
      ? ["  (none)"]
      : sections.stillOpen.map((a) =>
          alertLine(a, `OPEN ${a.periodsOpen} PERIOD${a.periodsOpen !== 1 ? "S" : ""}`),
        )),
    "",
    `CLEARED (${sections.cleared.length}):`,
    ...(sections.cleared.length === 0
      ? ["  (none)"]
      : sections.cleared.map((a) => alertLine(a))),
  ];

  if (sections.escalating.length > 0) {
    lines.push(
      "",
      `ESCALATING TO YOU (${sections.escalating.length}):`,
      ...sections.escalating.map(
        ({ alert: a, daysSinceRaised }) =>
          `  • [${a.code}] ${a.entity} — raised ${fmtDate(a.firstSeenAt)}, ${daysSinceRaised} days open, still unacknowledged`,
      ),
    );
  }

  lines.push(
    "",
    "This is an automated digest from Prayag Sales Intelligence.",
  );

  return lines.join("\n");
}
