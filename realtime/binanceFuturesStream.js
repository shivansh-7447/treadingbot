const WebSocket = require("ws");

function toStreamSymbol(symbol = "") {
  return String(symbol).replace("/", "").toLowerCase();
}

function sumOrderBookNotional(levels = []) {
  return levels.reduce(
    (sum, [price, quantity]) => sum + Number(price || 0) * Number(quantity || 0),
    0
  );
}

class BinanceFuturesStream {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || "wss://fstream.binance.com";
    this.queueIntervalMs = Number(options.queueIntervalMs || 100);
    this.lagTimeoutMs = Number(options.lagTimeoutMs || 15000);
    this.reconnectDelayMs = Number(options.reconnectDelayMs || 3000);
    this.maxBatchSize = Number(options.maxBatchSize || 100);
    this.symbols = [];
    this.queue = [];
    this.marketState = new Map();
    this.ws = null;
    this.connected = false;
    this.started = false;
    this.reconnectTimer = null;
    this.queueTimer = null;
    this.healthTimer = null;
    this.lastMessageAt = 0;
    this.lastConnectAt = null;
    this.reconnectCount = 0;
    this.lastDisconnectReason = "";
  }

  buildStreams(symbols = []) {
    return symbols.flatMap((symbol) => {
      const streamSymbol = toStreamSymbol(symbol);
      return [
        `${streamSymbol}@trade`,
        `${streamSymbol}@aggTrade`,
        `${streamSymbol}@kline_1m`,
        `${streamSymbol}@kline_5m`,
        `${streamSymbol}@kline_1h`,
        `${streamSymbol}@kline_4h`,
        `${streamSymbol}@depth20@100ms`,
        `${streamSymbol}@markPrice@1s`,
        `${streamSymbol}@openInterest@1s`,
        `${streamSymbol}@forceOrder`
      ];
    });
  }

  buildUrl(symbols = this.symbols) {
    const streams = this.buildStreams(symbols);
    if (!streams.length) {
      return null;
    }
    return `${this.baseUrl}/stream?streams=${streams.join("/")}`;
  }

  start(symbols = []) {
    this.started = true;
    this.setSymbols(symbols);
  }

  stop() {
    this.started = false;
    this.clearTimers();
    this.queue = [];
    this.connected = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }

  setSymbols(symbols = []) {
    const normalized = [...new Set(symbols.filter(Boolean))];
    const changed = normalized.join("|") !== this.symbols.join("|");
    this.symbols = normalized;
    if (!this.started) {
      return;
    }
    if (!this.symbols.length) {
      this.stop();
      return;
    }
    if (!this.ws || changed) {
      this.connect(changed ? "symbol_update" : "start");
    }
  }

  connect(reason = "manual") {
    this.clearReconnectTimer();
    if (!this.started || !this.symbols.length) {
      return;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    const url = this.buildUrl();
    if (!url) {
      return;
    }
    this.lastConnectAt = new Date().toISOString();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.lastDisconnectReason = "";
      this.lastMessageAt = Date.now();
      this.ensureTimers();
    });

    this.ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      this.queue.push(raw.toString());
    });

    this.ws.on("close", (code, message) => {
      this.connected = false;
      this.lastDisconnectReason = `${reason}:${code}:${message || ""}`;
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      this.connected = false;
      this.lastDisconnectReason = error.message;
      this.scheduleReconnect();
    });
  }

  ensureTimers() {
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => this.processQueue(), this.queueIntervalMs);
    }
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => this.checkHealth(), 5000);
    }
  }

  clearTimers() {
    this.clearReconnectTimer();
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    if (!this.started) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectCount += 1;
      this.connect("reconnect");
    }, this.reconnectDelayMs);
  }

  checkHealth() {
    if (!this.started || !this.ws) {
      return;
    }
    if (!this.lastMessageAt) {
      return;
    }
    if (Date.now() - this.lastMessageAt > this.lagTimeoutMs) {
      this.connected = false;
      this.lastDisconnectReason = "lag_detected";
      this.connect("lag_detected");
    }
  }

  processQueue() {
    if (!this.queue.length) {
      return;
    }
    const batch = this.queue.splice(0, this.maxBatchSize);
    for (const raw of batch) {
      try {
        const payload = JSON.parse(raw);
        const data = payload?.data || payload;
        if (!data) {
          continue;
        }
        this.handlePayload(data);
      } catch (error) {
        continue;
      }
    }
  }

  ensureState(symbol) {
    if (!this.marketState.has(symbol)) {
      this.marketState.set(symbol, {
        symbol,
        trade: null,
        aggTrade: null,
        kline: null,
        kline5m: null,
        kline1h: null,
        kline4h: null,
        closedVolumes5m: [],
        depth: null,
        markPrice: null,
        openInterest: null,
        prevOiContracts: null,
        oiUpdateCount: 0,
        oiRising: false,
        oiFalling: false,
        liquidations: [],
        largeTrades: [],
        aggTradeTimestamps: [],
        updatedAt: null
      });
    }
    return this.marketState.get(symbol);
  }

  handlePayload(data) {
    let symbol = String(data.s || "").toUpperCase();
    if (data.e === "forceOrder" && data.o) {
      symbol = String(data.o.s || symbol || "").toUpperCase();
    }
    if (!symbol) {
      return;
    }
    const state = this.ensureState(symbol);
    state.updatedAt = new Date().toISOString();

    if (data.e === "trade") {
      const price = Number(data.p || 0);
      const quantity = Number(data.q || 0);
      state.trade = {
        price,
        quantity,
        tradeTime: Number(data.T || data.E || 0),
        eventTime: Number(data.E || 0),
        isBuyerMaker: Boolean(data.m)
      };
      const usd = price * quantity;
      const now = Date.now();
      if (usd >= 25000) {
        state.largeTrades.push({
          t: now,
          usd,
          takerBuy: !data.m
        });
        state.largeTrades = state.largeTrades.filter((item) => now - item.t <= 120_000);
      }
      return;
    }

    if (data.e === "aggTrade") {
      const price = Number(data.p || 0);
      const quantity = Number(data.q || 0);
      state.aggTrade = {
        price,
        quantity,
        tradeTime: Number(data.T || data.E || 0),
        eventTime: Number(data.E || 0),
        isBuyerMaker: Boolean(data.m),
        aggId: Number(data.a || 0)
      };
      const usd = price * quantity;
      const now = Date.now();
      state.aggTradeTimestamps.push(now);
      state.aggTradeTimestamps = state.aggTradeTimestamps.filter((t) => now - t <= 60_000);
      if (usd >= 25000) {
        state.largeTrades.push({
          t: now,
          usd,
          takerBuy: !data.m
        });
        state.largeTrades = state.largeTrades.filter((item) => now - item.t <= 120_000);
      }
      return;
    }

    if (data.e === "kline" && data.k) {
      const bar = {
        interval: String(data.k.i || "1m"),
        openTime: Number(data.k.t || 0),
        closeTime: Number(data.k.T || 0),
        open: Number(data.k.o || 0),
        high: Number(data.k.h || 0),
        low: Number(data.k.l || 0),
        close: Number(data.k.c || 0),
        volume: Number(data.k.v || 0),
        isClosed: Boolean(data.k.x),
        eventTime: Number(data.E || 0)
      };
      const iv = bar.interval;
      if (iv === "5m") {
        state.kline5m = bar;
        if (bar.isClosed && bar.volume > 0) {
          state.closedVolumes5m.push(bar.volume);
          const maxKeep = 120;
          if (state.closedVolumes5m.length > maxKeep) {
            state.closedVolumes5m.splice(0, state.closedVolumes5m.length - maxKeep);
          }
        }
      } else if (iv === "1h") {
        state.kline1h = bar;
      } else if (iv === "4h") {
        state.kline4h = bar;
      } else {
        state.kline = bar;
      }
      return;
    }

    if (data.e === "depthUpdate" || data.lastUpdateId) {
      const bids = (data.b || data.bids || []).map(([price, quantity]) => [
        Number(price || 0),
        Number(quantity || 0)
      ]);
      const asks = (data.a || data.asks || []).map(([price, quantity]) => [
        Number(price || 0),
        Number(quantity || 0)
      ]);
      const bidUsd = sumOrderBookNotional(bids);
      const askUsd = sumOrderBookNotional(asks);
      const totalUsd = bidUsd + askUsd;
      state.depth = {
        bids,
        asks,
        bidUsd: Number(bidUsd.toFixed(2)),
        askUsd: Number(askUsd.toFixed(2)),
        imbalance: totalUsd ? Number(((bidUsd - askUsd) / totalUsd).toFixed(4)) : 0,
        eventTime: Number(data.E || 0),
        updateId: Number(data.u || data.lastUpdateId || 0)
      };
      return;
    }

    if (data.e === "markPriceUpdate") {
      state.markPrice = {
        markPrice: Number(data.p || 0),
        fundingRate: Number(data.r || 0),
        eventTime: Number(data.E || 0),
        nextFundingTime: Number(data.T || 0)
      };
      return;
    }

    if (data.e === "openInterest") {
      const nextOi = Number(data.o || 0);
      const prev = state.prevOiContracts;
      if (prev !== null && Number.isFinite(prev) && Number.isFinite(nextOi)) {
        state.oiRising = nextOi > prev;
        state.oiFalling = nextOi < prev;
      } else {
        state.oiRising = false;
        state.oiFalling = false;
      }
      state.prevOiContracts = nextOi;
      state.oiUpdateCount += 1;
      state.openInterest = {
        openInterest: nextOi,
        eventTime: Number(data.E || 0)
      };
      return;
    }

    if (data.e === "forceOrder" && data.o) {
      const side = String(data.o.S || "").toUpperCase();
      const now = Date.now();
      state.liquidations.push({
        t: now,
        longLiquidated: side === "SELL",
        shortLiquidated: side === "BUY",
        quantity: Number(data.o.q || 0),
        price: Number(data.o.p || 0)
      });
      const windowMs = 300_000;
      state.liquidations = state.liquidations.filter((item) => now - item.t <= windowMs);
    }
  }

  getSnapshot(symbol) {
    const normalized = toStreamSymbol(symbol).toUpperCase();
    const state = this.marketState.get(normalized);
    if (!state) {
      return null;
    }
    const markPrice = Number(
      state.markPrice?.markPrice || state.aggTrade?.price || state.trade?.price || state.kline?.close || 0
    );
    const k = state.kline;
    const openPx = Number(k?.open || 0);
    const closePx = Number(k?.close || 0);
    const priceChange1mPct =
      openPx > 0 ? Number((((closePx - openPx) / openPx) * 100).toFixed(4)) : 0;

    const bull = (b) => b && Number(b.close) > Number(b.open);
    const trend4h1h5mBullAligned = Boolean(
      bull(state.kline4h) && bull(state.kline1h) && bull(state.kline5m)
    );

    const vols = state.closedVolumes5m || [];
    const lookback = vols.slice(-20);
    const volumeAvg5m =
      lookback.length > 0 ? lookback.reduce((a, b) => a + b, 0) / lookback.length : 0;
    const volumeCurrent5m = Number(state.kline5m?.volume || 0);
    const volumeSpike5m =
      volumeAvg5m > 0 ? Number((volumeCurrent5m / volumeAvg5m).toFixed(4)) : volumeCurrent5m > 0 ? 2 : 0;

    const now = Date.now();
    const liq = state.liquidations || [];
    const longLiq5m = liq.filter((x) => x.longLiquidated).length;
    const shortLiq5m = liq.filter((x) => x.shortLiquidated).length;
    const lt = state.largeTrades || [];
    const largeTakerBuyUsd1m = lt
      .filter((x) => now - x.t <= 60_000 && x.takerBuy)
      .reduce((s, x) => s + x.usd, 0);
    const largeTakerSellUsd1m = lt
      .filter((x) => now - x.t <= 60_000 && !x.takerBuy)
      .reduce((s, x) => s + x.usd, 0);
    const aggBurst1m = (state.aggTradeTimestamps || []).length;

    return {
      symbol: normalized,
      connected: this.connected,
      updatedAt: state.updatedAt,
      trade: state.trade,
      aggTrade: state.aggTrade,
      kline: state.kline,
      kline5m: state.kline5m,
      kline1h: state.kline1h,
      kline4h: state.kline4h,
      depth: state.depth,
      markPrice: state.markPrice,
      openInterest: state.openInterest,
      derived: {
        latestPrice: markPrice,
        fundingRate: Number(state.markPrice?.fundingRate || 0),
        openInterestUsd: Number(
          ((Number(state.openInterest?.openInterest || 0) || 0) * (markPrice || 0)).toFixed(2)
        ),
        orderBookImbalance: Number(state.depth?.imbalance || 0),
        orderBookBidUsd: Number(state.depth?.bidUsd || 0),
        orderBookAskUsd: Number(state.depth?.askUsd || 0),
        oiRising: Boolean(state.oiRising),
        oiFalling: Boolean(state.oiFalling),
        oiSampleCount: Number(state.oiUpdateCount || 0),
        priceChange1mPct,
        longLiquidations5m: longLiq5m,
        shortLiquidations5m: shortLiq5m,
        largeTakerBuyUsd1m: Number(largeTakerBuyUsd1m.toFixed(2)),
        largeTakerSellUsd1m: Number(largeTakerSellUsd1m.toFixed(2)),
        trend4h1h5mBullAligned,
        volumeAvg5m: Number(volumeAvg5m.toFixed(4)),
        volumeCurrent5m,
        volumeSpike5m,
        aggTradeBurst1m: aggBurst1m
      }
    };
  }

  getStatus() {
    return {
      connected: this.connected,
      started: this.started,
      symbols: this.symbols,
      lastConnectAt: this.lastConnectAt,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      reconnectCount: this.reconnectCount,
      lastDisconnectReason: this.lastDisconnectReason,
      queueLength: this.queue.length
    };
  }
}

module.exports = BinanceFuturesStream;
