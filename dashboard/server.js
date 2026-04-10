const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { WebSocketServer } = require("ws");
const bot = require("../bot");
const config = require("../config");
const { verifyCredentials, requireAuth, buildAuthState } = require("../auth");

const app = express();
const server = http.createServer(app);
let wss = null;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: config.auth.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12
  }
});
app.use(sessionMiddleware);

function broadcastJson(payload) {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify(payload));
    }
  }
}

async function buildRealtimePayload() {
  const state = await bot.getDashboardState();
  return {
    type: "state",
    timestamp: new Date().toISOString(),
    scanner: (state.runtime.lastScanResults || [])
      .filter((item) => !item.error)
      .map((item) => ({
        exchange: item.exchange,
        symbol: item.symbol,
        last: item.ticker?.last || 0,
        oneMinutePrice: item.timeframes?.["1m"]?.metrics?.latestPrice || 0,
        fiveMinutePrice: item.timeframes?.["5m"]?.metrics?.latestPrice || 0,
        fifteenMinutePrice: item.timeframes?.["15m"]?.metrics?.latestPrice || 0,
        warnings: item.warnings || []
      })),
    rankings: (state.runtime.lastRankings || []).slice(0, 10).map((item) => ({
      exchange: item.exchange,
      symbol: item.symbol,
      score: item.score,
      latestPrice:
        item.timeframes?.["5m"]?.metrics?.latestPrice ||
        item.timeframes?.["1m"]?.metrics?.latestPrice ||
        item.ticker?.last ||
        0
    }))
  };
}

app.get("/api/auth/status", async (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.authenticated) || !config.auth.enabled,
    auth: buildAuthState()
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { username = "", password = "" } = req.body || {};
  if (config.auth.enabled && !verifyCredentials(username, password)) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  req.session.authenticated = true;
  req.session.username = username || config.auth.username;
  res.json({
    success: true,
    auth: buildAuthState()
  });
});

app.post("/api/auth/logout", async (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/status", requireAuth, async (req, res) => {
  try {
    res.json({
      ...(await bot.getDashboardState()),
      auth: buildAuthState()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function manualExitFromRequestBody(req, res) {
  const tradeId = req.body?.tradeId ?? req.body?.id;
  if (tradeId === undefined || tradeId === null || String(tradeId).trim() === "") {
    res.status(400).json({ error: "tradeId is required." });
    return;
  }
  try {
    const result = await bot.manualExitTrade(String(tradeId).trim());
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(await bot.getDashboardState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/** Primary JSON exit endpoint (short path; some proxies mishandle longer paths). */
app.post("/api/close-position", requireAuth, manualExitFromRequestBody);
app.post("/api/manual-exit", requireAuth, manualExitFromRequestBody);

app.post("/api/start", requireAuth, async (req, res) => {
  try {
    res.json(await bot.start());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/stop", requireAuth, async (req, res) => {
  try {
    res.json(await bot.stop());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/modes/start-all", requireAuth, async (req, res) => {
  try {
    res.json(await bot.startAllModes());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/modes/stop-all", requireAuth, async (req, res) => {
  try {
    res.json(await bot.stopAllModes());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/modes/start-selected", requireAuth, async (req, res) => {
  try {
    res.json(await bot.startSelectedModes(req.body?.modes || []));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/modes/:mode/start", requireAuth, async (req, res) => {
  try {
    res.json(await bot.startMode(req.params.mode));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/modes/:mode/stop", requireAuth, async (req, res) => {
  try {
    res.json(await bot.stopMode(req.params.mode));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/scan", requireAuth, async (req, res) => {
  try {
    await bot.scanCycle();
    res.json(await bot.getDashboardState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/backtest", requireAuth, async (req, res) => {
  try {
    res.json(await bot.runBacktest());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/approve/:id", requireAuth, async (req, res) => {
  try {
    res.json(await bot.approve(req.params.id, req.body?.notes || ""));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reject/:id", requireAuth, async (req, res) => {
  try {
    res.json(await bot.reject(req.params.id, req.body?.reason || ""));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/manual/settings", requireAuth, async (req, res) => {
  try {
    await bot.updateManualControls(req.body || {});
    res.json(await bot.getDashboardState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/manual/start", requireAuth, async (req, res) => {
  try {
    await bot.startManualTrading();
    res.json(await bot.getDashboardState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/manual/stop", requireAuth, async (req, res) => {
  try {
    await bot.stopManualTrading();
    res.json(await bot.getDashboardState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/trades/:id/manual-exit", requireAuth, async (req, res) => {
  try {
    const result = await bot.manualExitTrade(req.params.id);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(await bot.getDashboardState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/chart", requireAuth, async (req, res) => {
  try {
    res.json(
      await bot.getMarketChart({
        exchange: req.query.exchange,
        symbol: req.query.symbol,
        timeframe: req.query.timeframe,
        limit: req.query.limit
      })
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/performance-log", requireAuth, async (req, res) => {
  try {
    const file = await bot.getPerformanceLog({
      date: req.query.date,
      format: req.query.format
    });
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
    return;
  }
  next();
});

const publicDir = path.join(__dirname, "..", "public");
const publicIndex = path.join(publicDir, "index.html");
const dashboardIndex = path.join(__dirname, "index.html");
const uiRoot = fs.existsSync(publicIndex) ? publicDir : __dirname;
const indexHtmlPath = fs.existsSync(publicIndex) ? publicIndex : dashboardIndex;
if (!fs.existsSync(indexHtmlPath)) {
  throw new Error(
    `Dashboard UI missing: add ${publicIndex} (preferred for Vercel) or ${dashboardIndex}.`
  );
}
app.use(express.static(uiRoot));

app.get("*", (req, res) => {
  res.sendFile(indexHtmlPath);
});

// Vercel serverless runs the Express app only (no long-lived listen / WS server).
if (!process.env.VERCEL) {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", async (socket) => {
    try {
      socket.send(JSON.stringify(await buildRealtimePayload()));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", error: error.message }));
    }
  });

  setInterval(async () => {
    if (!config.realtime.websocketEnabled || !wss.clients.size) {
      return;
    }

    try {
      broadcastJson(await buildRealtimePayload());
    } catch (error) {
      broadcastJson({ type: "error", error: error.message });
    }
  }, config.realtime.broadcastIntervalMs);

  server.listen(config.app.port, () => {
    console.log(`Dashboard running on http://localhost:${config.app.port}`);
    console.log(
      "Manual trade exit: POST /api/close-position or POST /api/manual-exit with JSON body { \"tradeId\": \"...\" }"
    );
  });
}

module.exports = app;
