const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

test("manual approval workflow persists through sqlite state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-test-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");

  const { closeDb } = require("../db");
  const {
    loadState,
    requestApproval,
    approveTrade,
    consumeApproval
  } = require("../manual");

  const approval = await requestApproval({
    exchange: "Binance",
    symbol: "BTC/USDT",
    price: 100,
    notional: 50,
    side: "buy",
    prediction: { confidence: 0.8 },
    exitPlan: { stopLoss: 98, takeProfit: 103 }
  });

  let state = await loadState();
  assert.equal(state.pendingApprovals.length, 1);
  assert.equal(state.signals[0].status, "awaiting_approval");

  await approveTrade(approval.id, "approved in test");
  state = await loadState();
  assert.equal(state.pendingApprovals[0].status, "approved");
  assert.equal(state.signals[0].status, "approved");

  await consumeApproval(approval.id);
  state = await loadState();
  assert.equal(state.pendingApprovals.length, 0);
  assert.equal(state.signals[0].status, "executed");
  assert.equal(Boolean(state.signals[0].executedAt), true);

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});

test("legacy manual settings persist while manual mode stays disabled", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-manual-test-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");

  const { closeDb } = require("../db");
  const { loadState, updateManualControls } = require("../manual");

  await updateManualControls({
    autoSettings: {
      capitalPercent: 4.5
    },
    manualMode: true,
    manualTradingActive: true,
    manualSettings: {
      capitalPercent: 7.5,
      takeProfitPercent: 4,
      stopLossPercent: 1.8,
      autoExit: false,
      profitLockPercent: 1.2
    }
  });

  const state = await loadState();
  assert.equal(state.autoSettings.capitalPercent, 4.5);
  assert.equal(state.manualMode, false);
  assert.equal(state.manualTradingActive, false);
  assert.equal(state.manualSettings.capitalPercent, 7.5);
  assert.equal(state.manualSettings.takeProfitPercent, 4);
  assert.equal(state.manualSettings.stopLossPercent, 1.8);
  assert.equal(state.manualSettings.autoExit, false);
  assert.equal(state.manualSettings.profitLockPercent, 1.2);

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});

test("ema scalping strategy settings persist through sqlite state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-ema-test-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");

  const { closeDb } = require("../db");
  const { loadState, updateManualControls } = require("../manual");

  await updateManualControls({
    strategyMode: "ema_scalping",
    emaScalpingSettings: {
      capitalPercent: 100,
      customMaxTradesPerDay: 14,
      minRiskPct: 0.03,
      maxRiskPct: 0.04,
      minRrr: 2.5,
      confidenceThreshold: 0.8
    }
  });

  const state = await loadState();
  assert.equal(state.strategyMode, "ema_scalping");
  assert.equal(state.manualMode, false);
  assert.equal(state.manualTradingActive, false);
  assert.equal(state.emaScalpingSettings.capitalPercent, 100);
  assert.equal(state.emaScalpingSettings.customMaxTradesPerDay, 14);
  assert.equal(state.emaScalpingSettings.minRiskPct, 0.03);
  assert.equal(state.emaScalpingSettings.maxRiskPct, 0.04);
  assert.equal(state.emaScalpingSettings.minRrr, 2.5);
  assert.equal(state.emaScalpingSettings.confidenceThreshold, 0.8);

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});

test("ultra ai strategy settings persist through sqlite state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-ultra-test-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");

  const { closeDb } = require("../db");
  const { loadState, updateManualControls } = require("../manual");

  await updateManualControls({
    strategyMode: "ultra_ai",
    autoSettings: {
      capitalPercent: 100
    },
    ultraAiSettings: {
      capitalPercent: 100,
      customMaxTradesPerDay: 10,
      confidenceThreshold: 0.82,
      executionMode: "paper"
    }
  });

  const state = await loadState();
  assert.equal(state.strategyMode, "ultra_ai");
  assert.equal(state.autoSettings.capitalPercent, 100);
  assert.equal(state.ultraAiSettings.capitalPercent, 100);
  assert.equal(state.ultraAiSettings.customMaxTradesPerDay, 10);
  assert.equal(state.ultraAiSettings.confidenceThreshold, 0.82);
  assert.equal(state.ultraAiSettings.executionMode, "paper");

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});
