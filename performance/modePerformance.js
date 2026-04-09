const { MODE_KEYS, MODE_DEFINITIONS } = require("../controller/modeController");

function calculateDrawdown(closedTrades = []) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of closedTrades) {
    cumulative += Number(trade.pnl || 0);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return Number(maxDrawdown.toFixed(2));
}

function buildModeMetrics(mode, trades = []) {
  const modeTrades = trades.filter((trade) => (trade.strategyMode || "auto") === mode);
  const closedTrades = modeTrades
    .filter((trade) => trade.status === "closed")
    .sort(
      (left, right) =>
        new Date(left.closedAt || left.openedAt || 0).getTime() -
        new Date(right.closedAt || right.openedAt || 0).getTime()
    );
  const openTrades = modeTrades.filter((trade) => trade.status === "open");
  const profit = Number(
    modeTrades
      .filter((trade) => Number(trade.status === "open" ? trade.livePnl : trade.pnl) > 0)
      .reduce((sum, trade) => sum + Number(trade.status === "open" ? trade.livePnl : trade.pnl || 0), 0)
      .toFixed(2)
  );
  const loss = Number(
    Math.abs(
      modeTrades
        .filter((trade) => Number(trade.status === "open" ? trade.livePnl : trade.pnl) < 0)
        .reduce((sum, trade) => sum + Number(trade.status === "open" ? trade.livePnl : trade.pnl || 0), 0)
    ).toFixed(2)
  );
  const netPnl = Number(
    modeTrades
      .reduce((sum, trade) => sum + Number(trade.status === "open" ? trade.livePnl : trade.pnl || 0), 0)
      .toFixed(2)
  );
  const wins = closedTrades.filter((trade) => Number(trade.pnl || 0) > 0).length;
  const winRate = closedTrades.length ? Number(((wins / closedTrades.length) * 100).toFixed(2)) : 0;
  const rrSamples = closedTrades
    .map((trade) => Number(trade.strategySettings?.riskReward || 0))
    .filter((value) => value > 0);
  const avgRiskReward = rrSamples.length
    ? Number((rrSamples.reduce((sum, v) => sum + v, 0) / rrSamples.length).toFixed(2))
    : 0;

  return {
    mode,
    label: MODE_DEFINITIONS[mode]?.label || mode,
    title: MODE_DEFINITIONS[mode]?.title || mode,
    profit,
    loss,
    winRate,
    avgRiskReward,
    totalTrades: modeTrades.length,
    openTrades: openTrades.length,
    closedTrades: closedTrades.length,
    drawdown: calculateDrawdown(closedTrades),
    netPnl
  };
}

function buildModePerformanceSummary(trades = []) {
  const modes = MODE_KEYS.map((mode) => buildModeMetrics(mode, trades));
  const ranked = [...modes].sort((left, right) => right.netPnl - left.netPnl);
  const activeRanked = ranked.filter((mode) => mode.totalTrades > 0);

  return {
    modes,
    bestMode: activeRanked[0] || ranked[0] || null,
    worstMode: activeRanked.at(-1) || ranked.at(-1) || null
  };
}

module.exports = {
  buildModePerformanceSummary
};
