# NovaPay — Rebuilt Transaction Backend

A production-grade financial transaction backend built as a microservices system.
Solves duplicate disbursements, unbalanced ledgers, stale FX rates, and database overload
through idempotency, double-entry bookkeeping, time-locked FX quotes, and pre-aggregated history.

---

## Architecture

```
                         ┌─────────────────────────────────────────┐
                         │            NGINX API Gateway             │
                         │         localhost:8080                   │
                         └────────────────┬────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
     ┌────────▼──────┐          ┌─────────▼──────┐         ┌────────▼──────┐
     │ Account Svc   │          │ Transaction Svc│         │  Ledger Svc   │
     │  :3001        │          │    :3002       │         │   :3003       │
     │  Wallets      │◄─────────┤  Idempotency   ├────────►│ Double-Entry  │
     │  Balances     │          │  Saga Recovery │         │ Hash Chain    │
     └──────┬────────┘          └────────┬───────┘         └──────┬────────┘
            │ account-db                 │ transaction-db          │ ledger-db
            │                           │                          │
     ┌──────▼────────┐          ┌────────▼───────┐         ┌──────▼────────┐
     │  FX Svc :3004 │          │ Payroll Svc    │         │  Admin Svc    │
     │  Rate Quotes  │◄─────────┤   :3005        │         │   :3006       │
     │  60s TTL      │          │  BullMQ Queue  │         │  Audit Logs   │
     └──────┬────────┘          └────────┬───────┘         └──────┬────────┘
            │ fx-db                      │ payroll-db              │ admin-db
            │                           │
            │                    ┌──────▼────────┐
            │                    │     Redis      │
            └────────────────────┤  BullMQ Jobs  │
                                 │  Idempotency  │
                                 └───────────────┘

Observability: Prometheus :9090 → Grafana :3000 | Jaeger :16686
```

### Services

| Service | Port | Responsibility |
|---|---|---|
| account-service | 3001 | User wallets, balance reads/writes, field-level encrypted PII |
| transaction-service | 3002 | Transfer initiation, idempotency enforcement, saga recovery |
| ledger-service | 3003 | Double-entry bookkeeping, invariant verification, hash chain |
| fx-service | 3004 | Time-locked rate quotes (60s TTL), single-use enforcement |
| payroll-service | 3005 | Bulk disbursements via BullMQ, checkpoint-based resumability |
| admin-service | 3006 | Operations panel, compliance audit log, system health |

---

## Setup & Running

### Prerequisites

- Docker 24+ and Docker Compose v2
- Git

### Start everything

```bash
git clone <repo-url>
cd novapay/infra
docker compose up --build
```

All services, databases, Redis, Prometheus, Grafana, and Jaeger start automatically.
Migrations run on first boot.

### Verify all services are healthy

```bash
curl http://localhost:8080/health
# → {"status":"ok"}

# Individual service health
curl http://localhost:8080/api/v1/accounts  # → 404 (no body)
```

### Access dashboards

| Tool | URL | Credentials |
|---|---|---|
| Grafana | http://localhost:3000 | admin / admin |
| Prometheus | http://localhost:9090 | — |
| Jaeger | http://localhost:16686 | — |

### Run all tests

```bash
# From repo root
for svc in account-service transaction-service ledger-service fx-service payroll-service admin-service; do
  echo "=== $svc ==="
  cd services/$svc && npm ci && npm test && cd ../..
done
```

---

## API Endpoint Summary

All requests go through the API gateway at `http://localhost:8080`.

### Account Service

#### Create Account
```
POST /api/v1/accounts
```
```json
// Request
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "currency": "USD",
  "fullName": "Jane Doe",
  "phone": "+1-555-0100"
}

// Response 201
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "currency": "USD",
  "balance": 0,
  "status": "active",
  "createdAt": "2024-01-15T09:00:00.000Z"
}
```

#### Get Account
```
GET /api/v1/accounts/:accountId
Headers: x-user-id: <userId>   (PII only returned to owner)
```

#### Update Balance (internal)
```
PATCH /api/v1/accounts/:accountId/balance
{ "delta": -10000 }   // negative = debit, positive = credit, minor units
```

---

### Transaction Service

#### Domestic Transfer
```
POST /api/v1/transfers
Headers: Idempotency-Key: <unique-key>
```
```json
// Request
{
  "senderAccountId": "acc-uuid-1",
  "recipientAccountId": "acc-uuid-2",
  "amount": 50000,
  "currency": "USD",
  "description": "Invoice payment"
}

// Response 201
{
  "transactionId": "tx-uuid",
  "status": "completed",
  "amount": 50000,
  "currency": "USD",
  "senderAccountId": "acc-uuid-1",
  "recipientAccountId": "acc-uuid-2"
}
```

#### International Transfer
```
POST /api/v1/transfers/international
Headers: Idempotency-Key: <unique-key>
```
```json
// Request — requires a valid, unexpired FX quote
{
  "senderAccountId": "acc-uuid-1",
  "recipientAccountId": "acc-uuid-2",
  "fxQuoteId": "quote-uuid"
}

// Response 201
{
  "transactionId": "tx-uuid",
  "status": "completed",
  "fromCurrency": "USD",
  "toCurrency": "EUR",
  "amountFrom": 200000,
  "amountTo": 184000,
  "lockedRate": 0.92,
  "fxQuoteId": "quote-uuid"
}
```

#### Transaction History
```
GET /api/v1/transactions/history/:accountId
```
Returns pre-cached history (no full table scan). Served from
`transaction_history_cache` — updated incrementally per completed transaction.

---

### FX Service

#### Issue Rate Quote
```
POST /api/v1/fx/quote
```
```json
// Request
{
  "fromCurrency": "USD",
  "toCurrency": "EUR",
  "amountFrom": 200000,
  "userId": "user-uuid"
}

// Response 201
{
  "quoteId": "quote-uuid",
  "fromCurrency": "USD",
  "toCurrency": "EUR",
  "rate": 0.92,
  "amountFrom": 200000,
  "amountTo": 184000,
  "status": "active",
  "expiresAt": "2024-01-15T09:01:00.000Z",
  "ttlSeconds": 60,
  "warning": "This quote expires in 60 seconds and is valid for one use only."
}
```

#### Check Quote Validity
```
GET /api/v1/fx/quote/:id
```
```json
{
  "quoteId": "quote-uuid",
  "rate": 0.92,
  "status": "active",
  "ttlSeconds": 38,
  "valid": true
}
```

---

### Payroll Service

#### Submit Payroll Job
```
POST /api/v1/payroll/jobs
Headers: Idempotency-Key: <unique-key>
```
```json
// Request
{
  "employerId": "employer-uuid",
  "employerAccountId": "acc-uuid",
  "currency": "USD",
  "disbursements": [
    { "employeeId": "emp-1", "recipientAccountId": "acc-1", "amount": 350000 },
    { "employeeId": "emp-2", "recipientAccountId": "acc-2", "amount": 420000 }
  ]
}

// Response 202
{
  "jobId": "job-uuid",
  "status": "queued",
  "totalItems": 2,
  "totalAmount": 770000,
  "message": "Payroll job queued. Poll GET /api/v1/payroll/jobs/:jobId for progress."
}
```

#### Poll Job Progress
```
GET /api/v1/payroll/jobs/:jobId
```
```json
{
  "jobId": "job-uuid",
  "status": "processing",
  "progress": "71%",
  "totalItems": 14000,
  "processedItems": 9940,
  "failedItems": 3,
  "checkpointIndex": 9939
}
```

---

### Ledger Service

#### Record Entries (internal)
```
POST /api/v1/ledger/entries
```
```json
{
  "transactionId": "tx-uuid",
  "entries": [
    { "account_id": "acc-1", "entry_type": "debit",  "amount": 50000, "currency": "USD" },
    { "account_id": "acc-2", "entry_type": "credit", "amount": 50000, "currency": "USD" }
  ]
}
```

#### Verify Invariant
```
GET /api/v1/ledger/verify/:transactionId
```
```json
{
  "transactionId": "tx-uuid",
  "balanced": true,
  "net": 0,
  "entryCount": 2
}
```

#### Account History (cursor-paginated, index-backed)
```
GET /api/v1/ledger/entries/account/:accountId?limit=50&before=<cursor>
```

---

### Admin Service

#### System Health
```
GET /api/v1/admin/system/health
```

#### Run Invariant Check
```
GET /api/v1/admin/ledger/invariant
```

#### Audit Logs
```
GET /api/v1/admin/audit-logs
GET /api/v1/admin/audit-logs/verify   ← re-computes hash chain
```

---

## Idempotency Scenarios — Exact Handling

See `decisions.md` for full detail. Summary:

| Scenario | Trigger | Result |
|---|---|---|
| A — Same key twice (sequential) | `INSERT ON CONFLICT DO NOTHING` → 0 rows | Cached response returned, no second debit |
| B — Three concurrent requests | One INSERT wins atomically; two poll until complete | Exactly one disbursement, two get cached replay |
| C — Crash between debit and credit | `status='processing'` + `updated_at < NOW()-30s` | Saga recovery completes or reverses the saga |
| D — Key reused after 24h expiry | Row deleted by cleanup; INSERT succeeds fresh | Request processed as new — documented behavior |
| E — Same key, different payload | SHA-256 hash comparison fails | HTTP 422 with `IDEMPOTENCY_PAYLOAD_MISMATCH` |

---

## Double-Entry Invariant

Every money movement writes exactly two ledger rows:

```
User sends $500:
  DEBIT  sender_wallet   $500
  CREDIT recipient_wallet $500

NovaPay collects $2 fee:
  DEBIT  sender_wallet   $2
  CREDIT novapay_fee_acct $2
```

Invariant: `SUM(credits) - SUM(debits) = 0` for every transaction.

Verified by:
1. Pre-write check in `POST /api/v1/ledger/entries`
2. Background `GET /api/v1/ledger/invariant-check` job (runs every minute)
3. Prometheus counter `ledger_invariant_violations_total` — alert fires instantly if > 0

---

## FX Quote Strategy

1. **Quote on demand:** Rate is fetched live from provider at quote time, never cached.
2. **60-second TTL:** `expires_at = NOW() + INTERVAL '60 seconds'`
3. **Single-use:** Atomic `UPDATE ... WHERE status='active' AND expires_at > NOW()`.
   Concurrent attempts: only one wins. Second gets `409 QUOTE_ALREADY_USED`.
4. **Expired quotes:** Return `410 QUOTE_EXPIRED` with instruction to re-initiate.
5. **Provider failure:** `fetchLiveRate()` throws → HTTP 503 `FX_PROVIDER_UNAVAILABLE`.
   Never silently applies a stale rate.
6. **Rate on ledger:** `locked_fx_rate` column on every cross-currency ledger entry.
   Permanent record of the exact rate applied to each transfer.

---

## Payroll Resumability

The checkpoint pattern used:

```sql
-- Advance checkpoint after each successful item
UPDATE payroll_jobs
SET checkpoint_index = <item_index>,
    processed_items = processed_items + 1
WHERE id = <jobId>;

-- On resume: only fetch items past the checkpoint
SELECT * FROM payroll_items
WHERE job_id = $1
  AND status = 'pending'
  AND item_index > $2   -- checkpoint_index
ORDER BY item_index ASC;
```

Each item uses a deterministic idempotency key: `payroll:<jobId>:item:<itemIndex>`.
Even if the same item is retried, the transaction-service deduplicates it.

---

## Audit Hash Chain

Each audit log entry stores:
- `entry_hash = SHA256(prev_hash | id | action | actor_id | created_at)`
- `prev_hash` = hash of the immediately preceding entry

**Tamper detection:** If any historical entry is modified, its hash changes, which
invalidates every subsequent hash in the chain. Running
`GET /api/v1/admin/audit-logs/verify` re-computes all hashes and reports any break.

---

## Tradeoffs Under Time Pressure

- **Auth is stubbed:** `x-user-id` and `x-admin-id` headers are trusted. Production
  requires JWT validation middleware on every service.
- **FX rates are mocked:** Real provider call is one function swap in `rateProvider.js`.
- **Idempotency key cleanup:** Documented but not wired to a cron. Use `pg-cron` in prod.
- **Redis is single-node:** Production needs Redis Sentinel or Cluster for HA.

---

## What Would Be Added Before Production

1. JWT authentication + RBAC on every service
2. Per-user rate limiting (not just per-IP)
3. Circuit breakers on all inter-service calls (`opossum`)
4. `pgBouncer` connection pooling
5. Secrets via HashiCorp Vault or AWS KMS
6. Real FX provider integration
7. Integration test suite against staging environment
8. `pg-cron` for idempotency key cleanup and invariant scanning
9. Webhook notifications for async payroll job completion
10. Multi-region Postgres replication for the ledger database
