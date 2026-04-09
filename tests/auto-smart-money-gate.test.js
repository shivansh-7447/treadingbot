const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateAutoSmartMoneyGate } = require("../ai/autoSmartMoneyGate");

test("smart money gate fails without snapshot", () => {
  const r = evaluateAutoSmartMoneyGate(null, { enabled: true });
  assert.equal(r.ok, false);
});

test("smart money gate passes when disabled", () => {
  const r = evaluateAutoSmartMoneyGate(null, { enabled: false });
  assert.equal(r.ok, true);
});
