// ── Anant Singh FY2026-27 YTD pack generator ─────────────────────────────────
// Run: node artifacts/api-server/pack-gen.mjs
// Output: /tmp/Anant_Singh_FY2026-27_YTD_pack.zip

import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const API    = "http://localhost:8080";
const FY     = "2026-27";
const SH     = "Anant Singh";
const PERIOD = "ytd";
const OUT    = "/tmp/anant-pack";
const FOLDER = `Anant_Singh_FY${FY}_YTD`;
const ZIP    = `/tmp/${FOLDER}.zip`;

// ── CSS (matches frontend PDF_BASE_STYLE) ────────────────────────────────────

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

const cover = (label, cutoff) =>
  `<div class="period-cover">Coverage: ${label} &nbsp;·&nbsp; Data to ${cutoff} &nbsp;·&nbsp; FY${FY}</div><div class="period-sep"></div>`;

const footer = (label, cutoff) =>
  `<div class="footer">FY${FY} · ${label} · Data to ${cutoff} · Generated ${new Date().toLocaleString()} · Figures are grounded in the verified payload.</div>`;

const page = (title, meta, cov, body, foot, extraCss = "") =>
  `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title>
  <style>${CSS}${extraCss}</style></head><body>
  <div class="brand">Prayag India - Sales Intelligence</div>
  <div class="meta">${title} &middot; ${meta}</div>
  ${cov}${body}${foot}</body></html>`;

const sectionsHtml = (sections) =>
  Object.values(sections)
    .map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g, "<br/>")}</p>`)
    .join("");

const suggestionsHtml = (intro, items) => {
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
};

const travelPlanHtml = (sections, monthPlans) => {
  const monthHtml = monthPlans.map((mp) => `
    <h3>${mp.month} — ${mp.workingDays} working days,
      ${mp.capacity} visits (${mp.maintenanceVisits} maintenance, ${mp.developmentVisits} development)</h3>
    <table>
      <tr><th>Name</th><th>District</th><th>Dist km</th><th>Priority</th><th>Reason</th></tr>
      ${(mp.targets ?? []).map((t) => `<tr>
        <td>${t.name}</td><td>${t.district ?? "—"}</td><td>${t.distanceKm ?? "—"}</td>
        <td>${t.priority}</td><td>${t.reason}</td></tr>`).join("")}
    </table>`).join("");
  return sectionsHtml(sections) + `<h2>Month-by-Month Visit Plan (App-Computed)</h2>${monthHtml}`;
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${path} → HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

// ── File writer ───────────────────────────────────────────────────────────────

function write(relPath, html) {
  const abs = join(OUT, FOLDER, relPath);
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, html, "utf8");
  process.stdout.write(`  wrote ${relPath}\n`);
}

// ── Deck HTML ─────────────────────────────────────────────────────────────────

function deckHtml(deck) {
  const renderSlides = (slides, label) => slides.map((s) => `
    <div style="margin:16px 0;padding:14px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;">
      <div style="font-size:11px;color:#64748b;margin-bottom:2px;">${label} ${s.slideNumber ?? ""}</div>
      <h3 style="margin:0 0 4px 0;font-size:14px;">${s.title}</h3>
      ${s.subtitle ? `<div style="font-size:12px;color:#64748b;margin-bottom:6px;">${s.subtitle}</div>` : ""}
      <ul style="margin:6px 0;padding-left:18px;">${(s.bullets ?? []).map((b) => `<li style="font-size:12px;margin:2px 0;">${b}</li>`).join("")}</ul>
      ${s.commentary ? `<p style="font-size:12px;color:#475569;font-style:italic;margin-top:6px;">${s.commentary}</p>` : ""}
      ${s.chartType && s.chartType !== "none" ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">[Chart: ${s.chartType} — ref: ${s.chartDataRef}]</div>` : ""}
    </div>`).join("");

  const memberSlideHtml = (deck.memberSlides ?? []).map((ms) => `
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
    <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">${deck.deckTitle ?? ""}</h1>
    <p style="color:#475569;margin-bottom:20px;">${deck.deckSubtitle ?? ""}</p>
    <h2>Team Slides (1–11)</h2>${renderSlides(deck.teamSlides ?? [], "Slide")}
    <h2>Member Slides</h2>${memberSlideHtml}
    <h2>Closing Slides (25–27)</h2>${renderSlides(deck.closingSlides ?? [], "Slide")}
  `;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log(`\nPrayag Pack Generator — ${SH} FY${FY} YTD`);
  console.log(`Output: ${ZIP}\n`);

  if (existsSync(join(OUT, FOLDER))) rmSync(join(OUT, FOLDER), { recursive: true });
  mkdirSync(join(OUT, FOLDER), { recursive: true });

  // README
  const readme = `Prayag India — ${SH} FY${FY} YTD Pack
Generated: ${new Date().toISOString()}

WHY THE FIGURES DIFFER FROM THE PREVIOUS PACK
==============================================
Four bugs were fixed between the previous pack and this one. None of
the differences are performance changes.

1. Three LEFT members excluded (Jagdev, Shiv Kumar, Ravi Upadhyay)
   Achievement rises 51.7% → 58.4% — ORGANISATIONAL, not commercial.

2. New-party order booking now included (+Rs 25.77 lakh, 11.7% of secondary)

3. Removed retailers separated from active (224 across team)
   Labelled by last active year (not "year of removal" — sheets hold no removal date).

4. Period stamping added — every document carries period covered, cutoff, generation time.

HEAD-CANON ALIASES (unrelated to Anant Singh)
=============================================
Five head merges applied on the same day:
  Sandeep Ji → Sandeep Dadheech, Rizvi Ji → Syed Aqil Rizvi,
  Bijju → Biju C.O, Lalan → Lalan Kumar, Nasir Husain → Nasir Hussain Khan.
Anant Singh was NEVER split. These do not affect this pack.

ACCEPTANCE FIGURES (team, active-10 basis)
==========================================
Order booking  : Rs 2.35 Cr (Rs 23,549,308)
Sales received : Rs 2.41 Cr
Target to date : Rs 4.03 Cr
Achievement    : 58.4%
Visits         : 4,522 (dashboard col AF)
Retailers      : 748 (dashboard col N)

Prasun Chatterjee (7 controls):
  73 retailers, 34 active | OB Rs 26,21,109 | Sale Rs 26,13,934
  395 visits / 1,704 required | Top-5 share 64.0%
  Effective retailers 9.9 | Cost ratio 5.94%

Removed retailers (reported separately):
  Ravinder Puri 64 · Prasun Chatterjee 47 · Manish Gupta 39
  Shivam Chauhan 58 · Ravi (Faridabad) 11 · Rinku 5 · others 0 · Total 224

DEPARTED MEMBERS (no forward reports generated)
================================================
Jagdev, Shiv Kumar, Ravi Upadhyay — status LEFT.
Historical business preserved in state head report.

DATA CUTOFF: 30 June 2026
`;
  writeFileSync(join(OUT, FOLDER, "00_README.txt"), readme, "utf8");
  console.log("  wrote 00_README.txt");

  // 1. State head report
  console.log("\n[1/3] State Head Report...");
  const shReport = await post("/api/ai/statehead-report", { fy: FY, stateHead: SH, period: PERIOD });
  write("01_state_head_report.html", page(
    `State Head Report — ${SH}`,
    `FY${FY} | Active 10 members`,
    cover(shReport.periodCoveredLabel, shReport.dataCutoff),
    sectionsHtml(shReport.sections),
    footer(shReport.periodCoveredLabel, shReport.dataCutoff),
  ));

  // 2. Deck
  console.log("[2/3] Deck (A4A 27-slide)...");
  let deckOk = false;
  try {
    const deck = await post("/api/ai/presentation", { fy: FY, stateHead: SH, period: PERIOD });
    write("02_deck.html", page(
      `Team Deck — ${SH}`,
      `FY${FY} | 27 slides`,
      cover(deck.periodCoveredLabel, deck.dataCutoff),
      deckHtml(deck),
      footer(deck.periodCoveredLabel, deck.dataCutoff),
    ));
    deckOk = true;
  } catch (err) {
    console.error("  FAILED deck (non-fatal):", String(err).slice(0, 200));
    writeFileSync(join(OUT, FOLDER, "02_deck_FAILED.txt"),
      `Deck generation failed at ${new Date().toISOString()}.\nError: ${String(err)}\nRetry: POST /api/ai/presentation with { fy, stateHead, period }\n`, "utf8");
  }
  console.log(`  deck: ${deckOk ? "✓" : "FAILED — see 02_deck_FAILED.txt"}`);

  // 3. Per-member documents
  const memberRanking = shReport.memberRanking ?? [];
  if (!memberRanking.length) throw new Error("No members in memberRanking");
  const activeMembers = memberRanking.map((m) => m.name);

  console.log(`\n[3/3] Generating docs for ${activeMembers.length} active members:`);
  console.log(`  ${activeMembers.join(", ")}\n`);

  // Process 2 members in parallel
  for (let i = 0; i < activeMembers.length; i += 2) {
    const batch = activeMembers.slice(i, i + 2);
    await Promise.all(batch.map(async (member) => {
      const safe = member.replace(/[/\\:*?"<>|]/g, "_");
      console.log(`  → ${member}...`);

      const [reportR, suggR, travelR, reviewR] = await Promise.allSettled([
        post("/api/ai/report",             { fy: FY, stateHead: SH, member, period: PERIOD }),
        post("/api/ai/suggestions",        { fy: FY, stateHead: SH, member, period: PERIOD }),
        post("/api/ai/travel-plan",        { fy: FY, stateHead: SH, member, period: PERIOD }),
        post("/api/ai/performance-review", { fy: FY, stateHead: SH, member, period: PERIOD }),
      ]);

      if (reportR.status === "fulfilled") {
        const r = reportR.value;
        write(`members/${safe}/${safe}_report.html`, page(
          `Management Report — ${member}`, `FY${FY}`,
          cover(r.periodCoveredLabel, r.dataCutoff),
          sectionsHtml(r.sections),
          footer(r.periodCoveredLabel, r.dataCutoff),
        ));
      } else { console.error(`    FAILED report ${member}:`, String(reportR.reason).slice(0, 120)); }

      if (suggR.status === "fulfilled") {
        const r = suggR.value;
        write(`members/${safe}/${safe}_suggestions.html`, page(
          `Suggestions — ${member}`, `FY${FY}`,
          cover(r.periodCoveredLabel, r.dataCutoff),
          suggestionsHtml(r.intro, r.suggestions ?? []),
          footer(r.periodCoveredLabel, r.dataCutoff),
        ));
      } else { console.error(`    FAILED suggestions ${member}:`, String(suggR.reason).slice(0, 120)); }

      if (travelR.status === "fulfilled") {
        const r = travelR.value;
        write(`members/${safe}/${safe}_travel_plan.html`, page(
          `Visit Plan — ${member}`, `FY${FY}`,
          cover(r.periodCoveredLabel, r.dataCutoff),
          travelPlanHtml(r.sections, r.monthPlans ?? []),
          footer(r.periodCoveredLabel, r.dataCutoff),
        ));
      } else { console.error(`    FAILED travel-plan ${member}:`, String(travelR.reason).slice(0, 120)); }

      if (reviewR.status === "fulfilled") {
        const r = reviewR.value;
        write(`members/${safe}/${safe}_performance_review.html`, page(
          `Performance Review — ${member}`, `FY${FY}`,
          cover(r.periodCoveredLabel, r.dataCutoff),
          `<div class="watermark">MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF</div>`
            + sectionsHtml(r.sections),
          footer(r.periodCoveredLabel, r.dataCutoff),
        ));
      } else { console.error(`    FAILED perf-review ${member}:`, String(reviewR.reason).slice(0, 120)); }

      console.log(`  ✓ ${member}`);
    }));
  }

  // Zip
  if (existsSync(ZIP)) execSync(`rm "${ZIP}"`);
  execSync(`cd "${OUT}" && zip -r "${ZIP}" "${FOLDER}"`, { stdio: "pipe" });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s.`);
  console.log(`Pack: ${ZIP}`);

  // List the files in the pack
  const listing = execSync(`cd "${OUT}" && find "${FOLDER}" -type f | sort`).toString().trim();
  console.log("\nContents:\n" + listing);
}

main().catch((err) => { console.error("Pack generation failed:", err); process.exit(1); });
