/**
 * Vercel (@vercel/node) loads this file as the serverless entry; it must export the Express app.
 * Locally, dashboard/server.js calls listen() when VERCEL is unset.
 */
module.exports = require("./dashboard/server.js");
