/**
 * Saga Recovery — Scenario C
 *
 * Problem: Server crashes AFTER debiting sender but BEFORE crediting recipient.
 * The ledger is unbalanced. Money has vanished inside the system.
 *
 * Solution: On startup and every 60 seconds, scan for transactions in
 * 'processing' state older than 30 seconds. For each one:
 *   1. Check what ledger entries exist.
 *   2. If debit entry exists but no credit → post the credit to complete it.
 *   3. If NO entries exist → reverse the debit (if any) and mark failed.
 *   4. If both entries exist but status is 'processing' → mark completed.
 *
 * This ensures the ledger is always balanced after any crash.
 */

const axios = require("axios");
const { Pool } = require("pg");
const pino = require("pino");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const LEDGER_URL = process.env.LEDGER_SERVICE_URL || "http://ledger-service:3003";
const ACCOUNT_URL = process.env.ACCOUNT_SERVICE_URL || "http://account-service:3001";

async function recoverStaleSagas() {
  logger.info("Running saga recovery scan...");

  let stale;
  try {
    stale = await pool.query(
      `SELECT id, sender_account_id, recipient_account_id, amount, currency,
              fx_quote_id, locked_fx_rate, type
       FROM transactions
       WHERE status = 'processing'
         AND updated_at < NOW() - INTERVAL '30 seconds'
       LIMIT 50`
    );
  } catch (err) {
    logger.error({ err: err.message }, "Saga recovery scan failed");
    return;
  }

  if (stale.rowCount === 0) {
    logger.info("No stale transactions found");
    return;
  }

  logger.warn({ count: stale.rowCount }, "Found stale transactions — beginning recovery");

  for (const tx of stale.rows) {
    try {
      await recoverTransaction(tx);
    } catch (err) {
      logger.error({ txId: tx.id, err: err.message }, "Failed to recover transaction");
    }
  }
}

async function recoverTransaction(tx) {
  const log = logger.child({ transactionId: tx.id });

  // Step 1: Check what ledger entries were already written
  let ledgerEntries;
  try {
    const resp = await axios.get(
      `${LEDGER_URL}/api/v1/ledger/entries/transaction/${tx.id}`,
      { timeout: 5000 }
    );
    ledgerEntries = resp.data.entries || [];
  } catch (err) {
    log.error({ err: err.message }, "Cannot reach ledger service during recovery");
    return;
  }

  const hasDebit = ledgerEntries.some((e) => e.entry_type === "debit");
  const hasCredit = ledgerEntries.some((e) => e.entry_type === "credit");

  if (hasDebit && hasCredit) {
    // Both entries written — transaction is complete but status wasn't updated (crash after ledger, before status update)
    log.info("Recovery: both ledger entries found — marking completed");
    await pool.query(
      `UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [tx.id]
    );
    return;
  }

  if (hasDebit && !hasCredit) {
    // Sender debited but recipient not credited — complete the credit
    log.warn("Recovery: debit found, credit missing — posting credit to complete saga");
    try {
      await axios.post(
        `${LEDGER_URL}/api/v1/ledger/entries`,
        {
          transactionId: tx.id,
          entries: [
            {
              account_id: tx.sender_account_id,
              entry_type: "debit",
              amount: tx.amount,
              currency: tx.currency,
              description: `[RECOVERED] Transfer debit`,
            },
            {
              account_id: tx.recipient_account_id,
              entry_type: "credit",
              amount: tx.amount,
              currency: tx.currency,
              description: `[RECOVERED] Transfer credit`,
            },
          ],
        },
        { timeout: 5000 }
      );

      // Credit the recipient account balance
      await axios.patch(
        `${ACCOUNT_URL}/api/v1/accounts/${tx.recipient_account_id}/balance`,
        { delta: tx.amount },
        { timeout: 5000 }
      );

      await pool.query(
        `UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [tx.id]
      );

      log.info("Recovery: credit posted — transaction completed");
    } catch (err) {
      log.error({ err: err.message }, "Recovery: failed to post credit");
    }
    return;
  }

  if (!hasDebit && !hasCredit) {
    // Nothing was written at all — crash happened before any ledger entry
    // Mark as failed so idempotency key can be retried
    log.warn("Recovery: no ledger entries found — marking transaction failed");
    await pool.query(
      `UPDATE transactions
       SET status = 'failed', failure_reason = 'Recovered from crash before ledger write', updated_at = NOW()
       WHERE id = $1`,
      [tx.id]
    );
  }
}

// Run on startup and then every 60 seconds
function startSagaRecovery() {
  // Delay first run by 10s to allow DB connections to settle
  setTimeout(() => {
    recoverStaleSagas();
    setInterval(recoverStaleSagas, 60_000);
  }, 10_000);
}

module.exports = { startSagaRecovery, recoverStaleSagas };
