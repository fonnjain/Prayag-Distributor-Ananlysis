// Sales People deep-dive endpoints: reporting tree, per-rep drill-down, an
// AI narrative/compare analyst, a verify/data-health reconciliation, and a
// per-rep Excel report download.
import { Router, type IRouter, type Request, type Response } from "express";
import { AnalyzeSalesPersonBody } from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  buildSalesTree,
  buildDeepDive,
  runSalesVerify,
  resolveRepKey,
  type DeepDive,
  type RepNode,
} from "../lib/mgmt/salespeople.js";
import { priorFy } from "../lib/mgmt/names.js";
import { buildSalesReports, type SalesRepReport } from "../lib/mgmt/salesReports.js";
import { buildRepReportWorkbook } from "../lib/mgmt/repReports.js";

// ---------------------------------------------------------------------------
// Dev-only fixture data
//
// When NODE_ENV is not "production" the tree endpoint falls back to a one-rep
// fixture tree if Google Sheets is unreachable (no access token in dev).
// The special repKey "__fixture" short-circuits the reports and download
// handlers so they return fixture data without any external dependency.
// These paths are never reachable in production because the guard is explicit.
// ---------------------------------------------------------------------------

const IS_PROD = process.env.NODE_ENV === "production";
const FIXTURE_REP_KEY = "__fixture";

function makeFixtureReport(fy: string): SalesRepReport {
  const prior = priorFy(fy);
  return {
    fy,
    priorFy: prior,
    repKey: FIXTURE_REP_KEY,
    repName: "Fixture Rep (Test Only)",
    scope: "own",
    hasTeam: false,
    available: true,
    basis: "secondary",
    monthly: [
      { month: "Apr", orderAmount: 500_000, orders: 12, saleAmount: 450_000 },
      { month: "May", orderAmount: 600_000, orders: 15, saleAmount: 550_000 },
    ],
    stateOptions: ["MADHYA PRADESH"],
    secondary: {
      tiles: {
        netOrderBooked: 1_800_000,
        netOrderBookedLast: 1_650_000,
        growthPct: 9.09,
        orders: 45,
        activeRetailers: 30,
        newRetailers: 5,
        avgOrderValue: 40_000,
        businessPerRetailer: 60_000,
        target: null,
        achievementPct: null,
      },
      byState: [{ label: "MADHYA PRADESH", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, sharePct: 100 }],
      partyByState: {
        "MADHYA PRADESH": [{ id: "fp1", name: "Fixture Party A", amount: 1_800_000, priorAmount: 1_650_000 }],
      },
      segmentByState: {
        "MADHYA PRADESH": [{ label: "HEALTH CARE", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, sharePct: 100 }],
      },
      byGroup: [{ label: "OTC", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, sharePct: 100 }],
      bySegment: [{ label: "HEALTH CARE", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, sharePct: 100 }],
      parties: {
        top: [{ label: "Fixture Party A", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, sharePct: 100 }],
        newTop: [],
        churned: [],
        newCount: 0,
        churnedCount: 0,
      },
      movers: { partiesUp: [], partiesDown: [], segmentsUp: [], segmentsDown: [] },
      saleCollection: { sale: 1_800_000, saleLast: 1_650_000, collection: null },
      byStateByMonth: [
        { state: "MADHYA PRADESH", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, months: [1_800_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], monthsPrior: [1_650_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      ],
      byGroupByState: {
        "MADHYA PRADESH": [{ label: "OTC", thisFy: 1_800_000, lastFy: 1_650_000, diff: 150_000, growthPct: 9.09, sharePct: 100 }],
      },
      partyGroupMatrix: [
        { party: "Fixture Party A", state: "MADHYA PRADESH", total: 1_800_000, byGroup: { OTC: 1_800_000 } },
      ],
    },
    primary: {
      available: false,
      reason: "Primary data not available for fixture rep.",
      headTotal: 0,
      bridgedToAnyTmAmount: 0,
      totalBridged: 0,
      bridgeCoverage: 0,
      bridgedParties: [],
      unbridgedParties: [],
      byItemCode: [],
    },
    reconciliation: {
      secondary: { repTotal: 1_800_000, fileTotal: 1_800_000, delta: 0, ok: true, note: "Fixture: cross-foot OK" },
      primary: { bridgedAmount: 0, unbridgedAmount: 0, headTotal: 0, delta: 0, ok: true, note: "Not available." },
    },
  };
}

const FIXTURE_TREE = {
  heads: [
    {
      key: FIXTURE_REP_KEY,
      name: "Fixture Rep (Test Only)",
      state: "MADHYA PRADESH",
      ownNet: 1_800_000,
      teamNet: 1_800_000,
      hasTeam: false,
      children: [],
    },
  ],
  multiLevel: false,
  loadDetail: "Google Sheets unavailable in dev — showing fixture data.",
};

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2025-26";

const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2122}\u{2139}\u{2328}\u{23E9}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;

function stripEmojis(text: string): string {
  return text.replace(EMOJI_PATTERN, "").replace(/[ \t]+\n/g, "\n").trim();
}

function fyParam(raw: unknown): string {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_FY;
}

const cr = (n: number): string => `${(n / 1e7).toFixed(2)} Cr`;

router.get("/salespeople/tree", async (req: Request, res: Response): Promise<void> => {
  const fy = fyParam(req.query.fy);
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2025-26" });
    return;
  }
  try {
    res.json(await buildSalesTree(fy));
  } catch (err) {
    req.log.error({ err, fy }, "salespeople tree failed");
    if (!IS_PROD) {
      req.log.warn("Sheets unavailable in dev — returning fixture tree for e2e testing");
      res.json(FIXTURE_TREE);
      return;
    }
    res.status(500).json({
      error:
        "Could not build the sales people tree. Google Sheets may be rate-limiting reads; try again in a minute.",
    });
  }
});

router.get("/salespeople/deep-dive", async (req: Request, res: Response): Promise<void> => {
  const fy = fyParam(req.query.fy);
  const repKey = typeof req.query.repKey === "string" ? req.query.repKey.trim() : "";
  const scope = req.query.scope === "team" ? "team" : "own";
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2025-26" });
    return;
  }
  if (!repKey) {
    res.status(400).json({ error: "repKey is required" });
    return;
  }
  try {
    res.json(await buildDeepDive(fy, repKey, scope));
  } catch (err) {
    req.log.error({ err, fy, repKey }, "salespeople deep-dive failed");
    res.status(500).json({
      error:
        "Could not compute the deep dive. Google Sheets may be rate-limiting reads; try again in a minute.",
    });
  }
});

router.get("/salespeople/verify", async (req: Request, res: Response): Promise<void> => {
  const fy = fyParam(req.query.fy);
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2025-26" });
    return;
  }
  try {
    res.json(await runSalesVerify(fy));
  } catch (err) {
    req.log.error({ err, fy }, "salespeople verify failed");
    res.status(500).json({ error: "Could not run verification. Try again in a minute." });
  }
});

function deepDiveContext(d: DeepDive): string {
  const rows = (list: DeepDive["byState"]): string =>
    list
      .slice(0, 12)
      .map(
        (r) =>
          `${r.label}: this ${cr(r.thisFy)}, last ${cr(r.lastFy)}, growth ${r.growthPct == null ? "n/a" : r.growthPct + "%"}, share ${r.sharePct == null ? "n/a" : r.sharePct + "%"}`,
      )
      .join("\n");
  return [
    `Sales person: ${d.repName} (${d.scope === "team" ? "own plus rolled-up team" : "own book"})`,
    `Fiscal year ${d.fy} vs ${d.priorFy}.`,
    `Net order booked: ${cr(d.tiles.netOrderBooked)} (last ${cr(d.tiles.netOrderBookedLast)}, growth ${d.tiles.growthPct == null ? "n/a" : d.tiles.growthPct + "%"}).`,
    `Orders ${d.tiles.orders}, active retailers ${d.tiles.activeRetailers}, new retailers ${d.tiles.newRetailers}.`,
    d.tiles.target != null
      ? `Target ${cr(d.tiles.target)}, achievement ${d.tiles.achievementPct == null ? "n/a" : d.tiles.achievementPct + "%"}.`
      : "No target set.",
    "",
    "By State:",
    rows(d.byState),
    "",
    "By Group:",
    rows(d.byGroup),
    "",
    "By Segment:",
    rows(d.bySegment),
    "",
    "Top parties:",
    rows(d.parties.top),
    "",
    `New parties this year: ${d.parties.newCount}. Churned parties: ${d.parties.churnedCount}.`,
    "Top gaining parties:",
    rows(d.movers.partiesUp),
    "Top declining parties:",
    rows(d.movers.partiesDown),
  ].join("\n");
}

async function compareContext(fy: string, head: RepNode, priorHead: RepNode | null): Promise<string> {
  const lastByKey = new Map<string, number>();
  if (priorHead) for (const c of priorHead.children) lastByKey.set(c.key, c.teamNet);
  const lines = head.children
    .slice()
    .sort((a, b) => b.teamNet - a.teamNet)
    .map((c) => {
      const last = lastByKey.get(c.key) ?? 0;
      const growth = last > 0 ? (((c.teamNet - last) / last) * 100).toFixed(1) + "%" : "n/a";
      return `${c.name}: this ${cr(c.teamNet)}, last ${cr(last)}, growth ${growth}, team members ${1 + c.children.length}`;
    })
    .join("\n");
  return [
    `State Head: ${head.name}. Fiscal year ${fy} vs ${priorFy(fy)}.`,
    `Head team total this year: ${cr(head.teamNet)}.`,
    "",
    "Sales people under this head (rolled-up team net):",
    lines || "No sales people found under this head.",
  ].join("\n");
}

router.get(
  "/salespeople/:key/reports",
  async (req: Request, res: Response): Promise<void> => {
    const repKey = typeof req.params.key === "string" ? req.params.key.trim() : "";
    const fy = fyParam(req.query.fy);
    const scope = req.query.scope === "team" ? "team" : "own";
    const basis = req.query.basis === "primary" ? "primary" : "secondary";
    const filterState = typeof req.query.state === "string" ? req.query.state.trim() : undefined;
    const filterParty = typeof req.query.party === "string" ? req.query.party.trim() : undefined;
    if (!repKey) {
      res.status(400).json({ error: "repKey is required" });
      return;
    }
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2025-26" });
      return;
    }
    if (!IS_PROD && repKey === FIXTURE_REP_KEY) {
      res.json(makeFixtureReport(fy));
      return;
    }
    try {
      res.json(
        await buildSalesReports(fy, repKey, scope, {
          basis,
          filterState,
          filterParty,
        }),
      );
    } catch (err) {
      req.log.error({ err, repKey, fy }, "salespeople reports failed");
      res.status(500).json({ error: "Could not build the report. Try again in a minute." });
    }
  },
);

router.get(
  "/salespeople/:key/reports/download",
  async (req: Request, res: Response): Promise<void> => {
    const repKey = typeof req.params.key === "string" ? req.params.key.trim() : "";
    const fy = fyParam(req.query.fy);
    const basis = req.query.basis === "primary" ? "primary" : "secondary";
    const scope = req.query.scope === "team" ? "team" : "own";
    if (!repKey) {
      res.status(400).json({ error: "repKey is required" });
      return;
    }
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2025-26" });
      return;
    }
    try {
      const report = !IS_PROD && repKey === FIXTURE_REP_KEY
        ? makeFixtureReport(fy)
        : await buildSalesReports(fy, repKey, scope);
      const wb = await buildRepReportWorkbook(report, basis);
      const safeName = report.repName.replace(/[^a-z0-9 ]/gi, "").trim().replace(/\s+/g, "_") || repKey;
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="SalesReports_${safeName}_${fy}_${scope}_${basis}_${today}.xlsx"`,
      );
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      req.log.error({ err, repKey, fy }, "salespeople reports download failed");
      res.status(500).json({ error: "Could not generate the report. Try again in a minute." });
    }
  },
);

router.post("/salesperson/analyze", async (req: Request, res: Response): Promise<void> => {
  const parsed = AnalyzeSalesPersonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const { mode, fy, repKey, scope, head } = parsed.data;
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2025-26" });
    return;
  }

  try {
    let context: string;
    let subject: string;
    if (mode === "narrative") {
      const key = repKey?.trim();
      if (!key) {
        res.status(400).json({ error: "repKey is required for narrative mode" });
        return;
      }
      const dive = await buildDeepDive(fy, key, scope === "team" ? "team" : "own");
      if (!dive.available) {
        res.status(400).json({ error: dive.reason ?? "No data available for this sales person." });
        return;
      }
      context = deepDiveContext(dive);
      subject = dive.repName;
    } else {
      const rawHead = head?.trim();
      if (!rawHead) {
        res.status(400).json({ error: "head is required for compare mode" });
        return;
      }
      const resolved = await resolveRepKey(rawHead);
      const [tree, priorTree] = await Promise.all([
        buildSalesTree(fy),
        buildSalesTree(priorFy(fy)),
      ]);
      const findNode = (nodes: RepNode[], key: string): RepNode | null => {
        for (const n of nodes) {
          if (n.key === key) return n;
          const hit = findNode(n.children, key);
          if (hit) return hit;
        }
        return null;
      };
      const key = resolved?.key ?? rawHead;
      const node = findNode(tree.heads, key);
      if (!node) {
        res.status(400).json({ error: `Could not find "${rawHead}" in the reporting tree.` });
        return;
      }
      context = await compareContext(fy, node, findNode(priorTree.heads, key));
      subject = node.name;
    }

    const system = `You are the "Prayag India Sales Analyst". Prayag India is an Indian manufacturer of retail and resource products. Analyse ONLY the NET secondary order booking figures provided below. All amounts are already in crore (Cr = 10,000,000 rupees); keep that unit and format like "12.34 Cr". Do not invent numbers not present in the context.

Write clear, executive GitHub-flavoured Markdown: lead with the headline, then support with specific figures, then call out risks and opportunities. Use headings, short bullet lists and Markdown tables where helpful. Be concise.

STRICT: Never use emojis, pictographs, medal or rank symbols, or decorative Unicode. Use plain numbers like 1, 2, 3 for ranking. Text and standard punctuation only.

Subject: ${subject}
Context:
${context}`;

    const userPrompt =
      mode === "narrative"
        ? `Give an executive performance summary for ${subject}, explaining what is driving the year-on-year change and where the biggest opportunities and risks are.`
        : `Rank and compare the sales people under ${subject}. Identify the strongest and weakest performers, notable movers, and where the head should focus.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userPrompt }],
    });
    const raw = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();
    res.json({ answer: stripEmojis(raw) || "I could not generate an analysis for that request." });
  } catch (err) {
    req.log.error({ err, mode, fy }, "salesperson analyze failed");
    res.status(502).json({ error: "The analyst is temporarily unavailable. Please try again." });
  }
});

export default router;
