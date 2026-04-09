const config = require("../config");

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

/**
 * Binance USD-M futures WebSocket + 5m ATR filters for professional signal gating.
 * Long-only for Auto/Ultra spot-style flow; encodes short-side book / OI logic for future sells.
 */

function futuresVolatilityPass(candles, cfg) {
  if (!candles || candles.length < Number(cfg.futuresAtrMinBars || 16)) {
    return { pass: true, skipped: true, reasons: [] };
  }
  const close = Number(candles.at(-1)?.[4] || 0);
  const atr = calculateATR(candles, Number(cfg.futuresAtrPeriod || 14));
  const atrPct = close > 0 && atr ? atr / close : 0;
  const minPct = Number(cfg.futuresHighVolatilityMinAtrPct || 0.001);
  const maxLowPct = Number(cfg.futuresLowVolatilityMaxAtrPct || 0.00035);
  const reasons = [];
  if (atrPct < minPct) {
    reasons.push(`futures ATR% too low (${(atrPct * 100).toFixed(4)})`);
  }
  if (atrPct > 0 && atrPct <= maxLowPct) {
    reasons.push("futures ATR in sideways band");
  }
  const pass = atrPct >= minPct && !(atrPct > 0 && atrPct <= maxLowPct);
  return {
    pass,
    skipped: false,
    atrPct: Number((atrPct * 100).toFixed(4)),
    reasons
  };
}

function evaluateBinanceFuturesAdvancedLong({
  snapshot,
  fiveMinuteCandles = [],
  whaleSignal = null
}) {
  const cfg = config.strategies.binanceFuturesAdvanced;
  const layers = {};
  const failReasons = [];

  if (!cfg.enabled) {
    return { pass: true, skipped: true, failReasons: [], layers: {} };
  }

  if (!snapshot || snapshot.connected === false) {
    return { pass: true, skipped: true, failReasons: [], layers: { note: "no_futures_snapshot" } };
  }

  const d = snapshot.derived || {};

  const vol = futuresVolatilityPass(fiveMinuteCandles, cfg);
  layers.futuresVolatility = vol;
  if (!vol.pass && !vol.skipped) {
    failReasons.push(...vol.reasons);
  }

  const funding = Number(d.fundingRate || 0);
  const fundMax = Number(cfg.fundingAbsMax || 0.0008);
  const fundingOk = Math.abs(funding) <= fundMax;
  layers.funding = { pass: fundingOk, rate: funding, maxAbs: fundMax };
  if (!fundingOk) {
    failReasons.push(
      `funding not neutral (${(funding * 100).toFixed(4)}% vs max ±${(fundMax * 100).toFixed(4)}%)`
    );
  }

  const imb = Number(d.orderBookImbalance || 0);
  const minLongImb = Number(cfg.orderbookMinImbalanceLong || 0.02);
  const bookOk = imb >= minLongImb;
  layers.orderbook = { pass: bookOk, imbalance: imb, need: `>= ${minLongImb}` };
  if (!bookOk) {
    failReasons.push(`order book: bid/ask imbalance ${imb} below ${minLongImb} (need bids heavier)`);
  }

  const oiSamples = Number(d.oiSampleCount || 0);
  if (oiSamples < 2) {
    layers.oiPrice = { pass: true, skipped: true };
  } else {
    if (d.oiFalling) {
      layers.oiPrice = { pass: false, reason: "OI decreasing" };
      failReasons.push("futures: open interest decreasing");
    } else {
      const priceMinPct = Number(cfg.price1mMinChangePct || 0.015);
      const priceUp = Number(d.priceChange1mPct || 0) >= priceMinPct;
      const oiUp = Boolean(d.oiRising);
      const priceDownOiUp =
        Number(d.priceChange1mPct || 0) <= -priceMinPct && oiUp;
      if (priceDownOiUp) {
        layers.oiPrice = { pass: false, reason: "price down + OI up (short buildup)" };
        failReasons.push("futures: price down with rising OI (avoid long)");
      } else {
        const comboOk = priceUp && oiUp;
        layers.oiPrice = {
          pass: comboOk,
          priceChange1mPct: d.priceChange1mPct,
          oiRising: oiUp,
          need: `price 1m >= ${priceMinPct}% & OI up`
        };
        if (!comboOk) {
          failReasons.push(
            "futures: need price up + open interest up on latest 1m (Binance futures)"
          );
        }
      }
    }
  }

  const whaleMin = Number(cfg.whaleMinScore || 0.35);
  const largeUsd = Number(cfg.largeTradeUsd1m || 75000);
  const liqLong = Number(d.longLiquidations5m || 0);
  const liqShort = Number(d.shortLiquidations5m || 0);
  const whaleScore = Number(whaleSignal?.score || 0);
  const bigBuy = Number(d.largeTakerBuyUsd1m || 0) >= largeUsd;
  const bigSell = Number(d.largeTakerSellUsd1m || 0) >= largeUsd;
  const liqConfirmsLong = liqLong >= liqShort + Number(cfg.liquidationLongBiasMin || 1);
  const whaleOk =
    bigBuy ||
    whaleScore >= whaleMin ||
    (liqConfirmsLong && !bigSell);
  layers.whale = {
    pass: whaleOk,
    largeTakerBuyUsd1m: d.largeTakerBuyUsd1m,
    largeTakerSellUsd1m: d.largeTakerSellUsd1m,
    longLiq: liqLong,
    shortLiq: liqShort,
    whaleScore
  };
  if (!whaleOk) {
    failReasons.push(
      "futures whale: need large taker buy, strong whale score, or long-liquidation bias without heavy sells"
    );
  }

  const pass = failReasons.length === 0;
  return { pass, skipped: false, failReasons, layers };
}

/**
 * Short-side book / OI check for future short strategies (not used by current Auto long path).
 */
function evaluateBinanceFuturesAdvancedShort({ snapshot, fiveMinuteCandles = [], whaleSignal = null }) {
  const cfg = config.strategies.binanceFuturesAdvanced;
  if (!cfg.enabled) {
    return { pass: true, skipped: true, failReasons: [], layers: {} };
  }
  if (!snapshot || snapshot.connected === false) {
    return { pass: true, skipped: true, failReasons: [], layers: {} };
  }
  const d = snapshot.derived || {};
  const failReasons = [];
  const vol = futuresVolatilityPass(fiveMinuteCandles, cfg);
  if (!vol.pass && !vol.skipped) {
    failReasons.push(...vol.reasons);
  }
  const fundMax = Number(cfg.fundingAbsMax || 0.0008);
  if (Math.abs(Number(d.fundingRate || 0)) > fundMax) {
    failReasons.push("funding not neutral for short");
  }
  const maxShortImb = Number(cfg.orderbookMinImbalanceShort || -0.02);
  if (Number(d.orderBookImbalance || 0) > maxShortImb) {
    failReasons.push(`order book: need ask-heavy imbalance <= ${maxShortImb}`);
  }
  if (Number(d.oiSampleCount || 0) >= 2) {
    if (d.oiFalling) {
      failReasons.push("OI decreasing (avoid short entry)");
    } else {
      const priceMinPct = Number(cfg.price1mMinChangePct || 0.015);
      const priceDown = Number(d.priceChange1mPct || 0) <= -priceMinPct;
      const oiUp = Boolean(d.oiRising);
      if (!(priceDown && oiUp)) {
        failReasons.push("futures: need price down + OI up for short");
      }
    }
  }
  const largeUsd = Number(cfg.largeTradeUsd1m || 75000);
  const bigSell = Number(d.largeTakerSellUsd1m || 0) >= largeUsd;
  const whaleScore = Number(whaleSignal?.score || 0);
  if (!bigSell && whaleScore < Number(cfg.whaleMinScore || 0.35)) {
    failReasons.push("futures whale: need large taker sell or whale score for short");
  }
  return { pass: failReasons.length === 0, skipped: false, failReasons, layers: {} };
}

module.exports = {
  evaluateBinanceFuturesAdvancedLong,
  evaluateBinanceFuturesAdvancedShort,
  futuresVolatilityPass
};
