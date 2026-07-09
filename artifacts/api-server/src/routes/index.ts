import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analyzeRouter from "./analyze";
import driveRouter from "./drive";
import dashboardRouter from "./dashboard";
import verifyRouter from "./verify";
import analyticsRouter from "./analytics";
import mgmtRouter from "./mgmt";
import targetsRouter from "./targets";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analyzeRouter);
router.use(driveRouter);
router.use(dashboardRouter);
router.use(verifyRouter);
router.use(analyticsRouter);
router.use(mgmtRouter);
router.use(targetsRouter);

export default router;
