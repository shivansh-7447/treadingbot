const test = require("node:test");
const assert = require("node:assert/strict");

const { calculateATR, calculateAdx, regimeCheck } = require("../ai/multiLayerFilters");

function ohlcv({ base = 100, vol = 1000, n = 30, wick = 1.2 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = base + i * 0.15 + Math.sin(i) * 0.05;
    out.push([
      Date.now() + i * 60_000,
      c - 0.1,
      c + wick,
      c - wick,
      c,
      vol * (i > n - 3 ? 2.5 : 1)
    ]);
  }
  return out;
}

test("calculateATR returns positive value on OHLCV", () => {
  const candles = ohlcv({ n: 25 });
  const atr = calculateATR(candles, 14);
  assert.equal(atr !== null && atr > 0, true);
});

test("calculateAdx returns a number on directional candles", () => {
  const candles = ohlcv({ n: 40, wick: 0.4 });
  const adx = calculateAdx(candles, 14);
  assert.equal(typeof adx === "number" && Number.isFinite(adx), true);
});

test("regimeCheck skips when insufficient bars", () => {
  const r = regimeCheck(ohlcv({ n: 10 }));
  assert.equal(r.skipped, true);
  assert.equal(r.pass, true);
});
