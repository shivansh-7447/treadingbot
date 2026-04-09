const crypto = require("crypto");
const config = require("./config");

class CoinDCXClient {
  constructor() {
    const settings = config.exchanges.coindcx;
    this.label = settings.label;
    this.baseUrl = "https://api.coindcx.com";
    this.publicUrl = "https://public.coindcx.com";
    this.marketCache = null;
  }

  async loadMarkets() {
    if (this.marketCache) {
      return this.marketCache;
    }

    const response = await fetch(`${this.baseUrl}/exchange/v1/markets_details`);
    if (!response.ok) {
      throw new Error(`CoinDCX markets failed with HTTP ${response.status}`);
    }

    const markets = await response.json();
    this.marketCache = markets
      .filter((item) => item.status === "active")
      .reduce((accumulator, market) => {
        const standardSymbol = `${market.target_currency_short_name}/${market.base_currency_short_name}`;
        accumulator[standardSymbol] = {
          id: market.symbol,
          symbol: standardSymbol,
          pair: market.pair,
          publicPair: this.getPublicPair(market),
          precision: {
            amount: market.target_currency_precision,
            price: market.base_currency_precision
          },
          limits: {
            amount: {
              min: Number(market.min_quantity),
              max: Number(market.max_quantity)
            },
            cost: {
              min: Number(market.min_notional)
            }
          },
          info: market
        };
        return accumulator;
      }, {});

    return this.marketCache;
  }

  async fetchTicker(symbol) {
    const markets = await this.loadMarkets();
    const market = markets[symbol];
    if (!market) {
      throw new Error(`CoinDCX market not found for ${symbol}`);
    }

    const response = await fetch(`${this.baseUrl}/exchange/ticker`);
    if (!response.ok) {
      throw new Error(`CoinDCX ticker failed with HTTP ${response.status}`);
    }

    const tickers = await response.json();
    const ticker = tickers.find((item) => item.market === market.id);
    if (!ticker) {
      throw new Error(`Ticker unavailable for ${symbol}`);
    }

    return {
      symbol,
      bid: Number(ticker.bid),
      ask: Number(ticker.ask),
      last: Number(ticker.last_price),
      high: Number(ticker.high),
      low: Number(ticker.low),
      baseVolume: Number(ticker.volume),
      timestamp: Number(ticker.timestamp) * 1000,
      info: ticker
    };
  }

  async fetchOHLCV(symbol, timeframe, limit = 60) {
    const markets = await this.loadMarkets();
    const market = markets[symbol];
    if (!market) {
      throw new Error(`CoinDCX market not found for ${symbol}`);
    }

    const url = `${this.publicUrl}/market_data/candles?pair=${encodeURIComponent(
      market.publicPair
    )}&interval=${encodeURIComponent(timeframe)}&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CoinDCX candles failed with HTTP ${response.status}`);
    }

    const candles = await response.json();
    return candles
      .slice()
      .reverse()
      .map((item) => [
        Number(item.time),
        Number(item.open),
        Number(item.high),
        Number(item.low),
        Number(item.close),
        Number(item.volume)
      ]);
  }

  getPublicPair(market) {
    const quote = market.base_currency_short_name;
    const base = market.target_currency_short_name;

    if (quote === "USDT") {
      return `B-${base}_${quote}`;
    }

    if (quote === "INR") {
      return `I-${base}_${quote}`;
    }

    return market.pair;
  }

  async fetchBalance() {
    if (!config.exchanges.coindcx.apiKey || !config.exchanges.coindcx.secret) {
      return { free: {}, total: {}, info: { mode: "dry-run" } };
    }

    const body = {
      timestamp: Date.now()
    };

    const response = await this.privatePost("/exchange/v1/users/balances", body);
    const balances = Array.isArray(response) ? response : [];

    return balances.reduce(
      (accumulator, item) => {
        accumulator.free[item.currency] = Number(item.balance);
        accumulator.total[item.currency] =
          Number(item.balance) + Number(item.locked_balance || 0);
        return accumulator;
      },
      { free: {}, total: {}, info: response }
    );
  }

  async placeSpotOrder({ symbol, side, amount }) {
    if (
      config.trading.paperOnly ||
      !config.exchanges.coindcx.apiKey ||
      !config.exchanges.coindcx.secret
    ) {
      return {
        id: `paper-coindcx-${Date.now()}`,
        exchange: this.label,
        status: "closed",
        side,
        amount,
        symbol,
        paper: true
      };
    }

    const markets = await this.loadMarkets();
    const market = markets[symbol];
    if (!market) {
      throw new Error(`CoinDCX market not found for ${symbol}`);
    }

    const quantity = Number(
      amount.toFixed(Math.max(0, market.precision.amount || 6))
    );

    const body = {
      side,
      order_type: "market_order",
      market: market.id,
      total_quantity: quantity,
      timestamp: Date.now()
    };

    const response = await this.privatePost("/exchange/v1/orders/create", body);
    return {
      id: response?.orders?.[0]?.id || response?.id || `coindcx-${Date.now()}`,
      exchange: this.label,
      status: "submitted",
      side,
      amount: quantity,
      symbol,
      info: response
    };
  }

  async privatePost(path, body) {
    const payload = JSON.stringify(body);
    const signature = crypto
      .createHmac("sha256", config.exchanges.coindcx.secret)
      .update(payload)
      .digest("hex");

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-APIKEY": config.exchanges.coindcx.apiKey,
        "X-AUTH-SIGNATURE": signature
      },
      body: payload
    });

    if (!response.ok) {
      throw new Error(`CoinDCX private request failed with HTTP ${response.status}`);
    }

    return response.json();
  }
}

module.exports = CoinDCXClient;
