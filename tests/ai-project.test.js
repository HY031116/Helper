'use strict';

/**
 * AI 规则引擎回归测试集
 * 覆盖 PRD 第 6 章：8 类意图 + 兜底场景
 * 运行：node --test tests/ai-project.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// 先加载 electron mock（拦截 require('electron')）
require('./helpers/mock-electron');

const store = require('../src/main/store');
const ai = require('../src/main/ai');
const { TOOL_DEFINITIONS, createToolRegistry } = require('../src/main/agent/tool-registry');
const { buildWorkspaceSnapshot } = require('../src/main/agent/context');
const { normalizeWorkflowState, generateDailyPlan } = require('../src/main/workflow-planner');
const { normalizeModelResponse } = require('../src/main/agent/model-contract');
const { normalizeReportModelResponse, reportToMarkdown } = require('../src/main/agent/report-contract');
const { buildDailyCopilot, normalizeCopilotState } = require('../src/main/agent/daily-copilot');
const { routeSemanticInput, reconcileModelRoute } = require('../src/main/agent/semantic-router');

const DATA_DIR = process.env.WORK_HELPER_DATA_DIR || path.join(require('os').tmpdir(), 'work-helper-ai-test-' + Date.now());

before(() => {
  process.env.WORK_HELPER_DATA_DIR = DATA_DIR;
  store.init();
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ---------- 工具 ---------- */
function reset() {
  store.resetTasks();
  store.updateWorkPreferences({ workdayStart: '09:00', workdayEnd: '23:59' });
  store.clearAgentState();
}

function useMorning(context) {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-21T10:00:00') });
}

test('Agent 工具注册表：所有能力声明读写与目标元数据', () => {
  assert.strictEqual(TOOL_DEFINITIONS.query.effect, 'read');
  assert.strictEqual(TOOL_DEFINITIONS.delete.dangerous, true);
  assert.strictEqual(TOOL_DEFINITIONS.delete.preflightSafe, true);
  assert.strictEqual(TOOL_DEFINITIONS.memo_split.targetType, 'memo');
  assert.strictEqual(TOOL_DEFINITIONS.update.requiresTarget, true);
  assert.strictEqual(TOOL_DEFINITIONS.update.planSafe, true);
  assert.strictEqual(TOOL_DEFINITIONS.delete.planSafe, undefined);
  assert.throws(() => createToolRegistry({}), /Agent tool handlers missing/);
});

test('Agent 上下文：大量任务时优先保留明确目标和最近指代', () => {
  reset();
  let recent;
  for (let index = 0; index < 50; index++) {
    const task = store.createTask({ title: `上下文任务 ${index + 1}` });
    if (index === 46) recent = task;
  }
  const mentioned = store.getAllTasks().find((task) => task.title === '上下文任务 50');
  store.updateAgentState({ lastEntity: { type: 'task', id: recent.id, title: recent.title, ts: Date.now() } });
  const snapshot = buildWorkspaceSnapshot(store, '把上下文任务 50 改成紧急');
  assert.ok(snapshot.taskEntities.some((task) => task.id === mentioned.id));
  assert.strictEqual(snapshot.recentFocus.id, recent.id);
});

test('每日闭环：旧任务缺少预计耗时时保持兼容并限制非法估时', () => {
  reset();
  const task = store.getAllTasks()[0];
  assert.strictEqual(task.estimatedMinutes, null);
  assert.strictEqual(store.updateTask(task.id, { estimatedMinutes: 1 }).estimatedMinutes, 5);
  assert.strictEqual(store.updateTask(task.id, { estimatedMinutes: 999 }).estimatedMinutes, 480);
  assert.strictEqual(store.updateTask(task.id, { estimatedMinutes: '' }).estimatedMinutes, null);
});

test('工作记录：旧任务保持兼容且记录可以新增、修改和删除', () => {
  reset();
  const task = store.getAllTasks()[0];
  assert.deepStrictEqual(task.workLogs, []);
  assert.throws(() => store.addTaskWorkLog(task.id, { kind: 'progress', text: '   ' }), /不能为空/);

  const created = store.addTaskWorkLog(task.id, { kind: 'outcome', text: '完成了可核对的交付物' });
  assert.strictEqual(created.kind, 'outcome');
  assert.strictEqual(store.getTask(task.id).workLogs[0].text, '完成了可核对的交付物');

  const updated = store.updateTaskWorkLog(task.id, created.id, { kind: 'decision', text: '决定先验证核心链路' });
  assert.strictEqual(updated.kind, 'decision');
  assert.strictEqual(updated.text, '决定先验证核心链路');
  assert.deepStrictEqual(store.removeTaskWorkLog(task.id, created.id), { ok: true, id: created.id });
  assert.deepStrictEqual(store.getTask(task.id).workLogs, []);
});

test('每日闭环：计划按进行中、逾期和优先级排序且不超过可用时间', (context) => {
  useMorning(context);
  reset();
  const tasks = store.getAllTasks();
  tasks.forEach((task, index) => store.updateTask(task.id, { estimatedMinutes: 25 + index * 5 }));
  const now = new Date();
  now.setHours(9, 0, 0, 0);
  const plan = store.previewDailyPlan({ availableMinutes: 80, startTime: '09:00' });
  assert.strictEqual(plan.status, 'draft');
  assert.strictEqual(plan.capacityMinutes, 80);
  assert.ok(plan.scheduledMinutes <= 80);
  assert.strictEqual(plan.items[0].taskId, 3, '正在进行的任务应排在最前');
  assert.strictEqual(new Set(plan.items.map((item) => item.taskId)).size, plan.items.length);
  assert.ok(plan.items.every((item) => item.reason && item.plannedStart && item.plannedEnd));
});

test('每日闭环：临近下班生成计划时严格截断在工作结束时间', () => {
  const state = normalizeWorkflowState({
    preferences: {
      workdayStart: '09:00',
      workdayEnd: '18:00',
      dailyCapacityMinutes: 240,
      defaultTaskMinutes: 30,
      shortBreakMinutes: 5
    }
  });
  const plan = generateDailyPlan([
    { id: 9001, title: '临近下班任务', status: 'todo', pri: 4, estimatedMinutes: 120, order: 1 },
    { id: 9002, title: '明天再做任务', status: 'todo', pri: 3, estimatedMinutes: 120, order: 2 }
  ], state, { date: '2026-08-21', availableMinutes: 240 }, new Date('2026-08-21T17:30:00'));
  assert.strictEqual(plan.scheduledMinutes, 30);
  assert.strictEqual(plan.items.length, 1);
  assert.strictEqual(plan.items[0].plannedStart, '17:30');
  assert.strictEqual(plan.items[0].plannedEnd, '18:00');
  assert.strictEqual(plan.items[0].partial, true);
});

test('每日闭环：智能约束会优先匹配、排除任务并避开占用时段', () => {
  const state = normalizeWorkflowState({
    preferences: { workdayStart: '09:00', workdayEnd: '18:00', dailyCapacityMinutes: 240, shortBreakMinutes: 5 }
  });
  const plan = generateDailyPlan([
    { id: 9101, title: '发布版本说明', status: 'todo', pri: 4, estimatedMinutes: 30, order: 1 },
    { id: 9102, title: '整理会议记录', status: 'todo', pri: 4, estimatedMinutes: 30, order: 2 },
    { id: 9103, title: '处理发布阻塞问题', status: 'todo', pri: 1, estimatedMinutes: 30, order: 3 }
  ], state, {
    date: '2026-08-25', availableMinutes: 120, startTime: '13:30', focus: '发布', exclude: ['会议'], blockedTimes: ['14:00-15:00']
  }, new Date('2026-08-25T08:00:00'));
  assert.strictEqual(plan.items[0].taskId, 9101);
  assert.ok(!plan.items.some((item) => item.taskId === 9102));
  assert.ok(plan.items.every((item) => item.plannedEnd <= '14:00' || item.plannedStart >= '15:00'));
  assert.deepStrictEqual(plan.blockedTimes, ['14:00-15:00']);
});

test('每日 Agent：晨间没有计划时只推荐生成可确认的计划草案', () => {
  const now = new Date('2026-08-25T09:15:00');
  const briefing = buildDailyCopilot([
    { id: 9201, title: '修复发布阻塞', status: 'todo', pri: 4, due: '2026-08-24 18:00' },
    { id: 9202, title: '整理会议记录', status: 'todo', pri: 2, due: '2026-08-25 17:00' }
  ], normalizeWorkflowState({ preferences: { workdayStart: '09:00', workdayEnd: '18:00' } }), now);
  assert.strictEqual(briefing.visible, true);
  assert.strictEqual(briefing.heading, '晨间简报');
  assert.strictEqual(briefing.suggestion.kind, 'plan_day');
  assert.strictEqual(briefing.suggestion.action.kind, 'preview_plan');
  assert.strictEqual(briefing.suggestion.targetId, 9201);
  assert.deepStrictEqual(briefing.suggestion.sources.map((source) => source.id), ['task:9201']);
  assert.strictEqual(briefing.summary.overdueCount, 1);
});

test('每日 Agent：已有计划时推荐唯一的当前任务并给出计划与任务依据', () => {
  const now = new Date('2026-08-25T10:15:00');
  const workflow = normalizeWorkflowState({
    preferences: { workdayStart: '09:00', workdayEnd: '18:00' },
    dailyPlans: {
      '2026-08-25': {
        date: '2026-08-25', revision: 2, capacityMinutes: 120, scheduledMinutes: 60,
        items: [{ taskId: 9301, title: '完成交互稿', plannedStart: '10:00', plannedEnd: '11:00', plannedMinutes: 60, reason: '今天截止' }]
      }
    }
  });
  const briefing = buildDailyCopilot([
    { id: 9301, title: '完成交互稿', status: 'todo', pri: 3, due: '2026-08-25 17:00' }
  ], workflow, now);
  assert.strictEqual(briefing.suggestion.kind, 'start_planned_task');
  assert.strictEqual(briefing.suggestion.action.kind, 'start_focus');
  assert.strictEqual(briefing.suggestion.action.targetMinutes, 60);
  assert.deepStrictEqual(briefing.suggestion.sources.map((source) => source.type), ['plan', 'task']);
  assert.match(briefing.suggestion.reason, /计划时段/);
});

test('每日 Agent：暂停中的专注优先恢复，进行中时不诱导切换', () => {
  const now = new Date('2026-08-25T11:00:00');
  const base = {
    preferences: { workdayStart: '09:00', workdayEnd: '18:00' },
    activeFocus: {
      id: 'focus-1', taskId: 9401, title: '核对验收结果', state: 'paused', targetMinutes: 25,
      startedAt: now.getTime() - 12 * 60000, pausedAt: now.getTime(), accumulatedMs: 12 * 60000
    }
  };
  const tasks = [{ id: 9401, title: '核对验收结果', status: 'doing', pri: 3 }];
  const paused = buildDailyCopilot(tasks, normalizeWorkflowState(base), now);
  assert.strictEqual(paused.suggestion.action.kind, 'resume_focus');
  const runningState = normalizeWorkflowState(Object.assign({}, base, {
    activeFocus: Object.assign({}, base.activeFocus, { state: 'running', resumedAt: now.getTime() })
  }));
  const running = buildDailyCopilot(tasks, runningState, now);
  assert.strictEqual(running.suggestion.kind, 'stay_focused');
  assert.strictEqual(running.suggestion.action.kind, 'view_focus');
});

test('每日 Agent：安静时段、稍后提醒和今日静默都会抑制主动卡片', () => {
  const tasks = [{ id: 9501, title: '低打扰测试', status: 'todo', pri: 2 }];
  const late = new Date('2026-08-25T21:00:00');
  const quiet = buildDailyCopilot(tasks, normalizeWorkflowState({}), late);
  assert.strictEqual(quiet.visible, false);
  assert.strictEqual(quiet.suppressedBy, 'quiet');
  const morning = new Date('2026-08-25T10:00:00');
  const snoozed = buildDailyCopilot(tasks, normalizeWorkflowState({ copilot: { snoozedUntil: morning.getTime() + 60000 } }), morning);
  assert.strictEqual(snoozed.suppressedBy, 'snoozed');
  const muted = buildDailyCopilot(tasks, normalizeWorkflowState({ copilot: { mutedDate: '2026-08-25' } }), morning);
  assert.strictEqual(muted.suppressedBy, 'muted');
  assert.strictEqual(normalizeCopilotState({ quietStart: 'bad', quietEnd: 'bad' }).quietStart, '20:00');
});

test('每日 Agent：下班后从计划事实引导复盘，复盘后转向日报', () => {
  const now = new Date('2026-08-25T18:30:00');
  const plan = {
    date: '2026-08-25', revision: 1, capacityMinutes: 60, scheduledMinutes: 60,
    items: [{ taskId: 9601, title: '完成验收', plannedStart: '16:00', plannedEnd: '17:00', plannedMinutes: 60 }]
  };
  const tasks = [{ id: 9601, title: '完成验收', status: 'done', pri: 3, completedAt: now.getTime() }];
  const pending = buildDailyCopilot(tasks, normalizeWorkflowState({ preferences: { workdayEnd: '18:00' }, dailyPlans: { '2026-08-25': plan }, copilot: { quietStart: '22:00' } }), now);
  assert.strictEqual(pending.suggestion.action.kind, 'review_day');
  const reviewed = buildDailyCopilot(tasks, normalizeWorkflowState({ preferences: { workdayEnd: '18:00' }, dailyPlans: { '2026-08-25': Object.assign({}, plan, { review: { completionRate: 100 } }) }, copilot: { quietStart: '22:00' } }), now);
  assert.strictEqual(reviewed.suggestion.action.kind, 'open_daily_report');
});

test('每日 Agent：稍后提醒与恢复写入本地工作流状态', () => {
  reset();
  const now = new Date('2026-08-25T10:00:00').getTime();
  const snoozed = store.updateDailyCopilot({ action: 'snooze', minutes: 30, now });
  assert.strictEqual(snoozed.visible, false);
  assert.strictEqual(snoozed.suppressedBy, 'snoozed');
  assert.strictEqual(store.getWorkflowState(now).copilot.snoozedUntil, now + 30 * 60000);
  const restored = store.updateDailyCopilot({ action: 'restore', now });
  assert.strictEqual(restored.suppressedBy, '');
});

test('Agent 智能安排：只生成首页草案，不写入已保存计划', async (context) => {
  useMorning(context);
  reset();
  const preview = await ai.previewDailyPlan('今天只有 2 小时，先做发布相关，14:00-15:00 开会');
  assert.strictEqual(preview.type, 'daily_plan_preview');
  assert.strictEqual(preview.plan.capacityMinutes, 120);
  assert.deepStrictEqual(preview.constraints.blockedTimes, ['14:00-15:00']);
  assert.strictEqual(Object.keys(store.getWorkflowState().dailyPlans).length, 0);
});

test('Agent 智能安排：中文时间窗口会转换为计划边界', async (context) => {
  useMorning(context);
  reset();
  const preview = await ai.previewDailyPlan('今天下午两点到七点');
  assert.strictEqual(preview.type, 'daily_plan_preview');
  assert.strictEqual(preview.constraints.startTime, '14:00');
  assert.strictEqual(preview.constraints.endTime, '19:00');
  assert.strictEqual(preview.constraints.availableMinutes, 300);
  assert.ok(preview.plan.items.every((item) => item.plannedEnd <= '19:00'));
});

test('Agent 智能安排：模型超时后受控降级，不把 AbortError 泄漏到界面', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({ aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'http://127.0.0.1:1/v1', aiApiKey: 'test-key', aiModel: 'test-model' });
  const preview = await ai.previewDailyPlan('今天下午两点到七点');
  assert.strictEqual(preview.type, 'daily_plan_preview');
  assert.match(preview.notice, /已使用本地计划器/);
  store.updateSettings({ aiStage: 'mock' });
});

test('任务上下文 Agent：预览不写入，确认后可撤销', async () => {
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const task = store.createTask({ title: '整理发布说明', pri: 2 });
  const before = ai.taskActionFingerprint(task);
  const preview = await ai.previewTaskAction(task.id, '设为紧急');
  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.action.params.taskId, task.id);
  assert.strictEqual(store.getTask(task.id).pri, 2);
  assert.strictEqual(ai.taskActionFingerprint(store.getTask(task.id)), before);

  const applied = ai.applyTaskAction(preview.action);
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(store.getTask(task.id).pri, 4);
  assert.strictEqual(applied.undoable, true);
  assert.strictEqual(ai.undoAction(applied.undo).ok, true);
  assert.strictEqual(store.getTask(task.id).pri, 2);
});

test('任务上下文 Agent：工作记录先预览再写入且不误判普通任务修改', async () => {
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const task = store.createTask({ title: '完善报告闭环', due: null });

  const addPreview = await ai.previewTaskAction(task.id, '成果：日报已经可以按项目归纳');
  assert.strictEqual(addPreview.ok, true);
  assert.strictEqual(addPreview.action.intent, 'worklog_add');
  assert.deepStrictEqual(store.getTask(task.id).workLogs, []);
  assert.strictEqual(ai.applyTaskAction(addPreview.action).ok, true);
  const log = store.getTask(task.id).workLogs[0];
  assert.strictEqual(log.kind, 'outcome');

  const editPreview = await ai.previewTaskAction(task.id, '日报可以按项目归纳并核对来源', null, {
    workLogId: log.id,
    workLogKind: log.kind
  });
  assert.strictEqual(editPreview.action.intent, 'worklog_update');
  assert.strictEqual(ai.applyTaskAction(editPreview.action).ok, true);
  assert.strictEqual(store.getTask(task.id).workLogs[0].text, '日报可以按项目归纳并核对来源');

  const notMisclassified = await ai.previewTaskAction(task.id, '更新截止时间到明天');
  assert.strictEqual(notMisclassified.action.intent, 'update');
  assert.deepStrictEqual(store.getTask(task.id).workLogs.map((item) => item.id), [log.id]);
  const ordinaryUpdate = await ai.previewTaskAction(task.id, '改到明天');
  assert.strictEqual(ordinaryUpdate.action.intent, 'update');
  assert.deepStrictEqual(store.getTask(task.id).workLogs.map((item) => item.id), [log.id]);

  const deletePreview = await ai.previewTaskAction(task.id, '删除最近的成果');
  assert.strictEqual(deletePreview.action.intent, 'worklog_delete');
  assert.strictEqual(ai.applyTaskAction(deletePreview.action).ok, true);
  assert.deepStrictEqual(store.getTask(task.id).workLogs, []);
});

test('任务上下文 Agent：安排今天使用明确 taskId 且预览冲突时拒绝覆盖', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const task = store.createTask({ title: '修正交互细节', due: null, desc: '' });
  const preview = await ai.previewTaskAction(task.id, '安排今天');
  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.action.intent, 'update');
  assert.strictEqual(preview.action.params.taskId, task.id);
  assert.strictEqual(preview.action.params.due, '2026-08-21 18:00');
  assert.strictEqual(store.getTask(task.id).due, null);

  store.updateTask(task.id, { desc: '从任务详情页补充的内容' });
  const applied = ai.applyTaskAction(preview.action);
  assert.strictEqual(applied.ok, false);
  assert.strictEqual(applied.type, 'conflict');
  assert.strictEqual(store.getTask(task.id).due, null);
});

test('任务上下文 Agent：无具体步骤时不会写入占位拆分', async () => {
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const task = store.createTask({ title: '准备上线方案' });
  const preview = await ai.previewTaskAction(task.id, '拆成三步');
  assert.strictEqual(preview.ok, false);
  assert.match(preview.message, /足够具体/);
  assert.deepStrictEqual(store.getTask(task.id).children, []);
});

test('任务上下文 Agent：连续补充时间沿用上一轮日期但只生成新预览', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const task = store.createTask({ title: '跟进客户', due: null });
  const first = await ai.previewTaskAction(task.id, '改到明天', null, null);
  assert.strictEqual(first.ok, true);
  const second = await ai.previewTaskAction(task.id, '下午三点', null, {
    previousText: '改到明天',
    previousAction: first.action
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.action.params.due, `${first.action.params.due.slice(0, 10)} 15:00`);
  assert.strictEqual(store.getTask(task.id).due, null);
  assert.notStrictEqual(second.action.fingerprint, '');
});

test('任务上下文 Agent：拆分预览后补充具体步骤不会重复写入', async () => {
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const task = store.createTask({ title: '发布版本' });
  const first = await ai.previewTaskAction(task.id, '拆成三步');
  assert.strictEqual(first.ok, false);
  const second = await ai.previewTaskAction(task.id, '准备说明、执行发布、通知团队', null, {
    previousText: '拆成三步',
    previousAction: { intent: 'split', params: { count: 3 } }
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.action.intent, 'split');
  assert.deepStrictEqual(second.action.params.steps, ['准备说明', '执行发布', '通知团队']);
  assert.deepStrictEqual(store.getTask(task.id).children, []);
});

test('每日闭环：应用计划检查版本且可以无冲突撤销', (context) => {
  useMorning(context);
  reset();
  const draft = store.previewDailyPlan({ availableMinutes: 60 });
  const applied = store.applyDailyPlan(draft);
  assert.strictEqual(applied.plan.status, 'active');
  assert.strictEqual(store.getWorkflowState().dailyPlans[draft.date].revision, 1);
  assert.throws(() => store.applyDailyPlan(draft), /已经变化/);
  const undone = store.restoreDailyPlan({
    date: draft.date,
    expectedRevision: applied.plan.revision,
    previousPlan: applied.previousPlan
  });
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getWorkflowState().dailyPlans[draft.date], undefined);
});

test('每日闭环：编辑后的计划不能超过声明的可用时间', (context) => {
  useMorning(context);
  reset();
  const draft = store.previewDailyPlan({ availableMinutes: 60 });
  draft.items[0].plannedMinutes = 65;
  assert.throws(() => store.applyDailyPlan(draft), /超出可用时间/);
  assert.strictEqual(store.getWorkflowState().dailyPlans[draft.date], undefined);
});

test('每日闭环：服务端拒绝手工编辑到工作时间之外的计划', () => {
  reset();
  store.updateWorkPreferences({ workdayStart: '09:00', workdayEnd: '18:00' });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  const draft = store.previewDailyPlan({ date, availableMinutes: 120, startTime: '17:00' });
  draft.items = [Object.assign({}, draft.items[0], {
    plannedMinutes: 90,
    plannedStart: '17:00',
    plannedEnd: '18:30'
  })];
  assert.throws(() => store.applyDailyPlan(draft), /不能超出工作时间/);
  assert.strictEqual(store.getWorkflowState().dailyPlans[date], undefined);
});

test('每日闭环：服务端拒绝把任务编辑进智能安排的占用时段', () => {
  reset();
  store.updateWorkPreferences({ workdayStart: '09:00', workdayEnd: '18:00' });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  const draft = store.previewDailyPlan({ date, availableMinutes: 120, startTime: '13:00', blockedTimes: ['14:00-15:00'] });
  draft.items = [Object.assign({}, draft.items[0], { plannedStart: '14:10', plannedEnd: '14:40' })];
  assert.throws(() => store.applyDailyPlan(draft), /不能超出工作时间/);
  assert.strictEqual(store.getWorkflowState().dailyPlans[date], undefined);
});

test('每日闭环：专注暂停、打断、继续和完成跨时间累计并同步任务', (context) => {
  useMorning(context);
  reset();
  const task = store.getTask(3);
  const base = Date.now();
  const draft = store.previewDailyPlan({ availableMinutes: 60 });
  store.applyDailyPlan(draft);
  let state = store.startFocus(task.id, { targetMinutes: 25, now: base });
  assert.strictEqual(state.activeFocus.state, 'running');
  state = store.recordInterruption('临时电话', { now: base + 10 * 60000 });
  assert.strictEqual(state.activeFocus.state, 'paused');
  assert.strictEqual(state.activeFocus.elapsedMs, 10 * 60000);
  assert.strictEqual(state.activeFocus.interruptions[0].reason, '临时电话');
  state = store.getWorkflowState(base + 20 * 60000);
  assert.strictEqual(state.activeFocus.elapsedMs, 10 * 60000, '暂停期间不能继续计时');
  state = store.resumeFocus({ now: base + 20 * 60000 });
  assert.strictEqual(state.activeFocus.state, 'running');
  const finished = store.finishFocus({ completeTask: true, now: base + 30 * 60000 });
  assert.strictEqual(finished.session.focusedMs, 20 * 60000);
  assert.strictEqual(finished.session.interruptions.length, 1);
  assert.strictEqual(store.getTask(task.id).status, 'done');
  assert.strictEqual(finished.workflow.activeFocus, null);
  const review = store.getDailyReview(draft.date, base + 31 * 60000);
  assert.ok(review.completedCount >= 1);
  assert.strictEqual(review.focusedMinutes, 20);
  assert.strictEqual(review.interruptionCount, 1);
});

test('每日闭环：损坏或旧版工作流状态会被安全规范化', () => {
  const normalized = normalizeWorkflowState({
    preferences: { focusMinutes: 2, dailyCapacityMinutes: 9999 },
    activeFocus: { taskId: 8, state: 'paused', accumulatedMs: -1 },
    focusSessions: [{ taskId: 8, focusedMs: -10, outcome: 'unexpected' }]
  });
  assert.strictEqual(normalized.preferences.focusMinutes, 10);
  assert.strictEqual(normalized.preferences.dailyCapacityMinutes, 720);
  assert.strictEqual(normalized.activeFocus.accumulatedMs, 0);
  assert.strictEqual(normalized.focusSessions[0].outcome, 'stopped');
});

test('Agent 每日计划：先预览确认，保存后可以撤销', (context) => {
  useMorning(context);
  reset();
  const preview = ai.handle('帮我按 2 小时安排今天的工作');
  assert.strictEqual(preview.intent, 'daily_plan');
  assert.strictEqual(preview.type, 'confirm');
  assert.strictEqual(preview.confirmation.params.plan.capacityMinutes, 120);
  assert.strictEqual(store.getWorkflowState().dailyPlans[preview.confirmation.params.plan.date], undefined);

  const applied = ai.handle('确认');
  assert.strictEqual(applied.type, 'daily_plan');
  assert.ok(applied.plan.items.length > 0);
  const undone = ai.undoAction(applied.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getWorkflowState().dailyPlans[applied.plan.date], undefined);
});

test('Agent 专注闭环：按计划开始、记录打断、继续并完成任务', (context) => {
  useMorning(context);
  reset();
  ai.handle('安排今天的工作计划');
  ai.handle('确认');
  const started = ai.handle('开始下一项');
  assert.strictEqual(started.type, 'focus_start');
  assert.strictEqual(store.getWorkflowState().activeFocus.state, 'running');

  const interrupted = ai.handle('被电话打断了');
  assert.strictEqual(interrupted.type, 'focus_interrupt');
  assert.strictEqual(interrupted.workflow.activeFocus.interruptions[0].reason, '电话');
  assert.strictEqual(interrupted.workflow.activeFocus.state, 'paused');

  assert.strictEqual(ai.handle('继续专注').type, 'focus_resume');
  const finished = ai.handle('完成当前任务');
  assert.strictEqual(finished.type, 'focus_finish');
  assert.strictEqual(finished.task.status, 'done');
  assert.strictEqual(store.getWorkflowState().activeFocus, null);
});

test('每日闭环：专注任务被归档时结束计时并跳过计划项', (context) => {
  useMorning(context);
  reset();
  const draft = store.previewDailyPlan({ availableMinutes: 60 });
  store.applyDailyPlan(draft);
  const taskId = draft.items[0].taskId;
  store.startFocus(taskId, { targetMinutes: 25 });
  store.archiveTask(taskId);
  const workflow = store.getWorkflowState();
  assert.strictEqual(workflow.activeFocus, null);
  assert.strictEqual(workflow.dailyPlans[draft.date].items.find((item) => item.taskId === taskId).status, 'skipped');
  assert.strictEqual(workflow.focusSessions.at(-1).outcome, 'stopped');
});

test('每日闭环：专注尚未结束时不能保存今日复盘', (context) => {
  useMorning(context);
  reset();
  const draft = store.previewDailyPlan({ availableMinutes: 60 });
  store.applyDailyPlan(draft);
  store.startFocus(draft.items[0].taskId, { targetMinutes: 25 });
  assert.throws(() => store.saveDailyReview(draft.date, {}), /先结束当前专注/);
  store.finishFocus({ completeTask: false });
});

test('Agent 重排与复盘：保留原因并继续使用确认边界', (context) => {
  useMorning(context);
  reset();
  ai.handle('安排今天的工作计划');
  ai.handle('确认');
  const before = store.getWorkflowState();
  const date = Object.keys(before.dailyPlans)[0];
  const replan = ai.handle('今天来不及了，只剩 1 小时，重新安排一下');
  assert.strictEqual(replan.intent, 'daily_replan');
  assert.strictEqual(replan.type, 'confirm');
  assert.strictEqual(replan.confirmation.params.plan.capacityMinutes, 60);
  assert.match(replan.message, /来不及/);
  assert.strictEqual(store.getWorkflowState().dailyPlans[date].revision, before.dailyPlans[date].revision);
  assert.strictEqual(ai.handle('确认').type, 'daily_replan');

  const review = ai.handle('复盘一下今天');
  assert.strictEqual(review.type, 'confirm');
  assert.match(review.message, /完成/);
  const saved = ai.handle('确认');
  assert.strictEqual(saved.type, 'daily_review');
  assert.strictEqual(store.getWorkflowState().dailyPlans[date].status, 'completed');
  assert.strictEqual(ai.undoAction(saved.undo).ok, true);
  assert.strictEqual(store.getWorkflowState().dailyPlans[date].status, 'active');
});

test('模型契约：接受受限工作流字段并拒绝越界专注时长', () => {
  const parsed = normalizeModelResponse(JSON.stringify({
    schemaVersion: 1,
    intent: 'focus_start',
    confidence: 'high',
    target: '写方案',
    targetMinutes: 45
  }), ai.INTENTS);
  assert.strictEqual(parsed.params.targetMinutes, 45);
  assert.throws(() => normalizeModelResponse(JSON.stringify({
    schemaVersion: 1,
    intent: 'focus_start',
    targetMinutes: 999
  }), ai.INTENTS), /targetMinutes/);
});

test('模型契约：忽略只读建议中的无关字段但继续拒绝会执行的非法字段', () => {
  const suggestion = normalizeModelResponse(JSON.stringify({
    schemaVersion: 1,
    intent: 'suggest',
    confidence: 'high',
    pri: 99
  }), ai.INTENTS);
  assert.strictEqual(suggestion.params.pri, undefined);
  assert.throws(() => normalizeModelResponse(JSON.stringify({
    schemaVersion: 1,
    intent: 'create',
    title: '交周报',
    pri: 99
  }), ai.INTENTS), /pri/);
});

/* ============ 1. 创建意图 ============ */
test('创建：明天下午3点 交周报 #工作 紧急', () => {
  reset();
  const r = ai.handle('明天下午3点 交周报 #工作 紧急');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.type, 'create');
  assert.ok(r.task);
  assert.strictEqual(r.task.title, '交周报');
  assert.strictEqual(r.task.pri, 4);
  assert.strictEqual(r.task.tags[0], '工作');
  assert.ok(r.task.due && r.task.due.includes('15:00'));
});

test('创建：记一下 买牛奶', () => {
  reset();
  const r = ai.handle('记一下 买牛奶');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '买牛奶');
  assert.strictEqual(r.task.pri, 2); // 默认中优先级
});

test('创建：后天 交季度报告 高优先级', () => {
  reset();
  const r = ai.handle('后天 交季度报告 高优先级');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '交季度报告');
  assert.strictEqual(r.task.pri, 3);
});

test('创建：周一下午2点 团队评审', () => {
  reset();
  const r = ai.handle('周一下午2点 团队评审');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '团队评审');
  assert.ok(r.task.due && r.task.due.includes('14:00'));
});

test('工作时间：相对日期按设置的工作结束时间解析', () => {
  reset();
  store.updateSettings({ workHours: { start: '09:00', end: '17:30', days: [1, 2, 3, 4, 5] } });
  const r = ai.handle('今天 提交日报');
  assert.strictEqual(r.intent, 'create');
  assert.ok(r.task.due && r.task.due.endsWith('17:30'), `due=${r.task.due}`);
});

test('工作时间：非法配置回退默认 18:00', () => {
  reset();
  store.updateSettings({ workHours: { start: '18:00', end: '09:00', days: [9] } });
  const s = store.getSettings();
  assert.strictEqual(s.workHours.end, '18:00');
  assert.deepStrictEqual(s.workHours.days, [1, 2, 3, 4, 5]);
  const r = ai.handle('今天 提交日报');
  assert.ok(r.task.due && r.task.due.endsWith('18:00'), `due=${r.task.due}`);
});

/* ============ 2. 查询意图 ============ */
test('查询：今天我要做什么', () => {
  reset();
  const r = ai.handle('今天我要做什么');
  assert.strictEqual(r.intent, 'query');
  assert.strictEqual(r.type, 'query');
  assert.ok(r.message.includes('共'));
});

test('查询：列一下我的任务', () => {
  reset();
  const r = ai.handle('列一下我的任务');
  assert.strictEqual(r.intent, 'query');
});

/* ============ 3. 完成意图 ============ */
test('完成：完成 交周报', () => {
  reset();
  const r = ai.handle('完成 交周报');
  assert.strictEqual(r.intent, 'complete');
  assert.strictEqual(r.type, 'complete');
  assert.ok(r.undoable);
  // 验证数据已更新
  const t = store.getAllTasks().find((x) => x.title === '交周报');
  assert.strictEqual(t.status, 'done');
  assert.ok(t.completedAt, '完成时应记录 completedAt');
});

test('完成：不存在的任务 → 报错不误操作', () => {
  reset();
  const r = ai.handle('完成 不存在的任务xyz');
  assert.strictEqual(r.type, 'error');
});

test('完成：多候选 → 追问不默认选择', () => {
  reset();
  // 创建两个相似任务
  store.createTask({ title: '写方案A' });
  store.createTask({ title: '写方案B' });
  const r = ai.handle('完成 写方案');
  assert.strictEqual(r.type, 'ask');
  assert.ok(r.candidates && r.candidates.length >= 2);
});

/* ============ 4. 开始意图 ============ */
test('开始：开始 写季度方案', () => {
  reset();
  const r = ai.handle('开始 写季度方案');
  assert.strictEqual(r.intent, 'start');
  assert.strictEqual(r.type, 'start');
  const t = store.getAllTasks().find((x) => x.title === '写季度方案');
  assert.strictEqual(t.status, 'doing');
});

/* ============ 5. 删除意图 ============ */
test('删除：删除 整理报销单据', () => {
  reset();
  const ask = ai.handle('删除 整理报销单据');
  assert.strictEqual(ask.intent, 'delete');
  assert.strictEqual(ask.type, 'confirm');
  assert.ok(store.getAllTasks().some((x) => x.title === '整理报销单据'), '确认前不得删除');
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'delete');
  assert.ok(r.undoable);
  // 软删除
  const all = store.getAllTasks();
  assert.ok(!all.some((x) => x.title === '整理报销单据'));
});

/* ============ 6. 归档意图 ============ */
test('归档：归档 写季度方案', () => {
  reset();
  const r = ai.handle('归档 写季度方案');
  assert.strictEqual(r.intent, 'archive');
  assert.strictEqual(r.type, 'archive');
  assert.ok(r.undoable);
  const t = store.getAllTasks().find((x) => x.title === '写季度方案');
  assert.strictEqual(t.status, 'archived');
});

/* ============ 7. 拆分意图 ============ */
test('拆分：没有具体步骤时不写入占位子任务', () => {
  reset();
  const existing = store.getAllTasks().find((item) => item.title === '写季度方案');
  const originalChildren = JSON.parse(JSON.stringify(existing.children));
  const r = ai.handle('把 写季度方案 拆成三步');
  assert.strictEqual(r.intent, 'split');
  assert.strictEqual(r.type, 'clarify');
  const t = store.getAllTasks().find((x) => x.title === '写季度方案');
  assert.deepStrictEqual(t.children, originalChildren);
  assert.doesNotMatch(r.message, /步骤1/);
});

test('拆分：具体步骤先预览确认再写入', () => {
  reset();
  const task = store.getAllTasks().find((item) => item.title === '写季度方案');
  const originalChildren = JSON.parse(JSON.stringify(task.children));
  const steps = ['确认方案目标和受众', '完成内容初稿与数据', '校对并提交最终版本'];
  const preview = ai.resolve('split', { count: 3, steps }, task.id);
  assert.strictEqual(preview.type, 'confirm');
  assert.deepStrictEqual(store.getTask(task.id).children, originalChildren);
  assert.match(preview.message, /确认方案目标和受众/);

  const result = ai.handle('确认执行');
  assert.strictEqual(result.type, 'split');
  assert.deepStrictEqual(store.getTask(task.id).children.map((child) => child.title), steps);
});

/* ============ 8. 建议意图 ============ */
test('建议：怎么安排今天的优先级', () => {
  reset();
  const r = ai.handle('怎么安排今天的优先级');
  assert.strictEqual(r.intent, 'suggest');
  assert.strictEqual(r.type, 'suggest');
  assert.ok(r.message.includes('建议'));
});

/* ============ 9. 小结意图 ============ */
test('小结：今天完成了什么', () => {
  reset();
  const r = ai.handle('今天完成了什么');
  assert.strictEqual(r.intent, 'summary');
  assert.strictEqual(r.type, 'summary');
  assert.ok(r.message.includes('已完成'));
});

/* ============ 10. 兜底场景 ============ */
test('兜底：非任务内容 → 通用对话，不执行任何操作', () => {
  reset();
  const before = store.getAllTasks().length;
  const r = ai.handle('今天天气怎么样');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.type, 'chat');
  assert.strictEqual(store.getAllTasks().length, before, '闲聊不应改动数据');
});

test('兜底：空输入 → 提示', () => {
  const r = ai.handle('');
  assert.strictEqual(r.intent, 'unknown');
});

test('缺少任务内容时追问并在下一轮补全', () => {
  reset();
  const ask = ai.handle('创建 一个任务');
  assert.strictEqual(ask.type, 'clarify');
  assert.strictEqual(store.getAllTasks().length, 8, '补全前不得创建空任务');
  const r = ai.handle('明天下午3点 交材料 #工作');
  assert.strictEqual(r.type, 'create');
  assert.strictEqual(r.task.title, '交材料');
  assert.strictEqual(r.task.pri, 2);
});

/* ============ 11. 撤销链路 ============ */
test('撤销：删除后可恢复', () => {
  reset();
  ai.handle('删除 整理报销单据');
  const r = ai.handle('确认执行');
  assert.ok(r.undo && r.undo.action === 'restore');
  const restored = store.restoreTask(r.undo.id);
  assert.strictEqual(restored.title, '整理报销单据');
});

test('撤销：归档后可恢复', () => {
  reset();
  const r = ai.handle('归档 写季度方案');
  assert.ok(r.undo && r.undo.action === 'update');
  const restored = ai.undoAction(r.undo);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.task.status, 'todo');
});

test('撤销：开始、完成和拆分会恢复真实字段', () => {
  reset();
  const task = store.createTask({ title: '撤销链路', children: [{ title: '原步骤', done: false }] });
  const originalChildren = JSON.parse(JSON.stringify(task.children));

  const started = ai.handle('开始 撤销链路');
  assert.strictEqual(store.getTask(task.id).status, 'doing');
  assert.strictEqual(ai.undoAction(started.undo).task.status, 'todo');

  const completed = ai.handle('完成 撤销链路');
  assert.strictEqual(store.getTask(task.id).children[0].done, true);
  assert.strictEqual(ai.undoAction(completed.undo).ok, true);
  assert.deepStrictEqual(store.getTask(task.id).children, originalChildren);
  assert.strictEqual(store.getTask(task.id).status, 'todo');

  const split = ai.resolve('split', {
    count: 3,
    steps: ['确认撤销前状态', '执行撤销并检查结果', '记录异常和恢复方式'],
    confirmed: true
  }, task.id);
  assert.strictEqual(store.getTask(task.id).children.length, 3);
  assert.strictEqual(ai.undoAction(split.undo).ok, true);
  assert.deepStrictEqual(store.getTask(task.id).children, originalChildren);
});

test('撤销：完成重复任务会移除本次自动生成的下一次任务', () => {
  reset();
  const task = store.createTask({ title: '每日同步撤销', repeat: 'daily', due: '2026-08-18 09:00' });
  const completed = ai.handle('完成 每日同步撤销');
  const successorId = completed.undo.removeCreated.id;
  assert.ok(store.getTask(successorId));

  const undone = ai.undoAction(completed.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(task.id).status, 'todo');
  assert.strictEqual(store.getTask(task.id).completedAt, null);
  assert.strictEqual(store.getTask(task.id).repeatNextId, null);
  assert.strictEqual(store.getTask(successorId), null);
});

test('撤销：后续任务已修改时拒绝部分回滚', () => {
  reset();
  const task = store.createTask({ title: '每日检查撤销冲突', repeat: 'daily', due: '2026-08-18 09:00' });
  const completed = ai.handle('完成 每日检查撤销冲突');
  const successorId = completed.undo.removeCreated.id;
  store.updateTask(successorId, { desc: '用户后来补充的内容' });

  const undone = ai.undoAction(completed.undo);
  assert.strictEqual(undone.ok, false);
  assert.strictEqual(undone.reason, 'conflict');
  assert.strictEqual(store.getTask(task.id).status, 'done', '冲突时原任务也不能被部分还原');
  assert.ok(store.getTask(successorId));
});

test('撤销：完成旧版重复任务只还原补写关联，不删除既有任务', () => {
  reset();
  const task = store.createTask({ title: '兼容周报撤销', repeat: 'weekly', due: '2026-08-18 18:00' });
  const successor = store.createTask({ title: '兼容周报撤销', repeat: 'weekly', due: '2026-08-25 18:00' });
  const completed = ai.handle('完成 兼容周报撤销');
  assert.strictEqual(completed.type, 'ask');
  const selected = ai.resolve('complete', completed.params, task.id);
  assert.strictEqual(store.getTask(successor.id).repeatSourceId, task.id);

  const undone = ai.undoAction(selected.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(task.id).repeatNextId, null);
  assert.strictEqual(store.getTask(successor.id).repeatSourceId, null);
  assert.ok(store.getTask(successor.id), '既有的下一次任务必须保留');
});

/* ============ 12. 子任务完成进度 ============ */
test('子任务：完成父任务时逐步推进', () => {
  reset();
  const t = store.createTask({ title: '多步任务', children: [{ title: '步骤1', done: false }, { title: '步骤2', done: false }] });
  const r1 = ai.handle('完成 多步任务');
  assert.strictEqual(r1.type, 'complete');
  const t1 = store.getTask(t.id);
  assert.strictEqual(t1.children.filter((c) => c.done).length, 1);
  assert.strictEqual(t1.status, 'todo', '未全部完成时父任务不应完成');
  const r2 = ai.handle('完成 多步任务');
  const t2 = store.getTask(t.id);
  assert.strictEqual(t2.children.filter((c) => c.done).length, 2);
  assert.strictEqual(t2.status, 'done', '全部子任务完成时父任务完成');
});

/* ============ 13. 统计口径 ============ */
test('统计：completedAt 记录真实完成时间', () => {
  reset();
  const t = store.createTask({ title: '统计测试任务' });
  store.updateTask(t.id, { status: 'done' });
  const done = store.getTask(t.id);
  assert.ok(done.completedAt);
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(new Date(done.completedAt).toISOString().slice(0, 10), today);
});

/* ============ 14. 数据层 ============ */
test('数据层：导入任务', () => {
  reset();
  const imported = store.importTasks([
    { title: '导入任务1', pri: 3 },
    { title: '导入任务2', due: '2026-12-31 18:00' }
  ]);
  assert.strictEqual(imported.length, 2);
  assert.strictEqual(store.getAllTasks().length, 10); // 8 种子 + 2 导入
});

test('数据层：清空全部', () => {
  reset();
  store.clearAllTasks();
  assert.strictEqual(store.getAllTasks().length, 0);
});

test('数据层：归档与恢复', () => {
  reset();
  const t = store.createTask({ title: '归档测试' });
  store.archiveTask(t.id);
  assert.strictEqual(store.getTask(t.id).status, 'archived');
  store.unarchiveTask(t.id);
  assert.strictEqual(store.getTask(t.id).status, 'todo');
});

/* ============ 15. 意图识别准确率基线 ============ */
test('基线：100 条典型语句识别准确率 ≥ 85%', () => {
  reset();
  const corpus = [
    // 创建（20 条）
    '明天下午3点 交周报', '记一下 买牛奶', '新建 写方案', '添加 预约牙医',
    '帮我记 取快递', '加一个 整理桌面', '建一个 学习计划', '记个 交电费',
    '后天 交季度报告', '周一下午2点 团队评审', '今天 完成周报', '明天 开会',
    '周五 交总结', '3月5日 交年报', '安排 出差报销', '创建 健身计划',
    '明天早上9点 晨会', '今晚8点 看直播', '下午4点 交材料', '明天下午 面试',
    // 查询（12 条）
    '今天我要做什么', '列一下我的任务', '我的任务', '有什么待办', '最近一周的任务',
    '查一下 交周报', '看看今天', '有哪些任务', '待办列表', '今天有什么',
    '本周任务', '所有任务',
    // 完成（12 条）
    '完成 交周报', '搞定 写方案', '做完了 回复邮件', '办完了 整理报销',
    '勾掉 团队周会', '完成 学习TypeScript', '搞定 更新OKR', '做完了 预约体检',
    '完成 写季度方案', '搞定 交周报', '完成 回复客户邮件', '做完了 整理报销单据',
    // 开始（8 条）
    '开始 写方案', '动手做 交周报', '着手 写季度方案', '开始 学习',
    '开始 整理报销', '动手做 回复邮件', '开始 写代码', '着手 做PPT',
    // 删除（8 条）
    '删除 整理报销单据', '去掉 买牛奶', '不做了 学习计划', '取消这个 预约牙医',
    '移除 取快递', '删除 交电费', '去掉 整理桌面', '删除 写方案',
    // 归档（4 条）
    '归档 写季度方案', '收起来 交周报', '移入归档 学习计划', '归档 整理报销',
    // 拆分（6 条）
    '把 写方案 拆成三步', '拆分 交周报', '把 学习 分解成五步', '把 写季度方案 拆成两步',
    '拆分 做PPT', '把 健身计划 分成四步',
    // 建议（8 条）
    '怎么安排今天的优先级', '先做什么', '建议一下', '优先级排序',
    '今天先做什么', '怎么安排', '安排一下', '排序一下任务',
    // 小结（8 条）
    '今天完成了什么', '今日小结', '总结一下', '复盘今天',
    '今天做了什么', '小结一下', '完成了什么', '今日复盘',
    // 未知（14 条）
    '今天天气怎么样', '你好', '帮我写首诗', '什么是量子力学',
    '推荐一部电影', '讲个笑话', '现在几点', '今天股市怎么样',
    '帮我翻译一下', '写个菜谱', '推荐一本书', '什么是爱',
    '帮我算一下', '随便聊聊'
  ];
  let correct = 0;
  const expected = {
    '明天下午3点 交周报': 'create', '记一下 买牛奶': 'create', '新建 写方案': 'create', '添加 预约牙医': 'create',
    '帮我记 取快递': 'create', '加一个 整理桌面': 'create', '建一个 学习计划': 'create', '记个 交电费': 'create',
    '后天 交季度报告': 'create', '周一下午2点 团队评审': 'create', '今天 完成周报': 'create', '明天 开会': 'create',
    '周五 交总结': 'create', '3月5日 交年报': 'create', '安排 出差报销': 'create', '创建 健身计划': 'create',
    '明天早上9点 晨会': 'create', '今晚8点 看直播': 'create', '下午4点 交材料': 'create', '明天下午 面试': 'create',
    '今天我要做什么': 'query', '列一下我的任务': 'query', '我的任务': 'query', '有什么待办': 'query', '最近一周的任务': 'query',
    '查一下 交周报': 'query', '看看今天': 'query', '有哪些任务': 'query', '待办列表': 'query', '今天有什么': 'query',
    '本周任务': 'query', '所有任务': 'query',
    '完成 交周报': 'complete', '搞定 写方案': 'complete', '做完了 回复邮件': 'complete', '办完了 整理报销': 'complete',
    '勾掉 团队周会': 'complete', '完成 学习TypeScript': 'complete', '搞定 更新OKR': 'complete', '做完了 预约体检': 'complete',
    '完成 写季度方案': 'complete', '搞定 交周报': 'complete', '完成 回复客户邮件': 'complete', '做完了 整理报销单据': 'complete',
    '开始 写方案': 'start', '动手做 交周报': 'start', '着手 写季度方案': 'start', '开始 学习': 'start',
    '开始 整理报销': 'start', '动手做 回复邮件': 'start', '开始 写代码': 'start', '着手 做PPT': 'start',
    '删除 整理报销单据': 'delete', '去掉 买牛奶': 'delete', '不做了 学习计划': 'delete', '取消这个 预约牙医': 'delete',
    '移除 取快递': 'delete', '删除 交电费': 'delete', '去掉 整理桌面': 'delete', '删除 写方案': 'delete',
    '归档 写季度方案': 'archive', '收起来 交周报': 'archive', '移入归档 学习计划': 'archive', '归档 整理报销': 'archive',
    '把 写方案 拆成三步': 'split', '拆分 交周报': 'split', '把 学习 分解成五步': 'split', '把 写季度方案 拆成两步': 'split',
    '拆分 做PPT': 'split', '把 健身计划 分成四步': 'split',
    '怎么安排今天的优先级': 'suggest', '先做什么': 'suggest', '建议一下': 'suggest', '优先级排序': 'suggest',
    '今天先做什么': 'suggest', '怎么安排': 'suggest', '安排一下': 'suggest', '排序一下任务': 'suggest',
    '今天完成了什么': 'summary', '今日小结': 'summary', '总结一下': 'summary', '复盘今天': 'summary',
    '今天做了什么': 'summary', '小结一下': 'summary', '完成了什么': 'summary', '今日复盘': 'summary',
    '今天天气怎么样': 'chat', '你好': 'greeting', '帮我写首诗': 'chat', '什么是量子力学': 'chat',
    '推荐一部电影': 'chat', '讲个笑话': 'chat', '现在几点': 'chat', '今天股市怎么样': 'chat',
    '帮我翻译一下': 'chat', '写个菜谱': 'chat', '推荐一本书': 'chat', '什么是爱': 'chat',
    '帮我算一下': 'chat', '随便聊聊': 'chat'
  };
  corpus.forEach((s) => {
    const r = ai.handle(s);
    if (r.intent === expected[s]) correct++;
  });
  const rate = correct / corpus.length;
  assert.ok(rate >= 0.85, `意图识别准确率 ${(rate * 100).toFixed(1)}% < 85% 基线（${correct}/${corpus.length}）`);
});

/* ============ 16. 重复任务 ============ */
test('重复任务：完成时自动生成下一次', () => {
  reset();
  const t = store.createTask({ title: '每日晨会', repeat: 'daily', due: '2026-08-18 09:00' });
  const res = store.completeTask(t.id);
  assert.strictEqual(res.task.status, 'done');
  assert.ok(res.next, '应生成下一次任务');
  assert.strictEqual(res.next.title, '每日晨会');
  assert.strictEqual(res.next.repeat, 'daily');
  assert.strictEqual(res.next.due, '2026-08-19 09:00', '每日任务应顺延一天');
});

test('重复任务：每周任务顺延 7 天', () => {
  reset();
  const t = store.createTask({ title: '周报', repeat: 'weekly', due: '2026-08-18 18:00' });
  const res = store.completeTask(t.id);
  assert.strictEqual(res.next.due, '2026-08-25 18:00');
});

test('数据层：组合新增校验失败时不会写入任何内容', () => {
  reset();
  resetMemos();
  const taskCount = store.getAllTasks().length;
  assert.throws(() => store.createAdditions({
    tasks: [{ title: '不应留下的任务' }],
    memos: [{ title: '', content: '' }]
  }), /备忘录内容不能为空/);
  assert.strictEqual(store.getAllTasks().length, taskCount);
  assert.strictEqual(store.getAllMemos().length, 0);
});

test('助手撤销：单独创建任务和备忘录都可安全移除', () => {
  store.clearAllTasks();
  resetMemos();

  const createdTask = ai.handle('今天 新建可撤销任务');
  assert.strictEqual(createdTask.type, 'create');
  assert.strictEqual(createdTask.undoable, true);
  assert.strictEqual(ai.undoAction(createdTask.undo).ok, true);
  assert.strictEqual(store.getTask(createdTask.task.id), null);

  const createdMemo = ai.handle('记到备忘录：新建可撤销备忘');
  assert.strictEqual(createdMemo.type, 'memo_create');
  assert.strictEqual(createdMemo.undoable, true);
  assert.strictEqual(ai.undoAction(createdMemo.undo).ok, true);
  assert.strictEqual(store.getMemo(createdMemo.memo.id), null);
});

test('助手撤销：新任务进入今日计划后拒绝移除并保留计划引用', (context) => {
  useMorning(context);
  store.clearAllTasks();
  store.updateWorkPreferences({ workdayStart: '00:00', workdayEnd: '23:59' });
  const created = ai.handle('今天 新建计划引用检查 预计 25 分钟');
  const plan = store.previewDailyPlan({ availableMinutes: 60 });
  assert.ok(plan.items.some((item) => item.taskId === created.task.id));
  store.applyDailyPlan(plan);

  const undone = ai.undoAction(created.undo);
  assert.strictEqual(undone.ok, false);
  assert.strictEqual(undone.reason, 'conflict');
  assert.match(undone.message, /今日计划或专注记录/);
  assert.ok(store.getTask(created.task.id));
});

test('数据层：一轮聊天记录原子写入，失败时不留下半轮内容', () => {
  store.clearChat();
  store.appendChat({ role: 'ai', text: '已有历史', ts: 1 });
  const before = JSON.stringify(store.getChatLog());
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.basename(destination) === 'chat.json') throw new Error('chat disk unavailable');
    return originalRename(source, destination);
  };
  try {
    assert.throws(() => store.appendChatEntries([
      { role: 'user', text: '本轮问题', ts: 2 },
      { role: 'ai', text: '本轮回答', ts: 3 }
    ]), /chat disk unavailable/);
    assert.strictEqual(JSON.stringify(store.getChatLog()), before);
  } finally {
    fs.renameSync = originalRename;
  }
});

test('重复任务：重新打开或重复完成不会复制下一次任务', () => {
  reset();
  const task = store.createTask({ title: '每日站会', repeat: 'daily', due: '2026-08-18 09:00' });
  const first = store.completeTask(task.id);
  store.updateTask(task.id, { status: 'todo' });
  const reopened = store.completeTask(task.id);
  const repeated = store.completeTask(task.id);
  const successors = store.getAllTasks().filter((t) => t.repeatSourceId === task.id);

  assert.strictEqual(successors.length, 1);
  assert.strictEqual(reopened.next.id, first.next.id);
  assert.strictEqual(repeated.next.id, first.next.id);
  assert.strictEqual(repeated.alreadyDone, true);
  assert.strictEqual(store.getTask(task.id).repeatNextId, first.next.id);
});

test('重复任务：升级前生成的下一次任务会被复用并补齐链路', () => {
  reset();
  const source = store.createTask({
    title: '旧版每日任务',
    repeat: 'daily',
    due: '2026-08-18 09:00',
    status: 'done'
  });
  const legacyNext = store.createTask({
    title: '旧版每日任务',
    repeat: 'daily',
    due: '2026-08-19 09:00'
  });
  store.updateTask(source.id, { status: 'todo' });

  const result = store.completeTask(source.id);
  const matches = store.getAllTasks().filter((t) => t.title === source.title && t.due === legacyNext.due);
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(result.next.id, legacyNext.id);
  assert.strictEqual(store.getTask(source.id).repeatNextId, legacyNext.id);
  assert.strictEqual(store.getTask(legacyNext.id).repeatSourceId, source.id);
});

test('保存并完成：新建和编辑均保留完整完成语义', () => {
  reset();
  const originalRename = fs.renameSync;
  let writes = 0;
  let created;
  let updated;
  try {
    fs.renameSync = (...args) => {
      writes++;
      return originalRename(...args);
    };
    created = store.saveAndCompleteTask(null, {
      title: '每日整理',
      repeat: 'daily',
      due: '2026-08-18 19:00',
      pri: 3
    });
    assert.strictEqual(writes, 1, '新建并完成应只写盘一次');

    const existing = store.createTask({ title: '待完善', due: '2026-08-20 18:00' });
    writes = 0;
    updated = store.saveAndCompleteTask(existing.id, {
      title: '已经完善',
      due: '2026-08-21 18:00',
      pri: 4,
      status: 'done'
    });
    assert.strictEqual(writes, 1, '编辑并完成应只写盘一次');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(created.task.status, 'done');
  assert.strictEqual(created.next.due, '2026-08-19 19:00');
  assert.strictEqual(updated.task.title, '已经完善');
  assert.strictEqual(updated.task.pri, 4);
  assert.strictEqual(updated.task.status, 'done');
  assert.ok(updated.task.completedAt);
});

test('重复任务：无截止时间不生成', () => {
  reset();
  const t = store.createTask({ title: '无截止重复', repeat: 'daily', due: null });
  const res = store.completeTask(t.id);
  assert.strictEqual(res.next, null);
});

/* ============ 17. 子任务 ============ */
test('子任务：对象化带 id，可单独勾选', () => {
  reset();
  const t = store.createTask({ title: '带子任务', children: ['步骤1', '步骤2'] });
  assert.ok(t.children[0].id, '子任务应有 id');
  assert.strictEqual(t.children[0].title, '步骤1');
  assert.strictEqual(t.children[0].done, false);
  // 勾选第一个
  const children = t.children.map((c, i) => i === 0 ? Object.assign({}, c, { done: true }) : c);
  const updated = store.updateTask(t.id, { children });
  assert.strictEqual(updated.children[0].done, true);
});

/* ============ 18. 排序 ============ */
test('排序：reorderTasks 持久化顺序', () => {
  reset();
  const a = store.createTask({ title: '排序A' });
  const b = store.createTask({ title: '排序B' });
  const c = store.createTask({ title: '排序C' });
  store.reorderTasks([c.id, a.id, b.id]);
  const all = store.getAllTasks();
  const order = all.filter((t) => [a.id, b.id, c.id].includes(t.id))
    .sort((x, y) => x.order - y.order).map((t) => t.title);
  assert.deepStrictEqual(order, ['排序C', '排序A', '排序B']);
});

/* ============ 19. 批量操作 ============ */
test('批量：batchUpdate 批量完成', () => {
  reset();
  const a = store.createTask({ title: '批量1' });
  const b = store.createTask({ title: '批量2' });
  store.batchUpdate([a.id, b.id], { status: 'done' });
  assert.strictEqual(store.getTask(a.id).status, 'done');
  assert.strictEqual(store.getTask(b.id).status, 'done');
});

test('批量完成：重复任务生成下一次并跳过已完成与归档任务', () => {
  reset();
  const recurring = store.createTask({ title: '每日复盘', repeat: 'daily', due: '2026-08-18 20:00' });
  const done = store.createTask({ title: '已经完成' });
  const archived = store.createTask({ title: '已经归档' });
  store.completeTask(done.id);
  store.archiveTask(archived.id);

  const result = store.batchComplete([recurring.id, done.id, archived.id, recurring.id]);

  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.skipped, 2);
  assert.strictEqual(result.generated.length, 1);
  assert.strictEqual(result.generated[0].due, '2026-08-19 20:00');
  assert.strictEqual(store.getTask(recurring.id).status, 'done');
  assert.strictEqual(store.getTask(archived.id).status, 'archived');
});

test('批量：batchDelete 批量删除进回收站', () => {
  reset();
  const a = store.createTask({ title: '批量删1' });
  const b = store.createTask({ title: '批量删2' });
  store.batchDelete([a.id, b.id]);
  assert.strictEqual(store.getDeletedTasks().length, 2);
});

/* ============ 20. 回收站 ============ */
test('回收站：删除后可查询并恢复', () => {
  reset();
  const t = store.createTask({ title: '回收站测试' });
  store.deleteTask(t.id);
  const deleted = store.getDeletedTasks();
  assert.strictEqual(deleted.length, 1);
  assert.strictEqual(deleted[0].title, '回收站测试');
  assert.ok(Number.isFinite(deleted[0].deletedAt), '删除任务时应记录删除时间');
  const restored = store.restoreTask(t.id);
  assert.strictEqual(restored.title, '回收站测试');
  assert.strictEqual(restored.deletedAt, undefined, '恢复任务后应清除删除时间');
  assert.strictEqual(store.getDeletedTasks().length, 0);
});

test('回收站：只能永久删除已进入回收站的任务', () => {
  reset();
  const active = store.createTask({ title: '仍在使用的任务' });
  assert.throws(() => store.purgeTask(active.id), /回收站中没有这条任务/);
  store.deleteTask(active.id);
  assert.deepStrictEqual(store.purgeTask(active.id), { ok: true, id: active.id });
  assert.strictEqual(store.getDeletedTasks().some((item) => item.id === active.id), false);
});

test('回收站：emptyTrash 清空', () => {
  reset();
  const t = store.createTask({ title: '清空测试' });
  store.deleteTask(t.id);
  store.emptyTrash();
  assert.strictEqual(store.getDeletedTasks().length, 0);
});

/* ============ 21. 顺延 ============ */
test('顺延：postponeTask 推迟到明天', () => {
  reset();
  const t = store.createTask({ title: '顺延测试', due: '2026-08-18 10:00' });
  const updated = store.postponeTask(t.id, 1);
  assert.strictEqual(updated.due, '2026-08-19 10:00');
});

/* ============ 22. AI 完成重复任务 ============ */
test('AI：完成重复任务自动生成下一次', () => {
  reset();
  const t = store.createTask({ title: 'AI重复任务', repeat: 'weekly', due: '2026-08-18 15:00' });
  const r = ai.handle('完成 AI重复任务');
  assert.strictEqual(r.type, 'complete');
  const next = store.getAllTasks().find((x) => x.title === 'AI重复任务' && x.status !== 'done');
  assert.ok(next, '应生成下一次任务');
  assert.strictEqual(next.due, '2026-08-25 15:00');
});

/* ============ 23. 词库扩充 ============ */
test('扩充：帮我看看今天有什么 → query', () => {
  reset();
  const r = ai.handle('帮我看看今天有什么');
  assert.strictEqual(r.intent, 'query');
});

test('扩充：记得周五交材料 → create', () => {
  reset();
  const r = ai.handle('记得周五交材料');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '交材料');
});

test('扩充：把那个方案删掉 → delete', () => {
  reset();
  store.createTask({ title: '产品方案' });
  const r = ai.handle('把那个方案删掉');
  assert.strictEqual(r.intent, 'delete');
});

test('扩充：明天要交周报吗 → 不误判 create', () => {
  reset();
  const r = ai.handle('明天要交周报吗');
  // 含疑问词「吗」，不应误判为 create
  assert.notStrictEqual(r.intent, 'create');
});

test('歧义选择：按任务 ID 继续原操作，不重新猜测任务名', () => {
  reset();
  const first = store.createTask({ title: '产品方案 A', pri: 2 });
  const second = store.createTask({ title: '产品方案 B', pri: 2 });
  const ask = ai.handle('把 产品方案 改成紧急');

  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.intent, 'update');
  assert.strictEqual(ask.params.pri, 4);
  assert.strictEqual(ask.candidates.length, 2);
  assert.deepStrictEqual(ask.candidates[1], {
    id: second.id,
    title: '产品方案 B',
    project: '',
    due: null,
    status: 'todo'
  });

  const result = ai.resolve(ask.intent, ask.params, second.id);
  assert.strictEqual(result.type, 'update');
  assert.strictEqual(store.getTask(first.id).pri, 2);
  assert.strictEqual(store.getTask(second.id).pri, 4);
});

test('歧义选择：拒绝不支持的意图', () => {
  reset();
  const task = store.createTask({ title: '保留任务' });
  const result = ai.resolve('batch', { text: '清除所有任务' }, task.id);
  assert.strictEqual(result.type, 'error');
  assert.ok(store.getTask(task.id));
});

test('歧义选择：可按任务 ID 从回收站恢复指定任务', () => {
  reset();
  const first = store.createTask({ title: '恢复候选 A' });
  const second = store.createTask({ title: '恢复候选 B' });
  store.deleteTask(first.id);
  store.deleteTask(second.id);

  const ask = ai.handle('恢复 恢复候选');
  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.intent, 'restore');

  const result = ai.resolve(ask.intent, ask.params, second.id);
  assert.strictEqual(result.type, 'restore');
  assert.ok(store.getTask(second.id));
  assert.ok(store.getDeletedTasks().some((task) => task.id === first.id));
});

/* ============ 24. 查询筛选 ============ */
test('筛选：我有哪些紧急任务 → pri=4', () => {
  reset();
  store.createTask({ title: '紧急任务A', pri: 4 });
  store.createTask({ title: '普通任务B', pri: 2 });
  const r = ai.handle('我有哪些紧急任务');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('紧急任务A'));
  assert.ok(!r.message.includes('普通任务B'));
});

test('筛选：#工作 的任务 → 按标签过滤', () => {
  reset();
  store.createTask({ title: '工作项', tags: ['工作'] });
  store.createTask({ title: '生活项', tags: ['生活'] });
  const r = ai.handle('#工作 的任务');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('工作项'));
  assert.ok(!r.message.includes('生活项'));
});

test('筛选：进行中的任务 → status=doing', () => {
  reset();
  store.createTask({ title: '进行中的A', status: 'doing' });
  store.createTask({ title: '待办的B', status: 'todo' });
  const r = ai.handle('进行中的任务有哪些');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('进行中的A'));
  assert.ok(!r.message.includes('待办的B'));
});

/* ============ 25. 统计问答 ============ */
test('统计：今天完成了多少 → stats', () => {
  reset();
  const t = store.createTask({ title: '统计任务' });
  store.updateTask(t.id, { status: 'done' });
  const r = ai.handle('今天完成了多少');
  assert.strictEqual(r.intent, 'stats');
  assert.ok(r.message.includes('今天已完成'));
});

test('统计：完成率 → stats', () => {
  reset();
  const a = store.createTask({ title: '完成率A' });
  store.updateTask(a.id, { status: 'done' });
  const r = ai.handle('完成率多少');
  assert.strictEqual(r.intent, 'stats');
  assert.ok(r.message.includes('完成率'));
});

/* ============ 26. 多轮上下文 ============ */
test('多轮：指代「那个任务」', () => {
  reset();
  store.createTask({ title: '上下文任务' });
  ai.handle('开始 上下文任务');
  const r = ai.handle('那个任务完成了吗');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('上下文任务'));
});

/* ============ 27. 问候 ============ */
test('问候：你好', () => {
  reset();
  const r = ai.handle('你好');
  assert.strictEqual(r.intent, 'greeting');
  assert.ok(r.message.includes('你好'));
});

test('感谢：谢谢', () => {
  reset();
  const r = ai.handle('谢谢');
  assert.strictEqual(r.intent, 'thanks');
});

/* ============ 28. 通用对话（知识问答） ============ */
test('知识问答：什么是番茄工作法 → chat + 知识库命中', () => {
  reset();
  const r = ai.handle('什么是番茄工作法');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.type, 'chat');
  assert.ok(r.message.includes('番茄'));
});

test('知识问答：四象限法则', () => {
  reset();
  const r = ai.handle('什么是四象限法则');
  assert.strictEqual(r.intent, 'chat');
  assert.ok(r.message.includes('四象限'));
});

test('知识问答：你是谁', () => {
  reset();
  const r = ai.handle('你是谁');
  assert.strictEqual(r.intent, 'chat');
  assert.ok(r.message.includes('工作台助手'));
});

test('知识问答：今天星期几', () => {
  reset();
  const r = ai.handle('今天星期几');
  assert.strictEqual(r.intent, 'chat');
  assert.ok(r.message.includes('星期'));
});

test('闲聊：未命中知识库 → 引导配置', () => {
  reset();
  const r = ai.handle('给我讲个关于宇宙的故事');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.type, 'chat');
  assert.ok(r.message.length > 0);
});

test('闲聊：不执行任何任务操作', () => {
  reset();
  const before = store.getAllTasks().length;
  ai.handle('推荐一部好看的电影');
  assert.strictEqual(store.getAllTasks().length, before, '闲聊不应创建任务');
});

/* ============ 29. 批量操作 ============ */
test('批量：清除所有任务', () => {
  reset();
  const before = store.getAllTasks().length;
  const ask = ai.handle('清除所有任务');
  assert.strictEqual(ask.intent, 'batch');
  assert.strictEqual(ask.type, 'confirm');
  assert.strictEqual(store.getAllTasks().length, before);
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'batch');
  assert.ok(r.message.includes('清除'));
  assert.strictEqual(store.getAllTasks().length, 0);
});

test('批量：全部完成', () => {
  reset();
  const originalPending = store.getAllTasks().filter((t) => t.status !== 'done' && t.status !== 'archived');
  const recurring = originalPending.find((t) => t.repeat && t.due);
  const ask = ai.handle('全部任务都完成');
  assert.strictEqual(ask.intent, 'batch');
  assert.strictEqual(ask.type, 'confirm');
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'batch');
  originalPending.forEach((task) => {
    assert.strictEqual(store.getTask(task.id).status, 'done', `原任务「${task.title}」应已完成`);
  });
  if (recurring) {
    const generated = store.getAllTasks().find((t) => t.id !== recurring.id && t.title === recurring.title && t.status === 'todo');
    assert.ok(generated, '重复任务应生成下一次待办');
    assert.ok(r.message.includes('下次任务'));
  }
});

test('批量：按优先级删除紧急任务', () => {
  reset();
  store.createTask({ title: '紧急A', pri: 4 });
  store.createTask({ title: '普通B', pri: 2 });
  const ask = ai.handle('把紧急任务都删掉');
  assert.strictEqual(ask.intent, 'batch');
  assert.strictEqual(ask.type, 'confirm');
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'batch');
  const urgent = store.getAllTasks().filter((t) => t.pri === 4);
  assert.strictEqual(urgent.length, 0, '紧急任务应被删除');
  assert.ok(store.getAllTasks().some((t) => t.title === '普通B'), '普通任务应保留');
});

test('批量：按标签删除', () => {
  reset();
  store.createTask({ title: '工作项', tags: ['工作'] });
  store.createTask({ title: '生活项', tags: ['生活'] });
  const ask = ai.handle('把所有工作标签的任务删掉');
  assert.strictEqual(ask.intent, 'batch');
  assert.strictEqual(ask.type, 'confirm');
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'batch');
  assert.ok(!store.getAllTasks().some((t) => t.title === '工作项'), '工作标签任务应删除');
  assert.ok(store.getAllTasks().some((t) => t.title === '生活项'), '生活标签任务应保留');
});

test('批量：把今天剩下的任务时间改到指定时刻', () => {
  reset();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  store.createTask({ title: '上午的事', due: `${dayKey} 10:00` });
  store.createTask({ title: '下午的事', due: `${dayKey} 16:00`, status: 'done' });
  store.createTask({ title: '明天的事', due: `${dayKey.replace(/(\d+)$/, (m) => String(Number(m) + 1))} 09:00` });

  const ask = ai.handle('把今天剩下的所有任务时间都改到七点');
  assert.strictEqual(ask.intent, 'batch');
  assert.strictEqual(ask.type, 'confirm', '批量改时间需要确认');
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'batch');
  const morning = store.getAllTasks().find((t) => t.title === '上午的事');
  assert.ok(morning.due.endsWith('07:00'), `due=${morning.due}`);
  const afternoon = store.getAllTasks().find((t) => t.title === '下午的事');
  assert.ok(afternoon.due.endsWith('16:00'), '已完成任务不应被修改');
  const tomorrow = store.getAllTasks().find((t) => t.title === '明天的事');
  assert.ok(tomorrow.due.endsWith('09:00'), '明天的任务不应被修改');
});

test('批量：清空回收站', () => {
  reset();
  const t = store.createTask({ title: '待删任务' });
  store.deleteTask(t.id);
  const ask = ai.handle('清空回收站');
  assert.strictEqual(ask.intent, 'batch');
  assert.strictEqual(ask.type, 'confirm');
  const r = ai.handle('确认执行');
  assert.strictEqual(r.type, 'batch');
  assert.strictEqual(store.getDeletedTasks().length, 0, '回收站应清空');
});

/* ============ 备份与恢复 ============ */
test('备份：创建备份并列出', () => {
  reset();
  const file = store.backup();
  assert.ok(file, '应返回备份文件路径');
  const list = store.listBackups();
  assert.ok(Array.isArray(list), '应返回备份列表');
  assert.ok(list.length >= 1, '至少有一份备份');
  assert.ok(list[0].name && list[0].path && list[0].size >= 0, '备份项应含名称/路径/大小');
});

test('备份：从备份恢复覆盖当前数据', () => {
  reset();
  // 先创建一份备份（含当前种子数据）
  const file = store.backup();
  // 清空并新增一条任务，模拟数据变化
  store.clearAllTasks();
  store.createTask({ title: '临时任务' });
  assert.strictEqual(store.getAllTasks().length, 1, '当前应只有临时任务');
  // 恢复到备份点
  const res = store.restoreFromBackup(file);
  assert.strictEqual(res.ok, true);
  assert.ok(res.count > 1, '恢复后任务数应多于 1');
  assert.ok(!store.getAllTasks().some((t) => t.title === '临时任务'), '临时任务应被覆盖');
});

test('备份：备份到外部目录', () => {
  reset();
  const dir = path.join(DATA_DIR, 'external-backup');
  const file = store.backupToDir(dir);
  assert.ok(file, '应返回外部备份文件路径');
  assert.ok(fs.existsSync(file), '外部备份文件应存在');
});

/* ============ 周报生成 ============ */
test('周报：生成本周 Markdown 周报', () => {
  reset();
  // 完成一条任务，确保有完成记录
  const t = store.createTask({ title: '周报测试任务', project: '测试项目', tags: ['工作'] });
  store.completeTask(t.id);
  const md = store.generateWeeklyReport(0);
  assert.ok(md.includes('# 工作周报'), '应包含周报标题');
  assert.ok(md.includes('本周完成'), '应包含本周概览');
  assert.ok(md.includes('周报测试任务'), '应包含完成的任务');
  assert.ok(md.includes('测试项目'), '应包含项目统计');
  assert.ok(md.includes('工作'), '应包含标签统计');
});

test('周报：上周/下周偏移不报错', () => {
  reset();
  const last = store.generateWeeklyReport(-1);
  const next = store.generateWeeklyReport(1);
  assert.ok(last.includes('# 工作周报'));
  assert.ok(next.includes('# 工作周报'));
  assert.ok(last.includes('## 一、上周概览'));
  assert.ok(last.includes('## 二、上周完成明细'));
  assert.ok(last.includes('## 六、上周到期未完成'));
  assert.ok(!last.includes('## 一、本周概览'));
  assert.ok(next.includes('## 一、下周概览'));
  assert.ok(next.includes('## 二、下周完成明细'));
  assert.ok(next.includes('## 六、下周到期未完成'));
  assert.ok(!next.includes('## 一、本周概览'));
});

test('日报：按本地日期汇总完成、到期和专注投入', (context) => {
  useMorning(context);
  reset();
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const completed = store.createTask({ title: '日报已完成', due: `${date} 12:00` });
  store.completeTask(completed.id);
  store.createTask({ title: '日报待处理', due: `${date} 18:00` });
  const md = store.generateDailyReport(0);
  assert.ok(md.includes(`# 工作日报（${date}）`));
  assert.ok(md.includes('日报已完成'));
  assert.ok(md.includes('日报待处理'));
  assert.ok(md.includes('专注投入'));
});

test('Agent 报告：日报和周报都走只读报告工具', (context) => {
  useMorning(context);
  reset();
  const before = JSON.stringify(store.getAllTasks());
  const daily = ai.handle('生成今日日报');
  assert.strictEqual(daily.intent, 'report');
  assert.strictEqual(daily.type, 'report');
  assert.strictEqual(daily.reportPeriod, 'daily');
  assert.ok(daily.markdown.includes('# 工作日报'));
  const weekly = ai.handle('整理本周周报');
  assert.strictEqual(weekly.intent, 'report');
  assert.strictEqual(weekly.reportPeriod, 'weekly');
  assert.ok(weekly.markdown.includes('# 工作周报'));
  assert.strictEqual(JSON.stringify(store.getAllTasks()), before, '报告不应修改任务');
});

test('报告事实快照：来源稳定可核对，事实变化后指纹更新', (context) => {
  useMorning(context);
  reset();
  const task = store.createTask({ title: '可追溯报告任务', project: 'Agent 报告', tags: ['工作'] });
  store.completeTask(task.id);
  const first = store.buildReportSnapshot({ period: 'daily', offset: 0, now: Date.now() });
  const second = store.buildReportSnapshot({ period: 'daily', offset: 0, now: Date.now() });
  const source = first.sources.find((item) => item.id === `task-${task.id}`);
  assert.ok(source);
  assert.strictEqual(source.type, 'task');
  assert.ok(first.summary.completed.sourceIds.includes(source.id));
  assert.strictEqual(first.sourceFingerprint, second.sourceFingerprint);
  store.updateTask(task.id, { title: '可追溯报告任务已更名' });
  const changed = store.buildReportSnapshot({ period: 'daily', offset: 0, now: Date.now() });
  assert.notStrictEqual(changed.sourceFingerprint, first.sourceFingerprint);
});

test('报告模型契约：事实必须引用存在来源并保留事实分析建议边界', () => {
  const payload = JSON.stringify({
    title: '日报', audience: '老板', tone: '正式', executiveSummary: '已完成关键事项。',
    sections: [
      { heading: '进展', kind: 'facts', items: [{ text: '完成发布检查。', sourceIds: ['task-1'] }] },
      { heading: '判断', kind: 'analysis', items: [{ text: '交付节奏稳定。', sourceIds: ['task-1'] }] },
      { heading: '下一步', kind: 'suggestions', items: [{ text: '建议继续跟踪反馈。', sourceIds: [] }] }
    ]
  });
  const report = normalizeReportModelResponse(payload, new Set(['task-1']));
  assert.deepStrictEqual(report.referencedSourceIds, ['task-1']);
  const markdown = reportToMarkdown(report);
  assert.match(markdown, /- 完成发布检查。/);
  assert.doesNotMatch(markdown, /\*\*事实\*\*|〔task-1〕/);
  assert.throws(() => normalizeReportModelResponse(payload.replace('task-1', 'task-404'), new Set(['task-1'])), /不存在的来源/);
  const unsourced = JSON.parse(payload);
  unsourced.sections[0].items[0].sourceIds = [];
  assert.throws(() => normalizeReportModelResponse(JSON.stringify(unsourced), new Set(['task-1'])), /必须标注来源/);
  const unsourcedAnalysis = JSON.parse(payload);
  unsourcedAnalysis.sections[1].items[0].sourceIds = [];
  assert.throws(() => normalizeReportModelResponse(JSON.stringify(unsourcedAnalysis), new Set(['task-1'])), /必须标注来源/);
});

test('真正的报告 Agent：模型撰写与连续修订复用事实快照且不修改工作数据', async (context) => {
  useMorning(context);
  reset();
  const work = store.createTask({ title: '完成 Agent 报告重构', project: '助手 Agent', tags: ['工作'] });
  const life = store.createTask({ title: '购买生活用品', project: '个人事务', tags: ['生活'] });
  store.completeTask(work.id);
  store.completeTask(life.id);
  const beforeTasks = JSON.stringify(store.getAllTasks());
  const beforeWorkflow = JSON.stringify(store.getWorkflowState());
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        title: calls === 1 ? 'Agent 工作日报' : 'Agent 工作日报（领导版）',
        audience: '老板', tone: calls === 1 ? '客观' : '正式、专业', executiveSummary: '完成了报告能力重构。',
        sections: [
          { heading: '已完成', kind: 'facts', items: [{ text: '完成 Agent 报告重构。', sourceIds: [`task-${work.id}`] }] },
          { heading: '归纳', kind: 'analysis', items: [{ text: '报告链路已形成可追溯闭环。', sourceIds: [`task-${work.id}`] }] },
          { heading: '建议', kind: 'suggestions', items: [{ text: '建议继续进行真实窗口验证。', sourceIds: [] }] }
        ]
      }) } }] })
    };
  };
  try {
    const first = await ai.handleAuto('生成今日日报，给老板看');
    assert.strictEqual(first.type, 'report');
    assert.strictEqual(first.authoredBy, 'model');
    assert.deepStrictEqual(first.evidenceCounts, { facts: 1, analysis: 1, suggestions: 1 });
    assert.ok(first.sources.some((item) => item.title === '购买生活用品'));
    const fingerprint = first.sourceFingerprint;

    const revised = await ai.handleAuto('语气正式，压缩成五条，隐藏生活任务');
    assert.strictEqual(revised.authoredBy, 'model');
    assert.strictEqual(revised.sourceFingerprint, fingerprint);
    assert.strictEqual(revised.preferences.audience, '老板');
    assert.strictEqual(revised.preferences.tone, '正式、专业');
    assert.strictEqual(revised.preferences.length, '五条以内');
    assert.ok(revised.preferences.exclude.includes('生活'));
    assert.ok(!revised.sources.some((item) => item.title === '购买生活用品'));
    assert.strictEqual(JSON.stringify(store.getAllTasks()), beforeTasks);
    assert.strictEqual(JSON.stringify(store.getWorkflowState()), beforeWorkflow);

    const cancelled = await ai.handleAuto('结束报告修改');
    assert.strictEqual(cancelled.reportSessionActive, false);
    assert.strictEqual(store.getAgentState().reportSession, null);
    assert.strictEqual(calls, 2);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('报告事实快照包含任务语境、子任务进度、新增事项和复盘原因', (context) => {
  useMorning(context);
  reset();
  const now = Date.now();
  const task = store.createTask({
    title: '完成日报质量重构',
    desc: '统一 Agent 生成入口并改善可读性',
    project: '工作助手',
    children: [{ title: '增强事实快照', done: true }, { title: '真实窗口验收', done: false }]
  });
  const snapshot = store.buildReportSnapshot({ period: 'daily', offset: 0, now });
  const source = snapshot.sources.find((item) => item.id === `task-${task.id}`);
  assert.ok(source);
  assert.ok(snapshot.summary.created.count >= 1);
  assert.ok(snapshot.summary.created.sourceIds.includes(`task-${task.id}`));
  assert.strictEqual(source.description, '统一 Agent 生成入口并改善可读性');
  assert.deepStrictEqual(source.childProgress, {
    completed: 1,
    total: 2,
    completedTitles: ['增强事实快照'],
    pendingTitles: ['真实窗口验收']
  });
  assert.match(source.detail, /子任务：已完成 1\/2/);

  const draft = store.previewDailyPlan({ availableMinutes: 60 });
  store.applyDailyPlan(draft);
  store.saveDailyReview(draft.date, {
    note: '核心链路已经完成',
    unfinishedReasons: [{ taskId: draft.items[0].taskId, reason: '等待真实模型验收' }]
  });
  const reviewed = store.buildReportSnapshot({ period: 'daily', offset: 0, now });
  const review = reviewed.sources.find((item) => item.type === 'review' && item.date === draft.date);
  assert.ok(review);
  assert.deepStrictEqual(review.unfinishedReasons, [{ taskId: draft.items[0].taskId, reason: '等待真实模型验收' }]);
});

test('报告工作记录：纳入可追溯来源并按项目合并成果与进展', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const first = store.createTask({ title: '重构报告事实层', project: '助手体验', tags: ['Agent'] });
  const second = store.createTask({ title: '验证报告输出', project: '助手体验', tags: ['Agent'] });
  const outcome = store.addTaskWorkLog(first.id, { kind: 'outcome', text: '事实快照已经覆盖工作记录' });
  const progress = store.addTaskWorkLog(second.id, { kind: 'progress', text: '正在验证日报与周报的一致性' });

  const snapshot = store.buildReportSnapshot({ period: 'daily', offset: 0, now: Date.now() });
  const outcomeSource = snapshot.sources.find((item) => item.type === 'worklog' && item.id.includes(outcome.id));
  const progressSource = snapshot.sources.find((item) => item.type === 'worklog' && item.id.includes(progress.id));
  assert.ok(outcomeSource);
  assert.ok(progressSource);
  assert.strictEqual(snapshot.summary.workLogs.count, 2);
  assert.ok(snapshot.summary.workLogs.byKind.outcome.sourceIds.includes(outcomeSource.id));
  const project = snapshot.projects.find((item) => item.name === '助手体验');
  assert.ok(project.sourceIds.includes(outcomeSource.id));
  assert.ok(project.sourceIds.includes(progressSource.id));

  const report = await ai.generateReport({ period: 'daily', offset: 0, instruction: '生成今日日报' });
  assert.match(report.markdown, /「助手体验」：事实快照已经覆盖工作记录/);
  assert.match(report.markdown, /「助手体验」：正在验证日报与周报的一致性/);
  assert.ok(report.sources.some((item) => item.type === 'worklog'));
});

test('报告生成 API 在本地模式也输出成果、推进与风险结构', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({ aiStage: 'mock' });
  const completed = store.createTask({ title: '完成报告重构', project: '工作助手', desc: '统一日报周报生成链路' });
  store.completeTask(completed.id);
  store.createTask({ title: '验证真实模型效果', project: '工作助手', status: 'doing' });
  const result = await ai.generateReport({ period: 'daily', offset: 0, instruction: '生成今日日报' });
  assert.strictEqual(result.type, 'report');
  assert.strictEqual(result.authoredBy, 'local');
  assert.match(result.markdown, /## 今日完成/);
  assert.match(result.markdown, /完成报告重构/);
  assert.match(result.markdown, /## 正在推进/);
  assert.match(result.markdown, /验证真实模型效果/);
  assert.doesNotMatch(result.markdown, /〔task-|\*\*事实\*\*/);
});

test('真正的报告 Agent：非法模型来源明确降级且可以重试', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      title: '伪造报告', executiveSummary: '',
      sections: [{ heading: '事实', kind: 'facts', items: [{ text: '不存在的成果', sourceIds: ['task-999999'] }] }]
    }) } }] })
  });
  try {
    const result = await ai.handleAuto('生成本周周报');
    assert.strictEqual(result.type, 'report');
    assert.strictEqual(result.authoredBy, 'local');
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.retryable, true);
    assert.match(result.degradeNotice, /模型回复格式异常|本地事实模板/);
    assert.ok(!result.markdown.includes('不存在的成果'));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('真正的报告 Agent：取消生成不会保存半成品会话或修改工作数据', async (context) => {
  useMorning(context);
  reset();
  const before = JSON.stringify({ tasks: store.getAllTasks(), workflow: store.getWorkflowState() });
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();
  try {
    const pending = ai.handleAuto('生成今日日报', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error && error.code === 'AI_REQUEST_CANCELLED');
    assert.strictEqual(store.getAgentState().reportSession, null);
    assert.strictEqual(JSON.stringify({ tasks: store.getAllTasks(), workflow: store.getWorkflowState() }), before);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({ aiStage: 'mock' });
  }
});

test('真正的报告 Agent：过期会话不会误接管普通的语气表达', async (context) => {
  useMorning(context);
  reset();
  store.updateSettings({ aiStage: 'mock' });
  await ai.handleAuto('生成今日日报');
  const session = store.getAgentState().reportSession;
  store.updateAgentState({ reportSession: Object.assign({}, session, { updatedAt: Date.now() - 3 * 60 * 60 * 1000 }) });
  const result = await ai.handleAuto('正式一点');
  assert.notStrictEqual(result.type, 'report');
  assert.strictEqual(store.getAgentState().reportSession, null);
});

test('周报：计划建议只包含所选周期的下一周待办', () => {
  reset();
  const now = new Date();
  const day = now.getDay() || 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() - (day - 1) + 7);
  nextMonday.setHours(10, 0, 0, 0);
  const later = new Date(nextMonday);
  later.setDate(nextMonday.getDate() + 8);
  const due = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  store.createTask({ title: '下一周范围内任务', status: 'todo', due: due(nextMonday) });
  store.createTask({ title: '下一周范围外任务', status: 'todo', due: due(later) });

  const md = store.generateWeeklyReport(0);
  const plan = md.slice(md.indexOf('## 七、下一周计划建议'));
  assert.ok(plan.includes('下一周范围内任务'));
  assert.ok(!plan.includes('下一周范围外任务'));
  assert.ok(plan.includes(' ~ '), '标题应展示计划周期');
});

/* ============ 精细化管理：update / child / postpone / restore ============ */
test('精细修改：改优先级', () => {
  reset();
  const t = store.createTask({ title: '写方案', pri: 2 });
  const r = ai.handle('把 写方案 改成紧急');
  assert.strictEqual(r.intent, 'update');
  assert.strictEqual(r.type, 'update');
  const updated = store.getTask(t.id);
  assert.strictEqual(updated.pri, 4, '优先级应改为紧急');
  assert.deepStrictEqual(r.undo.patch, { pri: 2 });
  assert.deepStrictEqual(r.undo.expected, { pri: 4 });
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(t.id).pri, 2, '撤销后应恢复原优先级');
});

test('引擎选择：本地助手模式不调用已配置的真实模型', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'mock',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('不应调用真实模型');
  };
  try {
    const r = await ai.handleAuto('你好');
    assert.strictEqual(r.engine, 'mock');
    assert.strictEqual(r.degraded, undefined);
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型体验：明确创建走本地快路径且立即报告执行阶段', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('明确操作不应请求模型'); };
  const progress = [];
  try {
    const result = await ai.handleAuto('明天下午3点交性能回归报告', {
      onProgress: (event) => progress.push(event)
    });
    assert.strictEqual(result.type, 'create');
    assert.strictEqual(result.engine, 'local-fast');
    assert.strictEqual(result.task.title, '交性能回归报告');
    assert.strictEqual(progress[0].stage, 'executing');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型体验：今日任务速记直接创建今天任务且不请求模型', async (context) => {
  useMorning(context);
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error('今日任务速记不应请求模型');
  };
  try {
    const result = await ai.handleAuto('今日任务 核查草案召唤两个衍生构筑的升级配置和描述是否正确', {
      onProgress() {}
    });
    assert.strictEqual(result.type, 'create');
    assert.strictEqual(result.engine, 'local-fast');
    assert.strictEqual(result.task.title, '核查草案召唤两个衍生构筑的升级配置和描述是否正确');
    assert.match(result.task.due, /^2026-08-21 18:00$/);
    assert.strictEqual(fetchCount, 0);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('今日任务速记：查询表达不会误创建任务', () => {
  assert.strictEqual(ai.parse('今日任务').intent, 'query');
  assert.strictEqual(ai.parse('今日任务有哪些').intent, 'query');
  assert.strictEqual(ai.parse('查看今日任务').intent, 'query');
  assert.notStrictEqual(ai.parse('今日任务 核查过了吗').intent, 'create');
});

test('统一语义路由：任务速记保留内容载荷并区分句面疑问', () => {
  const capture = routeSemanticInput('今日任务 核查两个衍生构筑的描述是否正确');
  assert.deepStrictEqual({
    intent: capture.intent,
    operationCue: capture.operationCue,
    entityType: capture.entityType,
    payload: capture.payload,
    timeScope: capture.timeScope,
    questionCue: capture.questionCue,
    protected: capture.protected,
    route: capture.route
  }, {
    intent: 'create',
    operationCue: 'task_capture',
    entityType: 'task',
    payload: '核查两个衍生构筑的描述是否正确',
    timeScope: 'today',
    questionCue: false,
    protected: true,
    route: 'protected-local'
  });

  const query = routeSemanticInput('今日任务有哪些？');
  assert.strictEqual(query.intent, 'query');
  assert.strictEqual(query.questionCue, true);
  assert.strictEqual(query.protected, true);
  assert.strictEqual(query.payload, '');
});

test('统一语义路由：自然表达语料保持操作、实体、时间和疑问边界', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'semantic-routing-corpus.json'), 'utf8'));
  corpus.forEach((example) => {
    const routed = routeSemanticInput(example.text);
    ['intent', 'protected', 'entityType', 'timeScope', 'questionCue'].forEach((field) => {
      assert.strictEqual(routed[field], example[field], `${example.text} 的 ${field} 应为 ${example[field]}，实际为 ${routed[field]}`);
    });
  });
});

test('统一语义路由：受保护意图会纠正相反的模型结论', () => {
  const capture = routeSemanticInput('今日任务 核查发布配置');
  const correctedCreate = reconcileModelRoute(capture, {
    intent: 'query', params: { range: 'today' }, confidence: 'high'
  }, ai.parse(capture.raw));
  assert.strictEqual(correctedCreate.intent, 'create');
  assert.strictEqual(correctedCreate.params.title, '核查发布配置');
  assert.deepStrictEqual(correctedCreate.semanticOverride, {
    from: 'query', to: 'create', reason: 'protected_intent'
  });
  const rewrittenTitle = reconcileModelRoute(capture, {
    intent: 'create', params: { title: '模型擅自改写的标题' }, confidence: 'high'
  }, ai.parse(capture.raw));
  assert.strictEqual(rewrittenTitle.intent, 'create');
  assert.strictEqual(rewrittenTitle.params.title, '核查发布配置');
  assert.strictEqual(rewrittenTitle.semanticOverride, undefined);

  const query = routeSemanticInput('今日任务有哪些');
  const correctedQuery = reconcileModelRoute(query, {
    intent: 'create', params: { title: '错误创建' }, confidence: 'high'
  }, ai.parse(query.raw));
  assert.strictEqual(correctedQuery.intent, 'query');
  assert.strictEqual(correctedQuery.params.range, 'today');
  assert.strictEqual(correctedQuery.params.title, undefined);

  const operationQuestion = routeSemanticInput('这个任务可以删除吗？');
  const blockedWrite = reconcileModelRoute(operationQuestion, {
    intent: 'delete', params: { target: '这个任务' }, confidence: 'high'
  });
  assert.strictEqual(blockedWrite.intent, 'delete');
  assert.strictEqual(blockedWrite.confidence, 'low');
  assert.match(blockedWrite.semanticConflict.message, /查询还是修改数据/);
});

test('真实模型：模型不能把受保护的今日任务速记改成查询', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'query', confidence: 'high', range: 'today'
    }) } }] })
  });
  try {
    const parsed = await ai.parseWithLLM('今日任务 核查发布配置');
    assert.strictEqual(parsed.intent, 'create');
    assert.strictEqual(parsed.params.title, '核查发布配置');
    assert.strictEqual(parsed.semantic.protected, true);
    assert.deepStrictEqual(parsed.semanticOverride, {
      from: 'query', to: 'create', reason: 'protected_intent'
    });
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('统一语义路由：任务内对话固定当前任务实体且只生成删除预览', async () => {
  reset();
  const task = store.createTask({ title: '任务内语义边界' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'memo_delete', confidence: 'high', target: '错误备忘录'
    }) } }] })
  });
  try {
    const preview = await ai.previewTaskAction(task.id, '删除');
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.type, 'task_action_preview');
    assert.strictEqual(preview.action.intent, 'delete');
    assert.strictEqual(preview.action.params.taskId, task.id);
    assert.ok(store.getTask(task.id), '生成预览时不得删除当前任务');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('统一语义路由：安排今天入口保护计划意图并保留本地时间约束', async () => {
  reset();
  store.createTask({ title: '发布配置核查', estimatedMinutes: 60 });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'query', confidence: 'high', range: 'today'
    }) } }] })
  });
  try {
    const preview = await ai.previewDailyPlan('下午两点到四点先做发布配置');
    assert.strictEqual(preview.intent, 'daily_plan');
    assert.strictEqual(preview.type, 'daily_plan_preview');
    assert.strictEqual(preview.constraints.startTime, '14:00');
    assert.strictEqual(preview.constraints.endTime, '16:00');
    assert.strictEqual(store.getWorkflowState().dailyPlans[preview.plan.date], undefined, '预览不得直接保存计划');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('本地快路径：明确创建前缀保护标题中的操作词并清理截止残词', () => {
  const parsed = ai.parse('新建任务：取消后恢复验证，今天 21:00 截止');
  assert.strictEqual(parsed.intent, 'create');
  assert.strictEqual(parsed.params.title, '取消后恢复验证');
  assert.match(parsed.params.due, / 21:00$/);

  const completeTitle = ai.parse('新建任务：完成删除流程复盘');
  assert.strictEqual(completeTitle.intent, 'create');
  assert.strictEqual(completeTitle.params.title, '完成删除流程复盘');

  const urgent = ai.parse('帮我记一下，明天下午三点把周报发出去，挺急的');
  assert.strictEqual(urgent.intent, 'create');
  assert.strictEqual(urgent.params.pri, 4);
  assert.doesNotMatch(urgent.params.title, /挺急/);
});

test('真实模型体验：纯对话单次请求并按增量流式返回', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async (url, options) => {
    requestCount += 1;
    assert.strictEqual(JSON.parse(options.body).stream, true);
    const encoder = new TextEncoder();
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"先确认"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"今天重点。"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        }
      })
    };
  };
  const progress = [];
  try {
    const result = await ai.handleAuto('聊聊今天的工作节奏', {
      onProgress: (event) => progress.push(event)
    });
    assert.strictEqual(requestCount, 1);
    assert.strictEqual(result.type, 'chat');
    assert.strictEqual(result.message, '先确认今天重点。');
    assert.deepStrictEqual(progress.filter((event) => event.delta).map((event) => event.delta), ['先确认', '今天重点。']);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型体验：取消进行中的模型请求不会修改数据或进入降级', async () => {
  reset();
  const beforeTasks = store.getAllTasks().map((task) => JSON.stringify(task));
  const beforeState = JSON.stringify(store.getAgentState());
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();
  try {
    const request = ai.handleAuto('聊聊我的工作安排', {
      signal: controller.signal,
      onProgress() {}
    });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(request, (error) => error.code === 'AI_REQUEST_CANCELLED');
    assert.deepStrictEqual(store.getAllTasks().map((task) => JSON.stringify(task)), beforeTasks);
    assert.strictEqual(JSON.stringify(store.getAgentState()), beforeState);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：解析时携带最近对话并保留精细操作参数', async () => {
  reset();
  store.clearChat();
  store.appendChat({ role: 'user', text: '我们先处理季度方案', ts: Date.now() - 2000 });
  store.appendChat({ role: 'ai', text: '好，先从季度方案开始。', ts: Date.now() - 1000 });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          intent: 'postpone',
          target: '季度方案',
          desc: '等客户确认',
          childTitle: '确认预算',
          days: 3
        }) } }]
      })
    };
  };
  try {
    const parsed = await ai.parseWithLLM('那就往后推三天');
    assert.strictEqual(parsed.params.desc, '等客户确认');
    assert.strictEqual(parsed.params.childTitle, '确认预算');
    assert.strictEqual(parsed.params.days, 3);
    assert.deepStrictEqual(
      requestBody.messages.slice(1, -1),
      [
        { role: 'user', content: '我们先处理季度方案' },
        { role: 'assistant', content: '好，先从季度方案开始。' }
      ]
    );
    assert.deepStrictEqual(requestBody.messages.at(-1), { role: 'user', content: '那就往后推三天' });
  } finally {
    global.fetch = originalFetch;
    store.clearChat();
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型：通用对话使用有限历史和任务上下文', async () => {
  reset();
  resetMemos();
  store.clearChat();
  store.createTask({ title: '准备季度复盘' });
  store.createMemo({ title: '复盘访谈记录', content: '客户希望先看留存数据', pinned: true });
  for (let i = 0; i < 8; i++) {
    store.appendChat({ role: 'user', text: `历史问题 ${i}`, ts: Date.now() + i * 2 });
    store.appendChat({ role: 'ai', text: `历史回答 ${i}`, ts: Date.now() + i * 2 + 1 });
  }
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    const content = '{"intent":"unknown","reply":"可以，我们接着刚才的话题。"}';
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
  try {
    const result = await ai.handleAuto('那你觉得下一步呢？');
    assert.strictEqual(result.message, '可以，我们接着刚才的话题。');
    assert.strictEqual(requests.length, 1, '普通对话应在意图解析时直接生成回复');
    const chatMessages = requests[0].messages;
    assert.strictEqual(chatMessages.length, 14, '应限制为 system + 最近 12 条 + 当前输入');
    assert.strictEqual(chatMessages[1].content, '历史问题 2');
    assert.deepStrictEqual(chatMessages.at(-1), { role: 'user', content: '那你觉得下一步呢？' });
    assert.match(chatMessages[0].content, /准备季度复盘/);
    assert.match(chatMessages[0].content, /复盘访谈记录/);
    assert.match(chatMessages[0].content, /客户希望先看留存数据/);
    assert.doesNotMatch(chatMessages[0].content, /3-5 句/);
  } finally {
    global.fetch = originalFetch;
    store.clearChat();
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型：缺少内联回复时回退到对话请求', async () => {
  reset();
  store.clearChat();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    const content = requestCount === 1 ? '{"intent":"unknown"}' : '这是回退生成的回答。';
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
  try {
    const result = await ai.handleAuto('聊聊工作节奏');
    assert.strictEqual(result.message, '这是回退生成的回答。');
    assert.strictEqual(requestCount, 2);
  } finally {
    global.fetch = originalFetch;
    store.clearChat();
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型：回退生成回答时仍保留当前问题相关的完整工作区上下文', async () => {
  reset();
  resetMemos();
  store.clearChat();
  for (let index = 0; index < 50; index++) store.createTask({ title: `普通上下文 ${index + 1}` });
  const target = store.createTask({ title: '晚创建但正在讨论的客户续约' });
  const memo = store.createMemo({ title: '客户续约结论', content: '先确认预算，再约法务评审', pinned: true });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    const content = requests.length === 1 ? '{"intent":"unknown"}' : '建议先确认预算，再推进客户续约。';
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
  try {
    const result = await ai.handleAuto('结合客户续约结论，晚创建但正在讨论的客户续约下一步做什么？');
    assert.strictEqual(result.message, '建议先确认预算，再推进客户续约。');
    assert.strictEqual(requests.length, 2);
    const chatSystemPrompt = requests[1].messages[0].content;
    assert.match(chatSystemPrompt, /workspace_snapshot/);
    assert.match(chatSystemPrompt, new RegExp(target.title));
    assert.match(chatSystemPrompt, new RegExp(memo.title));
    assert.match(chatSystemPrompt, /dailyWorkflow/);
  } finally {
    global.fetch = originalFetch;
    store.clearChat();
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：备忘录操作只由模型解析，修改仍走本地规则', async () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '客户决策记录', content: '先做 A 方案' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        intent: 'memo_pin',
        target: '客户决策记录',
        pinned: true
      }) } }] })
    };
  };
  try {
    const result = await ai.handleAuto('把刚才那份客户决定放到最上面');
    assert.strictEqual(result.engine, 'llm');
    assert.strictEqual(result.type, 'memo_pin');
    assert.strictEqual(result.memo.id, memo.id);
    assert.strictEqual(store.getMemo(memo.id).pinned, true);
    assert.strictEqual(requestCount, 1);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型：备忘录拆分使用模型给出的具体步骤并等待确认', async () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '游戏构筑与地图优化备忘', content: '平衡构筑并优化地图节奏' });
  ai.handle('查看我的备忘录');
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        intent: 'memo_split',
        target: '游戏构筑与地图优化备忘',
        steps: ['盘点现有构筑流派', '调整地图奖励节奏', '验证新路线数据']
      }) } }] })
    };
  };
  try {
    const preview = await ai.handleAuto('就拆构筑那个吧');
    assert.strictEqual(preview.engine, 'llm');
    assert.strictEqual(preview.type, 'confirm');
    assert.match(preview.message, /盘点现有构筑流派/);
    assert.strictEqual(preview.params.memoId, undefined, '稳定 ID 应由本地执行层绑定并保存在确认状态中');

    const created = await ai.handleAuto('确认执行');
    assert.strictEqual(created.type, 'memo_split');
    assert.deepStrictEqual(created.tasks.map((task) => task.title), ['盘点现有构筑流派', '调整地图奖励节奏', '验证新路线数据']);
    assert.strictEqual(requestCount, 1, '确认阶段不应再次请求模型');
    assert.ok(store.getMemo(memo.id));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型：服务超时后本地判断必须确认且不会立即修改数据', async () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '游戏构筑与地图优化备忘', content: '构筑平衡\n地图节奏' });
  ai.handle('查看我的备忘录');
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    const result = await ai.handleAuto('就拆构筑那个吧');
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.type, 'confirm');
    assert.strictEqual(store.getAgentState().pending.params.memoId, memo.id);
    assert.strictEqual(result.fallbackMode, 'preflight_local');
    assert.match(result.message, /建议把「游戏构筑与地图优化备忘」拆成/);
    assert.strictEqual(result.degradeNotice, '模型响应超时');
    assert.strictEqual(store.getAllTasks().length, 8, '确认本地判断前不得创建任务');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('真实模型：模型失败时不会静默创建规则引擎猜出的任务', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network unavailable'); };
  try {
    const before = store.getAllTasks().length;
    const proposal = await ai.handleAuto('明天下午3点交周报');
    assert.strictEqual(proposal.type, 'confirm');
    assert.strictEqual(proposal.fallbackMode, 'confirm_local');
    assert.strictEqual(store.getAllTasks().length, before);
    const created = await ai.handleAuto('确认执行');
    assert.strictEqual(created.type, 'create');
    assert.strictEqual(store.getAllTasks().length, before + 1);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：只读查询失败时可安全使用本地能力', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network unavailable'); };
  try {
    const before = store.getAllTasks().map((task) => JSON.stringify(task));
    const result = await ai.handleAuto('今天我要做什么');
    assert.strictEqual(result.type, 'query');
    assert.strictEqual(result.fallbackMode, 'read_only');
    assert.deepStrictEqual(store.getAllTasks().map((task) => JSON.stringify(task)), before);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：普通建议失败时不会被宽泛的安排词误导为任务排序', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    const before = store.getAllTasks().map((task) => JSON.stringify(task));
    const result = await ai.handleAuto('今天下午容易分心，我该怎样安排接下来一小时？');
    assert.strictEqual(result.type, 'error');
    assert.strictEqual(result.fallbackMode, 'unavailable');
    assert.match(result.message, /模型响应超时/);
    assert.match(result.message, /没有用本地规则猜测/);
    assert.deepStrictEqual(store.getAllTasks().map((task) => JSON.stringify(task)), before);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：本地写入失败不会伪装成模型故障或自动重放', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  const originalCreateTask = store.createTask;
  let requestCount = 0;
  let createCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        schemaVersion: 1, intent: 'create', confidence: 'high', title: '写入失败测试'
      }) } }] })
    };
  };
  store.createTask = () => {
    createCount += 1;
    throw new Error('disk unavailable');
  };
  try {
    const result = await ai.handleAuto('新建写入失败测试');
    assert.strictEqual(result.type, 'error');
    assert.strictEqual(result.localFailure, true);
    assert.strictEqual(result.resultUnknown, true);
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.degraded, undefined);
    assert.match(result.message, /不会自动重试/);
    assert.strictEqual(requestCount, 1);
    assert.strictEqual(createCount, 1);
  } finally {
    store.createTask = originalCreateTask;
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：不得把 reasoning 当作最终工具调用', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '', reasoning: '{"intent":"create","title":"不应创建"}' } }] })
  });
  try {
    const before = store.getAllTasks().length;
    const result = await ai.handleAuto('帮我处理一下');
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(store.getAllTasks().length, before);
    assert.strictEqual(result.degradeNotice, '模型回复格式异常');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：非法字段不会进入执行层', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"schemaVersion":1,"intent":"create","title":"交周报","pri":99}' } }] })
  });
  try {
    const before = store.getAllTasks().length;
    const result = await ai.handleAuto('明天交周报');
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.type, 'confirm');
    assert.strictEqual(store.getAllTasks().length, before);
    assert.strictEqual(result.degradeNotice, '模型回复格式异常');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：结构化上下文明确区分任务、备忘录和最近指代', async () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '构筑优化任务' });
  const memo = store.createMemo({ title: '构筑优化备忘', content: '地图节奏和流派平衡' });
  ai.handle('查看备忘录 构筑优化');
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"schemaVersion":1,"intent":"unknown","confidence":"high","reply":"知道了。"}' } }] })
    };
  };
  try {
    await ai.handleAuto('它们有什么区别？');
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, new RegExp(`"entityType": "task"[\\s\\S]*?"id": ${task.id}`));
    assert.match(prompt, new RegExp(`"entityType": "memo"[\\s\\S]*?"id": ${memo.id}`));
    assert.match(prompt, new RegExp(`"recentFocus"[\\s\\S]*?"entityType": "memo"[\\s\\S]*?"id": ${memo.id}`));
    assert.match(prompt, /taskEntities 和 memoEntities 是两种不同实体/);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：低置信度只追问，不执行写操作', async () => {
  reset();
  resetMemos();
  store.createTask({ title: '客户记录' });
  store.createMemo({ title: '客户记录', content: '客户偏好 A 方案' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1,
      intent: 'delete',
      confidence: 'low',
      target: '客户记录',
      clarification: '你要删除同名的任务，还是备忘录？'
    }) } }] })
  });
  try {
    const taskCount = store.getAllTasks().length;
    const memoCount = store.getAllMemos().length;
    const result = await ai.handleAuto('把客户记录删了');
    assert.strictEqual(result.type, 'clarify');
    assert.strictEqual(result.message, '「客户记录」同时存在任务和备忘录。你想删除哪一种？');
    assert.strictEqual(store.getAllTasks().length, taskCount);
    assert.strictEqual(store.getAllMemos().length, memoCount);
    assert.strictEqual(store.getAgentState().pending.kind, 'model_clarification');
    assert.strictEqual(ai.getSessionState().pending.clarification.mode, 'model');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：同名任务与备忘录会覆盖模型的错误高置信度选择', async () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '同名客户记录' });
  const memo = store.createMemo({ title: '同名客户记录', content: '备忘内容' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    const response = requestCount === 1
      ? { schemaVersion: 1, intent: 'delete', confidence: 'high', target: '同名客户记录' }
      : { schemaVersion: 1, intent: 'memo_delete', confidence: 'high', target: '同名客户记录' };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] })
    };
  };
  try {
    const question = await ai.handleAuto('把同名客户记录删了');
    assert.strictEqual(question.type, 'clarify');
    assert.strictEqual(question.confidence, 'low');
    assert.match(question.message, /同时存在任务和备忘录/);
    assert.ok(store.getTask(task.id));
    assert.ok(store.getMemo(memo.id));

    const proposal = await ai.handleAuto('备忘录那条');
    assert.strictEqual(proposal.intent, 'memo_delete');
    assert.strictEqual(proposal.type, 'confirm');
    assert.ok(store.getTask(task.id));
    assert.ok(store.getMemo(memo.id));
    await ai.handleAuto('取消');
    assert.strictEqual(requestCount, 2);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：确认阶段的用户纠正会重新理解而不是重复确认', async () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '错误任务目标' });
  const memo = store.createMemo({ title: '正确备忘目标', content: '应操作这条' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  const requests = [];
  global.fetch = async (url, options) => {
    requestCount += 1;
    requests.push(JSON.parse(options.body));
    const response = requestCount === 1
      ? { schemaVersion: 1, intent: 'delete', confidence: 'high', target: '错误任务目标' }
      : { schemaVersion: 1, intent: 'memo_delete', confidence: 'high', target: '正确备忘目标' };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] })
    };
  };
  try {
    const wrongProposal = await ai.handleAuto('把不需要的内容删掉');
    assert.strictEqual(wrongProposal.type, 'confirm');
    assert.match(wrongProposal.message, /错误任务目标/);

    const corrected = await ai.handleAuto('不对，我说的是备忘录“正确备忘目标”');
    assert.strictEqual(corrected.intent, 'memo_delete');
    assert.strictEqual(corrected.type, 'confirm');
    assert.match(corrected.message, /正确备忘目标/);
    assert.doesNotMatch(corrected.message, /仍在等待确认/);
    assert.match(requests[1].messages[0].content, /把不需要的内容删掉/);
    assert.match(requests[1].messages[0].content, /conversationTurns/);
    assert.ok(store.getTask(task.id));
    assert.ok(store.getMemo(memo.id));
    await ai.handleAuto('取消');
    assert.strictEqual(requestCount, 2);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：稳定的最近指代不会为可撤销修改重复确认', async () => {
  reset();
  const task = store.createTask({ title: '客户续约方案', pri: 2 });
  ai.handle('查看任务 客户续约方案');
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'update', confidence: 'medium', target: '客户续约方案', pri: 4
    }) } }] })
  });
  try {
    const result = await ai.handleAuto('把它改成紧急');
    assert.strictEqual(result.type, 'update');
    assert.strictEqual(result.confidence, 'high');
    assert.strictEqual(store.getTask(task.id).pri, 4);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：唯一完整标题的恢复操作不会重复确认', async () => {
  reset();
  const task = store.createTask({ title: '误删的发布清单' });
  store.deleteTask(task.id);
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'restore', confidence: 'medium', target: '发布清单'
    }) } }] })
  });
  try {
    const result = await ai.handleAuto('把误删的发布清单找回来');
    assert.strictEqual(result.type, 'restore');
    assert.strictEqual(result.confidence, 'high');
    assert.strictEqual(store.getTask(task.id).title, '误删的发布清单');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('本地降级：备忘录正文里的“看重”不会把创建误判成查询', () => {
  reset();
  resetMemos();
  const parsed = ai.parse('这不是任务，存到备忘录：客户更看重稳定性，下次评审先讲容灾方案');
  assert.strictEqual(parsed.intent, 'memo_create');
  assert.match(parsed.params.memoContent, /客户更看重稳定性/);
});

test('真实模型：最近备忘录的“拆成任务”不会被任务二字改成任务拆分', async () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '地图优化想法', content: '盘点障碍物\n调整奖励路线' });
  ai.handle('查看备忘录 地图优化想法');
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'split', confidence: 'high', target: '地图优化想法', count: 2
    }) } }] })
  });
  try {
    const result = await ai.handleAuto('这个可以拆成任务吗');
    assert.strictEqual(result.intent, 'memo_split');
    assert.strictEqual(result.type, 'confirm');
    assert.strictEqual(result.confirmation.params.memoId, memo.id);
    assert.strictEqual(store.getAllTasks().length, 8);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：复合写请求被模型截断时阻断残缺操作', async () => {
  reset();
  const task = store.createTask({ title: '旧任务' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'delete', confidence: 'high', target: '旧任务'
    }) } }] })
  });
  try {
    const result = await ai.handleAuto('新建一项准备发布，然后删除旧任务');
    assert.strictEqual(result.intent, 'plan');
    assert.strictEqual(result.type, 'clarify');
    assert.match(result.message, /没有完整保留每一步/);
    assert.strictEqual(store.getAgentState().pending.kind, 'model_clarification');
    assert.ok(store.getTask(task.id));
    assert.strictEqual(store.getAllTasks().some((item) => item.title === '准备发布'), false);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：服务失败时也不会把复合写请求降级成残缺操作', async () => {
  reset();
  const task = store.createTask({ title: '旧任务' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network unavailable'); };
  try {
    const result = await ai.handleAuto('新建一项准备发布，然后删除旧任务');
    assert.strictEqual(result.intent, 'plan');
    assert.strictEqual(result.type, 'clarify');
    assert.strictEqual(result.fallbackMode, 'compound_clarification');
    assert.strictEqual(store.getAgentState().pending.kind, 'model_clarification');
    assert.ok(store.getTask(task.id));
    assert.strictEqual(store.getAllTasks().some((item) => item.title === '准备发布'), false);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：连续纠正会保留完整表达链而不是只记最后一句', async () => {
  reset();
  resetMemos();
  const first = store.createTask({ title: '旧任务目标' });
  const memo = store.createMemo({ title: '中间备忘目标', content: '仍然不是这条' });
  const finalTask = store.createTask({ title: '最终任务目标' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    const responses = [
      { schemaVersion: 1, intent: 'delete', confidence: 'high', target: '旧任务目标' },
      { schemaVersion: 1, intent: 'memo_delete', confidence: 'high', target: '中间备忘目标' },
      { schemaVersion: 1, intent: 'complete', confidence: 'high', target: '最终任务目标' }
    ];
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(responses[requests.length - 1]) } }] })
    };
  };
  try {
    assert.strictEqual((await ai.handleAuto('处理掉旧的内容')).type, 'confirm');
    assert.strictEqual((await ai.handleAuto('不对，我说的是中间备忘目标')).type, 'confirm');
    const corrected = await ai.handleAuto('还是不对，应该完成最终任务目标');
    assert.strictEqual(corrected.intent, 'complete');
    assert.strictEqual(corrected.type, 'complete');
    assert.match(requests[2].messages[0].content, /处理掉旧的内容/);
    assert.match(requests[2].messages[0].content, /不对，我说的是中间备忘目标/);
    assert.ok(store.getTask(first.id));
    assert.ok(store.getMemo(memo.id));
    assert.strictEqual(store.getTask(finalTask.id).status, 'done');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：澄清后的短回答继续交给模型并保留安全确认', async () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '客户记录' });
  const memo = store.createMemo({ title: '客户记录', content: '客户偏好 A 方案' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    const response = requests.length === 1
      ? {
          schemaVersion: 1,
          intent: 'delete',
          confidence: 'low',
          target: '客户记录',
          clarification: '你要删除同名的任务，还是备忘录？'
        }
      : { schemaVersion: 1, intent: 'memo_delete', confidence: 'high', target: '客户记录' };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] })
    };
  };
  try {
    const question = await ai.handleAuto('把客户记录删了');
    assert.strictEqual(question.type, 'clarify');

    const proposal = await ai.handleAuto('备忘录那条');
    assert.strictEqual(proposal.type, 'confirm');
    assert.strictEqual(proposal.intent, 'memo_delete');
    assert.match(requests[1].messages[0].content, /originalRequest/);
    assert.match(requests[1].messages[0].content, /把客户记录删了/);
    assert.ok(store.getTask(task.id));
    assert.ok(store.getMemo(memo.id));

    const cancelled = await ai.handleAuto('取消');
    assert.strictEqual(cancelled.type, 'info');
    assert.strictEqual(requests.length, 2, '取消安全确认不应再次请求模型');
    assert.ok(store.getMemo(memo.id));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：澄清续接失败时保留状态且不按短回答本地猜测', async () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '失败续接记录' });
  store.createMemo({ title: '失败续接记录', content: '不能误删' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    if (requestCount > 1) throw new Error('network unavailable');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        schemaVersion: 1,
        intent: 'delete',
        confidence: 'low',
        target: '失败续接记录',
        clarification: '你要删除任务还是备忘录？'
      }) } }] })
    };
  };
  try {
    await ai.handleAuto('删掉失败续接记录');
    const result = await ai.handleAuto('备忘录');
    assert.strictEqual(result.type, 'error');
    assert.strictEqual(result.fallbackMode, 'clarification_unavailable');
    assert.strictEqual(result.retryable, true);
    assert.strictEqual(store.getAgentState().pending.kind, 'model_clarification');
    assert.strictEqual(store.getAgentState().pending.retryText, '备忘录');
    assert.strictEqual(ai.getSessionState().pending.retryText, '备忘录');
    assert.match(ai.getSessionState().pending.recoveryNotice, /重试后会继续原操作/);
    assert.ok(store.getTask(task.id));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：中置信度写操作先确认理解', async () => {
  reset();
  const task = store.createTask({ title: '中置信度方案' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1, intent: 'start', confidence: 'medium', target: '中置信度方案'
    }) } }] })
  });
  try {
    const proposal = await ai.handleAuto('处理一下中置信度方案');
    assert.strictEqual(proposal.type, 'confirm');
    assert.strictEqual(store.getTask(task.id).status, 'todo');
    const started = await ai.handleAuto('确认执行');
    assert.strictEqual(started.type, 'start');
    assert.strictEqual(store.getTask(task.id).status, 'doing');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：中置信度删除直接展示一次完整安全确认', async () => {
  reset();
  const task = store.createTask({ title: '待删除的中置信度草稿' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        schemaVersion: 1, intent: 'delete', confidence: 'medium', target: '待删除的中置信度草稿'
      }) } }] })
    };
  };
  try {
    const proposal = await ai.handleAuto('这份草稿可以删了');
    assert.strictEqual(proposal.type, 'confirm');
    assert.match(proposal.message, /删除后可以从回收站恢复/);
    assert.doesNotMatch(proposal.message, /这个判断还有一点不确定/);
    assert.strictEqual(store.getTask(task.id).title, '待删除的中置信度草稿');
    const removed = await ai.handleAuto('确认执行');
    assert.strictEqual(removed.type, 'delete');
    assert.strictEqual(store.getTask(task.id), null);
    assert.strictEqual(requestCount, 1);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：失败后的本地删除判断直接进入安全确认', async () => {
  reset();
  const task = store.createTask({ title: '本地降级删除草稿' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network unavailable'); };
  try {
    const proposal = await ai.handleAuto('删除 本地降级删除草稿');
    assert.strictEqual(proposal.type, 'confirm');
    assert.strictEqual(proposal.fallbackMode, 'preflight_local');
    assert.match(proposal.message, /模型服务短暂异常/);
    assert.match(proposal.message, /删除后可以从回收站恢复/);
    assert.strictEqual(store.getTask(task.id).title, '本地降级删除草稿');
    const removed = await ai.handleAuto('确认执行');
    assert.strictEqual(removed.type, 'delete');
    assert.strictEqual(store.getTask(task.id), null);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：一句话可规划独立的任务和备忘录新增操作', async () => {
  reset();
  resetMemos();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        schemaVersion: 1,
        confidence: 'medium',
        actions: [
          { intent: 'memo_create', memoTitle: '客户偏好', memoContent: '客户更喜欢 A 方案' },
          { intent: 'create', title: '周五确认客户方案', pri: 3, due: '2026-08-28 10:00' }
        ]
      }) } }] })
    };
  };
  try {
    const taskCount = store.getAllTasks().length;
    const proposal = await ai.handleAuto('记下客户喜欢 A 方案，再建个周五确认的任务');
    assert.strictEqual(proposal.intent, 'plan');
    assert.strictEqual(proposal.type, 'confirm');
    assert.match(proposal.message, /创建备忘录「客户偏好」/);
    assert.match(proposal.message, /创建任务「周五确认客户方案」/);
    assert.strictEqual(store.getAllTasks().length, taskCount);
    assert.strictEqual(store.getAllMemos().length, 0);

    const result = await ai.handleAuto('确认执行');
    assert.strictEqual(result.type, 'plan');
    assert.strictEqual(result.tasks.length, 1);
    assert.strictEqual(result.memos.length, 1);
    assert.strictEqual(store.getAllTasks().length, taskCount + 1);
    assert.strictEqual(store.getAllMemos()[0].title, '客户偏好');
    assert.strictEqual(requestCount, 1, '确认组合计划时不应再次请求模型');
    assert.strictEqual(store.getAgentState().lastEntity.type, 'task');
    assert.strictEqual(store.getAgentState().lastEntity.title, '周五确认客户方案');
    assert.strictEqual(result.undoable, true);
    const undone = ai.undoAction(result.undo);
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(store.getAllTasks().length, taskCount);
    assert.strictEqual(store.getAllMemos().length, 0);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('组合新增：任一内容被后续修改时拒绝整体撤销', async () => {
  reset();
  resetMemos();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1,
      confidence: 'high',
      actions: [
        { intent: 'memo_create', memoTitle: '整体撤销备忘', memoContent: '原始内容' },
        { intent: 'create', title: '整体撤销任务' }
      ]
    }) } }] })
  });
  try {
    await ai.handleAuto('同时新增任务和备忘录');
    const result = await ai.handleAuto('确认执行');
    store.updateTask(result.tasks[0].id, { pri: 4 });
    const undone = ai.undoAction(result.undo);
    assert.strictEqual(undone.ok, false);
    assert.strictEqual(undone.reason, 'conflict');
    assert.ok(store.getTask(result.tasks[0].id));
    assert.ok(store.getMemo(result.memos[0].id));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：组合计划可确认并原子执行修改与完成操作', async () => {
  reset();
  const first = store.createTask({ title: '完成旧方案' });
  const second = store.createTask({ title: '调整新方案', pri: 2 });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1,
      confidence: 'high',
      actions: [
        { intent: 'complete', target: '完成旧方案' },
        { intent: 'update', target: '调整新方案', pri: 4 }
      ]
    }) } }] })
  });
  try {
    const proposal = await ai.handleAuto('完成旧方案，然后把新方案改成紧急');
    assert.strictEqual(proposal.type, 'confirm');
    assert.match(proposal.message, /完成任务「完成旧方案」/);
    assert.match(proposal.message, /修改任务「调整新方案」/);
    assert.strictEqual(store.getTask(first.id).status, 'todo');
    assert.strictEqual(store.getTask(second.id).pri, 2);

    const result = await ai.handleAuto('确认执行');
    assert.strictEqual(result.type, 'plan');
    assert.deepStrictEqual(result.operations.map((operation) => operation.type), ['complete', 'update']);
    assert.strictEqual(store.getTask(first.id).status, 'done');
    assert.strictEqual(store.getTask(second.id).pri, 4);
    const undone = ai.undoAction(result.undo);
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(store.getTask(first.id).status, 'todo');
    assert.strictEqual(store.getTask(second.id).pri, 2);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('组合事务：中途失败时回滚已经执行的操作', () => {
  reset();
  const task = store.createTask({ title: '事务回滚任务', pri: 2 });
  assert.throws(() => store.runAgentTransaction(() => {
    store.updateTask(task.id, { pri: 4 });
    store.createTask({ title: '不应留下的任务' });
    throw new Error('模拟第二步失败');
  }), /模拟第二步失败/);
  assert.strictEqual(store.getTask(task.id).pri, 2);
  assert.ok(!store.getAllTasks().some((entry) => entry.title === '不应留下的任务'));
});

test('真实模型：组合计划仍拒绝危险删除操作', async () => {
  reset();
  const target = store.createTask({ title: '不得组合删除的任务' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: 'https://example.invalid/v1', aiApiKey: 'test-key', aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: 1,
      confidence: 'high',
      actions: [
        { intent: 'create', title: '允许新增的任务' },
        { intent: 'delete', target: '不得组合删除的任务' }
      ]
    }) } }] })
  });
  try {
    const result = await ai.handleAuto('新建一项并删除旧任务');
    assert.strictEqual(result.type, 'clarify');
    assert.ok(store.getTask(target.id));
    assert.ok(!store.getAllTasks().some((task) => task.title === '允许新增的任务'));
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage, aiProvider: previous.aiProvider, aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey, aiModel: previous.aiModel
    });
  }
});

test('真实模型：危险操作确认阶段不再次请求模型', async () => {
  reset();
  const task = store.createTask({ title: '废弃草稿' });
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'llm',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ intent: 'delete', target: '废弃草稿' }) } }] })
    };
  };
  try {
    const ask = await ai.handleAuto('这份已经不要了');
    assert.strictEqual(ask.type, 'confirm');
    assert.ok(store.getTask(task.id), '确认前不能删除');
    const result = await ai.handleAuto('确认执行');
    assert.strictEqual(result.type, 'delete');
    assert.strictEqual(store.getTask(task.id), null);
    assert.strictEqual(requestCount, 1, '确认阶段必须使用已保存的结构化操作');
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('助手体验：完成任务后推荐真实的下一项', () => {
  store.clearAllTasks();
  store.createTask({ title: '已经处理的事项', pri: 2 });
  store.createTask({ title: '下一项紧急工作', pri: 4 });
  const result = ai.handle('完成 已经处理的事项');
  assert.match(result.message, /接下来优先处理「下一项紧急工作」/);
  assert.match(result.message, /因为它紧急优先级/);
  assert.deepStrictEqual(result.followUps, [
    { label: '开始下一项', prompt: '开始 下一项紧急工作' },
    { label: '重新安排', prompt: '怎么安排今天的优先级' }
  ]);
});

test('助手体验：「接下来呢」给出单一焦点、理由和有限顺序', () => {
  store.clearAllTasks();
  resetMemos();
  const focus = store.createTask({ title: '客户回访', status: 'doing', pri: 2, tags: ['客户'] });
  store.createTask({ title: '补交报销', pri: 4, due: '2020-01-01 09:00' });
  store.createTask({ title: '整理周报', pri: 3 });
  store.createTask({ title: '购买耗材', pri: 1 });
  store.createMemo({ title: '客户回访要点', content: '先确认预算', tags: ['客户'], pinned: true });

  const result = ai.handle('接下来呢');
  assert.strictEqual(result.intent, 'suggest');
  assert.strictEqual(result.task.id, focus.id);
  assert.match(result.message, /建议先处理「客户回访」/);
  assert.match(result.message, /已经在进行/);
  assert.match(result.message, /置顶备忘录「客户回访要点」/);
  assert.match(result.message, /先确认预算/);
  assert.doesNotMatch(result.message, /^4\./m, '建议列表最多展示三项');
  assert.deepStrictEqual(result.followUps[0], { label: '继续第一项', prompt: '开始 客户回访' });
});

test('助手体验：开始任务时结合预计用时说明当前焦点', () => {
  store.clearAllTasks();
  store.createTask({ title: '核对发布清单', estimatedMinutes: 35 });
  const result = ai.handle('开始 核对发布清单');
  assert.match(result.message, /已成为当前焦点/);
  assert.match(result.message, /预计用时 35 分钟/);
});

test('助手体验：问候会反映当前工作状态而不是展示命令说明', () => {
  store.clearAllTasks();
  store.createTask({ title: '整理发布说明', status: 'doing' });
  store.createTask({ title: '处理旧工单', due: '2020-01-01 09:00' });
  const result = ai.handle('你好');
  assert.match(result.message, /1 项进行中/);
  assert.match(result.message, /1 项已逾期/);
  assert.match(result.message, /整理发布说明/);
  assert.doesNotMatch(result.message, /比如|API Key/);
  assert.strictEqual(result.followUps[0].label, '继续处理');
});

test('助手体验：标题有小错时给出候选并沿用原操作', () => {
  store.clearAllTasks();
  const task = store.createTask({ title: '提交季度方案' });
  const ask = ai.handle('完成 提交季度方按');
  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.candidates[0].id, task.id);
  assert.match(ask.message, /没有精确找到/);
  const completed = ai.handle('第一个');
  assert.strictEqual(completed.type, 'complete');
  assert.strictEqual(completed.task.id, task.id);
});

test('助手体验：今日新任务和清空待办给出不同下一步', () => {
  store.clearAllTasks();
  const created = ai.handle('今天 处理合同');
  assert.match(created.message, /已加入今天的安排/);
  assert.deepStrictEqual(created.followUps, [
    { label: '开始这个任务', prompt: '开始 处理合同' },
    { label: '查看今日安排', prompt: '今天我要做什么' }
  ]);

  const completed = ai.handle('完成 处理合同');
  assert.match(completed.message, /目前没有未完成任务了/);
  assert.deepStrictEqual(completed.followUps, [
    { label: '查看完成情况', prompt: '今天完成了多少' }
  ]);
});

test('助手体验：查看任务快捷操作沿用最近任务上下文', () => {
  store.clearAllTasks();
  store.createTask({ title: '季度方案' });
  store.createTask({ title: '客户回访' });
  const updated = ai.handle('把 季度方案 改成紧急');
  assert.deepStrictEqual(updated.followUps[0], {
    label: '查看任务',
    prompt: '查看刚说的那个任务'
  });
  const query = ai.handle(updated.followUps[0].prompt);
  assert.match(query.message, /季度方案/);
  assert.doesNotMatch(query.message, /客户回访/);
});

test('助手体验：恢复已完成任务不会建议重新开始', () => {
  store.clearAllTasks();
  const task = store.createTask({ title: '已经完成的任务' });
  store.completeTask(task.id);
  const completedAt = store.getTask(task.id).completedAt;
  store.deleteTask(task.id);

  const restored = ai.handle('恢复 已经完成的任务');
  assert.strictEqual(restored.task.status, 'done');
  assert.match(restored.message, /不会重新进入待办/);
  assert.deepStrictEqual(restored.followUps, [
    { label: '查看完成情况', prompt: '今天完成了多少' },
    { label: '查看全部任务', prompt: '查看我的任务' }
  ]);
  assert.strictEqual(store.getTask(task.id).completedAt, completedAt);
});

test('助手体验：查询后的优先任务限制在本次结果集', () => {
  store.clearAllTasks();
  const work = store.createTask({ title: '紧急工作', pri: 4, tags: ['工作'] });
  const life = store.createTask({ title: '生活采购', pri: 1, tags: ['生活'] });
  const otherLife = store.createTask({ title: '整理衣柜', pri: 2, tags: ['生活'] });

  const result = ai.handle('#生活 的任务');
  assert.deepStrictEqual(result.taskIds, [life.id, otherLife.id]);
  assert.deepStrictEqual(result.followUps, [
    { label: '开始优先任务', prompt: '开始 整理衣柜' }
  ]);
  assert.notStrictEqual(result.followUps[0].prompt, `开始 ${work.title}`);
});

test('精细修改：旧撤销不覆盖后续修改', () => {
  reset();
  const t = store.createTask({ title: '写方案', pri: 2 });
  const r = ai.handle('把 写方案 改成紧急');
  store.updateTask(t.id, { pri: 3 });
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, false);
  assert.strictEqual(undone.reason, 'conflict');
  assert.strictEqual(store.getTask(t.id).pri, 3, '冲突时应保留后续修改');
});

test('精细修改：改截止时间', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('把 写方案 改到明天下午3点');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.ok(updated.due && updated.due.includes('15:00'), '截止时间应改为 15:00');
});

test('精细修改：改项目', () => {
  reset();
  const t = store.createTask({ title: '写方案', project: 'Q3 规划' });
  const r = ai.handle('把 写方案 移到 日常工作');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.strictEqual(updated.project, '日常工作', '项目应改为日常工作');
});

test('精细修改：加标签', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('给 写方案 加标签 重要');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.ok(updated.tags.includes('重要'), '应添加标签「重要」');
  // 加标签「重要」不应误改优先级
  assert.strictEqual(updated.pri, 2, '优先级不应被误改');
});

test('精细修改：加备注', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('给 写方案 加备注 记得带资料');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.strictEqual(updated.desc, '记得带资料', '应更新备注');
});

test('子任务：加子任务', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('给 写方案 加子任务 搭框架');
  assert.strictEqual(r.intent, 'child');
  const updated = store.getTask(t.id);
  assert.ok(updated.children.some((c) => (c.title || c) === '搭框架'), '应添加子任务「搭框架」');
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(t.id).children.length, 0, '撤销后应移除新增子任务');
});

test('顺延：推迟任务', () => {
  reset();
  const t = store.createTask({ title: '写方案', due: '2026-08-20 15:00' });
  const r = ai.handle('把 写方案 推迟 3 天');
  assert.strictEqual(r.intent, 'postpone');
  const updated = store.getTask(t.id);
  assert.ok(updated.due.includes('2026-08-23'), '应推迟 3 天');
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(t.id).due, '2026-08-20 15:00', '撤销后应恢复原截止时间');
});

test('恢复：从回收站恢复', () => {
  reset();
  const t = store.createTask({ title: '待恢复任务' });
  store.deleteTask(t.id);
  const r = ai.handle('恢复 待恢复任务');
  assert.strictEqual(r.intent, 'restore');
  assert.ok(store.getAllTasks().some((x) => x.title === '待恢复任务'), '任务应恢复');
});

/* ============ 备忘录 ============ */
function resetMemos() {
  store.getAllMemos().forEach((memo) => store.deleteMemo(memo.id));
  store.emptyMemoTrash();
}

test('备忘录：创建、编辑和置顶排序', () => {
  resetMemos();
  const first = store.createMemo({ title: '会议记录', content: '确认下周目标', tags: ['工作'] });
  const second = store.createMemo({ title: '灵感', content: '做一个更轻量的入口' });
  const updated = store.updateMemo(first.id, { content: '确认下周目标和负责人', pinned: true });
  assert.strictEqual(updated.content, '确认下周目标和负责人');
  assert.strictEqual(store.getAllMemos()[0].id, first.id, '置顶备忘录应排在最前');
  assert.ok(store.getAllMemos().some((memo) => memo.id === second.id));
});

test('备忘录：删除后可从回收站恢复', () => {
  resetMemos();
  const memo = store.createMemo({ title: '待恢复备忘录', content: '不能丢' });
  store.deleteMemo(memo.id);
  assert.strictEqual(store.getAllMemos().length, 0);
  assert.strictEqual(store.getDeletedMemos()[0].id, memo.id);
  const restored = store.restoreMemo(memo.id);
  assert.strictEqual(restored.title, '待恢复备忘录');
  assert.strictEqual(store.getDeletedMemos().length, 0);
});

test('备忘录：只能永久删除已进入回收站的内容', () => {
  resetMemos();
  const memo = store.createMemo({ title: '待永久删除', content: '过期内容' });
  assert.throws(() => store.purgeMemo(memo.id), /回收站中没有这条备忘录/);
  store.deleteMemo(memo.id);
  assert.deepStrictEqual(store.purgeMemo(memo.id), { ok: true, id: memo.id });
  assert.strictEqual(store.getDeletedMemos().some((item) => item.id === memo.id), false);
});

test('备忘录：JSON 导出与备份恢复包含备忘录', () => {
  resetMemos();
  const memo = store.createMemo({ title: '备份校验', content: '跟随完整备份' });
  const exported = JSON.parse(store.exportJSON());
  assert.ok(Array.isArray(exported.tasks));
  assert.ok(exported.memos.some((item) => item.id === memo.id));

  const file = store.backup();
  store.deleteMemo(memo.id);
  store.emptyMemoTrash();
  assert.strictEqual(store.getAllMemos().length, 0);
  const result = store.restoreFromBackup(file);
  assert.ok(result.memoCount >= 1);
  assert.ok(store.getAllMemos().some((item) => item.title === '备份校验'));
});

test('助手：明确的备忘请求不会创建任务', () => {
  reset();
  resetMemos();
  const before = store.getAllTasks().length;
  const result = ai.handle('记到备忘录：客户更喜欢 A 方案，周五再确认');
  assert.strictEqual(result.intent, 'memo_create');
  assert.strictEqual(result.type, 'memo_create');
  assert.strictEqual(store.getAllTasks().length, before);
  assert.strictEqual(store.getAllMemos().length, 1);
  assert.match(store.getAllMemos()[0].content, /客户更喜欢 A 方案/);
});

test('Agent 备忘录上下文：查看后可用指代置顶并转为任务', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '客户回访要点', content: '确认预算和上线时间', tags: ['客户'] });

  const viewed = ai.handle('查看备忘录 客户回访');
  assert.strictEqual(viewed.type, 'memo_query');
  assert.strictEqual(viewed.memo.id, memo.id);

  const pinned = ai.handle('置顶这条备忘录');
  assert.strictEqual(pinned.type, 'memo_pin');
  assert.strictEqual(pinned.memo.id, memo.id);
  assert.strictEqual(store.getMemo(memo.id).pinned, true);

  const converted = ai.handle('把这条备忘录转为任务');
  assert.strictEqual(converted.type, 'memo_to_task');
  assert.strictEqual(converted.task.title, memo.title);
  assert.strictEqual(converted.task.desc, memo.content);
  assert.strictEqual(converted.undoable, true);
  assert.strictEqual(ai.undoAction(converted.undo).ok, true);
  assert.strictEqual(store.getTask(converted.task.id), null);
  assert.ok(store.getMemo(memo.id), '撤销转任务不能删除原备忘录');
});

test('Agent 备忘录上下文：记住最近列表并正确拆分“构筑那个”', () => {
  reset();
  resetMemos();
  store.createMemo({ title: '玩家闲置动作备忘', content: '补充等待动作' });
  const buildMemo = store.createMemo({
    title: '游戏构筑与地图优化备忘',
    content: '梳理构筑流派\n调整地图奖励节奏\n验证新路线的完成率',
    tags: ['游戏']
  });
  store.createMemo({ title: '新手教程与操作反馈问题', content: '整理新手反馈' });

  const list = ai.handle('看一下我的备忘录');
  assert.strictEqual(list.type, 'memo_query');
  assert.strictEqual(store.getAgentState().lastCollection.type, 'memo');
  assert.strictEqual(store.getAgentState().lastCollection.ids.length, 3);

  const ask = ai.handle('你觉得可以拆分吗');
  assert.strictEqual(ask.intent, 'memo_split');
  assert.strictEqual(ask.type, 'ask');
  assert.ok(ask.candidates.every((candidate) => candidate.entityType === 'memo'));

  const preview = ai.handle('就拆构筑那个吧');
  assert.strictEqual(preview.intent, 'memo_split');
  assert.strictEqual(preview.type, 'confirm');
  assert.match(preview.message, /游戏构筑与地图优化备忘/);
  assert.match(preview.message, /梳理构筑流派/);
  assert.strictEqual(store.getAllTasks().some((task) => task.desc.includes(buildMemo.title)), false);

  const created = ai.handle('确认执行');
  assert.strictEqual(created.type, 'memo_split');
  assert.strictEqual(created.tasks.length, 3);
  assert.ok(created.tasks.every((task) => task.desc.includes(buildMemo.title)));
  assert.ok(store.getMemo(buildMemo.id), '拆分后应保留原备忘录');
});

test('Agent 备忘录拆分：直接说标题关键词也不会误搜任务', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '游戏构筑与地图优化备忘', content: '构筑平衡\n地图节奏' });
  ai.handle('查看我的备忘录');

  const result = ai.handle('就拆构筑那个吧');
  assert.strictEqual(result.intent, 'memo_split');
  assert.strictEqual(result.type, 'confirm');
  assert.strictEqual(store.getAgentState().pending.params.memoId, memo.id);
});

test('Agent 备忘录上下文：过期列表不会把任务拆分误判成备忘录', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '旧备忘录', content: '已经过期的上下文' });
  store.updateAgentState({
    lastEntity: { type: 'memo', id: memo.id, title: memo.title, ts: Date.now() - 31 * 60 * 1000 },
    lastCollection: { type: 'memo', ids: [memo.id], ts: Date.now() - 31 * 60 * 1000 }
  });

  const result = ai.handle('把 写季度方案 拆成三步');
  assert.strictEqual(result.intent, 'split');
  assert.strictEqual(result.type, 'clarify');
});

test('Agent 备忘录上下文：明确任务标题优先于仍有效的备忘录上下文', () => {
  reset();
  resetMemos();
  store.createMemo({ title: '客户记录', content: '稍后处理' });
  ai.handle('查看备忘录 客户记录');

  const result = ai.handle('把 写季度方案 拆成三步');
  assert.strictEqual(result.intent, 'split');
  assert.strictEqual(result.type, 'clarify');
  assert.strictEqual(result.clarification.params.taskId, store.getAllTasks().find((task) => task.title === '写季度方案').id);
});

test('Agent 备忘录上下文：列出多条后不沿用之前的单条指代', () => {
  reset();
  resetMemos();
  const first = store.createMemo({ title: '客户记录 A', content: 'A' });
  const second = store.createMemo({ title: '客户记录 B', content: 'B' });
  ai.handle('查看备忘录 客户记录 A');
  const list = ai.handle('查看我的备忘录');
  assert.strictEqual(list.memoIds.length, 2);
  assert.strictEqual(store.getAgentState().lastEntity, null);

  const ask = ai.handle('置顶这条备忘录');
  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.candidates.length, 2);
  assert.strictEqual(store.getMemo(first.id).pinned, false);
  assert.strictEqual(store.getMemo(second.id).pinned, false);

  const pinned = ai.handle('第二条');
  assert.strictEqual(pinned.type, 'memo_pin');
  assert.strictEqual(pinned.memo.id, ask.candidates[1].id);
});

test('Agent 备忘录拆分：模型重复步骤会回退到至少两个有效步骤', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '构筑优化', content: '盘点现有流派\n验证地图奖励节奏' });
  const preview = ai.resolve('memo_split', { steps: ['重复步骤', '重复步骤'] }, memo.id);

  assert.strictEqual(preview.type, 'confirm');
  assert.deepStrictEqual(preview.confirmation.params.steps, ['盘点现有流派', '验证地图奖励节奏']);
});

test('Agent 备忘录拆分：创建的任务可以整体撤销', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '可撤销计划备忘', content: '步骤甲\n步骤乙\n步骤丙' });
  ai.handle('查看备忘录 可撤销计划备忘');
  const proposal = ai.handle('拆分这条备忘录');
  assert.strictEqual(proposal.type, 'confirm');
  const result = ai.handle('确认执行');
  assert.strictEqual(result.type, 'memo_split');
  assert.strictEqual(result.undoable, true);
  assert.strictEqual(result.tasks.length, 3);
  const undone = ai.undoAction(result.undo);
  assert.strictEqual(undone.ok, true);
  assert.ok(result.tasks.every((task) => store.getTask(task.id) === null));
  assert.ok(store.getMemo(memo.id), '撤销拆分不应删除原备忘录');
});

test('Agent 实体识别：标题中的动作词不会被参数提取器删除', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '可撤销拆分备忘', content: '动作词属于标题' });
  const viewed = ai.handle('查看备忘录 可撤销拆分备忘');
  assert.strictEqual(viewed.type, 'memo_query');
  assert.strictEqual(viewed.memo.id, memo.id);

  const task = store.createTask({ title: '完成情况删除检查' });
  const started = ai.handle('开始 完成情况删除检查');
  assert.strictEqual(started.type, 'start');
  assert.strictEqual(started.task.id, task.id);
});

test('Agent 备忘录消歧：可按序号选择后确认删除', () => {
  reset();
  resetMemos();
  const first = store.createMemo({ title: '产品方案 A', content: '保守版本' });
  const second = store.createMemo({ title: '产品方案 B', content: '激进版本' });

  const ask = ai.handle('删除产品方案备忘录');
  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.candidates.length, 2);
  assert.ok(ask.candidates.every((candidate) => candidate.entityType === 'memo'));
  const chosen = ask.candidates[1];

  const confirm = ai.handle('第二个');
  assert.strictEqual(confirm.type, 'confirm');
  assert.match(confirm.message, new RegExp(chosen.title));
  const deleted = ai.handle('确认执行');
  assert.strictEqual(deleted.type, 'memo_delete');
  assert.strictEqual(store.getMemo(chosen.id), null);
  const remainingId = chosen.id === first.id ? second.id : first.id;
  assert.ok(store.getMemo(remainingId));
});

test('本地 Agent：同名任务和备忘录先追问类型并沿用原删除动作', () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '本地同名记录' });
  const memo = store.createMemo({ title: '本地同名记录', content: '应删除备忘录' });

  const question = ai.handle('删除 本地同名记录');
  assert.strictEqual(question.type, 'clarify');
  assert.match(question.message, /同时存在任务和备忘录/);

  const proposal = ai.handle('备忘录那条');
  assert.strictEqual(proposal.intent, 'memo_delete');
  assert.strictEqual(proposal.type, 'confirm');
  assert.ok(store.getTask(task.id));
  assert.ok(store.getMemo(memo.id));
  ai.handle('取消');
});

test('Agent 备忘录安全：删除可取消，置顶可撤销', () => {
  reset();
  resetMemos();
  const memo = store.createMemo({ title: '临时决策', content: '稍后复核' });

  const ask = ai.handle('删除备忘录 临时决策');
  assert.strictEqual(ask.type, 'confirm');
  assert.strictEqual(ai.handle('取消').type, 'info');
  assert.ok(store.getMemo(memo.id));

  const pinned = ai.handle('置顶备忘录 临时决策');
  assert.strictEqual(store.getMemo(memo.id).pinned, true);
  const undone = ai.undoAction(pinned.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(undone.memo.pinned, false);
  assert.strictEqual(store.getMemo(memo.id).pinned, false);
});

test('助手：清空回收站同时清理任务和备忘录', () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '待清理任务' });
  const memo = store.createMemo({ title: '待清理备忘录' });
  store.deleteTask(task.id);
  store.deleteMemo(memo.id);
  const ask = ai.handle('清空回收站');
  assert.strictEqual(ask.type, 'confirm');
  const result = ai.handle('确认执行');
  assert.strictEqual(result.type, 'batch');
  assert.strictEqual(store.getDeletedTasks().length, 0);
  assert.strictEqual(store.getDeletedMemos().length, 0);
});

test('Agent 多轮：缺少目标时追问，下一轮只回答标题即可继续', () => {
  reset();
  const ask = ai.handle('完成');
  assert.strictEqual(ask.type, 'clarify');
  assert.match(ask.message, /哪一项/);
  const result = ai.handle('写季度方案');
  assert.strictEqual(result.type, 'complete');
  assert.strictEqual(result.task.title, '写季度方案');
});

test('Agent 多轮：修改追问支持只回答“紧急”或“明天”', () => {
  reset();
  const priorityAsk = ai.handle('把 写季度方案 改成');
  assert.strictEqual(priorityAsk.type, 'clarify');
  const priorityResult = ai.handle('紧急');
  assert.strictEqual(priorityResult.type, 'update');
  assert.strictEqual(priorityResult.task.pri, 4);

  const dueAsk = ai.handle('把 整理报销单据 改到');
  assert.strictEqual(dueAsk.type, 'clarify');
  const dueResult = ai.handle('明天');
  assert.strictEqual(dueResult.type, 'update');
  assert.ok(dueResult.task.due && dueResult.task.due.startsWith(dueResult.params.due.slice(0, 10)));
  assert.ok(!store.getAllTasks().some((task) => task.title === '明天'), '补充截止时间不能误创建任务');
});

test('Agent 多轮：歧义候选支持直接回答序号', () => {
  reset();
  const first = store.createTask({ title: '产品方案 A', pri: 2 });
  const second = store.createTask({ title: '产品方案 B', pri: 2 });
  const ask = ai.handle('把 产品方案 改成紧急');
  assert.strictEqual(ask.type, 'ask');
  const result = ai.handle('第二个');
  assert.strictEqual(result.type, 'update');
  assert.strictEqual(store.getTask(first.id).pri, 2);
  assert.strictEqual(store.getTask(second.id).pri, 4);
});

test('Agent 安全：取消删除不会改动任务', () => {
  reset();
  const ask = ai.handle('删除 整理报销单据');
  assert.strictEqual(ask.type, 'confirm');
  const result = ai.handle('取消');
  assert.strictEqual(result.type, 'info');
  assert.ok(store.getAllTasks().some((task) => task.title === '整理报销单据'));
  assert.strictEqual(store.getAgentState().pending, null);
});

test('Agent 恢复：重启后仍可继续待确认操作', () => {
  reset();
  const task = store.createTask({ title: '重启后删除' });
  const ask = ai.handle('删除 重启后删除');
  assert.strictEqual(ask.type, 'confirm');
  store.init();
  const result = ai.handle('确认执行');
  assert.strictEqual(result.type, 'delete');
  assert.strictEqual(store.getTask(task.id), null);
});

test('Agent 会话恢复：返回待确认文案且不执行操作', () => {
  reset();
  const task = store.createTask({ title: '界面恢复待删除' });
  const ask = ai.handle('删除 界面恢复待删除');
  assert.strictEqual(ask.type, 'confirm');
  store.init();

  const session = ai.getSessionState();
  assert.strictEqual(session.pending.type, 'confirm');
  assert.strictEqual(session.pending.message, ask.message);
  assert.strictEqual(session.pending.confirmation.purpose, 'safety');
  assert.ok(store.getTask(task.id), '读取会话状态不能执行待确认操作');
});

test('Agent 会话恢复：候选使用当前实体数据并忽略已删除项', () => {
  reset();
  const first = store.createTask({ title: '同名方案 A', pri: 2 });
  const second = store.createTask({ title: '同名方案 B', pri: 2 });
  const ask = ai.handle('把 同名方案 改成紧急');
  assert.strictEqual(ask.type, 'ask');
  store.updateTask(first.id, { title: '同名方案 A 新标题' });
  store.deleteTask(second.id);

  const session = ai.getSessionState();
  assert.strictEqual(session.pending.type, 'ask');
  assert.deepStrictEqual(session.pending.candidates.map((candidate) => candidate.title), ['同名方案 A 新标题']);
});

test('Agent 会话恢复：过期状态会被清理', () => {
  reset();
  store.updateAgentState({
    pending: {
      kind: 'field',
      intent: 'create',
      params: {},
      field: 'title',
      message: '想创建什么任务？',
      createdAt: Date.now() - 31 * 60 * 1000
    }
  });
  assert.strictEqual(ai.getSessionState().pending, null);
  assert.strictEqual(store.getAgentState().pending, null);
});

test('Agent 多轮：新命令会打断旧追问', () => {
  reset();
  const ask = ai.handle('创建任务');
  assert.strictEqual(ask.type, 'clarify');
  const result = ai.handle('今天我要做什么');
  assert.strictEqual(result.intent, 'query');
  assert.strictEqual(result.type, 'query');
  assert.ok(!store.getAllTasks().some((task) => task.title === '今天我要做什么'));
});

test('Agent 上下文：最近任务通过稳定 ID 跨重新初始化保留', () => {
  reset();
  const started = ai.handle('开始 写季度方案');
  const id = started.task.id;
  store.updateTask(id, { title: '季度方案最终稿' });
  store.init();
  const result = ai.handle('完成它');
  assert.strictEqual(result.type, 'complete');
  assert.strictEqual(result.task.id, id);
  assert.strictEqual(result.task.title, '季度方案最终稿');
});

test('Agent 上下文：清空对话同时清除待处理状态和最近指代', () => {
  reset();
  ai.handle('开始 写季度方案');
  ai.handle('删除 整理报销单据');
  store.clearChat();
  assert.deepStrictEqual(store.getAgentState(), { lastEntity: null, lastCollection: null, references: [], pending: null, reportSession: null });
  const result = ai.handle('完成它');
  assert.strictEqual(result.type, 'clarify');
});

test('Agent 上下文：任务与备忘录切换后仍能按实体类型找回最近任务', () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '跨类型上下文任务' });
  const memo = store.createMemo({ title: '跨类型上下文备忘', content: '不要覆盖任务焦点' });

  const started = ai.handle('开始 跨类型上下文任务');
  assert.strictEqual(started.task.id, task.id);
  const viewed = ai.handle('查看备忘录 跨类型上下文备忘');
  assert.strictEqual(viewed.memo.id, memo.id);
  assert.strictEqual(store.getAgentState().lastEntity.type, 'memo');

  const completed = ai.handle('完成刚才那个任务');
  assert.strictEqual(completed.type, 'complete');
  assert.strictEqual(completed.task.id, task.id);
});

test('Agent 上下文：最近实体栈可跨重新初始化恢复且自动剔除过期引用', () => {
  reset();
  resetMemos();
  const task = store.createTask({ title: '重启后的类型化任务' });
  const memo = store.createMemo({ title: '重启后的类型化备忘', content: '用于切换焦点' });
  ai.handle('开始 重启后的类型化任务');
  ai.handle('查看备忘录 重启后的类型化备忘');
  store.init();

  const completed = ai.handle('完成刚才那个任务');
  assert.strictEqual(completed.task.id, task.id);

  store.updateAgentState({
    lastEntity: { type: 'memo', id: memo.id, title: memo.title, ts: Date.now() },
    references: [{ type: 'task', id: task.id, title: task.title, ts: Date.now() - 31 * 60 * 1000 }]
  });
  const stale = ai.handle('开始刚才那个任务');
  assert.strictEqual(stale.type, 'clarify');
});
