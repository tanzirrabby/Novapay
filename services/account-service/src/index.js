require("./utils/tracing"); // MUST be first

const express = require("express");
const pinoHttp = require("pino-http");
const { logger } = require("./utils/logger");
const { register, httpRequestDurationSeconds, httpRequestsTotal } = require("./utils/metrics");
const accountsRouter = require("./routes/accounts");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res, err) => (res.statusCode >= 500 ? "error" : "info"),
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          requestId: req.headers["x-request-id"],
        };
      },
    },
  })
);

// Metrics middleware
app.use((req, res, next) => {
  const end = httpRequestDurationSeconds.startTimer();
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
      service: "account-service",
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok", service: "account-service" }));

// Prometheus metrics
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Routes
app.use("/api/v1/accounts", accountsRouter);

// Global error handler
app.use((err, req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "account-service started");
});

module.exports = app;
