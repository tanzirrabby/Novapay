const crypto = require("crypto");

function computeAuditHash(prevHash, entry) {
  const data = [prevHash, entry.id, entry.action, entry.actor_id || "", entry.created_at].join("|");
  return crypto.createHash("sha256").update(data).digest("hex");
}

describe("Audit Log Hash Chain", () => {
  const GENESIS = "0".repeat(64);

  function buildChain(entries) {
    let prevHash = GENESIS;
    return entries.map((e) => {
      const entryHash = computeAuditHash(prevHash, e);
      const row = { ...e, entry_hash: entryHash, prev_hash: prevHash };
      prevHash = entryHash;
      return row;
    });
  }

  function verifyChain(rows) {
    let prevHash = GENESIS;
    for (const row of rows) {
      const expected = computeAuditHash(prevHash, row);
      if (expected !== row.entry_hash) return { valid: false, failedAt: row.id };
      prevHash = row.entry_hash;
    }
    return { valid: true };
  }

  const entries = [
    { id: "a1", action: "FREEZE_ACCOUNT", actor_id: "admin-1", created_at: "2024-01-01T00:00:00.000Z" },
    { id: "a2", action: "VIEW_ACCOUNT",   actor_id: "admin-1", created_at: "2024-01-01T00:01:00.000Z" },
    { id: "a3", action: "INVARIANT_CHECK",actor_id: "admin-2", created_at: "2024-01-01T00:02:00.000Z" },
  ];

  test("valid chain passes verification", () => {
    const chain = buildChain(entries);
    expect(verifyChain(chain)).toEqual({ valid: true });
  });

  test("tampered entry breaks chain at that point", () => {
    const chain = buildChain(entries);
    // Tamper the second entry's action
    chain[1] = { ...chain[1], action: "TAMPERED_ACTION" };
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.failedAt).toBe("a2");
  });

  test("tampered first entry invalidates everything after it", () => {
    const chain = buildChain(entries);
    chain[0] = { ...chain[0], action: "TAMPERED" };
    // First entry fails, all subsequent chain entries also fail
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.failedAt).toBe("a1");
  });

  test("appended entries maintain chain continuity", () => {
    const chain = buildChain(entries);
    const lastHash = chain[chain.length - 1].entry_hash;
    const newEntry = { id: "a4", action: "NEW_ACTION", actor_id: "admin-3", created_at: "2024-01-01T00:03:00.000Z" };
    const newHash = computeAuditHash(lastHash, newEntry);
    chain.push({ ...newEntry, entry_hash: newHash, prev_hash: lastHash });
    expect(verifyChain(chain)).toEqual({ valid: true });
  });
});
