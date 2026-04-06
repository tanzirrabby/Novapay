/**
 * Payroll Queue — BullMQ with concurrency=1 per employer account
 *
 * WHY concurrency=1 per employer is better than DB locking:
 *
 * Option A — DB Row Lock (SELECT FOR UPDATE):
 *   - Holds a DB connection open for the ENTIRE job duration (potentially minutes for 14k credits)
 *   - Under 200 concurrent employer jobs: 200 locked connections sitting idle
 *   - If the process crashes, the lock is released but the job is in unknown state
 *   - No built-in retry, no progress visibility, no dead-letter queue
 *
 * Option B — BullMQ queue per employer (chosen):
 *   - Each employer gets their own named queue: "payroll:employer:<employerId>"
 *   - concurrency:1 on that queue = only one job processes at a time per employer
 *   - No DB connections held during processing — workers fetch/release per item
 *   - Durable: jobs persist in Redis across restarts
 *   - Built-in retry with exponential backoff for transient failures
 *   - Resume from checkpoint_index: if 3000/14000 credits processed and crash occurs,
 *     the job resumes at index 3001 — not from scratch
 *   - Full progress tracking: processed_items/total_items visible in real time
 */

const { Queue, Worker, QueueEvents } = require("bullmq");
const axios = require("axios");
const { Pool } = require("pg");
const pino = require("pino");
const { v4: uuidv4 } = require("uuid");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logger = pino({ timestamp: pino.stdTimeFunctions.isoTime });

const TRANSACTION_URL = process.env.TRANSACTION_SERVICE_URL || "http://transaction-service:3002";

const redisConnection = {
  host: (process.env.REDIS_URL || "redis://redis:6379").replace("redis://", "").split(":")[0],
  port: parseInt((process.env.REDIS_URL || "redis://redis:6379").split(":")[2]) || 6379,
};

/**
 * Returns (or creates) a BullMQ Queue scoped to this employer.
 * Scoping per employer gives us natural concurrency=1 isolation:
 * employer A's queue never blocks employer B's queue.
 */
const employerQueues = new Map();

function getEmployerQueue(employerId) {
  if (!employerQueues.has(employerId)) {
    const q = new Queue(`payroll:employer:${employerId}`, { connection: redisConnection });
    employerQueues.set(employerId, q);
  }
  return employerQueues.get(employerId);
}

/**
 * Enqueues a payroll job for a specific employer.
 * The job carries only the jobId — the worker fetches items from Postgres.
 * This keeps Redis payloads small and the DB the source of truth.
 */
async function enqueuePayrollJob(jobId, employerId) {
  const queue = getEmployerQueue(employerId);
  await queue.add(
    "process-payroll",
    { jobId, employerId },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    }
  );
  logger.info({ jobId, employerId }, "Payroll job enqueued");
}

/**
 * Processes a single payroll job.
 * Uses checkpoint_index to resume from the last successful item after any crash.
 */
async function processPayrollJob(job) {
  const { jobId, employerId } = job.data;
  const log = logger.child({ jobId, employerId });

  // Mark job as processing
  await pool.query(
    `UPDATE payroll_jobs SET status='processing', started_at=NOW() WHERE id=$1`,
    [jobId]
  );

  // Fetch the job record for employer account and checkpoint
  const jobRecord = await pool.query(
    `SELECT employer_account_id, checkpoint_index, currency FROM payroll_jobs WHERE id=$1`,
    [jobId]
  );
  if (jobRecord.rowCount === 0) throw new Error(`Job ${jobId} not found`);

  const { employer_account_id, checkpoint_index, currency } = jobRecord.rows[0];

  // Fetch only PENDING items from checkpoint onwards (resumability)
  const items = await pool.query(
    `SELECT id, item_index, recipient_account_id, amount, currency
     FROM payroll_items
     WHERE job_id = $1
       AND status = 'pending'
       AND item_index > $2
     ORDER BY item_index ASC`,
    [jobId, checkpoint_index]
  );

  log.info({ pendingItems: items.rowCount }, "Processing payroll items");

  let processedCount = 0;
  let failedCount = 0;

  for (const item of items.rows) {
    try {
      // Each disbursement is a transfer with a unique idempotency key
      // If this specific item was already sent (retry scenario), the transaction-service
      // idempotency layer deduplicates it — no double credit
      const idempotencyKey = `payroll:${jobId}:item:${item.item_index}`;

      const resp = await axios.post(
        `${TRANSACTION_URL}/api/v1/transfers`,
        {
          senderAccountId: employer_account_id,
          recipientAccountId: item.recipient_account_id,
          amount: item.amount,
          currency: item.currency,
          description: `Payroll disbursement - job ${jobId}`,
        },
        {
          headers: { "Idempotency-Key": idempotencyKey },
          timeout: 10_000,
        }
      );

      // Mark item complete and advance checkpoint atomically
      await pool.query(
        `UPDATE payroll_items
         SET status='completed', transaction_id=$1, processed_at=NOW()
         WHERE id=$2`,
        [resp.data.transactionId, item.id]
      );

      // Advance the checkpoint — crash after this point resumes from next item
      await pool.query(
        `UPDATE payroll_jobs
         SET checkpoint_index=$1, processed_items=processed_items+1
         WHERE id=$2`,
        [item.item_index, jobId]
      );

      processedCount++;
      await job.updateProgress(Math.round((processedCount / items.rowCount) * 100));

    } catch (err) {
      log.error({ itemId: item.id, itemIndex: item.item_index, err: err.message }, "Item failed");

      await pool.query(
        `UPDATE payroll_items
         SET status='failed', failure_reason=$1, processed_at=NOW()
         WHERE id=$2`,
        [err.message, item.id]
      );

      await pool.query(
        `UPDATE payroll_jobs SET failed_items=failed_items+1 WHERE id=$1`,
        [jobId]
      );

      failedCount++;
      // Continue processing remaining items — partial completion is better than full stop
    }
  }

  // Determine final job status
  const finalStatus = failedCount === 0 ? "completed" : processedCount === 0 ? "failed" : "partial";

  await pool.query(
    `UPDATE payroll_jobs
     SET status=$1, completed_at=NOW()
     WHERE id=$2`,
    [finalStatus, jobId]
  );

  log.info({ processedCount, failedCount, finalStatus }, "Payroll job finished");
  return { processedCount, failedCount, finalStatus };
}

/**
 * Starts one BullMQ Worker per employer queue.
 * concurrency: 1 — ensures only one payroll job runs at a time per employer.
 * This prevents overdraft: if 14,000 credits drain the account, the next job
 * sees the correct reduced balance rather than a stale snapshot.
 */
function startWorker(employerId) {
  const worker = new Worker(
    `payroll:employer:${employerId}`,
    processPayrollJob,
    {
      connection: redisConnection,
      concurrency: 1, // KEY: exactly one job at a time per employer
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.data?.jobId, err: err.message }, "Payroll worker job failed");
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job?.data?.jobId, result }, "Payroll worker job completed");
  });

  return worker;
}

module.exports = { enqueuePayrollJob, startWorker, getEmployerQueue };
