const config = require("../config");

function getFeeRate(exchange) {
  return (
    config.execution.exchangeFeeRates[exchange] || config.execution.defaultFeeRate
  );
}

function getSlippageRate(symbol) {
  if (config.execution.lowSlippageSymbols.includes(symbol)) {
    return config.execution.lowSlippageRate;
  }

  if (config.execution.mediumSlippageSymbols.includes(symbol)) {
    return config.execution.mediumSlippageRate;
  }

  return config.execution.highSlippageRate;
}

function estimateExecution({
  exchange,
  symbol,
  side,
  price,
  amount,
  feeRateOverride,
  slippageRateOverride
}) {
  const feeRate = Number.isFinite(feeRateOverride) ? feeRateOverride : getFeeRate(exchange);
  const slippageRate = Number.isFinite(slippageRateOverride)
    ? slippageRateOverride
    : getSlippageRate(symbol);
  const slippageMultiplier = side === "sell" ? 1 - slippageRate : 1 + slippageRate;
  const executedPrice = Number((price * slippageMultiplier).toFixed(8));
  const grossNotional = Number((executedPrice * amount).toFixed(8));
  const fee = Number((grossNotional * feeRate).toFixed(8));
  const netNotional =
    side === "sell"
      ? Number((grossNotional - fee).toFixed(8))
      : Number((grossNotional + fee).toFixed(8));

  return {
    feeRate,
    slippageRate,
    executedPrice,
    grossNotional,
    fee,
    netNotional
  };
}

module.exports = {
  estimateExecution
};
