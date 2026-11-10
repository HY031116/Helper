'use strict';

const SEMANTIC_ENVELOPE_VERSION = 1;

const WRITE_INTENTS = new Set([
  'create', 'memo_create', 'memo_to_task', 'complete', 'delete', 'batch', 'update', 'plan'
]);
const READ_INTENTS = new Set(['memo_query', 'query', 'record_query', 'summary', 'greeting', 'thanks']);

function clean(value) {
  return String(value || '').trim();
}

function timeScopeOf(text) {
  const raw = clean(text);
  if (/过期|逾期/.test(raw)) return 'overdue';
  if (/昨天|昨日/.test(raw)) return 'yesterday';
  if (/后天/.test(raw)) return 'day_after_tomorrow';
  if (/明天|明日/.test(raw)) return 'tomorrow';
  if (/今天|今日/.test(raw)) return 'today';
  if (/下周|下个星期/.test(raw)) return 'next_week';
  if (/上周|上个星期/.test(raw)) return 'previous_week';
  if (/本周|这周|这个星期|周[一二三四五六日天]/.test(raw)) return 'week';
  if (/\d{1,2}月\d{1,2}日/.test(raw)) return 'date';
  return 'unspecified';
}

function explicitEntityType(text) {
  const raw = clean(text);
  const hasMemo = /(备忘录|笔记)/.test(raw);
  const hasTask = /(任务|待办)/.test(raw);
  if (hasMemo && hasTask) return 'mixed';
  if (hasMemo) return 'memo';
  if (hasTask) return 'task';
  return 'unknown';
}

function surfaceQuestionCue(text) {
  const raw = clean(text);
  return /[？?]\s*$/.test(raw) || /^(?:为什么|什么是|如何|怎么|怎样|为何|谁|哪一)/.test(raw) || /(?:吗|呢|了吗|了没|什么|哪些|多少|几个|几项|怎么|怎样|如何|为何|为什么|谁|哪一)[？?。！!]?\s*$/.test(raw);
}

function hasCompoundOperationCue(text) {
  return /(?:然后|再|同时|并且|另外|并)\s*(?:把|将)?\s*(?:创建|新建|建个|创个|添加|记下|记录|删除|删掉|完成|开始|归档|修改|改成|加(?:子任务|标签|备注)|顺延|推迟|拆分|拆成)/.test(clean(text));
}

function isProtectedCommand(intent, text) {
  const raw = clean(text);
  if (!raw || hasCompoundOperationCue(raw)) return false;
  if (['greeting', 'thanks', 'memo_query', 'summary', 'record_query'].includes(intent)) return true;
  if (intent === 'query') return /(查|看看|看一下|查看|列出|有哪些|有什么|做什么|干嘛|完成了吗|做完了吗)/.test(raw);
  if (surfaceQuestionCue(raw)) return false;
  const direct = {
    complete: '完成|搞定|勾掉',
    delete: '删除|删掉|移除',
    update: '改成|改为|改到|改优先级|改截止|改时间|改项目|移到|移动到|加标签|加备注|改描述|改备注|设为|安排到|排到|顺延|推迟|延后|延期|归档|收起来|恢复|还原|找回|撤销删除|开始|动手做|着手|启动',
    memo_to_task: '转为|转成|变成',
    batch: '清除|清空|清掉|删光|全删|全部|所有|批量|一键'
  }[intent];
  if (!direct) return false;
  return new RegExp(`^(?:请)?(?:帮我)?\\s*(?:(?:${direct})|(?:把|将|给|为)\\s*.+?(?:${direct}))`).test(raw);
}

function shorthandTaskFrame(text) {
  const raw = clean(text);
  const match = raw.match(/^(今日|今天|明日|明天)(?:的)?(?:任务|待办)\s*[:：-]?\s*(.*)$/);
  if (!match) return null;
  const payload = clean(match[2]);
  const queryPayload = !payload || /^(?:有|是|都|还有|还剩|包括|列表|清单|哪些|什么|多少|几|查|查看|看看|显示|列出|完成了吗|做完了吗|剩下)/.test(payload) || /(?:[？?]|了吗|吗|呢|哪些|什么|多少|几个|几项|几条)\s*$/.test(payload);
  return {
    intent: queryPayload ? 'query' : 'create',
    operationCue: queryPayload ? 'task_scope_query' : 'task_capture',
    payload: queryPayload ? '' : payload,
    entityType: 'task',
    timeScope: /明/.test(match[1]) ? 'tomorrow' : 'today',
    questionCue: queryPayload,
    protected: true,
    confidence: 'high'
  };
}

function explicitCreateFrame(text) {
  const raw = clean(text);
  const memo = raw.match(/^(?:请)?(?:帮我)?\s*(?:把)?\s*(?:记到|记进|写到|写进|存到|存进|放到|放进|添加到|加入)(?:我的)?备忘录\s*[:：]?\s*(.+)$|^(?:请)?(?:帮我)?\s*(?:新建备忘录|备忘一下)\s*[:：]?\s*(.+)$/);
  if (memo) {
    return { intent: 'memo_create', operationCue: 'explicit_memo_create', payload: clean(memo[1] || memo[2]), entityType: 'memo' };
  }
  const task = raw.match(/^(?:请)?(?:帮我)?\s*(?:(?:创建|新建)(?!备忘录|笔记)|添加(?:一个|一项|个|项)?(?:任务|待办)|记一下|帮我记|记个|记得|提醒我)\s*(?:一个|一项|个|项)?(?:任务|待办)?\s*[:：]?\s*(.*)$/);
  if (task) {
    return { intent: 'create', operationCue: 'explicit_task_create', payload: clean(task[1]), entityType: 'task' };
  }
  return null;
}

function semanticKind(intent) {
  if (WRITE_INTENTS.has(intent)) return 'write';
  if (READ_INTENTS.has(intent)) return 'read';
  return 'conversation';
}

function routeSemanticInput(text, options) {
  const config = options || {};
  const intentText = clean(text);
  const raw = clean(config.sourceText || text);
  const surfaceQuestion = surfaceQuestionCue(raw);
  const base = {
    schemaVersion: SEMANTIC_ENVELOPE_VERSION,
    raw,
    normalized: intentText,
    intent: 'chat',
    operationCue: 'conversation',
    entityType: config.contextEntityType || explicitEntityType(raw),
    payload: '',
    timeScope: timeScopeOf(raw),
    questionCue: surfaceQuestion,
    surfaceQuestionCue: surfaceQuestion,
    confidence: 'low',
    protected: false,
    route: 'model-assisted'
  };

  if (!raw) return Object.assign(base, { intent: 'unknown', operationCue: 'empty' });
  if (config.mode !== 'continuation') {
    const shorthand = shorthandTaskFrame(raw);
    if (shorthand && !hasCompoundOperationCue(raw)) return Object.assign(base, shorthand, { route: 'protected-local', surfaceQuestionCue: surfaceQuestion });
    const explicitCreate = explicitCreateFrame(raw);
    if (explicitCreate && !hasCompoundOperationCue(raw)) {
      return Object.assign(base, explicitCreate, {
        questionCue: false,
        confidence: explicitCreate.payload ? 'high' : 'medium',
        protected: !!explicitCreate.payload,
        route: explicitCreate.payload ? 'protected-local' : 'local-parse'
      });
    }
  }

  let intent = '';
  let cue = '';
  let entityType = base.entityType;
  let protectedIntent = false;
  let confidence = 'medium';
  const set = (nextIntent, operationCue, overrides) => {
    intent = nextIntent;
    cue = operationCue;
    if (overrides && overrides.entityType) entityType = overrides.entityType;
    if (overrides && overrides.protected) protectedIntent = true;
    if (overrides && overrides.confidence) confidence = overrides.confidence;
  };

  if (/^(你好|您好|嗨|哈喽|早上好|下午好|晚上好|嗨喽|hello|hi)\s*[，。！!?？]?\s*$/.test(intentText)) set('greeting', 'greeting', { confidence: 'high' });
  else if (/^(谢谢|感谢|多谢|辛苦了|ok|好的|谢谢啦)\s*[。！!]?\s*$/.test(intentText)) set('thanks', 'thanks', { confidence: 'high' });
  else if (/(备忘录|笔记|这条|它).*(转为|转成|变成).*任务|(把|将).*(备忘录|笔记).*(转为|转成).*任务/.test(intentText)) set('memo_to_task', 'memo_to_task', { entityType: 'memo', protected: true, confidence: 'high' });
  else if (/(删除|删掉|移除).*(备忘录|笔记)|(备忘录|笔记).*(删除|删掉|移除)/.test(intentText)) set('chat', 'memo_delete_request', { confidence: 'medium' });
  else if (/(置顶|取消置顶|不再置顶).*(备忘录|笔记|这条)|(备忘录|笔记).*(置顶|取消置顶)/.test(intentText)) set('chat', 'memo_pin_request', { confidence: 'medium' });
  else if (/(记到|记进|写到|写进|存到|存进|放到|放进|添加到|加入)(我的)?备忘录|新建备忘录|备忘一下/.test(intentText)) set('memo_create', 'memo_create', { entityType: 'memo', protected: true, confidence: 'high' });
  else if (/(查|找|搜索|看|查看|列出|有哪些|多少).*(备忘录|笔记)|(备忘录|笔记).*(查|找|搜索|看|查看|列出|有哪些|多少)/.test(intentText)) set('memo_query', 'memo_query', { entityType: 'memo', protected: true, confidence: 'high' });
  else if (/((生成|写|整理|汇总|导出|查看|看看|给我|做一份|出一份).*(日报|周报|工作报告|工作总结)|(日报|周报|工作报告|工作总结).*(生成|查看|看看|写|整理|汇总|导出))/.test(intentText)) set('record_query', 'report_request', { confidence: 'high' });
  else if (/怎么安排|先做什么|排序|建议|安排一下|接下来呢|然后呢|下一步|现在该做什么|我该做什么|优先级.*(怎么|如何|排序)|怎么.*优先级|推荐.*顺序/.test(intentText)) set('query', 'advice_query', { entityType: 'task' });
  else if (/小结|总结|复盘|进展|今天完成了什么|今天做了什么/.test(intentText)) set('summary', 'summary');
  else if (/干了什么|干了啥|做了哪些|做了什么|工作记录|工作日志|记录了什么|昨天做了|这周做了|本周做了|上周做了/.test(intentText)) set('record_query', 'record_query', { confidence: 'medium' });
  else if (/(多少个|几条|几项|完成率|有几个|占比|还剩.*(个|条|项)|还有.*(个|条|项)没|完成了多少|做了多少|完成.*多少)/.test(intentText)) set('query', 'stats_query', { entityType: 'task' });
  else if (/完成了吗|做完了吗|搞定了吗|结束了没/.test(intentText)) set('query', 'status_query', { entityType: 'task', protected: true, confidence: 'high' });
  else if (/^(?:为什么|什么是|如何|怎么|怎样|为何)/.test(intentText)) set('chat', 'knowledge_question', { confidence: 'medium' });
  else if (surfaceQuestion && !(config.hasRecentMemoContext && /拆分|拆成/.test(intentText)) && /(?:可以|能否|能不能|要不要|该不该|应该|是否|会不会|怎么|如何).*(?:删除|删掉|修改|拆分|完成|归档)|(?:删除|删掉|修改|拆分|完成|归档).*(?:可以|能否|能不能|吗|怎么|如何)/.test(intentText)) set('chat', 'operation_question', { confidence: 'medium' });
  else if (/(所有|全部|剩下的|剩余).*(任务|待办).*(时间|截止).*(改|调|挪|移|设)|把.*(所有|全部|剩下的|剩余).*(任务|待办).*(改|调|挪|移|设)/.test(intentText)) set('batch', 'batch_reschedule', { entityType: 'task' });
  else if (/(改成|改为|改到|改成紧急|改成高|改成中|改成低|改优先级|改截止|改时间|改项目|移到|移动到|加标签|加个标签|加备注|加个备注|改描述|改备注|设为紧急|设为高|设为中|设为低|优先级改成|截止改成|时间改成|安排到|排到|顺延|推迟|延后|延期|归档|收起来|移入归档|恢复|还原|找回|撤销删除)/.test(intentText)) set('update', 'update', { entityType: 'task' });
  else if (/加子任务|添加子任务|加个步骤|加步骤|加一步|子任务.*(加|添加)/.test(intentText)) set('chat', 'child_request', { confidence: 'medium' });
  else if (/(清除|清空|清掉|删光|全删|全部.*删|所有.*删|全部.*完成|所有.*完成|批量|一键.*(删|完成|清)|把.*都(删|完成|清)|把.*全(删|完成|清))/.test(intentText)) set('batch', 'batch', { entityType: 'task' });
  else if (/删除|去掉|不做了|取消这个|移除|删掉|划掉/.test(intentText)) set('delete', 'delete', { entityType: 'task' });
  else if (/完成|搞定|做完了|办完了|勾掉|结束了|弄完了|做好了/.test(intentText)) set('complete', 'complete', { entityType: 'task' });
  else if (/开始|动手做|着手|启动/.test(intentText)) set('update', 'update', { entityType: 'task' });
  else if (/创建|添加|记一下|安排|新建|帮我记|加一个|建一个|记个|记得|提醒我|要交|要去/.test(intentText) && !surfaceQuestion) set('create', 'implicit_create', { entityType: 'task' });
  else if (/(今天|明天|后天|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{1,2}[:：点])/.test(intentText) && !/天气|下雨|晴天|气温|温度|星期几|什么|哪些|几个|怎么|怎样|如何|为何|为什么|吗|呢|谁|哪|几|？|\?/.test(intentText)) set('create', 'timed_capture', { entityType: 'task', protected: true, confidence: 'high' });
  else if (/(查|看看|看一下|查看|列|有什么|我的任务|最近|待办|做什么|干嘛|要做|安排|有哪些|都什么|那个任务|完成了吗|做完了吗)/.test(intentText)) set('query', 'task_query', { entityType: entityType === 'unknown' ? 'task' : entityType });
  else if (/#[\u4e00-\u9fa5A-Za-z0-9_-]+.*任务|任务.*#[\u4e00-\u9fa5A-Za-z0-9_-]+/.test(intentText)) set('query', 'tag_query', { entityType: 'task' });
  else set('chat', 'conversation', { confidence: 'low' });

  if (hasCompoundOperationCue(raw) && !config.expectedIntent && !config.contextEntityType) {
    protectedIntent = false;
    confidence = 'medium';
  }
  if (config.contextEntityType === 'task' && ['update', 'complete', 'delete'].includes(intent)) {
    entityType = 'task';
    // 任务锚定的复合句（“顺延两天然后开始做”）允许模型返回组合操作；
    // 预览层会逐项校验意图与任务归属，单句锚定保护仍然生效
    protectedIntent = !hasCompoundOperationCue(raw);
    confidence = 'high';
    cue = cue === 'conversation' ? 'task_surface_context' : cue;
  }
  if (!protectedIntent && config.mode !== 'continuation' && isProtectedCommand(intent, raw)) {
    protectedIntent = true;
    confidence = 'high';
  }

  return Object.assign(base, {
    intent,
    operationCue: cue,
    entityType,
    confidence,
    protected: protectedIntent,
    route: protectedIntent ? 'protected-local' : (confidence === 'low' ? 'model-assisted' : 'local-parse')
  });
}

function mergeProtectedParams(envelope, modelParams, localParams) {
  const params = Object.assign({}, modelParams || {});
  const local = localParams || {};
  if (envelope.intent === 'create') {
    if (local.title || envelope.payload) params.title = local.title || envelope.payload;
    if (local.due) params.due = local.due;
    if (local.pri) params.pri = local.pri;
    if (local.tags && local.tags.length) params.tags = local.tags;
  } else if (envelope.intent === 'memo_create' && envelope.payload) {
    params.memoContent = envelope.payload;
    params.memoTitle = local.memoTitle || params.memoTitle;
  } else if (semanticKind(envelope.intent) === 'read') {
    Object.assign(params, local);
    delete params.title;
    delete params.memoTitle;
    delete params.memoContent;
  }
  if (local.explicitMention || local.taskId || local.memoId) {
    ['target', 'taskId', 'memoId', 'explicitMention', 'useLastMention'].forEach((key) => {
      if (local[key] !== undefined) params[key] = local[key];
    });
  }
  if (envelope.intent === 'update') {
    ['pri', 'due', 'status', 'days', 'project', 'desc'].forEach((key) => {
      if (local[key] !== undefined && local[key] !== null && local[key] !== '') params[key] = local[key];
    });
    if (Array.isArray(local.tags) && local.tags.length) params.tags = local.tags;
  }
  return params;
}

function reconcileModelRoute(envelope, modelResult, localResult) {
  const parsed = Object.assign({}, modelResult, { params: Object.assign({}, modelResult && modelResult.params || {}) });
  if (!envelope || !parsed.intent) return Object.assign(parsed, { semantic: envelope || null });
  if (envelope.protected) {
    const modelIntent = parsed.intent;
    const reconciled = Object.assign(parsed, {
      intent: envelope.intent,
      params: mergeProtectedParams(envelope, parsed.params, localResult && localResult.params),
      confidence: 'high',
      semantic: envelope
    });
    if (modelIntent !== envelope.intent) {
      reconciled.semanticOverride = { from: modelIntent, to: envelope.intent, reason: 'protected_intent' };
    }
    return reconciled;
  }
  const envelopeKind = semanticKind(envelope.intent);
  const modelKind = semanticKind(parsed.intent);
  const writeEscalation = modelKind === 'write' && envelopeKind !== 'write' && (
    envelopeKind === 'read' || envelope.questionCue
  );
  if (!envelope.protected && writeEscalation) {
    return Object.assign(parsed, {
      confidence: 'low',
      semantic: envelope,
      semanticConflict: {
        localIntent: envelope.intent,
        modelIntent: parsed.intent,
        message: `我对这句话的操作类型还不能完全确定：本地语义更像“${envelope.intent}”，模型理解为“${parsed.intent}”。请明确是要查询还是修改数据。`
      }
    });
  }
  return Object.assign(parsed, { semantic: envelope });
}

module.exports = {
  SEMANTIC_ENVELOPE_VERSION,
  routeSemanticInput,
  reconcileModelRoute,
  semanticKind
};
