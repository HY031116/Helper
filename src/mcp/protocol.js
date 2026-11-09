'use strict';

/**
 * MCP（Model Context Protocol）协议核心。
 *
 * 零运行时依赖、不 require electron，可在纯 Node 下直接测试。
 * 只负责 JSON-RPC 语义与工具映射，传输层（HTTP / stdio）在别的文件里。
 *
 * 工具清单复用现有 agent 体系：
 * - inputSchema 直接取自 src/main/agent/tool-schemas.js 的 JSON Schema；
 * - readOnlyHint / destructiveHint 由 tool-registry.js 的 effect / dangerous 元数据推导。
 *
 * 安全边界：外部调用走 ai.executeExternalTool，不经过 finalizeResult / rememberOutcome，
 * 因此不会写入应用侧对话的 pending 状态，也不会借用应用内「最近提到」隐式选目标。
 */

const { AGENT_TOOLS } = require('../main/agent/tool-schemas');
const { getToolDefinition } = require('../main/agent/tool-registry');

const SERVER_NAME = 'work-helper';
const SERVER_TITLE = '工作台助手';
const TOOL_PREFIX = 'workhelper_';
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32002
});

const INSTRUCTIONS = [
  '这是用户本机的工作台助手，管理任务、备忘录、日计划、专注与报告。所有数据留在本机。',
  '工具名统一带 workhelper_ 前缀。操作任务优先用 taskId，操作备忘录优先用 memoId；只给标题时若匹配多项会返回 ambiguous，必须让用户选择后再调用，不要自行挑第一项。',
  '删除、批量等破坏性操作首次调用只会返回 confirmation_required，数据不会变化。必须先向用户复述将发生什么并取得明确同意，才可以按返回的 nextCall 再调用一次；严禁自行确认或反复重试。',
  '查询类问题先用 workhelper_query / workhelper_memo_query / workhelper_stats 拿实时数据，不要凭记忆回答。',
  '写操作返回的 undo 描述符可原样交给 workhelper_undo 撤销；撤销前数据若已变化会被拒绝，不会强行覆盖。'
].join('\n');

/* 已有 handler 但未进入模型工具清单的能力，对外部 agent 同样有用（报告、组合操作、恢复、撤销）。 */
const EXTRA_TOOL_SCHEMAS = Object.freeze([
  {
    intent: 'report',
    description: '生成日报或周报的 Markdown，纯本地统计，不调用外部模型。period=daily 为日报、weekly 为周报；offset 为 0 表示本期，-1 上一期，1 下一期。',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['daily', 'weekly'], description: '报告周期，默认 weekly' },
        offset: { type: 'integer', description: '相对本期的偏移：0 本期，-1 上一期，1 下一期' }
      }
    }
  },
  {
    intent: 'plan',
    description: '把 2 到 5 个安全操作组合成一组：首次调用返回整组预览（confirmation_required），用户同意后带 confirmed=true 再调用，整组原子执行，任一步失败全部回滚。只支持不含删除/批量的安全操作，每个步骤都要给出明确目标。',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 2,
          maxItems: 5,
          description: '按执行顺序排列的步骤',
          items: {
            type: 'object',
            properties: {
              intent: { type: 'string', description: '步骤意图，如 create / complete / start / update / postpone / child / memo_create' },
              params: { type: 'object', description: '该步骤的参数，字段与同名工具的 inputSchema 一致' }
            },
            required: ['intent', 'params']
          }
        },
        confirmed: { type: 'boolean', description: '用户已明确同意整组执行时才置为 true' }
      },
      required: ['actions']
    }
  },
  {
    intent: 'restore',
    description: '从回收站恢复已删除任务，或把归档任务取消归档。优先用 taskId；只给标题且匹配多项时返回候选，需用户选择。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'integer', description: '任务 ID' },
        target: { type: 'string', description: '任务标题（可模糊匹配）' }
      }
    }
  },
  {
    intent: 'undo',
    description: '撤销上一次工具返回的 undo 描述符（原样回传，不要自行构造）。若数据在撤销前又被改动，会拒绝执行并说明冲突。',
    parameters: {
      type: 'object',
      properties: {
        undo: { type: 'object', description: '先前工具结果里的 undo 对象，例如 { action: "restore", id: 101 }' }
      },
      required: ['undo']
    }
  }
]);

const TOOL_TITLES = Object.freeze({
  query: '查询任务',
  stats: '任务统计',
  suggest: '下一步建议',
  summary: '今日小结',
  report: '生成报告',
  create: '创建任务',
  complete: '完成任务',
  start: '开始任务',
  update: '修改任务',
  child: '添加子任务',
  postpone: '顺延截止时间',
  delete: '删除任务',
  archive: '归档任务',
  split: '拆分任务',
  batch: '批量操作',
  restore: '恢复任务',
  plan: '组合操作',
  undo: '撤销操作',
  memo_create: '创建备忘录',
  memo_query: '查询备忘录',
  memo_pin: '置顶备忘录',
  memo_to_task: '备忘录转任务',
  memo_split: '拆分备忘录',
  memo_delete: '删除备忘录',
  daily_plan: '生成日计划',
  daily_replan: '重排日计划',
  daily_review: '每日复盘',
  focus_start: '开始专注',
  focus_pause: '暂停专注',
  focus_resume: '继续专注',
  focus_interrupt: '记录打断',
  focus_finish: '结束专注'
});

const CONFIRMATION_SUFFIX = '（破坏性操作：首次调用只返回 confirmation_required，必须取得用户明确同意后才会真正执行。）';

function buildToolCatalog() {
  const sources = [
    ...AGENT_TOOLS.map((tool) => ({
      intent: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters || { type: 'object', properties: {} }
    })),
    ...EXTRA_TOOL_SCHEMAS.map((tool) => ({
      intent: tool.intent,
      description: tool.description,
      inputSchema: tool.parameters
    }))
  ];

  const seen = new Set();
  const catalog = [];
  for (const source of sources) {
    const definition = getToolDefinition(source.intent);
    // undo 没有 intent 定义，它直接包装 ai.undoAction；其余必须已注册，避免暴露空壳工具。
    if (!definition && source.intent !== 'undo') continue;
    if (seen.has(source.intent)) continue;
    seen.add(source.intent);

    const readOnly = !!definition && definition.effect === 'read';
    const dangerous = !!definition && !!definition.dangerous;
    catalog.push(Object.freeze({
      name: TOOL_PREFIX + source.intent,
      title: TOOL_TITLES[source.intent] || source.intent,
      description: dangerous ? `${source.description}${CONFIRMATION_SUFFIX}` : source.description,
      inputSchema: source.inputSchema,
      annotations: Object.freeze({
        title: TOOL_TITLES[source.intent] || source.intent,
        readOnlyHint: readOnly,
        destructiveHint: dangerous,
        idempotentHint: readOnly,
        openWorldHint: false
      })
    }));
  }
  return Object.freeze(catalog);
}

const TOOL_CATALOG = buildToolCatalog();
const TOOL_NAMES = Object.freeze(TOOL_CATALOG.map((tool) => tool.name));
const INTENTS_BY_NAME = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool.name.slice(TOOL_PREFIX.length)]));

/** 工具名 → intent。同时容忍客户端去掉前缀的写法。 */
function resolveIntent(name) {
  if (typeof name !== 'string' || !name) return null;
  if (INTENTS_BY_NAME.has(name)) return INTENTS_BY_NAME.get(name);
  if (INTENTS_BY_NAME.has(TOOL_PREFIX + name)) return name;
  return null;
}

/* ---------- 结果安全化：structuredContent 必须是可序列化、有界、无环的纯数据 ---------- */
function sanitize(value, depth, seen) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return value.length > 20000 ? `${value.slice(0, 20000)}…（已截断）` : value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type !== 'object') return null;
  if (depth <= 0) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitize(item, depth - 1, seen));
  }
  const output = {};
  for (const key of Object.keys(value).slice(0, 80)) {
    if (key.startsWith('__')) continue;
    const item = sanitize(value[key], depth - 1, seen);
    if (item !== null || value[key] === null) output[key] = item;
  }
  return output;
}

function jsonSafe(value) {
  return sanitize(value, 7, new WeakSet());
}

function textContent(text) {
  return [{ type: 'text', text: String(text || '').trim() || '（工具没有返回文案）' }];
}

/**
 * 把本地 handler 的结果转成 MCP tools/call 结果。
 * confirm / ask / clarify 都不是错误，而是「尚未执行、需要人介入」的结构化状态，
 * 外部 agent 必须把它们交还给用户，而不是自行补确认参数重试。
 */
function toToolCallResult(intent, rawResult) {
  const toolName = TOOL_PREFIX + intent;
  let result = rawResult && typeof rawResult === 'object' ? rawResult : null;

  if (intent === 'undo') {
    if (!result) result = { type: 'error', message: '没有可撤销的操作，或这个 undo 描述符已失效。' };
    else if (result.ok === false) result = { type: 'error', message: result.message || '撤销未执行。', reason: result.reason || '' };
    else result = { type: 'undo', message: result.message || '已撤销上一步操作。', ok: true };
  }
  if (!result) result = { type: 'error', message: '工具没有返回结果。' };

  const message = String(result.message || '').trim();

  if (result.type === 'confirm' && result.confirmation) {
    const purpose = result.confirmation.purpose || 'safety';
    const flag = purpose === 'interpretation'
      ? 'interpretationConfirmed'
      : purpose === 'fallback' ? 'localFallbackConfirmed' : 'confirmed';
    const params = Object.assign({}, result.confirmation.params);
    params[flag] = true;
    return {
      isError: false,
      content: textContent([
        message,
        '这次操作尚未执行，数据没有任何变化。请先向用户复述将发生什么并取得明确同意，再按 nextCall 原样调用一次；不得自行确认。'
      ].filter(Boolean).join('\n\n')),
      structuredContent: jsonSafe({
        status: 'confirmation_required',
        intent,
        message,
        detail: result.confirmation.detail || '',
        purpose,
        nextCall: { name: toolName, arguments: params }
      })
    };
  }

  if (result.type === 'ask' && Array.isArray(result.candidates)) {
    const definition = getToolDefinition(intent);
    const idField = definition && definition.targetType === 'memo' ? 'memoId' : 'taskId';
    return {
      isError: false,
      content: textContent([
        message,
        `匹配到多项，尚未执行。请让用户选择其中一项，再带上 ${idField} 重新调用 ${toolName}；不要自行挑第一项。`
      ].filter(Boolean).join('\n\n')),
      structuredContent: jsonSafe({
        status: 'ambiguous',
        intent,
        message,
        idField,
        candidates: result.candidates
      })
    };
  }

  if (result.type === 'clarify') {
    const clarification = result.clarification || {};
    return {
      isError: false,
      content: textContent([
        message,
        '缺少必要信息，尚未执行。请向用户追问后补齐参数再调用。'
      ].filter(Boolean).join('\n\n')),
      structuredContent: jsonSafe({
        status: 'clarification_required',
        intent,
        message,
        field: clarification.field || '',
        params: clarification.params || {}
      })
    };
  }

  if (result.type === 'error' || result.type === 'unknown' || result.ok === false) {
    return {
      isError: true,
      content: textContent(message || '工具执行失败。'),
      structuredContent: jsonSafe({ status: 'error', intent, message: message || '工具执行失败。', reason: result.reason || '' })
    };
  }

  const parts = [message];
  if (Array.isArray(result.taskIds) && result.taskIds.length) {
    parts.push(`任务 ID（与上方条目顺序一致）：${result.taskIds.join(', ')}`);
  }
  if (Array.isArray(result.memoIds) && result.memoIds.length) {
    parts.push(`备忘录 ID（与上方条目顺序一致）：${result.memoIds.join(', ')}`);
  }
  if (typeof result.markdown === 'string' && result.markdown.trim()) {
    parts.push(result.markdown.trim());
  }
  return {
    isError: false,
    content: textContent(parts.filter(Boolean).join('\n\n')),
    structuredContent: jsonSafe(Object.assign({ status: 'ok', intent }, result))
  };
}

function rpcError(id, code, message, data) {
  const error = { code, message: String(message || '') };
  if (data !== undefined) error.data = jsonSafe(data);
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/**
 * 创建协议核心。transport 负责会话对象与 framing，这里只管方法语义。
 * @param {object} options
 * @param {string} options.version 应用版本号
 * @param {(intent:string, params:object)=>any} options.executeTool 本地工具执行入口
 * @param {(undo:object)=>any} [options.undoTool] 撤销入口
 */
function createMcpCore(options) {
  const config = options || {};
  if (typeof config.executeTool !== 'function') throw new Error('MCP core 需要 executeTool 函数');
  const executeTool = config.executeTool;
  const undoTool = typeof config.undoTool === 'function' ? config.undoTool : () => null;
  const version = String(config.version || '0.0.0');

  function requireSession(id, session) {
    if (session && session.initialized) return null;
    return rpcError(id, ERROR_CODES.NOT_INITIALIZED, '会话尚未初始化，请先发送 initialize 请求。');
  }

  async function handle(message, session) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, ERROR_CODES.INVALID_REQUEST, '请求必须是 JSON-RPC 2.0 对象。');
    }
    const id = message.id;
    const isNotification = id === undefined || id === null;
    // 客户端响应（我们从不主动发请求）与无法识别的帧一律忽略。
    if (typeof message.method !== 'string') return null;
    if (message.jsonrpc !== '2.0') {
      return isNotification ? null : rpcError(id, ERROR_CODES.INVALID_REQUEST, '缺少 jsonrpc: "2.0" 字段。');
    }

    const method = message.method;
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
      ? message.params
      : {};

    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      if (session) {
        session.protocolVersion = negotiated;
        session.clientInfo = jsonSafe(params.clientInfo || null);
        session.initialized = true;
      }
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version, title: SERVER_TITLE },
        instructions: INSTRUCTIONS
      });
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      if (session && method === 'notifications/initialized') session.readyNotification = true;
      return null;
    }

    if (method === 'ping') return rpcResult(id, {});

    if (method === 'tools/list') {
      const blocked = requireSession(id, session);
      if (blocked) return blocked;
      return rpcResult(id, { tools: TOOL_CATALOG.map((tool) => jsonSafe(tool)) });
    }

    if (method === 'tools/call') {
      const blocked = requireSession(id, session);
      if (blocked) return blocked;
      const intent = resolveIntent(params.name);
      if (!intent) {
        return rpcResult(id, {
          isError: true,
          content: textContent(`未知工具 ${String(params.name || '')}。请先用 tools/list 获取可用工具。`),
          structuredContent: { status: 'error', message: `未知工具 ${String(params.name || '')}` }
        });
      }
      const args = params.arguments;
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        return rpcError(id, ERROR_CODES.INVALID_PARAMS, 'arguments 必须是对象。');
      }
      let result;
      try {
        result = intent === 'undo'
          ? await undoTool((args || {}).undo)
          : await executeTool(intent, args || {});
      } catch (error) {
        result = { type: 'error', message: `工具执行失败：${error && error.message || error}` };
      }
      return rpcResult(id, toToolCallResult(intent, result));
    }

    // 未声明 resources / prompts 能力，但部分客户端仍会探测；返回空列表比报错更兼容。
    if (method === 'resources/list') return rpcResult(id, { resources: [] });
    if (method === 'resources/templates/list') return rpcResult(id, { resourceTemplates: [] });
    if (method === 'prompts/list') return rpcResult(id, { prompts: [] });

    if (isNotification) return null;
    return rpcError(id, ERROR_CODES.METHOD_NOT_FOUND, `不支持的方法 ${method}`);
  }

  return Object.freeze({
    version,
    toolCount: TOOL_CATALOG.length,
    toolNames: TOOL_NAMES,
    handle
  });
}

module.exports = {
  SERVER_NAME,
  SERVER_TITLE,
  TOOL_PREFIX,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ERROR_CODES,
  INSTRUCTIONS,
  TOOL_CATALOG,
  TOOL_NAMES,
  resolveIntent,
  toToolCallResult,
  jsonSafe,
  rpcError,
  rpcResult,
  createMcpCore
};