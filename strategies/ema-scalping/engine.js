const config = require("../../config");
const { fetchMacroMarketSnapshot, fetchForexFactoryEvents } = require("./dataProvider");
const { analyzeEmaScalpingSetup } = require("./indicators");
const { hasHighImpactNewsBlock } = require("./newsFilter");
const { evaluateEmaMultiLayer } = require("../../ai/multiLayerFilters");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function confidenceFromChecks(setup, newsFilter) {
  if (!setup || setup.direction === "wait" || !setup.riskPlan) {
    return 0;
  }

  const trendScore = setup.trend.isTrending ? 0.2 : 0;
  const adxScore = clamp((setup.adx - 18) / 12, 0, 1) * 0.15;
  const angleScore = clamp(Math.abs(setup.emaAngle) / 55, 0, 1) * 0.15;
  const pullbackScore = setup.pullback.hasPullback ? 0.12 : 0;
  const rejectionScore = setup.rejection.confirmed ? 0.12 : 0;
  const supportScore = setup.supportResistance.nearLevel ? 0.08 : 0;
  const trendlineScore = setup.trendline.confirmed ? 0.08 : 0;
  const trapScore = setup.trap.detected ? 0.05 : 0;
  const rrrScore = clamp((setup.riskPlan.rrr - 1.5) / 1.5, 0, 1) * 0.1;
  const emaQualityScore =
    !setup.repeatedCrosses && Math.abs(setup.emaAngle) >= config.strategies.emaScalping.emaAngleThreshold
      ? 0.1
      : 0;
  const newsScore = newsFilter.blocked ? 0 : 0.05;

  return Number(
    clamp(
      trendScore +
        adxScore +
        angleScore +
        pullbackScore +
        rejectionScore +
        supportScore +
        trendlineScore +
        trapScore +
        rrrScore +
        emaQualityScore +
        newsScore,
      0,
      1
    ).toFixed(3)
  );
}

function buildTradeCandidate(symbol, snapshot, setup, newsFilter) {
  const confidenceScore = confidenceFromChecks(setup, newsFilter);
  const confirmationCount = [
    Boolean(setup?.rejection?.confirmed),
    Boolean(setup?.supportResistance?.nearLevel),
    Boolean(setup?.trendline?.confirmed),
    Boolean(setup?.trap?.detected)
  ].filter(Boolean).length;
  const strongContinuation =
    Boolean(setup?.pullback?.hasPullback) &&
    Number(setup?.adx || 0) >= 30 &&
    Math.abs(Number(setup?.emaAngle || 0)) >=
      config.strategies.emaScalping.emaAngleThreshold + 5;
  let shouldTrade =
    setup &&
    (setup.trend.isTrending || setup.trendQualified) &&
    !newsFilter.blocked &&
    setup.direction !== "wait" &&
    Math.abs(setup.emaAngle) >= config.strategies.emaScalping.emaAngleThreshold &&
    setup.pullback.hasPullback &&
    (confirmationCount >= 1 || strongContinuation) &&
    setup.riskPlan &&
    setup.riskPlan.rrr >= config.strategies.emaScalping.minRrr &&
    confidenceScore >= config.strategies.emaScalping.confidenceThreshold &&
    !setup.repeatedCrosses;

  if (shouldTrade && snapshot?.timeframes?.["1m"]?.candles) {
    const emaMl = evaluateEmaMultiLayer({ oneMinuteCandles: snapshot.timeframes["1m"].candles });
    if (!emaMl.pass) {
      shouldTrade = false;
    }
  }

  return {
    symbol,
    source: snapshot.source,
    latestPrice: snapshot.latestPrice,
    setup,
    confidenceScore,
    tradeDecision: shouldTrade ? (setup.direction === "buy" ? "BUY" : "SELL") : "WAIT",
    scalpingModeActive: shouldTrade,
    newsBlocked: newsFilter.blocked,
    newsReason: newsFilter.reason,
    tradeQuality:
      confidenceScore >= 0.85 ? "Excellent" : confidenceScore >= 0.75 ? "High" : "Wait",
    trendDirection: setup?.trend?.direction || "choppy",
    confirmationCount,
    strongContinuation
  };
}

async function runEmaScalpingStrategy() {
  const settings = config.strategies.emaScalping;
  const events = await fetchForexFactoryEvents();
  const results = [];

  for (const symbol of settings.markets) {
    try {
      const snapshot = await fetchMacroMarketSnapshot(symbol);
      const oneMinute = analyzeEmaScalpingSetup(snapshot.timeframes["1m"], settings);
      const fiveMinute = analyzeEmaScalpingSetup(snapshot.timeframes["5m"], settings);
      const fifteenMinute = analyzeEmaScalpingSetup(snapshot.timeframes["15m"], settings);
      const fiveMinuteTrendDirection = fiveMinute?.trend?.direction || "choppy";
      const fifteenMinuteTrendDirection = fifteenMinute?.trend?.direction || "choppy";
      const higherTimeframeAligned =
        fiveMinuteTrendDirection !== "choppy" &&
        fiveMinuteTrendDirection === fifteenMinuteTrendDirection;
      const alignedDirection = higherTimeframeAligned
        ? oneMinute?.direction !== "wait"
          ? oneMinute.direction
          : fiveMinuteTrendDirection === "up"
            ? "buy"
            : "sell"
        : "wait";
      const chosenSetup = oneMinute && higherTimeframeAligned
        ? {
            ...oneMinute,
            direction: alignedDirection,
            trend: fifteenMinute.trend,
            higherTimeframe: {
              fiveMinute,
              fifteenMinute
            }
          }
        : {
            ...oneMinute,
            direction: "wait"
          };
      const newsFilter = hasHighImpactNewsBlock(
        events,
        symbol,
        settings.newsPauseMinutesBefore,
        settings.newsPauseMinutesAfter
      );
      const candidate = buildTradeCandidate(symbol, snapshot, chosenSetup, newsFilter);
      results.push(candidate);
    } catch (error) {
      results.push({
        symbol,
        tradeDecision: "WAIT",
        error: error.message
      });
    }
  }

  const opportunities = results
    .filter((item) => !item.error)
    .sort((left, right) => right.confidenceScore - left.confidenceScore);
  let bestOpportunity = opportunities.find((item) => item.tradeDecision !== "WAIT") || null;

  if (!bestOpportunity && config.trading.paperOnly && settings.allowPaperWarmup) {
    const fallback = opportunities.find(
      (item) =>
        item.setup?.emaDirection !== "wait" &&
        item.setup?.pullback?.hasPullback &&
        Number(item.setup?.adx || 0) >= Math.max(config.strategies.emaScalping.adxChoppyThreshold, 18) &&
        Math.abs(Number(item.setup?.emaAngle || 0)) >= 12 &&
        !item.newsBlocked &&
        !item.setup?.repeatedCrosses
    );

    if (fallback) {
      fallback.tradeDecision = fallback.setup.emaDirection === "buy" ? "BUY" : "SELL";
      fallback.scalpingModeActive = true;
      fallback.tradeQuality = "Paper Warmup";
      fallback.confidenceScore = Number(
        Math.max(
          fallback.confidenceScore || 0,
          config.strategies.emaScalping.confidenceThreshold
        ).toFixed(3)
      );
      fallback.paperWarmup = true;
      bestOpportunity = fallback;
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    mode: "ema_scalping",
    source: "Paper-first public market feed with MT5/OANDA-ready strategy logic",
    opportunities,
    bestOpportunity
  };
}

module.exports = {
  runEmaScalpingStrategy
};
