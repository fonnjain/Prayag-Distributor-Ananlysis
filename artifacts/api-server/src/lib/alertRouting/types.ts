export type Recipient = {
  id: number;
  alertCodePattern: string;
  scopeType: "state_head" | "all";
  scopeValue: string | null;
  escalationLevel: 1 | 2;
  name: string;
  channel: "whatsapp" | "email" | "in_app";
  contact: string | null;
  cadence: "on_raise" | "weekly";
  isActive: boolean;
};

export type SeverityConfig = {
  codePattern: string;
  isSevere: boolean;
  escalationWindowDays: number;
};

export type DeliveryRow = {
  id: number;
  alertId: number;
  recipientId: number;
  recipientName: string;
  channel: string;
  escalationLevel: number;
  triggerType: string;
  status: "pending" | "sent" | "failed" | "skipped";
  skipReason: string | null;
  messageBody: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type AlertRow = {
  id: number;
  code: string;
  entity: string;
  entityKey: string;
  entityType: string;
  periodLabel: string;
  status: "open" | "acknowledged" | "cleared";
  periodsOpen: number;
  rupeesAtStake: number;
  firstSeenAt: string;
  lastSeenAt: string;
  fy: string;
  detail: Record<string, unknown>;
};
