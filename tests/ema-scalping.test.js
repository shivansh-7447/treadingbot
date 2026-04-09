const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { analyzeEmaScalpingSetup } = require("../strategies/ema-scalping/indicators");

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function buildTrendingCandles({
  start = 100,
  step = 0.4,
  count = 80
} = {}) {
  const candles = [];
  let price = start;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = price + step;
    candles.push([
      Date.now() + index * 60_000,
      open,
      close + 0.25,
      open - 0.15,
      close,
      1000 + index * 10
    ]);
    price = close;
  }
  return candles;
}

test("ema scalping analysis returns a structured setup", () => {
  const setup = analyzeEmaScalpingSetup(buildTrendingCandles(), {
    adxTrendingThreshold: 22,
    adxChoppyThreshold: 20,
    minRrr: 2,
    maxRiskPct: 0.04
  });

  assert.equal(Boolean(setup), true);
  assert.equal(["buy", "sell", "wait"].includes(setup.direction), true);
  assert.equal(typeof setup.adx, "number");
  assert.equal(typeof setup.emaAngle, "number");
  assert.equal(typeof setup.pullback.hasPullback, "boolean");
});

test("ema scalping trade plan honors capital percent cap", () => {
  const bot = require("../bot");
  const tradePlan = bot.buildEmaScalpingTradePlan(
    {
      symbol: "XAUUSD",
      confidenceScore: 0.82,
      trendDirection: "up",
      source: "test",
      setup: {
        emaAngle: 42,
        adx: 29,
        riskPlan: {
          entryPrice: 100,
          stopLoss: 97,
          takeProfit: 106,
          stopDistance: 3,
          rrr: 2
        }
      }
    },
    {
      capitalPercent: 25,
      customMaxTradesPerDay: 12,
      minRiskPct: 0.03,
      maxRiskPct: 0.04,
      minRrr: 2,
      confidenceThreshold: 0.75,
      usePercentTakeProfit: false
    },
    2000
  );

  assert.equal(tradePlan.strategySettings.capitalUsed, 500);
  assert.equal(tradePlan.strategySettings.capitalPercent, 25);
  assert.equal(typeof tradePlan.strategySettings.allocatedCapitalPercent, "number");
  assert.equal(tradePlan.notional, 333.33);
  assert.equal(tradePlan.amount, 3.3333);
  assert.equal(tradePlan.strategySettings.targetRiskAmount, 60);
  assert.equal(tradePlan.strategySettings.riskPct, 3);
  assert.equal(tradePlan.strategySettings.takeProfitPips, 141);
  assert.equal(tradePlan.exitPlan.takeProfit, 101.41);
  assert.equal(tradePlan.exitPlan.stopLoss, 82);
});

test("ema scalping mode auto-approves and executes paper signals", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-ema-auto-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.TELEGRAM_CHAT_ID = "";

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");
  clearModule("../bot");

  const bot = require("../bot");
  const { loadState } = require("../manual");
  const { closeDb } = require("../db");

  await bot.updateManualControls({
    strategyMode: "ema_scalping",
    manualMode: false,
    emaScalpingSettings: {
      capitalPercent: 100,
      customMaxTradesPerDay: 12,
      minRiskPct: 0.03,
      maxRiskPct: 0.04,
      minRrr: 2,
      confidenceThreshold: 0.75
    }
  });

  bot.runtime.lastEmaScalping = {
    fetchedAt: new Date().toISOString(),
    opportunities: [
      {
        symbol: "XAUUSD",
        source: "test",
        latestPrice: 100,
        confidenceScore: 0.84,
        tradeDecision: "BUY",
        scalpingModeActive: true,
        newsBlocked: false,
        newsReason: "",
        tradeQuality: "High",
        trendDirection: "up",
        setup: {
          emaAngle: 41,
          adx: 29,
          riskPlan: {
            entryPrice: 100,
            stopLoss: 97,
            takeProfit: 106,
            stopDistance: 3,
            rrr: 2
          }
        }
      }
    ]
  };

  const state = await loadState();
  await bot.maybeQueueEmaScalpingSignal(state);

  const finalState = await loadState();
  assert.equal(finalState.strategyMode, "ema_scalping");
  assert.equal(finalState.pendingApprovals.length, 0);
  assert.equal(finalState.status.dailyTrades, 1);
  assert.equal(finalState.signals[0]?.status, "executed");
  assert.equal(finalState.trades[0]?.strategyMode, "ema_scalping");
  assert.equal(finalState.trades[0]?.paper, true);

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});

test("ema scalping still executes while learning pause is active", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-ema-paused-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.TELEGRAM_CHAT_ID = "";

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");
  clearModule("../bot");

  const bot = require("../bot");
  const { loadState, saveState } = require("../manual");
  const { closeDb } = require("../db");

  await bot.updateManualControls({
    strategyMode: "ema_scalping",
    manualMode: false,
    emaScalpingSettings: {
      capitalPercent: 100,
      customMaxTradesPerDay: 12,
      minRiskPct: 0.03,
      maxRiskPct: 0.04,
      minRrr: 2,
      confidenceThreshold: 0.75
    }
  });

  const state = await loadState();
  state.learning.pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  state.learning.pauseReason = "Paused in test";
  await saveState(state);

  bot.runtime.lastEmaScalping = {
    fetchedAt: new Date().toISOString(),
    opportunities: [
      {
        symbol: "XAUUSD",
        source: "test",
        latestPrice: 100,
        confidenceScore: 0.84,
        tradeDecision: "BUY",
        scalpingModeActive: true,
        newsBlocked: false,
        newsReason: "",
        tradeQuality: "High",
        trendDirection: "up",
        setup: {
          emaAngle: 41,
          adx: 29,
          riskPlan: {
            entryPrice: 100,
            stopLoss: 97,
            takeProfit: 106,
            stopDistance: 3,
            rrr: 2
          }
        }
      }
    ]
  };

  await bot.maybeQueueEmaScalpingSignal(await loadState());

  const finalState = await loadState();
  assert.equal(finalState.trades[0]?.strategyMode, "ema_scalping");
  assert.equal(finalState.trades[0]?.paper, true);
  assert.equal(finalState.pendingApprovals.length, 0);

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});
