const config = require("../config");
const {
  evaluateAutoMultiLayer,
  isStrong4hTrend
} = require("./multiLayerFilters");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values = []) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function calculateEma(values = [], period = 200) {
  if (!values.length) {
    return 0;
  }
  const effectivePeriod = Math.min(period, values.length);
  const multiplier = 2 / (effectivePeriod + 1);
  let ema = average(values.slice(0, effectivePeriod));
  for (const value of values.slice(effectivePeriod)) {
    ema = Number(value || 0) * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function getRecentSwing(candles = [], direction = "high", width = 2) {
  if (candles.length < width * 2 + 3) {
    return [];
  }
  const swings = [];
  for (let index = width; index < candles.length - width; index += 1) {
    const current = candles[index];
    const value = direction === "high" ? Number(current[2] || 0) : Number(current[3] || 0);
    let isSwing = true;
    for (let offset = 1; offset <= width; offset += 1) {
      const prev = candles[index - offset];
      const next = candles[index + offset];
      const prevValue = Number(prev[direction === "high" ? 2 : 3] || 0);
      const nextValue = Number(next[direction === "high" ? 2 : 3] || 0);
      if (direction === "high") {
        if (value <= prevValue || value <= nextValue) {
          isSwing = false;
          break;
        }
      } else if (value >= prevValue || value >= nextValue) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) {
      swings.push({
        index,
        value,
        candle: current
      });
    }
  }
  return swings.slice(-3);
}

function detectTrend(candles = []) {
  if (candles.length < 30) {
    return {
      direction: "none",
      price: 0,
      ema200: 0,
      structure: "unknown",
      isBullish: false,
      isBearish: false
    };
  }

  const closes = candles.map((item) => Number(item[4] || 0));
  const price = closes.at(-1) || 0;
  const ema200 = calculateEma(closes, 200);
  const swingHighs = getRecentSwing(candles, "high");
  const swingLows = getRecentSwing(candles, "low");
  const lastHigh = swingHighs.at(-1)?.value || 0;
  const prevHigh = swingHighs.at(-2)?.value || 0;
  const lastLow = swingLows.at(-1)?.value || 0;
  const prevLow = swingLows.at(-2)?.value || 0;
  const recentSegment = candles.slice(-24);
  const midpoint = Math.max(1, Math.floor(recentSegment.length / 2));
  const earlier = recentSegment.slice(0, midpoint);
  const later = recentSegment.slice(midpoint);
  const fallbackHigherHigh =
    Math.max(...later.map((item) => Number(item[2] || 0))) >
    Math.max(...earlier.map((item) => Number(item[2] || 0)));
  const fallbackHigherLow =
    Math.min(...later.map((item) => Number(item[3] || 0))) >
    Math.min(...earlier.map((item) => Number(item[3] || 0)));
  const fallbackLowerHigh =
    Math.max(...later.map((item) => Number(item[2] || 0))) <
    Math.max(...earlier.map((item) => Number(item[2] || 0)));
  const fallbackLowerLow =
    Math.min(...later.map((item) => Number(item[3] || 0))) <
    Math.min(...earlier.map((item) => Number(item[3] || 0)));
  const higherHigh = (lastHigh > prevHigh && prevHigh > 0) || fallbackHigherHigh;
  const higherLow = (lastLow > prevLow && prevLow > 0) || fallbackHigherLow;
  const lowerHigh = (lastHigh < prevHigh && prevHigh > 0) || fallbackLowerHigh;
  const lowerLow = (lastLow < prevLow && prevLow > 0) || fallbackLowerLow;
  const isBullish = price > ema200 && higherHigh && higherLow;
  const isBearish = price < ema200 && lowerHigh && lowerLow;

  return {
    direction: isBullish ? "bullish" : isBearish ? "bearish" : "none",
    price: Number(price.toFixed(6)),
    ema200: Number(ema200.toFixed(6)),
    structure: isBullish ? "HH_HL" : isBearish ? "LH_LL" : "mixed",
    higherHigh,
    higherLow,
    lowerHigh,
    lowerLow,
    isBullish,
    isBearish
  };
}

function analyzeRejectionCandle(candle = []) {
  const open = Number(candle[1] || 0);
  const high = Number(candle[2] || 0);
  const low = Number(candle[3] || 0);
  const close = Number(candle[4] || 0);
  const body = Math.abs(close - open);
  const range = Math.max(high - low, 0.0000001);
  const lowerWick = Math.max(Math.min(open, close) - low, 0);
  const upperWick = Math.max(high - Math.max(open, close), 0);
  const bullishRejection = close > open && lowerWick >= body * 1.2;
  const bearishRejection = close < open && upperWick >= body * 1.2;
  const strongBullish = close > open && body / range >= 0.55;
  const strongBearish = close < open && body / range >= 0.55;

  return {
    bullishRejection,
    bearishRejection,
    strongBullish,
    strongBearish,
    body,
    range,
    lowerWick,
    upperWick
  };
}

function detectLiquiditySweep(candles = [], trendDirection = "none", lookback = 20) {
  if (candles.length < lookback + 2) {
    return {
      direction: "none",
      valid: false
    };
  }

  const latest = candles.at(-1);
  const previous = candles.slice(-(lookback + 1), -1);
  const previousHigh = Math.max(...previous.map((item) => Number(item[2] || 0)));
  const previousLow = Math.min(...previous.map((item) => Number(item[3] || 0)));
  const latestHigh = Number(latest[2] || 0);
  const latestLow = Number(latest[3] || 0);
  const latestClose = Number(latest[4] || 0);
  const rejection = analyzeRejectionCandle(latest);

  const bullishSweep =
    trendDirection === "bullish" &&
    latestLow < previousLow &&
    latestClose > previousLow &&
    rejection.bullishRejection;
  const bearishSweep =
    trendDirection === "bearish" &&
    latestHigh > previousHigh &&
    latestClose < previousHigh &&
    rejection.bearishRejection;

  return {
    direction: bullishSweep ? "bullish" : bearishSweep ? "bearish" : "none",
    valid: bullishSweep || bearishSweep,
    previousHigh: Number(previousHigh.toFixed(6)),
    previousLow: Number(previousLow.toFixed(6)),
    sweepHigh: Number(latestHigh.toFixed(6)),
    sweepLow: Number(latestLow.toFixed(6)),
    rejection
  };
}

function detectBreakOfStructure(candles = [], direction = "none") {
  if (candles.length < 8) {
    return {
      valid: false,
      level: 0
    };
  }

  const latest = candles.at(-1);
  const recent = candles.slice(-7, -1);
  const recentHigh = Math.max(...recent.map((item) => Number(item[2] || 0)));
  const recentLow = Math.min(...recent.map((item) => Number(item[3] || 0)));
  const close = Number(latest[4] || 0);
  const rejection = analyzeRejectionCandle(latest);
  const bullishBos = direction === "bullish" && close > recentHigh && rejection.strongBullish;
  const bearishBos = direction === "bearish" && close < recentLow && rejection.strongBearish;

  return {
    valid: bullishBos || bearishBos,
    direction: bullishBos ? "bullish" : bearishBos ? "bearish" : "none",
    level: Number((bullishBos ? recentHigh : bearishBos ? recentLow : 0).toFixed(6)),
    strongCandle: bullishBos || bearishBos
  };
}

function detectVolumeSpike(candles = [], threshold = 1.8) {
  if (candles.length < 10) {
    return {
      valid: false,
      ratio: 0
    };
  }
  const latestVolume = Number(candles.at(-1)?.[5] || 0);
  const baseline = average(candles.slice(-10, -1).map((item) => Number(item[5] || 0)));
  const ratio = baseline > 0 ? latestVolume / baseline : 0;
  return {
    valid: ratio >= threshold,
    ratio: Number(ratio.toFixed(2))
  };
}

function buildWhaleConfirmation({ whaleSignal = null, realtimeSnapshot = null, trendDirection = "none" } = {}) {
  const whaleScore = Number(whaleSignal?.score || 0);
  const depthImbalance = Number(realtimeSnapshot?.derived?.orderBookImbalance || 0);
  const trade = realtimeSnapshot?.trade || null;
  const tradeNotional = Number(trade?.price || 0) * Number(trade?.quantity || 0);
  const largeOrder = tradeNotional >= 100000;
  const whaleBuying = trendDirection === "bullish" && (whaleScore >= 0.8 || depthImbalance > 0.08 || (largeOrder && !trade?.isBuyerMaker));
  const whaleSelling = trendDirection === "bearish" && (whaleScore >= 0.8 || depthImbalance < -0.08 || (largeOrder && trade?.isBuyerMaker));
  const exchangeFlow = whaleBuying
    ? "withdrawal_bias"
    : whaleSelling
      ? "deposit_bias"
      : "neutral";

  return {
    valid: whaleBuying || whaleSelling,
    whaleBuying,
    whaleSelling,
    exchangeFlow,
    largeOrder,
    whaleScore: Number(whaleScore.toFixed(3)),
    orderBookImbalance: Number(depthImbalance.toFixed(4))
  };
}

function analyzeAutoTradeCandidate(
  candidate,
  whaleSignal = null,
  realtimeSnapshot = null,
  sentimentSnapshot = null
) {
  const fourHourCandles = candidate.timeframes?.["4h"]?.candles || [];
  const fifteenMinuteCandles = candidate.timeframes?.["15m"]?.candles || [];
  const fiveMinuteCandles = candidate.timeframes?.["5m"]?.candles || [];
  const oneMinuteCandles = candidate.timeframes?.["1m"]?.candles || [];
  const trend = detectTrend(fourHourCandles);
  const liquiditySweep = detectLiquiditySweep(
    fifteenMinuteCandles,
    trend.direction,
    config.strategies.autoAi.liquiditySweepLookback
  );
  const structureBreak = detectBreakOfStructure(fiveMinuteCandles, trend.direction);
  const volumeSpike = detectVolumeSpike(
    oneMinuteCandles.length >= 10 ? oneMinuteCandles : fiveMinuteCandles,
    config.strategies.autoAi.volumeSpikeThreshold
  );
  const whaleConfirmation = buildWhaleConfirmation({
    whaleSignal,
    realtimeSnapshot,
    trendDirection: trend.direction
  });

  const latestPrice =
    Number(realtimeSnapshot?.derived?.latestPrice || 0) ||
    Number(candidate.ticker?.last || 0) ||
    Number(fiveMinuteCandles.at(-1)?.[4] || 0);
  const stopLoss =
    trend.direction === "bullish"
      ? Number(liquiditySweep.sweepLow || 0)
      : trend.direction === "bearish"
        ? Number(liquiditySweep.sweepHigh || 0)
        : 0;
  const stopDistance = Math.abs(latestPrice - stopLoss);
  const stopDistancePct = latestPrice > 0 ? stopDistance / latestPrice : 0;
  const minimumRrr = config.strategies.autoAi.minimumRrr;

  const lowVolume = !volumeSpike.valid;
  const sidewaysMarket = trend.direction === "none";
  const highVolatility = stopDistancePct > config.strategies.autoAi.maxStopDistancePct;
  const riskOffNews = Number(sentimentSnapshot?.compositeScore || 0) < -0.35;
  const avoidReasons = [];
  if (sidewaysMarket) avoidReasons.push("no 4h trend");
  if (!liquiditySweep.valid) avoidReasons.push("no liquidity sweep");
  if (!structureBreak.valid) avoidReasons.push("no break of structure");
  if (!volumeSpike.valid) avoidReasons.push("no volume spike");
  if (config.strategies.autoAi.requireWhaleConfirmation && !whaleConfirmation.valid) {
    avoidReasons.push("no whale confirmation");
  }
  if (highVolatility) avoidReasons.push("stop distance too wide");
  if (riskOffNews) avoidReasons.push("risk-off news sentiment");

  const confirmationCount = [
    trend.direction !== "none",
    liquiditySweep.valid,
    structureBreak.valid,
    volumeSpike.valid,
    whaleConfirmation.valid
  ].filter(Boolean).length;
  const confidenceScore = clamp(
    confirmationCount * 0.16 +
      (trend.direction !== "none" ? 0.18 : 0) +
      Math.min(0.18, volumeSpike.ratio / 10) +
      Math.min(0.18, Number(whaleConfirmation.whaleScore || 0) / 3) +
      Math.min(0.12, Math.abs(Number(whaleConfirmation.orderBookImbalance || 0)) / 2),
    0,
    1
  );
  const minTpPct = Number(config.risk.takeProfitPctMin ?? 0.21);
  const maxTpPct = Number(config.risk.takeProfitPctMax ?? 0.5);
  const tpPct = minTpPct + confidenceScore * Math.max(0, maxTpPct - minTpPct);
  let takeProfit =
    trend.direction === "bullish"
      ? Number((latestPrice * (1 + tpPct)).toFixed(6))
      : trend.direction === "bearish"
        ? Number((latestPrice * (1 - tpPct)).toFixed(6))
        : 0;
  let riskReward = stopDistance > 0 ? Math.abs((takeProfit - latestPrice) / stopDistance) : 0;
  let decision =
    trend.direction === "bullish" &&
    liquiditySweep.direction === "bullish" &&
    structureBreak.direction === "bullish" &&
    volumeSpike.valid &&
    (!config.strategies.autoAi.requireWhaleConfirmation || whaleConfirmation.whaleBuying) &&
    stopDistancePct > 0 &&
    stopDistancePct <= config.strategies.autoAi.maxStopDistancePct &&
    !riskOffNews &&
    riskReward >= minimumRrr
      ? "BUY"
      : "WAIT";

  const mlCfg = config.strategies.multiLayerFilter;
  let multiLayerReport = null;

  if (decision === "BUY" && mlCfg.enabled && mlCfg.autoAi) {
    const minConf = Number(config.strategies.autoAi.minConfidenceScore ?? 0.7);
    if (confidenceScore < minConf) {
      decision = "WAIT";
      avoidReasons.push(`confidence ${confidenceScore.toFixed(2)} below minimum ${minConf}`);
    } else {
      const ml = evaluateAutoMultiLayer({
        candidate,
        trend,
        liquiditySweep,
        structureBreak,
        volumeSpike,
        whaleConfirmation,
        latestPrice,
        whaleSignal,
        realtimeSnapshot
      });
      multiLayerReport = ml;
      if (!ml.pass) {
        decision = "WAIT";
        avoidReasons.push(...ml.failReasons.map((r) => `multi-layer: ${r}`));
      }
    }

    if (decision === "BUY" && stopDistance > 0) {
      const targetR = isStrong4hTrend(trend, fourHourCandles)
        ? Number(config.strategies.autoAi.preferredRrr || 3)
        : Number(config.strategies.autoAi.minimumRrr || 2);
      takeProfit = Number((latestPrice + stopDistance * targetR).toFixed(6));
      riskReward = Math.abs((takeProfit - latestPrice) / stopDistance);
      if (riskReward + 1e-6 < minimumRrr) {
        decision = "WAIT";
        avoidReasons.push(`risk/reward ${riskReward.toFixed(2)} below minimum ${minimumRrr}`);
      }
    }
  }

  const exitOnTrendReversal = trend.direction === "bearish";
  const exitOnWhaleReversal = whaleConfirmation.whaleSelling;

  return {
    decision,
    trend,
    liquiditySweep,
    structureBreak,
    volumeSpike,
    whaleConfirmation,
    confidenceScore: Number(confidenceScore.toFixed(3)),
    stopLoss: Number(stopLoss.toFixed(6)),
    takeProfit,
    stopDistancePct: Number((stopDistancePct * 100).toFixed(3)),
    riskReward: Number(riskReward.toFixed(2)),
    lowVolume,
    sidewaysMarket,
    highVolatility,
    riskOffNews,
    avoidReasons,
    exitOnTrendReversal,
    exitOnWhaleReversal,
    latestPrice: Number(latestPrice.toFixed(6)),
    multiLayerReport
  };
}

module.exports = {
  analyzeAutoTradeCandidate,
  detectTrend,
  detectLiquiditySweep,
  detectBreakOfStructure,
  detectVolumeSpike
};
