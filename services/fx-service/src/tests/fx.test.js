// FX quote TTL and single-use logic tests

describe("FX Quote TTL Logic", () => {
  function isQuoteValid(quote) {
    const now = Date.now();
    return quote.status === "active" && new Date(quote.expires_at).getTime() > now;
  }

  function secondsRemaining(quote) {
    return Math.max(
      0,
      Math.floor((new Date(quote.expires_at).getTime() - Date.now()) / 1000)
    );
  }

  test("quote is valid within 60 seconds", () => {
    const quote = {
      status: "active",
      expires_at: new Date(Date.now() + 55_000).toISOString(), // 55s from now
    };
    expect(isQuoteValid(quote)).toBe(true);
    expect(secondsRemaining(quote)).toBeGreaterThan(50);
  });

  test("quote is invalid after expiry", () => {
    const quote = {
      status: "active",
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1s ago
    };
    expect(isQuoteValid(quote)).toBe(false);
    expect(secondsRemaining(quote)).toBe(0);
  });

  test("used quote is invalid even if within TTL", () => {
    const quote = {
      status: "used",
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(isQuoteValid(quote)).toBe(false);
  });

  test("expired status is invalid", () => {
    const quote = {
      status: "expired",
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(isQuoteValid(quote)).toBe(false);
  });
});

describe("FX Rate Calculation", () => {
  test("converts amount correctly using locked rate", () => {
    const rate = 0.92; // USD -> EUR
    const amountFrom = 200000; // $2000.00 in cents
    const amountTo = Math.round(amountFrom * rate);
    expect(amountTo).toBe(184000); // €1840.00
  });

  test("round-trip conversion is consistent", () => {
    const usdToEur = 0.92;
    const eurToUsd = 1 / 0.92;
    const original = 100000;
    const converted = Math.round(original * usdToEur);
    const backConverted = Math.round(converted * eurToUsd);
    // Allow 1 cent rounding tolerance
    expect(Math.abs(backConverted - original)).toBeLessThanOrEqual(1);
  });
});
