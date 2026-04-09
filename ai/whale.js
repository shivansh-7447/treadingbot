const config = require("../config");

function detectWhaleSignals(scanResults) {
  return scanResults
    .filter((item) => !item.error && item.timeframes?.["5m"])
    .map((item) => {
      const metrics = item.timeframes["5m"].metrics;
      const ratio = metrics.avgVolume ? metrics.latestVolume / metrics.avgVolume : 0;
      const isWhaleActivity = ratio >= config.marketIntelligence.whaleVolumeSpikeThreshold;

      return {
        exchange: item.exchange,
        symbol: item.symbol,
        isWhaleActivity,
        volumeSpikeRatio: Number(ratio.toFixed(2)),
        score: isWhaleActivity ? Math.min(2, ratio / 2) : 0
      };
    })
    .filter((item) => item.isWhaleActivity);
}

module.exports = {
  detectWhaleSignals
};
