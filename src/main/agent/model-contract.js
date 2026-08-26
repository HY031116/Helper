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

  const usesPriority = ['create', 'update', 'query', 'stats', 'batch'].includes(parsed.intent);
  const pri = !usesPriority || parsed.pri === undefined || parsed.pri === null ? undefined : Number(parsed.pri);
  if (pri !== undefined && ![1, 2, 3, 4].includes(pri)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 pri 必须是 1 到 4');
  }
  const usesDays = parsed.intent === 'postpone';
  const days = !usesDays || parsed.days === undefined || parsed.days === null ? undefined : Number(parsed.days);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 days 必须是有效正整数');
  }
  const usesCount = parsed.intent === 'split' || parsed.intent === 'memo_split';
  const count = !usesCount ? undefined : (parsed.count === undefined || parsed.count === null ? 3 : Number(parsed.count));
  if (usesCount && (!Number.isInteger(count) || count < 2 || count > 8)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 count 必须是 2 到 8');
  }
  const usesPinned = parsed.intent === 'memo_pin';
  if (usesPinned && parsed.pinned !== undefined && typeof parsed.pinned !== 'boolean') {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 pinned 必须是布尔值');
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
  const usesDailyPlan = ['daily_plan', 'daily_replan'].includes(parsed.intent);
  const startTime = usesDailyPlan ? optionalString(parsed.startTime, 'startTime', 5) : '';
  if (startTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 startTime 必须使用 HH:mm 格式');
  }
  const endTime = usesDailyPlan ? optionalString(parsed.endTime, 'endTime', 5) : '';
  if (endTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 endTime 必须使用 HH:mm 格式');
  }
  const blockedTimes = usesDailyPlan ? optionalStringList(parsed.blockedTimes, 'blockedTimes', 8, 32) : [];
  if (blockedTimes.some((value) => !/^((?:[01]\d|2[0-3]):[0-5]\d)\s*[-~至到]\s*((?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))) {
    fail('MODEL_OUTPUT_INVALID_FIELD', '模型字段 blockedTimes 必须使用 HH:mm-HH:mm 格式');
  }

  return {
    intent: parsed.intent,
    params: {
      title: optionalString(parsed.title, 'title', 200),
      memoTitle: optionalString(parsed.memoTitle, 'memoTitle', 200),
      memoContent: optionalString(parsed.memoContent, 'memoContent', 12000),
      pinned: usesPinned ? parsed.pinned : undefined,
      target: optionalString(parsed.target, 'target', 200),
      count,
      steps: optionalStringList(parsed.steps, 'steps', 8, 200),
      pri,
      due: due || null,
      tags: optionalStringList(parsed.tags, 'tags', 5, 40),
      project: optionalString(parsed.project, 'project', 100),
      desc: optionalString(parsed.desc, 'desc', 4000),
      childTitle: optionalString(parsed.childTitle, 'childTitle', 200),
      days,
      estimatedMinutes: ['create', 'update'].includes(parsed.intent)
        ? optionalInteger(parsed.estimatedMinutes, 'estimatedMinutes', 5, 480) : undefined,
      availableMinutes: ['daily_plan', 'daily_replan'].includes(parsed.intent)
        ? optionalInteger(parsed.availableMinutes, 'availableMinutes', 30, 720) : undefined,
      startTime: usesDailyPlan ? startTime : undefined,
      endTime: usesDailyPlan ? endTime : undefined,
      focus: usesDailyPlan
        ? optionalString(parsed.focus, 'focus', 160) : undefined,
      include: usesDailyPlan
        ? optionalStringList(parsed.include, 'include', 5, 80) : undefined,
      exclude: usesDailyPlan
        ? optionalStringList(parsed.exclude, 'exclude', 8, 80) : undefined,
      blockedTimes: usesDailyPlan ? blockedTimes : undefined,
      targetMinutes: parsed.intent === 'focus_start'
        ? optionalInteger(parsed.targetMinutes, 'targetMinutes', 5, 240) : undefined,
      reason: optionalString(parsed.reason, 'reason', 240),
      note: optionalString(parsed.note, 'note', 1000),
      period: parsed.intent === 'report' ? optionalEnum(parsed.period, 'period', ['daily', 'weekly'], 'weekly') : undefined,
      offset: parsed.intent === 'report' ? optionalInteger(parsed.offset, 'offset', -1, 1) : undefined,
      completeTask: parsed.intent === 'focus_finish' ? optionalBoolean(parsed.completeTask, 'completeTask') : undefined,
      status: ['query', 'stats', 'batch'].includes(parsed.intent)
        ? optionalEnum(parsed.status, 'status', ['todo', 'doing', 'done'], undefined) : undefined,
      rescheduleTime: usesReschedule ? (rescheduleTime || undefined) : undefined,
      rescheduleScope,
      onlyRemaining,
      range: ['query', 'stats'].includes(parsed.intent)
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
