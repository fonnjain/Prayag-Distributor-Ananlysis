import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analyzeRouter from "./analyze";
import driveRouter from "./drive";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analyzeRouter);
router.use(driveRouter);
router.use(dashboardRouter);

export default router;
