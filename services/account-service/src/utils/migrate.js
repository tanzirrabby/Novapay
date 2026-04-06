// src/utils/migrate.js — runs on service startup
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // accounts table — stores wallet per currency per user
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL,
        currency      CHAR(3) NOT NULL,          -- ISO 4217
        balance       BIGINT NOT NULL DEFAULT 0, -- stored in minor units (cents)
        status        VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','frozen','closed')),
        -- PII stored encrypted (envelope encryption)
        encrypted_full_name  TEXT,
        encrypted_phone      TEXT,
        encrypted_national_id TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT accounts_user_currency_unique UNIQUE (user_id, currency),
        CONSTRAINT accounts_balance_non_negative CHECK (balance >= 0)
      );
    `);

    // Indexes for fast balance lookups
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_accounts_currency ON accounts(currency);`
    );

    // transaction_history — pre-aggregated, updated by ledger events
    // This replaces the 40M-row live query that crashed the DB
    await client.query(`
      CREATE TABLE IF NOT EXISTS balance_snapshots (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id    UUID NOT NULL REFERENCES accounts(id),
        balance       BIGINT NOT NULL,
        snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("[account-service] Migrations applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[account-service] Migration failed:", err.message);
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
