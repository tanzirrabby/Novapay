const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const { encrypt, decrypt } = require("../utils/encryption");
const { childLogger } = require("../utils/logger");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// POST /api/v1/accounts — create account/wallet
router.post("/", async (req, res) => {
  const { userId, currency, fullName, phone, nationalId } = req.body;
  const log = childLogger({ requestId: req.headers["x-request-id"], userId });

  if (!userId || !currency) {
    return res.status(400).json({ error: "userId and currency are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO accounts (id, user_id, currency, balance, encrypted_full_name, encrypted_phone, encrypted_national_id)
       VALUES ($1, $2, $3, 0, $4, $5, $6)
       ON CONFLICT (user_id, currency) DO NOTHING
       RETURNING id, user_id, currency, balance, status, created_at`,
      [
        uuidv4(),
        userId,
        currency.toUpperCase(),
        fullName ? encrypt(fullName) : null,
        phone ? encrypt(phone) : null,
        nationalId ? encrypt(nationalId) : null,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: "Account already exists for this user/currency" });
    }

    log.info({ accountId: result.rows[0].id }, "Account created");
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    log.error({ err: err.message }, "Failed to create account");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/v1/accounts/:accountId — get account with decrypted PII (owner only)
router.get("/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const requestingUserId = req.headers["x-user-id"]; // set by auth middleware in prod
  const log = childLogger({ requestId: req.headers["x-request-id"], userId: requestingUserId });

  try {
    const result = await pool.query(
      `SELECT id, user_id, currency, balance, status, encrypted_full_name, encrypted_phone, created_at
       FROM accounts WHERE id = $1`,
      [accountId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Account not found" });
    }

    const account = result.rows[0];

    // Only decrypt PII for the account owner
    const isOwner = requestingUserId === account.user_id;
    const response = {
      id: account.id,
      userId: account.user_id,
      currency: account.currency,
      balance: account.balance,
      status: account.status,
      createdAt: account.created_at,
      // PII only returned to owner
      fullName: isOwner && account.encrypted_full_name
        ? decrypt(account.encrypted_full_name)
        : undefined,
      phone: isOwner && account.encrypted_phone
        ? decrypt(account.encrypted_phone)
        : undefined,
    };

    return res.json(response);
  } catch (err) {
    log.error({ err: err.message }, "Failed to fetch account");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/v1/accounts/user/:userId — list all accounts for a user
router.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"], userId });

  try {
    const result = await pool.query(
      `SELECT id, user_id, currency, balance, status, created_at
       FROM accounts WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );
    return res.json({ accounts: result.rows });
  } catch (err) {
    log.error({ err: err.message }, "Failed to list accounts");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/v1/accounts/:accountId/balance — internal: update balance (called by ledger)
// Protected — only internal services call this endpoint (use internal auth in prod)
router.patch("/:accountId/balance", async (req, res) => {
  const { accountId } = req.params;
  const { delta, expectedBalance } = req.body; // delta in minor units, signed
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  if (delta === undefined) {
    return res.status(400).json({ error: "delta is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Optimistic lock via expectedBalance (if provided)
    let result;
    if (expectedBalance !== undefined) {
      result = await client.query(
        `UPDATE accounts
         SET balance = balance + $1, updated_at = NOW()
         WHERE id = $2 AND balance = $3
         RETURNING id, balance`,
        [delta, accountId, expectedBalance]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Balance conflict — optimistic lock failed" });
      }
    } else {
      result = await client.query(
        `UPDATE accounts
         SET balance = balance + $1, updated_at = NOW()
         WHERE id = $2 AND balance + $1 >= 0
         RETURNING id, balance`,
        [delta, accountId]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Insufficient balance or account not found" });
      }
    }

    await client.query("COMMIT");
    log.info({ accountId, delta, newBalance: result.rows[0].balance }, "Balance updated");
    return res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    log.error({ err: err.message }, "Balance update failed");
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

module.exports = router;
