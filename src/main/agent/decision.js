'use strict';

const { TOOL_DEFINITIONS } = require('./tool-registry');

const READ_ONLY_INTENTS = new Set(
  Object.entries(TOOL_DEFINITIONS).filter(([, definition]) => definition.effect === 'read').map(([intent]) => intent)
);
const PREFLIGHT_SAFE_INTENTS = new Set(
  Object.entries(TOOL_DEFINITIONS).filter(([, definition]) => definition.preflightSafe).map(([intent]) => intent)
);

function decideModelAction(intent, confidence) {
  if (confidence === 'low') return 'clarify';
  if (confidence !== 'medium' || READ_ONLY_INTENTS.has(intent) || intent === 'chat' || intent === 'unknown') {
    return 'execute';
  }
  if (PREFLIGHT_SAFE_INTENTS.has(intent)) return 'preflight';
  return 'confirm_interpretation';
}

function decideFallbackAction(intent, options) {
  if (READ_ONLY_INTENTS.has(intent)) {
    return options && options.localReadSafe ? 'read_only' : 'unavailable';
  }
  if (intent === 'chat' || intent === 'unknown') return 'unavailable';
  if (PREFLIGHT_SAFE_INTENTS.has(intent)) return 'preflight';
  return 'confirm_local';
}

module.exports = {
  READ_ONLY_INTENTS,
  PREFLIGHT_SAFE_INTENTS,
  decideModelAction,
  decideFallbackAction
};
