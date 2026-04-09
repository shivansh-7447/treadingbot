const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeStreaksFromClosed,
  getDefaultCapitalGrowthState
} = require("../ai/capitalGrowthEngine");
const config = require("../config");

test("computeStreaksFromClosed counts consecutive wins from most recent close", () => {
  const now = Date.now();
  const trades = [
    { status: "closed", pnl: 10, closedAt: new Date(now).toISOString() },
    { status: "closed", pnl: 5, closedAt: new Date(now - 1000).toISOString() },
    { status: "closed", pnl: -1, closedAt: new Date(now - 2000).toISOString() }
  ];
  const s = computeStreaksFromClosed(trades);
  assert.equal(s.winStreak, 2);
  assert.equal(s.lossStreak, 0);
});

test("computeStreaksFromClosed counts consecutive losses from most recent close", () => {
  const now = Date.now();
  const trades = [
    { status: "closed", pnl: -2, closedAt: new Date(now).toISOString() },
    { status: "closed", pnl: -1, closedAt: new Date(now - 1000).toISOString() },
    { status: "closed", pnl: 50, closedAt: new Date(now - 2000).toISOString() }
  ];
  const s = computeStreaksFromClosed(trades);
  assert.equal(s.lossStreak, 2);
  assert.equal(s.winStreak, 0);
});

test("auto trade plan uses optional dynamic risk for smart-money sizing", () => {
  const bot = require("../bot");
  const candidate = {
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
  };
  const baseline = bot.buildAutoTradePlan(
    candidate,
    [],
    { capitalPercent: 100 },
    100,
    0.82,
    2000,
    null
  );
  const boosted = bot.buildAutoTradePlan(
    candidate,
    [],
    { capitalPercent: 100 },
    100,
    0.82,
    2000,
    0.015
  );
  assert.ok(Number(boosted.strategySettings.targetRiskAmount) > Number(baseline.strategySettings.targetRiskAmount));
  assert.equal(Number(boosted.strategySettings.targetRiskAmount), 30);
});

test("default capital growth state includes tracking fields", () => {
  const d = getDefaultCapitalGrowthState();
  assert.ok(Array.isArray(d.growthHistory));
  assert.equal(d.backfillDone, false);
  assert.ok(Object.prototype.hasOwnProperty.call(config, "capitalGrowth"));
  assert.ok(Number(config.capitalGrowth.reinvestProfitFraction) > 0);
});
