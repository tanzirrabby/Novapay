require("./utils/tracing");

const express = require("express");
const pinoHttp = require("pino-http");
const pino = require("pino");
const client = require("prom-client");
const fxRouter = require("./routes/fx");

const app = express();
const PORT = process.env.PORT || 3004;
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status_code", "service"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2],
  registers: [register],
});

app.use(express.json());
app.use(pinoHttp({ logger }));

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on("finish", () =>
    end({ method: req.method, route: req.route?.path || req.path, status_code: res.statusCode, service: "fx-service" })
  );
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "fx-service" }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/api/v1/fx", fxRouter);

app.listen(PORT, () => logger.info({ port: PORT }, "fx-service started"));
module.exports = app;
