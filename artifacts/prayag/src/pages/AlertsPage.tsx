// Alerts page — shows all active Red Alerts in two ranked sections.
//
// Layout:
//   • C5 data-blackout banner at top (if any)
//   • Salespeople section (A1/A2/A3) — ranked by ₹ at stake
//   • Customers section (B*/C*/S1) — ranked by ₹ at stake
//   • Cards capped at 20; "N further alerts — ₹X Cr combined" below
//   • Empty state: plain "No open alerts." text, no graphic
//
// Acknowledge requires the admin secret (same as other admin pages in the app).
// The secret is cached in sessionStorage under "adminSecret" once entered.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import {
  AlertTriangle, Bell, ChevronDown, ChevronUp, X, CheckCircle2, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ──────────────────────────────────────────────────────────────────

type AlertCard = {
  id: number;
  fingerprint: string;
  fy: string;
  code: string;
  entity: string;
  entityKey: string;
  entityType: string;
  periodLabel: string;
  status: "open" | "acknowledged" | "cleared";
  periodsOpen: number;
  rupeesAtStake: number;
  detail: {
    numbers?: Record<string, number | string | null>;
    extraForReport?: Record<string, number | string | null> | null;
    currentMonths?: string[];
    priorMonths?: string[];
    entity?: string;
  };
  guardsPassed: string[];
  suppressedBy: number | null;
  linkedAlertId: number | null;
  clearReason: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedBy: string | null;
  acknowledgedNote: string | null;
  acknowledgedAt: string | null;
};

type AlertSection = {
  cards: AlertCard[];
  hiddenCount: number;
  hiddenRupees: number;
};

type AlertsPayload = {
  dataBlackouts: AlertCard[];
  salespeople: AlertSection;
  customers: AlertSection;
  totalOpen: number;
  totalAcknowledged: number;
  lastDetectionAt: string | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtCr(rupees: number): string {
  const cr = rupees / 1e7;
  if (cr >= 1) return `₹${cr.toFixed(2)} Cr`;
  const lakh = rupees / 1e5;
  if (lakh >= 1) return `₹${lakh.toFixed(1)} L`;
  return `₹${Math.round(rupees).toLocaleString("en-IN")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

const CODE_COLORS: Record<string, string> = {
  A1: "bg-amber-100 text-amber-800 border border-amber-300",
  A2: "bg-red-100 text-red-800 border border-red-300",
  A3: "bg-orange-100 text-orange-800 border border-orange-300",
  B1: "bg-blue-100 text-blue-800 border border-blue-300",
  B2: "bg-blue-100 text-blue-800 border border-blue-300",
  B3: "bg-red-100 text-red-800 border border-red-300",
  B4: "bg-purple-100 text-purple-800 border border-purple-300",
  B5: "bg-purple-100 text-purple-800 border border-purple-300",
  C1: "bg-orange-100 text-orange-800 border border-orange-300",
  C2: "bg-orange-100 text-orange-800 border border-orange-300",
  C3: "bg-amber-100 text-amber-800 border border-amber-300",
  C4: "bg-indigo-100 text-indigo-800 border border-indigo-300",
  C5: "bg-slate-100 text-slate-800 border border-slate-400",
  S1: "bg-teal-100 text-teal-800 border border-teal-300",
};

const CODE_LABELS: Record<string, string> = {
  A1: "Below Target",
  A2: "Zero Booking",
  A3: "Team Slippage",
  B1: "Real Decline",
  B2: "Sustained Decline",
  B3: "Stopped Buying",
  B4: "Segment Dropout",
  B5: "SKU Breadth Drop",
  C1: "Concentration Risk",
  C2: "State Decline",
  C3: "Segment Under-Index",
  C4: "Margin Squeeze",
  C5: "Data Blackout",
  S1: "Destocking",
};

const CODE_ACTIONS: Record<string, string> = {
  A1: "Review with member — check booking pipeline and customer coverage gaps.",
  A2: "Urgent: member has no bookings this period. Escalate immediately.",
  A3: "State head review required — multiple team members below threshold.",
  B1: "Distributor real growth lagging after MRP increase. Review pricing strategy.",
  B2: "Sustained nominal decline. Investigate channel conflict or competitor entry.",
  B3: "Customer has completely stopped buying. Immediate relationship intervention needed.",
  B4: "Key segment has gone to zero. Check product availability and competitor activity.",
  B5: "SKU breadth collapsed by half or more. Review assortment and placement.",
  C1: "High-concentration customer declining. Territory risk is concentrated.",
  C2: "State-level territory decline sustained across two periods. Regional review needed.",
  C3: "Segment growing below company rate. Check segment-specific promotions.",
  C4: "Volume up but gross contribution down. Review pricing, discounts, or mix shift.",
  C5: "Secondary data sheet has not been read recently. Check sheet access and sync.",
  S1: "Distributor stopped buying primary but secondary sell-through continues — stock depletion risk.",
};

// ── Acknowledge modal ──────────────────────────────────────────────────────

function AckModal({
  alert,
  onClose,
  onSuccess,
}: {
  alert: AlertCard;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [byPerson, setByPerson] = useState("");
  const [note, setNote] = useState("");
  const [secret, setSecret] = useState<string>(
    () => sessionStorage.getItem("adminSecret") ?? "",
  );
  const [secretInput, setSecretInput] = useState("");
  const qc = useQueryClient();

  const isAuthed = secret.length > 0;

  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = secretInput.trim();
    if (s) {
      setSecret(s);
      sessionStorage.setItem("adminSecret", s);
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/alerts/${alert.id}/acknowledge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Secret": secret,
        },
        body: JSON.stringify({ by_person: byPerson.trim(), note: note.trim() || undefined }),
      });
      if (res.status === 401) {
        // Secret was rejected; clear the cached value
        sessionStorage.removeItem("adminSecret");
        setSecret("");
        throw new Error("Admin secret was rejected. Please re-enter it.");
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Request failed");
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["alerts"] });
      void qc.invalidateQueries({ queryKey: ["alerts-count"] });
      onSuccess();
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-md p-6 mx-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-base">Acknowledge alert</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold mr-1.5", CODE_COLORS[alert.code])}>
                {alert.code}
              </span>
              {alert.entity}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Admin secret gate — matches pattern used in DevMasters / OrgPeople pages */}
        {!isAuthed ? (
          <form onSubmit={handleAuthSubmit} className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Acknowledging an alert requires the admin secret (SESSION_SECRET).
            </p>
            <div>
              <label className="text-sm font-medium">Admin secret *</label>
              <input
                type="password"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                placeholder="Enter admin secret…"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors">Cancel</button>
              <button type="submit" disabled={!secretInput.trim()} className="flex-1 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">Unlock</button>
            </div>
          </form>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium">Your name *</label>
                <input
                  type="text"
                  value={byPerson}
                  onChange={(e) => setByPerson(e.target.value)}
                  placeholder="e.g. Anant Singh"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Note (optional)</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="What action was taken or why this is being acknowledged…"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>
              {mutation.error && (
                <p className="text-sm text-destructive">{String(mutation.error.message)}</p>
              )}
            </div>

            <div className="flex gap-2 mt-5">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!byPerson.trim() || mutation.isPending}
                onClick={() => mutation.mutate()}
                className="flex-1 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Acknowledge
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Alert card ─────────────────────────────────────────────────────────────

type DeliveryRow = {
  id: number;
  alert_id: number;
  recipient_id: number;
  recipient_name: string;
  channel: string;
  escalation_level: number;
  trigger_type: string;
  status: "pending" | "sent" | "failed" | "skipped";
  skip_reason: string | null;
  sent_at: string | null;
  acknowledged_at: string | null;
  created_at: string;
};

const CHANNEL_BADGE: Record<string, string> = {
  in_app: "bg-blue-50 text-blue-700",
  email: "bg-green-50 text-green-700",
  whatsapp: "bg-purple-50 text-purple-700",
};

const STATUS_BADGE: Record<string, string> = {
  sent: "bg-green-50 text-green-700",
  pending: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-muted text-muted-foreground",
};

function AlertCardView({
  card,
  allCards,
  onAck,
}: {
  card: AlertCard;
  allCards: AlertCard[];
  onAck: (card: AlertCard) => void;
}) {
  const [guardsOpen, setGuardsOpen] = useState(false);
  const [retailersOpen, setRetailersOpen] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);

  const { data: deliveriesData, isLoading: deliveriesLoading } = useQuery<{
    deliveries: DeliveryRow[];
  }>({
    queryKey: ["alert-deliveries", card.id],
    queryFn: () =>
      fetch(`${BASE}/api/alerts/${card.id}/deliveries`).then((r) => r.json()),
    enabled: deliveriesOpen,
    staleTime: 60_000,
  });

  const isAcknowledged = card.status === "acknowledged";
  const isLongOpen = card.periodsOpen >= 3;

  // Get linked alert (for B3+S1 merged display)
  const linkedCard = card.linkedAlertId
    ? allCards.find((c) => c.id === card.linkedAlertId)
    : null;

  // B3 retailer list
  const retailerList: string[] = (() => {
    const raw = card.detail.extraForReport?.retailers;
    if (typeof raw === "string" && raw.length > 0) return raw.split(",");
    return [];
  })();

  const numbers = card.detail.numbers ?? {};

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4 transition-all",
        isAcknowledged && "opacity-60",
        isLongOpen && !isAcknowledged && "border-amber-400",
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <span
            className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold flex-shrink-0 mt-0.5",
              CODE_COLORS[card.code] ?? "bg-muted text-muted-foreground",
            )}
          >
            {card.code}
          </span>
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">{card.entity}</p>
            <p className="text-xs text-muted-foreground">{CODE_LABELS[card.code] ?? card.code}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {card.rupeesAtStake > 0 && (
            <span className="text-sm font-semibold text-destructive">
              {fmtCr(card.rupeesAtStake)}
            </span>
          )}
          {isLongOpen && !isAcknowledged && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300">
              OPEN {card.periodsOpen} PERIODS
            </span>
          )}
        </div>
      </div>

      {/* Key figures from detail */}
      {Object.keys(numbers).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(numbers)
            .filter(([, v]) => v != null && v !== "")
            .slice(0, 4)
            .map(([k, v]) => (
              <span key={k} className="text-xs text-muted-foreground">
                <span className="font-medium capitalize">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span>:{" "}
                {typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toFixed(2)) : String(v)}
              </span>
            ))}
        </div>
      )}

      {/* Linked alert (B3 + S1) */}
      {linkedCard && (
        <div className="mt-2 rounded-md bg-teal-50 border border-teal-200 px-2.5 py-1.5 text-xs text-teal-800">
          Linked:{" "}
          <span className={cn("inline-flex items-center rounded px-1 py-0.5 text-xs font-bold mr-1", CODE_COLORS[linkedCard.code])}>
            {linkedCard.code}
          </span>
          {linkedCard.entity} — {fmtCr(linkedCard.rupeesAtStake)}
        </div>
      )}

      {/* B3 retailer list expansion */}
      {card.code === "B3" && retailerList.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setRetailersOpen((o) => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {retailersOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {retailerList.length} stopped retailer{retailerList.length !== 1 ? "s" : ""}
          </button>
          {retailersOpen && (
            <div className="mt-1.5 pl-3 border-l border-border/50 space-y-0.5">
              {retailerList.slice(0, 30).map((r) => (
                <p key={r} className="text-xs text-muted-foreground truncate">{r}</p>
              ))}
              {retailerList.length > 30 && (
                <p className="text-xs text-muted-foreground">…and {retailerList.length - 30} more</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Suggested action */}
      {CODE_ACTIONS[card.code] && (
        <p className="mt-2 text-xs text-muted-foreground italic">
          {CODE_ACTIONS[card.code]}
        </p>
      )}

      {/* Footer: dates + acknowledge */}
      <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>First: {fmtDate(card.firstSeenAt)}</span>
          <span>Last: {fmtDate(card.lastSeenAt)}</span>
          <span>{card.periodLabel}</span>
        </div>

        {isAcknowledged ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-xs text-green-700">
            <CheckCircle2 className="h-3 w-3" />
            Acknowledged by {card.acknowledgedBy ?? "—"}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onAck(card)}
            className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
          >
            Acknowledge
          </button>
        )}
      </div>

      {/* Footer toggles row: guards + notifications */}
      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
        {card.guardsPassed.length > 0 && (
          <button
            type="button"
            onClick={() => setGuardsOpen((o) => !o)}
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {guardsOpen ? "hide guards" : "guards ✓"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setDeliveriesOpen((o) => !o)}
          className="underline underline-offset-2 hover:text-foreground transition-colors"
        >
          {deliveriesOpen ? "hide notifications" : "notifications"}
        </button>
      </div>

      {/* Guards expandable */}
      {guardsOpen && card.guardsPassed.length > 0 && (
        <div className="mt-2 pl-3 border-l border-border/50">
          <p className="text-xs font-medium text-muted-foreground mb-1">Guards passed:</p>
          <div className="flex flex-wrap gap-1">
            {card.guardsPassed.map((g) => (
              <span key={g} className="text-[10px] bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5">
                {g}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Delivery log */}
      {deliveriesOpen && (
        <div className="mt-2 pl-3 border-l border-border/50">
          <p className="text-xs font-medium text-muted-foreground mb-1.5">Notification log:</p>
          {deliveriesLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : !deliveriesData?.deliveries?.length ? (
            <p className="text-xs text-muted-foreground">No deliveries recorded yet.</p>
          ) : (
            <div className="space-y-1">
              {deliveriesData.deliveries.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="font-medium text-foreground">{d.recipient_name}</span>
                  <span className={cn("rounded px-1 py-0.5 font-medium", CHANNEL_BADGE[d.channel] ?? "bg-muted text-muted-foreground")}>
                    {d.channel}
                  </span>
                  <span className="text-muted-foreground">L{d.escalation_level}</span>
                  <span className="text-muted-foreground capitalize">{d.trigger_type.replace(/_/g, " ")}</span>
                  <span className={cn("rounded px-1 py-0.5 font-medium", STATUS_BADGE[d.status] ?? "bg-muted text-muted-foreground")}>
                    {d.status}
                  </span>
                  {d.skip_reason && (
                    <span className="text-muted-foreground italic">— {d.skip_reason}</span>
                  )}
                  {d.sent_at && (
                    <span className="text-muted-foreground">{fmtDate(d.sent_at)}</span>
                  )}
                  {d.acknowledged_at && (
                    <span className="text-green-600">acked {fmtDate(d.acknowledged_at)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section ────────────────────────────────────────────────────────────────

function AlertSection({
  title,
  section,
  allCards,
  onAck,
}: {
  title: string;
  section: AlertSection;
  allCards: AlertCard[];
  onAck: (card: AlertCard) => void;
}) {
  if (section.cards.length === 0 && section.hiddenCount === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
        {title} — {section.cards.length + section.hiddenCount} alert{section.cards.length + section.hiddenCount !== 1 ? "s" : ""}
      </h2>
      <div className="space-y-3">
        {section.cards.map((card) => (
          <AlertCardView key={card.id} card={card} allCards={allCards} onAck={onAck} />
        ))}
      </div>
      {section.hiddenCount > 0 && (
        <p className="mt-2 text-sm text-muted-foreground pl-1">
          {section.hiddenCount} further alert{section.hiddenCount !== 1 ? "s" : ""} — {fmtCr(section.hiddenRupees)} combined
        </p>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function AlertsPage() {
  const [ackTarget, setAckTarget] = useState<AlertCard | null>(null);

  const { data, isLoading, error } = useQuery<AlertsPayload>({
    queryKey: ["alerts"],
    queryFn: () => fetch(`${BASE}/api/alerts`).then((r) => r.json()),
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Failed to load alerts: {String(error ?? "Unknown error")}</p>
      </div>
    );
  }

  const allCards = [
    ...(data.dataBlackouts ?? []),
    ...(data.salespeople?.cards ?? []),
    ...(data.customers?.cards ?? []),
  ];

  const hasAnyAlert =
    (data.dataBlackouts?.length ?? 0) > 0 ||
    (data.salespeople?.cards?.length ?? 0) > 0 ||
    (data.salespeople?.hiddenCount ?? 0) > 0 ||
    (data.customers?.cards?.length ?? 0) > 0 ||
    (data.customers?.hiddenCount ?? 0) > 0;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Red Alerts</h1>
          {data.totalOpen > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs font-bold w-5 h-5">
              {data.totalOpen}
            </span>
          )}
        </div>
        {data.lastDetectionAt && (
          <p className="text-xs text-muted-foreground">
            Last run: {fmtDate(data.lastDetectionAt)}
          </p>
        )}
      </div>

      {/* Empty state */}
      {!hasAnyAlert && (
        <p className="text-sm text-muted-foreground">No open alerts.</p>
      )}

      {/* C5 data-blackout banner */}
      {data.dataBlackouts.length > 0 && (
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-slate-600 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-slate-800">
              Data Blackout — {data.dataBlackouts.length} member{data.dataBlackouts.length !== 1 ? "s" : ""}
            </h3>
          </div>
          <p className="text-xs text-slate-600 mb-3">
            Secondary data sheets have not been read recently for the following members.
            Performance alerts for their teams are suppressed until data resumes.
          </p>
          <div className="space-y-2">
            {data.dataBlackouts.map((card) => (
              <div key={card.id} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold", CODE_COLORS["C5"])}>
                    C5
                  </span>
                  <span className="text-sm font-medium">{card.entity}</span>
                  {card.detail.extraForReport?.stateHead && (
                    <span className="text-xs text-muted-foreground">
                      ({String(card.detail.extraForReport.stateHead)})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {card.detail.numbers?.daysSinceRead != null
                      ? `${card.detail.numbers.daysSinceRead} days`
                      : "—"}
                  </span>
                  {card.status !== "acknowledged" && (
                    <button
                      type="button"
                      onClick={() => setAckTarget(card)}
                      className="rounded border px-2 py-0.5 text-xs hover:bg-muted transition-colors"
                    >
                      Ack
                    </button>
                  )}
                  {card.status === "acknowledged" && (
                    <span className="text-xs text-green-600">Acked by {card.acknowledgedBy}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Salespeople section */}
      <AlertSection
        title="Salespeople"
        section={data.salespeople}
        allCards={allCards}
        onAck={setAckTarget}
      />

      {/* Customers section */}
      <AlertSection
        title="Customers"
        section={data.customers}
        allCards={allCards}
        onAck={setAckTarget}
      />

      {/* Acknowledge modal */}
      {ackTarget && (
        <AckModal
          alert={ackTarget}
          onClose={() => setAckTarget(null)}
          onSuccess={() => setAckTarget(null)}
        />
      )}
    </div>
  );
}
