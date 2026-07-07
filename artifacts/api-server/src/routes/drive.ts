import { Router, type IRouter, type Request, type Response } from "express";
import { ListDriveFilesQueryParams, ListDriveFilesResponse } from "@workspace/api-zod";
import { listDriveFiles } from "../lib/googleDrive";

const router: IRouter = Router();

router.get("/drive/files", async (req: Request, res: Response): Promise<void> => {
  const parsed = ListDriveFilesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  try {
    const result = await listDriveFiles({
      q: parsed.data.q,
      pageToken: parsed.data.pageToken,
    });
    const data = ListDriveFilesResponse.parse(result);
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "drive list request failed");
    res.status(502).json({ error: "Could not reach Google Drive. Please try again." });
  }
});

export default router;
