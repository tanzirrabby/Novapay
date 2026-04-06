const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // idempotency_keys — the core table preventing duplicate disbursements
    // Scenario A/B: INSERT ... ON CONFLICT DO NOTHING + SELECT FOR UPDATE
    // Scenario D: expires_at column — 24h TTL enforced here
    // Scenario E: payload_hash compared on conflict
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key           VARCHAR(255) NOT NULL,
        payload_hash  VARCHAR(64)  NOT NULL,   -- SHA-256 of sorted payload
        status        VARCHAR(20)  NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing','completed','failed')),
        response_body JSONB,                   -- cached response for idempotent replay
        transaction_id UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        PRIMARY KEY (key)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_idempotency_expires
      ON idempotency_keys(expires_at);
    `);

    // transactions — every money movement initiated here
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key VARCHAR(255),
        type            VARCHAR(30) NOT NULL
                          CHECK (type IN ('transfer','disbursement','fee','fx_transfer','reversal')),
        status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','completed','failed','reversed')),
        sender_account_id    UUID NOT NULL,
        recipient_account_id UUID NOT NULL,
        amount          BIGINT NOT NULL CHECK (amount > 0),  -- minor units
        currency        CHAR(3) NOT NULL,
        fx_quote_id     UUID,                -- set for cross-currency
        locked_fx_rate  NUMERIC(18,8),       -- rate at time of quote
        description     TEXT,
        failure_reason  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_sender
      ON transactions(sender_account_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_recipient
      ON transactions(recipient_account_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_status
      ON transactions(status) WHERE status IN ('pending','processing');
    `);

    // Transaction history — pre-aggregated view (avoids 40M row live scan)
    // Each account has a pre-built history page stored as JSONB
    // Updated incrementally on each transaction — NOT recalculated from scratch
    await client.query(`
      CREATE TABLE IF NOT EXISTS transaction_history_cache (
        account_id    UUID PRIMARY KEY,
        last_tx_id    UUID,
        page_data     JSONB NOT NULL DEFAULT '[]',   -- last 50 transactions
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("[transaction-service] Migrations applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[transaction-service] Migration failed:", err.message);
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
