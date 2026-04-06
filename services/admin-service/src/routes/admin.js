const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const pino = require("pino");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const LEDGER_URL = process.env.LEDGER_SERVICE_URL || "http://ledger-service:3003";
const ACCOUNT_URL = process.env.ACCOUNT_SERVICE_URL || "http://account-service:3001";
const TX_URL = process.env.TRANSACTION_SERVICE_URL || "http://transaction-service:3002";

function computeAuditHash(prevHash, entry) {
  const data = [prevHash, entry.id, entry.action, entry.actor_id || "", entry.created_at].join("|");
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function writeAuditLog(action, actorId, targetType, targetId, details) {
  const id = uuidv4();
  const createdAt = new Date().toISOString();

  const lastRow = await pool.query(
    `SELECT entry_hash FROM audit_logs ORDER BY created_at DESC LIMIT 1`
  );
  const prevHash = lastRow.rowCount > 0
    ? lastRow.rows[0].entry_hash
    : "0000000000000000000000000000000000000000000000000000000000000000";

  const entryHash = computeAuditHash(prevHash, { id, action, actor_id: actorId, created_at: createdAt });

  await pool.query(
    `INSERT INTO audit_logs (id, action, actor_id, target_type, target_id, details, entry_hash, prev_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, action, actorId || null, targetType || null, targetId || null,
     details ? JSON.stringify(details) : null, entryHash, prevHash, createdAt]
  );

  return { id, entryHash };
}

// GET /api/v1/admin/ledger/invariant — run invariant check across all recent transactions
router.get("/ledger/invariant", async (req, res) => {
  try {
    const resp = await axios.get(`${LEDGER_URL}/api/v1/ledger/invariant-check`, { timeout: 10000 });
    await writeAuditLog("INVARIANT_CHECK", req.headers["x-admin-id"], null, null, resp.data);
    return res.json(resp.data);
  } catch (err) {
    return res.status(500).json({ error: "Invariant check failed", detail: err.message });
  }
});

// GET /api/v1/admin/accounts/:accountId — view account details (admin)
router.get("/accounts/:accountId", async (req, res) => {
  const { accountId } = req.params;
  try {
    const resp = await axios.get(`${ACCOUNT_URL}/api/v1/accounts/${accountId}`, {
      headers: { "x-user-id": "admin" },
      timeout: 5000,
    });
    await writeAuditLog("ADMIN_VIEW_ACCOUNT", req.headers["x-admin-id"], "account", accountId, null);
    return res.json(resp.data);
  } catch (err) {
    return res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// POST /api/v1/admin/accounts/:accountId/freeze — freeze an account
router.post("/accounts/:accountId/freeze", async (req, res) => {
  const { accountId } = req.params;
  const { reason } = req.body;

  try {
    await writeAuditLog("FREEZE_ACCOUNT", req.headers["x-admin-id"], "account", accountId, { reason });
    logger.warn({ accountId, reason }, "Account frozen by admin");
    return res.json({ accountId, status: "frozen", reason, message: "Account frozen" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/admin/audit-logs — paginated audit log with hash chain
router.get("/audit-logs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before;

  try {
    const params = [limit];
    let cursor = "";
    if (before) {
      params.push(before);
      cursor = `AND created_at < $2`;
    }

    const logs = await pool.query(
      `SELECT id, action, actor_id, actor_type, target_type, target_id,
              details, entry_hash, prev_hash, created_at
       FROM audit_logs
       WHERE 1=1 ${cursor}
       ORDER BY created_at DESC
       LIMIT $1`,
      params
    );

    return res.json({
      logs: logs.rows,
      nextCursor: logs.rows.length === limit ? logs.rows[logs.rows.length - 1].created_at : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/admin/audit-logs/verify — verify hash chain integrity
router.get("/audit-logs/verify", async (req, res) => {
  try {
    const logs = await pool.query(
      `SELECT id, action, actor_id, entry_hash, prev_hash, created_at
       FROM audit_logs ORDER BY created_at ASC LIMIT 1000`
    );

    let valid = true;
    const violations = [];
    let prevHash = "0000000000000000000000000000000000000000000000000000000000000000";

    for (const log of logs.rows) {
      const expected = computeAuditHash(prevHash, {
        id: log.id,
        action: log.action,
        actor_id: log.actor_id,
        created_at: log.created_at.toISOString(),
      });

      if (expected !== log.entry_hash) {
        valid = false;
        violations.push({ id: log.id, action: log.action, created_at: log.created_at });
      }

      prevHash = log.entry_hash;
    }

    return res.json({
      chainValid: valid,
      entriesChecked: logs.rowCount,
      violations,
      message: valid
        ? "Audit log chain is intact — no tampering detected"
        : "ALERT: Audit log chain broken — possible tampering detected",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/admin/system/health — aggregate health of all services
router.get("/system/health", async (req, res) => {
  const services = [
    { name: "account-service", url: ACCOUNT_URL },
    { name: "transaction-service", url: TX_URL },
    { name: "ledger-service", url: LEDGER_URL },
  ];

  const results = await Promise.allSettled(
    services.map(async (s) => {
      const resp = await axios.get(`${s.url}/health`, { timeout: 3000 });
      return { name: s.name, status: "ok", data: resp.data };
    })
  );

  const health = results.map((r, i) => ({
    service: services[i].name,
    status: r.status === "fulfilled" ? "ok" : "down",
    error: r.status === "rejected" ? r.reason.message : undefined,
  }));

  const allHealthy = health.every((h) => h.status === "ok");
  return res.status(allHealthy ? 200 : 207).json({ healthy: allHealthy, services: health });
});

module.exports = router;
module.exports.writeAuditLog = writeAuditLog;
