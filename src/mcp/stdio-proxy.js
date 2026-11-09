#!/usr/bin/env node
'use strict';

/**
 * MCP stdio ↔ 应用内 HTTP 代理（零运行时依赖）。
 *
 * MCP 客户端（Claude Desktop / Cursor / Qoder 等）以 stdio 方式拉起本脚本，
 * 脚本把 JSON-RPC 逐条转发到运行中的工作台助手 /mcp 端点，并把响应写回 stdout。
 *
 * 约束：
 * - stdout 只允许出现 JSON-RPC 消息，所有日志走 stderr；
 * - 端点信息每次请求都重新读取，应用后启动或重启也能自动恢复；
 * - 应用未运行 / 未开启 MCP 时返回明确的 JSON-RPC 错误，不静默失败；
 * - 会话过期（HTTP 404）时自动重新 initialize 并重试一次，initialize 不改动任何数据。
 *
 * 用法：node src/mcp/stdio-proxy.js [--data-dir=...] [--endpoint=...] [--url=... --token=...]
 * 打包后可用 WorkHelper.exe 配合 ELECTRON_RUN_AS_NODE=1 直接执行本脚本。
 */

const http = require('http');
const { resolveEndpoint } = require('./endpoint');

const DISCOVERY = {
  dataDir: argValue('data-dir') || process.env.WORK_HELPER_DATA_DIR || '',
  endpointFile: argValue('endpoint') || process.env.WORK_HELPER_MCP_ENDPOINT || '',
  url: argValue('url') || process.env.WORK_HELPER_MCP_URL || '',
  token: argValue('token') || process.env.WORK_HELPER_MCP_TOKEN || ''
};
const TIMEOUT_MS = Math.max(1000, Number(argValue('timeout')) || 60000);
const SERVER_UNAVAILABLE = -32000;
const SESSION_EXPIRED = -32001;

let sessionId = '';
let lastInitialize = null;
let chain = Promise.resolve();
let stdoutDrain = null;

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function log(...parts) {
  process.stderr.write(`[work-helper-mcp] ${parts.join(' ')}\n`);
}

function writeMessage(message) {
  return new Promise((resolve) => {
    const line = `${JSON.stringify(message)}\n`;
    if (process.stdout.write(line)) return resolve();
    // 背压：等 drain 再继续，避免大响应把内存堆满。
    stdoutDrain = resolve;
    process.stdout.once('drain', () => {
      const pending = stdoutDrain;
      stdoutDrain = null;
      if (pending) pending();
    });
  });
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function requestIds(payload) {
  const list = Array.isArray(payload) ? payload : [payload];
  return list
    .filter((item) => item && typeof item === 'object' && typeof item.method === 'string' && item.id !== undefined && item.id !== null)
    .map((item) => item.id);
}

function parseSse(text) {
  const messages = [];
  let data = [];
  const flush = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    try { messages.push(JSON.parse(payload)); } catch (error) { log('忽略无法解析的 SSE 数据'); }
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  flush();
  return messages;
}

function post(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(endpoint.url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${endpoint.token}`
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const nextSession = res.headers['mcp-session-id'];
        if (nextSession) sessionId = String(nextSession);
        resolve({
          status: res.statusCode || 0,
          contentType: String(res.headers['content-type'] || ''),
          text: Buffer.concat(chunks).toString('utf-8')
        });
      });
    });
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error(`等待应用响应超过 ${TIMEOUT_MS}ms`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function connectionMessage(error, endpoint) {
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
    return `无法连接工作台助手 MCP 服务（${endpoint.url}）。请确认应用正在运行，并已在「设置 → 助手 → MCP 服务」开启开关。`;
  }
  if (error && error.code === 'ETIMEDOUT') return error.message;
  return `转发 MCP 请求失败：${error && error.message || error}`;
}

async function emitResponses(response, ids) {
  if (response.status === 202 || !response.text.trim()) return;
  let messages;
  if (response.contentType.includes('text/event-stream')) {
    messages = parseSse(response.text);
  } else {
    try {
      const parsed = JSON.parse(response.text);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      messages = [errorResponse(ids[0] !== undefined ? ids[0] : null, SERVER_UNAVAILABLE, `应用返回了无法解析的响应（HTTP ${response.status}）。`)];
    }
  }
  for (const message of messages) {
    // 只把响应写回客户端；服务端主动通知/请求（带 method）在本代理中不支持。
    // id 为 null 的错误响应也要回传，否则客户端会一直等待。
    if (message && typeof message === 'object' && typeof message.method !== 'string') {
      await writeMessage(message);
    }
  }
}

async function forward(payload) {
  const ids = requestIds(payload);
  const isInitialize = !Array.isArray(payload) && payload && payload.method === 'initialize';
  if (isInitialize) {
    lastInitialize = payload;
    sessionId = '';
  }

  const discovered = resolveEndpoint(DISCOVERY);
  if (!discovered.endpoint) {
    for (const id of ids) await writeMessage(errorResponse(id, SERVER_UNAVAILABLE, discovered.reason));
    return;
  }
  const endpoint = discovered.endpoint;

  let response;
  try {
    response = await post(endpoint, payload);
  } catch (error) {
    log(connectionMessage(error, endpoint));
    for (const id of ids) await writeMessage(errorResponse(id, SERVER_UNAVAILABLE, connectionMessage(error, endpoint)));
    return;
  }

  // 会话过期：重新 initialize 后重试一次，避免客户端因应用重启而彻底失联。
  if (response.status === 404 && !isInitialize && lastInitialize) {
    sessionId = '';
    try {
      const renewed = await post(endpoint, lastInitialize);
      if (renewed.status === 200) response = await post(endpoint, payload);
    } catch (error) {
      log('重新初始化失败', error && error.message);
    }
  }

  if (response.status === 404) {
    for (const id of ids) {
      await writeMessage(errorResponse(id, SESSION_EXPIRED, 'MCP 会话已过期且无法自动恢复，请让客户端重新连接（重启对话或重载 MCP 服务）。'));
    }
    return;
  }
  if (response.status === 401 || response.status === 403) {
    for (const id of ids) {
      await writeMessage(errorResponse(id, SERVER_UNAVAILABLE, `应用拒绝了代理请求（HTTP ${response.status}）。token 可能已轮换，请在设置页重新复制客户端配置。`));
    }
    return;
  }
  if (response.status >= 400) {
    for (const id of ids) {
      await writeMessage(errorResponse(id, SERVER_UNAVAILABLE, `应用返回 HTTP ${response.status}：${response.text.slice(0, 300)}`));
    }
    return;
  }
  await emitResponses(response, ids);
}

function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    chain = chain.then(() => writeMessage(errorResponse(null, -32700, 'stdin 收到无法解析的 JSON。')));
    return;
  }
  chain = chain.then(() => forward(payload)).catch(async (error) => {
    log('转发异常', error && error.stack || error);
    for (const id of requestIds(payload)) {
      await writeMessage(errorResponse(id, -32603, `代理内部错误：${error && error.message || error}`));
    }
  });
}

function shutdown() {
  chain.finally(() => {
    process.exit(0);
  });
}

if (process.argv.includes('--help')) {
  process.stderr.write([
    '工作台助手 MCP stdio 代理',
    '  --data-dir=<dir>    数据目录（默认按平台 appData 推导，或用 WORK_HELPER_DATA_DIR）',
    '  --endpoint=<file>   直接指定 mcp-endpoint.json',
    '  --url=<url> --token=<token>  跳过端点文件，手动指定',
    '  --timeout=<ms>      单次请求超时，默认 60000',
    ''
  ].join('\n'));
  process.exit(0);
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) handleLine(buffer);
  buffer = '';
  shutdown();
});
process.stdin.on('error', (error) => {
  log('stdin 错误', error && error.message);
  shutdown();
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  log('未捕获异常', error && error.stack || error);
});