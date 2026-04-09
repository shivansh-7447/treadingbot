function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function ema(values, period) {
  if (!values.length) {
    return 0;
  }
  const multiplier = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) {
    result = (values[index] - result) * multiplier + result;
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  if (!losses) {
    return 100;
  }

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  const macdLine = ema(values, 12) - ema(values, 26);
  const signalLine = ema(values.slice(-26).map((_, index, items) => ema(items.slice(0, index + 1), 9)), 9);
  return {
    macd: Number(macdLine.toFixed(4)),
    signal: Number(signalLine.toFixed(4)),
    histogram: Number((macdLine - signalLine).toFixed(4))
  };
}

function bollinger(values, period = 20, multiplier = 2) {
  const window = values.slice(-period);
  const mid = average(window);
  const deviation = stdDev(window);
  return {
    middle: Number(mid.toFixed(4)),
    upper: Number((mid + deviation * multiplier).toFixed(4)),
    lower: Number((mid - deviation * multiplier).toFixed(4))
  };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) {
    return 0;
  }
  const ranges = [];
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const [_, __, high, low, close] = candles[index];
    const previousClose = candles[index - 1]?.[4] || close;
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return Number(average(ranges).toFixed(4));
}

function stochasticRsi(values, period = 14) {
  if (values.length <= period + 2) {
    return 50;
  }

  const rsiSeries = [];
  for (let index = period; index < values.length; index += 1) {
    rsiSeries.push(rsi(values.slice(0, index + 1), period));
  }
  const recent = rsiSeries.slice(-period);
  const current = recent.at(-1) || 50;
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  if (max === min) {
    return 50;
  }
  return Number((((current - min) / (max - min)) * 100).toFixed(2));
}

function chaikinMoneyFlow(candles, period = 20) {
  const recent = candles.slice(-period);
  if (!recent.length) {
    return 0;
  }
  let moneyFlowVolume = 0;
  let totalVolume = 0;
  for (const candle of recent) {
    const [, open, high, low, close, volume] = candle;
    const denominator = high - low || 1;
    const moneyFlowMultiplier = ((close - low) - (high - close)) / denominator;
    moneyFlowVolume += moneyFlowMultiplier * volume;
    totalVolume += volume;
  }
  return totalVolume ? Number((moneyFlowVolume / totalVolume).toFixed(4)) : 0;
}

function analyzeCandles(candles = []) {
  const closes = candles.map((item) => Number(item[4]));
  const volumes = candles.map((item) => Number(item[5]));
  const latestClose = closes.at(-1) || 0;
  const latestVolume = volumes.at(-1) || 0;
  const previousCloses = closes.slice(-21, -1);
  const recentHigh = candles.slice(-20).reduce((max, candle) => Math.max(max, Number(candle[2] || 0)), 0);
  const recentLow = candles.slice(-20).reduce((min, candle) => Math.min(min, Number(candle[3] || latestClose)), latestClose || 0);
  const avgVolume = average(volumes.slice(-20));
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsiValue = rsi(closes, 14);
  const macdValue = macd(closes);
  const stochasticRsiValue = stochasticRsi(closes, 14);
  const bands = bollinger(closes, 20, 2);
  const atrValue = atr(candles, 14);
  const smartMoneyFlow = chaikinMoneyFlow(candles, 20);
  const volumeSpike = avgVolume > 0 && latestVolume / avgVolume >= 1.8;
  const breakout = latestClose >= Math.max(...previousCloses, latestClose);
  const volatilityPct = latestClose ? (atrValue / latestClose) * 100 : 0;
  const trendDirection =
    latestClose > ema9 && ema9 > ema21 && ema21 > ema50 ? "up" : latestClose < ema21 ? "down" : "sideways";
  const trendStrength = clamp(
    ((latestClose - ema50) / Math.max(latestClose, 1)) * 8 + (ema21 - ema50) / Math.max(latestClose, 1) * 5,
    -1,
    1
  );
  const pumpRisk = volatilityPct > 4.8 && volumeSpike;
  const volumeDrop = avgVolume > 0 && latestVolume / avgVolume <= 0.75;
  const whaleDistribution = smartMoneyFlow < -0.12 && volumeSpike;

  return {
    latestPrice: Number(latestClose.toFixed(4)),
    trendDirection,
    trendStrength: Number(trendStrength.toFixed(4)),
    breakout,
    volumeSpike,
    volumeDrop,
    whaleDistribution,
    avgVolume: Number(avgVolume.toFixed(2)),
    latestVolume: Number(latestVolume.toFixed(2)),
    volatilityPct: Number(volatilityPct.toFixed(2)),
    pumpRisk,
    ema9: Number(ema9.toFixed(4)),
    ema21: Number(ema21.toFixed(4)),
    ema50: Number(ema50.toFixed(4)),
    ema200: Number(ema200.toFixed(4)),
    rsi: Number(rsiValue.toFixed(2)),
    macd: macdValue,
    stochasticRsi: stochasticRsiValue,
    bollingerBands: bands,
    atr: atrValue,
    smartMoneyFlow
  };
}

module.exports = {
  analyzeCandles
};
