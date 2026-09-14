import { Router, type Request, type Response } from "express";
import { requireExternalReadEndpointAccess } from "../lib/apiKeyAuth.js";
import {
  ExternalSourceChangedError,
  ProvenanceUnavailableError,
  parseExternalRequest,
  readMarginByItem,
  readSalesByItem,
} from "../lib/externalItemAnalytics.js";

const router = Router();
router.use(requireExternalReadEndpointAccess);

function handleError(req: Request, res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "External read failed";
  if (error instanceof ExternalSourceChangedError) {
    res.status(409).json({ error: "source_changed", restart_required: true });
    return;
  }
  if (error instanceof ProvenanceUnavailableError) {
    req.log.error({ err: error }, "external provenance unavailable");
    res.status(503).json({ error: "provenance_unavailable" });
    return;
  }
  if (
    message.includes("required") ||
    message.includes("must be") ||
    message.includes("outside") ||
    message.includes("not valid")
  ) {
    res.status(400).json({ error: message });
    return;
  }
  req.log.error({ err: error }, "external item endpoint failed");
  res.status(503).json({ error: "External source unavailable" });
}

router.get("/external/sales-by-item", async (req: Request, res: Response): Promise<void> => {
  const readAt = new Date().toISOString();
  try {
    const request = parseExternalRequest(req.query as Record<string, unknown>);
    res.json(await readSalesByItem(request, readAt));
  } catch (error) {
    handleError(req, res, error);
  }
});

router.get("/external/margin-by-item", async (req: Request, res: Response): Promise<void> => {
  const readAt = new Date().toISOString();
  try {
    const request = parseExternalRequest(req.query as Record<string, unknown>);
    res.json(await readMarginByItem(request, readAt));
  } catch (error) {
    handleError(req, res, error);
  }
});

export default router;
