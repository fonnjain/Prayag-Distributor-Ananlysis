import { Router, type Request } from "express";
import { pool } from "@workspace/db";
import { requireAdmin, writeAudit } from "../lib/auth.js";
import { loadDeepDiveData } from "../lib/mgmt/deepDiveData.js";
import { normSecKey } from "../lib/mgmt/names.js";
import {
  canonicalMonthLabel,
  forwardMonthChoices,
  aggregateStateHeadMonthPace,
  plannerTargetInputMetadata,
} from "../lib/mgmt/visitPlan.js";
import {
  inferVisitCompletion,
  retailerIdentity,
  sourceSnapshotForMember,
  sourceSnapshotHash,
} from "../lib/mgmt/visitPlanPersistence.js";

const router = Router();
const FY_RE = /^\d{4}-\d{2}$/;

function queryText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetJson(row: Record<string, any>): Record<string, unknown> {
  return {
    id: row.id,
    planId: row.plan_id,
    retailerIdentity: row.retailer_identity,
    retailerName: row.retailer_name,
    district: row.district,
    distanceKm: row.distance_km === null ? null : Number(row.distance_km),
    priorityType: row.priority_type,
    priorityScore: row.priority_score === null ? null : Number(row.priority_score),
    defaultedInputs: row.defaulted_inputs,
    inputStates: row.input_states,
    inputReasons: row.input_reasons,
    businessPlan: row.business_plan === null ? null : Number(row.business_plan),
    orderBooking: row.order_booking === null ? null : Number(row.order_booking),
    visitsDone: row.visits_done,
    visitsRequired: row.visits_required,
    reason: row.reason,
    status: row.status,
    visitedOn: row.visited_on,
    orderValueAfter: row.order_value_after === null ? null : Number(row.order_value_after),
    completionBasis: row.completion_basis,
    baselineTotalVisit: row.baseline_total_visit,
    currentTotalVisit: row.current_total_visit,
    baselineObservedAt: row.baseline_observed_at,
    currentObservedAt: row.current_observed_at,
    baselineOrderBooking: row.baseline_order_booking === null ? null : Number(row.baseline_order_booking),
    currentOrderBooking: row.current_order_booking === null ? null : Number(row.current_order_booking),
    supersedesTargetId: row.supersedes_target_id,
    supersededByTargetId: row.superseded_by_target_id,
    evidence: row.evidence,
  };
}

function planJson(row: Record<string, any>, targets?: Record<string, any>[]): Record<string, unknown> {
  return {
    id: row.id,
    member: row.member,
    stateHead: row.state_head,
    fy: row.fy,
    month: row.month,
    generatedAt: row.generated_at,
    generatedFrom: row.generated_from,
    sourceSnapshotHash: row.source_snapshot_hash,
    sourceSnapshotAt: row.source_snapshot_at,
    sourceSnapshot: row.source_snapshot,
    capacity: row.capacity,
    workingDays: row.working_days,
    maintenanceBudget: row.maintenance_budget,
    developmentBudget: row.development_budget,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    poolExhausted: row.pool_exhausted,
    excludedCount: row.excluded_count,
    excludedReason: row.excluded_reason,
    supersededBy: row.superseded_by,
    supersedesPlanId: row.supersedes_plan_id,
    createdBy: row.created_by,
    targets: (targets ?? row.targets ?? []).map((target: Record<string, any>) => targetJson(target)),
  };
}

function currentPlanQuery(member: string | null, fy: string, month: string | null, params: unknown[]) {
  const where = ["p.fy = $1"];
  params.push(fy);
  if (member) { params.push(normSecKey(member)); where.push(`p.member_norm = lower(regexp_replace($${params.length}, '[^a-zA-Z0-9]', '', 'g'))`); }
  if (month) { params.push(month); where.push(`p.month = $${params.length}`); }
  return where.join(" AND ");
}

router.get("/ai-plan", async (req, res): Promise<void> => {
  const fy = queryText(req.query.fy) ?? "2026-27";
  if (!FY_RE.test(fy)) { res.status(400).json({ error: "fy must be YYYY-YY" }); return; }
  const member = queryText(req.query.member);
  const rawMonth = queryText(req.query.month);
  const month = rawMonth ? canonicalMonthLabel(fy, rawMonth) : null;
  if (rawMonth && !month) {
    res.status(400).json({ error: "month must be a fiscal month such as Apr-26 or Apr 26 for the requested FY", validMonths: forwardMonthChoices(fy) });
    return;
  }
  const params: unknown[] = [];
  try {
    const plans = await pool.query(
      `SELECT p.*, COALESCE(json_agg(t ORDER BY t.priority_score DESC NULLS LAST, t.id)
        FILTER (WHERE t.id IS NOT NULL), '[]') AS targets
         FROM visit_plan p LEFT JOIN visit_plan_target t ON t.plan_id = p.id
        WHERE ${currentPlanQuery(member, fy, month, params)}
        GROUP BY p.id ORDER BY p.generated_at DESC`,
      params,
    );
    const history = plans.rows.map((row) => planJson(row, row.targets));
    const includeHistory = ["1", "true", "all"].includes(String(req.query.history ?? "").toLowerCase());
    res.json({
      fy, member, month,
      plans: includeHistory ? history : history.filter((plan) => plan.status !== "superseded"),
      revisionHistory: history,
      currentPlanId: history.find((plan) => plan.status !== "superseded")?.id ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "ai-plan current plans failed");
    res.status(500).json({ error: "Unable to load visit plans" });
  }
});

router.get("/ai-plan/months", async (req, res): Promise<void> => {
  const fy = queryText(req.query.fy) ?? "2026-27";
  if (!FY_RE.test(fy)) { res.status(400).json({ error: "fy must be YYYY-YY" }); return; }
  const months = forwardMonthChoices(fy);
  res.json({ fy, months, canonicalFormat: "Mon YY", acceptedFormats: ["Apr-26", "Apr 26", "April 26"] });
});

router.get("/ai-plan/analytics", async (req, res): Promise<void> => {
  const fy = queryText(req.query.fy) ?? "2026-27";
  if (!FY_RE.test(fy)) { res.status(400).json({ error: "fy must be YYYY-YY" }); return; }
  try {
    const result = await pool.query(
      `WITH current_plan_ids AS (
         SELECT id
           FROM (
             SELECT p.id,
                    ROW_NUMBER() OVER (
                       PARTITION BY p.member_norm, p.fy, p.month
                      ORDER BY p.generated_at DESC, p.id DESC
                    ) AS current_revision
               FROM visit_plan p
              WHERE p.fy = $1 AND p.status <> 'superseded'
           ) ranked
          WHERE current_revision = 1
       )
       SELECT p.member, p.state_head, p.fy, p.month, p.status, p.capacity, p.working_days,
              p.maintenance_budget, p.development_budget, p.source_snapshot_hash,
              p.source_snapshot, p.generated_at,
              COUNT(t.id) FILTER (WHERE t.status IN ('proposed','planned'))::int AS planned,
              COUNT(t.id) FILTER (WHERE t.status = 'proposed')::int AS proposed,
              COUNT(t.id) FILTER (WHERE t.status = 'planned')::int AS operational_planned,
              COUNT(t.id) FILTER (WHERE t.status = 'visited')::int AS visited,
              COUNT(t.id) FILTER (WHERE t.status = 'not_visited')::int AS not_visited,
              COUNT(t.id) FILTER (WHERE jsonb_array_length(t.defaulted_inputs) > 0)::int AS defaulted_targets,
              COUNT(t.id) FILTER (WHERE t.defaulted_inputs ? 'businessPlan'
                                      AND t.defaulted_inputs ? 'distanceKm')::int AS defaulted_rank_targets
       FROM visit_plan p
       JOIN current_plan_ids current_plan ON current_plan.id = p.id
       LEFT JOIN visit_plan_target t ON t.plan_id = p.id
      GROUP BY p.id ORDER BY p.generated_at DESC`,
      [fy],
    );
    const figures = result.rows.map((row) => {
      const source = row.source_snapshot ?? {};
      const pattern = source.pattern ?? {};
      const capacity = source.capacity ?? {};
      const rows = Array.isArray(source.rows) ? source.rows : [];
      const neverVisited = rows.filter((r: any) => r.totalVisit === 0);
      const dormant = rows.filter((r: any) => !r.isActive);
      const excluded = rows.filter((r: any) => !r.distributor).map((r: any) => ({
        retailer: r.name,
        reason: "retailer has no assigned distributor",
      }));
      return {
        ...row,
        paceVisitsDone: pattern.totalVisitsDone ?? null,
        paceProRatedRequired: pattern.proRatedRequired ?? null,
        paceDeficit: pattern.visitDeficit ?? null,
        capacityGap: capacity.gap ?? null,
        demonstratedRate: capacity.demonstratedVisitsPerDay ?? null,
        demonstratedRateNumerator: pattern.totalVisitsDone ?? null,
        demonstratedRateDenominator: capacity.demonstratedRateDenominator ?? null,
        demonstratedRateDenominatorAuthority: capacity.demonstratedRateDenominatorAuthority ?? "calendar fallback",
        coverageNeverVisitedCount: neverVisited.length,
        coverageNeverVisitedRanking: neverVisited
          .sort((a: any, b: any) => plannerTargetInputMetadata(b).priorityScore
            - plannerTargetInputMetadata(a).priorityScore)
          .slice(0, 20)
          .map((r: any) => {
            const metadata = plannerTargetInputMetadata(r);
            return {
              retailer: r.name,
              district: r.district,
              businessPlan: r.businessPlan,
              distanceKm: r.distanceKm,
              ...metadata,
            };
          }),
        dormantCount: dormant.length,
        dormantRetailers: dormant.map((r: any) => ({ retailer: r.name, district: r.district })),
        excludedRetailerCount: excluded.length,
        excludedRetailers: excluded,
        sourceDenominator: "member-sheet source snapshot",
        demonstratedRateAuthority: capacity.demonstratedRateDenominatorAuthority ?? "calendar fallback",
      };
    });
    const stateHeads = aggregateStateHeadMonthPace(result.rows.map((row) => {
      const source = row.source_snapshot ?? {};
      return {
        stateHead: row.state_head,
        month: row.month,
        sourceSnapshotHash: row.source_snapshot_hash ?? null,
        pattern: source.pattern ?? {},
        capacity: source.capacity ?? {},
      };
    }));
    res.json({
      fy,
      figures,
      stateHeads,
      note: "Pace, coverage, dormant, and exclusions are computed from the persisted authoritative member-sheet snapshot. Defaults are ranking inputs only and never contribute to count totals.",
    });
  } catch (err) {
    req.log.error({ err }, "ai-plan analytics failed");
    res.status(500).json({ error: "Unable to load visit-plan analytics" });
  }
});

async function generatePlan(req: Request, res: any, supersede = false, requestedPreviousId: number | null = null): Promise<void> {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const fy = typeof body.fy === "string" ? body.fy : "2026-27";
  const member = typeof body.member === "string" ? body.member.trim() : "";
  const stateHead = typeof body.stateHead === "string" ? body.stateHead.trim() : null;
  const requestedMonthInput = typeof body.month === "string" ? body.month.trim() : null;
  if (!FY_RE.test(fy) || !member) { res.status(400).json({ error: "member and fy (YYYY-YY) are required" }); return; }
  const requestedMonth = requestedMonthInput ? canonicalMonthLabel(fy, requestedMonthInput) : null;
  if (requestedMonthInput && !requestedMonth) {
    res.status(400).json({ error: "month must be a fiscal month such as Apr-26 or Apr 26 for the requested FY", validMonths: forwardMonthChoices(fy) });
    return;
  }

  const data = await loadDeepDiveData(fy, stateHead ?? undefined, normSecKey(member), { skipExtras: true });
  if (!data.kpis || data.retailerDetail?.status !== "ok") {
    res.status(404).json({ error: "Member sheet data is unavailable; no plan was persisted." }); return;
  }
  const detail = data.retailerDetail;
  if (detail.rows.length === 0) {
    res.status(422).json({
      error: "Visit plan not persisted: member source returned no retailer rows.",
      reason: "A plan requires authoritative member-sheet rows.",
      unavailableCounts: detail.visitPlan.unavailableCounts,
    });
    return;
  }
  const selectedMonth = requestedMonth
    ? detail.visitPlan.monthPlans.find((p) => p.month === requestedMonth)
    : detail.visitPlan.monthPlans[0];
  if (!selectedMonth) {
    res.status(409).json({
      error: "Requested month is closed or not a forward month for this source observation",
      month: requestedMonth,
      validMonths: detail.visitPlan.monthPlans.map((p) => p.month),
    });
    return;
  }
  if (selectedMonth.targets.length === 0) {
    res.status(422).json({ error: "No safe visit targets can be built for the requested forward month", month: selectedMonth.month });
    return;
  }

  const observedAt = detail.sourceObservedAt;
  const snapshot = sourceSnapshotForMember(data.kpis.name, fy, detail, observedAt);
  const hash = sourceSnapshotHash(snapshot);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let previousPlan: Record<string, any> | null = null;
    const previousTargets = new Map<string, { id: number; status: string }>();
    if (supersede) {
      const previous = await client.query(
        `SELECT * FROM visit_plan WHERE id = $1 AND status <> 'superseded' FOR UPDATE`,
        [requestedPreviousId],
      );
      previousPlan = previous.rows[0] ?? null;
      if (!previousPlan) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "The plan was already superseded; regenerate the current revision instead." });
        return;
      }
      const oldTargets = await client.query(
         `SELECT id, retailer_identity, status FROM visit_plan_target WHERE plan_id = $1 FOR UPDATE`,
        [previousPlan.id],
      );
      for (const oldTarget of oldTargets.rows) {
        previousTargets.set(oldTarget.retailer_identity, { id: oldTarget.id, status: oldTarget.status });
      }
      // Free the current-revision slot before inserting the replacement.
      await client.query(
        `UPDATE visit_plan SET status = 'superseded' WHERE id = $1`,
        [previousPlan.id],
      );
    }
    const inserted = await client.query(
      `INSERT INTO visit_plan
        (member, member_norm, state_head, fy, month, generated_from, source_snapshot_hash,
         source_snapshot_at, source_snapshot, capacity, working_days,
         maintenance_budget, development_budget, status, pool_exhausted, excluded_count,
         excluded_reason, created_by, supersedes_plan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'proposed',$14,$15,$16,$17,$18)
       RETURNING *`,
      [data.kpis.name, normSecKey(data.kpis.name), data.kpis.stateHead ?? stateHead, fy, selectedMonth.month,
       `member sheet:${detail.tabName}`, hash, observedAt, snapshot,
       selectedMonth.capacity, selectedMonth.workingDays, selectedMonth.maintenanceVisits,
        selectedMonth.developmentVisits, selectedMonth.poolExhausted,
       detail.visitPlan.unassignedExcluded,
       detail.visitPlan.unassignedExcluded > 0 ? "retailer has no assigned distributor" : null,
       req.authUser?.displayName ?? req.authUser?.email ?? null,
       previousPlan?.id ?? null],
    );
    const plan = inserted.rows[0];
    const rowsByIdentity = new Map(detail.rows.map((row) => [retailerIdentity(row.name, row.district), row]));
    for (const target of selectedMonth.targets) {
      const identity = retailerIdentity(target.name, target.district);
      const row = rowsByIdentity.get(identity);
      const insertedTarget = await client.query(
        `INSERT INTO visit_plan_target
          (plan_id, retailer_identity, retailer_name, district, distance_km,
           priority_type, priority_score, defaulted_inputs, input_states,
            input_reasons, business_plan, order_booking, visits_done, visits_required, reason,
            supersedes_target_id,
           status, baseline_total_visit, baseline_order_booking, baseline_observed_at, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,
                 'proposed',$17,$18,$19,$20::jsonb)
         RETURNING id`,
        [plan.id, identity, target.name, target.district, target.distanceKm,
         target.priority, target.priorityScore, JSON.stringify(target.defaultedInputs),
         JSON.stringify(target.inputStates), JSON.stringify(target.inputReasons),
          target.businessPlan, target.ob, row?.totalVisit ?? null,
          target.effectiveInputs.visitsRequired, target.reason,
          previousTargets.get(identity)?.status === "proposed" || previousTargets.get(identity)?.status === "planned"
            ? previousTargets.get(identity)!.id
            : null,
          row?.totalVisit ?? null, row?.orderBooking ?? null, observedAt,
          JSON.stringify({
            source: detail.tabName,
            inference: "not_started",
            sourceSnapshotHash: hash,
          })],
      );
      if (previousTargets.get(identity)?.status === "proposed" || previousTargets.get(identity)?.status === "planned") {
        await client.query(
          `UPDATE visit_plan_target SET superseded_by_target_id = $2, status = 'superseded'
            WHERE id = $1 AND status IN ('proposed','planned')`,
          [previousTargets.get(identity)!.id, insertedTarget.rows[0].id],
        );
      }
    }
    if (previousPlan) {
      await client.query(
        `UPDATE visit_plan
            SET status = 'superseded', superseded_by = $2
          WHERE id = $1`,
        [previousPlan.id, plan.id],
      );
      await client.query(
          `UPDATE visit_plan_target SET status = 'superseded'
           WHERE plan_id = $1 AND status IN ('proposed','planned')
             AND superseded_by_target_id IS NULL`,
        [previousPlan.id],
      );
    }
    await writeAudit(client, supersede ? "visit_plan_regenerated" : "visit_plan_generated",
      req, req.authUser?.id ?? null, null, { planId: plan.id, sourceSnapshotHash: hash });
    await client.query(
      `INSERT INTO visit_plan_audit (plan_id, event, actor_id, after_state, evidence)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [plan.id, supersede ? "regenerated" : "generated", String(req.authUser?.id ?? ""),
       JSON.stringify({ status: "proposed" }), JSON.stringify({ sourceSnapshotHash: hash })],
    );
    await client.query("COMMIT");
    res.status(201).json({ plan: planJson(plan, []), targetCount: selectedMonth.targets.length, sourceSnapshotHash: hash });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ err }, "ai-plan generation failed");
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A current visit plan already exists for this member, fiscal year, and month; regenerate that revision instead." });
      return;
    }
    res.status(500).json({ error: "Unable to persist visit plan" });
  } finally { client.release(); }
}

router.post("/ai-plan/generate", async (req, res): Promise<void> => {
  try { await generatePlan(req, res, false); }
  catch (err) { req.log.error({ err }, "ai-plan source generation failed"); res.status(502).json({ error: "Unable to read member sheet" }); }
});

router.post("/ai-plan/:id/regenerate", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid plan id" }); return; }
  const found = await pool.query("SELECT fy, member, state_head, month FROM visit_plan WHERE id = $1", [id]);
  if (!found.rows[0]) { res.status(404).json({ error: "Plan not found" }); return; }
  req.body = { ...req.body, fy: found.rows[0].fy, member: found.rows[0].member, stateHead: found.rows[0].state_head, month: found.rows[0].month };
  try { await generatePlan(req, res, true, id); }
  catch (err) { req.log.error({ err }, "ai-plan regeneration failed"); res.status(502).json({ error: "Unable to regenerate visit plan" }); }
});

router.post("/ai-plan/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid plan id" }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE visit_plan SET status = 'approved', approved_by = $2, approved_at = now()
        WHERE id = $1 AND status = 'proposed' RETURNING *`,
      [id, req.authUser?.displayName ?? req.authUser?.email ?? "administrator"],
    );
    if (!result.rows[0]) { await client.query("ROLLBACK"); res.status(409).json({ error: "Plan is missing or is not proposed" }); return; }
    await client.query(
      "UPDATE visit_plan_target SET status = 'planned' WHERE plan_id = $1 AND status = 'proposed'",
      [id],
    );
    await writeAudit(client, "visit_plan_approved", req, req.authUser?.id ?? null, null, { planId: id });
    await client.query(`INSERT INTO visit_plan_audit (plan_id,event,actor_id,after_state)
      VALUES ($1,'approved',$2,$3::jsonb)`, [id, String(req.authUser?.id ?? ""), JSON.stringify({ status: "approved" })]);
    const targetCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM visit_plan_target WHERE plan_id = $1",
      [id],
    );
    await client.query("COMMIT");
    res.json({
      plan: planJson(result.rows[0], []),
      targetCount: targetCount.rows[0]?.count ?? 0,
      sourceSnapshotHash: result.rows[0].source_snapshot_hash,
    });
  } catch (err) { await client.query("ROLLBACK").catch(() => undefined); req.log.error({ err }, "ai-plan approval failed"); res.status(500).json({ error: "Unable to approve visit plan" }); }
  finally { client.release(); }
});

router.post("/ai-plan/:id/reconcile", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const plan = await pool.query("SELECT * FROM visit_plan WHERE id = $1 AND status = 'approved'", [id]);
  if (!plan.rows[0]) { res.status(404).json({ error: "Approved plan not found" }); return; }
  const p = plan.rows[0];
  const data = await loadDeepDiveData(p.fy, p.state_head ?? undefined, normSecKey(p.member), { skipExtras: true });
  if (data.retailerDetail?.status !== "ok") { res.status(502).json({ error: "Member sheet unavailable; completion was not inferred" }); return; }
  const observedAt = data.retailerDetail.sourceObservedAt;
  const current = new Map(data.retailerDetail.rows.map((row) => [retailerIdentity(row.name, row.district), row]));
  const currentSourceHash = sourceSnapshotHash({
    member: p.member,
    fy: p.fy,
    rows: data.retailerDetail.rows,
  });
  const targets = await pool.query("SELECT * FROM visit_plan_target WHERE plan_id = $1 AND status = 'planned'", [id]);
  const client = await pool.connect();
  let visited = 0;
  try {
    await client.query("BEGIN");
    for (const target of targets.rows) {
      const completion = inferVisitCompletion({
        retailerIdentity: target.retailer_identity,
        baselineTotalVisit: target.baseline_total_visit,
        baselineObservedAt: target.baseline_observed_at,
        baselineOrderBooking: target.baseline_order_booking,
        baselineSourceSnapshotHash: target.evidence?.sourceSnapshotHash ?? null,
      }, current.get(target.retailer_identity) ?? null, observedAt, observedAt.slice(0, 10),
        currentSourceHash, p.month);
      if (completion.status === "visited") {
        visited++;
        await client.query(
          `UPDATE visit_plan_target
              SET status='visited', visited_on=$2, order_value_after=$3,
                  completion_basis=$4, current_total_visit=$5,
                  current_order_booking=$6, current_observed_at=$7, evidence=$8::jsonb
            WHERE id=$1 AND status='planned'`,
          [target.id, completion.visitedOn, completion.orderValueAfter, completion.completionBasis,
           completion.evidence.currentTotalVisit, completion.evidence.currentOrderBooking,
           observedAt, JSON.stringify({ ...completion.evidence, sourceSnapshotHash: currentSourceHash })],
        );
      } else if (completion.status === "not_visited") {
        await client.query(
          `UPDATE visit_plan_target
              SET status='not_visited', current_total_visit=$2,
                  current_order_booking=$3, current_observed_at=$4, evidence=$5::jsonb
            WHERE id=$1 AND status='planned'`,
          [target.id, completion.evidence.currentTotalVisit,
           completion.evidence.currentOrderBooking, observedAt,
           JSON.stringify({ ...completion.evidence, sourceSnapshotHash: currentSourceHash })],
        );
      } else {
        await client.query(
          `UPDATE visit_plan_target
              SET current_total_visit=$2, current_order_booking=$3,
                  current_observed_at=$4, evidence=$5::jsonb
            WHERE id=$1 AND status='planned'`,
          [target.id, completion.evidence.currentTotalVisit,
           completion.evidence.currentOrderBooking, observedAt,
           JSON.stringify({ ...completion.evidence, sourceSnapshotHash: currentSourceHash })],
        );
      }
    }
    await writeAudit(client, "visit_plan_reconciled", req, req.authUser?.id ?? null, null, {
      planId: id,
      visited,
      considered: targets.rowCount,
      inference: "stable retailer identity + cumulative totalVisit increase",
    });
    await client.query("COMMIT");
    res.json({ planId: id, visited, considered: targets.rowCount, inference: "inferred from stable retailer identity and cumulative totalVisit increase; not confirmed attendance" });
  } catch (err) { await client.query("ROLLBACK").catch(() => undefined); req.log.error({ err }, "ai-plan reconcile failed"); res.status(500).json({ error: "Unable to reconcile visit plan" }); }
  finally { client.release(); }
});

router.get("/ai-plan/:id/plan-vs-actual", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid plan id" }); return; }
  const result = await pool.query(
    `SELECT p.member, p.fy, p.month, priority_type, COUNT(*)::int planned,
            COUNT(*) FILTER (WHERE status='visited')::int visited,
            COUNT(*) FILTER (WHERE status='not_visited')::int not_visited,
            COUNT(*) FILTER (WHERE status='visited' AND order_value_after > 0)::int visited_with_order,
            COUNT(*) FILTER (WHERE status='visited' AND COALESCE(order_value_after,0) = 0)::int visited_no_order,
            COALESCE(SUM(order_value_after) FILTER (WHERE status='visited'),0) AS order_value_after,
            COALESCE(SUM(
              CASE WHEN status='visited' AND current_order_booking IS NOT NULL
                THEN GREATEST(0, current_order_booking - COALESCE(baseline_order_booking,0))
                ELSE 0 END),0) AS order_value_delta
       FROM visit_plan p JOIN visit_plan_target t ON t.plan_id=p.id
      WHERE p.id=$1 GROUP BY p.member,p.fy,p.month,priority_type ORDER BY priority_type`,
    [id],
  );
  res.json({
    planId: id,
    member: result.rows[0]?.member ?? null,
    fy: result.rows[0]?.fy ?? null,
    month: result.rows[0]?.month ?? null,
    rows: result.rows,
    orderValueDelta: result.rows.reduce((sum, row) => sum + Number(row.order_value_delta ?? 0), 0),
    source: "visit_plan_target completion records; order delta is current minus baseline booking; visited status is inferred, not confirmed attendance",
  });
});

router.get("/ai-plan/:id/export", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const result = await pool.query(
    `SELECT p.member,p.fy,p.month,p.status,t.retailer_name,t.district,t.priority_type,
            t.priority_score,t.business_plan,t.distance_km,t.visits_done,t.status AS target_status,
            t.visited_on,t.order_value_after,t.completion_basis,t.defaulted_inputs
       FROM visit_plan p JOIN visit_plan_target t ON t.plan_id=p.id WHERE p.id=$1 ORDER BY t.priority_score DESC NULLS LAST`,
    [id],
  );
  if (!result.rows.length) { res.status(404).json({ error: "Plan not found" }); return; }
  const keys = Object.keys(result.rows[0]);
  const csv = [keys.join(","), ...result.rows.map((row) => keys.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
  res.type("text/csv").attachment(`visit-plan-${id}.csv`).send(csv);
});

export default router;
