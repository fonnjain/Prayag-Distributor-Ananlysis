import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { AnalyzeSalesBody, AnalyzeSalesResponse } from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDataset(): string {
  const candidates = [
    join(__dirname, "../../data/prayag_data.json"),
    join(process.cwd(), "data/prayag_data.json"),
    join(process.cwd(), "artifacts/api-server/data/prayag_data.json"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      // try next candidate
    }
  }
  throw new Error("prayag_data.json dataset not found");
}

const datasetJson = loadDataset();

const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2122}\u{2139}\u{2328}\u{23E9}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;

function stripEmojis(text: string): string {
  return text.replace(EMOJI_PATTERN, "").replace(/[ \t]+\n/g, "\n").trim();
}

const SYSTEM_PROMPT = `You are the "Prayag India Sales Analyst", an expert data analyst for Prayag India, an Indian manufacturer of retail and resource products.

You answer questions strictly using the JSON dataset provided below. Do not invent numbers that are not derivable from the data. If a question cannot be answered from the data, say so plainly and suggest what related insight IS available.

Dataset structure notes:
- fy2425: FY2024-25 sales. grand_total is total annual sales in INR. months + grand_monthly = monthly sales. products[] = per-product annual sales. groups[] = product-group rollups.
- orders_fy2627: FY2026-27 order pipeline. monthly[] = order value per month. groups[] = per-group order values.
- by_state[]: sales broken down by Indian state.
- heads_retail[] / heads_resources[]: sales attributed to sales heads (people) for retail and resources divisions.
- coverage[] + coverage_totals: geographic/market coverage metrics by state.
- top_retailers[]: the top 40 retail customers by value.
- totals: headline totals.

Formatting rules:
- All monetary values are in Indian Rupees. Format large numbers using the Indian convention: crore (Cr = 10,000,000) and lakh (lakh = 100,000). Example: 3417311917 -> "₹341.73 Cr".
- Respond in clear, well-structured GitHub-flavored Markdown. Use headings, bullet lists, and Markdown tables where helpful.
- Be concise and executive in tone. Lead with the answer, then support it with specific numbers.
- When ranking or comparing, cite the actual figures from the data.
- STRICT: Never use emojis, pictographs, medal/rank symbols, or any decorative Unicode characters (e.g. no medal symbols, check marks, arrows-as-decoration, stars). Use plain numbers like "1", "2", "3" for ranking. Text and standard punctuation only. This rule is absolute.

Dataset (JSON):
${datasetJson}`;

router.post("/analyze", async (req: Request, res: Response): Promise<void> => {
  const parsed = AnalyzeSalesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: parsed.data.question }],
    });

    const rawAnswer = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();

    const answer = stripEmojis(rawAnswer);

    const data = AnalyzeSalesResponse.parse({
      answer: answer || "I could not generate an answer for that question.",
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "analyst request failed");
    res.status(502).json({ error: "The analyst is temporarily unavailable. Please try again." });
  }
});

export default router;
