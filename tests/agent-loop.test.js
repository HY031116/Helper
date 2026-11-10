'use strict';

/**
 * Agent 主循环回归测试
 * 覆盖：模型自主多步工具调用、observation 回填、危险操作确认中断、
 * 流式 tool_calls 分片重组、循环中模型失败的收尾语义
 * 运行：node --test tests/agent-loop.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

require('./helpers/mock-electron');

const store = require('../src/main/store');
const ai = require('../src/main/ai');
const { AGENT_TOOLS, AGENT_TOOL_NAMES } = require('../src/main/agent/tool-schemas');

const DATA_DIR = process.env.WORK_HELPER_DATA_DIR || path.join(require('os').tmpdir(), 'work-helper-agent-test-' + Date.now());

before(() => {
  process.env.WORK_HELPER_DATA_DIR = DATA_DIR;
  store.init();
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function reset() {
  store.resetTasks();
  store.clearAgentState();
}

function useLlmSettings() {
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
}

function toolCallMessage(calls) {
  return { choices: [{ message: { content: null, tool_calls: calls.map((call, index) => ({
    id: call.id || `call-${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
  })) } }] };
}

function contentMessage(text) {
  return { choices: [{ message: { content: text } }] };
}

test('工具清单：与 tool-registry 意图对齐且排除对话类与专用管线能力', () => {
  assert.strictEqual(AGENT_TOOLS.length, 11);
  for (const tool of AGENT_TOOLS) {
    assert.strictEqual(tool.type, 'function');
    assert.strictEqual(typeof tool.function.name, 'string');
    assert.strictEqual(tool.function.parameters.type, 'object');
  }
  // 专用管线与对话类不作为模型工具
  for (const excluded of ['report', 'chat', 'greeting', 'thanks', 'restore', 'plan']) {
    assert.ok(!AGENT_TOOL_NAMES.includes(excluded), `${excluded} 不应开放为模型工具`);
  }
  // schema 名称必须是已注册 intent，避免模型调到不存在的 handler
  assert.deepStrictEqual(AGENT_TOOL_NAMES.filter((name) => !require('../src/main/agent/tool-registry').TOOL_DEFINITIONS[name]), []);
});

test('Agent 主循环：模型多步自主调用工具并给出最终答复', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const task = store.createTask({ title: '整理季度数据', pri: 1 });
  const originalFetch = global.fetch;
  let call = 0;
  const bodies = [];
  global.fetch = async (url, options) => {
    call += 1;
    bodies.push(JSON.parse(options.body));
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'query', args: { pri: 1 } }]) };
    if (call === 2) return { ok: true, json: async () => toolCallMessage([{ name: 'update', args: { taskId: task.id, status: 'doing' } }]) };
    return { ok: true, json: async () => contentMessage('已把「整理季度数据」标记为进行中，这是当前唯一的紧急任务。') };
  };
  try {
    const result = await ai.handleAuto('看看我的紧急任务，把最急的那个开始做');
    assert.strictEqual(result.engine, 'agent');
    assert.deepStrictEqual(result.agentSteps, ['query', 'update']);
    assert.strictEqual(result.type, 'update');
    assert.strictEqual(result.task.status, 'doing');
    assert.strictEqual(result.message, '已把「整理季度数据」标记为进行中，这是当前唯一的紧急任务。');
    // 每一轮请求都带工具清单
    assert.ok(bodies.every((body) => Array.isArray(body.tools) && body.tools.length === 11));
    // observation 以 tool 角色回填给模型
    assert.ok(bodies[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call-0'));
    assert.ok(bodies[1].messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)));
    // jsonMode 不与 tools 同发（OpenAI 兼容接口限制）
    assert.strictEqual(bodies[0].response_format, undefined);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：危险操作触发确认卡片中断且不执行删除', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const task = store.createTask({ title: '旧方案草稿' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => toolCallMessage([{ name: 'delete', args: { target: '旧方案草稿' } }]) });
  try {
    const result = await ai.handleAuto('把旧方案草稿删掉');
    assert.strictEqual(result.type, 'confirm');
    assert.strictEqual(result.engine, 'agent');
    assert.deepStrictEqual(result.agentSteps, []);
    assert.match(result.message, /删除任务「旧方案草稿」/);
    // 任务未被删除，进入待确认 pending
    assert.ok(store.getAllTasks().some((t) => t.id === task.id));
    const pending = store.getAgentState().pending;
    assert.strictEqual(pending.kind, 'confirmation');
    assert.strictEqual(pending.intent, 'delete');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：未知工具名回传错误观察，模型改为文字作答', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const originalFetch = global.fetch;
  let call = 0;
  let secondBody = null;
  global.fetch = async (url, options) => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'not_a_tool', args: {} }]) };
    secondBody = JSON.parse(options.body);
    return { ok: true, json: async () => contentMessage('当前没有可用的对应能力，建议直接在任务列表操作。') };
  };
  try {
    const result = await ai.handleAuto('帮我同步日历');
    assert.strictEqual(result.engine, 'agent');
    assert.strictEqual(result.type, 'chat');
    assert.strictEqual(result.message, '当前没有可用的对应能力，建议直接在任务列表操作。');
    assert.deepStrictEqual(result.agentSteps, []);
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /未知工具/);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：模型仍可返回意图 JSON 走原有单步路径', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => contentMessage(JSON.stringify({
    schemaVersion: 1, intent: 'create', confidence: 'high', title: '跟设计确认最终稿', pri: 1
  })) });
  try {
    const result = await ai.handleAuto('新建跟设计确认最终稿');
    assert.strictEqual(result.type, 'create');
    assert.strictEqual(result.engine, 'llm');
    assert.ok(!result.agentSteps);
    assert.ok(store.getAllTasks().some((t) => t.title === '跟设计确认最终稿'));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：循环中途模型失败时保留已执行结果且不重复执行', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'create', args: { title: '准备汇报材料', pri: 2 } }]) };
    const error = new Error('模型连接超时（45s 内未收到响应）');
    error.name = 'TimeoutError';
    error.code = 'AI_REQUEST_TIMEOUT';
    throw error;
  };
  try {
    const result = await ai.handleAuto('新建任务准备汇报材料');
    assert.strictEqual(result.engine, 'agent');
    assert.deepStrictEqual(result.agentSteps, ['create']);
    assert.strictEqual(result.type, 'create');
    // 失败消息汇总已执行步骤的真实结果，而不是空泛的"已完成的部分如下"
    assert.match(result.message, /已完成 1 步：/);
    assert.match(result.message, /准备汇报材料/);
    assert.match(result.message, /模型中断没有执行/);
    assert.match(result.message, /模型连接超时/);
    assert.match(result.message, /可重试继续/);
    assert.ok(result.retryable);
    // 只创建了一次，没有因降级重复创建
    const created = store.getAllTasks().filter((t) => t.title === '准备汇报材料');
    assert.strictEqual(created.length, 1);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：思考耗尽预算导致正文为空时加大 token 预算重试一次', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const originalFetch = global.fetch;
  let call = 0;
  const bodies = [];
  global.fetch = async (url, options) => {
    call += 1;
    bodies.push(JSON.parse(options.body));
    // 第 1 次：解析出工具调用；第 2 次：只有思考没有正文（token 预算被思考耗尽）
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'query', args: {} }]) };
    if (call === 2) return { ok: true, json: async () => contentMessage('') };
    // 第 3 次：加大预算的重试成功给出最终答复
    return { ok: true, json: async () => contentMessage('这是重试后的完整回答。') };
  };
  try {
    const result = await ai.handleAuto('看看我的任务');
    assert.strictEqual(result.engine, 'agent');
    // 最终 type 跟随最后执行成功的操作（query），最终消息来自重试后的模型答复
    assert.strictEqual(result.type, 'query');
    assert.strictEqual(result.message, '这是重试后的完整回答。');
    assert.deepStrictEqual(result.agentSteps, ['query']);
    // 循环内调用使用加大的预算，正文为空后用更大预算重试
    assert.strictEqual(bodies[1].max_tokens, 4096);
    assert.strictEqual(bodies[2].max_tokens, 8192);
    // 重试的是同一段对话（observation 已回填），不是新请求
    assert.ok(bodies[2].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call-0'));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：加预算重试仍拿不到正文时走部分收尾', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const originalFetch = global.fetch;
  let call = 0;
  const bodies = [];
  global.fetch = async (url, options) => {
    call += 1;
    bodies.push(JSON.parse(options.body));
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'record_query', args: {} }]) };
    return { ok: true, json: async () => contentMessage('') }; // 始终只有思考没有正文
  };
  try {
    const result = await ai.handleAuto('统计一下进度');
    assert.strictEqual(result.engine, 'agent');
    assert.deepStrictEqual(result.agentSteps, ['record_query']);
    assert.match(result.message, /已完成 1 步：/);
    assert.match(result.message, /模型没有返回最终答案/);
    assert.match(result.message, /可重试继续/);
    assert.ok(result.retryable);
    // 恰好三次带工具的调用：初始解析 + 循环常规预算 + 一次加预算重试，不做无限重试
    assert.strictEqual(bodies.filter((b) => Array.isArray(b.tools)).length, 3);
    assert.strictEqual(bodies[1].max_tokens, 4096);
    assert.strictEqual(bodies[2].max_tokens, 8192);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('流式 tool_calls 分片重组：跨 chunk 的 name/arguments 正确拼接', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const task = store.createTask({ title: '核对发票' });
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-x","function":{"name":"comp"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lete","arguments":"{\\"target\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"核对发票\\"}"}}]}}]}',
    'data: [DONE]'
  ].join('\n') + '\n';
  const encoder = new TextEncoder();
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async (url, options) => {
    call += 1;
    // 第一次（parseWithLLM）：非流式，模型直接发起第一个工具调用
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'query', args: {} }]) };
    // 第二次（agent 循环内）：流式返回分片的 tool_calls
    if (call === 2) {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.stream, true);
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: (() => {
              let sent = false;
              return async () => {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: encoder.encode(sse) };
              };
            })()
          })
        }
      };
    }
    return { ok: true, json: async () => contentMessage('已完成核对发票任务的收尾。') };
  };
  try {
    const result = await ai.handleAuto('看看我的任务，把最急的那个完成掉', { onProgress: () => {} });
    assert.strictEqual(result.engine, 'agent');
    assert.deepStrictEqual(result.agentSteps, ['query', 'complete']);
    assert.strictEqual(store.getTask(task.id).status, 'done');
    assert.strictEqual(result.message, '已完成核对发票任务的收尾。');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：消费旧澄清状态正常完成后清理残留 pending', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  store.updateAgentState({ pending: {
    kind: 'model_clarification', intent: 'create', params: {},
    message: '要创建什么标题的任务？', originalText: '新建任务', createdAt: Date.now()
  } });
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => toolCallMessage([{ name: 'query', args: {} }]) };
    return { ok: true, json: async () => contentMessage('当前任务列表是空的。') };
  };
  try {
    const result = await ai.handleAuto('列出我所有的任务');
    assert.strictEqual(result.engine, 'agent');
    // 旧澄清 pending 不应残留，否则下一条普通命令会被误当作澄清补充
    assert.ok(!store.getAgentState().pending);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：澄清 pending 期间触发确认，新确认替换旧澄清', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const task = store.createTask({ title: '旧方案草稿' });
  store.updateAgentState({ pending: {
    kind: 'model_clarification', intent: 'create', params: {},
    message: '要创建什么标题的任务？', originalText: '新建任务', createdAt: Date.now()
  } });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => toolCallMessage([{ name: 'delete', args: { target: '旧方案草稿' } }]) });
  try {
    const result = await ai.handleAuto('把旧方案草稿删掉');
    assert.strictEqual(result.type, 'confirm');
    assert.strictEqual(result.engine, 'agent');
    const pending = store.getAgentState().pending;
    assert.strictEqual(pending.kind, 'confirmation');
    assert.strictEqual(pending.intent, 'delete');
    assert.ok(store.getAllTasks().some((t) => t.id === task.id));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：非法 JSON 参数不执行工具，回传错误观察让模型自纠', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const originalFetch = global.fetch;
  let call = 0;
  let secondBody = null;
  global.fetch = async (url, options) => {
    call += 1;
    if (call === 1) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{
        id: 'call-0', type: 'function', function: { name: 'query', arguments: '{pri: }' }
      }] } }] }) };
    }
    secondBody = JSON.parse(options.body);
    return { ok: true, json: async () => contentMessage('刚才的调用参数不完整，建议直接在任务列表查看。') };
  };
  try {
    const result = await ai.handleAuto('看看我的紧急任务，把最急的那个开始做');
    assert.strictEqual(result.engine, 'agent');
    assert.deepStrictEqual(result.agentSteps, []);
    assert.strictEqual(result.type, 'chat');
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /合法 JSON/);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：超大观察收缩数组而不是截断字符串，保持合法 JSON', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  const longTitle = '超'.repeat(1000); // 1000 字标题，保证任意 12 条窗口都超过 4000
  for (let i = 1; i <= 20; i += 1) store.createTask({ title: `${longTitle}${i}` });
  const originalFetch = global.fetch;
  let secondBody = null;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!secondBody && body.messages && body.messages.some((m) => m.role === 'tool')) {
      secondBody = body;
      return { ok: true, json: async () => contentMessage('任务很多，建议先筛掉低优先级。') };
    }
    return { ok: true, json: async () => toolCallMessage([{ name: 'query', args: {} }]) };
  };
  try {
    const result = await ai.handleAuto('列出我所有的任务');
    assert.strictEqual(result.engine, 'agent');
    const observation = secondBody.messages.find((m) => m.role === 'tool').content;
    assert.ok(observation.length <= 4000);
    const parsed = JSON.parse(observation); // 若按字符串截断会在这里抛错
    assert.ok(parsed.tasks.length >= 1 && parsed.tasks.length < 12, '超大列表应收缩而非全量保留');
    assert.strictEqual(parsed.total, 28); // 20 条新建 + 8 条种子任务
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('Agent 主循环：工具结果以压缩观察回填，超大列表被截断保护上下文', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
  reset();
  useLlmSettings();
  for (let i = 1; i <= 30; i += 1) store.createTask({ title: `批量任务 ${String(i).padStart(2, '0')}` });
  const originalFetch = global.fetch;
  let secondBody = null;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!secondBody && body.messages && body.messages.some((m) => m.role === 'tool')) {
      secondBody = body;
      return { ok: true, json: async () => contentMessage('收到，任务很多，建议先筛掉低优先级。') };
    }
    return { ok: true, json: async () => toolCallMessage([{ name: 'query', args: {} }]) };
  };
  try {
    const result = await ai.handleAuto('列出我所有的任务');
    assert.strictEqual(result.engine, 'agent');
    const observation = secondBody.messages.find((m) => m.role === 'tool').content;
    const parsed = JSON.parse(observation);
    assert.strictEqual(parsed.tasks.length, 12); // 压缩：最多 12 条
    assert.strictEqual(parsed.total, 38); // 30 条新建 + 8 条种子任务
    assert.ok(observation.length <= 4000);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});
