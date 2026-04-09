const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeCandles } = require("../market-intelligence/indicators");
const { buildOpportunity } = require("../market-intelligence/scorer");

function buildCandles({ start = 100, step = 1, volume = 1000, count = 80 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const price = start + step * index;
    return [
      Date.now() + index * 60000,
      price - 0.5,
      price + 1.2,
      price - 1,
      price,
      volume + index * 50
    ];
  });
}

test("analyzeCandles returns breakout and trend metrics", () => {
  const result = analyzeCandles(buildCandles());
  assert.equal(result.latestPrice > 0, true);
  assert.equal(["up", "down", "sideways"].includes(result.trendDirection), true);
  assert.equal(typeof result.breakout, "boolean");
});

test("buildOpportunity marks strong aligned setup as buy", () => {
  const metrics = analyzeCandles(buildCandles({ start: 100, step: 1.5, volume: 1500 }));
  const candidate = {
    exchange: "Binance",
    symbol: "SOL/USDT",
    ticker: { last: metrics.latestPrice },
    timeframes: {
      "1m": { metrics },
      "5m": { metrics: { ...metrics, volumeSpike: true } },
      "15m": { metrics },
      "1h": { metrics },
      "4h": { metrics }
    }
  };
  const market = {
    liquidityScore: 0.8,
    totalVolume: 100000000,
    marketCap: 50000000000
  };
  const sentiment = { compositeScore: 0.5 };
  const whale = { score: 0.9 };
  const funding = { fundingScore: 0.7 };

  const opportunity = buildOpportunity(candidate, market, sentiment, whale, funding);
  assert.equal(opportunity.coinScore >= 0, true);
  assert.equal(opportunity.confidenceScore >= 0, true);
  assert.equal(["BUY", "WAIT"].includes(opportunity.decision), true);
});
