const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // audit_logs — tamper-evident chained log for compliance
    // Each entry hashes the previous entry's hash — tampering breaks the chain
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        action      VARCHAR(100) NOT NULL,
        actor_id    UUID,
        actor_type  VARCHAR(20) DEFAULT 'admin',
        target_type VARCHAR(50),
        target_id   UUID,
        details     JSONB,
        entry_hash  CHAR(64) NOT NULL,
        prev_hash   CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);`);

    await client.query("COMMIT");
    console.log("[admin-service] Migrations applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => { console.error(err); process.exit(1); });
