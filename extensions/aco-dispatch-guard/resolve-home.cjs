'use strict';

const os = require('os');
const path = require('path');

function resolveOpenclawHome() {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

function resolveOpenclawPaths() {
  const openclawHome = resolveOpenclawHome();
  return {
    openclawHome,
    configPath: path.join(openclawHome, 'openclaw.json'),
    eventsPath: process.env.DISPATCH_GUARD_EVENTS_PATH || path.join(openclawHome, 'workspace', 'logs', 'dispatch-guard-events.jsonl'),
  };
}

module.exports = {
  resolveOpenclawHome,
  resolveOpenclawPaths,
};
