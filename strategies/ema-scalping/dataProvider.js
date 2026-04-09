const config = require("../../config");

const symbolMap = {
  XAUUSD: "GC=F",
  XAGUSD: "SI=F",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  BTCUSD: "BTC-USD",
  ETHUSD: "ETH-USD"
};

const intervalMap = {
  "1m": { interval: "1m", range: "7d" },
  "5m": { interval: "5m", range: "1mo" },
  "15m": { interval: "15m", range: "1mo" }
};

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function normalizeYahooCandles(payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) {
    return [];
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const candles = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const open = Number(opens[index]);
    const high = Number(highs[index]);
    const low = Number(lows[index]);
    const close = Number(closes[index]);
    const volume = Number(volumes[index] || 0);
    if (![open, high, low, close].every(Number.isFinite)) {
      continue;
    }
    candles.push([timestamps[index] * 1000, open, high, low, close, volume]);
  }
  return candles;
}

async function fetchYahooCandles(symbol, timeframe) {
  const mapped = symbolMap[symbol];
  if (!mapped) {
    throw new Error(`Unsupported EMA scalping symbol: ${symbol}`);
  }
  const intervalConfig = intervalMap[timeframe];
  if (!intervalConfig) {
    throw new Error(`Unsupported EMA scalping timeframe: ${timeframe}`);
  }

  const url = `${config.macroMarketData.yahooChartBaseUrl}/${encodeURIComponent(
    mapped
  )}?interval=${intervalConfig.interval}&range=${intervalConfig.range}&includePrePost=false`;
  const payload = await fetchJson(url);
  return normalizeYahooCandles(payload);
}

async function fetchMacroMarketSnapshot(symbol) {
  const [oneMinute, fiveMinute, fifteenMinute] = await Promise.all([
    fetchYahooCandles(symbol, "1m"),
    fetchYahooCandles(symbol, "5m"),
    fetchYahooCandles(symbol, "15m")
  ]);

  const latestPrice =
    oneMinute.at(-1)?.[4] || fiveMinute.at(-1)?.[4] || fifteenMinute.at(-1)?.[4] || 0;

  return {
    symbol,
    latestPrice,
    timeframes: {
      "1m": oneMinute,
      "5m": fiveMinute,
      "15m": fifteenMinute
    },
    source: "Yahoo Finance public market data"
  };
}

async function fetchForexFactoryEvents() {
  try {
    const events = await fetchJson(config.macroMarketData.forexFactoryCalendarUrl);
    return Array.isArray(events) ? events : [];
  } catch (error) {
    return [];
  }
}

module.exports = {
  fetchMacroMarketSnapshot,
  fetchForexFactoryEvents
};
