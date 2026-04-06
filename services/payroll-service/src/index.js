require("./utils/tracing");

const express = require("express");
const pinoHttp = require("pino-http");
const pino = require("pino");
const promClient = require("prom-client");
const payrollRouter = require("./routes/payroll");

const app = express();
const PORT = process.env.PORT || 3005;
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

app.use(express.json());
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "payroll-service" }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/api/v1/payroll", payrollRouter);

app.use((err, req, res, _next) => {
  logger.error({ err: err.message }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => logger.info({ port: PORT }, "payroll-service started"));
module.exports = app;
