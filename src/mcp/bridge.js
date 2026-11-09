'use strict';

/**
 * MCP 桥接层：把协议核心、HTTP 传输、端点落盘和客户端配置拼成一个可开关的服务。
 *
 * 不依赖 Electron，全部外部能力由调用方注入，便于在纯 Node 下测试：
 * - executeTool / undoTool：本地工具执行入口（必须是不写应用会话状态的外部安全入口）
 * - onMutation：写操作成功后的广播回调，让主窗口与桌宠实时刷新
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createMcpCore, TOOL_CATALOG } = require('./protocol');
const { createHttpTransport } = require('./http-transport');
const { getToolDefinition } = require('../main/agent/tool-registry');
const endpointStore = require('./endpoint');
const { buildClientConfigs } = require('./client-config');

const SECRET_FILE = 'mcp-secret.json';
const DEFAULT_PORT = 4571;
const NON_MUTATION_TYPES = new Set(['confirm', 'ask', 'clarify', 'error', 'unknown', 'cancelled']);

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function readSecret(dataDir) {
  const file = path.join(dataDir, SECRET_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const token = String(raw && raw.token || '');
    return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
  } catch (error) {
    return null;
  }
}

function writeSecret(dataDir, token) {
  const file = path.join(dataDir, SECRET_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ token, updatedAt: Date.now() }, null, 2)}\n`, 'utf-8');
  try { fs.chmodSync(tmp, 0o600); } catch (error) { /* Windows 权限位有限 */ }
  fs.renameSync(tmp, file);
  return token;
}

function createMcpBridge(options) {
  const config = options || {};
  if (typeof config.executeTool !== 'function') throw new Error('MCP bridge 需要 executeTool');
  const dataDir = String(config.dataDir || endpointStore.defaultDataDir());
  const version = String(config.version || '0.0.0');
  const logger = config.logger || { warn: () => {}, error: () => {} };
  const preferredPort = Number(config.port) || DEFAULT_PORT;
  const proxyPath = String(config.proxyPath || path.join(__dirname, 'stdio-proxy.js'));
  const execPath = String(config.execPath || process.execPath);

  let transport = null;
  let token = null;
  let endpoint = null;
  let startedAt = 0;
  let lastError = '';

  async function executeTool(intent, params) {
    const result = await config.executeTool(intent, params);
    const definition = getToolDefinition(intent);
    // undo 成功的返回形态不一：restore/unarchive 直接返回实体对象（无 ok 字段），
    // removeCreatedAdditions 返回 { ok: true }，冲突时返回 { ok: false }。只要不是明确失败都算变更。
    const mutated = intent === 'undo'
      ? !!(result && result.ok !== false)
      : !!definition && definition.effect !== 'read' && !!result && !NON_MUTATION_TYPES.has(result.type);
    if (mutated && typeof config.onMutation === 'function') {
      try { config.onMutation(intent, result); } catch (error) { logger.error('[mcp] 变更广播失败', error); }
    }
    return result;
  }

  function currentStatus() {
    const running = !!transport && transport.isRunning();
    const activeToken = running ? token : null;
    const configs = buildClientConfigs({
      execPath,
      proxyPath,
      dataDir,
      url: running ? transport.url() : '',
      token: activeToken || ''
    });
    return {
      running,
      version,
      toolCount: TOOL_CATALOG.length,
      host: running ? transport.host() : '127.0.0.1',
      port: running ? transport.port() : 0,
      url: running ? transport.url() : '',
      token: activeToken || '',
      endpointFile: endpointStore.endpointPath(dataDir),
      dataDir,
      proxyPath,
      execPath,
      startedAt: running ? startedAt : 0,
      clientSessions: running ? transport.sessionCount() : 0,
      lastError,
      configs
    };
  }

  async function start() {
    if (transport && transport.isRunning()) return currentStatus();
    lastError = '';
    try {
      token = readSecret(dataDir) || writeSecret(dataDir, generateToken());
      const core = createMcpCore({
        version,
        executeTool,
        undoTool: typeof config.undoTool === 'function' ? config.undoTool : () => null
      });
      const instance = createHttpTransport({ core, token, port: preferredPort, logger });
      const info = await instance.start();
      transport = instance;
      startedAt = Date.now();
      endpoint = endpointStore.writeEndpoint(dataDir, {
        name: 'work-helper',
        version,
        pid: process.pid,
        port: info.port,
        token,
        startedAt,
        proxyPath,
        execPath
      });
      return currentStatus();
    } catch (error) {
      lastError = String(error && error.message || error);
      logger.error('[mcp] 启动失败', error);
      if (transport) {
        try { await transport.stop(); } catch (stopError) { /* 忽略 */ }
        transport = null;
      }
      throw error;
    }
  }

  async function stop() {
    const instance = transport;
    transport = null;
    endpoint = null;
    startedAt = 0;
    // 先同步清理端点文件：即使进程随即退出，代理也不会连到一个已失效的端口。
    endpointStore.removeEndpoint(dataDir, process.pid);
    if (instance) {
      try { await instance.stop(); } catch (error) { logger.error('[mcp] 停止失败', error); }
    }
    return currentStatus();
  }

  /** 轮换 token：运行中会重启监听，旧 token 立即失效，已连接的客户端需要重新配置。 */
  async function rotateToken() {
    const wasRunning = !!transport && transport.isRunning();
    token = writeSecret(dataDir, generateToken());
    if (wasRunning) {
      await stop();
      await start();
    }
    return currentStatus();
  }

  return Object.freeze({
    start,
    stop,
    rotateToken,
    status: currentStatus,
    isRunning: () => !!transport && transport.isRunning(),
    endpoint: () => endpoint,
    // 供测试与上层直接验证变更判定语义
    executeTool
  });
}

module.exports = {
  createMcpBridge,
  generateToken,
  readSecret,
  writeSecret,
  SECRET_FILE,
  DEFAULT_PORT
};