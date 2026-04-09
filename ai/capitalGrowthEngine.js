const config = require("../config");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ensureCapitalGrowthOnState(state) {
  if (!state.capitalGrowth) {
    state.capitalGrowth = {
      ...getDefaultCapitalGrowthState(),
      enabled: config.capitalGrowth.enabled
    };
  }
}

function getDefaultCapitalGrowthState() {
  return {
    enabled: true,
    reinvestedLayer: 0,
    cumulativeReinvested: 0,
    cumulativeWithdrawnNotional: 0,
    peakEquity: null,
    winStreak: 0,
    lossStreak: 0,
    lastScaledAutoRiskPct: null,
    lastEffectiveCapital: null,
    growthHistory: [],
    backfillDone: false,
    pausedUntil: null,
    pauseReason: null,
    lastUpdatedAt: null
  };
}

function computeStreaksFromClosed(closedTrades = []) {
  const sorted = [...closedTrades]
    .filter((t) => t.status === "closed" && t.closedAt)
    .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
  if (!sorted.length) {
    return { winStreak: 0, lossStreak: 0 };
  }
  const firstWin = Number(sorted[0].pnl || 0) > 0;
  let winStreak = 0;
  let lossStreak = 0;
  if (firstWin) {
    for (const t of sorted) {
      if (Number(t.pnl || 0) > 0) {
        winStreak += 1;
      } else {
        break;
      }
    }
  } else {
    for (const t of sorted) {
      if (Number(t.pnl || 0) <= 0) {
        lossStreak += 1;
      } else {
        break;
      }
    }
  }
  return { winStreak, lossStreak };
}

function backfillReinvestedLayer(state) {
  const cg = state.capitalGrowth;
  if (!cg || cg.backfillDone) {
    return;
  }
  const frac = Number(config.capitalGrowth.reinvestProfitFraction || 0.5);
  const closed = state.trades.filter((t) => t.status === "closed");
  let layer = 0;
  for (const t of closed) {
    const p = Number(t.pnl || 0);
    layer += p > 0 ? p * frac : p;
  }
  cg.reinvestedLayer = Number(layer.toFixed(2));
  cg.backfillDone = true;
}

function getFullEquity(state) {
  const initial = Number(config.capital.initialINR || 0);
  return Number((initial + Number(state.metrics?.realizedPnl || 0)).toFixed(2));
}

function getEffectiveCapitalBase(state) {
  ensureCapitalGrowthOnState(state);
  const initial = Number(config.capital.initialINR || 0);
  const minBase = Number(config.capitalGrowth.minCapitalBase || 500);
  if (!config.capitalGrowth.enabled || !state.capitalGrowth?.enabled) {
    return Math.max(minBase, getFullEquity(state));
  }
  if (state.capitalGrowth && !state.capitalGrowth.backfillDone) {
    backfillReinvestedLayer(state);
  }
  const layer = Number(state.capitalGrowth.reinvestedLayer || 0);
  return Math.max(minBase, Number((initial + layer).toFixed(2)));
}

function resolveStreakRiskPct(winStreak, lossStreak) {
  const c = config.capitalGrowth;
  if (lossStreak >= Number(c.lossStreak5 || 5)) {
    return Number(c.riskAfterLossStreak5 || 0.005);
  }
  if (lossStreak >= Number(c.lossStreak3 || 3)) {
    return Number(c.riskAfterLossStreak3 || 0.008);
  }
  if (winStreak >= Number(c.winStreak5 || 5)) {
    return Number(c.riskAfterWinStreak5 || 0.015);
  }
  if (winStreak >= Number(c.winStreak3 || 3)) {
    return Number(c.riskAfterWinStreak3 || 0.012);
  }
  return Number(config.strategies.autoAi.riskPctMin || 0.01);
}

function getCapitalGrowthContext(state) {
  ensureCapitalGrowthOnState(state);
  const cg = state.capitalGrowth;
  const c = config.capitalGrowth;
  const initial = Number(config.capital.initialINR || 0);
  const fullEquity = getFullEquity(state);
  const effectiveCapital = getEffectiveCapitalBase({ ...state, capitalGrowth: cg });

  if (!c.enabled || !cg.enabled) {
    return {
      enabled: false,
      effectiveCapital,
      fullEquity,
      autoRiskPct: Number(config.strategies.autoAi.riskPctMin || 0.01),
      emaRiskMultiplier: 1,
      tradingPausedByCapitalGrowth: false,
      pauseReason: null,
      drawdownPct: 0,
      reinvestedLayer: Number(cg.reinvestedLayer || 0),
      winStreak: 0,
      lossStreak: 0
    };
  }

  if (!cg.backfillDone) {
    backfillReinvestedLayer({ ...state, capitalGrowth: cg });
  }

  const now = Date.now();
  if (cg.pausedUntil && new Date(cg.pausedUntil).getTime() > now) {
    return {
      enabled: true,
      effectiveCapital,
      fullEquity,
      autoRiskPct: Number(c.riskDrawdownSoft || 0.005),
      emaRiskMultiplier: Number(c.riskDrawdownSoft || 0.005) / Number(config.strategies.autoAi.riskPctMin || 0.01),
      tradingPausedByCapitalGrowth: true,
      pauseReason: cg.pauseReason || "capital_growth_drawdown_pause",
      drawdownPct: cg.lastDrawdownPct || 0,
      reinvestedLayer: Number(cg.reinvestedLayer || 0),
      winStreak: cg.winStreak || 0,
      lossStreak: cg.lossStreak || 0
    };
  }
  if (cg.pausedUntil && new Date(cg.pausedUntil).getTime() <= now) {
    cg.pausedUntil = null;
    cg.pauseReason = null;
  }

  const peak = cg.peakEquity != null ? Number(cg.peakEquity) : fullEquity;
  const drawdownPct =
    peak > 0 ? Number((((peak - fullEquity) / peak) * 100).toFixed(2)) : 0;

  let autoRiskPct = resolveStreakRiskPct(cg.winStreak || 0, cg.lossStreak || 0);

  const ddSoft = Number(c.drawdownSoftPct || 10);
  if (drawdownPct > ddSoft) {
    autoRiskPct = Math.min(autoRiskPct, Number(c.riskDrawdownSoft || 0.005));
  }

  const profitLockPct = Number(c.profitLockReturnPct || 5);
  if (initial > 0 && (fullEquity - initial) / initial >= profitLockPct / 100) {
    autoRiskPct *= Number(c.profitLockRiskFactor || 0.75);
  }

  const rMin = Number(c.riskMinPct || 0.005);
  const rMax = Number(c.riskMaxPct || 0.02);
  autoRiskPct = clamp(autoRiskPct, rMin, rMax);

  const baseline = Number(config.strategies.autoAi.riskPctMin || 0.01);
  const emaRiskMultiplier = baseline > 0 ? clamp(autoRiskPct / baseline, rMin / baseline, rMax / baseline) : 1;

  return {
    enabled: true,
    effectiveCapital,
    fullEquity,
    autoRiskPct,
    emaRiskMultiplier,
    tradingPausedByCapitalGrowth: false,
    pauseReason: null,
    drawdownPct,
    reinvestedLayer: Number(cg.reinvestedLayer || 0),
    winStreak: cg.winStreak || 0,
    lossStreak: cg.lossStreak || 0
  };
}

function applyCapitalGrowthAfterClose(state, closedTrade) {
  const c = config.capitalGrowth;
  ensureCapitalGrowthOnState(state);
  if (!c.enabled || !state.capitalGrowth?.enabled) {
    return;
  }
  const cg = state.capitalGrowth;
  const pnl = Number(closedTrade.pnl || 0);
  const frac = Number(c.reinvestProfitFraction || 0.5);

  if (!cg.backfillDone) {
    backfillReinvestedLayer(state);
  } else {
    cg.reinvestedLayer = Number(
      (Number(cg.reinvestedLayer || 0) + (pnl > 0 ? pnl * frac : pnl)).toFixed(2)
    );
  }
  cg.cumulativeReinvested = Number(
    (Number(cg.cumulativeReinvested || 0) + (pnl > 0 ? pnl * frac : 0)).toFixed(2)
  );
  if (pnl < 0) {
    cg.cumulativeWithdrawnNotional = Number(
      (Number(cg.cumulativeWithdrawnNotional || 0) + Math.abs(pnl)).toFixed(2)
    );
  }

  const closed = state.trades.filter((t) => t.status === "closed");
  const streaks = computeStreaksFromClosed(closed);
  cg.winStreak = streaks.winStreak;
  cg.lossStreak = streaks.lossStreak;

  const fullEquity = getFullEquity(state);
  cg.peakEquity =
    cg.peakEquity == null
      ? fullEquity
      : Number(Math.max(Number(cg.peakEquity), fullEquity).toFixed(2));

  const peak = Number(cg.peakEquity || fullEquity);
  const drawdownPct =
    peak > 0 ? Number((((peak - fullEquity) / peak) * 100).toFixed(2)) : 0;
  cg.lastDrawdownPct = drawdownPct;
  if (drawdownPct > Number(c.drawdownHardPct || 15)) {
    cg.pausedUntil = new Date(Date.now() + Number(c.pauseDurationMs || 86_400_000)).toISOString();
    cg.pauseReason = `drawdown ${drawdownPct.toFixed(1)}% exceeded ${c.drawdownHardPct || 15}%`;
  }

  const ctx = getCapitalGrowthContext(state);
  cg.lastScaledAutoRiskPct = ctx.autoRiskPct;
  cg.lastEffectiveCapital = ctx.effectiveCapital;
  cg.lastUpdatedAt = new Date().toISOString();

  const hist = Array.isArray(cg.growthHistory) ? cg.growthHistory : [];
  hist.unshift({
    at: cg.lastUpdatedAt,
    effectiveCapital: ctx.effectiveCapital,
    fullEquity: ctx.fullEquity,
    autoRiskPct: ctx.autoRiskPct,
    reinvestedLayer: ctx.reinvestedLayer,
    tradePnl: pnl,
    drawdownPct: ctx.drawdownPct
  });
  cg.growthHistory = hist.slice(0, Number(c.growthHistoryMax || 120));
}

function ensureCapitalGrowthBackfill(state) {
  ensureCapitalGrowthOnState(state);
  if (config.capitalGrowth.enabled && state.capitalGrowth?.enabled) {
    backfillReinvestedLayer(state);
  }
}

module.exports = {
  getDefaultCapitalGrowthState,
  ensureCapitalGrowthOnState,
  ensureCapitalGrowthBackfill,
  getFullEquity,
  getEffectiveCapitalBase,
  getCapitalGrowthContext,
  applyCapitalGrowthAfterClose,
  computeStreaksFromClosed
};
