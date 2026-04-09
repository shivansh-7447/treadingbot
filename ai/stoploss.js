const config = require("../config");

function buildExitPlan(entryPrice, confidence = 0.5) {
  const adaptiveBuffer = Math.max(0.005, (1 - confidence) * 0.01);
  const stopLoss = entryPrice * (1 - config.risk.stopLossPct + adaptiveBuffer);
  const minTp = Number(config.risk.takeProfitPctMin ?? 0.21);
  const maxTp = Number(config.risk.takeProfitPctMax ?? 0.5);
  const span = Math.max(0, maxTp - minTp);
  const takeProfitPct = minTp + Math.min(1, Math.max(0, confidence)) * span;
  const takeProfit = entryPrice * (1 + takeProfitPct);

  return {
    stopLoss: Number(stopLoss.toFixed(4)),
    takeProfit: Number(takeProfit.toFixed(4))
  };
}

function buildManualExitPlan(entryPrice, settings = {}) {
  const stopLossPct = Number(settings.stopLossPercent || 0) / 100;
  const minTp = Number(config.risk.takeProfitPctMin ?? 0.21);
  const maxTp = Number(config.risk.takeProfitPctMax ?? 0.5);
  const defaultTpPct = (minTp + maxTp) / 2;
  const rawTp = Number(settings.takeProfitPercent);
  const takeProfitPct = Number.isFinite(rawTp) && rawTp > 0
    ? Math.min(maxTp, Math.max(minTp, rawTp / 100))
    : defaultTpPct;

  return {
    stopLoss: Number((entryPrice * (1 - stopLossPct)).toFixed(4)),
    takeProfit: Number((entryPrice * (1 + takeProfitPct)).toFixed(4))
  };
}

function adjustTrailingStop(position, latestPrice) {
  const profitableMove = latestPrice > position.entryPrice;
  if (!profitableMove) {
    return position.stopLoss;
  }

  const trailingStop = latestPrice * (1 - config.risk.trailingStopBufferPct);
  return Number(Math.max(position.stopLoss, trailingStop).toFixed(4));
}

module.exports = {
  buildExitPlan,
  buildManualExitPlan,
  adjustTrailingStop
};
