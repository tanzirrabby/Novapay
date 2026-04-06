require("./utils/tracing");

const express = require("express");
const pinoHttp = require("pino-http");
const pino = require("pino");
const promClient = require("prom-client");
const transactionsRouter = require("./routes/transactions");
const { startSagaRecovery } = require("./utils/sagaRecovery");

const app = express();
const PORT = process.env.PORT || 3002;
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status_code", "service"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

const txRequestsTotal = new promClient.Counter({
  name: "transaction_requests_total",
  help: "Total transaction requests",
  registers: [register],
});

const txFailuresTotal = new promClient.Counter({
  name: "transaction_failures_total",
  help: "Total failed transactions",
  registers: [register],
});

app.use(express.json());
app.use(pinoHttp({ logger }));

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
      service: "transaction-service",
    };
    end(labels);
    if (req.path.includes("transfer") || req.path.includes("transaction")) {
      txRequestsTotal.inc();
      if (res.statusCode >= 500) txFailuresTotal.inc();
    }
  });
  next();
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "transaction-service" })
);

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/api/v1/transfers", transactionsRouter);
app.use("/api/v1/transactions", transactionsRouter);

app.use((err, req, res, _next) => {
  logger.error({ err: err.message }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "transaction-service started");
  // Start background saga recovery (Scenario C)
  startSagaRecovery();
});

module.exports = app;
