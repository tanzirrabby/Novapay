const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Computes SHA-256 of the sorted request payload.
 * Sorting keys ensures { a:1, b:2 } and { b:2, a:1 } produce the same hash.
 * This is used for Scenario E detection (same key, different payload).
 */
function hashPayload(body) {
  const sorted = JSON.stringify(
    Object.keys(body)
      .sort()
      .reduce((acc, k) => { acc[k] = body[k]; return acc; }, {})
  );
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

/**
 * Idempotency Middleware
 *
 * Reads the Idempotency-Key header and enforces exactly-once processing.
 *
 * Scenario A — Same key arrives twice (sequential):
 *   First request: INSERT succeeds, status='processing'. Request proceeds.
 *   Second request: INSERT fails (ON CONFLICT DO NOTHING), 0 rows returned.
 *   Middleware polls until status becomes 'completed', then returns cached response.
 *
 * Scenario B — Three identical requests within 100ms (concurrent):
 *   All three hit INSERT simultaneously. PostgreSQL's atomic INSERT ON CONFLICT
 *   ensures exactly one wins. The two losing requests get 0 rows — they poll.
 *   No second debit ever occurs.
 *
 * Scenario D — Key reused 30 hours later (after 24h expiry):
 *   expires_at < NOW() — the old row is gone (cleaned by cron).
 *   A new INSERT succeeds. The request is treated as brand new and re-processed.
 *
 * Scenario E — Same key, different payload:
 *   INSERT fails on conflict. We SELECT the stored payload_hash.
 *   If it differs from the incoming request's hash → 422 Unprocessable Entity.
 */
async function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers["idempotency-key"];

  // Idempotency is optional for GET requests
  if (!idempotencyKey || req.method === "GET") {
    return next();
  }

  const payloadHash = hashPayload(req.body);

  const client = await pool.connect();
  try {
    // Attempt to claim the idempotency key atomically
    // ON CONFLICT DO NOTHING — if key exists, 0 rows inserted
    const insert = await client.query(
      `INSERT INTO idempotency_keys (key, payload_hash, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (key) DO NOTHING
       RETURNING key, status`,
      [idempotencyKey, payloadHash]
    );

    if (insert.rowCount === 1) {
      // We claimed the key — this is the first (or only) request. Proceed.
      req.idempotencyKey = idempotencyKey;
      req.payloadHash = payloadHash;

      // After handler completes, cache the response
      const originalJson = res.json.bind(res);
      res.json = async function (body) {
        if (res.statusCode < 500) {
          await pool.query(
            `UPDATE idempotency_keys
             SET status = $1, response_body = $2
             WHERE key = $3`,
            [
              res.statusCode < 400 ? "completed" : "failed",
              JSON.stringify({ status: res.statusCode, body }),
              idempotencyKey,
            ]
          );
        }
        return originalJson(body);
      };

      return next();
    }

    // Key already exists — check for Scenario E (payload mismatch)
    const existing = await client.query(
      `SELECT key, payload_hash, status, response_body, expires_at
       FROM idempotency_keys WHERE key = $1`,
      [idempotencyKey]
    );

    if (existing.rowCount === 0) {
      // Race: key was inserted then immediately expired/deleted. Treat as new.
      return next();
    }

    const record = existing.rows[0];

    // Scenario E — payload mismatch
    if (record.payload_hash !== payloadHash) {
      return res.status(422).json({
        error: "Idempotency key reuse with a different payload is not allowed.",
        code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
        hint: "Use a new Idempotency-Key for a different request.",
      });
    }

    // Scenario A/B — same key, same payload, already completed: return cached response
    if (record.status === "completed" || record.status === "failed") {
      const cached = record.response_body;
      return res
        .status(cached.status)
        .set("X-Idempotent-Replayed", "true")
        .json(cached.body);
    }

    // Status is 'processing' — another request is currently in flight (Scenario B concurrent case)
    // Poll for up to 5 seconds, then return 202 Accepted
    let attempts = 0;
    while (attempts < 10) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await pool.query(
        `SELECT status, response_body FROM idempotency_keys WHERE key = $1`,
        [idempotencyKey]
      );
      if (poll.rowCount > 0 && poll.rows[0].status !== "processing") {
        const cached = poll.rows[0].response_body;
        return res
          .status(cached.status)
          .set("X-Idempotent-Replayed", "true")
          .json(cached.body);
      }
      attempts++;
    }

    // Still processing after 5s — return 202 to let client retry
    return res.status(202).json({
      message: "Request is still being processed. Retry with the same Idempotency-Key.",
      code: "PROCESSING",
    });
  } finally {
    client.release();
  }
}

module.exports = { idempotencyMiddleware, hashPayload };
