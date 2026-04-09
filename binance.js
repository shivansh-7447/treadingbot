const ccxt = require("ccxt");
const config = require("./config");

class BinanceClient {
  constructor() {
    const settings = config.exchanges.binance;
    this.publicExchange = new ccxt.binance({
      enableRateLimit: true,
      options: {
        defaultType: "spot"
      }
    });

    this.tradeExchange = new ccxt.binance({
      apiKey: settings.apiKey,
      secret: settings.secret,
      enableRateLimit: true,
      options: {
        defaultType: "spot"
      }
    });

    if (settings.sandbox) {
      this.tradeExchange.setSandboxMode(true);
    }

    this.label = settings.label;
  }

  async loadMarkets() {
    return this.publicExchange.loadMarkets();
  }

  async fetchTicker(symbol) {
    return this.publicExchange.fetchTicker(symbol);
  }

  async fetchOHLCV(symbol, timeframe, limit = 60) {
    return this.publicExchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  }

  async fetchBalance() {
    if (!config.exchanges.binance.apiKey || !config.exchanges.binance.secret) {
      return { free: {}, total: {}, info: { mode: "dry-run" } };
    }
    return this.tradeExchange.fetchBalance();
  }

  async placeSpotOrder({ symbol, side, amount }) {
    if (
      config.trading.paperOnly ||
      !config.exchanges.binance.apiKey ||
      !config.exchanges.binance.secret
    ) {
      return {
        id: `paper-binance-${Date.now()}`,
        exchange: this.label,
        status: "closed",
        side,
        amount,
        symbol,
        paper: true
      };
    }

    return this.tradeExchange.createOrder(symbol, "market", side, amount);
  }
}

module.exports = BinanceClient;
