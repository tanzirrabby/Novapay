require("./utils/tracing");

const express = require("express");
const pinoHttp = require("pino-http");
const { logger } = require("./utils/logger");
const {
  register,
  httpRequestDurationSeconds,
  httpRequestsTotal,
} = require("./utils/metrics");
const ledgerRouter = require("./routes/ledger");

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());
app.use(
  pinoHttp({
    logger,
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        requestId: req.headers["x-request-id"],
      }),
    },
  })
);

app.use((req, res, next) => {
  const end = httpRequestDurationSeconds.startTimer();
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
      service: "ledger-service",
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "ledger-service" })
);

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/api/v1/ledger", ledgerRouter);

app.use((err, req, res, _next) => {
  logger.error({ err: err.message }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => logger.info({ port: PORT }, "ledger-service started"));

module.exports = app;
