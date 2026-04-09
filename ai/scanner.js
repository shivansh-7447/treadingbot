const config = require("../config");

const defaultSymbols = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "XRP/USDT",
  "ADA/USDT",
  "DOGE/USDT",
  "MATIC/USDT"
];

const average = (items) => {
  if (!items.length) {
    return 0;
  }
  return items.reduce((sum, item) => sum + item, 0) / items.length;
};

const pctChange = (first, last) => {
  if (!first || !last) {
    return 0;
  }
  return (last - first) / first;
};

const MAX_PRICE_DEVIATION_PCT = 0.2;

function buildMetrics(candles) {
  const closes = candles.map((item) => item[4]);
  const volumes = candles.map((item) => item[5]);
  const latestPrice = closes.at(-1) || 0;
  const trend = pctChange(closes[0], latestPrice);
  const recentMomentum = pctChange(closes.at(-6), latestPrice);
  const avgVolume = average(volumes);
  const latestVolume = volumes.at(-1) || 0;

  return {
    latestPrice,
    trend,
    recentMomentum,
    avgVolume,
    latestVolume
  };
}

function isTickerAligned(candles, tickerLast) {
  if (!candles.length || !tickerLast) {
    return true;
  }

  const latestClose = candles.at(-1)?.[4];
  if (!latestClose) {
    return true;
  }

  return Math.abs((latestClose - tickerLast) / tickerLast) <= MAX_PRICE_DEVIATION_PCT;
}

async function scanExchange(exchangeClient, preferredSymbols = defaultSymbols) {
  const markets = await exchangeClient.loadMarkets();
  const tradableSymbols = preferredSymbols.filter((symbol) => Boolean(markets[symbol]));
  const results = [];

  for (const symbol of tradableSymbols) {
    const timeframes = {};
    const warnings = [];
    let ticker = null;

    try {
      ticker = await exchangeClient.fetchTicker(symbol);

      for (const timeframe of config.analysis.timeframes) {
        const lookbackLimit =
          timeframe === "4h"
            ? config.analysis.higherTimeframeLookbackCandles
            : config.analysis.lookbackCandles;
        const rawCandles = await exchangeClient.fetchOHLCV(
          symbol,
          timeframe,
          lookbackLimit
        );
        const candles = isTickerAligned(rawCandles, ticker.last) ? rawCandles : [];

        if (rawCandles.length && !candles.length) {
          warnings.push(
            `${timeframe} candles rejected because they diverged from ticker price`
          );
        }

        timeframes[timeframe] = {
          candles,
          metrics: buildMetrics(candles)
        };
      }

      results.push({
        exchange: exchangeClient.label,
        symbol,
        ticker,
        timeframes,
        warnings
      });
    } catch (error) {
      results.push({
        exchange: exchangeClient.label,
        symbol,
        error: error.message
      });
    }
  }

  return results;
}

module.exports = {
  scanExchange,
  defaultSymbols
};
