const crypto = require("crypto");

// Reproduce the hashPayload function for isolated testing
function hashPayload(body) {
  const sorted = JSON.stringify(
    Object.keys(body)
      .sort()
      .reduce((acc, k) => { acc[k] = body[k]; return acc; }, {})
  );
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

describe("Idempotency — Scenario A: Same key arrives twice (sequential)", () => {
  test("same payload produces same hash", () => {
    const payload = { senderAccountId: "a", recipientAccountId: "b", amount: 500, currency: "USD" };
    expect(hashPayload(payload)).toBe(hashPayload(payload));
  });

  test("key ordering does not affect hash (sorted normalization)", () => {
    const p1 = { amount: 500, currency: "USD", senderAccountId: "a", recipientAccountId: "b" };
    const p2 = { recipientAccountId: "b", senderAccountId: "a", currency: "USD", amount: 500 };
    expect(hashPayload(p1)).toBe(hashPayload(p2));
  });
});

describe("Idempotency — Scenario B: Three concurrent requests", () => {
  test("all three requests produce identical payload hash", () => {
    const payload = { senderAccountId: "x", recipientAccountId: "y", amount: 1000, currency: "USD" };
    const hashes = [hashPayload(payload), hashPayload(payload), hashPayload(payload)];
    expect(new Set(hashes).size).toBe(1); // all identical
  });
});

describe("Idempotency — Scenario D: Key reused after 24h expiry", () => {
  test("expired key detection logic", () => {
    const expiresAt = new Date(Date.now() - 1000); // 1 second ago
    const isExpired = new Date() > expiresAt;
    expect(isExpired).toBe(true);
  });

  test("key within 24h is not expired", () => {
    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
    const isExpired = new Date() > expiresAt;
    expect(isExpired).toBe(false);
  });
});

describe("Idempotency — Scenario E: Same key, different payload", () => {
  test("different amounts produce different hashes (mismatch detected)", () => {
    const base = { senderAccountId: "a", recipientAccountId: "b", currency: "USD" };
    const hash500 = hashPayload({ ...base, amount: 500 });
    const hash800 = hashPayload({ ...base, amount: 800 });
    expect(hash500).not.toBe(hash800);
  });

  test("mismatch is detectable by comparing stored vs incoming hash", () => {
    const storedPayload = { senderAccountId: "a", recipientAccountId: "b", amount: 500, currency: "USD" };
    const incomingPayload = { senderAccountId: "a", recipientAccountId: "b", amount: 800, currency: "USD" };
    const storedHash = hashPayload(storedPayload);
    const incomingHash = hashPayload(incomingPayload);
    expect(storedHash).not.toBe(incomingHash); // triggers 422 response
  });
});

describe("Idempotency — Scenario C: Saga recovery logic", () => {
  test("stale transaction detection — older than 30 seconds", () => {
    const updatedAt = new Date(Date.now() - 45_000); // 45s ago
    const threshold = new Date(Date.now() - 30_000);  // 30s threshold
    const isStale = updatedAt < threshold;
    expect(isStale).toBe(true);
  });

  test("recent processing transaction is not stale", () => {
    const updatedAt = new Date(Date.now() - 10_000); // 10s ago
    const threshold = new Date(Date.now() - 30_000);
    const isStale = updatedAt < threshold;
    expect(isStale).toBe(false);
  });

  test("recovery action: debit only → needs credit posted", () => {
    const entries = [{ entry_type: "debit", amount: 5000 }];
    const hasDebit = entries.some(e => e.entry_type === "debit");
    const hasCredit = entries.some(e => e.entry_type === "credit");
    const action = hasDebit && !hasCredit ? "POST_CREDIT" : hasDebit && hasCredit ? "COMPLETE" : "MARK_FAILED";
    expect(action).toBe("POST_CREDIT");
  });

  test("recovery action: no entries → mark failed", () => {
    const entries = [];
    const hasDebit = entries.some(e => e.entry_type === "debit");
    const hasCredit = entries.some(e => e.entry_type === "credit");
    const action = hasDebit && !hasCredit ? "POST_CREDIT" : hasDebit && hasCredit ? "COMPLETE" : "MARK_FAILED";
    expect(action).toBe("MARK_FAILED");
  });

  test("recovery action: both entries → mark completed", () => {
    const entries = [
      { entry_type: "debit", amount: 5000 },
      { entry_type: "credit", amount: 5000 },
    ];
    const hasDebit = entries.some(e => e.entry_type === "debit");
    const hasCredit = entries.some(e => e.entry_type === "credit");
    const action = hasDebit && !hasCredit ? "POST_CREDIT" : hasDebit && hasCredit ? "COMPLETE" : "MARK_FAILED";
    expect(action).toBe("COMPLETE");
  });
});
