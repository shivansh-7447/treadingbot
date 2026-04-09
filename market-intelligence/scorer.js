const config = require("../config");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize(value, min, max) {
  if (max === min) {
    return 0.5;
  }
  return clamp((value - min) / (max - min), 0, 1);
}

function buildOpportunity(candidate, market, sentimentSnapshot, whaleSignal, funding) {
  const oneMinute = candidate.timeframes["1m"]?.metrics || {};
  const fiveMinute = candidate.timeframes["5m"]?.metrics || {};
  const fifteenMinute = candidate.timeframes["15m"]?.metrics || {};
  const oneHour = candidate.timeframes["1h"]?.metrics || {};
  const fourHour = candidate.timeframes["4h"]?.metrics || {};

  const multiTimeframeAlignment = [fiveMinute, fifteenMinute, oneHour, fourHour].filter(
    (item) => item.trendDirection === "up"
  ).length / 4;
  const combinedMomentum =
    Number(fiveMinute.macd?.histogram || 0) + Number(fifteenMinute.macd?.histogram || 0);
  const momentumScore = normalize(combinedMomentum, -0.8, 0.8);
  const rsiScore = oneHour.rsi >= 48 && oneHour.rsi <= 68 ? 1 : normalize(70 - Math.abs(oneHour.rsi - 58), 0, 20);
  const trendScore = normalize(
    fiveMinute.trendStrength * 0.2 +
      fifteenMinute.trendStrength * 0.25 +
      oneHour.trendStrength * 0.25 +
      fourHour.trendStrength * 0.3,
    -1,
    1
  );
  const breakoutScore = candidate.timeframes["5m"]?.metrics?.breakout ? 1 : 0;
  const volumeScore = fiveMinute.volumeSpike ? 1 : normalize(fiveMinute.latestVolume / Math.max(fiveMinute.avgVolume || 1, 1), 0.8, 2.2);
  const smartMoneyScore = normalize((oneHour.smartMoneyFlow || 0) + (fourHour.smartMoneyFlow || 0), -0.6, 0.6);
  const sentimentScore = clamp((sentimentSnapshot.compositeScore + 1) / 2, 0, 1);
  const whaleScore = clamp((Number(whaleSignal?.score || 0) + 0.2) / 1.5, 0, 1);
  const fundingScore = Number(funding?.fundingScore || 0.5);
  const liquidityScore = clamp(Number(market?.liquidityScore || 0), 0, 1);
  const marketCapScore = normalize(Number(market?.marketCap || 0), 5e8, 5e11);
  const volatilityPenalty = normalize(oneHour.volatilityPct || 0, 2, 8);
  const pumpDumpRisk = fiveMinute.pumpRisk || oneHour.pumpRisk || fourHour.pumpRisk;
  const lowVolumeRisk = (market?.totalVolume || 0) < config.marketIntelligence.minVolumeUsd;
  const highVolatilityRisk = (oneHour.volatilityPct || 0) > config.marketIntelligence.maxPreferredVolatilityPct;

  const rawScore =
    trendScore * 0.2 +
    momentumScore * 0.12 +
    rsiScore * 0.08 +
    breakoutScore * 0.1 +
    volumeScore * 0.12 +
    smartMoneyScore * 0.08 +
    sentimentScore * 0.1 +
    whaleScore * 0.08 +
    fundingScore * 0.04 +
    liquidityScore * 0.05 +
    marketCapScore * 0.03;

  const riskPenalty =
    (pumpDumpRisk ? 0.2 : 0) +
    (lowVolumeRisk ? 0.14 : 0) +
    (highVolatilityRisk ? 0.08 : 0) +
    volatilityPenalty * 0.07;

  const coinScore = clamp(rawScore - riskPenalty, 0, 1);
  const confidenceScore = clamp(
    coinScore * 0.72 + multiTimeframeAlignment * 0.18 + (breakoutScore ? 0.06 : 0) + (fiveMinute.volumeSpike ? 0.04 : 0),
    0,
    1
  );

  const trendUp =
    fiveMinute.trendDirection === "up" &&
    fifteenMinute.trendDirection === "up" &&
    oneHour.trendDirection === "up";

  const shouldBuy =
    sentimentScore > 0.5 &&
    coinScore >= config.marketIntelligence.minCoinScore &&
    confidenceScore >= config.marketIntelligence.minConfidenceScore &&
    fiveMinute.volumeSpike &&
    trendUp;

  const exitSignal =
    fifteenMinute.trendDirection === "down" ||
    oneHour.rsi >= 72 ||
    (fiveMinute.volumeDrop && fifteenMinute.macd?.histogram < 0) ||
    fiveMinute.whaleDistribution;

  const reasons = [];
  if (trendUp) reasons.push("trend aligned");
  if (fiveMinute.volumeSpike) reasons.push("volume spike");
  if (breakoutScore) reasons.push("breakout");
  if (sentimentScore > 0.55) reasons.push("bullish sentiment");
  if (whaleScore > 0.55) reasons.push("whale support");
  if (pumpDumpRisk) reasons.push("pump risk");
  if (lowVolumeRisk) reasons.push("low volume");

  let tradeQuality = "Skip";
  if (confidenceScore >= 0.8) tradeQuality = "Excellent";
  else if (confidenceScore >= 0.7) tradeQuality = "High";
  else if (confidenceScore >= 0.58) tradeQuality = "Medium";

  return {
    exchange: candidate.exchange,
    symbol: candidate.symbol,
    candidate,
    coinScore: Number(coinScore.toFixed(3)),
    confidenceScore: Number(confidenceScore.toFixed(3)),
    tradeQuality,
    marketRisk: Number(riskPenalty.toFixed(3)),
    decision: shouldBuy ? "BUY" : "WAIT",
    shouldAvoid: pumpDumpRisk || lowVolumeRisk || highVolatilityRisk,
    exitSignal,
    reasons,
    rankingFactors: {
      trendScore: Number(trendScore.toFixed(3)),
      volumeScore: Number(volumeScore.toFixed(3)),
      momentumScore: Number(momentumScore.toFixed(3)),
      sentimentScore: Number(sentimentScore.toFixed(3)),
      whaleScore: Number(whaleScore.toFixed(3)),
      liquidityScore: Number(liquidityScore.toFixed(3)),
      multiTimeframeAlignment: Number(multiTimeframeAlignment.toFixed(3))
    }
  };
}

module.exports = {
  buildOpportunity
};
