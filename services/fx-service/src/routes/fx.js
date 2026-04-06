const express = require("express");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const { fetchLiveRate } = require("../utils/rateProvider");
const pino = require("pino");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

function childLogger(ctx) {
  return logger.child({ requestId: "N/A", userId: "N/A", transactionId: "N/A", ...ctx });
}

/**
 * POST /api/v1/fx/quote
 *
 * Issues a time-locked FX quote with a 60-second TTL.
 * The rate is fetched LIVE from the provider at quote time.
 * If the provider is down, we return a clear error — never a cached rate.
 *
 * Each quote is single-use. One quote = one transfer, never reusable.
 */
router.post("/quote", async (req, res) => {
  const { fromCurrency, toCurrency, amountFrom, userId } = req.body;
  const log = childLogger({ requestId: req.headers["x-request-id"], userId });

  if (!fromCurrency || !toCurrency || !amountFrom) {
    return res.status(400).json({
      error: "fromCurrency, toCurrency, and amountFrom are required",
    });
  }

  if (fromCurrency === toCurrency) {
    return res.status(400).json({ error: "fromCurrency and toCurrency must differ" });
  }

  let rate;
  try {
    // LIVE rate fetch — no silent cache fallback
    rate = await fetchLiveRate(fromCurrency.toUpperCase(), toCurrency.toUpperCase());
  } catch (err) {
    log.error({ err: err.message }, "FX provider unavailable — refusing to issue quote");
    // Return a clear, actionable error. Never silently apply a cached rate.
    return res.status(503).json({
      error: "FX provider is currently unavailable. Please try again in a moment.",
      code: "FX_PROVIDER_UNAVAILABLE",
    });
  }

  const amountTo = Math.round(amountFrom * rate);

  try {
    const result = await pool.query(
      `INSERT INTO fx_quotes
         (id, from_currency, to_currency, rate, amount_from, amount_to, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, from_currency, to_currency, rate, amount_from, amount_to, status, expires_at, created_at`,
      [
        uuidv4(),
        fromCurrency.toUpperCase(),
        toCurrency.toUpperCase(),
        rate,
        amountFrom,
        amountTo,
        userId || null,
      ]
    );

    const quote = result.rows[0];
    const ttlSeconds = Math.floor((new Date(quote.expires_at) - Date.now()) / 1000);

    log.info(
      { quoteId: quote.id, rate, amountFrom, amountTo, ttlSeconds },
      "FX quote issued"
    );

    return res.status(201).json({
      quoteId: quote.id,
      fromCurrency: quote.from_currency,
      toCurrency: quote.to_currency,
      rate: parseFloat(quote.rate),
      amountFrom: quote.amount_from,
      amountTo: quote.amount_to,
      status: quote.status,
      expiresAt: quote.expires_at,
      ttlSeconds,
      warning: "This quote expires in 60 seconds and is valid for one use only.",
    });
  } catch (err) {
    log.error({ err: err.message }, "Failed to store FX quote");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/fx/quote/:id
 *
 * Check quote validity and time remaining.
 * Used by the transfer endpoint to validate before executing.
 */
router.get("/quote/:id", async (req, res) => {
  const { id } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  try {
    const result = await pool.query(
      `SELECT id, from_currency, to_currency, rate, amount_from, amount_to,
              status, expires_at, used_at, created_at
       FROM fx_quotes WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Quote not found" });
    }

    const quote = result.rows[0];
    const now = Date.now();
    const expiresAt = new Date(quote.expires_at).getTime();
    const isExpired = now > expiresAt;
    const ttlSeconds = isExpired ? 0 : Math.floor((expiresAt - now) / 1000);

    // Auto-mark expired quotes
    if (isExpired && quote.status === "active") {
      await pool.query(
        `UPDATE fx_quotes SET status = 'expired' WHERE id = $1 AND status = 'active'`,
        [id]
      );
      quote.status = "expired";
    }

    return res.json({
      quoteId: quote.id,
      fromCurrency: quote.from_currency,
      toCurrency: quote.to_currency,
      rate: parseFloat(quote.rate),
      amountFrom: quote.amount_from,
      amountTo: quote.amount_to,
      status: quote.status,
      expiresAt: quote.expires_at,
      ttlSeconds,
      usedAt: quote.used_at,
      valid: quote.status === "active" && !isExpired,
    });
  } catch (err) {
    log.error({ err: err.message }, "Failed to fetch quote");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/fx/quote/:id/use
 *
 * Internal endpoint — called by transaction-service to atomically mark a quote as used.
 * Uses a single UPDATE with conditions to prevent race conditions.
 * One quote = one transfer, enforced at DB level.
 */
router.post("/quote/:id/use", async (req, res) => {
  const { id } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  try {
    // Atomic single-use enforcement:
    // Only succeeds if status='active' AND expires_at > NOW()
    // Concurrent requests on same quote: only one UPDATE wins (0 rows = reject)
    const result = await pool.query(
      `UPDATE fx_quotes
       SET status = 'used', used_at = NOW()
       WHERE id = $1
         AND status = 'active'
         AND expires_at > NOW()
       RETURNING id, rate, from_currency, to_currency, amount_from, amount_to`,
      [id]
    );

    if (result.rowCount === 0) {
      // Check why it failed
      const check = await pool.query(
        `SELECT status, expires_at FROM fx_quotes WHERE id = $1`,
        [id]
      );

      if (check.rowCount === 0) {
        return res.status(404).json({ error: "Quote not found" });
      }

      const q = check.rows[0];
      if (q.status === "used") {
        return res.status(409).json({
          error: "Quote already used. Each quote is valid for one transfer only.",
          code: "QUOTE_ALREADY_USED",
        });
      }
      if (q.status === "expired" || new Date(q.expires_at) <= new Date()) {
        return res.status(410).json({
          error: "Quote has expired. Please request a new quote and retry the transfer.",
          code: "QUOTE_EXPIRED",
        });
      }
      return res.status(409).json({ error: "Quote cannot be used", code: "QUOTE_INVALID" });
    }

    log.info({ quoteId: id }, "FX quote consumed");
    return res.json({
      quoteId: result.rows[0].id,
      rate: parseFloat(result.rows[0].rate),
      fromCurrency: result.rows[0].from_currency,
      toCurrency: result.rows[0].to_currency,
      amountFrom: result.rows[0].amount_from,
      amountTo: result.rows[0].amount_to,
    });
  } catch (err) {
    log.error({ err: err.message }, "Failed to use quote");
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
