const { buildExitPlan } = require("./stoploss");

function simulateTradeSequence(candles, confidence = 0.55) {
  const trades = [];

  for (let index = 20; index < candles.length - 5; index += 5) {
    const entryPrice = candles[index][4];
    const { stopLoss, takeProfit } = buildExitPlan(entryPrice, confidence);
    let exitPrice = candles[index + 1][4];
    let outcome = "hold";

    for (let future = index + 1; future < Math.min(index + 6, candles.length); future += 1) {
      const high = candles[future][2];
      const low = candles[future][3];
      const close = candles[future][4];

      if (low <= stopLoss) {
        exitPrice = stopLoss;
        outcome = "stop_loss";
        break;
      }

      if (high >= takeProfit) {
        exitPrice = takeProfit;
        outcome = "take_profit";
        break;
      }

      exitPrice = close;
    }

    const pnlPct = (exitPrice - entryPrice) / entryPrice;
    trades.push({
      entryPrice,
      exitPrice,
      pnlPct,
      win: pnlPct > 0,
      outcome
    });
  }

  return trades;
}

function runBacktest(candlesBySymbol = {}) {
  const symbols = Object.keys(candlesBySymbol);
  const allTrades = symbols.flatMap((symbol) => simulateTradeSequence(candlesBySymbol[symbol]));
  const wins = allTrades.filter((trade) => trade.win).length;
  const winRate = allTrades.length ? wins / allTrades.length : 0;
  const accuracy = winRate;
  const totalPnlPct = allTrades.reduce((sum, trade) => sum + trade.pnlPct, 0);

  return {
    symbolsTested: symbols.length,
    tradesTested: allTrades.length,
    winRate: Number((winRate * 100).toFixed(2)),
    accuracy: Number((accuracy * 100).toFixed(2)),
    totalPnlPct: Number((totalPnlPct * 100).toFixed(2)),
    samples: allTrades.slice(0, 10)
  };
}

module.exports = {
  runBacktest
};
