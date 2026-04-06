require("./utils/tracing");
const express = require("express");
const pinoHttp = require("pino-http");
const pino = require("pino");
const promClient = require("prom-client");
const adminRouter = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 3006;
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

app.use(express.json());
app.use(pinoHttp({ logger }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "admin-service" }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});
app.use("/api/v1/admin", adminRouter);
app.use((err, req, res, _next) => {
  logger.error({ err: err.message }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});
app.listen(PORT, () => logger.info({ port: PORT }, "admin-service started"));
module.exports = app;
