/**
 * Vercel expects a Node entry at the repo root (e.g. server.js) that loads Express.
 * The dashboard app stays in dashboard/server.js; this file only wires it up.
 */
require("express");
require("./dashboard/server.js");
