const config = require("../config");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDefaultLearningState() {
  return {
    enabled: config.learning.enabled,
    pausedUntil: null,
    pauseReason: null,
    gateBlocked: false,
    dynamicMinConfidence: config.learning.baseMinConfidence,
    recentClosedTrades: [],
    disabledSymbols: [],
    disabledExchanges: [],
    metrics: {
      sampleCount: 0,
      recentWinRate: 0,
      recentAvgPnlPct: 0,
      recentProfitFactor: 0,
      lossStreak: 0,
      learningBias: 0,
      lastUpdatedAt: null
    }
  };
}

function computeLossStreak(samples) {
  let streak = 0;
  for (const sample of samples) {
    if (sample.win) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function summarizeLearningSamples(samples = []) {
  const recent = samples.slice(0, config.learning.recentWindow);
  const sampleCount = recent.length;
  const wins = recent.filter((sample) => sample.win).length;
  const recentWinRate = sampleCount ? wins / sampleCount : 0;
  const recentAvgPnlPct = sampleCount
    ? recent.reduce((sum, sample) => sum + Number(sample.pnlPct || 0), 0) / sampleCount
    : 0;
  const totalGains = recent
    .filter((sample) => Number(sample.pnl || 0) > 0)
    .reduce((sum, sample) => sum + Number(sample.pnl || 0), 0);
  const totalLosses = Math.abs(
    recent
      .filter((sample) => Number(sample.pnl || 0) < 0)
      .reduce((sum, sample) => sum + Number(sample.pnl || 0), 0)
  );
  const recentProfitFactor = totalLosses
    ? totalGains / totalLosses
    : totalGains > 0
      ? 9.99
      : 0;
  const lossStreak = computeLossStreak(samples);

  let dynamicMinConfidence = config.learning.baseMinConfidence;
  if (sampleCount >= config.learning.minSamplesForGating) {
    const winRatePenalty = Math.max(0, config.learning.targetWinRate - recentWinRate) * 0.8;
    const pnlPenalty =
      recentAvgPnlPct < 0 ? Math.min(0.18, (Math.abs(recentAvgPnlPct) / 100) * 4) : 0;
    const streakPenalty = lossStreak * config.learning.tightenPerLossStreak;
    dynamicMinConfidence = clamp(
      config.learning.baseMinConfidence + winRatePenalty + pnlPenalty + streakPenalty,
      config.learning.baseMinConfidence,
      config.learning.maxMinConfidence
    );
  }

  const learningBias = clamp(
    (recentWinRate - 0.5) * 0.8 + recentAvgPnlPct / 10,
    -0.3,
    0.3
  );

  const gateBlocked =
    sampleCount >= config.learning.minSamplesForGating &&
    (recentWinRate < config.learning.minRecentWinRate ||
      recentAvgPnlPct < config.learning.minRecentAvgPnlPct);

  return {
    dynamicMinConfidence: Number(dynamicMinConfidence.toFixed(4)),
    gateBlocked,
    metrics: {
      sampleCount,
      recentWinRate: Number((recentWinRate * 100).toFixed(2)),
      recentAvgPnlPct: Number(recentAvgPnlPct.toFixed(2)),
      recentProfitFactor: Number(recentProfitFactor.toFixed(2)),
      lossStreak,
      learningBias: Number(learningBias.toFixed(4)),
      lastUpdatedAt: new Date().toISOString()
    }
  };
}

function summarizeEntityPerformance(samples, selector, minSamples) {
  const groups = new Map();

  for (const sample of samples) {
    const key = selector(sample);
    if (!key) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(sample);
  }

  return [...groups.entries()]
    .map(([key, entries]) => {
      const sampleCount = entries.length;
      const wins = entries.filter((entry) => entry.win).length;
      const winRate = sampleCount ? wins / sampleCount : 0;
      const avgPnlPct = sampleCount
        ? entries.reduce((sum, entry) => sum + Number(entry.pnlPct || 0), 0) / sampleCount
        : 0;

      return {
        key,
        sampleCount,
        winRate,
        avgPnlPct,
        shouldDisable:
          sampleCount >= minSamples &&
          winRate < config.learning.minRecentWinRate &&
          avgPnlPct < config.learning.minRecentAvgPnlPct
      };
    })
    .filter((entry) => entry.shouldDisable)
    .map((entry) => ({
      key: entry.key,
      sampleCount: entry.sampleCount,
      winRate: Number((entry.winRate * 100).toFixed(2)),
      avgPnlPct: Number(entry.avgPnlPct.toFixed(2)),
      reason: `Disabled after ${entry.sampleCount} recent trades with ${Number(
        (entry.winRate * 100).toFixed(2)
      )}% win rate and ${Number(entry.avgPnlPct.toFixed(2))}% avg pnl.`
    }));
}

function refreshLearningState(state) {
  const current = {
    ...getDefaultLearningState(),
    ...(state.learning || {}),
    recentClosedTrades: Array.isArray(state.learning?.recentClosedTrades)
      ? state.learning.recentClosedTrades
      : []
  };

  if (
    current.pausedUntil &&
    Number.isFinite(new Date(current.pausedUntil).getTime()) &&
    new Date(current.pausedUntil).getTime() <= Date.now()
  ) {
    current.pausedUntil = null;
    current.pauseReason = null;
  }

  if (
    !config.learning.autoPauseEnabled &&
    current.pauseReason &&
    String(current.pauseReason).startsWith("Auto-paused")
  ) {
    current.pausedUntil = null;
    current.pauseReason = null;
  }

  const summary = summarizeLearningSamples(current.recentClosedTrades);
  const recentSamples = current.recentClosedTrades.slice(0, config.learning.maxStoredTrades);
  state.learning = {
    ...current,
    enabled: config.learning.enabled,
    dynamicMinConfidence: summary.dynamicMinConfidence,
    gateBlocked: summary.gateBlocked,
    disabledSymbols: summarizeEntityPerformance(recentSamples, (sample) => sample.symbol, 3),
    disabledExchanges: summarizeEntityPerformance(
      recentSamples,
      (sample) => sample.exchange,
      4
    ),
    metrics: summary.metrics,
    isPaused: Boolean(
      current.pausedUntil && new Date(current.pausedUntil).getTime() > Date.now()
    )
  };

  return state.learning;
}

function buildTradeOutcomeSample(trade) {
  return {
    closedAt: trade.closedAt || new Date().toISOString(),
    exchange: trade.exchange,
    symbol: trade.symbol,
    strategyMode: trade.strategyMode || "auto",
    exitReason: trade.exitReason || "",
    pnl: Number(trade.pnl || 0),
    pnlPct: Number(trade.pnlPct || 0),
    win: Number(trade.pnl || 0) > 0,
    features: {
      confidence: Number(trade.prediction?.confidence || 0),
      probabilityUp: Number(trade.prediction?.probabilityUp || 0),
      trend15m: Number(trade.rankingFactors?.fifteenMinuteTrend || 0),
      momentum5m: Number(trade.rankingFactors?.fiveMinuteMomentum || 0),
      momentum1m: Number(trade.rankingFactors?.oneMinuteMomentum || 0),
      sentiment: Number(trade.sentimentScore || 0),
      whaleScore: Number(trade.whaleScore || 0),
      score: Number(trade.score || 0)
    }
  };
}

function recordTradeOutcome(state, trade) {
  const current = refreshLearningState(state);
  current.recentClosedTrades.unshift(buildTradeOutcomeSample(trade));
  current.recentClosedTrades = current.recentClosedTrades.slice(0, config.learning.maxStoredTrades);

  const refreshed = refreshLearningState(state);
  let pauseTriggered = false;

  if (!refreshed.isPaused && config.learning.autoPauseEnabled) {
    const shouldPauseForLossStreak =
      refreshed.metrics.lossStreak >= config.learning.autoPauseLossStreak;
    const shouldPauseForPoorPerformance =
      refreshed.metrics.sampleCount >= config.learning.autoPauseMinSamples &&
      refreshed.metrics.recentWinRate / 100 < config.learning.autoPauseMinWinRate &&
      refreshed.metrics.recentAvgPnlPct < config.learning.autoPauseMinAvgPnlPct;

    if (shouldPauseForLossStreak || shouldPauseForPoorPerformance) {
      refreshed.pausedUntil = new Date(
        Date.now() + config.learning.autoPauseMinutes * 60 * 1000
      ).toISOString();
      refreshed.pauseReason = shouldPauseForLossStreak
        ? `Auto-paused after ${refreshed.metrics.lossStreak} consecutive losing trades.`
        : "Auto-paused because recent win rate and pnl fell below safety thresholds.";
      pauseTriggered = true;
      refreshLearningState(state);
    }
  }

  return {
    learning: state.learning,
    pauseTriggered
  };
}

function buildPredictionLearningContext(state) {
  const learning = refreshLearningState(state);
  return {
    dynamicMinConfidence: learning.dynamicMinConfidence,
    gateBlocked: learning.gateBlocked,
    isPaused: learning.isPaused,
    pauseReason: learning.pauseReason,
    disabledSymbols: learning.disabledSymbols || [],
    disabledExchanges: learning.disabledExchanges || [],
    learningSamples: learning.recentClosedTrades.slice(0, config.learning.trainingWindow),
    metrics: learning.metrics
  };
}

module.exports = {
  getDefaultLearningState,
  refreshLearningState,
  recordTradeOutcome,
  buildPredictionLearningContext
};
