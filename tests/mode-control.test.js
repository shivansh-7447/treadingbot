const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const {
  getDefaultModeControls,
  startModes,
  stopModes,
  getEnabledModes
} = require("../controller/modeController");
const { buildModePerformanceSummary } = require("../performance/modePerformance");

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

test("mode controller can enable all existing modes and stop them again", () => {
  const defaults = getDefaultModeControls("auto");
  const started = startModes(defaults, ["auto", "ultra_ai", "ema_scalping"], {
    exclusive: true,
    primaryMode: "auto"
  });

  assert.deepEqual(getEnabledModes(started), ["auto", "ultra_ai", "ema_scalping"]);

  const stopped = stopModes(started, ["auto", "ultra_ai", "ema_scalping"]);
  assert.deepEqual(getEnabledModes(stopped), []);
});

test("mode performance summary highlights best and worst modes", () => {
  const summary = buildModePerformanceSummary([
    { strategyMode: "auto", status: "closed", pnl: 120, openedAt: "2026-01-01", closedAt: "2026-01-01" },
    { strategyMode: "auto", status: "closed", pnl: -30, openedAt: "2026-01-02", closedAt: "2026-01-02" },
    { strategyMode: "ultra_ai", status: "closed", pnl: 40, openedAt: "2026-01-01", closedAt: "2026-01-01" },
    { strategyMode: "ema_scalping", status: "closed", pnl: -80, openedAt: "2026-01-01", closedAt: "2026-01-01" }
  ]);

  assert.equal(summary.bestMode.mode, "auto");
  assert.equal(summary.worstMode.mode, "ema_scalping");
  assert.equal(summary.modes.find((mode) => mode.mode === "auto").drawdown >= 0, true);
});

test("mode control state persists through sqlite state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crypto-bot-mode-control-"));
  const sqlitePath = path.join(tempDir, "bot.db");

  process.env.SQLITE_PATH = sqlitePath;

  clearModule("../config");
  clearModule("../db");
  clearModule("../manual");

  const { closeDb } = require("../db");
  const { loadState, updateManualControls } = require("../manual");

  await updateManualControls({
    modeControls: {
      primaryMode: "ultra_ai",
      selectedModes: ["auto", "ultra_ai"],
      modes: {
        auto: { enabled: true },
        ultra_ai: { enabled: true },
        ema_scalping: { enabled: false }
      }
    }
  });

  const state = await loadState();
  assert.equal(state.strategyMode, "ultra_ai");
  assert.deepEqual(
    Object.entries(state.modeControls.modes)
      .filter(([, value]) => value.enabled)
      .map(([key]) => key),
    ["auto", "ultra_ai"]
  );
  assert.deepEqual(state.modeControls.selectedModes, ["auto", "ultra_ai"]);

  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});
