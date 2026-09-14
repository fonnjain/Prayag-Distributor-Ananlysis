import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { resolveApiKey } from "./lib/apiKeyAuth";
import { logExternalReadResponse, rateLimitExternalRead } from "./lib/externalReadRateLimiter";
import { requireSameOriginForSession, resolveSession } from "./lib/auth";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const allowedBrowserHosts = new Set(
  [process.env.REPLIT_DEV_DOMAIN, ...(process.env.REPLIT_DOMAINS ?? "").split(",")]
    .map((host) => host?.trim())
    .filter((host): host is string => Boolean(host)),
);
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      try {
        const url = new URL(origin);
        const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        callback(null, local || allowedBrowserHosts.has(url.host) || allowedBrowserHosts.has(url.hostname));
      } catch {
        callback(null, false);
      }
    },
  }),
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(cookieParser());

// Validate Bearer token if present; attach req.apiKey; reject invalid tokens.
app.use("/api", resolveApiKey);
// Correlate each accepted external key with its path and final response status.
app.use("/api", logExternalReadResponse);
// External integrations are limited per authenticated key before any route
// handler runs. The middleware is a no-op for every other request.
app.use("/api", rateLimitExternalRead);
app.use("/api", resolveSession);
app.use("/api", requireSameOriginForSession);
app.use("/api", router);

export default app;
