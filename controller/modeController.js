const MODE_DEFINITIONS = {
  auto: {
    key: "auto",
    label: "Mode 1",
    title: "Auto AI"
  },
  ultra_ai: {
    key: "ultra_ai",
    label: "Mode 2",
    title: "Ultra AI"
  },
  ema_scalping: {
    key: "ema_scalping",
    label: "Mode 3",
    title: "Professional EMA Scalping"
  }
};

const MODE_KEYS = Object.keys(MODE_DEFINITIONS);

function getDefaultModeControls(primaryMode = "auto") {
  return {
    primaryMode: MODE_KEYS.includes(primaryMode) ? primaryMode : "auto",
    selectedModes: [MODE_KEYS.includes(primaryMode) ? primaryMode : "auto"],
    modes: MODE_KEYS.reduce((accumulator, key) => {
      accumulator[key] = {
        ...MODE_DEFINITIONS[key],
        enabled: key === (MODE_KEYS.includes(primaryMode) ? primaryMode : "auto")
      };
      return accumulator;
    }, {})
  };
}

function normalizeModeControls(modeControls = {}, fallbackPrimaryMode = "auto", options = {}) {
  const defaults = getDefaultModeControls(fallbackPrimaryMode);
  const providedModes = modeControls.modes || {};
  const normalizedModes = MODE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = {
      ...defaults.modes[key],
      ...(providedModes[key] || {}),
      enabled:
        providedModes[key]?.enabled === undefined
          ? defaults.modes[key].enabled
          : Boolean(providedModes[key].enabled)
    };
    return accumulator;
  }, {});

  const selectedModes = Array.isArray(modeControls.selectedModes)
    ? modeControls.selectedModes.filter((mode) => MODE_KEYS.includes(mode))
    : defaults.selectedModes;
  const enabledModes = MODE_KEYS.filter((mode) => normalizedModes[mode].enabled);
  const primaryMode = MODE_KEYS.includes(modeControls.primaryMode)
    ? modeControls.primaryMode
    : enabledModes[0] || selectedModes[0] || defaults.primaryMode;

  if (!enabledModes.length && !options.allowEmpty) {
    normalizedModes[primaryMode].enabled = true;
  }

  return {
    primaryMode,
    selectedModes: selectedModes.length ? selectedModes : [primaryMode],
    modes: normalizedModes
  };
}

function getEnabledModes(modeControls = {}) {
  const normalized = normalizeModeControls(modeControls, "auto", { allowEmpty: true });
  return MODE_KEYS.filter((mode) => normalized.modes[mode].enabled);
}

function setSelectedModes(modeControls = {}, selectedModes = []) {
  const normalized = normalizeModeControls(modeControls);
  return {
    ...normalized,
    selectedModes: selectedModes.filter((mode) => MODE_KEYS.includes(mode))
  };
}

function startModes(modeControls = {}, modes = [], options = {}) {
  const normalized = normalizeModeControls(modeControls);
  const targetModes = modes.filter((mode) => MODE_KEYS.includes(mode));
  const exclusive = Boolean(options.exclusive);
  const nextModes = MODE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = {
      ...normalized.modes[key],
      enabled: exclusive ? targetModes.includes(key) : normalized.modes[key].enabled || targetModes.includes(key)
    };
    return accumulator;
  }, {});
  const enabledModes = MODE_KEYS.filter((mode) => nextModes[mode].enabled);
  const primaryMode = MODE_KEYS.includes(options.primaryMode)
    ? options.primaryMode
    : enabledModes[0] || normalized.primaryMode;

  return {
    primaryMode,
    selectedModes: targetModes.length ? targetModes : normalized.selectedModes,
    modes: nextModes
  };
}

function stopModes(modeControls = {}, modes = []) {
  const normalized = normalizeModeControls(modeControls, "auto", { allowEmpty: true });
  const targetModes = new Set(modes.filter((mode) => MODE_KEYS.includes(mode)));
  const nextModes = MODE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = {
      ...normalized.modes[key],
      enabled: targetModes.has(key) ? false : normalized.modes[key].enabled
    };
    return accumulator;
  }, {});
  const enabledModes = MODE_KEYS.filter((mode) => nextModes[mode].enabled);

  return {
    primaryMode: enabledModes[0] || normalized.primaryMode,
    selectedModes: normalized.selectedModes,
    modes: nextModes
  };
}

module.exports = {
  MODE_DEFINITIONS,
  MODE_KEYS,
  getDefaultModeControls,
  normalizeModeControls,
  getEnabledModes,
  setSelectedModes,
  startModes,
  stopModes
};
