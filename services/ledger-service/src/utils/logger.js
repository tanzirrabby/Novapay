const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ["password", "token", "authorization"], censor: "[REDACTED]" },
});

function childLogger({ requestId, userId, transactionId } = {}) {
  return logger.child({
    requestId: requestId || "N/A",
    userId: userId || "N/A",
    transactionId: transactionId || "N/A",
  });
}

module.exports = { logger, childLogger };
