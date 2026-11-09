'use strict';

const TOOL_DEFINITIONS = Object.freeze({
  create: { effect: 'write', planSafe: true },
  memo_create: { effect: 'write', planSafe: true },
  memo_query: { effect: 'read', targetType: 'memo' },
  memo_delete: { effect: 'write', targetType: 'memo', requiresTarget: true, preflightSafe: true, dangerous: true },
  memo_pin: { effect: 'write', targetType: 'memo', requiresTarget: true, planSafe: true },
  memo_to_task: { effect: 'write', targetType: 'memo', requiresTarget: true },
  memo_split: { effect: 'write', targetType: 'memo', requiresTarget: true, preflightSafe: true },
  complete: { effect: 'write', targetType: 'task', requiresTarget: true, planSafe: true },
  start: { effect: 'write', targetType: 'task', requiresTarget: true, planSafe: true },
  delete: { effect: 'write', targetType: 'task', requiresTarget: true, preflightSafe: true, dangerous: true },
  archive: { effect: 'write', targetType: 'task', requiresTarget: true, planSafe: true },
  split: { effect: 'write', targetType: 'task', requiresTarget: true },
  suggest: { effect: 'read' },
  summary: { effect: 'read' },
  stats: { effect: 'read' },
  report: { effect: 'read' },
  query: { effect: 'read' },
  batch: { effect: 'write', dangerous: true },
  update: { effect: 'write', targetType: 'task', requiresTarget: true, planSafe: true },
  child: { effect: 'write', targetType: 'task', requiresTarget: true, planSafe: true },
  postpone: { effect: 'write', targetType: 'task', requiresTarget: true, planSafe: true },
  restore: { effect: 'write', targetType: 'task' },
  plan: { effect: 'write', preflightSafe: true },
  greeting: { effect: 'read' },
  thanks: { effect: 'read' },
  chat: { effect: 'conversation' }
});

function getToolDefinition(intent) {
  return TOOL_DEFINITIONS[intent] || null;
}

function createToolRegistry(handlers) {
  const missing = Object.keys(TOOL_DEFINITIONS).filter((intent) => typeof handlers[intent] !== 'function');
  if (missing.length) throw new Error(`Agent tool handlers missing: ${missing.join(', ')}`);
  return Object.freeze({
    execute(intent, params) {
      const definition = getToolDefinition(intent);
      if (!definition) return null;
      return handlers[intent](params || {});
    },
    definition: getToolDefinition
  });
}

module.exports = { TOOL_DEFINITIONS, getToolDefinition, createToolRegistry };
