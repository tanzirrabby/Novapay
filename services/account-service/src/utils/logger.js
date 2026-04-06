// shared/logger.js — structured logger with mandatory fields
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["password", "token", "authorization", "cardNumber", "cvv", "pin"],
    censor: "[REDACTED]",
  },
});

/**
 * Returns a child logger that always includes required fields:
 * requestId, userId, transactionId, timestamp
 */
function childLogger({ requestId, userId, transactionId } = {}) {
  return logger.child({
    requestId: requestId || "N/A",
    userId: userId || "N/A",
    transactionId: transactionId || "N/A",
  });
}

module.exports = { logger, childLogger };
