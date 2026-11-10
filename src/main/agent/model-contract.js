'use strict';

const MODEL_CONTRACT_VERSION = 1;

class ModelContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ModelContractError(code, message);
}

function extractJsonObject(content) {
  const raw = String(content || '').trim();
  if (!raw) fail('MODEL_OUTPUT_EMPTY', '模型最终回复为空');

  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const json = (fence ? fence[1] : raw).trim();
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    fail('MODEL_OUTPUT_INVALID_JSON', '模型回复不是有效 JSON');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    fail('MODEL_OUTPUT_INVALID_SHAPE', '模型回复必须是 JSON 对象');
  }
  return value;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('MODEL_OUTPUT_INVALID_FIELD', `模型字段 ${field} 必须是文本`);
  return value.trim().slice(0, maxLength);
}

function optionalStringList(value, field, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('MODEL_OUTPUT_INVALID_FIELD', `模型字段 ${field} 必须是文本数组`);
  }
  return value.map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
}

function optionalEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) fail('MODEL_OUTPUT_INVALID_FIELD', `模型字段 ${field} 的值无效`);
  return value;
}

function optionalInteger(value, field, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('MODEL_OUTPUT_INVALID_FIELD', `模型字段 ${field} 必须是 ${min} 到 ${max} 的整数`);
  }
  return number;
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail('MODEL_OUTPUT_INVALID_FIELD', `模型字段 ${field} 必须是布尔值`);
  return value;
}

function normalizeAction(parsed, allowedIntents) {
  if (typeof parsed.intent !== 'string' || !allowedIntents.includes(parsed.intent)) {
    fail('MODEL_OUTPUT_INVALID_INTENT', '模型返回了未知意图');
  }

  const usesPriority = ['create', 'update', 'query', 'batch'].includes(parsed.intent);
  const pri = !usesPriority || parsed.pri === undefined || parsed.pri === null ? undefined : Number(parsed.pri);
  if (pri !== undefined && ![1, 2, 3, 4].includes(pri)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 pri 必须是 1 到 4');
  }
  const usesDays = parsed.intent === 'update';
  const days = !usesDays || parsed.days === undefined || parsed.days === null ? undefined : Number(parsed.days);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 days 必须是有效正整数');
  }

  const usesDue = parsed.intent === 'create' || parsed.intent === 'update';
  const due = usesDue ? optionalString(parsed.due, 'due', 32) : '';
  if (due && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(due)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 due 必须使用 YYYY-MM-DD HH:mm 格式');
  }
  const usesReschedule = parsed.intent === 'batch';
  const rescheduleTime = usesReschedule ? optionalString(parsed.rescheduleTime, 'rescheduleTime', 5) : '';
  if (rescheduleTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rescheduleTime)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 rescheduleTime 必须使用 HH:mm 格式');
  }
  const rescheduleScope = usesReschedule
    ? optionalEnum(parsed.rescheduleScope, 'rescheduleScope', ['today', 'tomorrow'], 'today') : undefined;
  const onlyRemaining = usesReschedule ? optionalBoolean(parsed.onlyRemaining, 'onlyRemaining') : undefined;

  return {
    intent: parsed.intent,
    params: {
      title: optionalString(parsed.title, 'title', 200),
      memoTitle: optionalString(parsed.memoTitle, 'memoTitle', 200),
      memoContent: optionalString(parsed.memoContent, 'memoContent', 12000),
      target: optionalString(parsed.target, 'target', 200),
      pri,
      due: due || null,
      tags: optionalStringList(parsed.tags, 'tags', 5, 40),
      project: optionalString(parsed.project, 'project', 100),
      desc: optionalString(parsed.desc, 'desc', 4000),
      note: optionalString(parsed.note, 'note', 4000),
      days,
      estimatedMinutes: ['create', 'update'].includes(parsed.intent)
        ? optionalInteger(parsed.estimatedMinutes, 'estimatedMinutes', 5, 480) : undefined,
      date: parsed.intent === 'record_query' ? optionalString(parsed.date, 'date', 10) : undefined,
      offset: parsed.intent === 'record_query' ? optionalInteger(parsed.offset, 'offset', -1, 1) : undefined,
      period: parsed.intent === 'record_query'
        ? optionalEnum(parsed.period, 'period', ['daily', 'weekly'], undefined) : undefined,
      status: ['query', 'batch'].includes(parsed.intent)
        ? optionalEnum(parsed.status, 'status', ['todo', 'doing', 'done'], undefined)
        : parsed.intent === 'update'
          ? optionalEnum(parsed.status, 'status', ['todo', 'doing', 'done', 'archived'], undefined) : undefined,
      rescheduleTime: usesReschedule ? (rescheduleTime || undefined) : undefined,
      rescheduleScope,
      onlyRemaining,
      range: parsed.intent === 'query'
        ? optionalEnum(parsed.range, 'range', ['today', 'tomorrow', 'week', 'yesterday', 'overdue', 'all'], 'all') : 'all'
    }
  };
}

function normalizeModelResponse(content, allowedIntents) {
  const parsed = extractJsonObject(content);
  const version = parsed.schemaVersion === undefined ? MODEL_CONTRACT_VERSION : Number(parsed.schemaVersion);
  if (version !== MODEL_CONTRACT_VERSION) {
    fail('MODEL_OUTPUT_UNSUPPORTED_VERSION', `不支持的模型契约版本：${parsed.schemaVersion}`);
  }

  const confidence = optionalEnum(parsed.confidence, 'confidence', ['high', 'medium', 'low'], 'high');
  const clarification = optionalString(parsed.clarification, 'clarification', 500);
  const reply = optionalString(parsed.reply, 'reply', 4000);
  if (parsed.actions !== undefined) {
    if (!Array.isArray(parsed.actions) || parsed.actions.length < 2 || parsed.actions.length > 5) {
      fail('MODEL_OUTPUT_INVALID_PLAN', '模型字段 actions 必须包含 2 到 5 个操作');
    }
    return {
      schemaVersion: MODEL_CONTRACT_VERSION,
      intent: 'plan',
      confidence,
      clarification,
      params: { actions: parsed.actions.map((action) => normalizeAction(action, allowedIntents)) },
      reply
    };
  }

  const action = normalizeAction(parsed, allowedIntents);
  return {
    schemaVersion: MODEL_CONTRACT_VERSION,
    intent: action.intent,
    confidence,
    clarification,
    params: action.params,
    reply
  };
}

module.exports = {
  MODEL_CONTRACT_VERSION,
  ModelContractError,
  normalizeModelResponse
};
