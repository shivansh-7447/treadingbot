const config = require("../../config");
const { evaluateUltraMultiLayer } = require("../../ai/multiLayerFilters");
const { evaluateBinanceFuturesAdvancedLong } = require("../../ai/binanceFuturesAdvancedFilters");

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalize(value, min, max) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (max === min) {
    return 0.5;
  }
  return clamp((value - min) / (max - min), 0, 1);
}

function getBaseAsset(symbol = "") {
  return String(symbol).split("/")[0].toUpperCase();
}

function toBinanceSymbol(symbol = "") {
  return String(symbol).replace("/", "").toUpperCase();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function safeFetchJson(url, options = {}, fallback = null) {
  try {
    return await fetchJson(url, options);
  } catch (error) {
    return fallback;
  }
}

function buildBinanceLiveMetricsFromStream(snapshot) {
  if (!snapshot) {
    return {
      orderBookImbalance: 0,
      orderBookBidUsd: 0,
      orderBookAskUsd: 0,
      fundingRate: 0,
      openInterestUsd: 0,
      openInterestContracts: 0,
      largeTradeCount: 0,
      largeTradeImbalance: 0,
      markPrice: 0,
      latestKlineClose: 0,
      lagMs: Number.POSITIVE_INFINITY
    };
  }

  const tradeNotional = Number(snapshot.trade?.price || 0) * Number(snapshot.trade?.quantity || 0);
  const largeTradeCount = tradeNotional >= 100000 ? 1 : 0;
  const largeTradeImbalance =
    largeTradeCount > 0 ? (snapshot.trade?.isBuyerMaker ? -1 : 1) : 0;
  const updatedAtMs = snapshot.updatedAt ? new Date(snapshot.updatedAt).getTime() : 0;
  return {
    orderBookImbalance: Number(snapshot.derived?.orderBookImbalance || 0),
    orderBookBidUsd: Number(snapshot.derived?.orderBookBidUsd || 0),
    orderBookAskUsd: Number(snapshot.derived?.orderBookAskUsd || 0),
    fundingRate: Number(snapshot.derived?.fundingRate || 0),
    openInterestUsd: Number(snapshot.derived?.openInterestUsd || 0),
    openInterestContracts: Number(snapshot.openInterest?.openInterest || 0),
    largeTradeCount,
    largeTradeImbalance,
    markPrice: Number(snapshot.markPrice?.markPrice || snapshot.trade?.price || snapshot.kline?.close || 0),
    latestKlineClose: Number(snapshot.kline?.close || 0),
    lagMs: updatedAtMs ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY
  };
}

async function fetchWhaleAlertSignal(baseAsset) {
  const apiKey = config.strategies.ultraAi.dataSources.whaleAlertApiKey;
  if (!apiKey) {
    return {
      live: false,
      eventCount: 0,
      whaleUsd: 0,
      smartMoneyScore: 0.5
    };
  }

  const start = Math.floor(Date.now() / 1000) - 30 * 60;
  const url =
    `${config.strategies.ultraAi.dataSources.whaleAlert}/v1/transactions?api_key=${apiKey}` +
    `&start=${start}&min_value=100000&currency=usd`;
  const payload = await safeFetchJson(url, {}, {});
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const filtered = transactions.filter((item) => {
    const symbol = String(item.symbol || item.blockchain || "").toUpperCase();
    return symbol.includes(baseAsset);
  });
  const whaleUsd = filtered.reduce((sum, item) => sum + Number(item.amount_usd || 0), 0);

  return {
    live: true,
    eventCount: filtered.length,
    whaleUsd: Number(whaleUsd.toFixed(2)),
    smartMoneyScore: normalize(whaleUsd, 250000, 10000000)
  };
}

async function fetchEtherscanSignal() {
  const apiKey = config.strategies.ultraAi.dataSources.etherscanApiKey;
  if (!apiKey) {
    return {
      live: false,
      gasScore: 0.5,
      fastGasPrice: 0
    };
  }

  const url =
    `${config.strategies.ultraAi.dataSources.etherscan}/api?module=gastracker&action=gasoracle&apikey=${apiKey}`;
  const payload = await safeFetchJson(url, {}, {});
  const result = payload?.result || {};
  const fastGasPrice = Number(result.FastGasPrice || 0);

  return {
    live: true,
    gasScore: normalize(fastGasPrice, 10, 80),
    fastGasPrice
  };
}

async function fetchCoinGeckoSignal() {
  const [global, trending] = await Promise.all([
    safeFetchJson(`${config.strategies.ultraAi.dataSources.coingecko}/global`, {}, {}),
    safeFetchJson(`${config.strategies.ultraAi.dataSources.coingecko}/search/trending`, {}, {})
  ]);

  const marketCapChange = Number(global?.data?.market_cap_change_percentage_24h_usd || 0);
  const marketCapPercentage = global?.data?.market_cap_percentage || {};
  const btcDominance = Number(marketCapPercentage?.btc || 0);
  const trendingCoins = Array.isArray(trending?.coins)
    ? trending.coins.map((item) => String(item?.item?.symbol || "").toUpperCase()).filter(Boolean)
    : [];

  return {
    live: true,
    marketCapChange,
    btcDominance,
    trendingCoins,
    marketScore: normalize(marketCapChange, -5, 5)
  };
}

async function fetchCoinMarketCapSignal() {
  const apiKey = config.strategies.ultraAi.dataSources.coinmarketcapApiKey;
  if (!apiKey) {
    return {
      live: false,
      marketScore: 0.5,
      btcDominance: 0
    };
  }

  const payload = await safeFetchJson(
    `${config.strategies.ultraAi.dataSources.coinmarketcap}/v1/global-metrics/quotes/latest`,
    {
      headers: {
        "X-CMC_PRO_API_KEY": apiKey
      }
    },
    {}
  );
  const data = payload?.data || {};

  return {
    live: true,
    marketScore: normalize(Number(data?.quote?.USD?.total_market_cap_yesterday_percentage_change || 0), -5, 5),
    btcDominance: Number(data?.btc_dominance || 0)
  };
}

function buildUltraOpportunity(candidate, context, liveSnapshot = null) {
  const baseAiScore = normalize(Number(candidate.score || 0), -10, 20);
  const sentimentScore = clamp(
    normalize(Number(candidate.rankingFactors?.sentimentScore || 0), -1, 1),
    0,
    1
  );
  const whaleScore = Math.max(context.whaleSignal.smartMoneyScore, normalize(Number(candidate.rankingFactors?.whaleScore || 0), 0, 2));
  const orderBookScore = normalize(context.binance.orderBookImbalance, -0.2, 0.2);
  const largeTradeScore = normalize(
    context.binance.largeTradeImbalance + context.binance.largeTradeCount / 10,
    -0.3,
    1.25
  );
  const fundingScore = normalize(context.binance.fundingRate, -0.002, 0.002);
  const openInterestScore = normalize(context.binance.openInterestUsd, 50000000, 1000000000);
  const marketScore = (context.coinGecko.marketScore + context.coinMarketCap.marketScore) / 2;
  const smartMoneyScore = clamp(
    whaleScore * 0.28 +
    orderBookScore * 0.28 +
    largeTradeScore * 0.2 +
    openInterestScore * 0.16 +
    context.etherscan.gasScore * 0.08,
    0,
    1
  );
  const trendScore = normalize(
    Number(candidate.rankingFactors?.fifteenMinuteTrend || 0) * 100 +
    Number(candidate.rankingFactors?.fiveMinuteMomentum || 0) * 120,
    -1,
    4
  );
  const momentumSupport = normalize(
    Number(candidate.rankingFactors?.fiveMinuteMomentum || 0) * 1000,
    -4,
    8
  );

  const ultraScore = clamp(
    baseAiScore * 0.22 +
    trendScore * 0.16 +
    momentumSupport * 0.12 +
    sentimentScore * 0.08 +
    whaleScore * 0.08 +
    orderBookScore * 0.12 +
    largeTradeScore * 0.08 +
    fundingScore * 0.04 +
    openInterestScore * 0.05 +
    smartMoneyScore * 0.05,
    0,
    1
  );
  const confidenceScore = clamp(
    ultraScore * 0.5 +
    marketScore * 0.12 +
    smartMoneyScore * 0.12 +
    trendScore * 0.16 +
    momentumSupport * 0.1,
    0,
    1
  );
  const trendingSupport = [
    Number(candidate.rankingFactors?.fifteenMinuteTrend || 0) > 0,
    Number(candidate.rankingFactors?.fiveMinuteMomentum || 0) > 0,
    context.binance.orderBookImbalance > -0.05
  ].filter(Boolean).length;
  let shouldTrade =
    trendingSupport >= 2 &&
    context.binance.lagMs <= 15000 &&
    ultraScore >= 0.44 &&
    confidenceScore >= Math.max(0.55, config.strategies.ultraAi.confidenceThreshold - 0.15) &&
    context.binance.largeTradeImbalance > -0.35 &&
    context.binance.orderBookImbalance > -0.1;

  const reasons = [];
  if (shouldTrade) {
    const ultraMl = evaluateUltraMultiLayer({ candidate, context });
    if (!ultraMl.pass) {
      shouldTrade = false;
      reasons.push(...ultraMl.failReasons);
    }
  }
  const fxAdv = config.strategies.binanceFuturesAdvanced;
  if (
    shouldTrade &&
    fxAdv.enabled &&
    fxAdv.ultraAi &&
    liveSnapshot &&
    liveSnapshot.connected !== false
  ) {
    const fut = evaluateBinanceFuturesAdvancedLong({
      snapshot: liveSnapshot,
      fiveMinuteCandles: candidate?.timeframes?.["5m"]?.candles || [],
      whaleSignal: { score: context.whaleSignal?.smartMoneyScore ?? 0 }
    });
    if (!fut.pass && !fut.skipped) {
      shouldTrade = false;
      reasons.push(...fut.failReasons.map((r) => `binance-futures: ${r}`));
    }
  }
  if (context.binance.orderBookImbalance > 0.05) reasons.push("bid-side order book pressure");
  if (context.binance.largeTradeCount > 0) reasons.push("large live trades detected");
  if (context.binance.largeTradeImbalance > 0.05) reasons.push("aggressive buyers active");
  if (context.binance.openInterestUsd > 0) reasons.push("open interest tracked");
  if (Math.abs(context.binance.fundingRate) > 0) reasons.push("funding rate tracked");
  if (context.binance.latestKlineClose > 0) reasons.push("1m websocket kline active");
  if (context.whaleSignal.eventCount > 0) reasons.push("whale activity matched");
  if (context.coinGecko.trendingCoins.includes(getBaseAsset(candidate.symbol))) reasons.push("CoinGecko trending");
  if (context.etherscan.live) reasons.push(`ETH gas ${context.etherscan.fastGasPrice}`);
  if (context.binance.lagMs > 15000) reasons.push("websocket lag detected");

  let tradeQuality = "Monitor";
  if (confidenceScore >= 0.78) tradeQuality = "Institutional";
  else if (confidenceScore >= 0.65) tradeQuality = "High";
  else if (confidenceScore >= 0.52) tradeQuality = "Medium";

  return {
    exchange: candidate.exchange,
    symbol: candidate.symbol,
    candidate,
    decision: shouldTrade ? "BUY" : "WAIT",
    ultraScore: Number(ultraScore.toFixed(3)),
    confidenceScore: Number(confidenceScore.toFixed(3)),
    tradeQuality,
    reasons,
    smartMoneyScore: Number(smartMoneyScore.toFixed(3)),
    rankingFactors: {
      ...candidate.rankingFactors,
      ultraScore: Number(ultraScore.toFixed(3)),
      smartMoneyScore: Number(smartMoneyScore.toFixed(3)),
      orderBookImbalance: context.binance.orderBookImbalance,
      largeTradeCount: context.binance.largeTradeCount,
      largeTradeImbalance: context.binance.largeTradeImbalance,
      fundingRate: context.binance.fundingRate,
      openInterestUsd: context.binance.openInterestUsd,
      whaleUsd: context.whaleSignal.whaleUsd
    },
    liveData: {
      binance: context.binance,
      whaleSignal: context.whaleSignal,
      etherscan: context.etherscan
    }
  };
}

async function runUltraAiMode({ rankedCandidates = [], realtimeProvider = null }) {
  const preferredExchange = config.strategies.ultraAi.preferredExchange || "Binance";
  const candidates = rankedCandidates
    .filter(
      (item) =>
        !item.error &&
        item.symbol &&
        item.exchange &&
        item.exchange === preferredExchange
    )
    .slice(0, 5);

  const [coinGecko, coinMarketCap, etherscan] = await Promise.all([
    fetchCoinGeckoSignal(),
    fetchCoinMarketCapSignal(),
    fetchEtherscanSignal()
  ]);

  const opportunities = await Promise.all(
    candidates.map(async (candidate) => {
      const liveSnapshot = realtimeProvider?.getSnapshot
        ? realtimeProvider.getSnapshot(candidate.symbol)
        : null;
      const [binance, whaleSignal] = await Promise.all([
        buildBinanceLiveMetricsFromStream(liveSnapshot),
        fetchWhaleAlertSignal(getBaseAsset(candidate.symbol))
      ]);

      return buildUltraOpportunity(
        candidate,
        {
          binance,
          whaleSignal,
          etherscan,
          coinGecko,
          coinMarketCap
        },
        liveSnapshot
      );
    })
  );

  opportunities.sort((left, right) => {
    if (right.confidenceScore !== left.confidenceScore) {
      return right.confidenceScore - left.confidenceScore;
    }
    return right.ultraScore - left.ultraScore;
  });

  let bestTrade = opportunities.find((item) => item.decision === "BUY") || null;
  if (!bestTrade && config.trading.paperOnly) {
    const fallback = opportunities.find(
      (item) =>
        Number(item.liveData?.binance?.lagMs || Number.POSITIVE_INFINITY) <= 15000 &&
        item.confidenceScore >= 0.33 &&
        item.smartMoneyScore >= 0.38 &&
        Number(item.rankingFactors?.orderBookImbalance || 0) > -0.08 &&
        Number(item.rankingFactors?.fiveMinuteMomentum || 0) > -0.0035
    );
    if (fallback) {
      fallback.decision = "BUY";
      fallback.tradeQuality = "Paper Warmup";
      fallback.paperWarmup = true;
      fallback.reasons = [...fallback.reasons, "paper warmup trade enabled"];
      bestTrade = fallback;
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    dataSources: {
      websocket: "wss://fstream.binance.com",
      exchange: config.strategies.ultraAi.dataSources.exchange,
      futures: config.strategies.ultraAi.dataSources.futures,
      whaleAlertLive: Boolean(config.strategies.ultraAi.dataSources.whaleAlertApiKey),
      etherscanLive: Boolean(config.strategies.ultraAi.dataSources.etherscanApiKey),
      coingeckoLive: coinGecko.live,
      coinmarketcapLive: Boolean(config.strategies.ultraAi.dataSources.coinmarketcapApiKey)
    },
    marketSummary: {
      marketScore: Number(((coinGecko.marketScore + coinMarketCap.marketScore) / 2).toFixed(3)),
      btcDominance: Number((coinGecko.btcDominance || coinMarketCap.btcDominance || 0).toFixed(2)),
      trendingCoins: coinGecko.trendingCoins,
      etherscanGas: etherscan.fastGasPrice
    },
    opportunities,
    bestTrade
  };
}

module.exports = {
  runUltraAiMode,
  buildUltraOpportunity
};
