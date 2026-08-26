'use strict';

const { normalizeCopilotState } = require('./agent/daily-copilot');

const DEFAULT_PREFERENCES = Object.freeze({
  workdayStart: '09:00',
  workdayEnd: '18:00',
  dailyCapacityMinutes: 240,
  defaultTaskMinutes: 30,
  focusMinutes: 25,
  shortBreakMinutes: 5
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clampInteger(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function validTime(value, fallback) {
  const text = String(value || '');
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeTextList(value, maxItems = 8, maxLength = 80) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map((item) => String(item || '').trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
}

function parseBlockedRange(value) {
  const match = String(value || '').trim().match(/^((?:[01]\d|2[0-3]):[0-5]\d)\s*[-~至到]\s*((?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!match) return null;
  const start = timeToMinutes(match[1]);
  const end = timeToMinutes(match[2]);
  return end > start ? { start, end, label: `${match[1]}-${match[2]}` } : null;
}

function normalizeBlockedTimes(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map((item) => {
    if (item && typeof item === 'object' && Number.isFinite(Number(item.start)) && Number.isFinite(Number(item.end))) {
      const start = Math.max(0, Math.min(1439, Number(item.start)));
      const end = Math.max(0, Math.min(1440, Number(item.end)));
      return end > start ? { start, end, label: String(item.label || `${minutesToTime(start)}-${minutesToTime(end)}`) } : null;
    }
    return parseBlockedRange(item);
  }).filter(Boolean).slice(0, 8);
}

function taskMatchesTerms(task, terms) {
  const haystack = [task.title, task.project, task.desc, ...(Array.isArray(task.tags) ? task.tags : [])]
    .join(' ').toLowerCase();
  return terms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function normalizePreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  const workdayStart = validTime(source.workdayStart, DEFAULT_PREFERENCES.workdayStart);
  const requestedEnd = validTime(source.workdayEnd, DEFAULT_PREFERENCES.workdayEnd);
  const workdayEnd = timeToMinutes(requestedEnd) > timeToMinutes(workdayStart)
    ? requestedEnd
    : (timeToMinutes(DEFAULT_PREFERENCES.workdayEnd) > timeToMinutes(workdayStart)
      ? DEFAULT_PREFERENCES.workdayEnd
      : '23:59');
  return {
    workdayStart,
    workdayEnd,
    dailyCapacityMinutes: clampInteger(source.dailyCapacityMinutes, 30, 720, DEFAULT_PREFERENCES.dailyCapacityMinutes),
    defaultTaskMinutes: clampInteger(source.defaultTaskMinutes, 10, 240, DEFAULT_PREFERENCES.defaultTaskMinutes),
    focusMinutes: clampInteger(source.focusMinutes, 10, 120, DEFAULT_PREFERENCES.focusMinutes),
    shortBreakMinutes: clampInteger(source.shortBreakMinutes, 0, 30, DEFAULT_PREFERENCES.shortBreakMinutes)
  };
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizePlanItem(item, index) {
  if (!item || !Number(item.taskId)) return null;
  const status = ['planned', 'active', 'paused', 'done', 'skipped'].includes(item.status)
    ? item.status
    : 'planned';
  return {
    id: String(item.id || `plan-${Number(item.taskId)}-${index + 1}`),
    taskId: Number(item.taskId),
    title: String(item.title || ''),
    order: index,
    plannedMinutes: clampInteger(item.plannedMinutes, 5, 480, DEFAULT_PREFERENCES.defaultTaskMinutes),
    plannedStart: validTime(item.plannedStart, ''),
    plannedEnd: validTime(item.plannedEnd, ''),
    reason: String(item.reason || ''),
    partial: !!item.partial,
    status,
    completedAt: item.completedAt ? Number(item.completedAt) : null
  };
}

function normalizePlan(plan, date) {
  if (!plan || typeof plan !== 'object') return null;
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(plan.date || '')) ? plan.date : date;
  return {
    id: String(plan.id || `daily-${key}`),
    date: key,
    status: ['draft', 'active', 'completed'].includes(plan.status) ? plan.status : 'active',
    revision: Math.max(1, Number(plan.revision) || 1),
    capacityMinutes: clampInteger(plan.capacityMinutes, 30, 720, DEFAULT_PREFERENCES.dailyCapacityMinutes),
    scheduledMinutes: Math.max(0, Number(plan.scheduledMinutes) || 0),
    omittedCount: Math.max(0, Number(plan.omittedCount) || 0),
    focus: String(plan.focus || '').trim().slice(0, 160),
    endTime: validTime(plan.endTime, ''),
    include: normalizeTextList(plan.include, 5, 80),
    exclude: normalizeTextList(plan.exclude, 8, 80),
    blockedTimes: normalizeBlockedTimes(plan.blockedTimes),
    createdAt: Number(plan.createdAt) || Date.now(),
    updatedAt: Number(plan.updatedAt) || Date.now(),
    items: (Array.isArray(plan.items) ? plan.items : []).map(normalizePlanItem).filter(Boolean),
    review: plan.review && typeof plan.review === 'object' ? clone(plan.review) : null
  };
}

function normalizeFocus(value) {
  if (!value || !Number(value.taskId)) return null;
  const state = value.state === 'paused' ? 'paused' : 'running';
  return {
    id: String(value.id || `focus-${Date.now()}`),
    taskId: Number(value.taskId),
    title: String(value.title || ''),
    planDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value.planDate || '')) ? value.planDate : localDateKey(),
    planItemId: value.planItemId ? String(value.planItemId) : null,
    state,
    targetMinutes: clampInteger(value.targetMinutes, 5, 240, DEFAULT_PREFERENCES.focusMinutes),
    startedAt: Number(value.startedAt) || Date.now(),
    resumedAt: state === 'running' ? (Number(value.resumedAt) || Date.now()) : null,
    pausedAt: state === 'paused' ? (Number(value.pausedAt) || Date.now()) : null,
    accumulatedMs: Math.max(0, Number(value.accumulatedMs) || 0),
    interruptions: (Array.isArray(value.interruptions) ? value.interruptions : []).slice(-50).map((entry) => ({
      at: Number(entry && entry.at) || Date.now(),
      reason: String(entry && entry.reason || '').trim().slice(0, 160)
    }))
  };
}

function normalizeSession(value) {
  if (!value || !Number(value.taskId)) return null;
  return {
    id: String(value.id || `focus-${Date.now()}`),
    taskId: Number(value.taskId),
    title: String(value.title || ''),
    planDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value.planDate || '')) ? value.planDate : localDateKey(),
    targetMinutes: clampInteger(value.targetMinutes, 5, 240, DEFAULT_PREFERENCES.focusMinutes),
    startedAt: Number(value.startedAt) || Date.now(),
    endedAt: Number(value.endedAt) || Date.now(),
    focusedMs: Math.max(0, Number(value.focusedMs) || 0),
    outcome: ['completed', 'stopped'].includes(value.outcome) ? value.outcome : 'stopped',
    interruptions: (Array.isArray(value.interruptions) ? value.interruptions : []).slice(-50).map((entry) => ({
      at: Number(entry && entry.at) || Date.now(),
      reason: String(entry && entry.reason || '').trim().slice(0, 160)
    }))
  };
}

function normalizeWorkflowState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const dailyPlans = {};
  Object.entries(source.dailyPlans && typeof source.dailyPlans === 'object' ? source.dailyPlans : {}).forEach(([date, plan]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const normalized = normalizePlan(plan, date);
    if (normalized) dailyPlans[date] = normalized;
  });
  return {
    version: 1,
    preferences: normalizePreferences(source.preferences),
    copilot: normalizeCopilotState(source.copilot),
    dailyPlans,
    activeFocus: normalizeFocus(source.activeFocus),
    focusSessions: (Array.isArray(source.focusSessions) ? source.focusSessions : [])
      .map(normalizeSession).filter(Boolean).slice(-200)
  };
}

function parseDue(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(' ', 'T') + ':00');
  return Number.isNaN(date.getTime()) ? null : date;
}

function taskReason(task, now, today) {
  if (task.status === 'doing') return { score: 1000, label: '继续正在进行的任务' };
  const due = parseDue(task.due);
  if (due && due.getTime() < now.getTime()) return { score: 750, label: '已经逾期，需要优先处理' };
  if (due && localDateKey(due) === today) return { score: 600, label: '今天截止' };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (due && localDateKey(due) === localDateKey(tomorrow)) return { score: 300, label: '明天截止，今天提前推进' };
  if (Number(task.pri) >= 4) return { score: 220, label: '紧急优先级' };
  if (Number(task.pri) === 3) return { score: 140, label: '高优先级' };
  return { score: 20, label: task.due ? '按截止时间安排' : '补充到可用时间' };
}

function timeToMinutes(value) {
  const [hour, minute] = validTime(value, '09:00').split(':').map(Number);
  return hour * 60 + minute;
}

function minutesToTime(total) {
  const normalized = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function planStartMinutes(date, requested, preferences, now) {
  let start = timeToMinutes(validTime(requested, preferences.workdayStart));
  if (date === localDateKey(now)) {
    const current = now.getHours() * 60 + now.getMinutes();
    start = Math.max(start, Math.ceil(current / 5) * 5);
  }
  return start;
}

function generateDailyPlan(tasks, stateValue, options, nowValue) {
  const state = normalizeWorkflowState(stateValue);
  const preferences = state.preferences;
  const now = nowValue instanceof Date ? new Date(nowValue) : new Date(nowValue || Date.now());
  const date = options && /^\d{4}-\d{2}-\d{2}$/.test(String(options.date || ''))
    ? options.date
    : localDateKey(now);
  const capacityMinutes = clampInteger(
    options && options.availableMinutes,
    30,
    720,
    preferences.dailyCapacityMinutes
  );
  const focus = String(options && options.focus || '').trim().slice(0, 160);
  const include = normalizeTextList(options && options.include, 5, 80);
  const exclude = normalizeTextList(options && options.exclude, 8, 80);
  const blockedTimes = normalizeBlockedTimes(options && options.blockedTimes);
  const active = (Array.isArray(tasks) ? tasks : []).filter((task) =>
    task && !task._deleted && ['todo', 'doing'].includes(task.status) && !taskMatchesTerms(task, exclude)
  );
  const ranked = active.map((task) => {
    const reason = taskReason(task, now, date);
    const due = parseDue(task.due);
    return {
      task,
      reason,
      score: reason.score + clampInteger(task.pri, 1, 4, 2) * 20
        + (taskMatchesTerms(task, [...include, ...(focus ? focus.split(/[，,、\s]+/).filter(Boolean) : [])]) ? 180 : 0),
      dueTime: due ? due.getTime() : Number.MAX_SAFE_INTEGER
    };
  }).sort((left, right) => right.score - left.score || left.dueTime - right.dueTime || left.task.order - right.task.order);

  let remaining = capacityMinutes;
  let cursor = planStartMinutes(date, options && options.startTime, preferences, now);
  const requestedEnd = validTime(options && options.endTime, '');
  const workdayEnd = requestedEnd && timeToMinutes(requestedEnd) > cursor
    ? Math.min(timeToMinutes(preferences.workdayEnd), timeToMinutes(requestedEnd))
    : timeToMinutes(preferences.workdayEnd);
  const items = [];
  const moveToAvailableSlot = (start, duration) => {
    let next = start;
    for (const range of blockedTimes) {
      if (next >= range.end) continue;
      if (next + duration <= range.start) break;
      next = range.end;
    }
    return next;
  };
  for (const entry of ranked) {
    const estimate = clampInteger(entry.task.estimatedMinutes, 10, 480, preferences.defaultTaskMinutes);
    cursor = moveToAvailableSlot(cursor, Math.min(estimate, remaining));
    const windowMinutes = workdayEnd - cursor;
    if (remaining < 10 || windowMinutes < 10) break;
    const plannedMinutes = Math.min(estimate, remaining, windowMinutes);
    const plannedStart = minutesToTime(cursor);
    const plannedEnd = minutesToTime(cursor + plannedMinutes);
    items.push({
      id: `plan-${date}-${entry.task.id}`,
      taskId: entry.task.id,
      title: entry.task.title,
      order: items.length,
      plannedMinutes,
      plannedStart,
      plannedEnd,
      reason: entry.reason.label,
      partial: plannedMinutes < estimate,
      status: 'planned',
      completedAt: null
    });
    remaining -= plannedMinutes;
    cursor += plannedMinutes + preferences.shortBreakMinutes;
  }

  return {
    id: `daily-${date}`,
    date,
    status: 'draft',
    revision: (state.dailyPlans[date] && state.dailyPlans[date].revision || 0) + 1,
    capacityMinutes,
    scheduledMinutes: items.reduce((sum, item) => sum + item.plannedMinutes, 0),
    omittedCount: Math.max(0, ranked.length - items.length),
    createdAt: state.dailyPlans[date] && state.dailyPlans[date].createdAt || now.getTime(),
    updatedAt: now.getTime(),
    focus,
    endTime: requestedEnd,
    include,
    exclude,
    blockedTimes: blockedTimes.map((range) => range.label),
    items,
    review: null
  };
}

function planFitsWorkday(planValue, preferencesValue) {
  const plan = planValue && typeof planValue === 'object' ? planValue : {};
  const preferences = normalizePreferences(preferencesValue);
  const workdayStart = timeToMinutes(preferences.workdayStart);
  const requestedEnd = validTime(plan.endTime, '');
  const workdayEnd = requestedEnd
    ? Math.min(timeToMinutes(preferences.workdayEnd), timeToMinutes(requestedEnd))
    : timeToMinutes(preferences.workdayEnd);
  const blockedTimes = normalizeBlockedTimes(plan.blockedTimes);
  return (Array.isArray(plan.items) ? plan.items : []).every((item) => {
    if (!item || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(item.plannedStart || ''))) return false;
    const start = timeToMinutes(item.plannedStart);
    const end = start + clampInteger(item.plannedMinutes, 5, 480, DEFAULT_PREFERENCES.defaultTaskMinutes);
    const overlapsBlocked = blockedTimes.some((range) => start < range.end && end > range.start);
    return start >= workdayStart && end <= workdayEnd && !overlapsBlocked && item.plannedEnd === minutesToTime(end);
  });
}

function focusElapsedMs(activeFocus, nowValue) {
  const focus = normalizeFocus(activeFocus);
  if (!focus) return 0;
  const now = Number(nowValue) || Date.now();
  return focus.accumulatedMs + (focus.state === 'running' ? Math.max(0, now - focus.resumedAt) : 0);
}

function workflowSnapshot(stateValue, nowValue) {
  const state = normalizeWorkflowState(stateValue);
  const activeFocus = state.activeFocus;
  const elapsedMs = focusElapsedMs(activeFocus, nowValue);
  return Object.assign({}, clone(state), {
    activeFocus: activeFocus ? Object.assign({}, activeFocus, {
      elapsedMs,
      remainingMs: Math.max(0, activeFocus.targetMinutes * 60000 - elapsedMs)
    }) : null
  });
}

function createDailyReview(tasks, stateValue, dateValue, nowValue) {
  const state = normalizeWorkflowState(stateValue);
  const now = Number(nowValue) || Date.now();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || '')) ? dateValue : localDateKey(now);
  const plan = state.dailyPlans[date] || null;
  const taskMap = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [Number(task.id), task]));
  const sessions = state.focusSessions.filter((session) => session.planDate === date);
  const items = plan ? plan.items : [];
  const completed = items.filter((item) => {
    const task = taskMap.get(item.taskId);
    return item.status === 'done' || task && task.status === 'done';
  });
  const unfinished = items.filter((item) => !completed.includes(item));
  const focusedMinutes = Math.round(sessions.reduce((sum, session) => sum + session.focusedMs, 0) / 60000);
  const interruptions = sessions.reduce((sum, session) => sum + session.interruptions.length, 0);
  const completionRate = items.length ? Math.round(completed.length / items.length * 100) : 0;
  let suggestion = '明天先选择一件最重要的任务开始。';
  if (unfinished.length) suggestion = `明天优先重新安排「${unfinished[0].title}」，并为计划预留缓冲时间。`;
  else if (interruptions >= 3) suggestion = '今天打断较多，明天可以缩短单次专注时间并提前关闭干扰源。';
  else if (completed.length) suggestion = '今天的计划完成得不错，明天保持相近容量即可。';
  return {
    date,
    createdAt: now,
    plannedCount: items.length,
    completedCount: completed.length,
    completionRate,
    plannedMinutes: items.reduce((sum, item) => sum + item.plannedMinutes, 0),
    focusedMinutes,
    interruptionCount: interruptions,
    unfinished: unfinished.map((item) => ({ taskId: item.taskId, title: item.title })),
    suggestion
  };
}

module.exports = {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  normalizeBlockedTimes,
  normalizeWorkflowState,
  normalizePlan,
  localDateKey,
  generateDailyPlan,
  planFitsWorkday,
  focusElapsedMs,
  workflowSnapshot,
  createDailyReview
};
