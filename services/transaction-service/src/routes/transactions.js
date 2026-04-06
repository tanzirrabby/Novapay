const express = require("express");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { Pool } = require("pg");
const { idempotencyMiddleware } = require("../middleware/idempotency");
const pino = require("pino");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const LEDGER_URL = process.env.LEDGER_SERVICE_URL || "http://ledger-service:3003";
const ACCOUNT_URL = process.env.ACCOUNT_SERVICE_URL || "http://account-service:3001";
const FX_URL = process.env.FX_SERVICE_URL || "http://fx-service:3004";

function childLogger(ctx) {
  return logger.child({ requestId: "N/A", userId: "N/A", transactionId: "N/A", ...ctx });
}

/**
 * POST /api/v1/transfers
 *
 * Domestic transfer (same currency).
 * Protected by idempotency middleware — handles Scenarios A, B, C, D, E.
 *
 * Execution order (saga steps):
 * 1. Validate accounts and balance
 * 2. Record transaction as 'processing' in DB
 * 3. Debit sender balance (account-service)
 * 4. Write double-entry to ledger (ledger-service) ← atomic pair
 * 5. Credit recipient balance (account-service)
 * 6. Mark transaction 'completed'
 *
 * If crash between steps 3-5: saga recovery detects and completes.
 */
router.post("/", idempotencyMiddleware, async (req, res) => {
  const {
    senderAccountId,
    recipientAccountId,
    amount,
    currency,
    description,
  } = req.body;

  const transactionId = uuidv4();
  const log = childLogger({
    requestId: req.headers["x-request-id"],
    transactionId,
  });

  if (!senderAccountId || !recipientAccountId || !amount || !currency) {
    return res.status(400).json({ error: "senderAccountId, recipientAccountId, amount, and currency are required" });
  }
  if (amount <= 0) {
    return res.status(400).json({ error: "Amount must be positive" });
  }
  if (senderAccountId === recipientAccountId) {
    return res.status(400).json({ error: "Sender and recipient must differ" });
  }

  const client = await pool.connect();
  try {
    // Step 1: Record transaction as 'processing' — crash recovery uses this
    await client.query(
      `INSERT INTO transactions
         (id, idempotency_key, type, status, sender_account_id, recipient_account_id, amount, currency, description)
       VALUES ($1, $2, 'transfer', 'processing', $3, $4, $5, $6, $7)`,
      [
        transactionId,
        req.idempotencyKey || null,
        senderAccountId,
        recipientAccountId,
        amount,
        currency.toUpperCase(),
        description || null,
      ]
    );
    client.release();

    // Step 2: Debit sender — balance check and debit are atomic in one UPDATE
    log.info("Debiting sender");
    const debitResp = await axios.patch(
      `${ACCOUNT_URL}/api/v1/accounts/${senderAccountId}/balance`,
      { delta: -amount },
      { timeout: 5000 }
    );
    if (debitResp.status !== 200) {
      await pool.query(
        `UPDATE transactions SET status='failed', failure_reason='Insufficient balance', updated_at=NOW() WHERE id=$1`,
        [transactionId]
      );
      return res.status(402).json({ error: "Insufficient balance" });
    }

    // Step 3: Write double-entry ledger pair — atomic
    // If this crashes mid-write, saga recovery detects partial state
    log.info("Writing ledger entries");
    await axios.post(
      `${LEDGER_URL}/api/v1/ledger/entries`,
      {
        transactionId,
        entries: [
          {
            account_id: senderAccountId,
            entry_type: "debit",
            amount,
            currency: currency.toUpperCase(),
            description: description || "Transfer",
          },
          {
            account_id: recipientAccountId,
            entry_type: "credit",
            amount,
            currency: currency.toUpperCase(),
            description: description || "Transfer",
          },
        ],
      },
      { timeout: 5000 }
    );

    // Step 4: Credit recipient
    log.info("Crediting recipient");
    await axios.patch(
      `${ACCOUNT_URL}/api/v1/accounts/${recipientAccountId}/balance`,
      { delta: amount },
      { timeout: 5000 }
    );

    // Step 5: Mark completed
    await pool.query(
      `UPDATE transactions SET status='completed', updated_at=NOW() WHERE id=$1`,
      [transactionId]
    );

    log.info("Transfer completed successfully");
    return res.status(201).json({
      transactionId,
      status: "completed",
      amount,
      currency: currency.toUpperCase(),
      senderAccountId,
      recipientAccountId,
    });
  } catch (err) {
    log.error({ err: err.message }, "Transfer failed");
    await pool
      .query(
        `UPDATE transactions SET status='processing', updated_at=NOW() WHERE id=$1 AND status='processing'`,
        [transactionId]
      )
      .catch(() => {});
    return res.status(500).json({ error: "Transfer failed — will be recovered automatically" });
  }
});

/**
 * POST /api/v1/transfers/international
 *
 * Cross-currency transfer. Requires a valid, unexpired, unused FX quote.
 * The locked rate from the quote is recorded on every ledger entry.
 */
router.post("/international", idempotencyMiddleware, async (req, res) => {
  const { senderAccountId, recipientAccountId, fxQuoteId, description } = req.body;
  const transactionId = uuidv4();
  const log = childLogger({
    requestId: req.headers["x-request-id"],
    transactionId,
  });

  if (!senderAccountId || !recipientAccountId || !fxQuoteId) {
    return res.status(400).json({
      error: "senderAccountId, recipientAccountId, and fxQuoteId are required",
    });
  }

  try {
    // Step 1: Atomically consume the FX quote (single-use enforcement)
    log.info({ fxQuoteId }, "Consuming FX quote");
    let quoteData;
    try {
      const quoteResp = await axios.post(
        `${FX_URL}/api/v1/fx/quote/${fxQuoteId}/use`,
        {},
        { timeout: 5000 }
      );
      quoteData = quoteResp.data;
    } catch (err) {
      if (err.response?.status === 410) {
        return res.status(410).json({
          error: "FX quote has expired. Please request a new quote.",
          code: "QUOTE_EXPIRED",
        });
      }
      if (err.response?.status === 409) {
        return res.status(409).json({
          error: "FX quote has already been used.",
          code: "QUOTE_ALREADY_USED",
        });
      }
      throw err;
    }

    const { rate, fromCurrency, toCurrency, amountFrom, amountTo } = quoteData;

    // Step 2: Record transaction
    await pool.query(
      `INSERT INTO transactions
         (id, idempotency_key, type, status, sender_account_id, recipient_account_id,
          amount, currency, fx_quote_id, locked_fx_rate, description)
       VALUES ($1, $2, 'fx_transfer', 'processing', $3, $4, $5, $6, $7, $8, $9)`,
      [
        transactionId,
        req.idempotencyKey || null,
        senderAccountId,
        recipientAccountId,
        amountFrom,
        fromCurrency,
        fxQuoteId,
        rate,
        description || `FX Transfer ${fromCurrency}→${toCurrency}`,
      ]
    );

    // Step 3: Debit sender in fromCurrency
    await axios.patch(
      `${ACCOUNT_URL}/api/v1/accounts/${senderAccountId}/balance`,
      { delta: -amountFrom },
      { timeout: 5000 }
    );

    // Step 4: Write ledger with LOCKED rate recorded on entries
    await axios.post(
      `${LEDGER_URL}/api/v1/ledger/entries`,
      {
        transactionId,
        entries: [
          {
            account_id: senderAccountId,
            entry_type: "debit",
            amount: amountFrom,
            currency: fromCurrency,
            locked_fx_rate: rate,
            description: `FX Transfer (rate: ${rate} ${fromCurrency}/${toCurrency})`,
          },
          {
            account_id: recipientAccountId,
            entry_type: "credit",
            amount: amountTo,
            currency: toCurrency,
            locked_fx_rate: rate,
            description: `FX Transfer (rate: ${rate} ${fromCurrency}/${toCurrency})`,
          },
        ],
      },
      { timeout: 5000 }
    );

    // Step 5: Credit recipient in toCurrency
    await axios.patch(
      `${ACCOUNT_URL}/api/v1/accounts/${recipientAccountId}/balance`,
      { delta: amountTo },
      { timeout: 5000 }
    );

    // Step 6: Complete
    await pool.query(
      `UPDATE transactions SET status='completed', updated_at=NOW() WHERE id=$1`,
      [transactionId]
    );

    log.info({ rate, amountFrom, amountTo }, "International transfer completed");
    return res.status(201).json({
      transactionId,
      status: "completed",
      fromCurrency,
      toCurrency,
      amountFrom,
      amountTo,
      lockedRate: rate,
      fxQuoteId,
    });
  } catch (err) {
    log.error({ err: err.message }, "International transfer failed");
    return res.status(500).json({ error: "Transfer failed — saga recovery will handle reconciliation" });
  }
});

/**
 * GET /api/v1/transactions/history/:accountId
 *
 * Returns pre-cached transaction history — NOT a live query across 40M rows.
 * The cache is updated incrementally on each completed transaction.
 * Falls back to a limited indexed query if cache is empty.
 */
router.get("/history/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  try {
    // Serve from pre-built cache first (avoids full table scan)
    const cached = await pool.query(
      `SELECT page_data, updated_at FROM transaction_history_cache WHERE account_id = $1`,
      [accountId]
    );

    if (cached.rowCount > 0) {
      return res.json({
        accountId,
        transactions: cached.rows[0].page_data,
        cachedAt: cached.rows[0].updated_at,
        source: "cache",
      });
    }

    // Cache miss — query with index (sender or recipient), LIMIT 50, no full scan
    const result = await pool.query(
      `SELECT id, type, status, sender_account_id, recipient_account_id,
              amount, currency, locked_fx_rate, description, created_at
       FROM transactions
       WHERE (sender_account_id = $1 OR recipient_account_id = $1)
         AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 50`,
      [accountId]
    );

    // Populate cache for future requests
    await pool
      .query(
        `INSERT INTO transaction_history_cache (account_id, page_data)
         VALUES ($1, $2)
         ON CONFLICT (account_id)
         DO UPDATE SET page_data = $2, updated_at = NOW()`,
        [accountId, JSON.stringify(result.rows)]
      )
      .catch(() => {});

    return res.json({
      accountId,
      transactions: result.rows,
      source: "db",
    });
  } catch (err) {
    log.error({ err: err.message }, "History fetch failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
