const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
};

const parseList = (value, fallback = []) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
};

const config = {
  app: {
    name: "AI Crypto Trading Bot",
    port: parseNumber(process.env.PORT, 3000),
    pythonBin: process.env.PYTHON_BIN || "python"
  },
  storage: {
    sqlitePath: process.env.SQLITE_PATH || path.join(__dirname, "data", "bot.db"),
    legacyJsonPath: path.join(__dirname, "data", "trades.json")
  },
  auth: {
    enabled: parseBoolean(process.env.DASHBOARD_AUTH_ENABLED, true),
    username: process.env.DASHBOARD_USERNAME || "admin",
    password: process.env.DASHBOARD_PASSWORD || "change-me-now",
    sessionSecret:
      process.env.SESSION_SECRET || "crypto-bot-dashboard-change-this-session-secret"
  },
  realtime: {
    websocketEnabled: parseBoolean(process.env.WEBSOCKET_ENABLED, true),
    broadcastIntervalMs: parseNumber(process.env.WS_BROADCAST_INTERVAL_MS, 5000)
  },
  safety: {
    safeMode: true,
    manualApprovalRequired: true,
    spotOnly: true,
    noWithdrawals: true
  },
  trading: {
    paperOnly: parseBoolean(process.env.PAPER_TRADING_ONLY, true),
    exitOnMarketIntelligence: parseBoolean(process.env.EXIT_ON_MARKET_INTELLIGENCE, false),
    exitOnAutoTrendReversal: parseBoolean(process.env.EXIT_ON_AUTO_TREND_REVERSAL, false),
    exitOnAutoWhaleReversal: parseBoolean(process.env.EXIT_ON_AUTO_WHALE_REVERSAL, false)
  },
  capital: {
    initialINR: parseNumber(process.env.CAPITAL_INITIAL_INR, 5000),
    requestedTradeSizePct: 1,
    safeTradeSizePct: 1,
    effectiveTradeSizePct: parseNumber(process.env.CAPITAL_EFFECTIVE_TRADE_SIZE_PCT, 100) / 100,
    maxTradesRequestedPerDay: parseNumber(process.env.CAPITAL_MAX_TRADES_REQUESTED_PER_DAY, 100),
    maxTradesSafePerDay: parseNumber(process.env.CAPITAL_MAX_TRADES_SAFE_PER_DAY, 100),
    effectiveMaxTradesPerDay: parseNumber(process.env.CAPITAL_EFFECTIVE_MAX_TRADES_PER_DAY, 100)
  },
  capitalGrowth: {
    enabled: parseBoolean(process.env.CAPITAL_GROWTH_ENABLED, true),
    reinvestProfitFraction: parseNumber(process.env.CAPITAL_REINVEST_FRACTION, 0.5),
    minCapitalBase: parseNumber(process.env.CAPITAL_GROWTH_MIN_BASE, 500),
    winStreak3: parseNumber(process.env.CAPITAL_GROWTH_WIN_STREAK_3, 3),
    winStreak5: parseNumber(process.env.CAPITAL_GROWTH_WIN_STREAK_5, 5),
    lossStreak3: parseNumber(process.env.CAPITAL_GROWTH_LOSS_STREAK_3, 3),
    lossStreak5: parseNumber(process.env.CAPITAL_GROWTH_LOSS_STREAK_5, 5),
    riskAfterWinStreak3: parseNumber(process.env.CAPITAL_GROWTH_RISK_WIN3, 0.012),
    riskAfterWinStreak5: parseNumber(process.env.CAPITAL_GROWTH_RISK_WIN5, 0.015),
    riskAfterLossStreak3: parseNumber(process.env.CAPITAL_GROWTH_RISK_LOSS3, 0.008),
    riskAfterLossStreak5: parseNumber(process.env.CAPITAL_GROWTH_RISK_LOSS5, 0.005),
    riskMinPct: parseNumber(process.env.CAPITAL_GROWTH_RISK_MIN, 0.005),
    riskMaxPct: parseNumber(process.env.CAPITAL_GROWTH_RISK_MAX, 0.02),
    drawdownSoftPct: parseNumber(process.env.CAPITAL_GROWTH_DD_SOFT_PCT, 10),
    drawdownHardPct: parseNumber(process.env.CAPITAL_GROWTH_DD_HARD_PCT, 15),
    riskDrawdownSoft: parseNumber(process.env.CAPITAL_GROWTH_RISK_DD_SOFT, 0.005),
    pauseDurationMs: parseNumber(process.env.CAPITAL_GROWTH_PAUSE_MS, 86_400_000),
    profitLockReturnPct: parseNumber(process.env.CAPITAL_GROWTH_PROFIT_LOCK_RETURN_PCT, 5),
    profitLockRiskFactor: parseNumber(process.env.CAPITAL_GROWTH_PROFIT_LOCK_FACTOR, 0.75),
    growthHistoryMax: parseNumber(process.env.CAPITAL_GROWTH_HISTORY_MAX, 120)
  },
  risk: {
    stopLossPct: parseNumber(process.env.RISK_STOP_LOSS_PCT, 0.12),
    takeProfitPctMin: parseNumber(process.env.RISK_TAKE_PROFIT_PCT_MIN, 0.45),
    takeProfitPctMax: parseNumber(process.env.RISK_TAKE_PROFIT_PCT_MAX, 0.5),
    trailingStopBufferPct: parseNumber(process.env.RISK_TRAILING_STOP_BUFFER_PCT, 0.02)
  },
  allocation: {
    BTC: 0.3,
    ETH: 0.25,
    ALT: 0.45
  },
  analysis: {
    timeframes: ["1m", "5m", "15m", "1h", "4h"],
    lookbackCandles: 60,
    higherTimeframeLookbackCandles: parseNumber(process.env.HIGHER_TIMEFRAME_LOOKBACK_CANDLES, 240),
    scanIntervalMs: parseNumber(process.env.SCAN_INTERVAL_MS, 20 * 1000),
    maxSignalsPerScan: parseNumber(process.env.MAX_SIGNALS_PER_SCAN, 8),
    defaultQuote: "USDT"
  },
  exchanges: {
    binance: {
      id: "binance",
      label: "Binance",
      enabled: true,
      apiKey: process.env.BINANCE_API_KEY || "",
      secret: process.env.BINANCE_SECRET || "",
      sandbox: parseBoolean(process.env.BINANCE_SANDBOX, true)
    },
    coindcx: {
      id: "coindcx",
      label: "CoinDCX",
      enabled: true,
      apiKey: process.env.COINDCX_API_KEY || "",
      secret: process.env.COINDCX_SECRET || "",
      sandbox: parseBoolean(process.env.COINDCX_SANDBOX, false)
    }
  },
  marketIntelligence: {
    refreshIntervalMs: parseNumber(process.env.MARKET_INTELLIGENCE_REFRESH_MS, 30000),
    topCoinsLimit: parseNumber(process.env.MARKET_INTELLIGENCE_TOP_COINS, 100),
    deepAnalysisLimit: parseNumber(process.env.MARKET_INTELLIGENCE_DEEP_ANALYSIS_LIMIT, 12),
    minVolumeUsd: parseNumber(process.env.MARKET_INTELLIGENCE_MIN_VOLUME_USD, 25000000),
    maxPreferredVolatilityPct: parseNumber(
      process.env.MARKET_INTELLIGENCE_MAX_VOLATILITY_PCT,
      6
    ),
    minCoinScore: parseNumber(process.env.MARKET_INTELLIGENCE_MIN_COIN_SCORE, 0.65),
    minConfidenceScore: parseNumber(process.env.MARKET_INTELLIGENCE_MIN_CONFIDENCE, 0.7),
    fearGreedUrl: "https://api.alternative.me/fng/?limit=1",
    newsRssUrl: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    altNewsRssUrl: "https://cointelegraph.com/rss",
    trendingUrl: "https://api.coingecko.com/api/v3/search/trending",
    globalUrl: "https://api.coingecko.com/api/v3/global",
    mempoolFeesUrl: "https://mempool.space/api/v1/fees/recommended",
    coinGeckoMarketsUrl: "https://api.coingecko.com/api/v3/coins/markets",
    cryptoCompareTopUrl: "https://min-api.cryptocompare.com/data/top/mktcapfull",
    binanceFundingUrl: "https://fapi.binance.com/fapi/v1/premiumIndex",
    coinSwitchUrl: process.env.COINSWITCH_MARKETS_URL || "",
    whaleVolumeSpikeThreshold: 2.2
  },
  execution: {
    defaultFeeRate: parseNumber(process.env.DEFAULT_FEE_RATE, 0.001),
    exchangeFeeRates: {
      Binance: parseNumber(process.env.BINANCE_FEE_RATE, 0.001),
      CoinDCX: parseNumber(process.env.COINDCX_FEE_RATE, 0.0015)
    },
    defaultSlippageRate: parseNumber(process.env.DEFAULT_SLIPPAGE_RATE, 0.0015),
    lowSlippageSymbols: ["BTC/USDT", "ETH/USDT"],
    mediumSlippageSymbols: ["SOL/USDT", "XRP/USDT", "ADA/USDT", "MATIC/USDT"],
    lowSlippageRate: parseNumber(process.env.LOW_SLIPPAGE_RATE, 0.0008),
    mediumSlippageRate: parseNumber(process.env.MEDIUM_SLIPPAGE_RATE, 0.0015),
    highSlippageRate: parseNumber(process.env.HIGH_SLIPPAGE_RATE, 0.0025)
  },
  manual: {
    defaultMode: parseBoolean(process.env.MANUAL_MODE_DEFAULT, false),
    defaultTradingActive: parseBoolean(process.env.MANUAL_TRADING_ACTIVE, false),
    settings: {
      capitalPercent: parseNumber(process.env.MANUAL_CAPITAL_PERCENT, 5),
      takeProfitPercent: parseNumber(process.env.MANUAL_TAKE_PROFIT_PERCENT, 35),
      stopLossPercent: parseNumber(process.env.MANUAL_STOP_LOSS_PERCENT, 2),
      autoExit: parseBoolean(process.env.MANUAL_AUTO_EXIT, true),
      profitLockPercent: parseNumber(process.env.MANUAL_PROFIT_LOCK_PERCENT, 1.5)
    }
  },
  strategies: {
    defaultMode: process.env.STRATEGY_MODE_DEFAULT || "auto",
    autoAi: {
      enabled: true,
      riskPctMin: parseNumber(process.env.AUTO_AI_MIN_RISK_PCT, 0.01),
      riskPctMax: parseNumber(process.env.AUTO_AI_MAX_RISK_PCT, 0.01),
      minimumRrr: parseNumber(process.env.AUTO_AI_MIN_RRR, 2),
      preferredRrr: parseNumber(process.env.AUTO_AI_PREFERRED_RRR, 3),
      volumeSpikeThreshold: parseNumber(process.env.AUTO_AI_VOLUME_SPIKE_THRESHOLD, 1.8),
      liquiditySweepLookback: parseNumber(process.env.AUTO_AI_LIQUIDITY_LOOKBACK, 20),
      maxStopDistancePct: parseNumber(process.env.AUTO_AI_MAX_STOP_DISTANCE_PCT, 0.035),
      requireWhaleConfirmation: parseBoolean(process.env.AUTO_AI_REQUIRE_WHALE_CONFIRMATION, true),
      minConfidenceScore: parseNumber(process.env.AUTO_AI_MIN_CONFIDENCE_SCORE, 0.7),
      maxTradesPerDay: parseNumber(process.env.AUTO_AI_MAX_TRADES_PER_DAY, 5),
      smartMoneyProfessional: {
        enabled: parseBoolean(process.env.AUTO_AI_SMART_MONEY_PRO_ENABLED, true),
        applyOnlyToBinance: parseBoolean(process.env.AUTO_AI_SMART_MONEY_BINANCE_ONLY, true),
        minOrderBookImbalanceLong: parseNumber(process.env.AUTO_AI_SMART_MONEY_BOOK_IMB_MIN, 0.15),
        volumeLookback: parseNumber(process.env.AUTO_AI_SMART_MONEY_VOL_LOOKBACK, 20),
        minSmartMoneyScore: parseNumber(process.env.AUTO_AI_SMART_MONEY_MIN_SCORE, 0.55),
        maxConcurrentTrades: parseNumber(process.env.AUTO_AI_SMART_MONEY_MAX_OPEN, 2),
        professionalMaxTradesPerDay: parseNumber(process.env.AUTO_AI_SMART_MONEY_MAX_DAY, 5),
        professionalMaxDailyLossPct: parseNumber(process.env.AUTO_AI_SMART_MONEY_MAX_DD_PCT, 0.05),
        professionalRiskPct: parseNumber(process.env.AUTO_AI_SMART_MONEY_RISK_PCT, 0.01),
        oiMinSamples: parseNumber(process.env.AUTO_AI_SMART_MONEY_OI_MIN_SAMPLES, 3),
        largeTradeUsdThreshold: parseNumber(process.env.AUTO_AI_SMART_MONEY_LARGE_USD, 25000)
      }
    },
    multiLayerFilter: {
      enabled: parseBoolean(process.env.MULTI_LAYER_FILTER_ENABLED, false),
      autoAi: parseBoolean(process.env.MULTI_LAYER_AUTO_AI, true),
      ultraAi: parseBoolean(process.env.MULTI_LAYER_ULTRA_AI, true),
      emaScalping: parseBoolean(process.env.MULTI_LAYER_EMA_SCALPING, true),
      atrPeriod: parseNumber(process.env.MULTI_LAYER_ATR_PERIOD, 14),
      adxPeriod: parseNumber(process.env.MULTI_LAYER_ADX_PERIOD, 14),
      atrMinPctOfPrice: parseNumber(process.env.MULTI_LAYER_ATR_MIN_PCT, 0.0008),
      highVolatilityMinAtrPct: parseNumber(process.env.MULTI_LAYER_HIGH_VOL_ATR_PCT, 0.001),
      lowVolatilityMaxAtrPct: parseNumber(process.env.MULTI_LAYER_LOW_VOL_ATR_PCT, 0.00035),
      adxMinThreshold: parseNumber(process.env.MULTI_LAYER_ADX_MIN, 20),
      volumeAboveAvgMultiplier: parseNumber(process.env.MULTI_LAYER_VOLUME_ABOVE_AVG_MULT, 1),
      volumeLookback: parseNumber(process.env.MULTI_LAYER_VOLUME_LOOKBACK, 20),
      minBarsForIndicators: parseNumber(process.env.MULTI_LAYER_MIN_BARS, 20),
      liquidityZoneProximityPct: parseNumber(process.env.MULTI_LAYER_LIQUIDITY_PROXIMITY_PCT, 0.004),
      liquiditySwingLookback: parseNumber(process.env.MULTI_LAYER_LIQUIDITY_SWING_LOOKBACK, 30),
      midRangeAvoidFactor: parseNumber(process.env.MULTI_LAYER_MID_RANGE_FACTOR, 0.35),
      hourlyEmaTolerance: parseNumber(process.env.MULTI_LAYER_HOURLY_EMA_TOLERANCE, 0.002),
      orderflowMinBookImbalance: parseNumber(process.env.MULTI_LAYER_ORDERFLOW_MIN_IMB, 0.04),
      orderflowMinWhaleScore: parseNumber(process.env.MULTI_LAYER_ORDERFLOW_MIN_WHALE, 0.35),
      largeTradeUsdThreshold: parseNumber(process.env.MULTI_LAYER_LARGE_TRADE_USD, 50000),
      strongTrendAdx4h: parseNumber(process.env.MULTI_LAYER_STRONG_TREND_ADX_4H, 26),
      strongTrendEmaSeparationPct: parseNumber(process.env.MULTI_LAYER_STRONG_TREND_EMA_SEP_PCT, 0.012),
      ultraMinOrderBookImbalance: parseNumber(process.env.MULTI_LAYER_ULTRA_MIN_IMB, 0),
      maxDailyLossPct: parseNumber(process.env.AUTO_MAX_DAILY_LOSS_PCT, 0.04)
    },
    binanceFuturesAdvanced: {
      enabled: parseBoolean(process.env.BINANCE_FUTURES_ADVANCED_ENABLED, false),
      autoAi: parseBoolean(process.env.BINANCE_FUTURES_ADVANCED_AUTO, true),
      ultraAi: parseBoolean(process.env.BINANCE_FUTURES_ADVANCED_ULTRA, true),
      fundingAbsMax: parseNumber(process.env.BINANCE_FUTURES_FUNDING_ABS_MAX, 0.0008),
      orderbookMinImbalanceLong: parseNumber(process.env.BINANCE_FUTURES_BOOK_IMB_LONG_MIN, 0.02),
      orderbookMinImbalanceShort: parseNumber(process.env.BINANCE_FUTURES_BOOK_IMB_SHORT_MAX, -0.02),
      price1mMinChangePct: parseNumber(process.env.BINANCE_FUTURES_PRICE_1M_MIN_PCT, 0.015),
      largeTradeUsd1m: parseNumber(process.env.BINANCE_FUTURES_LARGE_TRADE_USD_1M, 75000),
      whaleMinScore: parseNumber(process.env.BINANCE_FUTURES_WHALE_MIN_SCORE, 0.35),
      liquidationLongBiasMin: parseNumber(process.env.BINANCE_FUTURES_LIQ_LONG_BIAS_MIN, 1),
      futuresAtrPeriod: parseNumber(process.env.BINANCE_FUTURES_ATR_PERIOD, 14),
      futuresAtrMinBars: parseNumber(process.env.BINANCE_FUTURES_ATR_MIN_BARS, 16),
      futuresHighVolatilityMinAtrPct: parseNumber(process.env.BINANCE_FUTURES_ATR_MIN_PCT, 0.001),
      futuresLowVolatilityMaxAtrPct: parseNumber(process.env.BINANCE_FUTURES_ATR_LOW_MAX_PCT, 0.00035)
    },
    ultraAi: {
      enabled: parseBoolean(process.env.ULTRA_AI_ENABLED, true),
      paperFirst: true,
      preferredExchange: "Binance",
      capitalPercent: parseNumber(process.env.ULTRA_AI_CAPITAL_PERCENT, 100),
      customMaxTradesPerDay: parseNumber(process.env.ULTRA_AI_MAX_TRADES_PER_DAY, 100),
      confidenceThreshold: parseNumber(process.env.ULTRA_AI_CONFIDENCE_THRESHOLD, 0.75),
      executionMode:
        process.env.ULTRA_AI_EXECUTION_MODE ||
        (parseBoolean(process.env.PAPER_TRADING_ONLY, true) ? "paper" : "live_futures"),
      dataSources: {
        exchange: process.env.ULTRA_AI_EXCHANGE_API || "https://api.binance.com",
        futures: process.env.ULTRA_AI_FUTURES_API || "https://fapi.binance.com",
        whaleAlert: process.env.ULTRA_AI_WHALE_ALERT_API || "https://api.whale-alert.io",
        whaleAlertApiKey: process.env.WHALE_ALERT_API_KEY || "",
        etherscan: process.env.ULTRA_AI_ETHERSCAN_API || "https://api.etherscan.io",
        etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",
        coingecko: process.env.ULTRA_AI_COINGECKO_API || "https://api.coingecko.com/api/v3",
        coinmarketcap: process.env.ULTRA_AI_COINMARKETCAP_API || "https://pro-api.coinmarketcap.com",
        coinmarketcapApiKey: process.env.COINMARKETCAP_API_KEY || ""
      }
    },
    emaScalping: {
      enabled: parseBoolean(process.env.EMA_SCALPING_ENABLED, true),
      paperFirst: true,
      allowPaperWarmup: parseBoolean(process.env.EMA_SCALPING_ALLOW_PAPER_WARMUP, false),
      brokerPreference: ["mt5", "oanda"],
      capitalPercent: parseNumber(process.env.EMA_SCALPING_CAPITAL_PERCENT, 100),
      customMaxTradesPerDay: parseNumber(process.env.EMA_SCALPING_MAX_TRADES_PER_DAY, 100),
      minRiskPct: parseNumber(process.env.EMA_SCALPING_MIN_RISK_PCT, 0.03),
      maxRiskPct: parseNumber(process.env.EMA_SCALPING_MAX_RISK_PCT, 0.04),
      minRrr: parseNumber(process.env.EMA_SCALPING_MIN_RRR, 2),
      confidenceThreshold: parseNumber(process.env.EMA_SCALPING_CONFIDENCE_THRESHOLD, 0.75),
      adxTrendingThreshold: parseNumber(process.env.EMA_SCALPING_ADX_TRENDING_THRESHOLD, 22),
      adxChoppyThreshold: parseNumber(process.env.EMA_SCALPING_ADX_CHOPPY_THRESHOLD, 20),
      emaAngleThreshold: parseNumber(process.env.EMA_SCALPING_EMA_ANGLE_THRESHOLD, 35),
      takeProfitPipsMin: parseNumber(process.env.EMA_SCALPING_TAKE_PROFIT_PIPS_MIN, 100),
      takeProfitPipsMax: parseNumber(process.env.EMA_SCALPING_TAKE_PROFIT_PIPS_MAX, 150),
      usePercentTakeProfit: parseBoolean(process.env.EMA_SCALPING_USE_PERCENT_TP, true),
      aggressiveExitManagement: parseBoolean(process.env.EMA_SCALPING_AGGRESSIVE_EXIT, false),
      maxAdverseStopPct: parseNumber(process.env.EMA_MAX_ADVERSE_STOP_PCT, 0.18),
      newsPauseMinutesBefore: parseNumber(process.env.EMA_SCALPING_NEWS_PAUSE_BEFORE, 30),
      newsPauseMinutesAfter: parseNumber(process.env.EMA_SCALPING_NEWS_PAUSE_AFTER, 30),
      markets: parseList(process.env.EMA_SCALPING_MARKETS, ["XAUUSD", "XAGUSD", "BTCUSD"])
    }
  },
  learning: {
    enabled: parseBoolean(process.env.LEARNING_ENABLED, true),
    recentWindow: parseNumber(process.env.LEARNING_RECENT_WINDOW, 12),
    maxStoredTrades: parseNumber(process.env.LEARNING_MAX_STORED_TRADES, 60),
    minSamplesForGating: parseNumber(process.env.LEARNING_MIN_SAMPLES_FOR_GATING, 5),
    targetWinRate: parseNumber(process.env.LEARNING_TARGET_WIN_RATE, 0.55),
    minRecentWinRate: parseNumber(process.env.LEARNING_MIN_RECENT_WIN_RATE, 0.4),
    minRecentAvgPnlPct: parseNumber(process.env.LEARNING_MIN_RECENT_AVG_PNL_PCT, -0.25),
    baseMinConfidence: parseNumber(process.env.LEARNING_BASE_MIN_CONFIDENCE, 0.2),
    maxMinConfidence: parseNumber(process.env.LEARNING_MAX_MIN_CONFIDENCE, 0.7),
    tightenPerLossStreak: parseNumber(process.env.LEARNING_TIGHTEN_PER_LOSS_STREAK, 0.04),
    autoPauseEnabled: parseBoolean(process.env.LEARNING_AUTO_PAUSE_ENABLED, false),
    autoPauseLossStreak: parseNumber(process.env.LEARNING_AUTO_PAUSE_LOSS_STREAK, 3),
    autoPauseMinutes: parseNumber(process.env.LEARNING_AUTO_PAUSE_MINUTES, 120),
    autoPauseMinSamples: parseNumber(process.env.LEARNING_AUTO_PAUSE_MIN_SAMPLES, 8),
    autoPauseMinWinRate: parseNumber(process.env.LEARNING_AUTO_PAUSE_MIN_WIN_RATE, 0.3),
    autoPauseMinAvgPnlPct: parseNumber(process.env.LEARNING_AUTO_PAUSE_MIN_AVG_PNL_PCT, -0.5),
    trainingWindow: parseNumber(process.env.LEARNING_TRAINING_WINDOW, 25)
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || ""
  },
  macroMarketData: {
    yahooChartBaseUrl: "https://query1.finance.yahoo.com/v8/finance/chart",
    forexFactoryCalendarUrl:
      process.env.FOREX_FACTORY_CALENDAR_URL ||
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
  }
};

module.exports = config;
