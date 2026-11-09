'use strict';

/**
 * MCP 端点发现与落盘。
 *
 * 应用启动 MCP 服务后，把 { port, token, pid, url } 原子写入数据目录下的 mcp-endpoint.json；
 * stdio 代理与设置页都从这里读，避免用户手填端口和 token。
 * 不依赖 Electron：纯 Node 侧按各平台 appData 约定推导同一目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENDPOINT_FILE = 'mcp-endpoint.json';
const ENDPOINT_SCHEMA_VERSION = 1;

/** 与 src/main.js + store.getDataDir() 保持一致的生产数据目录。 */
function defaultDataDir() {
  if (process.env.WORK_HELPER_DATA_DIR) return process.env.WORK_HELPER_DATA_DIR;
  const home = os.homedir();
  let appData;
  if (process.platform === 'win32') {
    appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    appData = path.join(home, 'Library', 'Application Support');
  } else {
    appData = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  return path.join(appData, 'work-helper', 'data');
}

function endpointPath(dataDir) {
  return path.join(dataDir || defaultDataDir(), ENDPOINT_FILE);
}

function normalizeEndpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const port = Number(raw.port);
  const token = String(raw.token || '');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const host = '127.0.0.1';
  return {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    name: String(raw.name || 'work-helper'),
    version: String(raw.version || ''),
    pid: Number.isInteger(Number(raw.pid)) ? Number(raw.pid) : null,
    host,
    port,
    token,
    url: `http://${host}:${port}/mcp`,
    startedAt: Number(raw.startedAt) || 0,
    proxyPath: raw.proxyPath ? String(raw.proxyPath) : '',
    execPath: raw.execPath ? String(raw.execPath) : ''
  };
}

function readEndpoint(options) {
  const settings = options || {};
  const file = settings.endpointFile || endpointPath(settings.dataDir);
  try {
    if (!fs.existsSync(file)) return null;
    return normalizeEndpoint(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (error) {
    return null;
  }
}

/** 原子写入，避免代理读到半截 JSON。权限尽量收紧到仅当前用户。 */
function writeEndpoint(dataDir, info) {
  const endpoint = normalizeEndpoint(info);
  if (!endpoint) throw new Error('MCP 端点信息无效');
  const file = endpointPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(endpoint, null, 2)}\n`, 'utf-8');
  try { fs.chmodSync(tmp, 0o600); } catch (error) { /* Windows 上权限位有限，忽略 */ }
  fs.renameSync(tmp, file);
  return endpoint;
}

/**
 * 停止服务时清理端点文件。
 * 只有文件仍属于本进程时才删，避免误删后启动实例写下的新端点。
 */
function removeEndpoint(dataDir, pid) {
  const file = endpointPath(dataDir);
  try {
    const current = readEndpoint({ dataDir });
    if (current && pid && current.pid && current.pid !== pid) return false;
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * 代理侧解析端点：显式 url+token 优先，其次端点文件。
 * 返回 { endpoint, dataDir, endpointFile, reason }，reason 用于给用户可读的失败原因。
 */
function resolveEndpoint(options) {
  const settings = options || {};
  const dataDir = settings.dataDir || defaultDataDir();
  const endpointFile = settings.endpointFile || endpointPath(dataDir);

  if (settings.url && settings.token) {
    let manual = null;
    try {
      manual = normalizeEndpoint({
        port: Number(new URL(settings.url).port) || 80,
        token: settings.token,
        name: settings.name || 'work-helper'
      });
    } catch (error) {
      manual = null;
    }
    if (manual) {
      manual.url = settings.url;
      return { endpoint: manual, dataDir, endpointFile, reason: '' };
    }
    return { endpoint: null, dataDir, endpointFile, reason: '手动指定的 MCP url 或 token 无效。' };
  }

  const endpoint = readEndpoint({ dataDir, endpointFile });
  if (!endpoint) {
    return {
      endpoint: null,
      dataDir,
      endpointFile,
      reason: `未找到 MCP 端点文件（${endpointFile}）。请先启动工作台助手，并在「设置 → 助手 → MCP 服务」中开启开关。`
    };
  }
  return { endpoint, dataDir, endpointFile, reason: '' };
}

module.exports = {
  ENDPOINT_FILE,
  ENDPOINT_SCHEMA_VERSION,
  defaultDataDir,
  endpointPath,
  normalizeEndpoint,
  readEndpoint,
  writeEndpoint,
  removeEndpoint,
  isProcessAlive,
  resolveEndpoint
};