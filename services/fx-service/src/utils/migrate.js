const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // fx_quotes — time-locked rate quotes
    // Each quote is single-use: status transitions active -> used (one-way)
    // expired quotes are set by background job or detected on use
    await client.query(`
      CREATE TABLE IF NOT EXISTS fx_quotes (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_currency  CHAR(3) NOT NULL,
        to_currency    CHAR(3) NOT NULL,
        rate           NUMERIC(18, 8) NOT NULL,   -- locked rate at quote time
        amount_from    BIGINT NOT NULL,            -- amount in from_currency (minor units)
        amount_to      BIGINT NOT NULL,            -- pre-computed amount in to_currency
        status         VARCHAR(10) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'used', 'expired')),
        requested_by   UUID,                       -- userId
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '60 seconds',
        used_at        TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fx_quotes_status
      ON fx_quotes(status, expires_at);
    `);

    // fx_rates_log — historical rate snapshots from provider
    await client.query(`
      CREATE TABLE IF NOT EXISTS fx_rates_log (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_currency CHAR(3) NOT NULL,
        to_currency   CHAR(3) NOT NULL,
        rate          NUMERIC(18, 8) NOT NULL,
        source        VARCHAR(50) DEFAULT 'provider',
        fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("[fx-service] Migrations applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[fx-service] Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => { console.error(err); process.exit(1); });
