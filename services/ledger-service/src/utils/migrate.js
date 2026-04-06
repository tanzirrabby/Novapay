const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ledger_entries — the immutable source of financial truth
    // Every money movement produces exactly TWO rows here (debit + credit)
    // Rows are NEVER updated or deleted — only appended
    await client.query(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL,
        account_id     UUID NOT NULL,
        entry_type     VARCHAR(6) NOT NULL CHECK (entry_type IN ('debit', 'credit')),
        amount         BIGINT NOT NULL CHECK (amount > 0),   -- always positive; direction via entry_type
        currency       CHAR(3) NOT NULL,
        locked_fx_rate NUMERIC(18, 8),                      -- non-null for cross-currency entries
        description    TEXT,
        -- Audit hash chain: SHA-256(prev_hash || entry data)
        -- Tampered records are detectable because the chain breaks
        entry_hash     CHAR(64) NOT NULL,
        prev_hash      CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Partial index — fast lookup of entries per transaction
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ledger_transaction_id
      ON ledger_entries(transaction_id);
    `);

    // Fast account balance reconstruction from ledger (audit path)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ledger_account_id
      ON ledger_entries(account_id, created_at DESC);
    `);

    // ledger_invariant_log — records any detected violation
    // A nonzero row count here is a CRITICAL alert
    await client.query(`
      CREATE TABLE IF NOT EXISTS ledger_invariant_violations (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID,
        detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        details        JSONB
      );
    `);

    await client.query("COMMIT");
    console.log("[ledger-service] Migrations applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[ledger-service] Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
