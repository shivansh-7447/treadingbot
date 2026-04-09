const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getDefaultLearningState,
  refreshLearningState,
  recordTradeOutcome
} = require("../ai/learning");

function buildTrade(overrides = {}) {
  return {
    exchange: "Binance",
    symbol: "BTC/USDT",
    strategyMode: "auto",
    exitReason: "stop_loss",
    pnl: -5,
    pnlPct: -2.5,
    prediction: {
      confidence: 0.42,
      probabilityUp: 0.58
    },
    rankingFactors: {
      fifteenMinuteTrend: 0.02,
      fiveMinuteMomentum: -0.01,
      oneMinuteMomentum: -0.02
    },
    sentimentScore: -0.1,
    whaleScore: 0.05,
    score: 0.22,
    ...overrides
  };
}

test("learning state tightens confidence and blocks weak recent performance", () => {
  const state = {
    learning: {
      ...getDefaultLearningState(),
      recentClosedTrades: [
        { pnl: -10, pnlPct: -2, win: false },
        { pnl: -8, pnlPct: -1.5, win: false },
        { pnl: 4, pnlPct: 0.8, win: true },
        { pnl: -6, pnlPct: -1.2, win: false },
        { pnl: -3, pnlPct: -0.6, win: false }
      ]
    }
  };

  const learning = refreshLearningState(state);
  assert.equal(learning.gateBlocked, true);
  assert.equal(learning.metrics.lossStreak >= 2, true);
  assert.equal(learning.dynamicMinConfidence > 0.2, true);
});

test("learning state auto-pauses after consecutive losing trades", () => {
  const prevEnv = process.env.LEARNING_AUTO_PAUSE_ENABLED;
  process.env.LEARNING_AUTO_PAUSE_ENABLED = "true";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("../ai/learning")];
  const {
    recordTradeOutcome: recordWithPause,
    getDefaultLearningState: getDefaultWithPause
  } = require("../ai/learning");

  try {
    const state = {
      learning: getDefaultWithPause()
    };

    recordWithPause(state, buildTrade({ pnl: -4, pnlPct: -1.1 }));
    recordWithPause(state, buildTrade({ pnl: -6, pnlPct: -1.6 }));
    const result = recordWithPause(state, buildTrade({ pnl: -7, pnlPct: -2.2 }));

    assert.equal(result.pauseTriggered, true);
    assert.equal(Boolean(state.learning.pausedUntil), true);
    assert.equal(state.learning.isPaused, true);
  } finally {
    if (prevEnv === undefined) {
      delete process.env.LEARNING_AUTO_PAUSE_ENABLED;
    } else {
      process.env.LEARNING_AUTO_PAUSE_ENABLED = prevEnv;
    }
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("../ai/learning")];
    require("../ai/learning");
  }
});
