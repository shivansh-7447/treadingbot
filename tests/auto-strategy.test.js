const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeAutoTradeCandidate } = require("../ai/autoStrategy");

function buildTrendCandles({ start = 100, drift = 1.1, count = 80 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const wave = Math.sin(index / 2) * 2.2;
    const price = start + drift * index + wave;
    return [
      Date.now() + index * 60_000,
      price - 0.7,
      price + 1.1,
      price - 1.4,
      price + 0.5,
      1000 + index * 25
    ];
  });
}

function buildLiquiditySweepCandles() {
  const candles = [];
  for (let index = 0; index < 24; index += 1) {
    const base = 172 + index * 0.15;
    candles.push([
      Date.now() + index * 60_000,
      base - 0.2,
      base + 0.9,
      base - 0.8,
      base + 0.4,
      1000 + index * 20
    ]);
  }
  candles.push([
    Date.now() + 25 * 60_000,
    173.8,
    175.2,
    171.1,
    174.6,
    2400
  ]);
  return candles;
}

function buildBosCandles() {
  const candles = [];
  for (let index = 0; index < 10; index += 1) {
    const base = 170 + index * 0.4;
    candles.push([
      Date.now() + index * 60_000,
      base - 0.3,
      base + 0.8,
      base - 0.7,
      base + 0.2,
      800 + index * 10
    ]);
  }
  candles.push([
    Date.now() + 11 * 60_000,
    173.5,
    177.8,
    173.1,
    177.2,
    2100
  ]);
  return candles;
}

function buildVolumeCandles() {
  const candles = [];
  for (let index = 0; index < 11; index += 1) {
    const base = 175 + index * 0.1;
    candles.push([
      Date.now() + index * 60_000,
      base - 0.1,
      base + 0.2,
      base - 0.2,
      base + 0.05,
      index === 10 ? 5000 : 1000 + index * 50
    ]);
  }
  return candles;
}

test("analyzeAutoTradeCandidate marks aligned smart-money setup as buy", () => {
  const candidate = {
    exchange: "Binance",
    symbol: "BTC/USDT",
    ticker: { last: 177.2 },
    timeframes: {
      "1m": {
        candles: buildVolumeCandles(),
        metrics: { latestPrice: 177.2 }
      },
      "5m": {
        candles: buildBosCandles(),
        metrics: { latestPrice: 177.2 }
      },
      "15m": {
        candles: buildLiquiditySweepCandles(),
        metrics: { latestPrice: 170.8 }
      },
      "4h": {
        candles: buildTrendCandles(),
        metrics: { latestPrice: 177.2 }
      }
    }
  };

  const setup = analyzeAutoTradeCandidate(
    candidate,
    { score: 1.4 },
    {
      trade: { price: 177.2, quantity: 1.1, isBuyerMaker: false },
      derived: { latestPrice: 177.2, orderBookImbalance: 0.22 }
    }
  );

  assert.equal(setup.decision, "BUY");
  assert.equal(setup.trend.direction, "bullish");
  assert.equal(setup.liquiditySweep.direction, "bullish");
  assert.equal(setup.structureBreak.direction, "bullish");
  assert.equal(setup.volumeSpike.valid, true);
  assert.equal(setup.whaleConfirmation.whaleBuying, true);
  assert.equal(setup.riskReward >= 2, true);
});

test("auto trade plan uses risk-based sizing from smart-money stop", () => {
  const bot = require("../bot");
  const tradePlan = bot.buildAutoTradePlan(
    {
      symbol: "BTC/USDT",
      autoSetup: {
        decision: "BUY",
        stopLoss: 95,
        takeProfit: 115,
        riskReward: 3,
        trend: { direction: "bullish" },
        liquiditySweep: { direction: "bullish" },
        structureBreak: { direction: "bullish" },
        whaleConfirmation: { whaleBuying: true },
        volumeSpike: { ratio: 2.4 }
      }
    },
    [],
    { capitalPercent: 100 },
    100,
    0.82,
    2000
  );

  assert.equal(tradePlan.strategySettings.entryModel, "smart_money_trend");
  assert.equal(tradePlan.exitPlan.stopLoss, 95);
  assert.equal(tradePlan.exitPlan.takeProfit, 115);
  assert.equal(tradePlan.strategySettings.riskPct, 1);
  assert.equal(tradePlan.strategySettings.targetRiskAmount, 20);
  assert.equal(tradePlan.notional, 400);
});
