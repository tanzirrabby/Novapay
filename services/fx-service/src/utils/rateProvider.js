const axios = require("axios");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Simulated exchange rates (in production, call a real provider e.g. Open Exchange Rates)
const MOCK_RATES = {
  "USD-EUR": 0.92,
  "USD-GBP": 0.79,
  "USD-JPY": 148.5,
  "USD-BDT": 110.0,
  "EUR-USD": 1.087,
  "GBP-USD": 1.265,
  "JPY-USD": 0.00673,
  "BDT-USD": 0.0091,
  "EUR-GBP": 0.857,
  "GBP-EUR": 1.167,
};

/**
 * Fetches a live rate from the FX provider.
 *
 * CRITICAL RULE: If the provider is unavailable, this function THROWS.
 * We NEVER silently fall back to a cached rate.
 * The caller catches this and returns a clear error to the user.
 */
async function fetchLiveRate(fromCurrency, toCurrency) {
  const pair = `${fromCurrency}-${toCurrency}`;

  // In production: call real FX provider with timeout
  // const response = await axios.get(`https://api.exchangerate.host/convert?from=${fromCurrency}&to=${toCurrency}`, {
  //   timeout: 5000,
  // });

  // Simulate provider failure via env flag (used in observability test scenario)
  if (process.env.FX_PROVIDER_DOWN === "true") {
    throw new Error("FX_PROVIDER_UNAVAILABLE: External FX provider is not responding");
  }

  const rate = MOCK_RATES[pair];
  if (!rate) {
    throw new Error(`FX_PAIR_UNSUPPORTED: No rate available for ${pair}`);
  }

  // Log the fetched rate
  await pool.query(
    `INSERT INTO fx_rates_log (from_currency, to_currency, rate, source)
     VALUES ($1, $2, $3, 'mock_provider')`,
    [fromCurrency, toCurrency, rate]
  );

  return rate;
}

module.exports = { fetchLiveRate };
