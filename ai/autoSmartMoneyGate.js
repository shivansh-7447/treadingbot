const config = require("../config");

/**
 * Auto AI only: multi-factor gate using Binance Futures WebSocket snapshot (no REST).
 * All checks must pass when smartMoneyProfessional.enabled and exchange is Binance (unless allowNonBinance).
 */
function evaluateAutoSmartMoneyGate(snapshot, sm = config.strategies.autoAi.smartMoneyProfessional) {
  const out = {
    ok: true,
    score: 1,
    reasons: [],
    details: {}
  };

  if (!sm || !sm.enabled) {
    out.reasons.push("smart_money_gate_disabled");
    return out;
  }

  if (!snapshot || !snapshot.derived) {
    out.ok = false;
    out.score = 0;
    out.reasons.push("no_futures_ws_snapshot");
    return out;
  }

  if (!snapshot.connected) {
    out.ok = false;
    out.score = 0;
    out.reasons.push("futures_ws_not_connected");
    return out;
  }

  const d = snapshot.derived;
  const minBook = Number(sm.minOrderBookImbalanceLong ?? 0.15);
  const oiMin = Math.max(1, Number(sm.oiMinSamples ?? 3));

  const checks = [];

  const trendOk = Boolean(d.trend4h1h5mBullAligned);
  checks.push({ name: "trend_4h_1h_5m_bull", pass: trendOk });
  out.details.trend4h1h5mBullAligned = trendOk;

  const volumeOk =
    d.volumeAvg5m > 0
      ? d.volumeCurrent5m > d.volumeAvg5m
      : d.volumeCurrent5m > 0;
  checks.push({ name: "volume_above_avg", pass: volumeOk });
  out.details.volumeCurrent5m = d.volumeCurrent5m;
  out.details.volumeAvg5m = d.volumeAvg5m;

  const oiSamplesReady = Number(d.oiSampleCount || 0) >= oiMin;
  const oiAvoid = Boolean(d.oiFalling);
  const priceUp = Number(d.priceChange1mPct || 0) > 0;
  const oiUp = Boolean(d.oiRising);
  const bearishOiLong = !priceUp && oiUp;
  const oiLongOk = oiSamplesReady && !oiAvoid && !bearishOiLong && priceUp && oiUp;
  checks.push({
    name: "oi_price_long",
    pass: oiLongOk
  });
  out.details.oiFalling = d.oiFalling;
  out.details.oiRising = d.oiRising;
  out.details.priceChange1mPct = d.priceChange1mPct;

  const imb = Number(d.orderBookImbalance || 0);
  const bookOk = imb >= minBook;
  checks.push({ name: "orderbook_imbalance_long", pass: bookOk, value: imb });
  out.details.orderBookImbalance = imb;

  const buyLarge = Number(d.largeTakerBuyUsd1m || 0);
  const sellLarge = Number(d.largeTakerSellUsd1m || 0);
  const liqLong = Number(d.longLiquidations5m || 0);
  const liqShort = Number(d.shortLiquidations5m || 0);
  const burst = Number(d.aggTradeBurst1m || 0);
  const whaleOk =
    (buyLarge > sellLarge * 1.1 && buyLarge > 0) ||
    (liqShort > liqLong && liqShort > 0) ||
    (burst >= 30 && buyLarge >= sellLarge);
  checks.push({ name: "whale_liquidation_bias", pass: whaleOk });
  out.details.largeTakerBuyUsd1m = buyLarge;
  out.details.largeTakerSellUsd1m = sellLarge;

  const sub =
    (trendOk ? 0.2 : 0) +
    (volumeOk ? 0.2 : 0) +
    (oiLongOk ? 0.2 : 0) +
    (bookOk ? 0.2 : 0) +
    (whaleOk ? 0.2 : 0);
  out.details.smartMoneySubscore = sub;

  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  out.reasons = failed.length ? failed : ["all_smart_money_checks_passed"];
  out.score = sub;
  out.ok = failed.length === 0;
  return out;
}

module.exports = {
  evaluateAutoSmartMoneyGate
};
