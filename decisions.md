# NovaPay — Architectural Decisions

This document records every significant design decision made in the NovaPay rebuild,
with explicit coverage of all five idempotency scenarios required by the assessment.

---

## Idempotency — All Five Scenarios

### Scenario A: Same key arrives twice (sequential)

**What happens at the database level:**

1. First request arrives with `Idempotency-Key: key-abc`.
2. Middleware executes:
   ```sql
   INSERT INTO idempotency_keys (key, payload_hash, status)
   VALUES ('key-abc', '<hash>', 'processing')
   ON CONFLICT (key) DO NOTHING
   RETURNING key;
   ```
3. `rowCount = 1` → key was claimed. Request proceeds through the handler.
4. After the handler completes, the middleware patches the row:
   ```sql
   UPDATE idempotency_keys
   SET status = 'completed', response_body = '<cached JSON>'
   WHERE key = 'key-abc';
   ```
5. Second request arrives. `INSERT ... ON CONFLICT DO NOTHING` returns `rowCount = 0`.
6. Middleware reads the existing row: `status = 'completed'`.
7. Returns the cached response directly. **No second debit ever executes.**

**Result:** Exactly one disbursement. Second call receives HTTP 200 with
`X-Idempotent-Replayed: true` header.

---

### Scenario B: Three identical requests arrive within 100ms (concurrent)

**Exact mechanism:**

All three requests hit the middleware simultaneously. All three fire:
```sql
INSERT INTO idempotency_keys (key, payload_hash, status)
VALUES ('key-abc', '<hash>', 'processing')
ON CONFLICT (key) DO NOTHING;
```

PostgreSQL's `INSERT ... ON CONFLICT DO NOTHING` is **atomic at the row level**.
The database serializes the three concurrent inserts internally. Exactly **one** insert
wins and returns `rowCount = 1`. The other two return `rowCount = 0`.

**What happens to the two losing requests:**

- They enter a poll loop, checking every 500ms for up to 5 seconds:
  ```sql
  SELECT status, response_body FROM idempotency_keys WHERE key = 'key-abc';
  ```
- Once status transitions from `processing` → `completed`, they read and return
  the cached response body.
- If the winning request is still processing after 5 seconds, they return HTTP 202
  with `{ "code": "PROCESSING" }` and instruct the client to retry.

**At the database level:** Only the winning request ever reaches the transfer logic.
The two losing requests never touch the account balance or ledger. There is no race
condition because the primary key constraint on `idempotency_keys.key` is enforced
atomically by PostgreSQL.

---

### Scenario C: Sender debited, server crashes before recipient is credited

**The atomicity problem — Saga pattern with background recovery:**

The transaction saga has six steps:

```
Step 1: INSERT transaction (status='processing')
Step 2: PATCH account (debit sender)         ← crash here leaves balance wrong
Step 3: POST ledger entries (debit+credit)   ← crash here leaves ledger unbalanced
Step 4: PATCH account (credit recipient)     ← crash here loses money
Step 5: UPDATE transaction (status='completed')
```

Any crash between steps 2–5 leaves the system in an inconsistent state.

**Recovery mechanism:**

On service startup and every 60 seconds, the saga recovery job runs:

```sql
SELECT id, sender_account_id, recipient_account_id, amount, currency
FROM transactions
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '30 seconds'
LIMIT 50;
```

For each stale transaction, it queries the ledger service for existing entries:

| Ledger state | Recovery action |
|---|---|
| No debit, no credit | Mark transaction `failed` — nothing happened, safe to retry |
| Debit exists, no credit | POST the missing credit entry + credit recipient balance → mark `completed` |
| Both entries exist | Status update was lost — mark `completed`, ledger already balanced |

This guarantees the ledger is always balanced after any crash. Money cannot vanish.
The recovery is idempotent — running it multiple times on the same transaction is safe.

---

### Scenario D: Idempotency key expires after 24h, client retries with same key 30 hours later

**What happens:**

Idempotency keys have a 24-hour TTL enforced by the `expires_at` column:

```sql
expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
```

A background cleanup job (or the next INSERT conflict check) removes expired keys.
When the client retries at the 30-hour mark:

1. The `SELECT` for the old key returns zero rows (expired and cleaned up).
2. The `INSERT` succeeds as if this were a brand new request.
3. The disbursement is **processed again** as a fresh transaction.

**This is the correct behavior.** The 24-hour window exists specifically to prevent
indefinite idempotency key pollution while still covering all reasonable network retry
scenarios. A retry 30 hours later is almost certainly a client bug (as described in
the scenario). The client receives a fresh HTTP 201 response.

**Documentation requirement:** API consumers must be advised that idempotency keys
are valid for 24 hours only and must generate new keys for retries beyond that window.

---

### Scenario E: Client sends key-abc for $500, then key-abc for $800

**Detection mechanism:**

When a request arrives, the middleware computes a SHA-256 hash of the sorted payload:

```javascript
function hashPayload(body) {
  const sorted = JSON.stringify(
    Object.keys(body).sort().reduce((acc, k) => { acc[k] = body[k]; return acc; }, {})
  );
  return crypto.createHash("sha256").update(sorted).digest("hex");
}
```

Sorting keys ensures `{ amount: 500, currency: "USD" }` and
`{ currency: "USD", amount: 500 }` produce the **same hash** — preventing false mismatches
from key ordering differences.

When the second request arrives with key `key-abc` and amount `$800`:
1. `INSERT ... ON CONFLICT DO NOTHING` returns `rowCount = 0` (key exists).
2. Middleware reads the stored `payload_hash`.
3. Computes hash of the incoming `$800` payload.
4. Stored hash (`$500`) ≠ incoming hash (`$800`).
5. Returns immediately:

```json
HTTP 422 Unprocessable Entity
{
  "error": "Idempotency key reuse with a different payload is not allowed.",
  "code": "IDEMPOTENCY_PAYLOAD_MISMATCH",
  "hint": "Use a new Idempotency-Key for a different request."
}
```

**No money movement occurs.** The error is deterministic and fast — no database
write, no service calls, no ledger entries.

---

## Problem 2: Bulk Payroll — BullMQ with concurrency=1 per employer

### Why not a database lock?

**Option A — `SELECT FOR UPDATE` row lock:**
- Holds a live PostgreSQL connection open for the entire job duration.
- For 14,000 credits at ~50ms each, that is ~12 minutes of locked connection.
- Under 200 concurrent employers: 200 blocked connections sitting idle.
- If the process crashes, the lock releases but job state is unknown.
- No built-in retry, no progress visibility, no dead-letter queue, no backoff.

**Option B — BullMQ queue scoped per employer (chosen):**
- Each employer gets their own named queue: `payroll:employer:<employerId>`
- `concurrency: 1` on that queue ensures exactly one job runs at a time per employer.
- No database connections are held during processing — each credit is a short transaction.
- **Durable:** Jobs persist in Redis across process restarts.
- **Resumable:** `checkpoint_index` tracks the last successfully processed item.
  After a crash with 3,000/14,000 credits complete, the job resumes at index 3,001.
- **Isolated:** Employer A's queue never blocks employer B's queue.
- Built-in retry with exponential backoff for transient transfer failures.
- Progress is visible in real time via `GET /api/v1/payroll/jobs/:jobId`.

### Checkpoint pattern

Every time a payroll item succeeds, the checkpoint advances atomically:

```sql
UPDATE payroll_jobs
SET checkpoint_index = <item_index>, processed_items = processed_items + 1
WHERE id = <jobId>;
```

On recovery (restart or re-queue), the worker queries only pending items
**after** the checkpoint:

```sql
SELECT * FROM payroll_items
WHERE job_id = $1
  AND status = 'pending'
  AND item_index > $2   -- checkpoint_index
ORDER BY item_index ASC;
```

This means partial failures never cause double-payments. Items before the checkpoint
are already complete. Items after it are processed fresh. Each item's transfer uses
a deterministic idempotency key: `payroll:<jobId>:item:<itemIndex>` — so even if
the same item is attempted twice due to a retry, the transaction service deduplicates it.

---

## Problem 3: FX Rate Locking

### Why time-locked quotes?

The original failure: a rate fetched at 9:00am was applied at 10:45am. The customer
lost $320 on a $2,000 transfer because the rate moved 16% in 105 minutes.

**Our solution — 60-second TTL locked quotes:**

1. Client calls `POST /api/v1/fx/quote` → receives `{ quoteId, rate, expiresAt, ttlSeconds }`.
2. The rate is fetched **live** from the provider at quote time. It is stored in `fx_quotes`.
3. Client immediately calls `POST /api/v1/transfers/international` with `fxQuoteId`.
4. Transaction service calls `POST /api/v1/fx/quote/:id/use`:
   ```sql
   UPDATE fx_quotes
   SET status = 'used', used_at = NOW()
   WHERE id = $1
     AND status = 'active'
     AND expires_at > NOW()
   RETURNING rate, ...;
   ```
   If `rowCount = 0`: quote is expired or already used → reject with clear error.
5. The locked `rate` is written to every ledger entry for this transaction.

**Single-use enforcement:** The `UPDATE ... WHERE status = 'active'` is atomic.
Two concurrent requests using the same quote: only one `UPDATE` wins. The second
gets `rowCount = 0` and receives HTTP 409 `QUOTE_ALREADY_USED`.

**Provider failure:** `fetchLiveRate()` throws if the provider is unreachable.
The quote endpoint catches this and returns HTTP 503 `FX_PROVIDER_UNAVAILABLE`.
We **never** silently fall back to a cached or stale rate. The customer is always
told explicitly when their transfer cannot proceed.

---

## Problem 4: Field-Level Encryption (Envelope Encryption)

### Two-key hierarchy

**Layer 1 — Master Encryption Key (MEK):**
- 256-bit key loaded from environment variable at service startup.
- In production: sourced from AWS KMS, HashiCorp Vault, or GCP Cloud KMS.
- Never written to disk or database.

**Layer 2 — Data Encryption Key (DEK):**
- Fresh 256-bit key generated per record using `crypto.randomBytes(32)`.
- Encrypted by the MEK using AES-256-GCM before storage.
- Stored alongside the encrypted data in the database.

**Encryption flow for each PII field:**

```
plaintext → AES-256-GCM(DEK) → ciphertext
DEK       → AES-256-GCM(MEK) → encryptedDek
```

**Stored in database (JSON envelope):**
```json
{
  "encryptedDek": "<base64>",
  "dekIv":        "<base64>",
  "dekTag":       "<base64>",
  "iv":           "<base64>",
  "tag":          "<base64>",
  "ciphertext":   "<base64>"
}
```

**Why envelope encryption over simple field encryption?**
- Key rotation: to rotate the MEK, re-encrypt only the DEKs — not every record.
- Tamper detection: AES-GCM authentication tags detect any bit-level modification.
- Each record has a unique IV and DEK — identical plaintext values produce different ciphertexts.

**What is never logged or returned:**
- Raw PII values never appear in log lines (pino `redact` config).
- Encrypted envelopes are never returned in API responses.
- Only the account owner (verified by `x-user-id` header match) receives decrypted PII.

---

## Double-Entry Ledger Invariant

Every money movement produces exactly two ledger entries. The sum of all credits minus
all debits for any transaction must equal zero:

```sql
SELECT SUM(
  CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END
) AS net
FROM ledger_entries
WHERE transaction_id = $1;
-- Must always = 0
```

**How it is verified:**
1. On every `POST /api/v1/ledger/entries` call — amounts are checked before writing.
2. Background job via `GET /api/v1/ledger/invariant-check` runs every minute across
   all recent transactions.
3. Any violation increments the `ledger_invariant_violations_total` Prometheus counter.
4. A Prometheus alert fires **immediately** (no delay) when this counter exceeds zero.

**Hash chain for tamper detection:**
Each ledger entry stores:
- `entry_hash = SHA256(prev_hash || transactionId || accountId || entryType || amount || currency || createdAt)`
- `prev_hash` = the hash of the previous entry for that account

Tampering with any field changes the hash, which breaks all subsequent hashes in the chain.
The admin service exposes `GET /api/v1/admin/audit-logs/verify` to re-verify the full chain.

---

## Architecture Decisions

### Microservices over monolith

Chosen because the assessment explicitly requires service isolation with no shared databases.
Each service owns its schema, can be deployed and scaled independently, and fails in isolation.

### No shared databases

Each service has its own PostgreSQL instance. Communication is via HTTP (synchronous)
for reads and BullMQ/Redis (asynchronous) for payroll. This prevents a slow query in
one service from starving another.

### Amounts stored as integers (minor units)

All monetary amounts are stored as `BIGINT` in minor units (cents for USD, pence for GBP).
This eliminates floating-point rounding errors entirely. `$19.99` is stored as `1999`.

### Cursor-based pagination for transaction history

The original system ran a live query across 40 million rows on every page load, causing
100% CPU and a 22-minute database outage. Our solution:

1. **Pre-aggregated cache:** `transaction_history_cache` stores the last 50 transactions
   per account as JSONB. Updated incrementally on each completed transaction.
2. **Indexed fallback:** Cache miss falls back to a bounded indexed query (`LIMIT 50`)
   using the `sender_account_id` and `recipient_account_id` indexes.
3. **Cursor pagination:** `created_at`-based cursors prevent offset scans.

No full table scan ever occurs in production.

### Tradeoffs made under time pressure

- **Auth middleware is stubbed:** In production, every service would validate a JWT.
  The `x-user-id` and `x-admin-id` headers are trusted as-is here.
- **FX rates are mocked:** `MOCK_RATES` in `rateProvider.js` replaces the real provider call.
  The abstraction is correct — swapping in a real HTTP call is one line.
- **Redis connection reuse:** BullMQ connections are not pooled across queues.
  In production, a shared `IORedis` connection pool would be used.
- **Idempotency key cleanup:** The expired key cleanup job is documented but not wired
  to a cron. In production, a `pg-cron` job would purge rows where `expires_at < NOW()`.

### What would be added before production

1. **JWT authentication** on every service with RBAC (role-based access control).
2. **Rate limiting** per user ID, not just per IP, to prevent API abuse.
3. **Circuit breakers** on inter-service HTTP calls (e.g., `opossum` library).
4. **Database connection pooling** with `pgBouncer` to handle traffic spikes.
5. **Secrets management** via HashiCorp Vault or AWS Secrets Manager instead of env vars.
6. **Real FX provider** integration (Open Exchange Rates, Wise, or a bank API).
7. **End-to-end integration tests** against a staging environment with real Postgres and Redis.
8. **Data retention policy** — ledger entries are immutable but need archival after 7 years.
9. **Webhook notifications** to inform clients of async payroll job completion.
10. **Multi-region failover** for the ledger database (the financial source of truth).
