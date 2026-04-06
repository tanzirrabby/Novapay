const client = require("prom-client");

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code", "service"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code", "service"],
  registers: [register],
});

// CRITICAL METRIC — must always be zero
const ledgerInvariantViolations = new client.Counter({
  name: "ledger_invariant_violations_total",
  help: "Count of double-entry invariant violations — nonzero means money was created or destroyed",
  registers: [register],
});

const ledgerEntriesCreated = new client.Counter({
  name: "ledger_entries_created_total",
  help: "Total ledger entries created",
  registers: [register],
});

module.exports = {
  register,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  ledgerInvariantViolations,
  ledgerEntriesCreated,
};
