const crypto = require("crypto");

// Test the hash chain logic in isolation
function computeEntryHash(prevHash, entry) {
  const data = [
    prevHash,
    entry.transaction_id,
    entry.account_id,
    entry.entry_type,
    entry.amount.toString(),
    entry.currency,
    entry.created_at,
  ].join("|");
  return crypto.createHash("sha256").update(data).digest("hex");
}

describe("Ledger Hash Chain", () => {
  const prevHash = "0".repeat(64);

  const entry = {
    transaction_id: "tx-123",
    account_id: "acc-456",
    entry_type: "debit",
    amount: 10000,
    currency: "USD",
    created_at: "2024-01-01T00:00:00.000Z",
  };

  test("produces a 64-char hex hash", () => {
    const hash = computeEntryHash(prevHash, entry);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  test("is deterministic for same input", () => {
    expect(computeEntryHash(prevHash, entry)).toBe(computeEntryHash(prevHash, entry));
  });

  test("changes when any field changes (tamper detection)", () => {
    const hash1 = computeEntryHash(prevHash, entry);
    const hash2 = computeEntryHash(prevHash, { ...entry, amount: 10001 });
    expect(hash1).not.toBe(hash2);
  });

  test("chain: second hash depends on first", () => {
    const hash1 = computeEntryHash(prevHash, entry);
    const entry2 = { ...entry, entry_type: "credit", account_id: "acc-789" };
    const hash2 = computeEntryHash(hash1, entry2);
    // Tamper entry1 amount — hash1 changes — hash2 becomes invalid
    const tamperedHash1 = computeEntryHash(prevHash, { ...entry, amount: 99999 });
    const tamperedHash2 = computeEntryHash(tamperedHash1, entry2);
    expect(hash2).not.toBe(tamperedHash2);
  });
});

describe("Double-Entry Invariant Logic", () => {
  function checkInvariant(entries) {
    const net = entries.reduce((sum, e) => {
      return sum + (e.entry_type === "credit" ? e.amount : -e.amount);
    }, 0);
    return { balanced: net === 0, net };
  }

  test("balanced entries return net=0", () => {
    const entries = [
      { entry_type: "debit", amount: 5000 },
      { entry_type: "credit", amount: 5000 },
    ];
    expect(checkInvariant(entries)).toEqual({ balanced: true, net: 0 });
  });

  test("unbalanced entries are detected", () => {
    const entries = [
      { entry_type: "debit", amount: 5000 },
      { entry_type: "credit", amount: 4999 },
    ];
    expect(checkInvariant(entries).balanced).toBe(false);
    expect(checkInvariant(entries).net).toBe(-1);
  });

  test("fee transaction: 4 entries still balance", () => {
    // $100 transfer + $2 fee
    const entries = [
      { entry_type: "debit", amount: 10000 },   // sender pays $100
      { entry_type: "credit", amount: 10000 },  // recipient gets $100
      { entry_type: "debit", amount: 200 },     // sender pays $2 fee
      { entry_type: "credit", amount: 200 },    // novapay collects $2
    ];
    expect(checkInvariant(entries)).toEqual({ balanced: true, net: 0 });
  });
});
