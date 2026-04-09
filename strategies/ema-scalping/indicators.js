function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emaSeries(values, period) {
  if (!values.length) {
    return [];
  }
  const multiplier = 2 / (period + 1);
  const series = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    series.push((values[index] - series[index - 1]) * multiplier + series[index - 1]);
  }
  return series;
}

function calculateRsi(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (!losses) {
    return 100;
  }
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateAdx(candles, period = 14) {
  if (candles.length <= period + 1) {
    return 15;
  }

  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];

  for (let index = 1; index < candles.length; index += 1) {
    const prev = candles[index - 1];
    const current = candles[index];
    const upMove = current[2] - prev[2];
    const downMove = prev[3] - current[3];
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(
      Math.max(
        current[2] - current[3],
        Math.abs(current[2] - prev[4]),
        Math.abs(current[3] - prev[4])
      )
    );
  }

  const tr14 = average(trueRanges.slice(-period));
  const plus14 = average(plusDm.slice(-period));
  const minus14 = average(minusDm.slice(-period));
  if (!tr14) {
    return 15;
  }
  const plusDi = (plus14 / tr14) * 100;
  const minusDi = (minus14 / tr14) * 100;
  const dx =
    plusDi + minusDi === 0
      ? 0
      : (Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100;
  return Number(dx.toFixed(2));
}

function calculateEmaAngle(emaValues) {
  if (emaValues.length < 8) {
    return 0;
  }
  const current = emaValues.at(-1);
  const prior = emaValues.at(-6);
  if (!prior) {
    return 0;
  }
  const pctMove = ((current - prior) / prior) * 100;
  return Number((Math.atan(pctMove * 14) * (180 / Math.PI)).toFixed(2));
}

function hasRepeatedCrosses(ema9, ema15) {
  const recent = ema9.slice(-10).map((value, index) => Math.sign(value - ema15[ema15.length - 10 + index]));
  let crosses = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index] !== 0 && recent[index - 1] !== 0 && recent[index] !== recent[index - 1]) {
      crosses += 1;
    }
  }
  return crosses >= 3;
}

function detectTrend(candles, ema50Series, adx, adxTrendingThreshold, adxChoppyThreshold) {
  const highs = candles.slice(-6).map((candle) => candle[2]);
  const lows = candles.slice(-6).map((candle) => candle[3]);
  const higherHighs = highs.at(-1) > highs[0] && highs.at(-2) > highs[1];
  const higherLows = lows.at(-1) > lows[0] && lows.at(-2) > lows[1];
  const lowerHighs = highs.at(-1) < highs[0] && highs.at(-2) < highs[1];
  const lowerLows = lows.at(-1) < lows[0] && lows.at(-2) < lows[1];
  const ema50Direction = ema50Series.at(-1) > ema50Series.at(-6) ? "up" : "down";

  if (adx < adxChoppyThreshold) {
    return {
      direction: "choppy",
      isTrending: false,
      ema50Direction
    };
  }

  if (adx > adxTrendingThreshold && higherHighs && higherLows && ema50Direction === "up") {
    return {
      direction: "up",
      isTrending: true,
      ema50Direction
    };
  }

  if (adx > adxTrendingThreshold && lowerHighs && lowerLows && ema50Direction === "down") {
    return {
      direction: "down",
      isTrending: true,
      ema50Direction
    };
  }

  return {
    direction: "sideways",
    isTrending: false,
    ema50Direction
  };
}

function detectPullback(closes, ema9, ema15) {
  const latestClose = closes.at(-1) || 0;
  const nearEma9 = Math.abs((latestClose - ema9.at(-1)) / latestClose) <= 0.0025;
  const nearEma15 = Math.abs((latestClose - ema15.at(-1)) / latestClose) <= 0.0035;
  return {
    nearEma9,
    nearEma15,
    hasPullback: nearEma9 || nearEma15
  };
}

function detectRejection(candles, direction) {
  const candle = candles.at(-1);
  if (!candle) {
    return { confirmed: false, type: "none" };
  }
  const [_, open, high, low, close] = candle;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const previous = candles.at(-2);
  const bullishEngulfing =
    previous && close > open && previous[4] < previous[1] && close >= previous[1] && open <= previous[4];
  const bearishEngulfing =
    previous && close < open && previous[4] > previous[1] && close <= previous[1] && open >= previous[4];

  if (direction === "buy") {
    if (lowerWick > body * 1.8 && close > open) {
      return { confirmed: true, type: "pin_bar" };
    }
    if (bullishEngulfing) {
      return { confirmed: true, type: "engulfing" };
    }
  }

  if (direction === "sell") {
    if (upperWick > body * 1.8 && close < open) {
      return { confirmed: true, type: "pin_bar" };
    }
    if (bearishEngulfing) {
      return { confirmed: true, type: "engulfing" };
    }
  }

  return { confirmed: false, type: "none" };
}

function detectSupportResistance(candles, direction) {
  const recent = candles.slice(-20);
  const latest = recent.at(-1);
  if (!latest) {
    return { nearLevel: false, support: 0, resistance: 0 };
  }
  const support = Math.min(...recent.map((candle) => candle[3]));
  const resistance = Math.max(...recent.map((candle) => candle[2]));
  const nearSupport = Math.abs((latest[4] - support) / latest[4]) <= 0.004;
  const nearResistance = Math.abs((resistance - latest[4]) / latest[4]) <= 0.004;

  return {
    nearLevel: direction === "buy" ? nearSupport : nearResistance,
    support: Number(support.toFixed(4)),
    resistance: Number(resistance.toFixed(4))
  };
}

function detectTrendlineSignal(candles, direction) {
  const recent = candles.slice(-8);
  if (recent.length < 6) {
    return { confirmed: false, type: "none" };
  }

  const first = recent[0];
  const middle = recent[Math.floor(recent.length / 2)];
  const last = recent.at(-1);

  if (direction === "buy") {
    const projectedSlope = (middle[3] - first[3]) / Math.max(Math.floor(recent.length / 2), 1);
    const projectedLow = middle[3] + projectedSlope * (recent.length - 1 - Math.floor(recent.length / 2));
    const bounce = last[3] >= projectedLow * 0.998 && last[4] > last[1];
    return { confirmed: bounce, type: bounce ? "trendline_bounce" : "none" };
  }

  const projectedSlope = (middle[2] - first[2]) / Math.max(Math.floor(recent.length / 2), 1);
  const projectedHigh = middle[2] + projectedSlope * (recent.length - 1 - Math.floor(recent.length / 2));
  const bounce = last[2] <= projectedHigh * 1.002 && last[4] < last[1];
  return { confirmed: bounce, type: bounce ? "trendline_reject" : "none" };
}

function detectLiquidityTrap(candles, direction) {
  const latest = candles.at(-1);
  const previousWindow = candles.slice(-12, -1);
  if (!latest || previousWindow.length < 3) {
    return { detected: false, bias: "none" };
  }
  const priorHigh = Math.max(...previousWindow.map((candle) => candle[2]));
  const priorLow = Math.min(...previousWindow.map((candle) => candle[3]));

  if (direction === "sell" && latest[2] > priorHigh && latest[4] < priorHigh) {
    return { detected: true, bias: "sell" };
  }
  if (direction === "buy" && latest[3] < priorLow && latest[4] > priorLow) {
    return { detected: true, bias: "buy" };
  }

  return { detected: false, bias: "none" };
}

function buildRiskPlan(candles, direction, riskPct, minimumRrr) {
  const latest = candles.at(-1);
  if (!latest) {
    return null;
  }
  const [, open, high, low, close] = latest;
  const entry = close;
  const stopLoss = direction === "buy" ? Math.min(low, close * 0.997) : Math.max(high, close * 1.003);
  const stopDistance = Math.abs(entry - stopLoss);
  if (!stopDistance) {
    return null;
  }
  const takeProfit = direction === "buy"
    ? entry + stopDistance * minimumRrr
    : entry - stopDistance * minimumRrr;

  return {
    entryPrice: Number(entry.toFixed(5)),
    stopLoss: Number(stopLoss.toFixed(5)),
    takeProfit: Number(takeProfit.toFixed(5)),
    stopDistance: Number(stopDistance.toFixed(5)),
    rrr: minimumRrr,
    riskPct
  };
}

function analyzeEmaScalpingSetup(candles, settings) {
  if (!candles.length) {
    return null;
  }

  const closes = candles.map((candle) => candle[4]);
  const ema9 = emaSeries(closes, 9);
  const ema15 = emaSeries(closes, 15);
  const ema50 = emaSeries(closes, 50);
  const adx = calculateAdx(candles, 14);
  const trend = detectTrend(
    candles,
    ema50,
    adx,
    settings.adxTrendingThreshold,
    settings.adxChoppyThreshold
  );
  const emaAngle = calculateEmaAngle(ema9);
  const emaDirection =
    ema9.at(-1) > ema15.at(-1)
      ? "buy"
      : ema9.at(-1) < ema15.at(-1)
        ? "sell"
        : "wait";
  const trendQualified =
    trend.isTrending ||
    (adx >= settings.adxTrendingThreshold &&
      Math.abs(emaAngle) >= settings.emaAngleThreshold * 0.6 &&
      !hasRepeatedCrosses(ema9, ema15));
  const direction =
    emaDirection === "wait"
      ? "wait"
      : trend.direction === "up" && emaDirection === "buy"
        ? "buy"
        : trend.direction === "down" && emaDirection === "sell"
          ? "sell"
          : trendQualified
            ? emaDirection
            : "wait";
  const pullback = detectPullback(closes, ema9, ema15);
  const rejection = detectRejection(candles, direction);
  const supportResistance = detectSupportResistance(candles, direction);
  const trendline = detectTrendlineSignal(candles, direction);
  const trap = detectLiquidityTrap(candles, direction);
  const repeatedCrosses = hasRepeatedCrosses(ema9, ema15);
  const riskPlan =
    direction === "wait"
      ? null
      : buildRiskPlan(candles, direction, settings.maxRiskPct, settings.minRrr);

  return {
    direction,
    emaDirection,
    trendQualified,
    adx,
    trend,
    emaAngle,
    ema9: ema9.at(-1),
    ema15: ema15.at(-1),
    ema50: ema50.at(-1),
    rsi: calculateRsi(closes, 14),
    pullback,
    rejection,
    supportResistance,
    trendline,
    trap,
    repeatedCrosses,
    riskPlan,
    latestPrice: closes.at(-1)
  };
}

module.exports = {
  analyzeEmaScalpingSetup
};
