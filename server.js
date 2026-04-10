/**
 * Exports the Express app for:
 * - Local: `npm start` → listen() runs in dashboard/server.js when VERCEL is unset.
 * - Vercel: `api/index.js` re-exports this app; keep Root Directory = repo root (not dashboard).
 */
module.exports = require("./dashboard/server.js");
