'use strict';

/**
 * MCP streamable HTTP 传输层（应用内常驻）。
 *
 * 只绑定 127.0.0.1，要求 Bearer token，并校验 Host / Origin 以防 DNS rebinding。
 * 不依赖 Electron，可直接在 node --test 里启动真实端口做端到端验证。
 *
 * 协议语义全部交给 protocol.js 的 core，这里只做会话、framing 与访问控制。
 */

const http = require('http');
const crypto = require('crypto');

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 64;
const KEEPALIVE_MS = 25 * 1000;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(String(hostname || '').toLowerCase());
}

/** Host 头必须是本机回环，挡住把外部域名解析到 127.0.0.1 的重绑定攻击。 */
function isAllowedHost(header, port) {
  const value = String(header || '').toLowerCase().trim();
  if (!value) return false;
  const allowed = new Set([
    `${DEFAULT_HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`,
    DEFAULT_HOST, 'localhost', '[::1]'
  ]);
  return allowed.has(value);
}

function isAllowedOrigin(header) {
  if (!header) return true; // 非浏览器客户端不带 Origin
  const value = String(header).trim();
  if (value === 'null') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLocalHostname(url.hostname);
  } catch (error) {
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        // 不直接销毁 socket：先把 413 响应送回客户端，剩余数据用 resume 丢弃。
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders) {
  const body = payload === undefined || payload === null ? '' : JSON.stringify(payload);
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }, extraHeaders || {}));
  res.end(body);
}

function createHttpTransport(options) {
  const config = options || {};
  const core = config.core;
  if (!core || typeof core.handle !== 'function') throw new Error('HTTP 传输需要 MCP core');
  const token = String(config.token || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('MCP token 无效');
  const host = DEFAULT_HOST;
  const logger = config.logger || { warn: () => {}, error: () => {} };
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const sessionTtlMs = Number(config.sessionTtlMs) || SESSION_TTL_MS;

  const sessions = new Map();
  let server = null;
  let actualPort = 0;
  let keepaliveTimer = null;

  function pruneSessions() {
    const cutoff = now() - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) closeSession(id);
    }
    while (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!oldest) break;
      closeSession(oldest[0]);
    }
  }

  function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return false;
    for (const stream of session.streams) {
      try { stream.end(); } catch (error) { /* 已断开 */ }
    }
    session.streams.clear();
    sessions.delete(id);
    return true;
  }

  function createSession() {
    pruneSessions();
    const id = crypto.randomBytes(16).toString('hex');
    const session = { id, initialized: false, protocolVersion: null, clientInfo: null, createdAt: now(), lastSeen: now(), streams: new Set() };
    sessions.set(id, session);
    return session;
  }

  function authorize(req, res) {
    if (!isAllowedHost(req.headers.host, actualPort)) {
      sendJson(res, 403, { error: 'Host 头不是本机回环地址，已拒绝。' });
      return false;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'Origin 不是本机来源，已拒绝。' });
      return false;
    }
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !secureEqual(match[1], token)) {
      sendJson(res, 401, { error: '缺少或错误的 Bearer token。' }, { 'WWW-Authenticate': 'Bearer realm="work-helper-mcp"' });
      return false;
    }
    return true;
  }

  /** 处理一条或一批 JSON-RPC 消息，返回 { responses, session, initialized } */
  async function dispatch(payload, session) {
    const messages = Array.isArray(payload) ? payload : [payload];
    const responses = [];
    let activeSession = session;
    let issuedSessionId = null;

    for (const message of messages) {
      const isInitialize = message && typeof message === 'object' && message.method === 'initialize';
      if (isInitialize && !activeSession) {
        activeSession = createSession();
        issuedSessionId = activeSession.id;
      }
      if (activeSession) activeSession.lastSeen = now();
      let response;
      try {
        response = await core.handle(message, activeSession);
      } catch (error) {
        logger.error('[mcp] 处理请求失败', error);
        response = {
          jsonrpc: '2.0',
          id: message && message.id !== undefined ? message.id : null,
          error: { code: -32603, message: `服务内部错误：${error && error.message || error}` }
        };
      }
      if (response) responses.push(response);
    }
    return { responses, session: activeSession, issuedSessionId };
  }

  async function handlePost(req, res) {
    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message } });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求体不是合法 JSON。' } });
      return;
    }

    const headerId = req.headers['mcp-session-id'];
    let session = headerId ? sessions.get(String(headerId)) : null;
    const touchesInitialize = (Array.isArray(payload) ? payload : [payload])
      .some((message) => message && typeof message === 'object' && message.method === 'initialize');

    if (!session && !touchesInitialize) {
      // 会话缺失（含已过期、已 DELETE、服务重启后）：按规范回 404，客户端应重新 initialize。
      // 不依赖 sessions.size，否则最后一个会话被 DELETE 后旧 ID 会漏到 -32002/HTTP 200。
      sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: '会话不存在或已过期，请重新 initialize。' } });
      return;
    }

    const { responses, issuedSessionId } = await dispatch(payload, session || null);
    const headers = {};
    if (issuedSessionId) headers['Mcp-Session-Id'] = issuedSessionId;
    if (!responses.length) {
      res.writeHead(202, Object.assign({ 'Cache-Control': 'no-store' }, headers));
      res.end();
      return;
    }
    const body = Array.isArray(payload) ? responses : responses[0];
    sendJson(res, 200, body, headers);
  }

  function handleStream(req, res) {
    const session = sessions.get(String(req.headers['mcp-session-id'] || ''));
    if (!session) {
      sendJson(res, 404, { error: '会话不存在或已过期，请重新 initialize。' });
      return;
    }
    const accept = String(req.headers.accept || '');
    if (!accept.includes('text/event-stream')) {
      sendJson(res, 406, { error: 'GET /mcp 需要 Accept: text/event-stream。' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    session.streams.add(res);
    session.lastSeen = now();
    req.on('close', () => {
      session.streams.delete(res);
      try { res.end(); } catch (error) { /* 已断开 */ }
    });
  }

  function handleDelete(req, res) {
    const id = String(req.headers['mcp-session-id'] || '');
    const closed = closeSession(id);
    if (!closed) {
      sendJson(res, 404, { error: '会话不存在或已结束。' });
      return;
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  async function handler(req, res) {
    try {
      const url = String(req.url || '').split('?')[0];
      if (url === '/health') {
        if (!authorize(req, res)) return;
        sendJson(res, 200, { ok: true, name: 'work-helper', version: core.version, tools: core.toolCount, sessions: sessions.size });
        return;
      }
      if (url !== '/mcp') {
        sendJson(res, 404, { error: '未找到该路径，MCP 端点是 /mcp。' });
        return;
      }
      if (!authorize(req, res)) return;

      if (req.method === 'POST') return await handlePost(req, res);
      if (req.method === 'GET') return handleStream(req, res);
      if (req.method === 'DELETE') return handleDelete(req, res);
      sendJson(res, 405, { error: `不支持 ${req.method}，请用 POST / GET / DELETE。` }, { Allow: 'POST, GET, DELETE' });
    } catch (error) {
      logger.error('[mcp] 请求处理异常', error);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: '服务内部错误。' } });
      else res.end();
    }
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const instance = http.createServer(handler);
      instance.once('error', reject);
      instance.listen(port, host, () => {
        instance.removeListener('error', reject);
        resolve(instance);
      });
    });
  }

  async function start() {
    if (server) return { host, port: actualPort, url: `http://${host}:${actualPort}/mcp` };
    const preferred = Number(config.port) || 0;
    let instance;
    try {
      instance = await listen(preferred);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || !preferred) throw error;
      // 首选端口被占用时退到系统分配端口，端点文件与设置页会同步更新。
      logger.warn(`[mcp] 端口 ${preferred} 被占用，改用系统分配端口`);
      instance = await listen(0);
    }
    server = instance;
    actualPort = server.address().port;
    server.on('error', (error) => logger.error('[mcp] 服务错误', error));
    keepaliveTimer = setInterval(() => {
      pruneSessions();
      for (const session of sessions.values()) {
        for (const stream of session.streams) {
          try { stream.write(': keepalive\n\n'); } catch (error) { session.streams.delete(stream); }
        }
      }
    }, KEEPALIVE_MS);
    if (keepaliveTimer.unref) keepaliveTimer.unref();
    return { host, port: actualPort, url: `http://${host}:${actualPort}/mcp` };
  }

  async function stop() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    for (const id of [...sessions.keys()]) closeSession(id);
    const instance = server;
    server = null;
    actualPort = 0;
    if (!instance) return;
    await new Promise((resolve) => {
      if (typeof instance.closeAllConnections === 'function') instance.closeAllConnections();
      instance.close(() => resolve());
      // close 会等待空闲连接，兜底超时后直接 resolve，避免退出卡住。
      setTimeout(resolve, 1500).unref?.();
    });
  }

  return Object.freeze({
    start,
    stop,
    isRunning: () => !!server,
    port: () => actualPort,
    host: () => host,
    url: () => (server ? `http://${host}:${actualPort}/mcp` : ''),
    sessionCount: () => sessions.size
  });
}

module.exports = {
  createHttpTransport,
  secureEqual,
  isAllowedHost,
  isAllowedOrigin,
  MAX_BODY_BYTES,
  SESSION_TTL_MS
};