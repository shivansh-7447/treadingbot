const crypto = require("crypto");
const config = require("./config");

function toBuffer(value) {
  return Buffer.from(String(value ?? ""), "utf8");
}

function safeEqual(left, right) {
  const leftBuffer = toBuffer(left);
  const rightBuffer = toBuffer(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyCredentials(username, password) {
  return (
    safeEqual(username, config.auth.username) && safeEqual(password, config.auth.password)
  );
}

function requireAuth(req, res, next) {
  if (!config.auth.enabled) {
    next();
    return;
  }

  if (req.session?.authenticated) {
    next();
    return;
  }

  res.status(401).json({ error: "Authentication required." });
}

function buildAuthState() {
  return {
    enabled: config.auth.enabled,
    username: config.auth.username,
    requiresPasswordChange: config.auth.password === "change-me-now"
  };
}

module.exports = {
  verifyCredentials,
  requireAuth,
  buildAuthState
};
