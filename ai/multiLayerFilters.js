const config = require("../config");
const { evaluateBinanceFuturesAdvancedLong } = require("./binanceFuturesAdvancedFilters");

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, v) => sum + Number(v || 0), 0) / values.length;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return null;
  }
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const h = Number(cur[2] || 0);
    const l = Number(cur[3] || 0);
    const pc = Number(prev[4] || 0);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.length ? average(slice) : null;
}

function calculateAdx(candles, period = 14) {
  if (!candles || candles.length < period + 2) {
    return null;
  }
  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const upMove = Number(cur[2] || 0) - Number(prev[2] || 0);
    const downMove = Number(prev[3] || 0) - Number(cur[3] || 0);
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(
      Math.max(
        Number(cur[2] || 0) - Number(cur[3] || 0),
        Math.abs(Number(cur[2] || 0) - Number(prev[4] || 0)),
        Math.abs(Number(cur[3] || 0) - Number(prev[4] || 0))
      )
    );
  }
  const tr14 = average(trueRanges.slice(-period));
  const plus14 = average(plusDm.slice(-period));
  const minus14 = average(minusDm.slice(-period));
  if (!tr14) {
    return null;
  }
  const plusDi = (plus14 / tr14) * 100;
  const minusDi = (minus14 / tr14) * 100;
  if (plusDi + minusDi === 0) {
    return 0;
  }
  const dx = (Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100;
  return Number(dx.toFixed(2));
}

function volumeAboveAverage(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 1) {
    return { pass: true, ratio: 1, skipped: true };
  }
  const vols = candles.slice(-lookback - 1, -1).map((c) => Number(c[5] || 0));
  const baseline = average(vols);
  const latest = Number(candles.at(-1)?.[5] || 0);
  if (!baseline) {
    return { pass: true, ratio: 1, skipped: true };
  }
  const ratio = latest / baseline;
  const mult = Number(config.strategies.multiLayerFilter.volumeAboveAvgMultiplier || 1);
  return {
    pass: ratio >= mult,
    ratio: Number(ratio.toFixed(3)),
    skipped: false
  };
}

function regimeCheck(candles) {
  const f = config.strategies.multiLayerFilter;
  const minBars = Number(f.minBarsForIndicators || 20);
  if (!candles || candles.length < minBars) {
    return { pass: true, skipped: true, reasons: [] };
  }
  const close = Number(candles.at(-1)?.[4] || 0);
  const atr = calculateATR(candles, Number(f.atrPeriod || 14));
  const adx = calculateAdx(candles, Number(f.adxPeriod || 14));
  const atrPct = close > 0 && atr ? atr / close : 0;
  const minAtrPct = Number(f.atrMinPctOfPrice || 0.0008);
  const adxMin = Number(f.adxMinThreshold || 20);
  const vol = volumeAboveAverage(candles, Number(f.volumeLookback || 20));

  const reasons = [];
  if (atrPct < minAtrPct) {
    reasons.push(`ATR% ${(atrPct * 100).toFixed(4)} below min ${(minAtrPct * 100).toFixed(4)}`);
  }
  if (adx === null || adx < adxMin) {
    reasons.push(`ADX ${adx ?? "n/a"} below ${adxMin}`);
  }
  if (!vol.pass && !vol.skipped) {
    reasons.push(`volume not above average (ratio ${vol.ratio})`);
  }

  const pass =
    atrPct >= minAtrPct &&
    adx !== null &&
    adx >= adxMin &&
    (vol.pass || vol.skipped);

  return {
    pass,
    skipped: false,
    atrPct: Number((atrPct * 100).toFixed(4)),
    adx,
    volume: vol,
    reasons
  };
}

function volatilityHighEnough(candles) {
  const f = config.strategies.multiLayerFilter;
  const minBars = Number(f.minBarsForIndicators || 20);
  if (!candles || candles.length < minBars) {
    return { pass: true, skipped: true, reasons: [] };
  }
  const close = Number(candles.at(-1)?.[4] || 0);
  const atr = calculateATR(candles, Number(f.atrPeriod || 14));
  const atrPct = close > 0 && atr ? atr / close : 0;
  const minHigh = Number(f.highVolatilityMinAtrPct || 0.001);
  const maxLow = Number(f.lowVolatilityMaxAtrPct || 0.00035);
  const reasons = [];
  if (atrPct < minHigh) {
    reasons.push(`volatility too low (ATR% ${(atrPct * 100).toFixed(4)})`);
  }
  if (atrPct > 0 && atrPct <= maxLow) {
    reasons.push("sideways / compressed ATR band");
  }
  const pass = atrPct >= minHigh && !(atrPct > 0 && atrPct <= maxLow);
  return { pass, skipped: false, atrPct: Number((atrPct * 100).toFixed(4)), reasons };
}

function hourlyBullish(candles) {
  const f = config.strategies.multiLayerFilter;
  if (!candles || candles.length < 30) {
    return { pass: true, skipped: true, reasons: [] };
  }
  const closes = candles.map((c) => Number(c[4] || 0));
  const ema20 = exponentialMovingAverageLast(closes, 20);
  const ema50 = exponentialMovingAverageLast(closes, 50);
  const price = closes.at(-1) || 0;
  const trendUp = closes.at(-1) > closes.at(-6);
  const pass =
    price > ema20 &&
    ema20 >= ema50 * (1 - Number(f.hourlyEmaTolerance || 0.002)) &&
    trendUp;
  return {
    pass,
    skipped: false,
    ema20: Number(ema20.toFixed(6)),
    ema50: Number(ema50.toFixed(6)),
    reasons: pass ? [] : ["1h not bullish vs EMAs / momentum"]
  };
}

function exponentialMovingAverageLast(closes, period) {
  if (!closes.length) {
    return 0;
  }
  const k = 2 / (period + 1);
  let ema = average(closes.slice(0, Math.min(period, closes.length)));
  for (let i = Math.min(period, closes.length); i < closes.length; i += 1) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function nearLiquidityZone(price, candles, direction) {
  const f = config.strategies.multiLayerFilter;
  const lookback = Math.min(Number(f.liquiditySwingLookback || 30), (candles || []).length - 1);
  if (!candles || candles.length < lookback || !price) {
    return { pass: true, skipped: true, reasons: [] };
  }
  const segment = candles.slice(-lookback);
  const swingHigh = Math.max(...segment.map((c) => Number(c[2] || 0)));
  const swingLow = Math.min(...segment.map((c) => Number(c[3] || 0)));
  const range = swingHigh - swingLow;
  if (range <= 0) {
    return { pass: true, skipped: true, reasons: [] };
  }
  const proximity = Number(f.liquidityZoneProximityPct || 0.004) * price;
  const distHigh = Math.abs(price - swingHigh);
  const distLow = Math.abs(price - swingLow);
  const mid = (swingHigh + swingLow) / 2;
  const distMid = Math.abs(price - mid);
  const nearEdge = Math.min(distHigh, distLow) <= proximity;
  const inMidRange = distMid < range * Number(f.midRangeAvoidFactor || 0.35) && !nearEdge;

  if (direction === "bullish") {
    const nearSupport = distLow <= proximity * 1.5;
    const pass = nearSupport || nearEdge;
    return {
      pass,
      skipped: false,
      reasons: pass ? [] : ["price mid-range / not near liquidity (support)"]
    };
  }

  const pass = nearEdge;
  return {
    pass,
    skipped: false,
    reasons: pass ? [] : ["price not near liquidity zone"]
  };
}

function orderflowConfirmsLong(whaleConfirmation, realtimeSnapshot, whaleSignal) {
  const f = config.strategies.multiLayerFilter;
  const minImb = Number(f.orderflowMinBookImbalance || 0.04);
  const minWhale = Number(f.orderflowMinWhaleScore || 0.35);
  const imb = Number(realtimeSnapshot?.derived?.orderBookImbalance || 0);
  const trade = realtimeSnapshot?.trade;
  const notional = Number(trade?.price || 0) * Number(trade?.quantity || 0);
  const largeAggBuy =
    notional >= Number(f.largeTradeUsdThreshold || 50000) && !trade?.isBuyerMaker;
  const whaleScore = Number(whaleSignal?.score || 0);
  const whaleOk =
    whaleConfirmation?.whaleBuying ||
    imb >= minImb ||
    whaleScore >= minWhale ||
    largeAggBuy;
  return {
    pass: whaleOk,
    reasons: whaleOk ? [] : ["orderflow / whale does not confirm long"]
  };
}

function isStrong4hTrend(trend, fourHourCandles) {
  const f = config.strategies.multiLayerFilter;
  if (trend?.direction !== "bullish") {
    return false;
  }
  const adx4h = calculateAdx(fourHourCandles, Number(f.adxPeriod || 14));
  const strongAdx = Number(f.strongTrendAdx4h || 26);
  if (adx4h !== null && adx4h >= strongAdx) {
    return true;
  }
  const sep = Number(f.strongTrendEmaSeparationPct || 0.012);
  return trend.price > trend.ema200 * (1 + sep);
}

function evaluateAutoMultiLayer({
  candidate,
  trend,
  liquiditySweep,
  structureBreak,
  volumeSpike,
  whaleConfirmation,
  latestPrice,
  whaleSignal,
  realtimeSnapshot
}) {
  const f = config.strategies.multiLayerFilter;
  if (!f.enabled || !f.autoAi) {
    return { pass: true, skipped: true, layers: {}, failReasons: [] };
  }

  const failReasons = [];
  const layers = {};

  const fiveM = candidate.timeframes?.["5m"]?.candles || [];
  const oneH = candidate.timeframes?.["1h"]?.candles || [];
  const fourH = candidate.timeframes?.["4h"]?.candles || [];

  const regime = regimeCheck(fiveM);
  layers.marketRegime = regime;
  if (!regime.pass && !regime.skipped) {
    failReasons.push(...regime.reasons.map((r) => `regime: ${r}`));
  }

  const vol = volatilityHighEnough(fiveM);
  layers.volatility = vol;
  if (!vol.pass && !vol.skipped) {
    failReasons.push(...vol.reasons.map((r) => `volatility: ${r}`));
  }

  const h1 = hourlyBullish(oneH);
  layers.hourlyTrend = h1;
  if (!h1.pass && !h1.skipped) {
    failReasons.push(...h1.reasons);
  }

  const mtf5mEntry =
    structureBreak?.valid &&
    structureBreak?.direction === "bullish" &&
    liquiditySweep?.valid &&
    liquiditySweep?.direction === "bullish";
  layers.mtf5mEntry = { pass: mtf5mEntry, reasons: mtf5mEntry ? [] : ["5m entry not confirmed (BOS/sweep)"] };
  if (!mtf5mEntry) {
    failReasons.push(...layers.mtf5mEntry.reasons);
  }

  const fourHBull = trend?.direction === "bullish";
  layers.mtf4h = {
    pass: fourHBull,
    reasons: fourHBull ? [] : ["4h not bullish"]
  };
  if (!fourHBull) {
    failReasons.push("4h not bullish");
  }

  const zone = nearLiquidityZone(latestPrice, fiveM, "bullish");
  layers.liquidityZone = zone;
  if (!zone.pass && !zone.skipped) {
    failReasons.push(...zone.reasons);
  }

  const flow = orderflowConfirmsLong(whaleConfirmation, realtimeSnapshot, whaleSignal);
  layers.orderflow = flow;
  if (!flow.pass) {
    failReasons.push(...flow.reasons);
  }

  const fxCfg = config.strategies.binanceFuturesAdvanced;
  if (
    fxCfg.enabled &&
    fxCfg.autoAi &&
    candidate.exchange === "Binance" &&
    realtimeSnapshot
  ) {
    const fut = evaluateBinanceFuturesAdvancedLong({
      snapshot: realtimeSnapshot,
      fiveMinuteCandles: fiveM,
      whaleSignal
    });
    layers.binanceFutures = fut.layers;
    if (!fut.pass && !fut.skipped) {
      failReasons.push(...fut.failReasons.map((r) => `binance-futures: ${r}`));
    }
  }

  const pass = failReasons.length === 0;
  return { pass, skipped: false, layers, failReasons };
}

function evaluateUltraMultiLayer({ candidate, context }) {
  const f = config.strategies.multiLayerFilter;
  if (!f.enabled || !f.ultraAi) {
    return { pass: true, skipped: true, failReasons: [] };
  }
  const fiveM = candidate?.timeframes?.["5m"]?.candles || [];
  const regime = regimeCheck(fiveM);
  const vol = volatilityHighEnough(fiveM);
  const failReasons = [];
  if (!regime.pass && !regime.skipped) {
    failReasons.push(...regime.reasons.map((r) => `ultra regime: ${r}`));
  }
  if (!vol.pass && !vol.skipped) {
    failReasons.push(...vol.reasons.map((r) => `ultra vol: ${r}`));
  }
  const imb = Number(context?.binance?.orderBookImbalance || 0);
  if (imb < Number(f.ultraMinOrderBookImbalance || 0)) {
    failReasons.push("ultra: order book not supportive");
  }
  return { pass: failReasons.length === 0, failReasons };
}

function evaluateEmaMultiLayer({ oneMinuteCandles }) {
  const f = config.strategies.multiLayerFilter;
  if (!f.enabled || !f.emaScalping) {
    return { pass: true, skipped: true, failReasons: [] };
  }
  const regime = regimeCheck(oneMinuteCandles);
  const vol = volatilityHighEnough(oneMinuteCandles);
  const failReasons = [];
  if (!regime.pass && !regime.skipped) {
    failReasons.push(...regime.reasons.map((r) => `ema regime: ${r}`));
  }
  if (!vol.pass && !vol.skipped) {
    failReasons.push(...vol.reasons.map((r) => `ema vol: ${r}`));
  }
  return { pass: failReasons.length === 0, failReasons };
}

module.exports = {
  calculateATR,
  calculateAdx,
  regimeCheck,
  volatilityHighEnough,
  hourlyBullish,
  nearLiquidityZone,
  orderflowConfirmsLong,
  isStrong4hTrend,
  evaluateAutoMultiLayer,
  evaluateUltraMultiLayer,
  evaluateEmaMultiLayer,
  volumeAboveAverage
};
