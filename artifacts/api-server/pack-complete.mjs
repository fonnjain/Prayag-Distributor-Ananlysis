// ── Pack completion pass ──────────────────────────────────────────────────────
// Generates any missing files from the Anant Singh pack.
// Already-written files are skipped (idempotent).
// Run: node artifacts/api-server/pack-complete.mjs
//
// Pass MEMBERS_ONLY=1 env var to skip deck generation.
// Pass DECK_ONLY=1 to skip member generation.

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const API    = "http://localhost:8080";
const FY     = "2026-27";
const SH     = "Anant Singh";
const PERIOD = "ytd";
const FOLDER = "Anant_Singh_FY2026-27_YTD";
const ROOT   = `/tmp/anant-pack/${FOLDER}`;
const ZIP    = `/tmp/${FOLDER}.zip`;

const MEMBERS_ONLY = process.env.MEMBERS_ONLY === "1";
const DECK_ONLY    = process.env.DECK_ONLY === "1";

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
  body{font-family:'Inter',system-ui,sans-serif;color:#0f172a;margin:40px;line-height:1.6}
  .brand{color:#1d4ed8;font-weight:700;font-size:18px;margin-bottom:2px}
  .meta{color:#64748b;font-size:11px;margin-bottom:4px}
  .period-cover{background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;
    padding:8px 12px;font-size:12px;color:#1e40af;margin-bottom:4px}
  .period-sep{margin-bottom:16px}
  h2{font-size:15px;font-weight:600;border-bottom:1px solid #e2e8f0;
    padding-bottom:4px;margin-top:20px;color:#1e293b}
  h3{font-size:13px;margin-top:14px;color:#1e293b}
  p{margin:6px 0;font-size:13px}
  .footer{margin-top:32px;padding-top:10px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:10px}
  .watermark{background:#DC2626;color:white;text-align:center;padding:6px;
    font-size:11px;font-weight:700;border-radius:4px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;margin:6px 0;font-size:11px}
  th{padding:4px 8px;background:#f1f5f9;border:1px solid #cbd5e1;text-align:left}
  td{padding:3px 8px;border:1px solid #e2e8f0}
`;

// ── HTML helpers ──────────────────────────────────────────────────────────────
const mkCover  = (label, cutoff) =>
  `<div class="period-cover">Coverage: ${label} &nbsp;·&nbsp; Data to ${cutoff} &nbsp;·&nbsp; FY${FY}</div><div class="period-sep"></div>`;
const mkFooter = (label, cutoff) =>
  `<div class="footer">FY${FY} · ${label} · Data to ${cutoff} · Generated ${new Date().toLocaleString()} · Figures are grounded in the verified payload.</div>`;
const mkPage   = (title, meta, cov, body, foot) =>
  `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title>
  <style>${CSS}</style></head><body>
  <div class="brand">Prayag India - Sales Intelligence</div>
  <div class="meta">${title} &middot; ${meta}</div>
  ${cov}${body}${foot}</body></html>`;

const sectionsHtml = (sections) =>
  Object.values(sections).map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g,"<br/>")}</p>`).join("");

const suggestionsHtml = (intro, items) =>
  `<h2>Introduction</h2><p>${intro}</p><h2>Ranked Suggestions</h2>` +
  items.map((s) => `
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

const travelPlanHtml = (sections, monthPlans) =>
  sectionsHtml(sections) +
  `<h2>Month-by-Month Visit Plan (App-Computed)</h2>` +
  monthPlans.map((mp) => `
    <h3>${mp.month} — ${mp.workingDays} working days,
      ${mp.capacity} visits (${mp.maintenanceVisits} maintenance, ${mp.developmentVisits} development)</h3>
    <table><tr><th>Name</th><th>District</th><th>Dist km</th><th>Priority</th><th>Reason</th></tr>
    ${(mp.targets??[]).map((t)=>`<tr><td>${t.name}</td><td>${t.district??"—"}</td><td>${t.distanceKm??"—"}</td><td>${t.priority}</td><td>${t.reason}</td></tr>`).join("")}
    </table>`).join("");

const deckHtml = (d) => {
  const renderSlides = (slides, label) => slides.map((s) => `
    <div style="margin:16px 0;padding:14px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;">
      <div style="font-size:11px;color:#64748b;">${label} ${s.slideNumber??""}</div>
      <h3 style="margin:0 0 4px 0;font-size:14px;">${s.title}</h3>
      ${s.subtitle?`<div style="font-size:12px;color:#64748b;margin-bottom:6px;">${s.subtitle}</div>`:""}
      <ul style="margin:6px 0;padding-left:18px;">${(s.bullets??[]).map((b)=>`<li style="font-size:12px;margin:2px 0;">${b}</li>`).join("")}</ul>
      ${s.commentary?`<p style="font-size:12px;color:#475569;font-style:italic;margin-top:6px;">${s.commentary}</p>`:""}
      ${s.chartType&&s.chartType!=="none"?`<div style="font-size:11px;color:#94a3b8;margin-top:4px;">[Chart: ${s.chartType} — ref: ${s.chartDataRef}]</div>`:""}
    </div>`).join("");
  const memberSlides = (d.memberSlides??[]).map((ms)=>`
    <div style="margin:16px 0;padding:14px;border:2px solid ${ms.achievementBadge==="teal"?"#99f6e4":"#fde68a"};border-radius:6px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-size:14px;font-weight:600;">${ms.memberName}</span>
        <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;
          background:${ms.achievementBadge==="teal"?"#99f6e4":"#fde68a"};
          color:${ms.achievementBadge==="teal"?"#065f46":"#713f12"};">
          ${ms.achievementBadge==="teal"?"On track ≥60%":"Below target"}</span>
        ${ms.unmapped?`<span style="font-size:10px;color:#ef4444;">⚠ No member sheet</span>`:""}
      </div>
      <ul style="margin:0;padding-left:18px;">${(ms.bullets??[]).map((b)=>`<li style="font-size:12px;margin:2px 0;">${b}</li>`).join("")}</ul>
      ${ms.commentary?`<p style="font-size:12px;color:#475569;font-style:italic;margin-top:6px;">${ms.commentary}</p>`:""}
    </div>`).join("");
  return `
    <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">${d.deckTitle??""}</h1>
    <p style="color:#475569;margin-bottom:20px;">${d.deckSubtitle??""}</p>
    <h2>Team Slides (1–11)</h2>${renderSlides(d.teamSlides??[],"Slide")}
    <h2>Member Slides</h2>${memberSlides}
    <h2>Closing Slides (25–27)</h2>${renderSlides(d.closingSlides??[],"Slide")}`;
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function post(path, body, timeoutMs = 200_000) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error(`${path} → HTTP ${r.status}: ${txt.slice(0,300)}`);
  }
  return r.json();
}

// ── Write helper (skips if file exists) ──────────────────────────────────────
function write(relPath, html, force = false) {
  const abs = join(ROOT, relPath);
  if (!force && existsSync(abs)) {
    console.log(`  skip (exists): ${relPath}`);
    return false;
  }
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, html, "utf8");
  console.log(`  wrote: ${relPath}`);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`\nPack completion pass — ${SH} FY${FY} YTD`);
  console.log(`MEMBERS_ONLY=${MEMBERS_ONLY} DECK_ONLY=${DECK_ONLY}\n`);

  // Remaining active members (those NOT already in the output dir)
  // Full team-of-10 from state head report ranking (same order as before):
  const ALL_MEMBERS = [
    "Ravinder Puri", "Manish Gupta", "Prasun Chatterjee", "Rinku",
    "Ankit Kumar", "Tarun Giri", "Ashutosh Kumar (Rudrapur)",
    "Shivam Chauhan", "Rahul Singh", "Ravi (Faridabad)",
  ];

  // ── Deck ──────────────────────────────────────────────────────────────────
  if (!MEMBERS_ONLY) {
    const deckPath = join(ROOT, "02_deck.html");
    if (existsSync(deckPath)) {
      console.log("skip (exists): 02_deck.html");
    } else {
      console.log("Generating deck (A4A 27-slide)...");
      try {
        const deck = await post("/api/ai/presentation", { fy: FY, stateHead: SH, period: PERIOD }, 280_000);
        write("02_deck.html", mkPage(
          `Team Deck — ${SH}`, `FY${FY} | 27 slides`,
          mkCover(deck.periodCoveredLabel, deck.dataCutoff),
          deckHtml(deck),
          mkFooter(deck.periodCoveredLabel, deck.dataCutoff),
        ), true);
        // Remove FAILED marker if it exists
        const failedPath = join(ROOT, "02_deck_FAILED.txt");
        if (existsSync(failedPath)) execSync(`rm "${failedPath}"`);
        console.log("  ✓ deck");
      } catch (err) {
        console.error(`  FAILED deck: ${String(err).slice(0,200)}`);
      }
    }
  }

  // ── Members ───────────────────────────────────────────────────────────────
  if (!DECK_ONLY) {
    const DOC_SUFFIX = {
      report: "_report.html",
      suggestions: "_suggestions.html",
      "travel-plan": "_travel_plan.html",
      "performance-review": "_performance_review.html",
    };
    const ROUTES = {
      report: "/api/ai/report",
      suggestions: "/api/ai/suggestions",
      "travel-plan": "/api/ai/travel-plan",
      "performance-review": "/api/ai/performance-review",
    };

    // Check which members still need work
    const todo = ALL_MEMBERS.filter((m) => {
      const safe = m.replace(/[/\\:*?"<>|]/g, "_");
      const dir  = join(ROOT, "members", safe);
      const missing = Object.values(DOC_SUFFIX).filter((sfx) => !existsSync(join(dir, safe + sfx)));
      if (missing.length === 0) { console.log(`  skip (complete): ${m}`); return false; }
      return true;
    });

    console.log(`\n${todo.length} member(s) need work: ${todo.join(", ")}\n`);

    // Process 2 at a time
    for (let i = 0; i < todo.length; i += 2) {
      const batch = todo.slice(i, i + 2);
      await Promise.all(batch.map(async (member) => {
        const safe = member.replace(/[/\\:*?"<>|]/g, "_");
        const dir  = join(ROOT, "members", safe);

        // Issue requests only for missing files
        const needsDoc = (sfx) => !existsSync(join(dir, safe + sfx));

        const tasks = Object.entries(DOC_SUFFIX)
          .filter(([, sfx]) => needsDoc(sfx))
          .map(([type]) => type);

        if (tasks.length === 0) return;
        console.log(`  → ${member}: generating ${tasks.join(", ")}...`);

        const results = await Promise.allSettled(
          tasks.map((type) => post(ROUTES[type], { fy: FY, stateHead: SH, member, period: PERIOD }))
        );

        tasks.forEach((type, idx) => {
          const rr = results[idx];
          if (rr.status !== "fulfilled") {
            console.error(`    FAILED ${type} for ${member}: ${String(rr.reason).slice(0,120)}`);
            return;
          }
          const r = rr.value;
          const cov  = mkCover(r.periodCoveredLabel, r.dataCutoff);
          const foot = mkFooter(r.periodCoveredLabel, r.dataCutoff);

          let body = "";
          if (type === "report") {
            body = sectionsHtml(r.sections);
          } else if (type === "suggestions") {
            body = suggestionsHtml(r.intro, r.suggestions ?? []);
          } else if (type === "travel-plan") {
            body = travelPlanHtml(r.sections, r.monthPlans ?? []);
          } else if (type === "performance-review") {
            body = `<div class="watermark">MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF</div>`
                 + sectionsHtml(r.sections);
          }

          write(
            `members/${safe}/${safe}${DOC_SUFFIX[type]}`,
            mkPage(`${type === "performance-review" ? "Performance Review" : type === "travel-plan" ? "Visit Plan" : type === "report" ? "Management Report" : "Suggestions"} — ${member}`, `FY${FY}`, cov, body, foot),
            true,
          );
        });
        console.log(`  ✓ ${member}`);
      }));
    }
  }

  // ── Zip ────────────────────────────────────────────────────────────────────
  if (existsSync(ZIP)) execSync(`rm "${ZIP}"`);
  execSync(`cd /tmp/anant-pack && zip -r "${ZIP}" "${FOLDER}"`, { stdio: "pipe" });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s. Pack: ${ZIP}`);
  const listing = execSync(`cd /tmp/anant-pack && find "${FOLDER}" -type f | sort`).toString().trim();
  console.log("\nContents:\n" + listing);
}

main().catch((err) => { console.error("Completion failed:", err); process.exit(1); });
