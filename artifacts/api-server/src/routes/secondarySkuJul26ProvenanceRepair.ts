import { Router, type Request, type Response } from "express";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  assertJulyRetrospectiveInput,
  commitJulyRetrospectiveProvenance,
  previewJulyRetrospectiveProvenance,
  type JulyRetrospectiveInput,
} from "../lib/secondary/jul26RetrospectiveProvenance.js";

const router = Router();
const TTL_MS = 30 * 60_000;
let approvedPreview:
  | (JulyRetrospectiveInput & { expiresAt: number })
  | null = null;

function admin(req: Request, res: Response): boolean {
  if (!isAdminToken(String(req.headers["x-admin-secret"] ?? "").trim())) {
    res.status(401).json({ error: "Admin authorisation required." });
    return false;
  }
  return true;
}

function input(req: Request): JulyRetrospectiveInput {
  return {
    originalLoadedAt:
      typeof req.body?.originalLoadedAt === "string"
        ? req.body.originalLoadedAt.trim()
        : "",
    recordedBy:
      typeof req.body?.recordedBy === "string"
        ? req.body.recordedBy.trim()
        : "",
    sourceNote:
      typeof req.body?.sourceNote === "string"
        ? req.body.sourceNote.trim()
        : "",
  };
}

router.post(
  "/admin/secondary-sku/jul-26/retrospective-provenance",
  async (req: Request, res: Response): Promise<void> => {
    if (!admin(req, res)) return;
    const requested = input(req);
    try {
      assertJulyRetrospectiveInput(requested);
      if (req.query.commit !== "true") {
        const preview = await previewJulyRetrospectiveProvenance();
        approvedPreview = {
          ...requested,
          expiresAt: Date.now() + TTL_MS,
        };
        res.json({
          dryRun: true,
          ...preview,
          input: requested,
          commitExpiresAt: new Date(
            approvedPreview.expiresAt,
          ).toISOString(),
          next:
            "Repeat the identical JSON with ?commit=true&confirm=RETROSPECTIVE-JUL-26 within 30 minutes.",
        });
        return;
      }
      if (req.query.confirm !== "RETROSPECTIVE-JUL-26") {
        res.status(400).json({
          error: "Commit requires confirm=RETROSPECTIVE-JUL-26.",
        });
        return;
      }
      if (
        !approvedPreview ||
        approvedPreview.expiresAt < Date.now() ||
        approvedPreview.originalLoadedAt !== requested.originalLoadedAt ||
        approvedPreview.recordedBy !== requested.recordedBy ||
        approvedPreview.sourceNote !== requested.sourceNote
      ) {
        res.status(409).json({
          error:
            "Run a successful dry-run with identical metadata within 30 minutes before committing.",
        });
        return;
      }
      // Re-run the live preview immediately before the transaction. The
      // transaction itself repeats the checks under the July loader's lock.
      await previewJulyRetrospectiveProvenance();
      const result = await commitJulyRetrospectiveProvenance(requested);
      approvedPreview = null;
      res.json(result);
    } catch (error) {
      res.status(422).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;