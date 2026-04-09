const test = require("node:test");
const assert = require("node:assert/strict");

const BinanceFuturesStream = require("../realtime/binanceFuturesStream");

test("binance futures stream builds combined websocket url for multiple pairs", () => {
  const stream = new BinanceFuturesStream();
  const url = stream.buildUrl(["BTC/USDT", "ETH/USDT"]);

  assert.equal(url.startsWith("wss://fstream.binance.com/stream?streams="), true);
  assert.equal(url.includes("btcusdt@trade"), true);
  assert.equal(url.includes("btcusdt@aggTrade"), true);
  assert.equal(url.includes("btcusdt@kline_1m"), true);
  assert.equal(url.includes("btcusdt@kline_5m"), true);
  assert.equal(url.includes("btcusdt@kline_1h"), true);
  assert.equal(url.includes("btcusdt@kline_4h"), true);
  assert.equal(url.includes("btcusdt@depth20@100ms"), true);
  assert.equal(url.includes("ethusdt@openInterest@1s"), true);
  assert.equal(url.includes("btcusdt@forceOrder"), true);
});

test("binance futures stream aggregates live snapshot from websocket payloads", () => {
  const stream = new BinanceFuturesStream();

  stream.handlePayload({
    e: "trade",
    E: Date.now(),
    s: "BTCUSDT",
    p: "65000",
    q: "2.5",
    m: false
  });
  stream.handlePayload({
    e: "kline",
    E: Date.now(),
    s: "BTCUSDT",
    k: {
      t: Date.now() - 60000,
      T: Date.now(),
      o: "64900",
      h: "65100",
      l: "64850",
      c: "65020",
      v: "125.4",
      x: false
    }
  });
  stream.handlePayload({
    e: "depthUpdate",
    E: Date.now(),
    s: "BTCUSDT",
    b: [["65000", "4"], ["64990", "3"]],
    a: [["65010", "2"], ["65020", "2.5"]]
  });
  stream.handlePayload({
    e: "markPriceUpdate",
    E: Date.now(),
    s: "BTCUSDT",
    p: "65005",
    r: "0.0004",
    T: Date.now() + 3600000
  });
  stream.handlePayload({
    e: "openInterest",
    E: Date.now(),
    s: "BTCUSDT",
    o: "1520.5"
  });
  stream.handlePayload({
    e: "openInterest",
    E: Date.now(),
    s: "BTCUSDT",
    o: "1535.2"
  });
  stream.handlePayload({
    e: "forceOrder",
    E: Date.now(),
    o: { s: "BTCUSDT", S: "SELL", q: "0.5", p: "65000" }
  });

  const snapshot = stream.getSnapshot("BTC/USDT");

  assert.equal(snapshot.trade.price, 65000);
  assert.equal(snapshot.kline.close, 65020);
  assert.equal(snapshot.depth.bids.length, 2);
  assert.equal(snapshot.markPrice.fundingRate, 0.0004);
  assert.equal(snapshot.openInterest.openInterest, 1535.2);
  assert.equal(snapshot.derived.latestPrice, 65005);
  assert.equal(snapshot.derived.openInterestUsd > 0, true);
  assert.equal(snapshot.derived.oiRising, true);
  assert.equal(snapshot.derived.longLiquidations5m >= 1, true);
});
