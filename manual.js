const crypto = require("crypto");
const config = require("./config");
const { getDefaultLearningState } = require("./ai/learning");
const {
  getDefaultCapitalGrowthState,
  ensureCapitalGrowthBackfill
} = require("./ai/capitalGrowthEngine");
const { readState, writeState } = require("./db");
const {
  getDefaultModeControls,
  normalizeModeControls
} = require("./controller/modeController");

const defaultState = {
  trades: [],
  pendingApprovals: [],
  signals: [],
  strategyMode: config.strategies.defaultMode,
  autoSettings: {
    capitalPercent: config.capital.effectiveTradeSizePct * 100
  },
  learning: getDefaultLearningState(),
  manualMode: config.manual.defaultMode,
  manualTradingActive: config.manual.defaultTradingActive,
  manualSettings: {
    ...config.manual.settings
  },
  emaScalpingSettings: {
    capitalPercent: config.strategies.emaScalping.capitalPercent,
    customMaxTradesPerDay: config.strategies.emaScalping.customMaxTradesPerDay,
    minRiskPct: config.strategies.emaScalping.minRiskPct,
    maxRiskPct: config.strategies.emaScalping.maxRiskPct,
    minRrr: config.strategies.emaScalping.minRrr,
    confidenceThreshold: config.strategies.emaScalping.confidenceThreshold
  },
  ultraAiSettings: {
    capitalPercent: config.strategies.ultraAi.capitalPercent,
    customMaxTradesPerDay: config.strategies.ultraAi.customMaxTradesPerDay,
    confidenceThreshold: config.strategies.ultraAi.confidenceThreshold,
    executionMode: config.strategies.ultraAi.executionMode,
    paperFirst: config.strategies.ultraAi.paperFirst
  },
  modeControls: getDefaultModeControls(config.strategies.defaultMode),
  status: {
    running: false,
    lastScanAt: null,
    dailyTrades: 0,
    dailyRealizedPnlToday: 0,
    lastError: null
  },
  metrics: {
    realizedPnl: 0,
    winRate: 0,
    accuracy: 0
  },
  capitalGrowth: {
    ...getDefaultCapitalGrowthState(),
    enabled: config.capitalGrowth.enabled
  }
};

async function loadState() {
  const parsed = await readState(defaultState);
  const normalizedStrategyMode =
    parsed.strategyMode === "manual"
      ? "ultra_ai"
      : parsed.strategyMode || defaultState.strategyMode;
  const fromUltra = parsed.ultraAiSettings || {};
  const normalizedUltraAiSettings = {
    ...defaultState.ultraAiSettings,
    ...fromUltra,
    customMaxTradesPerDay: Number(
      fromUltra.customMaxTradesPerDay ?? defaultState.ultraAiSettings.customMaxTradesPerDay
    )
  };
  const normalizedModeControls = normalizeModeControls(
    parsed.modeControls || {},
    normalizedStrategyMode
  );
  const merged = {
    ...defaultState,
    ...parsed,
    strategyMode: normalizedModeControls.primaryMode || normalizedStrategyMode,
    manualMode: normalizedStrategyMode === "manual",
    manualTradingActive:
      normalizedStrategyMode === "manual"
        ? Boolean(parsed.manualTradingActive)
        : false,
    autoSettings: {
      ...defaultState.autoSettings,
      ...(parsed.autoSettings || {})
    },
    learning: {
      ...defaultState.learning,
      ...(parsed.learning || {}),
      metrics: {
        ...defaultState.learning.metrics,
        ...((parsed.learning && parsed.learning.metrics) || {})
      },
      recentClosedTrades: Array.isArray(parsed.learning?.recentClosedTrades)
        ? parsed.learning.recentClosedTrades
        : defaultState.learning.recentClosedTrades
    },
    manualSettings: {
      ...defaultState.manualSettings,
      ...(parsed.manualSettings || {})
    },
    emaScalpingSettings: {
      ...defaultState.emaScalpingSettings,
      ...(parsed.emaScalpingSettings || {})
    },
    ultraAiSettings: normalizedUltraAiSettings,
    modeControls: normalizedModeControls,
    status: { ...defaultState.status, ...(parsed.status || {}) },
    metrics: { ...defaultState.metrics, ...(parsed.metrics || {}) },
    capitalGrowth: {
      ...defaultState.capitalGrowth,
      ...(parsed.capitalGrowth || {}),
      growthHistory: Array.isArray(parsed.capitalGrowth?.growthHistory)
        ? parsed.capitalGrowth.growthHistory
        : defaultState.capitalGrowth.growthHistory
    }
  };
  ensureCapitalGrowthBackfill(merged);
  return merged;
}

async function saveState(state) {
  return writeState(state);
}

function makeApproval(signal) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "pending",
    signal
  };
}

function updateSignalRecord(state, id, updates) {
  const signal = state.signals.find((item) => item.id === id);
  if (!signal) {
    return;
  }

  Object.assign(signal, updates);
}

async function requestApproval(signal) {
  const state = await loadState();
  const approval = makeApproval(signal);
  state.pendingApprovals.unshift(approval);
  state.signals.unshift({
    id: approval.id,
    createdAt: approval.createdAt,
    status: "awaiting_approval",
    signal
  });
  await saveState(state);
  return approval;
}

async function approveTrade(id, notes = "") {
  const state = await loadState();
  const approval = state.pendingApprovals.find((item) => item.id === id);
  if (!approval) {
    throw new Error("Approval request not found.");
  }

  approval.status = "approved";
  approval.approvedAt = new Date().toISOString();
  approval.notes = notes;
  updateSignalRecord(state, id, {
    status: "approved",
    approvedAt: approval.approvedAt,
    notes
  });
  await saveState(state);
  return approval;
}

async function rejectTrade(id, reason = "") {
  const state = await loadState();
  const approval = state.pendingApprovals.find((item) => item.id === id);
  if (!approval) {
    throw new Error("Approval request not found.");
  }

  approval.status = "rejected";
  approval.rejectedAt = new Date().toISOString();
  approval.reason = reason;
  updateSignalRecord(state, id, {
    status: "rejected",
    rejectedAt: approval.rejectedAt,
    reason
  });
  await saveState(state);
  return approval;
}

async function consumeApproval(id) {
  const state = await loadState();
  const index = state.pendingApprovals.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error("Approval request not found.");
  }

  const [approval] = state.pendingApprovals.splice(index, 1);
  updateSignalRecord(state, id, {
    status: approval.status === "approved" ? "executed" : approval.status,
    executedAt: approval.status === "approved" ? new Date().toISOString() : undefined
  });
  await saveState(state);
  return approval;
}

async function updateManualControls(updates = {}) {
  const state = await loadState();

  if (updates.autoSettings) {
    state.autoSettings = {
      ...state.autoSettings,
      ...updates.autoSettings
    };
  }

  if (typeof updates.manualMode === "boolean") {
    state.manualMode = updates.manualMode;
  }

  if (typeof updates.strategyMode === "string") {
    state.strategyMode = updates.strategyMode;
    state.manualMode = updates.strategyMode === "manual";
    if (updates.strategyMode !== "manual") {
      state.manualTradingActive = false;
    }
  }

  if (typeof updates.manualTradingActive === "boolean") {
    state.manualTradingActive = updates.manualTradingActive;
  }

  if (updates.manualSettings) {
    state.manualSettings = {
      ...state.manualSettings,
      ...updates.manualSettings
    };
  }

  if (updates.emaScalpingSettings) {
    state.emaScalpingSettings = {
      ...state.emaScalpingSettings,
      ...updates.emaScalpingSettings
    };
  }

  if (updates.ultraAiSettings) {
    state.ultraAiSettings = {
      ...state.ultraAiSettings,
      ...updates.ultraAiSettings
    };
  }

  if (updates.modeControls) {
    state.modeControls = normalizeModeControls(
      {
        ...state.modeControls,
        ...updates.modeControls,
        modes: {
          ...(state.modeControls?.modes || {}),
          ...(updates.modeControls?.modes || {})
        }
      },
      updates.modeControls.primaryMode || state.strategyMode || config.strategies.defaultMode
    );
    state.strategyMode = state.modeControls.primaryMode;
  } else if (typeof updates.strategyMode === "string") {
    state.modeControls = normalizeModeControls(
      {
        ...(state.modeControls || getDefaultModeControls(updates.strategyMode)),
        primaryMode: updates.strategyMode,
        selectedModes: [updates.strategyMode],
        modes: {
          ...(state.modeControls?.modes || {}),
          [updates.strategyMode]: {
            ...(state.modeControls?.modes?.[updates.strategyMode] || {}),
            enabled: true
          }
        }
      },
      updates.strategyMode
    );
  }

  await saveState(state);
  return state;
}

module.exports = {
  loadState,
  saveState,
  requestApproval,
  approveTrade,
  rejectTrade,
  consumeApproval,
  updateManualControls
};
