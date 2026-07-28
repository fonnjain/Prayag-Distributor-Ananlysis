// ── Anant Singh FY2026-27 YTD pack generator ─────────────────────────────────
//
// Generates the full pack (state head report, deck, member reports, suggestions,
// travel plans, performance reviews) by calling the live API at localhost:8080,
// then assembles HTML files and zips them.
//
// Run: pnpm --filter @workspace/api-server exec tsx src/pack-gen.ts
//
// Output: /tmp/Anant_Singh_FY2026-27_YTD_pack.zip

import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const API = "http://localhost:8080";
const FY = "2026-27";
const STATE_HEAD = "Anant Singh";
const PERIOD = "ytd";
const OUT = "/tmp/anant-pack";
const FOLDER = `Anant_Singh_FY${FY}_YTD`;
const ZIP = `/tmp/${FOLDER}.zip`;

// ── Shared HTML style (matches frontend AiReports.tsx PDF_BASE_STYLE) ────────

const CSS = `
  body { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; margin: 40px; line-height: 1.6; }
  .brand { color: #1d4ed8; font-weight: 700; font-size: 18px; margin-bottom: 2px; }
  .meta  { color: #64748b; font-size: 11px; margin-bottom: 4px; }
  .period-cover { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 4px;
                  padding: 8px 12px; font-size: 12px; color: #1e40af; margin-bottom: 4px; }
  .period-sep   { margin-bottom: 16px; }
  h2  { font-size: 15px; font-weight: 600; border-bottom: 1px solid #e2e8f0;
        padding-bottom: 4px; margin-top: 20px; color: #1e293b; }
  p   { margin: 6px 0; font-size: 13px; }
  .footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #e2e8f0;
            color: #94a3b8; font-size: 10px; }
  .watermark { background: #DC2626; color: white; text-align: center; padding: 6px;
               font-size: 11px; font-weight: 700; border-radius: 4px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 11px; }
  th    { padding: 4px 8px; background: #f1f5f9; border: 1px solid #cbd5e1; text-align: left; }
  td    { padding: 3px 8px; border: 1px solid #e2e8f0; }
`;

function periodCoverHtml(label: string, cutoff: string): string {
  return `<div class="period-cover">Coverage: ${label} &nbsp;·&nbsp; Data to ${cutoff} &nbsp;·&nbsp; FY${FY}</div><div class="period-sep"></div>`;
}
function footerHtml(label: string, cutoff: string, gen: string): string {
  return `<div class="footer">FY${FY} · ${label} · Data to ${cutoff} · Generated ${gen} · Figures are grounded in the verified payload.</div>`;
}
function page(title: string, meta: string, cover: string, body: string, foot: string, extra = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title><style>${CSS}${extra}</style></head><body>
  <div class="brand">Prayag India - Sales Intelligence</div>
  <div class="meta">${title} &middot; ${meta}</div>
  ${cover}${body}${foot}</body></html>`;
}

// ── POST helper ───────────────────────────────────────────────────────────────

async function post(path: string, body: object): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // @ts-ignore — Node 18 fetch does not support signal in all typings
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${path} → HTTP ${r.status}: ${txt}`);
  }
  return r.json() as Promise<Record<string, unknown>>;
}

// ── Section HTML helpers ──────────────────────────────────────────────────────

type Section = { title: string; body: string };

function sectionsHtml(sections: Record<string, Section>): string {
  return Object.values(sections)
    .map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

type SuggItem = {
  rank: number; title: string; metric: string;
  expectedEffect: string; action: string; effort: string;
};

function suggestionsHtml(intro: string, items: SuggItem[]): string {
  const cards = items.map((s) => `
    <div style="margin:10px 0;padding:10px;border:1px solid #e2e8f0;border-radius:4px;">
      <div style="font-weight:600;font-size:13px;">${s.rank}. ${s.title}
        <span style="margin-left:6px;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;
          background:${s.effort==="low"?"#D1FAE5":s.effort==="medium"?"#FEF3C7":"#FEE2E2"};
          color:${s.effort==="low"?"#065F46":s.effort==="medium"?"#92400E":"#991B1B"};">
          ${s.effort} effort</span></div>
      <p style="font-size:12px;margin:4px 0"><strong>Metric:</strong> ${s.metric}</p>
      <p style="font-size:12px;margin:4px 0"><strong>Expected effect:</strong> ${s.expectedEffect}</p>
      <p style="font-size:12px;margin-top:6px;"><strong>Action:</strong> ${s.action}</p>
    </div>`).join("");
  return `<h2>Introduction</h2><p>${intro}</p><h2>Ranked Suggestions</h2>${cards}`;
}

type MonthPlan = {
  month: string; workingDays: number; capacity: number;
  maintenanceVisits: number; developmentVisits: number;
  targets: { name: string; district?: string; distanceKm?: number; priority: string; reason: string }[];
};

function travelPlanHtml(sections: Record<string, Section>, monthPlans: MonthPlan[]): string {
  const monthHtml = monthPlans.map((mp) => `
    <h3 style="font-size:13px;margin-top:14px;color:#1e293b;">${mp.month} — ${mp.workingDays} working days,
      ${mp.capacity} visits (${mp.maintenanceVisits} maintenance, ${mp.developmentVisits} development)</h3>
    <table>
      <tr><th>Name</th><th>District</th><th>Dist km</th><th>Priority</th><th>Reason</th></tr>
      ${mp.targets.map((t) => `<tr>
        <td>${t.name}</td><td>${t.district ?? "—"}</td><td>${t.distanceKm ?? "—"}</td>
        <td>${t.priority}</td><td>${t.reason}</td></tr>`).join("")}
    </table>`).join("");
  return sectionsHtml(sections) + `<h2>Month-by-Month Visit Plan (App-Computed)</h2>${monthHtml}`;
}

// ── Write helper ──────────────────────────────────────────────────────────────

function writeHtml(relPath: string, html: string): void {
  const abs = join(OUT, FOLDER, relPath);
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, html, "utf8");
  console.log(`  wrote ${relPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`\nPrayag Pack Generator — ${STATE_HEAD} FY${FY} YTD`);
  console.log(`Output: ${ZIP}\n`);

  // Clean previous run
  if (existsSync(join(OUT, FOLDER))) rmSync(join(OUT, FOLDER), { recursive: true });
  mkdirSync(join(OUT, FOLDER), { recursive: true });

  // ── README ─────────────────────────────────────────────────────────────────
  const readme = `Prayag India — ${STATE_HEAD} FY${FY} YTD Pack
Generated: ${new Date().toISOString()}

WHY THE FIGURES DIFFER FROM THE PREVIOUS PACK
==============================================
Four bugs were fixed between the previous pack and this one.
None of the differences are performance changes.

1. Three LEFT members excluded (Jagdev, Shiv Kumar, Ravi Upadhyay)
   Previous pack: 13 members included, inflating aggregate figures.
   This pack: 10 active members only.
   Effect: achievement rises from 51.7% → 58.4% — this is ORGANISATIONAL, not commercial.

2. New-party order booking now included (+Rs 25.77 lakh, 11.7% of secondary)
   The secondaryOB field previously excluded newPartyOrderBooking.
   Effect: total OB rises by Rs 25.77 lakh across the team.

3. Removed retailers separated from active
   224 removed retailers no longer appear in the active retailer count.
   They now appear as "former retailers" labelled by last active year.

4. Period stamping added
   Every document now carries: period covered, data cutoff, and generation time.

Five head-canon aliases were also merged in the DB on the same day:
  Sandeep Ji → Sandeep Dadheech
  Rizvi Ji → Syed Aqil Rizvi
  Bijju → Biju C.O
  Lalan → Lalan Kumar
  Nasir Husain → Nasir Hussain Khan
Anant Singh was NEVER split. None of these changes affect this pack's figures.

ACCEPTANCE FIGURES (team, active-10 basis)
==========================================
Order booking:   Rs 2.35 Cr (Rs 23,549,308)
Sales received:  Rs 2.41 Cr
Target to date:  Rs 4.03 Cr
Achievement:     58.4%
Visits:          4,522 (dashboard col AF)
Retailers:       748 (dashboard col N)

Prasun Chatterjee (7-control verification):
  73 retailers, 34 active
  OB: Rs 26,21,109
  Sale: Rs 26,13,934
  395 visits against 1,704 required
  Top-5 share: 64.0%
  Effective retailers: 9.9
  Cost ratio: 5.94%

DEPARTED MEMBERS (no forward reports generated)
================================================
Jagdev, Shiv Kumar, Ravi Upadhyay — marked LEFT.
Their historical business is preserved in the State Head report.
No suggestions, visit plan, or performance review is generated for them.

PACK STRUCTURE
==============
00_README.txt                     — this file
01_state_head_report.html         — Anant Singh team report
02_deck.html                      — 27-slide team deck (HTML rendering)
members/<name>/
  <name>_report.html              — 6-section management report
  <name>_suggestions.html         — ranked improvement suggestions
  <name>_travel_plan.html         — visit plan with month-by-month schedule
  <name>_performance_review.html  — MANAGEMENT ONLY, requires sign-off

DATA CUTOFF: 30 June 2026
`;
  writeFileSync(join(OUT, FOLDER, "00_README.txt"), readme, "utf8");
  console.log("  wrote 00_README.txt");

  // ── 1. State Head Report ───────────────────────────────────────────────────
  console.log("\n[1/3] State Head Report...");
  const shReport = await post("/api/ai/statehead-report", {
    fy: FY, stateHead: STATE_HEAD, period: PERIOD,
  });
  {
    const sections = shReport.sections as Record<string, Section>;
    const cover = periodCoverHtml(shReport.periodCoveredLabel as string, shReport.dataCutoff as string);
    const foot  = footerHtml(shReport.periodCoveredLabel as string, shReport.dataCutoff as string, new Date().toLocaleString());
    const body  = sectionsHtml(sections);
    writeHtml("01_state_head_report.html",
      page(`State Head Report — ${STATE_HEAD}`, `FY${FY} | Active 10 members`, cover, body, foot));
  }

  // ── 2. Deck ────────────────────────────────────────────────────────────────
  console.log("[2/3] Deck (A4A 27-slide)...");
  const deck = await post("/api/ai/presentation", {
    fy: FY, stateHead: STATE_HEAD, period: PERIOD,
  });
  {
    const cover = periodCoverHtml(deck.periodCoveredLabel as string, deck.dataCutoff as string);
    const foot  = footerHtml(deck.periodCoveredLabel as string, deck.dataCutoff as string, new Date().toLocaleString());

    type TeamSlide   = { slideNumber: number; title: string; subtitle?: string; bullets: string[]; commentary: string; chartType: string; chartDataRef: string };
    type MemberSlide = { memberName: string; achievementBadge: string; bullets: string[]; commentary: string; unmapped: boolean };
    type ClosingSlide = TeamSlide;

    function renderSlides(slides: TeamSlide[], label: string): string {
      return slides.map((s) => `
        <div style="margin:16px 0;padding:14px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;">
          <div style="font-size:11px;color:#64748b;margin-bottom:2px;">${label} ${s.slideNumber ?? ""}</div>
          <h3 style="margin:0 0 4px 0;font-size:14px;">${s.title}</h3>
          ${s.subtitle ? `<div style="font-size:12px;color:#64748b;margin-bottom:6px;">${s.subtitle}</div>` : ""}
          <ul style="margin:6px 0;padding-left:18px;">${(s.bullets ?? []).map((b) => `<li style="font-size:12px;margin:2px 0;">${b}</li>`).join("")}</ul>
          ${s.commentary ? `<p style="font-size:12px;color:#475569;font-style:italic;margin-top:6px;">${s.commentary}</p>` : ""}
          ${s.chartType && s.chartType !== "none" ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">[Chart: ${s.chartType} — data: ${s.chartDataRef}]</div>` : ""}
        </div>`).join("");
    }

    const memberSlideHtml = ((deck.memberSlides ?? []) as MemberSlide[]).map((ms) => `
      <div style="margin:16px 0;padding:14px;border:2px solid ${ms.achievementBadge === "teal" ? "#99f6e4" : "#fde68a"};border-radius:6px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:14px;font-weight:600;">${ms.memberName}</span>
          <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;
            background:${ms.achievementBadge === "teal" ? "#99f6e4" : "#fde68a"};
            color:${ms.achievementBadge === "teal" ? "#065f46" : "#713f12"};">
            ${ms.achievementBadge === "teal" ? "On track" : "Below target"}</span>
          ${ms.unmapped ? `<span style="font-size:10px;color:#ef4444;">No member sheet</span>` : ""}
        </div>
        <ul style="margin:0;padding-left:18px;">${(ms.bullets ?? []).map((b) => `<li style="font-size:12px;margin:2px 0;">${b}</li>`).join("")}</ul>
        ${ms.commentary ? `<p style="font-size:12px;color:#475569;font-style:italic;margin-top:6px;">${ms.commentary}</p>` : ""}
      </div>`).join("");

    const body = `
      <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">${deck.deckTitle ?? ""}</h1>
      <p style="color:#475569;margin-bottom:20px;">${deck.deckSubtitle ?? ""}</p>
      <h2>Team Slides (1–11)</h2>
      ${renderSlides((deck.teamSlides ?? []) as TeamSlide[], "Slide")}
      <h2>Member Slides</h2>
      ${memberSlideHtml}
      <h2>Closing Slides (25–27)</h2>
      ${renderSlides((deck.closingSlides ?? []) as ClosingSlide[], "Slide")}
    `;
    writeHtml("02_deck.html",
      page(`Deck — ${STATE_HEAD}`, `FY${FY} | 27 slides`, cover, body, foot));
  }

  // ── 3. Per-member documents ───────────────────────────────────────────────
  // Get the member list (active only) from the state head report ranking
  const memberRanking = shReport.memberRanking as Array<{ name: string }>;
  if (!memberRanking?.length) {
    throw new Error("No members in memberRanking from state head report");
  }
  const activeMembers = memberRanking.map((m) => m.name);
  console.log(`\n[3/3] Generating docs for ${activeMembers.length} active members:\n  ${activeMembers.join(", ")}`);

  const DOC_TYPES = ["report", "suggestions", "travel-plan", "performance-review"] as const;

  // Process 2 members in parallel to avoid rate-limiting
  for (let i = 0; i < activeMembers.length; i += 2) {
    const batch = activeMembers.slice(i, i + 2);
    await Promise.all(batch.map(async (member) => {
      const safe = member.replace(/[/\\:*?"<>|]/g, "_");
      console.log(`  → ${member}...`);

      // All 4 doc types in parallel per member
      const [reportR, suggR, travelR, reviewR] = await Promise.allSettled([
        post("/api/ai/report",             { fy: FY, stateHead: STATE_HEAD, member, period: PERIOD }),
        post("/api/ai/suggestions",        { fy: FY, stateHead: STATE_HEAD, member, period: PERIOD }),
        post("/api/ai/travel-plan",        { fy: FY, stateHead: STATE_HEAD, member, period: PERIOD }),
        post("/api/ai/performance-review", { fy: FY, stateHead: STATE_HEAD, member, period: PERIOD }),
      ]);

      // Full report
      if (reportR.status === "fulfilled") {
        const r = reportR.value;
        const cover = periodCoverHtml(r.periodCoveredLabel as string, r.dataCutoff as string);
        const foot  = footerHtml(r.periodCoveredLabel as string, r.dataCutoff as string, new Date().toLocaleString());
        const body  = sectionsHtml(r.sections as Record<string, Section>);
        writeHtml(`members/${safe}/${safe}_report.html`,
          page(`Management Report — ${member}`, `FY${FY}`, cover, body, foot));
      } else {
        console.error(`    FAILED report for ${member}:`, reportR.reason);
      }

      // Suggestions
      if (suggR.status === "fulfilled") {
        const r = suggR.value;
        const cover = periodCoverHtml(r.periodCoveredLabel as string, r.dataCutoff as string);
        const foot  = footerHtml(r.periodCoveredLabel as string, r.dataCutoff as string, new Date().toLocaleString());
        const body  = suggestionsHtml(r.intro as string, r.suggestions as SuggItem[]);
        writeHtml(`members/${safe}/${safe}_suggestions.html`,
          page(`Suggestions — ${member}`, `FY${FY}`, cover, body, foot));
      } else {
        console.error(`    FAILED suggestions for ${member}:`, suggR.reason);
      }

      // Travel plan
      if (travelR.status === "fulfilled") {
        const r = travelR.value;
        const cover = periodCoverHtml(r.periodCoveredLabel as string, r.dataCutoff as string);
        const foot  = footerHtml(r.periodCoveredLabel as string, r.dataCutoff as string, new Date().toLocaleString());
        const body  = travelPlanHtml(r.sections as Record<string, Section>, r.monthPlans as MonthPlan[] ?? []);
        writeHtml(`members/${safe}/${safe}_travel_plan.html`,
          page(`Visit Plan — ${member}`, `FY${FY}`, cover, body, foot));
      } else {
        console.error(`    FAILED travel-plan for ${member}:`, travelR.reason);
      }

      // Performance review
      if (reviewR.status === "fulfilled") {
        const r = reviewR.value;
        const cover = periodCoverHtml(r.periodCoveredLabel as string, r.dataCutoff as string);
        const foot  = footerHtml(r.periodCoveredLabel as string, r.dataCutoff as string, new Date().toLocaleString());
        const sections = r.sections as Record<string, Section>;
        const watermark = `<div class="watermark">MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF</div>`;
        const body  = watermark + sectionsHtml(sections);
        writeHtml(`members/${safe}/${safe}_performance_review.html`,
          page(`Performance Review — ${member}`, `FY${FY}`, cover, body, foot,
            `.watermark { background:#DC2626;color:white;text-align:center;padding:6px;font-size:11px;font-weight:700;border-radius:4px;margin-bottom:16px; }`));
      } else {
        console.error(`    FAILED performance-review for ${member}:`, reviewR.reason);
      }

      console.log(`  ✓ ${member}`);
    }));
  }

  // ── Zip ────────────────────────────────────────────────────────────────────
  if (existsSync(ZIP)) execSync(`rm "${ZIP}"`);
  execSync(`cd "${OUT}" && zip -r "${ZIP}" "${FOLDER}"`, { stdio: "pipe" });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s. Pack: ${ZIP}`);
}

main().catch((err) => {
  console.error("Pack generation failed:", err);
  process.exit(1);
});
