/**
 * Vercel serverless entry. Rewrites in vercel.json send /api/* (and other routes
 * without a static file) here. Reuses the same Express app as local `npm start`.
 */
module.exports = require("../server.js");
