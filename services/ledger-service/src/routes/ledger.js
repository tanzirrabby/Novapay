const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { childLogger } = require("../utils/logger");
const { ledgerInvariantViolations, ledgerEntriesCreated } = require("../utils/metrics");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Compute SHA-256 audit hash for a ledger entry.
 * hash = SHA256(prevHash + transactionId + accountId + entryType + amount + currency + createdAt)
 * This creates an immutable hash chain. Tampering with any entry breaks all subsequent hashes.
 */
function computeEntryHash(prevHash, entry) {
  const data = [
    prevHash,
    entry.transaction_id,
    entry.account_id,
    entry.entry_type,
    entry.amount.toString(),
    entry.currency,
    entry.created_at || new Date().toISOString(),
  ].join("|");
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * POST /api/v1/ledger/entries
 *
 * Records a double-entry pair atomically.
 * Body must contain EXACTLY two entries: one debit and one credit.
 * The amounts must match. Both are written in a single DB transaction.
 * If either write fails, both are rolled back — the ledger stays balanced.
 */
router.post("/entries", async (req, res) => {
  const { transactionId, entries } = req.body;
  const log = childLogger({
    requestId: req.headers["x-request-id"],
    transactionId,
  });

  // Validate structure
  if (!transactionId || !Array.isArray(entries) || entries.length !== 2) {
    return res.status(400).json({
      error: "Exactly two ledger entries required per transaction (one debit, one credit)",
    });
  }

  const debitEntries = entries.filter((e) => e.entry_type === "debit");
  const creditEntries = entries.filter((e) => e.entry_type === "credit");

  if (debitEntries.length !== 1 || creditEntries.length !== 1) {
    return res.status(400).json({
      error: "Each transaction must have exactly one debit and one credit entry",
    });
  }

  const debit = debitEntries[0];
  const credit = creditEntries[0];

  // Invariant check: debit amount must equal credit amount (same currency)
  // For FX transfers, amounts differ but locked_fx_rate bridges them — validated separately
  const isSameCurrency = debit.currency === credit.currency;
  if (isSameCurrency && debit.amount !== credit.amount) {
    log.error(
      { debitAmount: debit.amount, creditAmount: credit.amount },
      "Ledger invariant violation detected — amounts do not balance"
    );
    ledgerInvariantViolations.inc();
    await pool.query(
      `INSERT INTO ledger_invariant_violations (transaction_id, details)
       VALUES ($1, $2)`,
      [transactionId, JSON.stringify({ debit, credit, reason: "amount_mismatch" })]
    );
    return res.status(422).json({
      error: "Ledger invariant violation: debit and credit amounts do not match",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check for duplicate — idempotent entry creation
    const existing = await client.query(
      `SELECT id FROM ledger_entries WHERE transaction_id = $1 LIMIT 1`,
      [transactionId]
    );
    if (existing.rowCount > 0) {
      await client.query("ROLLBACK");
      log.warn("Duplicate ledger entry request — returning existing");
      const rows = await pool.query(
        `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at`,
        [transactionId]
      );
      return res.status(200).json({ entries: rows.rows, duplicate: true });
    }

    // Fetch the last hash in the chain for each account
    const getLastHash = async (accountId) => {
      const r = await client.query(
        `SELECT entry_hash FROM ledger_entries
         WHERE account_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [accountId]
      );
      return r.rowCount > 0
        ? r.rows[0].entry_hash
        : "0000000000000000000000000000000000000000000000000000000000000000";
    };

    const createdAt = new Date().toISOString();

    // Compute hash chain for debit entry
    const debitPrevHash = await getLastHash(debit.account_id);
    const debitHash = computeEntryHash(debitPrevHash, { ...debit, transaction_id: transactionId, created_at: createdAt });

    // Compute hash chain for credit entry
    const creditPrevHash = await getLastHash(credit.account_id);
    const creditHash = computeEntryHash(creditPrevHash, { ...credit, transaction_id: transactionId, created_at: createdAt });

    // Insert both entries atomically
    const insertSQL = `
      INSERT INTO ledger_entries
        (transaction_id, account_id, entry_type, amount, currency, locked_fx_rate, description, entry_hash, prev_hash, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    const debitRow = await client.query(insertSQL, [
      transactionId,
      debit.account_id,
      "debit",
      debit.amount,
      debit.currency,
      debit.locked_fx_rate || null,
      debit.description || null,
      debitHash,
      debitPrevHash,
      createdAt,
    ]);

    const creditRow = await client.query(insertSQL, [
      transactionId,
      credit.account_id,
      "credit",
      credit.amount,
      credit.currency,
      credit.locked_fx_rate || null,
      credit.description || null,
      creditHash,
      creditPrevHash,
      createdAt,
    ]);

    await client.query("COMMIT");

    ledgerEntriesCreated.inc(2);
    log.info({ transactionId, debitHash, creditHash }, "Ledger entries recorded");

    return res.status(201).json({
      entries: [debitRow.rows[0], creditRow.rows[0]],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log.error({ err: err.message }, "Failed to record ledger entries");
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/ledger/entries/transaction/:transactionId
 * Returns all ledger entries for a transaction
 */
router.get("/entries/transaction/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"], transactionId });

  try {
    const result = await pool.query(
      `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at`,
      [transactionId]
    );
    return res.json({ entries: result.rows });
  } catch (err) {
    log.error({ err: err.message }, "Failed to fetch ledger entries");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/ledger/entries/account/:accountId
 * Returns paginated ledger history for an account — served from index, NOT a full table scan
 */
router.get("/entries/account/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before; // cursor-based pagination (created_at)
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  try {
    const params = [accountId, limit];
    let cursorClause = "";
    if (before) {
      params.push(before);
      cursorClause = `AND created_at < $3`;
    }

    const result = await pool.query(
      `SELECT id, transaction_id, entry_type, amount, currency, description, entry_hash, created_at
       FROM ledger_entries
       WHERE account_id = $1 ${cursorClause}
       ORDER BY created_at DESC
       LIMIT $2`,
      params
    );

    return res.json({
      entries: result.rows,
      nextCursor: result.rows.length === limit
        ? result.rows[result.rows.length - 1].created_at
        : null,
    });
  } catch (err) {
    log.error({ err: err.message }, "Failed to fetch account ledger history");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/ledger/verify/:transactionId
 * Verifies the double-entry invariant for a transaction
 * Returns the net sum — must always be 0
 */
router.get("/verify/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"], transactionId });

  try {
    const result = await pool.query(
      `SELECT
         SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END) AS net,
         COUNT(*) AS entry_count,
         array_agg(entry_type) AS entry_types
       FROM ledger_entries
       WHERE transaction_id = $1`,
      [transactionId]
    );

    const { net, entry_count, entry_types } = result.rows[0];
    const netValue = parseInt(net || "0");
    const balanced = netValue === 0 && parseInt(entry_count) >= 2;

    if (!balanced) {
      log.error({ transactionId, net: netValue, entry_count }, "Invariant check FAILED");
      ledgerInvariantViolations.inc();
    }

    return res.json({
      transactionId,
      balanced,
      net: netValue,
      entryCount: parseInt(entry_count),
      entryTypes: entry_types,
    });
  } catch (err) {
    log.error({ err: err.message }, "Invariant check failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/ledger/invariant-check
 * Background job endpoint — checks all transactions from last 1 hour
 * Called by the invariant monitor cron
 */
router.get("/invariant-check", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT transaction_id,
             SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END) AS net,
             COUNT(*) AS entry_count
      FROM ledger_entries
      WHERE created_at > NOW() - INTERVAL '1 hour'
      GROUP BY transaction_id
      HAVING SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END) != 0
         OR COUNT(*) < 2
    `);

    if (result.rowCount > 0) {
      for (const row of result.rows) {
        ledgerInvariantViolations.inc();
        await pool.query(
          `INSERT INTO ledger_invariant_violations (transaction_id, details)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [row.transaction_id, JSON.stringify(row)]
        );
      }
    }

    return res.json({
      checked: true,
      violations: result.rowCount,
      violatedTransactions: result.rows.map((r) => r.transaction_id),
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
