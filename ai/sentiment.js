const config = require("../config");

const positiveKeywords = ["surge", "bull", "approval", "inflow", "growth", "gain"];
const negativeKeywords = ["hack", "drop", "ban", "outflow", "lawsuit", "crash"];

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

function scoreText(text) {
  const source = text.toLowerCase();
  let score = 0;

  for (const word of positiveKeywords) {
    if (source.includes(word)) {
      score += 1;
    }
  }

  for (const word of negativeKeywords) {
    if (source.includes(word)) {
      score -= 1;
    }
  }

  return score;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function buildSentimentSnapshot() {
  let fearGreed = null;
  let newsScore = 0;
  let altNewsScore = 0;
  let trending = [];
  let globalData = null;
  let mempoolFees = null;

  try {
    const fearGreedData = await fetchJson(config.marketIntelligence.fearGreedUrl);
    fearGreed = fearGreedData?.data?.[0] || null;
  } catch (error) {
    fearGreed = null;
  }

  try {
    const rssText = await fetchText(config.marketIntelligence.newsRssUrl);
    newsScore = scoreText(rssText.slice(0, 5000));
  } catch (error) {
    newsScore = 0;
  }

  try {
    const rssText = await fetchText(config.marketIntelligence.altNewsRssUrl);
    altNewsScore = scoreText(rssText.slice(0, 5000));
  } catch (error) {
    altNewsScore = 0;
  }

  try {
    const trendingData = await fetchJson(config.marketIntelligence.trendingUrl);
    trending = (trendingData?.coins || []).slice(0, 7).map((item) => item.item?.symbol);
  } catch (error) {
    trending = [];
  }

  try {
    const globalResponse = await fetchJson(config.marketIntelligence.globalUrl);
    globalData = globalResponse?.data || null;
  } catch (error) {
    globalData = null;
  }

  try {
    mempoolFees = await fetchJson(config.marketIntelligence.mempoolFeesUrl);
  } catch (error) {
    mempoolFees = null;
  }

  const fearGreedValue = Number(fearGreed?.value || 50);
  const fearGreedScore = (fearGreedValue - 50) / 50;
  const newsSentimentScore = clamp((newsScore + altNewsScore) / 10, -1, 1);
  const trendingScore = clamp((trending.length - 3) / 4, -1, 1);
  const btcDominance = Number(globalData?.market_cap_percentage?.btc || 50);
  const btcDominanceScore = clamp((55 - btcDominance) / 15, -1, 1);
  const mempoolFastFee = Number(mempoolFees?.fastestFee || 0);
  const networkActivityScore = clamp(mempoolFastFee / 100, 0, 1);
  const onChainScore = Number(
    ((btcDominanceScore + networkActivityScore + trendingScore) / 3).toFixed(3)
  );
  const compositeScore = Number(
    ((fearGreedScore + newsSentimentScore + onChainScore) / 3).toFixed(3)
  );

  return {
    fearGreed,
    newsSentimentScore,
    onChainScore,
    compositeScore
    ,
    trending,
    marketBreadth: {
      btcDominance,
      networkActivityScore,
      mempoolFastFee
    }
  };
}

module.exports = {
  buildSentimentSnapshot
};
