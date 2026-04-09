const test = require("node:test");
const assert = require("node:assert/strict");

const { estimateExecution } = require("../ai/execution");

test("estimateExecution applies buy-side fees and slippage", () => {
  const result = estimateExecution({
    exchange: "Binance",
    symbol: "BTC/USDT",
    side: "buy",
    price: 100,
    amount: 2
  });

  assert.equal(result.feeRate > 0, true);
  assert.equal(result.slippageRate > 0, true);
  assert.equal(result.executedPrice > 100, true);
  assert.equal(result.netNotional > result.grossNotional, true);
});

test("estimateExecution applies sell-side slippage in opposite direction", () => {
  const result = estimateExecution({
    exchange: "CoinDCX",
    symbol: "DOGE/USDT",
    side: "sell",
    price: 10,
    amount: 10
  });

  assert.equal(result.executedPrice < 10, true);
  assert.equal(result.netNotional < result.grossNotional, true);
});
