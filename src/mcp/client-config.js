'use strict';

/**
 * 生成可直接粘贴到 MCP 客户端的配置片段。
 *
 * stdio 片段用应用自带的运行时（打包后是 WorkHelper.exe，开发时是 electron.exe）
 * 配合 ELECTRON_RUN_AS_NODE=1 当作纯 Node 执行代理脚本，用户无需另装 Node。
 */

const SERVER_KEY = 'work-helper';

function stdioConfig(options) {
  const config = options || {};
  const command = String(config.execPath || process.execPath);
  const proxyPath = String(config.proxyPath || '');
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  if (config.dataDir) env.WORK_HELPER_DATA_DIR = String(config.dataDir);
  return {
    mcpServers: {
      [SERVER_KEY]: { command, args: [proxyPath], env }
    }
  };
}

function httpConfig(options) {
  const config = options || {};
  return {
    mcpServers: {
      [SERVER_KEY]: {
        url: String(config.url || ''),
        headers: { Authorization: `Bearer ${String(config.token || '')}` }
      }
    }
  };
}

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 供设置页展示：两段配置 + 说明。token 会出现在 HTTP 片段里，界面需按秘密处理。 */
function buildClientConfigs(options) {
  const config = options || {};
  const stdio = stdioConfig(config);
  const http = httpConfig(config);
  return {
    serverKey: SERVER_KEY,
    stdio: { json: pretty(stdio), command: stdio.mcpServers[SERVER_KEY].command, args: stdio.mcpServers[SERVER_KEY].args, env: stdio.mcpServers[SERVER_KEY].env },
    http: { json: pretty(http), url: http.mcpServers[SERVER_KEY].url, containsSecret: true }
  };
}

module.exports = { SERVER_KEY, stdioConfig, httpConfig, buildClientConfigs };