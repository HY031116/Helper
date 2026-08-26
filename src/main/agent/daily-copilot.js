'use strict';

const DEFAULT_COPILOT = Object.freeze({
  enabled: true,
  quietStart: '20:00',
  quietEnd: '08:00',
  snoozedUntil: 0,
  mutedDate: '',
  lastActionKey: '',
  lastActionAt: 0
});

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function validTime(value, fallback) {
  const text = String(value || '');
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function timeToMinutes(value) {
  const [hour, minute] = validTime(value, '00:00').split(':').map(Number);
  return hour * 60 + minute;
}

function normalizeCopilotState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled !== false,
    quietStart: validTime(source.quietStart, DEFAULT_COPILOT.quietStart),
    quietEnd: validTime(source.quietEnd, DEFAULT_COPILOT.quietEnd),
    snoozedUntil: Math.max(0, Number(source.snoozedUntil) || 0),
    mutedDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.mutedDate || '')) ? source.mutedDate : '',
    lastActionKey: String(source.lastActionKey || '').slice(0, 160),
    lastActionAt: Math.max(0, Number(source.lastActionAt) || 0)
  };
}

function isQuietTime(copilot, now) {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = timeToMinutes(copilot.quietStart);
  const end = timeToMinutes(copilot.quietEnd);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function parseDue(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T') + ':00');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatMinutes(total) {
  const minutes = Math.max(0, Math.round(Number(total) || 0));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function taskRank(task, now, today) {
  const due = parseDue(task.due);
  const overdue = due && due.getTime() < now.getTime();
  const dueToday = due && localDateKey(due) === today;
  return (task.status === 'doing' ? 1000 : 0)
    + (overdue ? 700 : 0)
    + (dueToday ? 400 : 0)
    + Math.max(1, Math.min(4, Number(task.pri) || 2)) * 50;
}

function taskSource(task, detail) {
  return {
    id: `task:${task.id}`,
    type: 'task',
    label: task.title,
    detail: detail || (task.due ? `截止 ${task.due}` : `优先级 ${Number(task.pri) || 2}`)
  };
}

function planSource(plan, detail) {
  return {
    id: `plan:${plan.date}:${plan.revision || 1}`,
    type: 'plan',
    label: `${plan.date} 今日计划`,
    detail
  };
}

function suggestion(kind, title, detail, reason, action, sources, urgency, targetId) {
  return {
    key: [kind, targetId || '', ...sources.map((source) => source.id)].join('|').slice(0, 240),
    kind,
    title,
    detail,
    reason,
    action,
    sources: sources.slice(0, 4),
    urgency: urgency || 'normal',
    targetId: targetId || null
  };
}

function buildSuggestion(tasks, workflow, now, today) {
  const active = tasks.filter((task) => task && !task._deleted && ['todo', 'doing'].includes(task.status));
  const ranked = active.slice().sort((left, right) => taskRank(right, now, today) - taskRank(left, now, today));
  const overdue = ranked.filter((task) => {
    const due = parseDue(task.due);
    return due && due.getTime() < now.getTime();
  });
  const dueToday = ranked.filter((task) => {
    const due = parseDue(task.due);
    return due && localDateKey(due) === today && due.getTime() >= now.getTime();
  });
  const plan = workflow.dailyPlans && workflow.dailyPlans[today] || null;
  const focus = workflow.activeFocus || null;
  const summary = {
    openCount: active.length,
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    plannedCount: plan && Array.isArray(plan.items) ? plan.items.length : 0,
    completedPlanCount: plan && Array.isArray(plan.items)
      ? plan.items.filter((item) => item.status === 'done' || tasks.some((task) => task.id === item.taskId && task.status === 'done')).length
      : 0
  };

  if (focus) {
    const elapsedMinutes = Math.floor((Number(focus.elapsedMs) || Number(focus.accumulatedMs) || 0) / 60000);
    const source = {
      id: `focus:${focus.id}`,
      type: 'focus',
      label: focus.title,
      detail: `已专注 ${formatMinutes(elapsedMinutes)}，目标 ${focus.targetMinutes} 分钟`
    };
    if (focus.state === 'paused') {
      return { summary, suggestion: suggestion(
        'resume_focus',
        `回到「${focus.title}」`,
        `这次专注已完成 ${elapsedMinutes}/${focus.targetMinutes} 分钟，继续后会接着计时。`,
        '当前专注处于暂停状态，先恢复上下文比切换任务成本更低。',
        { kind: 'resume_focus', label: '继续专注' },
        [source],
        'normal',
        focus.taskId
      ) };
    }
    return { summary, suggestion: suggestion(
      'stay_focused',
      `保持在「${focus.title}」`,
      `已专注 ${elapsedMinutes} 分钟，距离目标还剩 ${Math.max(0, focus.targetMinutes - elapsedMinutes)} 分钟。`,
      '当前已有进行中的专注，不建议此时切换工作。',
      { kind: 'view_focus', label: '查看专注' },
      [source],
      'calm',
      focus.taskId
    ) };
  }

  if (!active.length && !plan) {
    return { summary, suggestion: suggestion(
      'capture_next',
      '今天的待办已经清空',
      '可以记录下一件需要推进的事，或者直接结束今天。',
      '目前没有未完成任务，也没有正在进行的专注。',
      { kind: 'new_task', label: '记录下一件事' },
      [],
      'calm'
    ) };
  }

  const endMinutes = timeToMinutes(workflow.preferences && workflow.preferences.workdayEnd || '18:00');
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const planItems = plan && Array.isArray(plan.items) ? plan.items : [];
  const unfinished = planItems.filter((item) => {
    const task = tasks.find((entry) => entry.id === item.taskId);
    return item.status !== 'done' && task && ['todo', 'doing'].includes(task.status);
  });

  if (plan && plan.review) {
    return { summary, suggestion: suggestion(
      'review_complete',
      '今天已经完成复盘',
      '工作记录已经可以用于生成今日日报。',
      '今日计划里已经保存了复盘结果。',
      { kind: 'open_daily_report', label: '生成今日日报' },
      [planSource(plan, `完成 ${summary.completedPlanCount}/${summary.plannedCount} 项，已保存复盘`)],
      'calm'
    ) };
  }

  if (plan && (currentMinutes >= endMinutes || !unfinished.length)) {
    return { summary, suggestion: suggestion(
      'review_day',
      unfinished.length ? '收束今天，确认未完成项' : '计划已完成，做一次简短复盘',
      unfinished.length
        ? `计划完成 ${summary.completedPlanCount}/${summary.plannedCount} 项，复盘会保留未完成项供明天安排。`
        : `计划中的 ${summary.plannedCount} 项已经完成，可以补充今天有效的方法。`,
      currentMinutes >= endMinutes ? '已经到达设定的工作结束时间。' : '今日计划已经没有待执行项。',
      { kind: 'review_day', label: '开始今日复盘' },
      [planSource(plan, `计划 ${summary.completedPlanCount}/${summary.plannedCount} 项已完成`)],
      'normal'
    ) };
  }

  if (!plan) {
    const top = ranked[0];
    const sources = [taskSource(top, overdue.includes(top) ? `已逾期 · ${top.due}` : top.due ? `截止 ${top.due}` : '当前优先级最高')];
    return { summary, suggestion: suggestion(
      'plan_day',
      overdue.length ? `先把 ${overdue.length} 项逾期任务放进今天` : '先确认今天真正要完成的工作',
      `当前有 ${active.length} 项待处理${dueToday.length ? `，其中 ${dueToday.length} 项今天截止` : ''}。Agent 会先生成草案，不会直接保存。`,
      overdue.length ? `「${top.title}」已经逾期，生成计划时会优先处理。` : `还没有今天的计划，直接开工容易让高优先级任务互相挤占。`,
      { kind: 'preview_plan', label: '预览今日计划' },
      sources,
      overdue.length ? 'high' : 'normal',
      top.id
    ) };
  }

  const currentItem = unfinished.find((item) => {
    const start = timeToMinutes(item.plannedStart || '00:00');
    const end = timeToMinutes(item.plannedEnd || '23:59');
    return currentMinutes >= start && currentMinutes < end;
  });
  const first = currentItem || unfinished[0];
  if (!first) return { summary, suggestion: null };
  const task = tasks.find((entry) => entry.id === first.taskId);
  const plannedEnd = timeToMinutes(first.plannedEnd || '23:59');
  const behind = !currentItem && currentMinutes > plannedEnd + 15 && unfinished.length > 1;
  if (behind) {
    return { summary, suggestion: suggestion(
      'replan_day',
      '今天的计划已经偏离当前时间',
      `还有 ${unfinished.length} 项未完成，重新规划只会生成草案。`,
      `下一项「${first.title}」原计划在 ${first.plannedEnd} 前结束。`,
      { kind: 'preview_replan', label: '预览调整方案' },
      [planSource(plan, `还有 ${unfinished.length} 项未完成`), task ? taskSource(task, `原计划 ${first.plannedStart}-${first.plannedEnd}`) : null].filter(Boolean),
      'high',
      first.taskId
    ) };
  }

  return { summary, suggestion: suggestion(
    'start_planned_task',
    `现在推进「${first.title}」`,
    `计划时段 ${first.plannedStart}-${first.plannedEnd} · ${first.plannedMinutes} 分钟。`,
    currentItem ? '当前时间正处于这项任务的计划时段。' : '这是今日计划中第一项尚未完成的任务。',
    { kind: 'start_focus', label: `开始 ${first.plannedMinutes} 分钟专注`, targetMinutes: first.plannedMinutes },
    [planSource(plan, `完成 ${summary.completedPlanCount}/${summary.plannedCount} 项`), task ? taskSource(task, first.reason) : null].filter(Boolean),
    overdue.some((entry) => entry.id === first.taskId) ? 'high' : 'normal',
    first.taskId
  ) };
}

function buildDailyCopilot(tasksValue, workflowValue, nowValue) {
  const now = nowValue instanceof Date ? new Date(nowValue) : new Date(nowValue == null ? Date.now() : nowValue);
  const today = localDateKey(now);
  const tasks = Array.isArray(tasksValue) ? tasksValue : [];
  const workflow = workflowValue && typeof workflowValue === 'object' ? workflowValue : {};
  const copilot = normalizeCopilotState(workflow.copilot);
  const quiet = isQuietTime(copilot, now);
  const muted = copilot.mutedDate === today;
  const snoozed = copilot.snoozedUntil > now.getTime();
  const built = buildSuggestion(tasks, workflow, now, today);
  const hour = now.getHours();
  return {
    date: today,
    generatedAt: now.getTime(),
    period: hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening',
    heading: hour < 12 ? '晨间简报' : hour < 18 ? '此刻建议' : '收束今天',
    visible: copilot.enabled && !quiet && !muted && !snoozed && !!built.suggestion,
    suppressedBy: !copilot.enabled ? 'disabled' : quiet ? 'quiet' : muted ? 'muted' : snoozed ? 'snoozed' : '',
    snoozedUntil: copilot.snoozedUntil,
    quietHours: `${copilot.quietStart}-${copilot.quietEnd}`,
    summary: built.summary,
    suggestion: built.suggestion,
    preferences: copilot
  };
}

module.exports = {
  DEFAULT_COPILOT,
  normalizeCopilotState,
  isQuietTime,
  buildDailyCopilot
};
