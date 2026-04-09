const config = require("../config");
const { collectGlobalMarketSnapshot } = require("./collector");
const { analyzeCandles } = require("./indicators");
const { buildOpportunity } = require("./scorer");

async function fetchCandidateAnalysis(client, exchange, symbol) {
  const [ticker, oneMinute, fiveMinute, fifteenMinute, oneHour, fourHour] = await Promise.all([
    client.fetchTicker(symbol),
    client.fetchOHLCV(symbol, "1m", 80),
    client.fetchOHLCV(symbol, "5m", 80),
    client.fetchOHLCV(symbol, "15m", 80),
    client.fetchOHLCV(symbol, "1h", 80),
    client.fetchOHLCV(symbol, "4h", 80)
  ]);

  return {
    exchange,
    symbol,
    ticker,
    timeframes: {
      "1m": {
        candles: oneMinute,
        metrics: analyzeCandles(oneMinute)
      },
      "5m": {
        candles: fiveMinute,
        metrics: analyzeCandles(fiveMinute)
      },
      "15m": {
        candles: fifteenMinute,
        metrics: analyzeCandles(fifteenMinute)
      },
      "1h": {
        candles: oneHour,
        metrics: analyzeCandles(oneHour)
      },
      "4h": {
        candles: fourHour,
        metrics: analyzeCandles(fourHour)
      }
    }
  };
}

function buildOverview(snapshot, opportunities, sentimentSnapshot) {
  const buySetups = opportunities.filter((item) => item.decision === "BUY").length;
  const averageConfidence = opportunities.length
    ? opportunities.reduce((sum, item) => sum + item.confidenceScore, 0) / opportunities.length
    : 0;
  const averageCoinScore = opportunities.length
    ? opportunities.reduce((sum, item) => sum + item.coinScore, 0) / opportunities.length
    : 0;
  const globalSentiment = Number((((sentimentSnapshot.compositeScore || 0) + 1) / 2).toFixed(3));
  const marketTrend = opportunities.length
    ? opportunities.filter((item) => item.rankingFactors.multiTimeframeAlignment >= 0.75).length /
      opportunities.length
    : 0;
  const marketRisk = opportunities.length
    ? opportunities.reduce((sum, item) => sum + item.marketRisk, 0) / opportunities.length
    : 0;

  return {
    monitoredCoins: snapshot.tradableUniverse.length,
    sourceCoverage: snapshot.sources,
    globalSentiment,
    marketTrend: Number(marketTrend.toFixed(3)),
    averageCoinScore: Number(averageCoinScore.toFixed(3)),
    averageConfidence: Number(averageConfidence.toFixed(3)),
    marketRisk: Number(marketRisk.toFixed(3)),
    buySetups
  };
}

async function runGlobalMarketIntelligence({
  exchangeClients,
  sentimentSnapshot,
  whaleSignals = []
}) {
  const snapshot = await collectGlobalMarketSnapshot(exchangeClients);
  const whaleMap = new Map(whaleSignals.map((item) => [`${item.exchange}:${item.symbol}`, item]));
  const opportunities = [];

  for (const item of snapshot.tradableUniverse) {
    const client = exchangeClients[item.exchange];
    if (!client) {
      continue;
    }

    try {
      const candidate = await fetchCandidateAnalysis(client, item.exchange, item.symbol);
      const opportunity = buildOpportunity(
        candidate,
        item.market,
        sentimentSnapshot,
        whaleMap.get(`${item.exchange}:${item.symbol}`),
        snapshot.funding
      );
      opportunities.push(opportunity);
    } catch (error) {
      continue;
    }
  }

  opportunities.sort((left, right) => {
    if (right.confidenceScore !== left.confidenceScore) {
      return right.confidenceScore - left.confidenceScore;
    }
    return right.coinScore - left.coinScore;
  });

  const bestTrade = opportunities.find(
    (item) =>
      item.decision === "BUY" &&
      item.coinScore >= config.marketIntelligence.minCoinScore &&
      item.confidenceScore >= config.marketIntelligence.minConfidenceScore &&
      !item.shouldAvoid
  ) || null;

  return {
    fetchedAt: snapshot.fetchedAt,
    overview: buildOverview(snapshot, opportunities, sentimentSnapshot),
    topOpportunities: opportunities.slice(0, 10),
    bestTrade,
    sources: snapshot.sources,
    funding: snapshot.funding,
    sentiment: {
      score: Number((((sentimentSnapshot.compositeScore || 0) + 1) / 2).toFixed(3)),
      raw: sentimentSnapshot
    }
  };
}

module.exports = {
  runGlobalMarketIntelligence
};
