const config = require("../config");

function getBucket(symbol) {
  if (symbol.startsWith("BTC/")) {
    return "BTC";
  }
  if (symbol.startsWith("ETH/")) {
    return "ETH";
  }
  return "ALT";
}

function summarizeOpenPositions(trades) {
  return trades
    .filter((trade) => trade.status === "open")
    .reduce(
      (summary, trade) => {
        const bucket = getBucket(trade.symbol);
        summary[bucket] += trade.notional || 0;
        summary.total += trade.notional || 0;
        return summary;
      },
      { BTC: 0, ETH: 0, ALT: 0, total: 0 }
    );
}

function buildPortfolioPlan(trades) {
  const current = summarizeOpenPositions(trades);
  const total = current.total || config.capital.initialINR;

  return {
    current,
    targets: {
      BTC: Number((total * config.allocation.BTC).toFixed(2)),
      ETH: Number((total * config.allocation.ETH).toFixed(2)),
      ALT: Number((total * config.allocation.ALT).toFixed(2))
    }
  };
}

function calculateAllocationBias(symbol, trades) {
  const bucket = getBucket(symbol);
  const plan = buildPortfolioPlan(trades);
  const current = plan.current[bucket];
  const target = plan.targets[bucket];

  if (!target) {
    return 1;
  }

  const remainingRoom = Math.max(0.25, 1 + (target - current) / target);
  return Number(Math.min(1.5, remainingRoom).toFixed(3));
}

module.exports = {
  buildPortfolioPlan,
  calculateAllocationBias
};
