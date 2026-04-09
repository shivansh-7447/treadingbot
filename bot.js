const { spawn } = require("child_process");
const crypto = require("crypto");
const config = require("./config");
const BinanceClient = require("./binance");
const CoinDCXClient = require("./coindcx");
const {
  loadState,
  saveState,
  requestApproval,
  approveTrade,
  rejectTrade,
  consumeApproval,
  updateManualControls
} = require("./manual");
const { scanExchange, defaultSymbols } = require("./ai/scanner");
const { rankCoins } = require("./ai/ranking");
const { buildSentimentSnapshot } = require("./ai/sentiment");
const { detectWhaleSignals } = require("./ai/whale");
const { buildPortfolioPlan, calculateAllocationBias } = require("./ai/portfolio");
const { buildExitPlan, buildManualExitPlan, adjustTrailingStop } = require("./ai/stoploss");
const { runBacktest } = require("./ai/backtestLearning");
const { estimateExecution } = require("./ai/execution");
const { runGlobalMarketIntelligence } = require("./market-intelligence/engine");
const { runEmaScalpingStrategy } = require("./strategies/ema-scalping/engine");
const { runUltraAiMode } = require("./strategies/ultra-ai/engine");
const { fetchMacroMarketSnapshot } = require("./strategies/ema-scalping/dataProvider");
const BinanceFuturesStream = require("./realtime/binanceFuturesStream");
const {
  MODE_KEYS,
  getEnabledModes,
  normalizeModeControls,
  startModes,
  stopModes,
  setSelectedModes
} = require("./controller/modeController");
const { buildModePerformanceSummary } = require("./performance/modePerformance");
const {
  refreshLearningState,
  recordTradeOutcome,
  buildPredictionLearningContext
} = require("./ai/learning");
const {
  getFullEquity,
  getCapitalGrowthContext,
  applyCapitalGrowthAfterClose
} = require("./ai/capitalGrowthEngine");
const { evaluateAutoSmartMoneyGate } = require("./ai/autoSmartMoneyGate");

function getEmaPipSize(symbol) {
  const normalized = String(symbol || "").toUpperCase();
  if (normalized === "BTCUSD") {
    return 1;
  }
  if (normalized === "XAUUSD") {
    return 0.01;
  }
  if (normalized === "XAGUSD") {
    return 0.001;
  }
  return 0.0001;
}

class TradingBot {
  constructor() {
    this.exchangeClients = {
      Binance: new BinanceClient(),
      CoinDCX: new CoinDCXClient()
    };
    this.binanceFuturesStream = new BinanceFuturesStream({
      baseUrl: "wss://fstream.binance.com",
      queueIntervalMs: 100,
      lagTimeoutMs: 15000,
      reconnectDelayMs: 3000
    });
    this.timer = null;
    this.intelligenceTimer = null;
    this.isBusy = false;
    this.isRefreshingIntelligence = false;
    this.runtime = {
      lastScanResults: [],
      lastRankings: [],
      lastWhaleSignals: [],
      lastSentiment: null,
      lastBacktest: null,
      lastMarketIntelligence: null,
      lastEmaScalping: null,
      lastUltraAi: null,
      binanceRealtime: this.binanceFuturesStream.getStatus()
    };
  }

  minCapitalFloor() {
    return Number(config.capitalGrowth?.minCapitalBase || 500);
  }

  equityBaseForLimits(state) {
    return Math.max(this.minCapitalFloor(), getFullEquity(state));
  }

  async start() {
    if (this.timer) {
      return this.getDashboardState();
    }

    this.binanceFuturesStream.start(this.getRealtimeSymbols());

    this.timer = setInterval(() => {
      this.scanCycle().catch((error) => {
        console.error("Scan cycle failed:", error.message);
      });
    }, config.analysis.scanIntervalMs);

    this.intelligenceTimer = setInterval(() => {
      this.refreshMarketIntelligence().catch((error) => {
        console.error("Market intelligence refresh failed:", error.message);
      });
    }, config.marketIntelligence.refreshIntervalMs);

    const state = await loadState();
    state.status.running = true;
    state.status.lastError = null;
    await saveState(state);

    void (async () => {
      try {
        await this.refreshMarketIntelligence();
        await this.scanCycle();
      } catch (error) {
        console.error("Initial bot warm-up failed:", error.message);
      }
    })();

    return this.getDashboardState();
  }

  async stop() {
    this.binanceFuturesStream.stop();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.intelligenceTimer) {
      clearInterval(this.intelligenceTimer);
      this.intelligenceTimer = null;
    }

    const state = await loadState();
    state.status.running = false;
    await saveState(state);
    return this.getDashboardState();
  }

  async scanCycle() {
    if (this.isBusy) {
      return;
    }

    this.isBusy = true;

    try {
      await this.resetDailyCounterIfNeeded();
      const state = await loadState();
      refreshLearningState(state);
      await saveState(state);
      const scanResults = [];

      for (const client of Object.values(this.exchangeClients)) {
        const exchangeScan = await scanExchange(client, defaultSymbols);
        scanResults.push(...exchangeScan);
      }

      const sentiment = await buildSentimentSnapshot();
      const whaleSignals = detectWhaleSignals(scanResults);
      const ranked = rankCoins(
        scanResults,
        sentiment,
        whaleSignals,
        this.binanceFuturesStream
      );
      const marketIntelligence = await this.refreshMarketIntelligence(sentiment, whaleSignals);
      this.binanceFuturesStream.setSymbols(this.getRealtimeSymbols(ranked));

      this.runtime.lastScanResults = scanResults;
      this.runtime.lastWhaleSignals = whaleSignals;
      this.runtime.lastRankings = ranked;
      this.runtime.lastSentiment = sentiment;
      this.runtime.lastMarketIntelligence = marketIntelligence;
      const enabledModes = this.getEnabledModes(state);
      if (enabledModes.includes("ema_scalping")) {
        this.runtime.lastEmaScalping = await runEmaScalpingStrategy();
      } else {
        this.runtime.lastEmaScalping = null;
      }
      if (enabledModes.includes("ultra_ai")) {
        this.runtime.lastUltraAi = await runUltraAiMode({
          rankedCandidates: ranked,
          realtimeProvider: this.binanceFuturesStream
        });
      } else {
        this.runtime.lastUltraAi = null;
      }
      this.runtime.binanceRealtime = this.binanceFuturesStream.getStatus();

      await this.updateOpenPositions(state, scanResults);
      for (const mode of enabledModes) {
        const latestModeState = await loadState();
        const modeState = {
          ...latestModeState,
          strategyMode: mode
        };
        if (mode === "ema_scalping") {
          await this.maybeQueueEmaScalpingSignal(modeState);
        } else {
          await this.maybeQueueSignal(modeState, ranked, sentiment, whaleSignals);
        }
      }
      await this.executeApprovedTrades();

      const latestState = await loadState();
      latestState.status.lastScanAt = new Date().toISOString();
      latestState.status.running = Boolean(this.timer);
      latestState.status.lastError = null;
      await saveState(latestState);
    } catch (error) {
      const state = await loadState();
      state.status.lastError = error.message;
      await saveState(state);
      throw error;
    } finally {
      this.isBusy = false;
    }
  }

  async resetDailyCounterIfNeeded() {
    const state = await loadState();
    const today = new Date().toISOString().slice(0, 10);

    if (state.status.currentDay !== today) {
      state.status.currentDay = today;
      state.status.dailyTrades = 0;
      state.status.dailyRealizedPnlToday = 0;
      await saveState(state);
    }
  }

  async maybeQueueSignal(state, ranked, sentiment, whaleSignals) {
    if (!ranked.length) {
      return;
    }

    const strategyMode = state.strategyMode || (state.manualMode ? "manual" : "auto");
    const isManualMode = strategyMode === "manual";
    const isUltraMode = strategyMode === "ultra_ai";
    const smProf = config.strategies.autoAi.smartMoneyProfessional;
    const learningContext = buildPredictionLearningContext(state);
    const paperBypassLearning =
      config.trading.paperOnly && (isUltraMode || strategyMode === "auto");

    if (learningContext.isPaused && !paperBypassLearning) {
      return;
    }
    if (learningContext.gateBlocked && !paperBypassLearning) {
      return;
    }
    if (isManualMode && !state.manualTradingActive) {
      return;
    }

    const capitalBaseForLimit = this.equityBaseForLimits(state);
    let maxDailyLossPct = Number(config.strategies.multiLayerFilter.maxDailyLossPct || 0.05);
    if (strategyMode === "auto" && smProf?.enabled) {
      maxDailyLossPct = Math.min(
        maxDailyLossPct,
        Number(smProf.professionalMaxDailyLossPct ?? 0.05)
      );
    }
    const maxDailyLossAbs = capitalBaseForLimit * maxDailyLossPct;
    if (Number(state.status.dailyRealizedPnlToday || 0) <= -maxDailyLossAbs) {
      return;
    }

    if (state.status.dailyTrades >= this.getDailyTradeLimit(state)) {
      return;
    }

    const excluded = new Set();
    const maxPerScan = Math.max(1, Number(config.analysis.maxSignalsPerScan || 8));

    const intelligenceCandidates =
      this.runtime.lastMarketIntelligence?.topOpportunities
        ?.filter((item) => item.decision === "BUY" && !item.shouldAvoid)
        .map((item) => ({
          ...item.candidate,
          score: item.coinScore,
          confidenceScore: item.confidenceScore,
          tradeQuality: item.tradeQuality,
          intelligenceReasons: item.reasons,
          rankingFactors: {
            ...(item.candidate.rankingFactors || {}),
            ...(item.rankingFactors || {})
          }
        })) || [];
    const ultraCandidates = isUltraMode
      ? this.runtime.lastUltraAi?.opportunities
          ?.filter((item) => item.decision === "BUY")
          .map((item) => ({
            ...item.candidate,
            score: item.ultraScore,
            confidenceScore: item.confidenceScore,
            tradeQuality: item.tradeQuality,
            intelligenceReasons: item.reasons,
            rankingFactors: {
              ...(item.candidate.rankingFactors || {}),
              ...(item.rankingFactors || {})
            },
            liveData: item.liveData
          })) || []
      : [];
    const ultraFallbackCandidates = isUltraMode
      ? ranked.filter(
          (item) => item.exchange === (config.strategies.ultraAi.preferredExchange || "Binance")
        )
      : [];
    const candidatePool = isUltraMode
      ? ultraCandidates.length
        ? ultraCandidates
        : ultraFallbackCandidates
      : strategyMode === "auto"
        ? ranked.filter((item) => item.autoSetup?.decision === "BUY")
        : intelligenceCandidates.length
          ? intelligenceCandidates
          : ranked;

    if (!candidatePool.length) {
      return;
    }

    const sortedPool = [...candidatePool].sort(
      (a, b) => Number(b.score || 0) - Number(a.score || 0)
    );

    for (let n = 0; n < maxPerScan; n += 1) {
      const latestState = await loadState();
      const latestLearning = buildPredictionLearningContext(latestState);
      const growthCtx = getCapitalGrowthContext(latestState);
      if (growthCtx.tradingPausedByCapitalGrowth) {
        break;
      }
      const modeState = { ...latestState, strategyMode };

      if (latestState.status.dailyTrades >= this.getDailyTradeLimit(modeState)) {
        break;
      }

      if (strategyMode === "auto" && smProf?.enabled) {
        const openAutoCount = latestState.trades.filter(
          (t) => t.status === "open" && t.strategyMode === "auto"
        ).length;
        if (openAutoCount >= Number(smProf.maxConcurrentTrades ?? 2)) {
          break;
        }
      }

      const disabledSymbols = new Set(
        (latestLearning.disabledSymbols || []).map((item) => item.key)
      );
      const disabledExchanges = new Set(
        (latestLearning.disabledExchanges || []).map((item) => item.key)
      );

      const passesSymbolFilters = (item) => {
        const key = `${item.exchange}:${item.symbol}`;
        if (excluded.has(key)) {
          return false;
        }
        if ((isUltraMode || strategyMode === "auto") && config.trading.paperOnly) {
          return true;
        }
        return !disabledSymbols.has(item.symbol) && !disabledExchanges.has(item.exchange);
      };

      const topCandidate = sortedPool.find((item) => passesSymbolFilters(item));
      if (!topCandidate) {
        break;
      }

      const duplicatePending = latestState.pendingApprovals.some(
        (approval) =>
          approval.status === "pending" &&
          approval.signal.symbol === topCandidate.symbol &&
          approval.signal.exchange === topCandidate.exchange
      );
      const existingOpenTrade = latestState.trades.some(
        (trade) =>
          trade.status === "open" &&
          trade.symbol === topCandidate.symbol &&
          trade.exchange === topCandidate.exchange
      );

      if (duplicatePending || existingOpenTrade) {
        excluded.add(`${topCandidate.exchange}:${topCandidate.symbol}`);
        continue;
      }

      const rawPrediction = await this.runPythonPrediction(
        topCandidate,
        sentiment,
        whaleSignals,
        latestLearning
      );
      const prediction =
        strategyMode === "auto" &&
        topCandidate.autoSetup?.decision === "BUY"
          ? {
              ...rawPrediction,
              direction: "buy",
              confidence: Math.max(
                Number(rawPrediction?.confidence || 0),
                Number(topCandidate.autoSetup?.confidenceScore || 0),
                0.55
              ),
              probabilityUp: Math.max(
                Number(rawPrediction?.probabilityUp || 0),
                Number(topCandidate.autoSetup?.confidenceScore || 0),
                0.58
              )
            }
          : isUltraMode &&
              config.trading.paperOnly &&
              topCandidate.tradeQuality === "Paper Warmup"
            ? {
                ...rawPrediction,
                direction: "buy",
                confidence: Math.max(
                  Number(rawPrediction?.confidence || 0),
                  Number(topCandidate.confidenceScore || 0),
                  0.4
                ),
                probabilityUp: Math.max(
                  Number(rawPrediction?.probabilityUp || 0),
                  Number(topCandidate.confidenceScore || 0),
                  0.55
                ),
                expectedMovePct: Math.max(Number(rawPrediction?.expectedMovePct || 0), 0.35)
              }
            : rawPrediction;
      const mlAuto =
        config.strategies.multiLayerFilter.enabled && config.strategies.multiLayerFilter.autoAi;
      let minPredictionConfidence = latestLearning.dynamicMinConfidence;
      if (
        isUltraMode &&
        config.trading.paperOnly &&
        topCandidate.tradeQuality === "Paper Warmup"
      ) {
        minPredictionConfidence = Math.min(0.35, latestLearning.dynamicMinConfidence);
      } else if (strategyMode === "auto") {
        minPredictionConfidence = mlAuto
          ? Math.max(
              Number(config.strategies.autoAi.minConfidenceScore || 0.7),
              latestLearning.dynamicMinConfidence
            )
          : config.trading.paperOnly
            ? Math.min(0.42, latestLearning.dynamicMinConfidence)
            : latestLearning.dynamicMinConfidence;
      }
      if (
        prediction.direction !== "buy" ||
        prediction.confidence < minPredictionConfidence
      ) {
        excluded.add(`${topCandidate.exchange}:${topCandidate.symbol}`);
        continue;
      }

      if (strategyMode === "auto" && smProf?.enabled) {
        if (topCandidate.exchange === "Binance") {
          const snap = this.binanceFuturesStream.getSnapshot(topCandidate.symbol);
          const gate = evaluateAutoSmartMoneyGate(snap, smProf);
          if (!gate.ok) {
            excluded.add(`${topCandidate.exchange}:${topCandidate.symbol}`);
            continue;
          }
        }
      }

      const entryPrice = this.getEntryPrice(topCandidate);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        excluded.add(`${topCandidate.exchange}:${topCandidate.symbol}`);
        continue;
      }

      const capitalBase = growthCtx.effectiveCapital;
      let autoDynamicRisk =
        growthCtx.enabled &&
        config.capitalGrowth.enabled &&
        latestState.capitalGrowth?.enabled
          ? growthCtx.autoRiskPct
          : null;
      if (strategyMode === "auto" && smProf?.enabled) {
        const capRisk = Number(smProf.professionalRiskPct ?? 0.01);
        autoDynamicRisk = autoDynamicRisk != null ? Math.min(autoDynamicRisk, capRisk) : capRisk;
      }
      const tradePlan = isManualMode
        ? this.buildManualTradePlan(entryPrice, latestState.manualSettings, capitalBase)
        : isUltraMode
          ? this.buildUltraTradePlan(
              entryPrice,
              latestState.ultraAiSettings || config.strategies.ultraAi,
              prediction.confidence,
              capitalBase
            )
          : this.buildAutoTradePlan(
              topCandidate,
              latestState.trades,
              latestState.autoSettings,
              entryPrice,
              prediction.confidence,
              capitalBase,
              autoDynamicRisk
            );
      const {
        notional,
        exitPlan,
        strategyMode: signalStrategyMode,
        strategySettings
      } = tradePlan;
      const estimatedExecution = estimateExecution({
        exchange: topCandidate.exchange,
        symbol: topCandidate.symbol,
        side: "buy",
        price: entryPrice,
        amount: Number((notional / entryPrice).toFixed(6))
      });
      const whaleForSignal =
        whaleSignals.find(
          (item) =>
            item.exchange === topCandidate.exchange && item.symbol === topCandidate.symbol
        ) || null;

      const signal = {
        exchange: topCandidate.exchange,
        symbol: topCandidate.symbol,
        price: entryPrice,
        notional,
        side: "buy",
        prediction,
        exitPlan,
        score: Number(topCandidate.score.toFixed(3)),
        rankingFactors: topCandidate.rankingFactors,
        confidenceScore: Number(topCandidate.confidenceScore || prediction.confidence || 0),
        tradeQuality: topCandidate.tradeQuality || "Standard",
        intelligenceReasons: topCandidate.intelligenceReasons || [],
        sentiment,
        whaleSignal: whaleForSignal,
        estimatedExecution,
        strategyMode: signalStrategyMode,
        strategySettings,
        createdBy: isManualMode ? "manual-control" : isUltraMode ? "ultra-ai-engine" : "ai-engine"
      };

      const approval = await requestApproval(signal);
      if (isUltraMode) {
        await approveTrade(approval.id, "Auto-approved in Ultra AI mode");
        await this.executeApprovedTrades();
      } else if (strategyMode === "auto" && config.trading.paperOnly) {
        await approveTrade(approval.id, "Auto-approved in paper Auto AI mode");
        await this.executeApprovedTrades();
      }
      await this.sendTelegramAlert(
        `🔔 New signal\n${signal.exchange} ${signal.symbol}\nPrice: ${signal.price}\nNotional: ${this.formatRs(signal.notional)}\nConfidence: ${Number(signal.prediction?.confidence || 0).toFixed(3)}`
      );

      excluded.add(`${topCandidate.exchange}:${topCandidate.symbol}`);
    }
  }

  async executeApprovedTrades() {
    const state = await loadState();
    const learningContext = buildPredictionLearningContext(state);
    const hasApprovedEmaSignals = state.pendingApprovals.some(
      (item) => item.status === "approved" && item.signal?.strategyMode === "ema_scalping"
    );
    const hasApprovedUltraSignals = state.pendingApprovals.some(
      (item) => item.status === "approved" && item.signal?.strategyMode === "ultra_ai"
    );
    if (learningContext.isPaused && !hasApprovedEmaSignals && !hasApprovedUltraSignals) {
      return;
    }

    const approvedIds = state.pendingApprovals
      .filter((item) => item.status === "approved")
      .map((item) => item.id);

    for (const approvalId of approvedIds) {
      const latestState = await loadState();
      if (latestState.status.dailyTrades >= this.getDailyTradeLimit(latestState)) {
        break;
      }

      const approval = latestState.pendingApprovals.find((item) => item.id === approvalId);
      if (!approval || approval.status !== "approved") {
        continue;
      }

      await this.executeTrade(approval.signal);
      await consumeApproval(approval.id);

      const refreshedState = await loadState();
      refreshedState.status.dailyTrades += 1;
      await saveState(refreshedState);
    }
  }

  async executeTrade(signal) {
    const state = await loadState();
    const client = this.exchangeClients[signal.exchange];
    const isPaperExecution = config.trading.paperOnly || !client;

    if (!Number.isFinite(signal.price) || signal.price <= 0) {
      throw new Error(`Invalid signal price for ${signal.exchange} ${signal.symbol}`);
    }

    const liveExecutionPrice = await this.getLiveExecutionPrice(
      signal.exchange,
      signal.symbol,
      signal.price
    );
    const sizingPrice = isPaperExecution ? liveExecutionPrice : signal.price;
    const amount = Number((signal.notional / sizingPrice).toFixed(6));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid order size for ${signal.exchange} ${signal.symbol}`);
    }

    const execution = estimateExecution({
      exchange: signal.exchange,
      symbol: signal.symbol,
      side: signal.side,
      price: sizingPrice,
      amount,
      slippageRateOverride: isPaperExecution ? 0 : undefined
    });

    const order = client
      ? await client.placeSpotOrder({
          symbol: signal.symbol,
          side: signal.side,
          amount
        })
      : {
          id: `paper-${signal.exchange}-${Date.now()}`,
          exchange: signal.exchange,
          status: "closed",
          side: signal.side,
          amount,
          symbol: signal.symbol,
          paper: true
        };

    const trade = {
      id: crypto.randomUUID(),
      openedAt: new Date().toISOString(),
      exchange: signal.exchange,
      symbol: signal.symbol,
      side: signal.side,
      status: "open",
      amount,
      notional: signal.notional,
      entryPrice: execution.executedPrice,
      requestedEntryPrice: sizingPrice,
      stopLoss: signal.exitPlan.stopLoss,
      takeProfit: signal.exitPlan.takeProfit,
      orderId: order.id,
      paper: Boolean(order.paper),
      prediction: signal.prediction,
      score: signal.score,
      rankingFactors: signal.rankingFactors || null,
      sentimentScore: signal.sentiment?.compositeScore || 0,
      whaleScore: signal.whaleSignal?.score || 0,
      strategyMode: signal.strategyMode || "auto",
      strategySettings: (() => {
        const base = signal.strategySettings || {};
        if (signal.strategyMode === "auto" && signal.side !== "sell") {
          const initSl = Number(signal.exitPlan?.stopLoss || 0);
          const riskDist = Math.abs(Number(execution.executedPrice || 0) - initSl);
          return {
            ...base,
            initialStopLoss: initSl,
            initialRiskDistance: riskDist,
            breakevenApplied: false
          };
        }
        return base;
      })(),
      entryFee: execution.fee,
      entryFeeRate: execution.feeRate,
      entrySlippageRate: execution.slippageRate,
      estimatedExecution: execution
    };

    state.trades.unshift(trade);
    await saveState(state);
    await this.sendTelegramAlert(
      `📈 Trade opened\n${trade.exchange} ${trade.symbol}\nSide: ${String(trade.side || "buy").toUpperCase()}\nNotional: ${this.formatRs(trade.notional)}\nEntry: ${trade.entryPrice}\nQty: ${trade.amount}`
    );
    return trade;
  }

  async updateOpenPositions(state, scanResults) {
    const openTrades = state.trades.filter((trade) => trade.status === "open");
    let stateChanged = false;

    for (const trade of openTrades) {
      const realtimeSnapshot =
        trade.exchange === "Binance"
          ? this.binanceFuturesStream.getSnapshot(trade.symbol)
          : null;
      const latest = scanResults.find(
        (item) =>
          item.exchange === trade.exchange &&
          item.symbol === trade.symbol &&
          !item.error &&
          item.timeframes?.["1m"]
      );

      const emaSnapshot = this.runtime.lastEmaScalping?.opportunities?.find(
        (item) => item.symbol === trade.symbol
      );
      let latestPrice =
        realtimeSnapshot?.derived?.latestPrice ||
        latest?.timeframes?.["1m"]?.metrics?.latestPrice ||
        emaSnapshot?.latestPrice ||
        0;

      if (!latestPrice && trade.exchange === "MacroPaper") {
        try {
          const macroSnapshot = await fetchMacroMarketSnapshot(trade.symbol);
          latestPrice = Number(macroSnapshot.latestPrice || 0);
        } catch (error) {
          latestPrice = 0;
        }
      }

      if (!latestPrice) {
        continue;
      }

      if (trade.strategyMode === "manual") {
        const manualSettings = trade.strategySettings || state.manualSettings;
        if (manualSettings.autoExit) {
          this.applyManualProfitLock(trade, latestPrice, manualSettings);
        }
      } else if (trade.strategyMode === "ema_scalping") {
        const emaExit = this.applyEmaScalpingExitManagement(trade, latestPrice);
        stateChanged = true;
        if (emaExit.shouldExit) {
          await this.closeTrade(state, trade.id, latestPrice, emaExit.reason);
          continue;
        }
      } else {
        if (trade.strategyMode === "auto") {
          const autoCandidate = this.runtime.lastRankings?.find(
            (item) => item.exchange === trade.exchange && item.symbol === trade.symbol
          );
          if (
            config.trading.exitOnAutoTrendReversal &&
            autoCandidate?.autoSetup?.exitOnTrendReversal
          ) {
            await this.closeTrade(state, trade.id, latestPrice, "auto_trend_reversal");
            continue;
          }
          if (
            config.trading.exitOnAutoWhaleReversal &&
            autoCandidate?.autoSetup?.exitOnWhaleReversal
          ) {
            await this.closeTrade(state, trade.id, latestPrice, "auto_whale_reversal");
            continue;
          }
        }
        if (trade.side === "sell") {
          if (latestPrice < trade.entryPrice) {
            trade.stopLoss = Number(
              Math.min(trade.stopLoss, latestPrice * (1 + config.risk.trailingStopBufferPct)).toFixed(4)
            );
            stateChanged = true;
          }
        } else if (trade.strategyMode === "auto") {
          const entryPx = Number(trade.entryPrice || 0);
          const initialSl = Number(
            trade.strategySettings?.initialStopLoss ?? trade.stopLoss ?? entryPx
          );
          const r =
            Number(trade.strategySettings?.initialRiskDistance || 0) ||
            Math.abs(entryPx - initialSl);
          const favorable = latestPrice - entryPx;
          if (r > 0 && favorable >= r) {
            if (!trade.breakevenApplied) {
              trade.stopLoss = Number(Math.max(Number(trade.stopLoss || 0), entryPx).toFixed(4));
              trade.breakevenApplied = true;
              stateChanged = true;
            }
            trade.stopLoss = adjustTrailingStop(trade, latestPrice);
            stateChanged = true;
          }
        } else {
          trade.stopLoss = adjustTrailingStop(trade, latestPrice);
          stateChanged = true;
        }
      }

      if (
        (trade.side === "sell" && latestPrice >= trade.stopLoss) ||
        (trade.side !== "sell" && latestPrice <= trade.stopLoss)
      ) {
        await this.closeTrade(state, trade.id, latestPrice, "stop_loss");
      } else {
        const intelligenceExit = this.runtime.lastMarketIntelligence?.topOpportunities?.find(
          (item) => item.exchange === trade.exchange && item.symbol === trade.symbol
        );
        if (
          config.trading.exitOnMarketIntelligence &&
          trade.strategyMode !== "manual" &&
          intelligenceExit?.exitSignal
        ) {
          await this.closeTrade(state, trade.id, latestPrice, "market_intelligence_exit");
          continue;
        }
      }

      if (trade.status !== "open") {
        continue;
      } else if (
        (trade.side === "sell" && latestPrice <= trade.takeProfit) ||
        (trade.side !== "sell" && latestPrice >= trade.takeProfit)
      ) {
        if (trade.strategyMode === "ema_scalping") {
          stateChanged = true;
          await this.closeTrade(state, trade.id, latestPrice, "take_profit");
        } else if (trade.strategyMode === "manual" && Number(trade.strategySettings?.profitLockPercent || 0) > 0) {
          this.applyManualProfitLock(trade, latestPrice, trade.strategySettings);
        } else {
          await this.closeTrade(state, trade.id, latestPrice, "take_profit");
        }
      }
    }

    if (stateChanged) {
      await saveState(state);
    }
  }

  async closeTrade(state, tradeId, exitPrice, reason) {
    const trade = state.trades.find((item) => item.id === tradeId);
    if (!trade || trade.status !== "open") {
      return null;
    }

    const client = this.exchangeClients[trade.exchange];
    const isPaperExecution = config.trading.paperOnly || !client;
    const liveExitPrice = await this.getLiveExecutionPrice(
      trade.exchange,
      trade.symbol,
      exitPrice
    );
    const exitExecution = estimateExecution({
      exchange: trade.exchange,
      symbol: trade.symbol,
      side: trade.side === "sell" ? "buy" : "sell",
      price: isPaperExecution ? liveExitPrice : exitPrice,
      amount: trade.amount,
      slippageRateOverride: isPaperExecution ? 0 : undefined
    });
    if (client) {
      await client.placeSpotOrder({
        symbol: trade.symbol,
        side: trade.side === "sell" ? "buy" : "sell",
        amount: trade.amount
      });
    }

    trade.status = "closed";
    trade.closedAt = new Date().toISOString();
    trade.exitPrice = exitExecution.executedPrice;
    trade.requestedExitPrice = isPaperExecution ? liveExitPrice : exitPrice;
    trade.exitReason = reason;
    trade.exitFee = exitExecution.fee;
    trade.exitFeeRate = exitExecution.feeRate;
    trade.exitSlippageRate = exitExecution.slippageRate;
    const grossEntry = Number(trade.entryPrice || 0) * Number(trade.amount || 0);
    const grossExit = Number(trade.exitPrice || 0) * Number(trade.amount || 0);
    const totalFees = Number(trade.entryFee || 0) + Number(trade.exitFee || 0);
    trade.pnl = Number(
      (
        (trade.side === "sell" ? grossEntry - grossExit : grossExit - grossEntry) - totalFees
      ).toFixed(2)
    );
    trade.pnlPct = Number(((trade.pnl / trade.notional) * 100).toFixed(2));

    state.status.dailyRealizedPnlToday = Number(
      (Number(state.status.dailyRealizedPnlToday || 0) + trade.pnl).toFixed(2)
    );

    const closedTrades = state.trades.filter((item) => item.status === "closed");
    const wins = closedTrades.filter((item) => (item.pnl || 0) > 0).length;
    state.metrics.realizedPnl = Number(
      closedTrades.reduce((sum, item) => sum + (item.pnl || 0), 0).toFixed(2)
    );
    state.metrics.winRate = closedTrades.length
      ? Number(((wins / closedTrades.length) * 100).toFixed(2))
      : 0;
    state.metrics.accuracy = state.metrics.winRate;

    applyCapitalGrowthAfterClose(state, trade);
    const learningUpdate = recordTradeOutcome(state, trade);

    await saveState(state);
    await this.sendTelegramAlert(
      this.formatTradeClosedTelegramMessage(trade, reason, state.metrics.realizedPnl)
    );
    if (learningUpdate.pauseTriggered) {
      await this.sendTelegramAlert(state.learning.pauseReason);
    }
    return trade;
  }

  async runPythonPrediction(candidate, sentiment, whaleSignals, learningContext = {}) {
    const payload = {
      trend15m: candidate.timeframes["15m"]?.metrics.trend || 0,
      momentum5m: candidate.timeframes["5m"]?.metrics.recentMomentum || 0,
      momentum1m: candidate.timeframes["1m"]?.metrics.recentMomentum || 0,
      sentiment: sentiment.compositeScore || 0,
      whaleScore:
        whaleSignals.find(
          (item) =>
            item.exchange === candidate.exchange && item.symbol === candidate.symbol
        )?.score || 0,
      learningSamples: learningContext.learningSamples || []
    };

    return new Promise((resolve) => {
      const child = spawn(config.app.pythonBin, ["ai/predict.py", JSON.stringify(payload)], {
        cwd: __dirname,
        windowsHide: true
      });

      let stdout = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.on("close", () => {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          resolve({
            direction: "hold",
            probabilityUp: 0.5,
            confidence: 0,
            expectedMovePct: 0
          });
        }
      });

      child.on("error", () => {
        resolve({
          direction: "hold",
          probabilityUp: 0.5,
          confidence: 0,
          expectedMovePct: 0
        });
      });
    });
  }

  getEntryPrice(candidate) {
    return (
      candidate.liveData?.binance?.markPrice ||
      candidate.timeframes["5m"]?.metrics.latestPrice ||
      candidate.timeframes["1m"]?.metrics.latestPrice ||
      candidate.ticker?.last ||
      0
    );
  }

  buildAutoTradePlan(
    candidate,
    trades,
    autoSettings,
    entryPrice,
    confidence,
    capitalBase,
    dynamicRiskPct = null
  ) {
    const safeMaxPercent = 100;
    const statePercent = Number(autoSettings?.capitalPercent || 0);
    const configuredPercent = config.capital.effectiveTradeSizePct * 100;
    const capitalPercent = Math.max(
      1,
      Math.min(
        safeMaxPercent,
        Number.isFinite(statePercent) && statePercent > 0
          ? statePercent
          : Number.isFinite(configuredPercent) && configuredPercent > 0
            ? configuredPercent
            : config.capital.effectiveTradeSizePct * 100
      )
    );
    const allocationBias = calculateAllocationBias(candidate.symbol, trades);
    const tradeSizePct = Math.min(
      (capitalPercent / 100) * allocationBias,
      capitalPercent / 100
    );
    const autoSetup = candidate.autoSetup || null;
    if (autoSetup?.decision === "BUY" && autoSetup.stopLoss > 0 && autoSetup.takeProfit > 0) {
      const baselineRisk = Number(config.strategies.autoAi.riskPctMin || 0.015);
      const riskPct =
        dynamicRiskPct != null &&
        Number.isFinite(Number(dynamicRiskPct)) &&
        Number(dynamicRiskPct) > 0
          ? Number(dynamicRiskPct)
          : baselineRisk;
      const capitalUsed = capitalBase * tradeSizePct;
      const stopDistancePct = Math.abs(entryPrice - autoSetup.stopLoss) / Math.max(entryPrice, 0.0000001);
      const targetRiskAmount = capitalBase * riskPct;
      const riskSizedNotional = stopDistancePct > 0 ? targetRiskAmount / stopDistancePct : capitalUsed;
      const notional = Number(Math.min(capitalUsed, riskSizedNotional).toFixed(2));

      return {
        notional,
        exitPlan: {
          stopLoss: Number(autoSetup.stopLoss.toFixed(4)),
          takeProfit: Number(autoSetup.takeProfit.toFixed(4))
        },
        strategyMode: "auto",
        strategySettings: {
          capitalPercent,
          capitalUsed: Number(capitalUsed.toFixed(2)),
          riskPct: Number((riskPct * 100).toFixed(2)),
          targetRiskAmount: Number((Math.min(targetRiskAmount, notional * stopDistancePct)).toFixed(2)),
          riskReward: Number(autoSetup.riskReward || config.strategies.autoAi.minimumRrr),
          entryModel: "smart_money_trend",
          trendDirection: autoSetup.trend.direction,
          liquiditySweep: autoSetup.liquiditySweep.direction,
          structureBreak: autoSetup.structureBreak.direction,
          whaleConfirmation: autoSetup.whaleConfirmation.whaleBuying,
          volumeSpikeRatio: autoSetup.volumeSpike.ratio,
          stopDistancePct: Number((stopDistancePct * 100).toFixed(3))
        }
      };
    }

    return {
      notional: Number((capitalBase * tradeSizePct).toFixed(2)),
      exitPlan: buildExitPlan(entryPrice, confidence),
      strategyMode: "auto",
      strategySettings: {
        capitalPercent
      }
    };
  }

  buildUltraTradePlan(entryPrice, ultraSettings, confidence, capitalBase) {
    const capitalPercent = Math.max(
      1,
      Math.min(100, Number(ultraSettings?.capitalPercent || config.strategies.ultraAi.capitalPercent || 100))
    );
    const confidenceThreshold = Number(
      ultraSettings?.confidenceThreshold || config.strategies.ultraAi.confidenceThreshold || 0.75
    );

    return {
      notional: Number((capitalBase * (capitalPercent / 100)).toFixed(2)),
      exitPlan: buildExitPlan(entryPrice, Math.max(confidence, confidenceThreshold)),
      strategyMode: "ultra_ai",
      strategySettings: {
        capitalPercent,
        customMaxTradesPerDay: Number(config.strategies.ultraAi.customMaxTradesPerDay),
        confidenceThreshold,
        executionMode: ultraSettings?.executionMode || config.strategies.ultraAi.executionMode,
        paperFirst:
          ultraSettings?.paperFirst === undefined
            ? config.strategies.ultraAi.paperFirst
            : Boolean(ultraSettings.paperFirst),
        autoApproval: true
      }
    };
  }

  buildManualTradePlan(entryPrice, manualSettings, capitalBase) {
    const safeMaxPercent = config.capital.safeTradeSizePct * 100;
    const capitalPercent = Math.max(
      1,
      Math.min(safeMaxPercent, Number(manualSettings.capitalPercent || safeMaxPercent))
    );

    return {
      notional: Number((capitalBase * (capitalPercent / 100)).toFixed(2)),
      exitPlan: buildManualExitPlan(entryPrice, manualSettings),
      strategyMode: "manual",
      strategySettings: {
        capitalPercent,
        takeProfitPercent: Number(
          manualSettings.takeProfitPercent ||
            ((config.risk.takeProfitPctMin + config.risk.takeProfitPctMax) / 2) * 100
        ),
        stopLossPercent: Number(manualSettings.stopLossPercent || 2),
        autoExit: Boolean(manualSettings.autoExit),
        profitLockPercent: Number(manualSettings.profitLockPercent || 0)
      }
    };
  }

  buildEmaScalpingTradePlan(opportunity, settings, capitalBase) {
    const riskPct =
      opportunity.confidenceScore >= 0.85 ? settings.maxRiskPct : settings.minRiskPct;
    const capitalPercent = Math.max(
      1,
      Math.min(100, Number(settings.capitalPercent || config.strategies.emaScalping.capitalPercent || 100))
    );
    const riskAmount = capitalBase * riskPct;

    const capitalUsed = Number((capitalBase * (capitalPercent / 100)).toFixed(2));
    const entryPrice = Number(opportunity.setup.riskPlan.entryPrice || 0);
    if (!entryPrice) {
      throw new Error(`Invalid entry price for ${opportunity.symbol}`);
    }

    const usePctTp =
      settings.usePercentTakeProfit !== undefined
        ? Boolean(settings.usePercentTakeProfit)
        : Boolean(config.strategies.emaScalping.usePercentTakeProfit);
    const entryForTp = entryPrice;
    const confidenceScale = Math.min(1, Math.max(0, Number(opportunity.confidenceScore || 0)));
    let takeProfit;
    let takeProfitPips = null;
    if (usePctTp) {
      const minTp = Number(config.risk.takeProfitPctMin ?? 0.45);
      const maxTp = Number(config.risk.takeProfitPctMax ?? 0.5);
      const span = Math.max(0, maxTp - minTp);
      const tpPct = minTp + confidenceScale * span;
      takeProfit =
        opportunity.setup.direction === "sell"
          ? Number((entryForTp * (1 - tpPct)).toFixed(5))
          : Number((entryForTp * (1 + tpPct)).toFixed(5));
    } else {
      const minTpPips = Number(settings.takeProfitPipsMin || config.strategies.emaScalping.takeProfitPipsMin || 100);
      const maxTpPips = Number(settings.takeProfitPipsMax || config.strategies.emaScalping.takeProfitPipsMax || 150);
      const targetPips = minTpPips + confidenceScale * (maxTpPips - minTpPips);
      const pipSize = getEmaPipSize(opportunity.symbol);
      const pipTargetDistance = targetPips * pipSize;
      takeProfitPips = Number(targetPips.toFixed(2));
      takeProfit =
        opportunity.setup.direction === "sell"
          ? Number((entryForTp - pipTargetDistance).toFixed(5))
          : Number((entryForTp + pipTargetDistance).toFixed(5));
    }

    const maxAdv = Number(
      settings.maxAdverseStopPct ?? config.strategies.emaScalping.maxAdverseStopPct ?? 0.18
    );
    const structuralSl = Number(opportunity.setup.riskPlan.stopLoss);
    let stopLoss = structuralSl;
    if (opportunity.setup.direction === "sell") {
      const wideSl = entryForTp * (1 + maxAdv);
      stopLoss = Number(Math.max(structuralSl, wideSl).toFixed(5));
    } else {
      const wideSl = entryForTp * (1 - maxAdv);
      stopLoss = Number(Math.min(structuralSl, wideSl).toFixed(5));
    }

    const stopDistance = Math.abs(entryForTp - stopLoss);
    if (!stopDistance) {
      throw new Error(`Invalid stop distance for ${opportunity.symbol}`);
    }
    const riskSizedAmount = riskAmount / stopDistance;
    const maxAffordableAmount = capitalUsed / entryPrice;
    const amount = Number(Math.min(riskSizedAmount, maxAffordableAmount).toFixed(4));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid EMA amount for ${opportunity.symbol}`);
    }
    const notional = Number((amount * entryPrice).toFixed(2));
    const effectiveRiskAmount = Number((amount * stopDistance).toFixed(2));
    const effectiveRiskPct = Number(((effectiveRiskAmount / capitalBase) * 100).toFixed(2));

    return {
      notional,
      exitPlan: {
        stopLoss,
        takeProfit
      },
      amount,
      strategyMode: "ema_scalping",
      strategySettings: {
        capitalPercent,
        capitalUsed,
        allocatedCapitalPercent: Number(((capitalUsed / capitalBase) * 100).toFixed(2)),
        customMaxTradesPerDay: settings.customMaxTradesPerDay,
        minRiskPct: settings.minRiskPct,
        maxRiskPct: settings.maxRiskPct,
        riskPct: effectiveRiskPct,
        targetRiskAmount: effectiveRiskAmount,
        stopDistance: Number(stopDistance.toFixed(5)),
        initialStopLoss: Number(stopLoss.toFixed(5)),
        minRrr: settings.minRrr,
        confidenceThreshold: settings.confidenceThreshold,
        takeProfitPips,
        confidenceScore: opportunity.confidenceScore,
        trendDirection: opportunity.trendDirection,
        emaAngle: opportunity.setup?.emaAngle || 0,
        adx: opportunity.setup?.adx || 0,
        source: opportunity.source,
        paperFirst: true
      }
    };
  }

  applyEmaScalpingExitManagement(trade, latestPrice) {
    const emaCfg = config.strategies.emaScalping;
    if (!emaCfg.aggressiveExitManagement) {
      return { shouldExit: false };
    }
    const stopDistance = Number(
      trade.strategySettings?.stopDistance || Math.abs(Number(trade.entryPrice || 0) - Number(trade.stopLoss || 0))
    );
    if (!stopDistance) {
      return {
        shouldExit: false
      };
    }

    const side = trade.side === "sell" ? "sell" : "buy";
    const favorableMove =
      side === "sell"
        ? Number(trade.entryPrice || 0) - latestPrice
        : latestPrice - Number(trade.entryPrice || 0);
    let nextStop = Number(trade.stopLoss || 0);

    if (favorableMove >= stopDistance * 4) {
      nextStop =
        side === "sell"
          ? Math.min(nextStop, latestPrice + stopDistance * 0.5)
          : Math.max(nextStop, latestPrice - stopDistance * 0.5);
    } else if (favorableMove >= stopDistance * 3) {
      nextStop =
        side === "sell"
          ? Math.min(nextStop, latestPrice + stopDistance)
          : Math.max(nextStop, latestPrice - stopDistance);
    } else if (favorableMove >= stopDistance * 2) {
      nextStop =
        side === "sell"
          ? Math.min(nextStop, Number(trade.entryPrice || 0) - stopDistance)
          : Math.max(nextStop, Number(trade.entryPrice || 0) + stopDistance);
    } else if (favorableMove >= stopDistance) {
      nextStop =
        side === "sell"
          ? Math.min(nextStop, Number(trade.entryPrice || 0))
          : Math.max(nextStop, Number(trade.entryPrice || 0));
    }

    trade.stopLoss = Number(nextStop.toFixed(5));

    return {
      shouldExit: favorableMove >= stopDistance * 5,
      reason: "ema_5r_exit"
    };
  }

  async maybeQueueEmaScalpingSignal(state) {
    const strategySnapshot = this.runtime.lastEmaScalping || (await runEmaScalpingStrategy());
    this.runtime.lastEmaScalping = strategySnapshot;

    const capitalBaseEma = this.equityBaseForLimits(state);
    const maxDailyLossEma =
      capitalBaseEma * Number(config.strategies.multiLayerFilter.maxDailyLossPct || 0.05);
    if (Number(state.status.dailyRealizedPnlToday || 0) <= -maxDailyLossEma) {
      return;
    }

    if (state.status.dailyTrades >= this.getDailyTradeLimit(state)) {
      return;
    }

    const maxPerScan = Math.max(1, Number(config.analysis.maxSignalsPerScan || 8));
    const excludedSymbols = new Set();

    for (let n = 0; n < maxPerScan; n += 1) {
      const latestState = await loadState();
      const growthCtx = getCapitalGrowthContext(latestState);
      if (growthCtx.tradingPausedByCapitalGrowth) {
        break;
      }
      const modeState = { ...latestState, strategyMode: "ema_scalping" };
      if (latestState.status.dailyTrades >= this.getDailyTradeLimit(modeState)) {
        break;
      }

      const topCandidate = strategySnapshot.opportunities?.find(
        (item) =>
          item.tradeDecision !== "WAIT" &&
          !item.newsBlocked &&
          !excludedSymbols.has(item.symbol)
      );
      if (!topCandidate) {
        break;
      }

      const duplicatePending = latestState.pendingApprovals.some(
        (approval) =>
          approval.status === "pending" &&
          approval.signal.symbol === topCandidate.symbol &&
          approval.signal.strategyMode === "ema_scalping"
      );
      const existingOpenTrade = latestState.trades.some(
        (trade) => trade.status === "open" && trade.symbol === topCandidate.symbol
      );
      if (duplicatePending || existingOpenTrade) {
        excludedSymbols.add(topCandidate.symbol);
        continue;
      }

      const capitalBase = growthCtx.effectiveCapital;
      const baseEma = {
        ...config.strategies.emaScalping,
        ...(latestState.emaScalpingSettings || {})
      };
      let emaSettings = { ...baseEma };
      if (
        config.capitalGrowth.enabled &&
        latestState.capitalGrowth?.enabled &&
        growthCtx.enabled
      ) {
        const m = growthCtx.emaRiskMultiplier;
        if (Number.isFinite(m) && m > 0 && m !== 1) {
          emaSettings = {
            ...emaSettings,
            minRiskPct: Number((Number(emaSettings.minRiskPct || 0) * m).toFixed(6)),
            maxRiskPct: Number((Number(emaSettings.maxRiskPct || 0) * m).toFixed(6))
          };
        }
      }
      const tradePlan = this.buildEmaScalpingTradePlan(topCandidate, emaSettings, capitalBase);
      const amount = tradePlan.amount;
      const estimatedExecution = estimateExecution({
        exchange: "MacroPaper",
        symbol: topCandidate.symbol,
        side: topCandidate.tradeDecision.toLowerCase() === "sell" ? "sell" : "buy",
        price: topCandidate.setup.riskPlan.entryPrice,
        amount
      });

      const signal = {
        exchange: "MacroPaper",
        symbol: topCandidate.symbol,
        price: topCandidate.setup.riskPlan.entryPrice,
        notional: tradePlan.notional,
        side: topCandidate.tradeDecision.toLowerCase() === "sell" ? "sell" : "buy",
        prediction: {
          direction: topCandidate.tradeDecision.toLowerCase(),
          probabilityUp:
            topCandidate.tradeDecision === "BUY"
              ? topCandidate.confidenceScore
              : 1 - topCandidate.confidenceScore,
          confidence: topCandidate.confidenceScore,
          expectedMovePct: Number(
            (
              (Math.abs(
                topCandidate.setup.riskPlan.takeProfit - topCandidate.setup.riskPlan.entryPrice
              ) /
                topCandidate.setup.riskPlan.entryPrice) *
              100
            ).toFixed(2)
          )
        },
        exitPlan: tradePlan.exitPlan,
        score: topCandidate.confidenceScore,
        rankingFactors: {
          adx: topCandidate.setup.adx,
          emaAngle: topCandidate.setup.emaAngle,
          trendDirection: topCandidate.trendDirection,
          rrr: topCandidate.setup.riskPlan.rrr
        },
        confidenceScore: topCandidate.confidenceScore,
        tradeQuality: topCandidate.tradeQuality,
        intelligenceReasons: [
          `Trend ${topCandidate.trendDirection}`,
          `ADX ${Number(topCandidate.setup.adx || 0).toFixed(2)}`,
          `EMA angle ${Number(topCandidate.setup.emaAngle || 0).toFixed(2)}`,
          topCandidate.newsReason || "News clear"
        ],
        sentiment: {
          compositeScore: topCandidate.confidenceScore
        },
        whaleSignal: null,
        estimatedExecution,
        strategyMode: "ema_scalping",
        strategySettings: tradePlan.strategySettings,
        createdBy: "ema-scalping-engine"
      };

      const approval = await requestApproval(signal);
      await approveTrade(approval.id, "Auto-approved in EMA scalping mode");
      await this.executeApprovedTrades();
      await this.sendTelegramAlert(
        `⚡ EMA scalping auto-approved\n${signal.symbol} ${String(signal.side || "buy").toUpperCase()} @ ${signal.price}\nNotional: ${this.formatRs(signal.notional)}`
      );

      excludedSymbols.add(topCandidate.symbol);
    }
  }

  applyManualProfitLock(trade, latestPrice, manualSettings) {
    const profitLockPercent = Number(manualSettings?.profitLockPercent || 0);
    if (profitLockPercent <= 0) {
      return;
    }

    const activationPrice =
      trade.entryPrice * (1 + Number(manualSettings?.takeProfitPercent || 0) / 100);
    if (latestPrice < activationPrice) {
      return;
    }

    const lockedStop = trade.entryPrice * (1 + profitLockPercent / 100);
    trade.stopLoss = Number(Math.max(trade.stopLoss, lockedStop).toFixed(4));
  }

  async runBacktest() {
    const candlesBySymbol = {};

    for (const client of Object.values(this.exchangeClients)) {
      for (const symbol of defaultSymbols.slice(0, 4)) {
        try {
          candlesBySymbol[`${client.label}:${symbol}`] = await client.fetchOHLCV(
            symbol,
            "15m",
            120
          );
        } catch (error) {
          continue;
        }
      }
    }

    const result = runBacktest(candlesBySymbol);
    this.runtime.lastBacktest = result;

    const state = await loadState();
    state.metrics.winRate = result.winRate;
    state.metrics.accuracy = result.accuracy;
    await saveState(state);

    return result;
  }

  async refreshMarketIntelligence(
    sentimentSnapshot = null,
    whaleSignals = null
  ) {
    if (this.isRefreshingIntelligence && this.runtime.lastMarketIntelligence) {
      return this.runtime.lastMarketIntelligence;
    }

    this.isRefreshingIntelligence = true;
    try {
    const sentiment = sentimentSnapshot || (this.runtime.lastSentiment ?? (await buildSentimentSnapshot()));
    const whales = whaleSignals || this.runtime.lastWhaleSignals || [];
    const intelligence = await runGlobalMarketIntelligence({
      exchangeClients: this.exchangeClients,
      sentimentSnapshot: sentiment,
      whaleSignals: whales
    });
    this.runtime.lastMarketIntelligence = intelligence;
    return intelligence;
    } finally {
      this.isRefreshingIntelligence = false;
    }
  }

  async approve(id, notes = "") {
    const approval = await approveTrade(id, notes);
    await this.executeApprovedTrades();
    return approval;
  }

  async reject(id, reason = "") {
    return rejectTrade(id, reason);
  }

  async updateManualControls(payload = {}) {
    const parseSettingNumber = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const safeMaxPercent = 100;

    const autoSettings = payload.autoSettings
      ? {
          capitalPercent: Math.max(
            1,
            Math.min(
              safeMaxPercent,
              parseSettingNumber(
                payload.autoSettings.capitalPercent,
                config.capital.effectiveTradeSizePct * 100
              )
            )
          )
        }
      : undefined;

    const manualSettings = payload.manualSettings
      ? {
          capitalPercent: Math.max(
            1,
            Math.min(
              safeMaxPercent,
              parseSettingNumber(
                payload.manualSettings.capitalPercent,
                config.manual.settings.capitalPercent
              )
            )
          ),
          takeProfitPercent: Math.max(
            0.1,
            parseSettingNumber(
              payload.manualSettings.takeProfitPercent,
              config.manual.settings.takeProfitPercent
            )
          ),
          stopLossPercent: Math.max(
            0.1,
            parseSettingNumber(
              payload.manualSettings.stopLossPercent,
              config.manual.settings.stopLossPercent
            )
          ),
          autoExit:
            payload.manualSettings.autoExit === undefined
              ? config.manual.settings.autoExit
              : Boolean(payload.manualSettings.autoExit),
          profitLockPercent: Math.max(
            0,
            parseSettingNumber(
              payload.manualSettings.profitLockPercent,
              config.manual.settings.profitLockPercent
            )
          )
        }
      : undefined;

    const emaScalpingSettings = payload.emaScalpingSettings
      ? {
          capitalPercent: Math.max(
            1,
            Math.min(
              100,
              parseSettingNumber(
                payload.emaScalpingSettings.capitalPercent,
                config.strategies.emaScalping.capitalPercent
              )
            )
          ),
          customMaxTradesPerDay: Math.max(
            1,
            parseSettingNumber(
              payload.emaScalpingSettings.customMaxTradesPerDay,
              config.strategies.emaScalping.customMaxTradesPerDay
            )
          ),
          minRiskPct: Math.max(
            config.strategies.emaScalping.minRiskPct,
            Math.min(
              config.strategies.emaScalping.maxRiskPct,
              parseSettingNumber(
                payload.emaScalpingSettings.minRiskPct,
                config.strategies.emaScalping.minRiskPct
              )
            )
          ),
          maxRiskPct: Math.max(
            config.strategies.emaScalping.minRiskPct,
            Math.min(
              config.strategies.emaScalping.maxRiskPct,
              parseSettingNumber(
                payload.emaScalpingSettings.maxRiskPct,
                config.strategies.emaScalping.maxRiskPct
              )
            )
          ),
          minRrr: Math.max(
            2,
            parseSettingNumber(
              payload.emaScalpingSettings.minRrr,
              config.strategies.emaScalping.minRrr
            )
          ),
          confidenceThreshold: Math.max(
            0.6,
            Math.min(
              0.95,
              parseSettingNumber(
                payload.emaScalpingSettings.confidenceThreshold,
                config.strategies.emaScalping.confidenceThreshold
              )
            )
          )
        }
      : undefined;

    const ultraAiSettings = payload.ultraAiSettings
      ? {
          capitalPercent: Math.max(
            1,
            Math.min(
              100,
              parseSettingNumber(
                payload.ultraAiSettings.capitalPercent,
                config.strategies.ultraAi.capitalPercent
              )
            )
          ),
          customMaxTradesPerDay: Math.max(
            1,
            parseSettingNumber(
              payload.ultraAiSettings.customMaxTradesPerDay,
              config.strategies.ultraAi.customMaxTradesPerDay
            )
          ),
          confidenceThreshold: Math.max(
            0.6,
            Math.min(
              0.99,
              parseSettingNumber(
                payload.ultraAiSettings.confidenceThreshold,
                config.strategies.ultraAi.confidenceThreshold
              )
            )
          ),
          executionMode:
            payload.ultraAiSettings.executionMode === "live_futures" ? "live_futures" : "paper",
          paperFirst:
            payload.ultraAiSettings.paperFirst === undefined
              ? config.strategies.ultraAi.paperFirst
              : Boolean(payload.ultraAiSettings.paperFirst)
        }
      : undefined;

    return updateManualControls({
      autoSettings,
      strategyMode: payload.strategyMode || undefined,
      manualMode:
        payload.manualMode === undefined ? undefined : Boolean(payload.manualMode),
      manualTradingActive:
        payload.manualTradingActive === undefined
          ? undefined
          : Boolean(payload.manualTradingActive),
      manualSettings,
      emaScalpingSettings,
      ultraAiSettings
    });
  }

  async startManualTrading() {
    return updateManualControls({
      manualMode: true,
      manualTradingActive: true
    });
  }

  async stopManualTrading() {
    return updateManualControls({
      manualTradingActive: false
    });
  }

  async getMarketChart({ exchange, symbol, timeframe = "5m", limit = 120 }) {
    if (exchange === "MacroPaper") {
      const snapshot = await fetchMacroMarketSnapshot(symbol);
      const candles = (snapshot.timeframes[timeframe] || []).slice(-Math.max(20, Math.min(240, Number(limit) || 120)));
      return {
        exchange,
        symbol,
        timeframe,
        limit: candles.length,
        source: snapshot.source,
        fetchedAt: new Date().toISOString(),
        latestPrice: Number(snapshot.latestPrice || 0),
        candles: candles.map((item) => ({
          timestamp: Number(item[0]),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5])
        }))
      };
    }

    const client = this.exchangeClients[exchange];
    if (!client) {
      throw new Error(`Unsupported exchange: ${exchange}`);
    }

    if (!symbol) {
      throw new Error("Symbol is required.");
    }

    const supportedTimeframes = new Set(config.analysis.timeframes);
    if (!supportedTimeframes.has(timeframe)) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    const cappedLimit = Math.max(20, Math.min(240, Number(limit) || 120));
    const [candles, ticker] = await Promise.all([
      client.fetchOHLCV(symbol, timeframe, cappedLimit),
      client.fetchTicker(symbol)
    ]);

    return {
      exchange,
      symbol,
      timeframe,
      limit: cappedLimit,
      source:
        exchange === "Binance"
          ? "Binance public spot OHLCV via ccxt"
          : "CoinDCX public candles API",
      fetchedAt: new Date().toISOString(),
      latestPrice: Number(ticker?.last || 0),
      candles: candles.map((item) => ({
        timestamp: Number(item[0]),
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5])
      }))
    };
  }

  async getPerformanceLog({ date, format = "json" } = {}) {
    const state = await loadState();
    const selectedDate = date || new Date().toISOString().slice(0, 10);
    const trades = state.trades.filter((trade) => {
      const tradeDate = (trade.closedAt || trade.openedAt || "").slice(0, 10);
      return tradeDate === selectedDate;
    });

    const summary = {
      date: selectedDate,
      paperOnly: config.trading.paperOnly,
      trades: trades.length,
      closedTrades: trades.filter((trade) => trade.status === "closed").length,
      openTrades: trades.filter((trade) => trade.status === "open").length,
      realizedPnl: Number(
        trades
          .filter((trade) => trade.status === "closed")
          .reduce((sum, trade) => sum + Number(trade.pnl || 0), 0)
          .toFixed(2)
      ),
      winRate:
        trades.filter((trade) => trade.status === "closed").length > 0
          ? Number(
              (
                (trades.filter((trade) => trade.status === "closed" && Number(trade.pnl || 0) > 0)
                  .length /
                  trades.filter((trade) => trade.status === "closed").length) *
                100
              ).toFixed(2)
            )
          : 0
    };

    if (format === "csv") {
      const lines = [
        "date,openedAt,closedAt,exchange,symbol,status,strategyMode,entryPrice,exitPrice,pnl,pnlPct,exitReason,paper"
      ];
      for (const trade of trades) {
        lines.push(
          [
            selectedDate,
            trade.openedAt || "",
            trade.closedAt || "",
            trade.exchange || "",
            trade.symbol || "",
            trade.status || "",
            trade.strategyMode || "",
            trade.entryPrice || "",
            trade.exitPrice || "",
            trade.pnl || 0,
            trade.pnlPct || 0,
            trade.exitReason || "",
            trade.paper ? "true" : "false"
          ]
            .map((value) => `"${String(value).replace(/"/g, '""')}"`)
            .join(",")
        );
      }

      return {
        filename: `performance-log-${selectedDate}.csv`,
        contentType: "text/csv; charset=utf-8",
        body: `${lines.join("\n")}\n`
      };
    }

    return {
      filename: `performance-log-${selectedDate}.json`,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(
        {
          summary,
          learning: state.learning,
          trades
        },
        null,
        2
      )
    };
  }

  async getDashboardState() {
    const state = await loadState();
    refreshLearningState(state);
    await saveState(state);
    const trades = await Promise.all(
      state.trades.map(async (trade) => {
        if (trade.status !== "open") {
          return trade;
        }

        const livePrice = await this.getLiveExecutionPrice(
          trade.exchange,
          trade.symbol,
          Number(trade.entryPrice || 0)
        );
        const amount = Number(trade.amount || 0);
        const grossEntry = Number(trade.entryPrice || 0) * amount;
        const grossLive = Number(livePrice || 0) * amount;
        const estimatedExit = estimateExecution({
          exchange: trade.exchange,
          symbol: trade.symbol,
          side: trade.side === "sell" ? "buy" : "sell",
          price: livePrice,
          amount,
          slippageRateOverride: trade.paper ? 0 : undefined
        });
        const totalFees = Number(trade.entryFee || 0) + Number(estimatedExit.fee || 0);
        const livePnl = Number(
          (
            (trade.side === "sell" ? grossEntry - grossLive : grossLive - grossEntry) - totalFees
          ).toFixed(2)
        );

        return {
          ...trade,
          livePrice: Number(livePrice || 0),
          livePnl,
          livePnlPct: trade.notional
            ? Number(((livePnl / Number(trade.notional || 1)) * 100).toFixed(2))
            : 0
        };
      })
    );
    const openTrades = trades.filter((trade) => trade.status === "open");
    const unrealizedPnl = Number(
      openTrades.reduce((sum, trade) => sum + Number(trade.livePnl || 0), 0).toFixed(2)
    );
    const livePnlSummary = {
      openTrades: openTrades.length,
      unrealizedPnl,
      totalPnl: Number((Number(state.metrics.realizedPnl || 0) + unrealizedPnl).toFixed(2))
    };
    const modePerformance = buildModePerformanceSummary(trades);

    const capitalGrowthPreview = {
      ...getCapitalGrowthContext(state),
      growthHistory: (state.capitalGrowth?.growthHistory || []).slice(0, 80),
      cumulativeReinvested: state.capitalGrowth?.cumulativeReinvested ?? 0,
      pausedUntil: state.capitalGrowth?.pausedUntil ?? null,
      lastUpdatedAt: state.capitalGrowth?.lastUpdatedAt ?? null
    };

    return {
      config: {
        trading: config.trading,
        learning: config.learning,
        marketIntelligence: config.marketIntelligence,
        capital: config.capital,
        capitalGrowth: config.capitalGrowth,
        risk: config.risk,
        allocation: config.allocation,
        safety: config.safety,
        execution: config.execution,
        auth: config.auth,
        manual: config.manual,
        strategies: config.strategies
      },
      capitalGrowthPreview,
      portfolio: buildPortfolioPlan(trades),
      livePnlSummary,
      modePerformance,
      runtime: {
        ...this.runtime,
        binanceRealtime: this.binanceFuturesStream.getStatus()
      },
      ...state,
      trades
    };
  }

  getRealtimeSymbols(ranked = []) {
    const defaultBinanceSymbols = defaultSymbols;
    const rankedBinanceSymbols = ranked
      .filter((item) => item.exchange === "Binance")
      .slice(0, 5)
      .map((item) => item.symbol);
    return [...new Set([...defaultBinanceSymbols, ...rankedBinanceSymbols])];
  }

  getEnabledModes(state) {
    return getEnabledModes(
      normalizeModeControls(state?.modeControls || {}, state?.strategyMode || "auto")
    );
  }

  async updateModeControls(updates = {}) {
    const state = await loadState();
    const normalized = normalizeModeControls(
      {
        ...(state.modeControls || {}),
        ...updates,
        modes: {
          ...(state.modeControls?.modes || {}),
          ...(updates.modes || {})
        }
      },
      updates.primaryMode || state.strategyMode || "auto",
      { allowEmpty: true }
    );
    await updateManualControls({
      modeControls: normalized,
      strategyMode: normalized.primaryMode
    });
    const enabledModes = getEnabledModes(normalized);
    if (enabledModes.length && !this.timer) {
      return this.start();
    }
    if (!enabledModes.length && this.timer) {
      return this.stop();
    }
    return this.getDashboardState();
  }

  async startAllModes() {
    const state = await loadState();
    const nextControls = startModes(state.modeControls, MODE_KEYS, {
      exclusive: true,
      primaryMode: state.modeControls?.primaryMode || state.strategyMode || "auto"
    });
    return this.updateModeControls(nextControls);
  }

  async stopAllModes() {
    const state = await loadState();
    const nextControls = stopModes(state.modeControls, MODE_KEYS);
    return this.updateModeControls(nextControls);
  }

  async startMode(mode) {
    const state = await loadState();
    const nextControls = startModes(state.modeControls, [mode], {
      exclusive: false,
      primaryMode: mode
    });
    return this.updateModeControls(nextControls);
  }

  async stopMode(mode) {
    const state = await loadState();
    const nextControls = stopModes(state.modeControls, [mode]);
    return this.updateModeControls(nextControls);
  }

  async startSelectedModes(modes = []) {
    const state = await loadState();
    const selectedModes = modes.filter((mode) => MODE_KEYS.includes(mode));
    const primaryMode = selectedModes[0] || state.modeControls?.primaryMode || "auto";
    const nextControls = startModes(
      setSelectedModes(state.modeControls, selectedModes),
      selectedModes,
      {
        exclusive: true,
        primaryMode
      }
    );
    return this.updateModeControls(nextControls);
  }

  async manualExitTrade(tradeId) {
    const state = await loadState();
    const trade = state.trades.find(
      (item) => String(item.id) === String(tradeId) && item.status === "open"
    );
    if (!trade) {
      return { ok: false, error: "Trade not found or already closed." };
    }
    const exitPx = await this.getLiveExecutionPrice(
      trade.exchange,
      trade.symbol,
      Number(trade.entryPrice || 0)
    );
    await this.closeTrade(state, trade.id, exitPx, "manual_dashboard_exit");
    return { ok: true, tradeId };
  }

  getDailyTradeLimit(state) {
    const strategyMode = state.strategyMode || (state.manualMode ? "manual" : "auto");
    if (strategyMode === "ema_scalping") {
      return Number(
        state.emaScalpingSettings?.customMaxTradesPerDay ||
          config.strategies.emaScalping.customMaxTradesPerDay
      );
    }
    if (strategyMode === "ultra_ai") {
      return Number(
        state.ultraAiSettings?.customMaxTradesPerDay ||
          config.strategies.ultraAi.customMaxTradesPerDay
      );
    }
    if (strategyMode === "auto") {
      const sm = config.strategies.autoAi.smartMoneyProfessional;
      let lim = Math.min(
        config.capital.effectiveMaxTradesPerDay,
        Number(config.strategies.autoAi.maxTradesPerDay || 100)
      );
      if (sm?.enabled) {
        lim = Math.min(lim, Number(sm.professionalMaxTradesPerDay ?? 5));
      }
      return lim;
    }
    return config.capital.effectiveMaxTradesPerDay;
  }

  formatRs(amount) {
    const n = Number(amount || 0);
    const nf = new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    const sign = n < 0 ? "-" : n > 0 ? "+" : "";
    return `${sign}Rs. ${nf.format(Math.abs(n))}`;
  }

  formatExitReasonLabel(reason) {
    const map = {
      stop_loss: "Stop loss",
      take_profit: "Take profit",
      market_intelligence_exit: "Market intelligence exit",
      auto_trend_reversal: "Auto AI trend reversal",
      auto_whale_reversal: "Auto AI whale reversal",
      ema_5r_exit: "EMA strategy exit (5R)",
      live_open: "Open",
      manual_dashboard_exit: "Manual exit (dashboard)"
    };
    if (!reason) {
      return "—";
    }
    return map[reason] || String(reason).replace(/_/g, " ");
  }

  formatTradeClosedTelegramMessage(trade, reason, totalRealizedPnl) {
    const pnl = Number(trade.pnl || 0);
    const headline =
      pnl > 0
        ? "✅ TRADE CLOSED — PROFIT"
        : pnl < 0
          ? "❌ TRADE CLOSED — LOSS"
          : "⚖️ TRADE CLOSED — BREAKEVEN";
    const pct = Number(trade.pnlPct || 0);
    const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const mode = trade.strategyMode || "auto";
    return [
      headline,
      `📊 ${trade.exchange} · ${trade.symbol}`,
      `Side: ${String(trade.side || "buy").toUpperCase()} · Mode: ${mode}`,
      `💰 P&L: ${this.formatRs(pnl)} (${pctStr})`,
      `Entry → Exit: ${Number(trade.entryPrice || 0)} → ${Number(trade.exitPrice || 0)}`,
      `Notional: ${this.formatRs(trade.notional)}`,
      `Reason: ${this.formatExitReasonLabel(reason)}`,
      `📈 Total realized P&L (all closed trades): ${this.formatRs(totalRealizedPnl)}`
    ].join("\n");
  }

  async sendTelegramAlert(message) {
    if (!config.telegram.botToken || !config.telegram.chatId) {
      return false;
    }

    const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: message
      })
    });

    return response.ok;
  }

  async getLiveExecutionPrice(exchange, symbol, fallbackPrice) {
    try {
      if (exchange === "MacroPaper") {
        const snapshot = await fetchMacroMarketSnapshot(symbol);
        const latestPrice = Number(snapshot?.latestPrice || 0);
        return latestPrice > 0 ? latestPrice : fallbackPrice;
      }

      if (exchange === "Binance") {
        const realtimeSnapshot = this.binanceFuturesStream.getSnapshot(symbol);
        const realtimePrice = Number(realtimeSnapshot?.derived?.latestPrice || 0);
        if (realtimePrice > 0) {
          return realtimePrice;
        }
      }

      const client = this.exchangeClients[exchange];
      if (client?.fetchTicker) {
        const ticker = await client.fetchTicker(symbol);
        const latestPrice = Number(ticker?.last || 0);
        return latestPrice > 0 ? latestPrice : fallbackPrice;
      }
    } catch (error) {
      return fallbackPrice;
    }

    return fallbackPrice;
  }
}

const bot = new TradingBot();

if (require.main === module) {
  bot.start().then(() => {
    console.log("Trading bot started in dashboard-compatible mode.");
  });
}

module.exports = bot;
