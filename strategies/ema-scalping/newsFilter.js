function normalizeEventTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function eventTouchesSymbol(symbol, title = "", currency = "") {
  const text = `${title} ${currency}`.toUpperCase();
  if (symbol === "XAUUSD" || symbol === "XAGUSD") {
    return /USD|GOLD|SILVER|FED|CPI|NFP|FOMC/.test(text);
  }
  if (symbol.endsWith("USD")) {
    return /USD|FED|CPI|NFP|FOMC/.test(text);
  }
  if (symbol === "USDJPY") {
    return /USD|JPY|BOJ|FED|CPI|NFP|FOMC/.test(text);
  }
  return /USD|CRYPTO|FED|CPI|NFP/.test(text);
}

function hasHighImpactNewsBlock(events, symbol, beforeMinutes, afterMinutes) {
  const now = Date.now();
  const beforeMs = beforeMinutes * 60 * 1000;
  const afterMs = afterMinutes * 60 * 1000;

  const relevant = events.find((event) => {
    const impact = String(event.impact || event.impact_title || "").toLowerCase();
    if (!impact.includes("high")) {
      return false;
    }
    const eventTime = normalizeEventTime(event.date || event.timestamp || event.time);
    if (!eventTime) {
      return false;
    }
    if (!eventTouchesSymbol(symbol, event.title || event.event || "", event.currency || "")) {
      return false;
    }
    const delta = eventTime.getTime() - now;
    return delta >= -afterMs && delta <= beforeMs;
  });

  return relevant
    ? {
        blocked: true,
        reason: `High impact news filter: ${relevant.title || relevant.event || relevant.currency}`
      }
    : {
        blocked: false,
        reason: ""
      };
}

module.exports = {
  hasHighImpactNewsBlock
};
