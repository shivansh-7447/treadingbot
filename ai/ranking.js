const { analyzeAutoTradeCandidate } = require("./autoStrategy");

function rankCoins(scanResults, sentimentSnapshot, whaleSignals, realtimeProvider = null) {
  const whaleMap = new Map(
    whaleSignals.map((item) => [`${item.exchange}:${item.symbol}`, item])
  );

  return scanResults
    .filter((item) => {
      if (item.error) {
        return false;
      }

      const oneMinutePrice = item.timeframes?.["1m"]?.metrics?.latestPrice || 0;
      const fiveMinutePrice = item.timeframes?.["5m"]?.metrics?.latestPrice || 0;
      const fifteenMinutePrice = item.timeframes?.["15m"]?.metrics?.latestPrice || 0;

      return oneMinutePrice > 0 && fiveMinutePrice > 0 && fifteenMinutePrice > 0;
    })
    .map((item) => {
      const oneMinute = item.timeframes["1m"]?.metrics || {};
      const fiveMinute = item.timeframes["5m"]?.metrics || {};
      const fifteenMinute = item.timeframes["15m"]?.metrics || {};
      const whale = whaleMap.get(`${item.exchange}:${item.symbol}`);
      const realtimeSnapshot =
        item.exchange === "Binance" && realtimeProvider?.getSnapshot
          ? realtimeProvider.getSnapshot(item.symbol)
          : null;
      const autoSetup = analyzeAutoTradeCandidate(
        item,
        whale,
        realtimeSnapshot,
        sentimentSnapshot
      );

      const score =
        (autoSetup.decision === "BUY" ? 45 : -10) +
        autoSetup.confidenceScore * 35 +
        fifteenMinute.trend * 25 +
        fiveMinute.recentMomentum * 20 +
        oneMinute.recentMomentum * 10 +
        (sentimentSnapshot.compositeScore || 0) * 10 +
        (whale?.score || 0) * 10;

      return {
        ...item,
        score,
        confidenceScore: autoSetup.confidenceScore,
        tradeQuality:
          autoSetup.confidenceScore >= 0.8
            ? "Institutional"
            : autoSetup.confidenceScore >= 0.65
              ? "High"
              : autoSetup.confidenceScore >= 0.5
                ? "Medium"
                : "Monitor",
        intelligenceReasons: autoSetup.avoidReasons.length
          ? autoSetup.avoidReasons
          : [
              `${autoSetup.trend.direction} 4h trend`,
              `${autoSetup.liquiditySweep.direction} liquidity sweep`,
              `${autoSetup.structureBreak.direction} BOS`,
              `volume ratio ${autoSetup.volumeSpike.ratio}`,
              autoSetup.whaleConfirmation.whaleBuying ? "whale buy confirmed" : "whale neutral"
            ],
        rankingFactors: {
          autoDecision: autoSetup.decision,
          autoConfidence: autoSetup.confidenceScore,
          trendDirection4h: autoSetup.trend.direction,
          ema200: autoSetup.trend.ema200,
          liquiditySweep: autoSetup.liquiditySweep.direction,
          structureBreak: autoSetup.structureBreak.direction,
          volumeSpike: autoSetup.volumeSpike.valid,
          volumeSpikeRatio: autoSetup.volumeSpike.ratio,
          whaleBuying: autoSetup.whaleConfirmation.whaleBuying,
          whaleSelling: autoSetup.whaleConfirmation.whaleSelling,
          riskReward: autoSetup.riskReward,
          stopDistancePct: autoSetup.stopDistancePct,
          avoidReasons: autoSetup.avoidReasons,
          fifteenMinuteTrend: fifteenMinute.trend || 0,
          fiveMinuteMomentum: fiveMinute.recentMomentum || 0,
          oneMinuteMomentum: oneMinute.recentMomentum || 0,
          sentimentScore: sentimentSnapshot.compositeScore || 0,
          whaleScore: whale?.score || 0,
          multiLayerPass: (() => {
            const ml = autoSetup.multiLayerReport;
            if (!ml) {
              return true;
            }
            return Boolean(ml.skipped || ml.pass);
          })(),
          multiLayerFailReasons: autoSetup.multiLayerReport?.failReasons || []
        },
        autoSetup
      };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  rankCoins
};
