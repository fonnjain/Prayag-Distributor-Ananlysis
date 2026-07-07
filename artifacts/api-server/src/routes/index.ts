import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analyzeRouter from "./analyze";
import driveRouter from "./drive";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analyzeRouter);
router.use(driveRouter);

export default router;
