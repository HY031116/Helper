'use strict';

/**
 * MCP 服务回归测试集
 * 覆盖：协议协商、工具目录与注解、外部工具入口安全边界、HTTP 传输鉴权与会话、
 * stdio 代理端到端、端点落盘与客户端配置、设置与主进程接线。
 * 运行：node --test tests/mcp-server.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 先加载 electron mock（拦截 require('electron')）
require('./helpers/mock-electron');

const store = require('../src/main/store');
const ai = require('../src/main/ai');
const protocol = require('../src/mcp/protocol');
const { createMcpCore } = protocol;
const { createHttpTransport, isAllowedHost, isAllowedOrigin, MAX_BODY_BYTES } = require('../src/mcp/http-transport');
const endpointStore = require('../src/mcp/endpoint');
const { buildClientConfigs, SERVER_KEY } = require('../src/mcp/client-config');
const { createMcpBridge, SECRET_FILE } = require('../src/mcp/bridge');

const DATA_DIR = path.join(os.tmpdir(), `work-helper-mcp-test-${Date.now()}`);
const TOKEN = 'a'.repeat(48);

before(() => {
  process.env.WORK_HELPER_DATA_DIR = DATA_DIR;
  store.init();
  store.clearAgentState();
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ---------- 工具 ---------- */
function reset() {
  store.resetTasks();
  store.clearAgentState();
}

function jsonRequest(port, { method = 'POST', urlPath = '/mcp', token = TOKEN, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`
      }, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}, headers)
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* SSE 或空响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- 协议核心：目录与映射 ---------- */
test('MCP 工具目录：13 个工具、注解与前后缀解析一致', () => {
  // 目录按已注册意图动态生成：阶段 2 收缩后 24→13（11 个模型工具 + plan + undo；report/restore 随意图下线动态移除）。
  assert.strictEqual(protocol.TOOL_CATALOG.length, 13);
  const names = new Set();
  for (const tool of protocol.TOOL_CATALOG) {
    assert.ok(tool.name.startsWith(protocol.TOOL_PREFIX), `工具名缺少前缀：${tool.name}`);
    assert.strictEqual(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema 顶层必须是 object`);
    assert.ok(String(tool.description).trim().length > 0, `${tool.name} 的描述不能为空`);
    assert.ok(String(tool.title).trim().length > 0, `${tool.name} 缺少标题`);
    names.add(tool.name);
    assert.strictEqual(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.strictEqual(typeof tool.annotations.destructiveHint, 'boolean');
    assert.strictEqual(tool.annotations.openWorldHint, false);
    assert.strictEqual(tool.annotations.title, tool.title);
  }
  assert.strictEqual(names.size, 13, '工具名不能重复');

  const readOnly = protocol.TOOL_CATALOG.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort();
  assert.deepStrictEqual(readOnly, [
    'workhelper_memo_query', 'workhelper_query',
    'workhelper_record_query', 'workhelper_summary'
  ].sort());
  for (const name of readOnly) {
    assert.strictEqual(protocol.TOOL_CATALOG.find((tool) => tool.name === name).annotations.idempotentHint, true);
  }

  const destructive = protocol.TOOL_CATALOG.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name).sort();
  assert.deepStrictEqual(destructive, ['workhelper_batch', 'workhelper_delete'].sort());
  for (const name of destructive) {
    const tool = protocol.TOOL_CATALOG.find((item) => item.name === name);
    assert.ok(tool.description.includes('confirmation_required'), `${name} 的描述必须写明二次确认`);
    assert.strictEqual(tool.annotations.idempotentHint, false);
  }

  assert.strictEqual(protocol.resolveIntent('workhelper_query'), 'query');
  assert.strictEqual(protocol.resolveIntent('query'), 'query', '容忍客户端省略前缀');
  assert.strictEqual(protocol.resolveIntent('workhelper_undo'), 'undo');
  assert.strictEqual(protocol.resolveIntent('not_a_tool'), null);
  assert.strictEqual(protocol.resolveIntent(''), null);
});

function coreSession() {
  const session = { id: 's1', initialized: false, protocolVersion: null, clientInfo: null, readyNotification: false };
  return session;
}

test('协议核心：initialize 协商版本并记录客户端信息', async () => {
  const core = createMcpCore({ version: '0.2.0', executeTool: () => ({ type: 'info' }) });
  const session = coreSession();

  const response = await core.handle({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'tester', version: '1' } }
  }, session);
  assert.strictEqual(response.result.protocolVersion, '2024-11-05');
  assert.strictEqual(response.result.serverInfo.name, protocol.SERVER_NAME);
  assert.strictEqual(response.result.serverInfo.version, '0.2.0');
  assert.ok(response.result.instructions.includes('confirmation_required'));
  assert.strictEqual(session.initialized, true);
  assert.strictEqual(session.clientInfo.name, 'tester');

  // 不支持的版本回退到最新支持版本
  const fallback = await core.handle({
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '1999-01-01' }
  }, coreSession());
  assert.strictEqual(fallback.result.protocolVersion, protocol.LATEST_PROTOCOL_VERSION);
});

test('协议核心：未初始化、非法帧与未知方法返回明确错误', async () => {
  const core = createMcpCore({ version: '0.2.0', executeTool: () => ({ type: 'info' }) });

  const blockedList = await core.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, coreSession());
  assert.strictEqual(blockedList.error.code, protocol.ERROR_CODES.NOT_INITIALIZED);
  const blockedCall = await core.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workhelper_query' } }, coreSession());
  assert.strictEqual(blockedCall.error.code, protocol.ERROR_CODES.NOT_INITIALIZED);

  const badFrame = await core.handle({ id: 5, method: 'ping' }, coreSession());
  assert.strictEqual(badFrame.error.code, protocol.ERROR_CODES.INVALID_REQUEST);
  const notObject = await core.handle('hello', coreSession());
  assert.strictEqual(notObject.error.code, protocol.ERROR_CODES.INVALID_REQUEST);
  assert.strictEqual(notObject.id, null);

  const unknown = await core.handle({ jsonrpc: '2.0', id: 6, method: 'shelves/list' }, coreSession());
  assert.strictEqual(unknown.error.code, protocol.ERROR_CODES.METHOD_NOT_FOUND);
  assert.strictEqual(await core.handle({ jsonrpc: '2.0', method: 'shelves/list' }, coreSession()), null, '未知通知静默忽略');

  // 客户端探测类方法返回空列表
  const resources = await core.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, coreSession());
  assert.deepStrictEqual(resources.result.resources, []);
  const prompts = await core.handle({ jsonrpc: '2.0', id: 8, method: 'prompts/list' }, coreSession());
  assert.deepStrictEqual(prompts.result.prompts, []);

  const session = coreSession();
  await core.handle({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} }, session);
  assert.strictEqual(await core.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, session), null);
  assert.strictEqual(session.readyNotification, true);
  assert.deepStrictEqual((await core.handle({ jsonrpc: '2.0', id: 10, method: 'ping' }, session)).result, {});
});

test('协议核心：未知工具与非法 arguments 返回可读错误', async () => {
  const core = createMcpCore({ version: '0.2.0', executeTool: () => ({ type: 'info' }) });
  const session = coreSession();
  await core.handle({ jsonrpc: '2.0', id: 11, method: 'initialize', params: {} }, session);

  const unknown = await core.handle({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'workhelper_nope' } }, session);
  assert.strictEqual(unknown.result.isError, true);
  assert.ok(unknown.result.content[0].text.includes('未知工具'));

  const badArgs = await core.handle({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'query', arguments: [1] } }, session);
  assert.strictEqual(badArgs.error.code, protocol.ERROR_CODES.INVALID_PARAMS);
});

/* ---------- 外部工具入口：安全边界 ---------- */
test('外部工具入口：不写 agentState.pending，也不借用「最近提到」隐式选目标', () => {
  reset();
  const created = ai.executeExternalTool('create', { title: '外部入口任务', pri: 3 });
  assert.strictEqual(created.type, 'create');
  assert.ok(store.getTask(created.task.id));
  assert.strictEqual(store.getAgentState().pending, null, '外部调用不得写入应用侧 pending 会话状态');

  // 应用内路径会写 pending，这里反向对照，证明断言本身有效
  const appSide = ai.handle('删除 外部入口任务');
  assert.strictEqual(appSide.type, 'confirm');
  assert.strictEqual(store.getAgentState().pending.kind, 'confirmation');
  store.clearAgentState();

  // memo_to_task 缺目标：返回 clarify 而不是拿「最近备忘录」自动顶上（memo_delete 已随阶段 2 下线）
  const memo = store.createMemo({ content: '外部安全边界备忘录' });
  const taskCountBefore = store.getAllTasks().length;
  store.updateAgentState({ lastCollection: { type: 'memo', ids: [memo.id], ts: Date.now() } });
  const clarify = ai.executeExternalTool('memo_to_task', {});
  assert.strictEqual(clarify.type, 'clarify');
  assert.ok(store.getMemo(memo.id), '没有目标时绝不能自动选中');
  assert.strictEqual(store.getAllTasks().length, taskCountBefore, 'clarify 不得顺手转任务');

  const missingTarget = ai.executeExternalTool('delete', {});
  assert.strictEqual(missingTarget.type, 'clarify');
});

test('外部工具入口：歧义返回候选、删除先确认且数据零变化、确认后进回收站并可撤销', () => {
  reset();
  const first = store.createTask({ title: '重复标题任务' });
  const second = store.createTask({ title: '重复标题任务' });
  const ambiguous = ai.executeExternalTool('complete', { target: '重复标题任务' });
  assert.strictEqual(ambiguous.type, 'ask');
  assert.strictEqual(ambiguous.candidates.length, 2);
  assert.strictEqual(store.getTask(first.id).status, 'todo');
  assert.strictEqual(store.getTask(second.id).status, 'todo', '歧义时不得默认操作第一项');

  const beforeCount = store.getAllTasks().length;
  const confirmNeeded = ai.executeExternalTool('delete', { taskId: first.id });
  assert.strictEqual(confirmNeeded.type, 'confirm');
  assert.strictEqual(confirmNeeded.confirmation.purpose, 'safety');
  assert.strictEqual(store.getAllTasks().length, beforeCount, '确认前数据必须零变化');
  assert.strictEqual(store.getDeletedTasks().length, 0, '确认前不得进入回收站');

  // 裸 handler 层不自动加确认标记：MCP 层会按 purpose 把 confirmed 补进 nextCall，
  // 这里按同样语义补上 confirmed 后才真正执行。
  const done = ai.executeExternalTool('delete', Object.assign({}, confirmNeeded.confirmation.params, { confirmed: true }));
  assert.strictEqual(done.type, 'delete');
  assert.ok(store.getDeletedTasks().some((task) => task.id === first.id), '删除应进入回收站而非硬删');

  // undo 没有 tool-registry 定义：协议核心会把 workhelper_undo 直接路由到 ai.undoAction，
  // 这里按生产路径直接调 undoAction 验证撤销语义。
  const undone = ai.undoAction(done.undo);
  assert.ok(undone && undone.ok !== false, `撤销应成功：${undone && undone.message || '无返回'}`);
  assert.ok(store.getTask(first.id), '撤销后任务恢复');
  const rejectedUndo = ai.undoAction({ action: 'update', id: first.id, patch: { pri: 4 }, expected: { pri: 999 } });
  assert.strictEqual(rejectedUndo.ok, false, '数据已被改动时撤销必须拒绝');
});

/* ---------- 桥接层 ---------- */
test('桥接层：变更回调区分读写与撤销，端点文件随启停增删', async () => {
  const mutations = [];
  const stub = (intent) => {
    if (intent === 'query') return { type: 'query', message: 'ok' };
    if (intent === 'delete') return { type: 'delete', message: 'ok', undoable: true };
    if (intent === 'undo') return { ok: true, message: '已撤销' };
    if (intent === 'undoConflict') return { ok: false, message: '冲突' };
    return { type: 'confirm', message: 'need confirm', confirmation: { intent, params: {}, detail: '', purpose: 'safety' } };
  };
  const bridge = createMcpBridge({
    dataDir: DATA_DIR,
    executeTool: async (intent) => stub(intent === 'undoConflict' ? 'undoConflict' : intent),
    undoTool: async (undo) => stub('undoConflict'),
    onMutation: (intent) => mutations.push(intent),
    port: 0
  });

  await bridge.executeTool('query', {});
  await bridge.executeTool('delete', {});
  await bridge.executeTool('undo', {});
  await bridge.executeTool('undoConflict', {});
  assert.deepStrictEqual(mutations, ['delete', 'undo'], 'confirm 与撤销冲突都不算已发生变更');

  const started = await bridge.start();
  assert.strictEqual(started.running, true);
  assert.ok(/^[A-Za-z0-9_-]{16,128}$/.test(started.token));
  assert.strictEqual(started.host, '127.0.0.1');
  assert.ok(started.url.startsWith('http://127.0.0.1:'));
  assert.ok(fs.existsSync(endpointStore.endpointPath(DATA_DIR)), '启动后必须写入端点文件');
  const endpoint = endpointStore.readEndpoint({ dataDir: DATA_DIR });
  assert.strictEqual(endpoint.pid, process.pid);
  assert.strictEqual(endpoint.token, started.token);
  assert.ok(started.configs.stdio.json.includes(SERVER_KEY));
  assert.strictEqual(started.configs.stdio.env.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(started.configs.http.containsSecret, true);

  // token 持久化：重启后保持不变
  await bridge.stop();
  assert.strictEqual(fs.existsSync(endpointStore.endpointPath(DATA_DIR)), false, '停止后端点文件必须被清理');
  const restarted = await bridge.start();
  assert.strictEqual(restarted.token, started.token, 'token 在重启间保持稳定');

  // 轮换 token：旧 token 立即失效
  const rotated = await bridge.rotateToken();
  assert.notStrictEqual(rotated.token, started.token);
  assert.strictEqual(rotated.running, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA_DIR, SECRET_FILE), 'utf-8')).token, rotated.token);

  await bridge.stop();
});

/* ---------- HTTP 传输端到端 ---------- */
let transport;
let coreSessionId = '';

async function initSession(extraHeaders = {}) {
  const response = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e', version: '1' } } },
    headers: extraHeaders
  });
  assert.strictEqual(response.status, 200);
  coreSessionId = response.headers['mcp-session-id'];
  assert.ok(coreSessionId, 'initialize 必须下发会话 ID');
  return response;
}

test('HTTP 传输：鉴权、Origin 与 Host 校验', async () => {
  const { createMcpCore } = protocol;
  transport = createHttpTransport({
    core: createMcpCore({ version: 'test', executeTool: (intent, params) => ai.executeExternalTool(intent, params), undoTool: (undo) => ai.undoAction(undo) }),
    token: TOKEN,
    port: 0
  });
  const info = await transport.start();
  assert.strictEqual(info.host, '127.0.0.1');
  assert.ok(info.port > 0);
  reset();

  const noToken = await jsonRequest(info.port, { token: '', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.strictEqual(noToken.status, 401);
  const wrongToken = await jsonRequest(info.port, { token: 'b'.repeat(48), body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.strictEqual(wrongToken.status, 401);

  const evilOrigin = await jsonRequest(info.port, { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(evilOrigin.status, 403);
  const nullOrigin = await jsonRequest(info.port, { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, headers: { Origin: 'null' } });
  assert.strictEqual(nullOrigin.status, 403);

  // fetch 会剥离自定义 Host，这里用原生 http 显式伪造 Host 头验证防重绑定
  const evilHostStatus = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const req = http.request({
      hostname: '127.0.0.1', port: info.port, path: '/mcp', method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${TOKEN}` }
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.strictEqual(evilHostStatus, 403);

  const health = await jsonRequest(info.port, { urlPath: '/health' });
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.json.ok, true);
  assert.strictEqual(health.json.tools, 13);
  const healthNoAuth = await jsonRequest(info.port, { urlPath: '/health', token: '' });
  assert.strictEqual(healthNoAuth.status, 401);
  const notFound = await jsonRequest(info.port, { urlPath: '/other' });
  assert.strictEqual(notFound.status, 404);

  assert.strictEqual(isAllowedHost(`127.0.0.1:${info.port}`, info.port), true);
  assert.strictEqual(isAllowedHost('localhost', 1234), true);
  assert.strictEqual(isAllowedHost('attacker.example', 1234), false);
  assert.strictEqual(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.strictEqual(isAllowedOrigin(undefined), true, '非浏览器客户端可无 Origin');
});

test('HTTP 传输：完整会话流程与危险操作确认链', async () => {
  reset();
  const init = await initSession();
  assert.strictEqual(init.json.result.protocolVersion, '2025-06-18');
  assert.ok(init.json.result.instructions.includes('workhelper_'));

  const tools = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 't1', method: 'tools/list' },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.strictEqual(tools.json.result.tools.length, 13);

  // 写操作经 HTTP 真实落库
  const create = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'workhelper_create', arguments: { title: 'HTTP 创建的任务', pri: 1 } } },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.strictEqual(create.json.result.isError, false);
  assert.strictEqual(create.json.result.structuredContent.status, 'ok');
  const taskId = create.json.result.structuredContent.task.id;
  assert.ok(store.getTask(taskId));

  // 删除：先 confirmation_required 且零变化
  const beforeCount = store.getAllTasks().length;
  const confirm = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'd1', method: 'tools/call', params: { name: 'workhelper_delete', arguments: { taskId } } },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  const structured = confirm.json.result.structuredContent;
  assert.strictEqual(confirm.json.result.isError, false);
  assert.strictEqual(structured.status, 'confirmation_required');
  assert.strictEqual(structured.nextCall.name, 'workhelper_delete');
  assert.strictEqual(structured.nextCall.arguments.confirmed, true);
  assert.strictEqual(store.getAllTasks().length, beforeCount, '确认前数据零变化');

  // 确认后真正删除（进回收站），然后撤销
  const confirmed = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'd2', method: 'tools/call', params: { name: structured.nextCall.name, arguments: structured.nextCall.arguments } },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.strictEqual(confirmed.json.result.structuredContent.status, 'ok');
  assert.ok(store.getDeletedTasks().some((task) => task.id === taskId), '确认后删除进入回收站');

  const undo = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'u1', method: 'tools/call', params: { name: 'workhelper_undo', arguments: { undo: { action: 'restore', id: taskId } } } },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.strictEqual(undo.json.result.structuredContent.status, 'ok');
  assert.ok(store.getTask(taskId), '撤销后任务恢复');

  // 通知 → 202 无响应体
  const notification = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.strictEqual(notification.status, 202);
  assert.strictEqual(notification.text, '');

  // 未知会话 → 404
  const ghost = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'g1', method: 'tools/list' },
    headers: { 'Mcp-Session-Id': 'deadbeef' }
  });
  assert.strictEqual(ghost.status, 404);
  assert.strictEqual(ghost.json.error.code, -32001);

  // 解析错误 → HTTP 200 + -32700
  const parseError = await jsonRequest(transport.port(), { body: '{oops', headers: { 'Mcp-Session-Id': coreSessionId } });
  assert.strictEqual(parseError.status, 200);
  assert.strictEqual(parseError.json.error.code, -32700);

  // 批量消息 → 数组响应
  const batch = await jsonRequest(transport.port(), {
    body: [
      { jsonrpc: '2.0', id: 'b1', method: 'ping' },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/list' }
    ],
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.ok(Array.isArray(batch.json));
  assert.strictEqual(batch.json.length, 2);
  assert.strictEqual(batch.json[0].id, 'b1');
  assert.strictEqual(batch.json[1].result.tools.length, 13);

  // 请求体超限 → 413
  const oversized = await jsonRequest(transport.port(), { body: 'x'.repeat(MAX_BODY_BYTES + 16), headers: { 'Mcp-Session-Id': coreSessionId } });
  assert.strictEqual(oversized.status, 413);

  // GET 流：Accept 不带 event-stream → 406；正确 → SSE 头
  const wrongAccept = await jsonRequest(transport.port(), { method: 'GET', headers: { 'Mcp-Session-Id': coreSessionId, Accept: 'application/json' } });
  assert.strictEqual(wrongAccept.status, 406);
  const sse = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: transport.port(), path: '/mcp', method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': coreSessionId }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, text }); }, 300).unref?.();
    });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(sse.status, 200);
  assert.ok(sse.headers['content-type'].includes('text/event-stream'));
  assert.ok(sse.text.includes('retry: 3000'));

  // DELETE 关闭会话 → 204；旧会话失效
  const del = await jsonRequest(transport.port(), { method: 'DELETE', headers: { 'Mcp-Session-Id': coreSessionId } });
  assert.strictEqual(del.status, 204);
  assert.strictEqual(transport.sessionCount(), 0);
  const afterDelete = await jsonRequest(transport.port(), {
    body: { jsonrpc: '2.0', id: 'z1', method: 'tools/list' },
    headers: { 'Mcp-Session-Id': coreSessionId }
  });
  assert.strictEqual(afterDelete.status, 404);
});

/* ---------- stdio 代理端到端 ---------- */
function onceProxyResponse(child, matcher) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待代理响应超时')), 15000);
    const onData = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (e) { continue; }
        if (matcher(message)) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`代理提前退出（code ${code}）`)); });
  });
}

function spawnProxy(args) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'stdio-proxy.js'), ...args], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

test('stdio 代理：手动 url+token 模式端到端转发', async () => {
  reset();
  await initSession();
  const url = transport.url();
  const child = spawnProxy([`--url=${url}`, `--token=${TOKEN}`]);
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'stdio-e2e', version: '1' } } });
  const initResponse = await onceProxyResponse(child, (message) => message.id === 1);
  assert.strictEqual(initResponse.result.protocolVersion, '2025-03-26');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolsResponse = await onceProxyResponse(child, (message) => message.id === 2);
  assert.strictEqual(toolsResponse.result.tools.length, 13);

  const task = store.createTask({ title: 'stdio 代理链路任务' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workhelper_query', arguments: {} } });
  const queryResponse = await onceProxyResponse(child, (message) => message.id === 3);
  assert.strictEqual(queryResponse.result.structuredContent.status, 'ok');
  assert.ok(queryResponse.result.content[0].text.includes('stdio 代理链路任务'), '查询结果应包含真实任务');

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } });
  const unknownResponse = await onceProxyResponse(child, (message) => message.id === 4);
  assert.strictEqual(unknownResponse.result.isError, true);

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'workhelper_delete', arguments: { taskId: task.id } } });
  const confirmResponse = await onceProxyResponse(child, (message) => message.id === 5);
  assert.strictEqual(confirmResponse.result.structuredContent.status, 'confirmation_required');
  assert.ok(store.getTask(task.id), '确认前不得删除');

  child.stdin.end();
  await new Promise((resolve) => child.on('exit', resolve));
});

test('stdio 代理：端点文件发现与应用离线的可读错误', async () => {
  reset();
  await initSession();

  // 端点文件模式：代理自动发现运行中的服务（上面的桥接用例已清理过端点文件，这里重建）
  endpointStore.writeEndpoint(DATA_DIR, {
    name: 'work-helper', version: 'test', pid: process.pid,
    port: transport.port(), token: TOKEN, startedAt: Date.now()
  });
  const byFile = spawnProxy([`--data-dir=${DATA_DIR}`]);
  byFile.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  const fileInit = await onceProxyResponse(byFile, (message) => message.id === 1);
  assert.strictEqual(fileInit.result.serverInfo.name, protocol.SERVER_NAME);
  byFile.stdin.end();
  await new Promise((resolve) => byFile.on('exit', resolve));

  // 应用离线：返回 JSON-RPC 错误而不是静默失败
  const deadPort = await new Promise((resolve) => {
    const server = http.createServer(() => {});
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const offline = spawnProxy([`--url=http://127.0.0.1:${deadPort}/mcp`, `--token=${TOKEN}`]);
  offline.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} })}\n`);
  const offlineResponse = await onceProxyResponse(offline, (message) => message.id === 9);
  assert.strictEqual(offlineResponse.error.code, -32000);
  assert.ok(offlineResponse.error.message.includes('无法连接'), offlineResponse.error.message);
  offline.stdin.end();
  await new Promise((resolve) => offline.on('exit', resolve));

  // 端点文件缺失：错误信息要指引到设置页
  const missingDir = path.join(os.tmpdir(), `work-helper-mcp-missing-${Date.now()}`);
  const noEndpoint = spawnProxy([`--data-dir=${missingDir}`]);
  noEndpoint.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} })}\n`);
  const missingResponse = await onceProxyResponse(noEndpoint, (message) => message.id === 10);
  assert.strictEqual(missingResponse.error.code, -32000);
  assert.ok(missingResponse.error.message.includes('MCP 服务'), missingResponse.error.message);
  noEndpoint.stdin.end();
  await new Promise((resolve) => noEndpoint.on('exit', resolve));
});

/* ---------- 端点与客户端配置 ---------- */
test('端点模块：规范化、读写与按 pid 清理', () => {
  assert.strictEqual(endpointStore.normalizeEndpoint({ port: 0, token: TOKEN }), null);
  assert.strictEqual(endpointStore.normalizeEndpoint({ port: 70000, token: TOKEN }), null);
  assert.strictEqual(endpointStore.normalizeEndpoint({ port: 4571, token: 'short' }), null);
  const normalized = endpointStore.normalizeEndpoint({ port: 4571, token: TOKEN, pid: 42, name: 'work-helper' });
  assert.strictEqual(normalized.host, '127.0.0.1');
  assert.strictEqual(normalized.url, 'http://127.0.0.1:4571/mcp');

  const dir = path.join(os.tmpdir(), `work-helper-endpoint-${Date.now()}`);
  const written = endpointStore.writeEndpoint(dir, { port: 4571, token: TOKEN, pid: process.pid, startedAt: 123 });
  assert.strictEqual(written.port, 4571);
  assert.strictEqual(endpointStore.readEndpoint({ dataDir: dir }).startedAt, 123);
  assert.strictEqual(endpointStore.removeEndpoint(dir, 999999), false, 'pid 不匹配不得删除他人端点');
  assert.ok(fs.existsSync(endpointStore.endpointPath(dir)));
  assert.strictEqual(endpointStore.removeEndpoint(dir, process.pid), true);
  assert.strictEqual(endpointStore.readEndpoint({ dataDir: dir }), null);

  const resolved = endpointStore.resolveEndpoint({ dataDir: dir });
  assert.strictEqual(resolved.endpoint, null);
  assert.ok(resolved.reason.includes('MCP 服务'), resolved.reason);
  const manual = endpointStore.resolveEndpoint({ dataDir: dir, url: 'http://127.0.0.1:4571/mcp', token: TOKEN });
  assert.strictEqual(manual.endpoint.port, 4571);
  assert.strictEqual(endpointStore.resolveEndpoint({ dataDir: dir, url: '::not-a-url::', token: TOKEN }).reason, '手动指定的 MCP url 或 token 无效。');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('客户端配置：stdio 用应用自带运行时，HTTP 片段标记含密', () => {
  const configs = buildClientConfigs({ execPath: 'C:/app/WorkHelper.exe', proxyPath: 'C:/app/src/mcp/stdio-proxy.js', dataDir: DATA_DIR, url: 'http://127.0.0.1:4571/mcp', token: TOKEN });
  assert.strictEqual(configs.serverKey, SERVER_KEY);
  const stdioServer = JSON.parse(configs.stdio.json).mcpServers[SERVER_KEY];
  assert.strictEqual(stdioServer.command, 'C:/app/WorkHelper.exe');
  assert.deepStrictEqual(stdioServer.args, ['C:/app/src/mcp/stdio-proxy.js']);
  assert.strictEqual(stdioServer.env.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(stdioServer.env.WORK_HELPER_DATA_DIR, DATA_DIR);
  const httpServer = JSON.parse(configs.http.json).mcpServers[SERVER_KEY];
  assert.strictEqual(httpServer.url, 'http://127.0.0.1:4571/mcp');
  assert.strictEqual(httpServer.headers.Authorization, `Bearer ${TOKEN}`);
});

/* ---------- 设置与主进程接线 ---------- */
test('设置：MCP 默认关闭，开关按布尔语义更新', () => {
  reset();
  assert.strictEqual(store.getSettings().mcpEnabled, false);
  assert.strictEqual(store.updateSettings({ mcpEnabled: true }).mcpEnabled, true);
  assert.strictEqual(store.updateSettings({ mcpEnabled: 0 }).mcpEnabled, false);
  store.updateSettings({ mcpEnabled: false });
});

test('主进程接线：IPC、开关同步与退出清理静态一致', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

  assert.match(main, /ipcMain\.handle\('mcp:status'/);
  assert.match(main, /ipcMain\.handle\('mcp:setEnabled'/);
  assert.match(main, /ipcMain\.handle\('mcp:rotateToken'/);
  assert.match(main, /createMcpBridge\(\{/);
  assert.match(main, /executeTool: \(intent, params\) => ai\.executeExternalTool\(intent, params\)/);
  assert.match(main, /undoTool: \(undo\) => ai\.undoAction\(undo\)/);
  assert.match(main, /if \(patch && patch\.mcpEnabled !== undefined\) await syncMcpService\(s\.mcpEnabled\)/);
  assert.match(main, /if \(store\.getSettings\(\)\.mcpEnabled\) \{[\s\S]*?syncMcpService\(true\)/);
  assert.match(main, /mcpBridge\.stop\(\)/);
  assert.match(main, /tasks:changed|memos:changed/);
  assert.match(preload, /mcp: \{[\s\S]*?status: \(\) => ipcRenderer\.invoke\('mcp:status'\)[\s\S]*?setEnabled: \(enabled\) => ipcRenderer\.invoke\('mcp:setEnabled', !!enabled\)[\s\S]*?rotateToken: \(\) => ipcRenderer\.invoke\('mcp:rotateToken'\)/);
  assert.match(preload, /'tasks:changed', 'memos:changed'\]/);

  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'bridge.js'), 'utf8');
  assert.match(bridge, /removeEndpoint\(dataDir, process\.pid\)/, '停止时必须先清理端点文件');
  const broadcast = main.match(/function broadcastMcpMutation[\s\S]*?\n}/)[0];
  assert.ok(broadcast.includes('memos:changed'));
  assert.ok(broadcast.includes('tasks:changed'));
});

after(async () => {
  if (transport) {
    // 兜底清理：防止个别用例异常退出时端口泄漏
    try { await transport.stop(); } catch (e) { /* ignore */ }
  }
});
