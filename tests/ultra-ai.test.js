const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUltraOpportunity } = require("../strategies/ultra-ai/engine");

test("buildUltraOpportunity scores strong live ultra setup", () => {
  const opportunity = buildUltraOpportunity(
    {
      exchange: "Binance",
      symbol: "BTC/USDT",
      score: 72,
      rankingFactors: {
        sentimentScore: 0.55,
        whaleScore: 1.1,
        fifteenMinuteTrend: 0.04,
        fiveMinuteMomentum: 0.02
      }
    },
    {
      binance: {
        orderBookImbalance: 0.16,
        orderBookBidUsd: 8200000,
        orderBookAskUsd: 6100000,
        largeTradeCount: 5,
        largeTradeImbalance: 0.28,
        fundingRate: 0.0008,
        openInterestUsd: 650000000,
        openInterestContracts: 10000,
        markPrice: 65000,
        latestKlineClose: 64980,
        lagMs: 500
      },
      whaleSignal: {
        eventCount: 2,
        whaleUsd: 4500000,
        smartMoneyScore: 0.82
      },
      etherscan: {
        live: true,
        gasScore: 0.62,
        fastGasPrice: 24
      },
      coinGecko: {
        marketScore: 0.68,
        btcDominance: 54.2,
        trendingCoins: ["BTC"]
      },
      coinMarketCap: {
        marketScore: 0.66,
        btcDominance: 54.1
      }
    }
  );

  assert.equal(opportunity.symbol, "BTC/USDT");
  assert.equal(opportunity.decision, "BUY");
  assert.equal(opportunity.ultraScore > 0, true);
  assert.equal(opportunity.confidenceScore > 0, true);
  assert.equal(Array.isArray(opportunity.reasons), true);
  assert.equal(typeof opportunity.liveData.binance.openInterestUsd, "number");
});
