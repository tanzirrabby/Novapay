const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // payroll_jobs — one row per bulk disbursement submission
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_jobs (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employer_id       UUID NOT NULL,
        employer_account_id UUID NOT NULL,
        status            VARCHAR(20) NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','processing','completed','failed','partial')),
        total_items       INTEGER NOT NULL DEFAULT 0,
        processed_items   INTEGER NOT NULL DEFAULT 0,
        failed_items      INTEGER NOT NULL DEFAULT 0,
        -- Resumability checkpoint: last successfully processed item index
        -- On crash, recovery resumes from checkpoint_index + 1
        checkpoint_index  INTEGER NOT NULL DEFAULT -1,
        total_amount      BIGINT NOT NULL DEFAULT 0,
        currency          CHAR(3) NOT NULL,
        idempotency_key   VARCHAR(255),
        submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ,
        CONSTRAINT payroll_jobs_idempotency_unique UNIQUE (idempotency_key)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_jobs_employer
      ON payroll_jobs(employer_id, submitted_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_jobs_status
      ON payroll_jobs(status) WHERE status IN ('queued','processing');
    `);

    // payroll_items — individual employee disbursements within a job
    // Ordered by item_index for deterministic resumability
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_items (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id            UUID NOT NULL REFERENCES payroll_jobs(id),
        item_index        INTEGER NOT NULL,       -- position in the batch (0-based)
        employee_id       UUID NOT NULL,
        recipient_account_id UUID NOT NULL,
        amount            BIGINT NOT NULL CHECK (amount > 0),
        currency          CHAR(3) NOT NULL,
        status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','completed','failed')),
        transaction_id    UUID,                  -- set after successful transfer
        failure_reason    TEXT,
        processed_at      TIMESTAMPTZ,
        CONSTRAINT payroll_items_job_index_unique UNIQUE (job_id, item_index)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_items_job_pending
      ON payroll_items(job_id, item_index)
      WHERE status = 'pending';
    `);

    await client.query("COMMIT");
    console.log("[payroll-service] Migrations applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[payroll-service] Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => { console.error(err); process.exit(1); });
