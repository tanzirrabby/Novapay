const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const { enqueuePayrollJob, startWorker } = require("../queues/payrollQueue");
const pino = require("pino");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

function childLogger(ctx) {
  return logger.child({ requestId: "N/A", userId: "N/A", transactionId: "N/A", ...ctx });
}

/**
 * POST /api/v1/payroll/jobs
 *
 * Submit a bulk payroll disbursement job.
 *
 * Body:
 * {
 *   employerId: UUID,
 *   employerAccountId: UUID,
 *   currency: "USD",
 *   disbursements: [
 *     { employeeId: UUID, recipientAccountId: UUID, amount: 250000 },
 *     ...
 *   ]
 * }
 *
 * Idempotent via Idempotency-Key header.
 */
router.post("/jobs", async (req, res) => {
  const { employerId, employerAccountId, currency, disbursements } = req.body;
  const idempotencyKey = req.headers["idempotency-key"];
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  if (!employerId || !employerAccountId || !currency || !Array.isArray(disbursements) || disbursements.length === 0) {
    return res.status(400).json({
      error: "employerId, employerAccountId, currency, and disbursements[] are required",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotency check — same submission key returns existing job
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id, status FROM payroll_jobs WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (existing.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(200).json({
          jobId: existing.rows[0].id,
          status: existing.rows[0].status,
          message: "Duplicate submission — returning existing job",
          replayed: true,
        });
      }
    }

    const jobId = uuidv4();
    const totalAmount = disbursements.reduce((sum, d) => sum + d.amount, 0);

    // Create the job record
    await client.query(
      `INSERT INTO payroll_jobs
         (id, employer_id, employer_account_id, currency, total_items, total_amount, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, employerId, employerAccountId, currency.toUpperCase(), disbursements.length, totalAmount, idempotencyKey || null]
    );

    // Insert all individual disbursement items with their index
    // item_index enables deterministic resumability — always process in same order
    for (let i = 0; i < disbursements.length; i++) {
      const d = disbursements[i];
      await client.query(
        `INSERT INTO payroll_items (id, job_id, item_index, employee_id, recipient_account_id, amount, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv4(), jobId, i, d.employeeId, d.recipientAccountId, d.amount, currency.toUpperCase()]
      );
    }

    await client.query("COMMIT");

    // Start a worker for this employer (idempotent — reuses existing worker if running)
    startWorker(employerId);

    // Enqueue the job
    await enqueuePayrollJob(jobId, employerId);

    log.info({ jobId, employerId, totalItems: disbursements.length, totalAmount }, "Payroll job submitted");

    return res.status(202).json({
      jobId,
      status: "queued",
      totalItems: disbursements.length,
      totalAmount,
      currency: currency.toUpperCase(),
      message: "Payroll job queued. Poll GET /api/v1/payroll/jobs/:jobId for progress.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log.error({ err: err.message }, "Failed to submit payroll job");
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/payroll/jobs/:jobId
 *
 * Returns job progress — poll this after submitting.
 */
router.get("/jobs/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const log = childLogger({ requestId: req.headers["x-request-id"] });

  try {
    const job = await pool.query(
      `SELECT id, employer_id, status, total_items, processed_items, failed_items,
              checkpoint_index, total_amount, currency, submitted_at, started_at, completed_at
       FROM payroll_jobs WHERE id = $1`,
      [jobId]
    );

    if (job.rowCount === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const j = job.rows[0];
    const progressPct =
      j.total_items > 0
        ? Math.round((j.processed_items / j.total_items) * 100)
        : 0;

    return res.json({
      jobId: j.id,
      employerId: j.employer_id,
      status: j.status,
      progress: `${progressPct}%`,
      totalItems: j.total_items,
      processedItems: j.processed_items,
      failedItems: j.failed_items,
      checkpointIndex: j.checkpoint_index,
      totalAmount: j.total_amount,
      currency: j.currency,
      submittedAt: j.submitted_at,
      startedAt: j.started_at,
      completedAt: j.completed_at,
    });
  } catch (err) {
    log.error({ err: err.message }, "Failed to fetch job");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/payroll/jobs/:jobId/items
 *
 * Returns individual item statuses for a job.
 */
router.get("/jobs/:jobId/items", async (req, res) => {
  const { jobId } = req.params;
  const status = req.query.status; // optional filter: pending|completed|failed

  try {
    let query = `
      SELECT id, item_index, employee_id, recipient_account_id, amount, currency,
             status, transaction_id, failure_reason, processed_at
      FROM payroll_items WHERE job_id = $1
    `;
    const params = [jobId];

    if (status) {
      query += ` AND status = $2`;
      params.push(status);
    }

    query += ` ORDER BY item_index ASC LIMIT 200`;

    const items = await pool.query(query, params);
    return res.json({ jobId, items: items.rows });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
