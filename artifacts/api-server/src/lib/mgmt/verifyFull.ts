// Comprehensive multi-anchor-set data-health verification.
//
// Anchor Sets:
//   1 — Secondary order booking (delegates to lib/mgmt/verify.ts)
//   2 — Primary sale register (queries sale_line DB)
//   3 — Targets (reads Target Master sheet, checks Q1 total + ratio)
//   6 — Source health (probes each configured spreadsheet)
//
// Set 4 (Sunil Patel report logic) deferred; Set 5 (cross-foots) surfaces
// via Set 1 and 2 total vs per-head checks.
import verifyAnchorsJson from "../../../config/verify_anchors.json";
import { db, saleLines } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { runVerify, hasVerifyAnchors } from "./verify.js";
import { loadTargetsForFy } from "./targets.js";
import { listSheetTabs } from "../registers/sheetsApi.js";
import { normHead } from "./names.js";
import { logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "warn" | "fail" | "skip" | "pending";

export type HealthCheck = {
  key: string;
  label: string;
  unit: "money" | "count" | "pct" | "text";
  expected: number | null;
  actual: number | null;
  deltaPct: number | null;
  status: CheckStatus;
  note?: string;
};

export type CheckGroup = {
  id: string;
  label: string;
  available: boolean;
  pendingNote?: string;
  checks: HealthCheck[];
};

export type FullVerifyReport = {
  fy: string;
  overall: "pass" | "warn" | "fail";
  groups: CheckGroup[];
  computedAt: string;
};

// ── Anchor config types ────────────────────────────────────────────────────────

type Tolerances = {
  moneyPassPct: number;
  countPassPct: number;
  memberCountAbs: number;
  coverageMinPct: number;
};

type PrimaryFyAnchor = {
  total: number;
  perHead: Record<string, number>;
};

type TargetFyAnchor = {
  q1SecondaryTargetTotal?: number;
  targetMonthlyRatio?: number;
  memberAchievements?: Record<string, number>;
  companyAchievementPct?: number;
  companySecondaryTarget?: number;
};

type SourceEntry = {
  key: string;
  label: string;
  spreadsheetId: string;
  type: string;
  folderId?: string;
  pendingExpected: boolean;
  pendingNote?: string;
};

type Anchors = {
  tolerances: Tolerances;
  fy_anchors: Record<string, unknown>;
  primary_anchors: Record<string, unknown>;
  target_anchors: Record<string, unknown>;
  source_list: SourceEntry[];
};

// Statically imported — cwd-relative reads break in production.
const anchors = verifyAnchorsJson as unknown as Anchors;
const tol = anchors.tolerances;

// ── Check factories ────────────────────────────────────────────────────────────

function moneyCheck(
  key: string,
  label: string,
  expected: number,
  actual: number,
  note?: string,
): HealthCheck {
  const deltaPct = expected === 0 ? null : ((actual - expected) / expected) * 100;
  let status: CheckStatus = "fail";
  if (deltaPct != null) {
    const abs = Math.abs(deltaPct);
    if (abs <= tol.moneyPassPct) status = "pass";
    else if (abs <= tol.moneyPassPct * 2) status = "warn";
  }
  return { key, label, unit: "money", expected, actual, deltaPct, status, note };
}

function countCheck(
  key: string,
  label: string,
  expected: number,
  actual: number,
  note?: string,
): HealthCheck {
  const deltaPct = expected === 0 ? null : ((actual - expected) / expected) * 100;
  let status: CheckStatus = "fail";
  if (deltaPct != null) {
    const abs = Math.abs(deltaPct);
    if (abs <= tol.countPassPct) status = "pass";
    else if (abs <= tol.countPassPct * 2) status = "warn";
  }
  return { key, label, unit: "count", expected, actual, deltaPct, status, note };
}

// ── Set 1: Secondary order booking ────────────────────────────────────────────

async function runSecondarySet(fy: string): Promise<CheckGroup> {
  if (!hasVerifyAnchors(fy)) {
    return {
      id: "secondary",
      label: "Secondary Order Booking",
      available: false,
      pendingNote: `No approved anchors configured for ${fy}.`,
      checks: [],
    };
  }
  try {
    const legacy = await runVerify(fy);
    const checks: HealthCheck[] = (legacy.checks ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      unit: c.unit as "money" | "count" | "pct",
      expected: c.expected,
      actual: c.actual,
      deltaPct: c.deltaPct,
      status: c.status as CheckStatus,
    }));
    return {
      id: "secondary",
      label: "Secondary Order Booking",
      available: legacy.available ?? false,
      pendingNote: legacy.available ? undefined : "Secondary order booking file not yet loaded.",
      checks,
    };
  } catch (err) {
    logger.warn({ err, fy }, "verifyFull: secondary set threw");
    return {
      id: "secondary",
      label: "Secondary Order Booking",
      available: false,
      pendingNote: "Verification threw an error.",
      checks: [],
    };
  }
}

// ── Set 2: Primary sale register (DB) ─────────────────────────────────────────

async function runPrimarySet(fy: string): Promise<CheckGroup> {
  const fyAnchor = anchors.primary_anchors[fy] as PrimaryFyAnchor | undefined;

  try {
    // Total dispatch for this FY from sale_line
    const totalRows = await db
      .select({
        total: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      })
      .from(saleLines)
      .where(eq(saleLines.fy, fy));
    const totalActual = Math.round(totalRows[0]?.total ?? 0);

    if (!fyAnchor) {
      return {
        id: "primary",
        label: "Primary Sale Register (Dispatch)",
        available: true,
        checks: [
          {
            key: `primary_total_${fy}`,
            label: `Total Dispatch (${fy}) — ${totalActual === 0 ? "no rows" : (totalActual / 1e7).toFixed(2) + " Cr"}`,
            unit: "money",
            expected: null,
            actual: totalActual,
            deltaPct: null,
            status: totalActual === 0 ? "warn" : "skip",
            note: totalActual === 0
              ? "No rows in sale_line for this FY — run the backfill."
              : "No anchor configured for this FY.",
          },
        ],
      };
    }

    const checks: HealthCheck[] = [
      moneyCheck(
        `primary_total_${fy}`,
        `Total Dispatch (${fy})`,
        fyAnchor.total,
        totalActual,
      ),
    ];

    // Per-head checks when anchors are defined
    if (Object.keys(fyAnchor.perHead ?? {}).length > 0) {
      const headRows = await db
        .select({
          head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
          total: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
        })
        .from(saleLines)
        .where(eq(saleLines.fy, fy))
        .groupBy(sql`1`);

      const byNorm = new Map<string, number>();
      const byDisplay = new Map<string, number>();
      for (const row of headRows) {
        const key = normHead(row.head);
        byNorm.set(key, Math.round(row.total));
        byDisplay.set(row.head, Math.round(row.total));
      }

      for (const [headDisplay, expectedAmt] of Object.entries(fyAnchor.perHead)) {
        const nk = normHead(headDisplay);
        const actual =
          byDisplay.get(headDisplay) ??
          byNorm.get(nk) ??
          0;
        const isBijuCanary = headDisplay === "Biju C.O";
        checks.push(
          moneyCheck(
            `primary_head_${nk}_${fy}`,
            `${headDisplay} Dispatch (${fy})`,
            expectedAmt,
            actual,
            isBijuCanary
              ? "CANARY — if actual is 0, the BIJJU->Biju C.O alias in head normalisation is broken."
              : undefined,
          ),
        );
      }
    }

    return { id: "primary", label: "Primary Sale Register (Dispatch)", available: true, checks };
  } catch (err) {
    logger.warn({ err, fy }, "verifyFull: primary set failed");
    return {
      id: "primary",
      label: "Primary Sale Register (Dispatch)",
      available: false,
      pendingNote: "DB query failed — database may be unavailable.",
      checks: [],
    };
  }
}

// ── Set 3: Targets ─────────────────────────────────────────────────────────────

async function runTargetsSet(fy: string): Promise<CheckGroup> {
  const fyAnchor = anchors.target_anchors[fy] as TargetFyAnchor | undefined;

  if (!fyAnchor) {
    return {
      id: "targets",
      label: "Targets",
      available: false,
      pendingNote: `No target anchors configured for ${fy}.`,
      checks: [],
    };
  }

  try {
    const targetMap = await loadTargetsForFy(fy);
    const checks: HealthCheck[] = [];

    // Q1 secondary target total and monthly/annual ratio
    if (fyAnchor.q1SecondaryTargetTotal != null) {
      let q1Total = 0;
      let annualCount = 0;
      let monthlyCount = 0;
      for (const t of targetMap.values()) {
        for (let m = 0; m < 3; m++) {
          const mv = t.monthly.secondary[m];
          const av = t.annual.secondary;
          if (mv != null) {
            q1Total += mv;
            monthlyCount++;
          } else if (av != null) {
            q1Total += av / 12;
            annualCount++;
          }
        }
      }

      checks.push(
        moneyCheck(
          "target_q1_total",
          `Q1 Secondary Target Total (${fy})`,
          fyAnchor.q1SecondaryTargetTotal,
          q1Total,
          targetMap.size === 0
            ? "Target master returned 0 members — sheet may be empty or unreadable."
            : undefined,
        ),
      );

      // Ratio check: Q1 = 3 months. If annual targets are misread as monthly,
      // the sum is annual × 3 (≈ 12×monthly × 3) instead of monthly × 3.
      if (fyAnchor.targetMonthlyRatio != null && fyAnchor.q1SecondaryTargetTotal > 0) {
        // Approximate average monthly value by dividing Q1 total by 3
        const avgMonthly = q1Total / 3;
        // If all members have monthly targets: avgMonthly ≈ target_per_person/month
        // Annual/12 gives same result, so ratio between Q1 and a single month is always 3.
        // We detect the bug by checking ratio of Q1 total to anchor/ratio
        const anchorMonthly = fyAnchor.q1SecondaryTargetTotal / fyAnchor.targetMonthlyRatio;
        const ratio = anchorMonthly > 0 ? q1Total / anchorMonthly : null;
        if (ratio != null) {
          const expectedRatio = fyAnchor.targetMonthlyRatio;
          const ratioOk = Math.abs(ratio - expectedRatio) < 1;
          checks.push({
            key: "target_monthly_ratio",
            label: `Target Monthly Ratio (${fy}) — should be ${expectedRatio}, bug shows ~12`,
            unit: "count",
            expected: expectedRatio,
            actual: Math.round(ratio * 10) / 10,
            deltaPct: null,
            status: ratioOk ? "pass" : "fail",
            note: `${monthlyCount} monthly slots, ${annualCount} annual/12 slots. Ratio ~12 = annual targets loaded as monthly.`,
          });
        }
      }
    }

    // Company achievement % — skip (requires full assembled report)
    if (fyAnchor.companyAchievementPct != null) {
      checks.push({
        key: "target_company_ach",
        label: `Company Achievement (${fy}) vs ${fyAnchor.companySecondaryTarget != null ? (fyAnchor.companySecondaryTarget / 1e7).toFixed(0) + " Cr" : "??"} target`,
        unit: "pct",
        expected: fyAnchor.companyAchievementPct * 100,
        actual: null,
        deltaPct: null,
        status: "skip",
        note: "Requires full report assembly. Check via State Head Dashboard.",
      });
    }

    return { id: "targets", label: "Targets", available: true, checks };
  } catch (err) {
    logger.warn({ err, fy }, "verifyFull: targets set failed");
    return {
      id: "targets",
      label: "Targets",
      available: false,
      pendingNote: "Target master read failed — sheet may be temporarily unavailable.",
      checks: [],
    };
  }
}

// ── Set 6: Source health ───────────────────────────────────────────────────────

type SourceProbeResult = { status: "ok" | "not_shared" | "not_found" | "empty" | "error"; detail: string };

async function probeSheet(spreadsheetId: string): Promise<SourceProbeResult> {
  try {
    const tabs = await listSheetTabs(spreadsheetId);
    if (tabs.length === 0) return { status: "empty", detail: "Accessible but no tabs found." };
    return { status: "ok", detail: `${tabs.length} tab${tabs.length === 1 ? "" : "s"} accessible.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b403\b/.test(msg)) return { status: "not_shared", detail: "403 — not shared with service account." };
    if (/\b404\b/.test(msg)) return { status: "not_found", detail: "404 — sheet ID wrong or deleted." };
    return { status: "error", detail: msg.slice(0, 120) };
  }
}

async function runSourceHealthSet(): Promise<CheckGroup> {
  const checks: HealthCheck[] = await Promise.all(
    anchors.source_list.map(async (src): Promise<HealthCheck> => {
      const key = `source_${src.key}`;

      if (src.pendingExpected) {
        return {
          key,
          label: src.label,
          unit: "text",
          expected: null,
          actual: null,
          deltaPct: null,
          status: "pending",
          note: src.pendingNote ?? "Expected unavailable — known gap.",
        };
      }

      if (!src.spreadsheetId || src.type === "folder_scan") {
        return {
          key,
          label: src.label,
          unit: "text",
          expected: null,
          actual: null,
          deltaPct: null,
          status: "skip",
          note: "Folder-scan source — use the Data Sources tab for Drive folder status.",
        };
      }

      const result = await probeSheet(src.spreadsheetId);
      const status: CheckStatus =
        result.status === "ok"
          ? "pass"
          : result.status === "not_shared" || result.status === "not_found"
            ? "fail"
            : result.status === "empty"
              ? "warn"
              : "fail";

      return {
        key,
        label: src.label,
        unit: "text",
        expected: null,
        actual: null,
        deltaPct: null,
        status,
        note: result.detail,
      };
    }),
  );

  const ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2, skip: 3, pending: 4 };
  checks.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));

  return { id: "source_health", label: "Source Health", available: true, checks };
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function runFullVerify(fy: string): Promise<FullVerifyReport> {
  const [secondary, primary, targets, sourceHealth] = await Promise.all([
    runSecondarySet(fy),
    runPrimarySet(fy),
    runTargetsSet(fy),
    runSourceHealthSet(),
  ]);

  const groups: CheckGroup[] = [secondary, primary, targets, sourceHealth];
  const allChecks = groups.flatMap((g) => g.checks);

  const overall: "pass" | "warn" | "fail" = allChecks.some((c) => c.status === "fail")
    ? "fail"
    : allChecks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";

  return { fy, overall, groups, computedAt: new Date().toISOString() };
}
