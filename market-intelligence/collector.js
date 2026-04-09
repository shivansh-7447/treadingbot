const config = require("../config");

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function fetchCoinGeckoMarkets(limit = config.marketIntelligence.topCoinsLimit) {
  const url = `${config.marketIntelligence.coinGeckoMarketsUrl}?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`;
  const markets = await fetchJson(url);
  return Array.isArray(markets)
    ? markets.map((item) => ({
        symbol: String(item.symbol || "").toUpperCase(),
        name: item.name,
        marketCap: Number(item.market_cap || 0),
        totalVolume: Number(item.total_volume || 0),
        priceChange24h: Number(item.price_change_percentage_24h || 0),
        liquidityScore: clamp(
          Number(item.total_volume || 0) / Math.max(Number(item.market_cap || 1), 1),
          0,
          1
        ),
        source: "CoinGecko"
      }))
    : [];
}

async function fetchCryptoCompareMarkets(limit = config.marketIntelligence.topCoinsLimit) {
  const url = `${config.marketIntelligence.cryptoCompareTopUrl}?limit=${limit}&tsym=USD`;
  const payload = await fetchJson(url);
  const entries = Array.isArray(payload?.Data) ? payload.Data : [];
  return entries.map((item) => {
    const info = item?.RAW?.USD || {};
    return {
      symbol: String(item?.CoinInfo?.Name || "").toUpperCase(),
      name: item?.CoinInfo?.FullName || item?.CoinInfo?.Name || "",
      marketCap: Number(info.MKTCAP || 0),
      totalVolume: Number(info.TOTALVOLUME24HTO || 0),
      priceChange24h: Number(info.CHANGEPCT24HOUR || 0),
      liquidityScore: clamp(Number(info.VOLUME24HOURTO || 0) / Math.max(Number(info.MKTCAP || 1), 1), 0, 1),
      source: "CryptoCompare"
    };
  });
}

async function fetchCoinSwitchMarkets() {
  if (!config.marketIntelligence.coinSwitchUrl) {
    return [];
  }

  try {
    const payload = await fetchJson(config.marketIntelligence.coinSwitchUrl);
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    return entries.map((item) => ({
      symbol: String(item.symbol || item.ticker || "").toUpperCase(),
      name: item.name || item.symbol || "",
      marketCap: Number(item.market_cap || 0),
      totalVolume: Number(item.volume_24h || 0),
      priceChange24h: Number(item.price_change_24h || 0),
      liquidityScore: clamp(Number(item.liquidity_score || 0), 0, 1),
      source: "CoinSwitch"
    }));
  } catch (error) {
    return [];
  }
}

async function fetchFundingSnapshot() {
  try {
    const payload = await fetchJson(config.marketIntelligence.binanceFundingUrl);
    const entries = Array.isArray(payload) ? payload.slice(0, 40) : [];
    const rates = entries.map((item) => Number(item.lastFundingRate || 0)).filter(Number.isFinite);
    const averageFundingRate = rates.length
      ? rates.reduce((sum, value) => sum + value, 0) / rates.length
      : 0;

    return {
      averageFundingRate: Number(averageFundingRate.toFixed(6)),
      fundingScore: clamp((averageFundingRate + 0.0003) / 0.0006, 0, 1)
    };
  } catch (error) {
    return {
      averageFundingRate: 0,
      fundingScore: 0.5
    };
  }
}

function mergeMarketSources(...sources) {
  const merged = new Map();

  for (const source of sources.flat()) {
    if (!source.symbol) {
      continue;
    }

    const current = merged.get(source.symbol) || {
      symbol: source.symbol,
      name: source.name,
      marketCap: 0,
      totalVolume: 0,
      priceChange24h: 0,
      liquidityScore: 0,
      sources: []
    };

    current.name = current.name || source.name;
    current.marketCap = Math.max(current.marketCap, Number(source.marketCap || 0));
    current.totalVolume = Math.max(current.totalVolume, Number(source.totalVolume || 0));
    current.priceChange24h =
      current.priceChange24h === 0
        ? Number(source.priceChange24h || 0)
        : Number(((current.priceChange24h + Number(source.priceChange24h || 0)) / 2).toFixed(2));
    current.liquidityScore = Math.max(current.liquidityScore, Number(source.liquidityScore || 0));
    current.sources = [...new Set([...current.sources, source.source])];
    merged.set(source.symbol, current);
  }

  return [...merged.values()]
    .sort((left, right) => right.marketCap - left.marketCap)
    .slice(0, config.marketIntelligence.topCoinsLimit);
}

async function buildTradableUniverse(exchangeClients, topMarkets) {
  const clientEntries = Object.entries(exchangeClients);
  const marketsByExchange = {};

  for (const [exchange, client] of clientEntries) {
    try {
      marketsByExchange[exchange] = await client.loadMarkets();
    } catch (error) {
      marketsByExchange[exchange] = {};
    }
  }

  const universe = [];
  for (const coin of topMarkets) {
    const symbol = `${coin.symbol}/USDT`;
    const preferredExchange = clientEntries.find(([exchange]) => Boolean(marketsByExchange[exchange]?.[symbol]));
    if (!preferredExchange) {
      continue;
    }

    universe.push({
      exchange: preferredExchange[0],
      symbol,
      market: coin
    });

    if (universe.length >= config.marketIntelligence.deepAnalysisLimit) {
      break;
    }
  }

  return universe;
}

async function collectGlobalMarketSnapshot(exchangeClients) {
  const [coinGecko, cryptoCompare, coinSwitch, funding] = await Promise.all([
    fetchCoinGeckoMarkets(),
    fetchCryptoCompareMarkets(),
    fetchCoinSwitchMarkets(),
    fetchFundingSnapshot()
  ]);

  const topMarkets = mergeMarketSources(coinGecko, cryptoCompare, coinSwitch);
  const tradableUniverse = await buildTradableUniverse(exchangeClients, topMarkets);

  return {
    fetchedAt: new Date().toISOString(),
    topMarkets,
    tradableUniverse,
    funding,
    sources: {
      coinGecko: coinGecko.length,
      cryptoCompare: cryptoCompare.length,
      coinSwitch: coinSwitch.length,
      tradableUniverse: tradableUniverse.length
    }
  };
}

module.exports = {
  collectGlobalMarketSnapshot
};
