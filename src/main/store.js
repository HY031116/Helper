'use strict';

/**
 * 数据存储层 - 纯本地 JSON 文件存储
 * 数据主权第一原则：所有任务、备忘录、设置、AI 会话记录全部存于本机
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const {
  normalizePreferences,
  normalizeWorkflowState,
  normalizePlan,
  localDateKey,
  generateDailyPlan,
  planFitsWorkday,
  focusElapsedMs,
  workflowSnapshot,
  createDailyReview
} = require('./workflow-planner');
const { buildDailyCopilot, normalizeCopilotState } = require('./agent/daily-copilot');

/* ---------- 路径 ---------- */
function getDataDir() {
  // 允许通过环境变量覆盖（测试用）
  if (process.env.WORK_HELPER_DATA_DIR) return process.env.WORK_HELPER_DATA_DIR;
  return path.join(app.getPath('userData'), 'data');
}

const DATA_DIR = getDataDir();
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const MEMOS_FILE = path.join(DATA_DIR, 'memos.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const AGENT_STATE_FILE = path.join(DATA_DIR, 'agent-state.json');
const WORKFLOW_FILE = path.join(DATA_DIR, 'workflow.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/* ---------- 工具 ---------- */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[store] 读取失败，使用默认值:', file, e.message);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file); // 原子写入，避免写一半损坏
}

function normalizeEstimatedMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes) ? Math.max(5, Math.min(480, minutes)) : null;
}

const WORK_LOG_KINDS = new Set(['outcome', 'progress', 'blocker', 'decision', 'next']);

function normalizeWorkLogs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const text = String(entry && entry.text || '').trim().slice(0, 1000);
    if (!text) return null;
    const createdAt = Number(entry && entry.createdAt) || Date.now();
    return {
      id: String(entry && entry.id || `log-${createdAt}-${index + 1}`).slice(0, 100),
      kind: WORK_LOG_KINDS.has(entry && entry.kind) ? entry.kind : 'progress',
      text,
      createdAt,
      updatedAt: Number(entry && entry.updatedAt) || createdAt
    };
  }).filter(Boolean).slice(-200);
}

/* ---------- 种子数据 ---------- */
function seedTasks() {
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const dueOf = (offsetDays, hh, mm) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offsetDays);
    d.setHours(hh, mm, 0, 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh)}:${pad(mm)}`;
  };
  return [
    { id: 1, title: '交周报', desc: '汇总本周进展与下周计划', pri: 4, due: dueOf(0, 18, 0), tags: ['工作'], project: '日常工作', status: 'todo', repeat: 'weekly', remind: 30, children: [], createdAt: Date.now() },
    { id: 2, title: '写季度方案', desc: 'Q3 规划初稿', pri: 3, due: dueOf(1, 17, 0), tags: ['工作'], project: 'Q3 规划', status: 'todo', repeat: '', remind: 30, children: ['搭框架', '写初稿', '内部校对'], createdAt: Date.now() },
    { id: 3, title: '回复客户邮件', desc: '报价单过期问题', pri: 2, due: dueOf(0, 10, 30), tags: ['工作'], project: '客户跟进', status: 'doing', repeat: '', remind: 0, children: [], createdAt: Date.now() },
    { id: 4, title: '整理报销单据', desc: '上月差旅报销', pri: 1, due: dueOf(2, 12, 0), tags: ['财务'], project: '个人事务', status: 'todo', repeat: '', remind: 60, children: [], createdAt: Date.now() },
    { id: 5, title: '预约年度体检', desc: '记得带医保卡', pri: 3, due: dueOf(-1, 9, 0), tags: ['生活'], project: '健康', status: 'todo', repeat: '', remind: 30, children: [], createdAt: Date.now() },
    { id: 6, title: '团队周会', desc: '', pri: 2, due: dueOf(0, 15, 0), tags: ['工作'], project: '日常工作', status: 'done', repeat: 'weekly', remind: 10, children: [], createdAt: Date.now() },
    { id: 7, title: '学习 TypeScript 泛型', desc: '看完文档第三章', pri: 1, due: null, tags: ['学习'], project: '技能提升', status: 'done', repeat: '', remind: 0, children: [], createdAt: Date.now() },
    { id: 8, title: '更新个人 OKR', desc: '', pri: 2, due: dueOf(4, 20, 0), tags: ['工作'], project: 'Q3 规划', status: 'todo', repeat: '', remind: 30, children: [], createdAt: Date.now() }
  ];
}

/* ---------- 状态 ---------- */
let tasks = [];
let memos = [];
let settings = {};
let chatLog = [];
let agentState = {};
let workflowState = {};
let seq = 100;
let memoSeq = 1000;
let agentTransactionDepth = 0;
const agentTransactions = new Map();

/* ---------- 初始化 ---------- */
function init() {
  agentTransactions.clear();
  ensureDir(DATA_DIR);
  ensureDir(BACKUP_DIR);

  tasks = readJson(TASKS_FILE, null);
  if (!tasks || !Array.isArray(tasks)) {
    tasks = seedTasks();
    saveTasks();
  }
  // 计算最大 id
  tasks.forEach((t) => { if (t.id > seq) seq = t.id; });
  tasks = tasks.map((task) => Object.assign({}, task, {
    estimatedMinutes: normalizeEstimatedMinutes(task && task.estimatedMinutes),
    workLogs: normalizeWorkLogs(task && task.workLogs),
    updatedAt: Number(task && task.updatedAt) || Number(task && task.createdAt) || Date.now()
  }));

  memos = readJson(MEMOS_FILE, []);
  if (!Array.isArray(memos)) memos = [];
  memoSeq = 1000;
  memos = memos.map(normalizeMemo);
  memos.forEach((memo) => { if (memo.id > memoSeq) memoSeq = memo.id; });

  settings = Object.assign({}, getDefaultSettings(), readJson(SETTINGS_FILE, {}));
  chatLog = readJson(CHAT_FILE, []);
  agentState = normalizeAgentState(readJson(AGENT_STATE_FILE, {}));
  workflowState = normalizeWorkflowState(readJson(WORKFLOW_FILE, {}));
}

function getDefaultSettings() {
  return {
    autoBackup: true,
    autoStart: false,
    notify: true,
    theme: 'auto',
    aiStage: 'mock', // 'mock' | 'llm' 默认本地规则引擎，用户显式选择后才调用真实模型
    aiProvider: 'openai', // 'openai' | 'deepseek' | 'custom'
    aiBaseUrl: '',
    aiApiKey: '',
    aiModel: '',
    aiTemperature: 0.2,
    petPosition: null, // { x, y } 桌宠位置
    petEnabled: true, // 桌宠是否显示
    workHours: {
      start: '09:00',
      end: '18:00',
      days: [1, 2, 3, 4, 5] // 0=周日 … 6=周六
    },
    shortcuts: { ai: 'CommandOrControl+J', newTask: 'CommandOrControl+N' }
  };
}

/* 归一化工作时间设置，防御非法输入 */
function normalizeWorkHours(value) {
  const source = value && typeof value === 'object' ? value : {};
  const validTime = (v, fallback) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : fallback;
  const start = validTime(source.start, '09:00');
  let end = validTime(source.end, '18:00');
  if (end <= start) end = '18:00';
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const days = Array.isArray(source.days)
    ? [...new Set(source.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : null;
  return { start, end, days: days && days.length ? days : allDays.slice(1, 6) };
}

/* ---------- 任务 CRUD ---------- */
function getAllTasks() {
  return tasks.filter((t) => !t._deleted);
}

function getTask(id) {
  return tasks.find((t) => t.id === id && !t._deleted) || null;
}

function nextId() {
  return ++seq;
}

/* ---------- 备忘录 CRUD ---------- */
function normalizeMemo(data) {
  const now = Date.now();
  return {
    id: Number(data && data.id) || ++memoSeq,
    title: String(data && data.title || '').trim() || '无标题备忘录',
    content: String(data && data.content || ''),
    tags: Array.isArray(data && data.tags)
      ? data.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 5)
      : [],
    pinned: !!(data && data.pinned),
    createdAt: Number(data && data.createdAt) || now,
    updatedAt: Number(data && data.updatedAt) || now,
    ...(data && data._deleted ? { _deleted: true, deletedAt: Number(data.deletedAt) || now } : {})
  };
}

function getAllMemos() {
  return memos
    .filter((memo) => !memo._deleted)
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function getMemo(id) {
  return memos.find((memo) => memo.id === Number(id) && !memo._deleted) || null;
}

function createMemo(data) {
  const memo = normalizeMemo(Object.assign({}, data, { id: ++memoSeq }));
  memos.push(memo);
  saveMemos();
  return memo;
}

function updateMemo(id, patch) {
  const memo = getMemo(id);
  if (!memo) throw new Error('备忘录不存在');
  if (patch.title !== undefined) memo.title = String(patch.title).trim() || '无标题备忘录';
  if (patch.content !== undefined) memo.content = String(patch.content);
  if (patch.tags !== undefined) {
    memo.tags = Array.isArray(patch.tags)
      ? patch.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 5)
      : [];
  }
  if (patch.pinned !== undefined) memo.pinned = !!patch.pinned;
  memo.updatedAt = Date.now();
  saveMemos();
  return memo;
}

function deleteMemo(id) {
  const memo = getMemo(id);
  if (!memo) throw new Error('备忘录不存在');
  memo._deleted = true;
  memo.deletedAt = Date.now();
  saveMemos();
  return { ok: true, id: memo.id };
}

function getDeletedMemos() {
  return memos.filter((memo) => memo._deleted).slice().sort((a, b) => b.deletedAt - a.deletedAt);
}

function restoreMemo(id) {
  const memo = memos.find((item) => item.id === Number(id));
  if (!memo) throw new Error('备忘录不存在');
  delete memo._deleted;
  delete memo.deletedAt;
  memo.updatedAt = Date.now();
  saveMemos();
  return memo;
}

function emptyMemoTrash() {
  memos = memos.filter((memo) => !memo._deleted);
  saveMemos();
  return { ok: true };
}

function purgeMemo(id) {
  const memo = memos.find((item) => item.id === Number(id) && item._deleted);
  if (!memo) throw new Error('回收站中没有这条备忘录');
  memos = memos.filter((item) => item.id !== memo.id);
  saveMemos();
  return { ok: true, id: memo.id };
}

function importMemos(list) {
  if (!Array.isArray(list)) throw new Error('备忘录导入格式不正确');
  const imported = list.filter((item) => item && (item.title || item.content)).map((item) => {
    const memo = normalizeMemo(Object.assign({}, item, { id: ++memoSeq, _deleted: false }));
    memos.push(memo);
    return memo;
  });
  saveMemos();
  return imported;
}

function createTaskRecord(data) {
  const now = Date.now();
  const task = {
    id: nextId(),
    title: String(data.title || '').trim(),
    desc: String(data.desc || '').trim(),
    pri: [1, 2, 3, 4].includes(Number(data.pri)) ? Number(data.pri) : 2,
    due: data.due || null,
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 5) : [],
    project: String(data.project || ''),
    status: ['todo', 'doing', 'done', 'archived'].includes(data.status) ? data.status : 'todo',
    repeat: ['', 'daily', 'weekly', 'monthly'].includes(data.repeat) ? data.repeat : '',
    remind: [0, 10, 30, 60].includes(Number(data.remind)) ? Number(data.remind) : 30,
    estimatedMinutes: normalizeEstimatedMinutes(data.estimatedMinutes),
    children: normalizeChildren(data.children),
    workLogs: normalizeWorkLogs(data.workLogs),
    completedAt: data.completedAt || null,
    repeatSourceId: data.repeatSourceId != null ? Number(data.repeatSourceId) : null,
    repeatNextId: data.repeatNextId != null ? Number(data.repeatNextId) : null,
    order: data.order != null ? Number(data.order) : Date.now(),
    createdAt: now,
    updatedAt: now
  };
  if (!task.title) throw new Error('标题不能为空');
  tasks.push(task);
  return task;
}

function createTask(data) {
  const task = createTaskRecord(data);
  saveTasks();
  return task;
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function captureAgentDataState() {
  return {
    tasks: cloneData(tasks),
    memos: cloneData(memos),
    workflow: cloneData(workflowState),
    seq,
    memoSeq
  };
}

function applyAgentDataState(snapshot) {
  tasks = cloneData(snapshot.tasks);
  memos = cloneData(snapshot.memos);
  workflowState = cloneData(snapshot.workflow);
  seq = snapshot.seq;
  memoSeq = snapshot.memoSeq;
}

function persistAgentDataState() {
  writeJson(TASKS_FILE, tasks);
  writeJson(MEMOS_FILE, memos);
  writeJson(WORKFLOW_FILE, workflowState);
}

function sameAgentDataState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rememberAgentTransaction(before, after) {
  const id = `agent-tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  agentTransactions.set(id, { before, after, createdAt: Date.now() });
  while (agentTransactions.size > 10) agentTransactions.delete(agentTransactions.keys().next().value);
  return id;
}

function runAgentTransaction(operation) {
  if (typeof operation !== 'function') throw new Error('组合操作无效');
  if (agentTransactionDepth) return { value: operation(), transactionId: null };
  const before = captureAgentDataState();
  agentTransactionDepth += 1;
  let value;
  let after;
  try {
    value = operation();
    after = captureAgentDataState();
  } catch (error) {
    applyAgentDataState(before);
    throw error;
  } finally {
    agentTransactionDepth -= 1;
  }
  try {
    persistAgentDataState();
    return { value, transactionId: rememberAgentTransaction(before, after) };
  } catch (error) {
    applyAgentDataState(before);
    try { persistAgentDataState(); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
}

function restoreAgentTransaction(transactionId) {
  const transaction = agentTransactions.get(String(transactionId || ''));
  if (!transaction) return { ok: false, reason: 'expired', message: '这次组合操作已过期，无法撤销' };
  const current = captureAgentDataState();
  if (!sameAgentDataState(current, transaction.after)) {
    return { ok: false, reason: 'conflict', message: '组合操作之后数据又发生了变化，本次撤销未执行' };
  }
  applyAgentDataState(transaction.before);
  persistAgentDataState();
  agentTransactions.delete(String(transactionId));
  return { ok: true };
}

function saveTaskAndMemoState() {
  saveTasks();
  saveMemos();
}

function createAdditions(input) {
  const taskInputs = Array.isArray(input && input.tasks) ? input.tasks : [];
  const memoInputs = Array.isArray(input && input.memos) ? input.memos : [];
  if (!taskInputs.length && !memoInputs.length) throw new Error('没有可创建的内容');
  taskInputs.forEach((data) => {
    if (!data || !String(data.title || '').trim()) throw new Error('任务标题不能为空');
  });
  memoInputs.forEach((data) => {
    if (!data || (!String(data.title || '').trim() && !String(data.content || '').trim())) {
      throw new Error('备忘录内容不能为空');
    }
  });

  const before = { tasks: cloneData(tasks), memos: cloneData(memos), seq, memoSeq };
  try {
    const createdTasks = taskInputs.map((data) => createTaskRecord(data));
    const createdMemos = memoInputs.map((data) => {
      const memo = normalizeMemo(Object.assign({}, data, { id: ++memoSeq }));
      memos.push(memo);
      return memo;
    });
    saveTaskAndMemoState();
    return { tasks: createdTasks, memos: createdMemos };
  } catch (error) {
    tasks = before.tasks;
    memos = before.memos;
    seq = before.seq;
    memoSeq = before.memoSeq;
    try { saveTaskAndMemoState(); } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

function removeCreatedAdditions(expected) {
  const expectedTasks = Array.isArray(expected && expected.tasks) ? expected.tasks : [];
  const expectedMemos = Array.isArray(expected && expected.memos) ? expected.memos : [];
  const actualTasks = expectedTasks.map((entry) => tasks.find((task) => task.id === Number(entry.id)) || null);
  const actualMemos = expectedMemos.map((entry) => memos.find((memo) => memo.id === Number(entry.id)) || null);
  const missing = actualTasks.some((item) => !item) || actualMemos.some((item) => !item);
  if (missing) return { ok: false, reason: 'missing', message: '部分新增内容已不存在，未执行整体撤销' };
  const changed = actualTasks.some((item, index) => JSON.stringify(item) !== JSON.stringify(expectedTasks[index])) ||
    actualMemos.some((item, index) => JSON.stringify(item) !== JSON.stringify(expectedMemos[index]));
  if (changed) return { ok: false, reason: 'conflict', message: '部分新增内容后来被修改过，未执行整体撤销' };

  const taskIds = new Set(expectedTasks.map((entry) => Number(entry.id)));
  const memoIds = new Set(expectedMemos.map((entry) => Number(entry.id)));
  const referencedByWorkflow = workflowState.activeFocus && taskIds.has(workflowState.activeFocus.taskId) ||
    Object.values(workflowState.dailyPlans || {}).some((plan) =>
      Array.isArray(plan && plan.items) && plan.items.some((item) => taskIds.has(item.taskId))
    );
  if (referencedByWorkflow) {
    return { ok: false, reason: 'conflict', message: '新增任务已经进入今日计划或专注记录，本次撤销未执行' };
  }

  const before = { tasks: cloneData(tasks), memos: cloneData(memos) };
  try {
    tasks = tasks.filter((task) => !taskIds.has(task.id));
    memos = memos.filter((memo) => !memoIds.has(memo.id));
    saveTaskAndMemoState();
    return { ok: true, taskCount: taskIds.size, memoCount: memoIds.size };
  } catch (error) {
    tasks = before.tasks;
    memos = before.memos;
    try { saveTaskAndMemoState(); } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

/* 子任务规范化：字符串 → { id, title, done } */
function normalizeChildren(children) {
  if (!Array.isArray(children)) return [];
  return children.map((c) => {
    if (typeof c === 'string') return { id: nextId(), title: c, done: false };
    return {
      id: c.id != null ? c.id : nextId(),
      title: String(c.title || '').trim(),
      done: !!(c.done)
    };
  }).filter((c) => c.title);
}

function applyTaskPatch(t, patch) {
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) throw new Error('标题不能为空');
    t.title = title;
  }
  if (patch.desc !== undefined) t.desc = String(patch.desc).trim();
  if (patch.pri !== undefined && [1, 2, 3, 4].includes(Number(patch.pri))) t.pri = Number(patch.pri);
  if (patch.due !== undefined) t.due = patch.due || null;
  if (patch.tags !== undefined) t.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 5) : [];
  if (patch.project !== undefined) t.project = String(patch.project || '');
  if (patch.status !== undefined && ['todo', 'doing', 'done', 'archived'].includes(patch.status)) {
    // 状态变更时记录完成时间（进入 done 时打点，离开 done 时清除）
    if (patch.status === 'done' && t.status !== 'done') t.completedAt = Date.now();
    if (patch.status !== 'done' && t.status === 'done') t.completedAt = null;
    t.status = patch.status;
  }
  if (patch.completedAt !== undefined) t.completedAt = patch.completedAt || null;
  if (patch.repeat !== undefined && ['', 'daily', 'weekly', 'monthly'].includes(patch.repeat)) t.repeat = patch.repeat;
  if (patch.repeatSourceId !== undefined) t.repeatSourceId = patch.repeatSourceId == null ? null : Number(patch.repeatSourceId);
  if (patch.repeatNextId !== undefined) t.repeatNextId = patch.repeatNextId == null ? null : Number(patch.repeatNextId);
  if (patch.remind !== undefined && [0, 10, 30, 60].includes(Number(patch.remind))) t.remind = Number(patch.remind);
  if (patch.estimatedMinutes !== undefined) t.estimatedMinutes = normalizeEstimatedMinutes(patch.estimatedMinutes);
  if (patch.children !== undefined) t.children = normalizeChildren(patch.children);
  if (patch.order !== undefined) t.order = Number(patch.order);
  t.updatedAt = Date.now();
  return t;
}

function addTaskWorkLog(taskId, input) {
  const task = getTask(Number(taskId));
  if (!task) throw new Error('任务不存在');
  const text = String(input && input.text || '').trim().slice(0, 1000);
  if (!text) throw new Error('工作记录不能为空');
  const now = Date.now();
  const log = {
    id: `log-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: WORK_LOG_KINDS.has(input && input.kind) ? input.kind : 'progress',
    text,
    createdAt: now,
    updatedAt: now
  };
  task.workLogs = normalizeWorkLogs([...(task.workLogs || []), log]);
  task.updatedAt = now;
  saveTasks();
  return cloneData(log);
}

function updateTaskWorkLog(taskId, logId, patch) {
  const task = getTask(Number(taskId));
  if (!task) throw new Error('任务不存在');
  const logs = normalizeWorkLogs(task.workLogs);
  const log = logs.find((entry) => entry.id === String(logId));
  if (!log) throw new Error('工作记录不存在');
  if (patch && patch.text !== undefined) {
    const text = String(patch.text || '').trim().slice(0, 1000);
    if (!text) throw new Error('工作记录不能为空');
    log.text = text;
  }
  if (patch && patch.kind !== undefined && WORK_LOG_KINDS.has(patch.kind)) log.kind = patch.kind;
  log.updatedAt = Date.now();
  task.workLogs = logs;
  task.updatedAt = log.updatedAt;
  saveTasks();
  return cloneData(log);
}

function removeTaskWorkLog(taskId, logId) {
  const task = getTask(Number(taskId));
  if (!task) throw new Error('任务不存在');
  const logs = normalizeWorkLogs(task.workLogs);
  const next = logs.filter((entry) => entry.id !== String(logId));
  if (next.length === logs.length) throw new Error('工作记录不存在');
  task.workLogs = next;
  task.updatedAt = Date.now();
  saveTasks();
  return { ok: true, id: String(logId) };
}

function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (workflowState.activeFocus && workflowState.activeFocus.taskId === t.id && ['done', 'archived'].includes(patch.status)) {
    finishFocus({ completeTask: false });
  }
  applyTaskPatch(t, patch);
  syncTaskInWorkflow(t, patch.status === 'done' ? 'done' : patch.status === 'archived' ? 'skipped' : null);
  saveTasks();
  return t;
}

function deleteTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (workflowState.activeFocus && workflowState.activeFocus.taskId === t.id) finishFocus({ completeTask: false });
  t._deleted = true; // 软删除，支持撤销
  t.deletedAt = Date.now();
  syncTaskInWorkflow(t, 'skipped');
  saveTasks();
  return { ok: true, id };
}

function restoreTask(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error('任务不存在');
  delete t._deleted;
  delete t.deletedAt;
  saveTasks();
  return t;
}

function archiveTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (workflowState.activeFocus && workflowState.activeFocus.taskId === t.id) finishFocus({ completeTask: false });
  t.status = 'archived';
  syncTaskInWorkflow(t, 'skipped');
  saveTasks();
  return t;
}

function unarchiveTask(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error('任务不存在');
  t.status = 'todo';
  saveTasks();
  return t;
}

function hardDeleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  saveTasks();
  return { ok: true, id };
}

function getDeletedTasks() {
  return tasks.filter((t) => t._deleted).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

function purgeTask(id) {
  const task = tasks.find((item) => item.id === Number(id) && item._deleted);
  if (!task) throw new Error('回收站中没有这条任务');
  tasks = tasks.filter((item) => item.id !== task.id);
  saveTasks();
  return { ok: true, id: task.id };
}

function emptyTrash() {
  tasks = tasks.filter((t) => !t._deleted);
  saveTasks();
  return { ok: true };
}

/* ---------- 批量操作 ---------- */
function batchUpdate(ids, patch) {
  const updated = [];
  ids.forEach((id) => {
    try {
      updated.push(updateTask(id, patch));
    } catch (e) { /* 跳过不存在的 */ }
  });
  saveTasks();
  return updated;
}

function batchComplete(ids) {
  const results = [];
  let skipped = 0;
  const uniqueIds = [...new Set(Array.isArray(ids) ? ids : [])];
  uniqueIds.forEach((id) => {
    const task = getTask(id);
    if (!task || task.status === 'done' || task.status === 'archived') {
      skipped++;
      return;
    }
    try {
      results.push(completeTask(id));
    } catch (e) {
      skipped++;
    }
  });
  return {
    completed: results.length,
    skipped,
    generated: results.filter((result) => result.next).map((result) => result.next)
  };
}

function batchDelete(ids) {
  ids.forEach((id) => {
    try { deleteTask(id); } catch (e) { /* skip */ }
  });
  saveTasks();
  return { ok: true, count: ids.length };
}

/* ---------- 排序 ---------- */
function reorderTasks(orderedIds) {
  const orderMap = {};
  orderedIds.forEach((id, idx) => { orderMap[id] = idx; });
  tasks.forEach((t) => {
    if (orderMap[t.id] !== undefined) t.order = orderMap[t.id];
  });
  saveTasks();
  return getAllTasks();
}

/* ---------- 重复任务：完成时生成下一次 ---------- */
function nextDueForRepeat(repeat, due) {
  if (!repeat || !due) return null;
  const d = new Date(due.replace(' ', 'T') + ':00');
  if (isNaN(d.getTime())) return null;
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 完成任务：若为重复任务，自动生成下一次任务
 * 返回 { task, next } next 为生成的下一次任务（可能为 null）
 */
function findRepeatSuccessor(t, nextDue) {
  if (t.repeatNextId != null) {
    const linked = tasks.find((candidate) => candidate.id === t.repeatNextId);
    if (linked) return linked;
  }
  const linked = tasks.find((candidate) => candidate.repeatSourceId === t.id);
  if (linked) return linked;
  if (!nextDue) return null;
  // 兼容升级前已经生成、但尚未写入链路字段的后继任务。
  return tasks.find((candidate) =>
    candidate.id !== t.id &&
    candidate.title === t.title &&
    candidate.due === nextDue &&
    candidate.repeat === t.repeat &&
    (candidate.project || '') === (t.project || '')
  ) || null;
}

function completeTaskRecord(t) {
  const wasDone = t.status === 'done';
  const nextDue = nextDueForRepeat(t.repeat, t.due);
  let successor = findRepeatSuccessor(t, nextDue);
  if (successor) {
    t.repeatNextId = successor.id;
    if (successor.repeatSourceId == null) successor.repeatSourceId = t.id;
  }
  if (wasDone) {
    return { task: t, next: successor && !successor._deleted ? successor : null, alreadyDone: true };
  }
  t.status = 'done';
  t.completedAt = Date.now();
  if (!successor && nextDue) {
    successor = createTaskRecord({
      title: t.title,
      desc: t.desc,
      pri: t.pri,
      due: nextDue,
      tags: t.tags,
      project: t.project,
      repeat: t.repeat,
      remind: t.remind,
      estimatedMinutes: t.estimatedMinutes,
      children: t.children,
      repeatSourceId: t.id
    });
    t.repeatNextId = successor.id;
  }
  return { task: t, next: successor && !successor._deleted ? successor : null, alreadyDone: false };
}

function completeTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (workflowState.activeFocus && workflowState.activeFocus.taskId === t.id) {
    return finishFocus({ completeTask: true }).completion;
  }
  const result = completeTaskRecord(t);
  let planChanged = false;
  Object.values(workflowState.dailyPlans).forEach((plan) => {
    const item = plan.items.find((entry) => entry.taskId === t.id);
    if (!item) return;
    planChanged = true;
    item.status = 'done';
    item.completedAt = t.completedAt;
    plan.updatedAt = Date.now();
  });
  saveTasks();
  if (planChanged) saveWorkflow();
  return result;
}

function saveAndCompleteTask(id, data) {
  if (id != null && workflowState.activeFocus && workflowState.activeFocus.taskId === Number(id)) {
    finishFocus({ completeTask: false });
  }
  const pendingData = Object.assign({}, data, { status: 'todo' });
  let task;
  if (id == null) {
    task = createTaskRecord(pendingData);
  } else {
    task = getTask(id);
    if (!task) throw new Error('任务不存在');
    applyTaskPatch(task, pendingData);
  }
  const result = completeTaskRecord(task);
  let planChanged = false;
  Object.values(workflowState.dailyPlans).forEach((plan) => {
    const item = plan.items.find((entry) => entry.taskId === task.id);
    if (!item) return;
    planChanged = true;
    item.status = 'done';
    item.completedAt = task.completedAt;
    plan.updatedAt = Date.now();
  });
  saveTasks();
  if (planChanged) saveWorkflow();
  return result;
}

/* ---------- 顺延：过期任务推迟到明天 ---------- */
function postponeTask(id, days) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  if (!t.due) throw new Error('任务没有截止时间');
  const d = new Date(t.due.replace(' ', 'T') + ':00');
  d.setDate(d.getDate() + (days || 1));
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  t.due = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  saveTasks();
  return t;
}

function clearAllTasks() {
  tasks = [];
  workflowState = normalizeWorkflowState({ preferences: workflowState.preferences });
  saveTaskAndWorkflowState();
  return tasks;
}

function importTasks(list) {
  if (!Array.isArray(list)) throw new Error('导入数据格式不正确');
  const imported = [];
  list.forEach((raw) => {
    if (!raw || !raw.title) return;
    const t = {
      id: nextId(),
      title: String(raw.title).trim(),
      desc: String(raw.desc || '').trim(),
      pri: [1, 2, 3, 4].includes(Number(raw.pri)) ? Number(raw.pri) : 2,
      due: raw.due || null,
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 5) : [],
      project: String(raw.project || ''),
      status: ['todo', 'doing', 'done', 'archived'].includes(raw.status) ? raw.status : 'todo',
      repeat: ['', 'daily', 'weekly', 'monthly'].includes(raw.repeat) ? raw.repeat : '',
      remind: [0, 10, 30, 60].includes(Number(raw.remind)) ? Number(raw.remind) : 30,
      estimatedMinutes: normalizeEstimatedMinutes(raw.estimatedMinutes),
      children: Array.isArray(raw.children) ? raw.children : [],
      workLogs: normalizeWorkLogs(raw.workLogs),
      completedAt: raw.completedAt || null,
      order: raw.order != null ? Number(raw.order) : Date.now(),
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || raw.createdAt || Date.now()
    };
    tasks.push(t);
    imported.push(t);
  });
  saveTasks();
  return imported;
}

function resetTasks() {
  tasks = seedTasks();
  seq = 100;
  tasks.forEach((t) => { if (t.id > seq) seq = t.id; });
  tasks = tasks.map((task) => Object.assign({}, task, { estimatedMinutes: null, workLogs: [], updatedAt: task.createdAt || Date.now() }));
  workflowState = normalizeWorkflowState({ preferences: workflowState.preferences });
  saveTaskAndWorkflowState();
  return tasks;
}

/* ---------- 设置 ---------- */
function getSettings() {
  return Object.assign({}, settings, { workHours: normalizeWorkHours(settings.workHours) });
}

function updateSettings(patch) {
  const next = Object.assign({}, settings, patch);
  if (patch && patch.workHours) next.workHours = normalizeWorkHours(patch.workHours);
  settings = next;
  saveSettings();
  return getSettings();
}

function saveSettings() {
  writeJson(SETTINGS_FILE, settings);
}

/* ---------- 聊天记录 ---------- */
function getChatLog() {
  return chatLog;
}

function appendChat(entry) {
  appendChatEntries([entry]);
  return entry;
}

function appendChatEntries(entries) {
  const additions = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : [];
  if (!additions.length) return [];
  const next = [...chatLog, ...additions].slice(-500);
  writeJson(CHAT_FILE, next);
  chatLog = next;
  return additions;
}

function clearChat() {
  chatLog = [];
  writeJson(CHAT_FILE, []);
  clearAgentState();
  return chatLog;
}

/* ---------- Agent 会话状态 ---------- */
function normalizeAgentState(value) {
  const state = value && typeof value === 'object' ? value : {};
  const normalizeReference = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const id = Number(entry.id) || null;
    if (!id) return null;
    return {
      type: entry.type === 'memo' ? 'memo' : 'task',
      id,
      title: String(entry.title || ''),
      ts: Number(entry.ts) || Date.now()
    };
  };
  const lastEntity = state.lastEntity && typeof state.lastEntity === 'object'
    ? normalizeReference(state.lastEntity)
    : null;
  const referenceKeys = new Set();
  const references = (Array.isArray(state.references) ? state.references : [])
    .map(normalizeReference)
    .filter((entry) => {
      if (!entry) return false;
      const key = `${entry.type}:${entry.id}`;
      if (referenceKeys.has(key)) return false;
      referenceKeys.add(key);
      return true;
    })
    .slice(0, 8);
  const pending = state.pending && typeof state.pending === 'object'
    ? JSON.parse(JSON.stringify(state.pending))
    : null;
  const lastCollection = state.lastCollection && typeof state.lastCollection === 'object'
    ? {
        type: state.lastCollection.type === 'memo' ? 'memo' : 'task',
        ids: Array.isArray(state.lastCollection.ids)
          ? state.lastCollection.ids.map(Number).filter(Boolean).slice(0, 20)
          : [],
        ts: Number(state.lastCollection.ts) || Date.now()
      }
    : null;
  const reportSession = normalizeReportSession(state.reportSession);
  return { lastEntity, lastCollection, references, pending, reportSession };
}

function normalizeReportSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id || '').trim().slice(0, 120);
  const snapshot = value.snapshot && typeof value.snapshot === 'object' ? cloneData(value.snapshot) : null;
  if (!id || !snapshot || !Array.isArray(snapshot.sources)) return null;
  const serializedSnapshot = JSON.stringify(snapshot);
  if (serializedSnapshot.length > 1500000) return null;
  const preferences = value.preferences && typeof value.preferences === 'object'
    ? {
        audience: String(value.preferences.audience || '').trim().slice(0, 80),
        purpose: String(value.preferences.purpose || '').trim().slice(0, 160),
        tone: String(value.preferences.tone || '').trim().slice(0, 80),
        length: String(value.preferences.length || '').trim().slice(0, 80),
        focus: String(value.preferences.focus || '').trim().slice(0, 200),
        exclude: (Array.isArray(value.preferences.exclude) ? value.preferences.exclude : [])
          .map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, 12)
      }
    : {};
  const report = value.report && typeof value.report === 'object' ? cloneData(value.report) : null;
  return {
    id,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    period: value.period === 'daily' ? 'daily' : 'weekly',
    offset: Math.max(-366, Math.min(366, Math.round(Number(value.offset) || 0))),
    preferences,
    instruction: String(value.instruction || '').trim().slice(0, 2000),
    snapshot,
    report,
    markdown: String(value.markdown || '').slice(0, 60000),
    sourceFingerprint: String(value.sourceFingerprint || snapshot.sourceFingerprint || '').slice(0, 128),
    authoredBy: value.authoredBy === 'model' ? 'model' : 'local'
  };
}

function getAgentState() {
  return JSON.parse(JSON.stringify(agentState));
}

function updateAgentState(patch) {
  agentState = normalizeAgentState(Object.assign({}, agentState, patch));
  writeJson(AGENT_STATE_FILE, agentState);
  return getAgentState();
}

function clearAgentState() {
  agentState = normalizeAgentState({});
  writeJson(AGENT_STATE_FILE, agentState);
  return getAgentState();
}

/* ---------- 每日工作闭环 ---------- */
function saveWorkflow() {
  if (agentTransactionDepth) return;
  writeJson(WORKFLOW_FILE, workflowState);
}

function syncTaskInWorkflow(task, inactiveStatus) {
  let changed = false;
  if (workflowState.activeFocus && workflowState.activeFocus.taskId === task.id && workflowState.activeFocus.title !== task.title) {
    workflowState.activeFocus.title = task.title;
    changed = true;
  }
  Object.values(workflowState.dailyPlans).forEach((plan) => {
    const item = plan.items.find((entry) => entry.taskId === task.id);
    if (!item) return;
    if (item.title !== task.title) {
      item.title = task.title;
      changed = true;
    }
    if (inactiveStatus && item.status !== inactiveStatus) {
      item.status = inactiveStatus;
      if (inactiveStatus === 'done') item.completedAt = task.completedAt || Date.now();
      changed = true;
    }
    if (changed) plan.updatedAt = Date.now();
  });
  if (changed) saveWorkflow();
}

function getWorkflowState(now) {
  return workflowSnapshot(workflowState, now);
}

function updateWorkPreferences(patch) {
  workflowState.preferences = normalizePreferences(Object.assign({}, workflowState.preferences, patch));
  saveWorkflow();
  return getWorkflowState();
}

function getDailyCopilot(now) {
  return buildDailyCopilot(getAllTasks(), getWorkflowState(now), now);
}

function updateDailyCopilot(input) {
  const source = input && typeof input === 'object' ? input : {};
  const action = String(source.action || '');
  const now = Number(source.now) || Date.now();
  const current = normalizeCopilotState(workflowState.copilot);
  const briefing = getDailyCopilot(now);
  const next = Object.assign({}, current);
  if (action === 'snooze') {
    const minutes = Math.max(5, Math.min(240, Math.round(Number(source.minutes) || 30)));
    next.snoozedUntil = now + minutes * 60000;
    next.lastActionKey = briefing.suggestion && briefing.suggestion.key || '';
    next.lastActionAt = now;
  } else if (action === 'mute-today') {
    next.mutedDate = localDateKey(now);
    next.snoozedUntil = 0;
    next.lastActionKey = briefing.suggestion && briefing.suggestion.key || '';
    next.lastActionAt = now;
  } else if (action === 'restore') {
    next.mutedDate = '';
    next.snoozedUntil = 0;
  } else if (action === 'preferences') {
    if (source.enabled !== undefined) next.enabled = !!source.enabled;
    if (source.quietStart !== undefined) next.quietStart = source.quietStart;
    if (source.quietEnd !== undefined) next.quietEnd = source.quietEnd;
  } else {
    throw new Error('未知的每日助手设置');
  }
  workflowState.copilot = normalizeCopilotState(next);
  saveWorkflow();
  return getDailyCopilot(now);
}

function previewDailyPlan(options) {
  return generateDailyPlan(getAllTasks(), workflowState, options || {});
}

function validatePlanForWrite(planInput) {
  const normalized = normalizePlan(planInput, planInput && planInput.date);
  if (!normalized || !normalized.items.length) throw new Error('计划中没有可执行的任务');
  const seen = new Set();
  normalized.items.forEach((item) => {
    if (seen.has(item.taskId)) throw new Error('计划中不能重复安排同一任务');
    seen.add(item.taskId);
    const task = getTask(item.taskId);
    if (!task || !['todo', 'doing'].includes(task.status)) throw new Error(`任务「${item.title || item.taskId}」当前不可安排`);
    item.title = task.title;
  });
  normalized.scheduledMinutes = normalized.items.reduce((sum, item) => sum + item.plannedMinutes, 0);
  if (normalized.scheduledMinutes > normalized.capacityMinutes) {
    throw new Error(`计划超出可用时间 ${normalized.scheduledMinutes - normalized.capacityMinutes} 分钟`);
  }
  if (!planFitsWorkday(normalized, workflowState.preferences)) {
    throw new Error(`计划不能超出工作时间 ${workflowState.preferences.workdayStart} - ${workflowState.preferences.workdayEnd}`);
  }
  return normalized;
}

function applyDailyPlan(planInput) {
  const plan = validatePlanForWrite(planInput);
  const current = workflowState.dailyPlans[plan.date] || null;
  const expectedRevision = (current && current.revision || 0) + 1;
  if (plan.revision !== expectedRevision) throw new Error('今日计划已经变化，请重新生成后再确认');
  const previousPlan = cloneData(current);
  plan.status = 'active';
  plan.updatedAt = Date.now();
  workflowState.dailyPlans[plan.date] = plan;
  saveWorkflow();
  return { plan: cloneData(plan), previousPlan };
}

function updateDailyPlan(date, input) {
  const current = workflowState.dailyPlans[date];
  if (!current) throw new Error('没有找到这一天的计划');
  if (Number(input && input.expectedRevision) !== current.revision) throw new Error('计划已经变化，请刷新后重试');
  const next = validatePlanForWrite(Object.assign({}, current, {
    items: input.items,
    revision: current.revision + 1,
    updatedAt: Date.now()
  }));
  const previousPlan = cloneData(current);
  workflowState.dailyPlans[date] = next;
  saveWorkflow();
  return { plan: cloneData(next), previousPlan };
}

function restoreDailyPlan(input) {
  const date = String(input && input.date || '');
  const current = workflowState.dailyPlans[date] || null;
  if (!current || current.revision !== Number(input && input.expectedRevision)) {
    return { ok: false, reason: 'conflict', message: '计划后来又被调整过，本次撤销未执行' };
  }
  if (input.previousPlan) workflowState.dailyPlans[date] = normalizePlan(input.previousPlan, date);
  else delete workflowState.dailyPlans[date];
  saveWorkflow();
  return { ok: true, plan: cloneData(workflowState.dailyPlans[date] || null) };
}

function planItemForTask(taskId, date) {
  const plan = workflowState.dailyPlans[date];
  if (!plan) return { plan: null, item: null };
  return { plan, item: plan.items.find((entry) => entry.taskId === Number(taskId)) || null };
}

function saveTaskAndWorkflowState() {
  saveTasks();
  saveWorkflow();
}

function startFocus(taskId, options) {
  const task = getTask(Number(taskId));
  if (!task || !['todo', 'doing'].includes(task.status)) throw new Error('这个任务当前不能开始专注');
  if (workflowState.activeFocus) {
    if (workflowState.activeFocus.taskId === task.id && workflowState.activeFocus.state === 'paused') return resumeFocus(options);
    throw new Error(`正在专注「${workflowState.activeFocus.title}」，请先暂停或结束当前专注`);
  }
  const now = Number(options && options.now) || Date.now();
  const date = localDateKey(now);
  const match = planItemForTask(task.id, date);
  const targetMinutes = normalizeEstimatedMinutes(options && options.targetMinutes) ||
    match.item && match.item.plannedMinutes || task.estimatedMinutes || workflowState.preferences.focusMinutes;
  const before = { tasks: cloneData(tasks), workflow: cloneData(workflowState) };
  try {
    task.status = 'doing';
    if (match.item) match.item.status = 'active';
    if (match.plan) match.plan.updatedAt = now;
    workflowState.activeFocus = {
      id: `focus-${now}-${task.id}`,
      taskId: task.id,
      title: task.title,
      planDate: date,
      planItemId: match.item && match.item.id || null,
      state: 'running',
      targetMinutes,
      startedAt: now,
      resumedAt: now,
      pausedAt: null,
      accumulatedMs: 0,
      interruptions: []
    };
    saveTaskAndWorkflowState();
    return getWorkflowState(now);
  } catch (error) {
    tasks = before.tasks;
    workflowState = before.workflow;
    throw error;
  }
}

function pauseFocus(input) {
  const focus = workflowState.activeFocus;
  if (!focus) throw new Error('当前没有进行中的专注');
  const now = Number(input && input.now) || Date.now();
  const reason = String(input && input.reason || '').trim().slice(0, 160);
  if (focus.state === 'running') {
    focus.accumulatedMs += Math.max(0, now - focus.resumedAt);
    focus.state = 'paused';
    focus.resumedAt = null;
    focus.pausedAt = now;
  }
  if (reason) focus.interruptions.push({ at: now, reason });
  const match = planItemForTask(focus.taskId, focus.planDate);
  if (match.item) match.item.status = 'paused';
  if (match.plan) match.plan.updatedAt = now;
  saveWorkflow();
  return getWorkflowState(now);
}

function resumeFocus(input) {
  const focus = workflowState.activeFocus;
  if (!focus) throw new Error('当前没有可继续的专注');
  if (focus.state === 'running') return getWorkflowState(input && input.now);
  const task = getTask(focus.taskId);
  if (!task || !['todo', 'doing'].includes(task.status)) throw new Error('关联任务当前不能继续');
  const now = Number(input && input.now) || Date.now();
  focus.state = 'running';
  focus.resumedAt = now;
  focus.pausedAt = null;
  const match = planItemForTask(focus.taskId, focus.planDate);
  if (match.item) match.item.status = 'active';
  if (match.plan) match.plan.updatedAt = now;
  saveWorkflow();
  return getWorkflowState(now);
}

function recordInterruption(reason, input) {
  return pauseFocus(Object.assign({}, input, { reason: String(reason || '').trim() || '被临时事务打断' }));
}

function finishFocus(input) {
  const focus = workflowState.activeFocus;
  if (!focus) throw new Error('当前没有进行中的专注');
  const now = Number(input && input.now) || Date.now();
  const task = getTask(focus.taskId);
  const before = { tasks: cloneData(tasks), workflow: cloneData(workflowState) };
  try {
    const elapsedMs = focusElapsedMs(focus, now);
    const complete = !!(input && input.completeTask);
    const session = {
      id: focus.id,
      taskId: focus.taskId,
      title: focus.title,
      planDate: focus.planDate,
      targetMinutes: focus.targetMinutes,
      startedAt: focus.startedAt,
      endedAt: now,
      focusedMs: elapsedMs,
      outcome: complete ? 'completed' : 'stopped',
      interruptions: cloneData(focus.interruptions)
    };
    workflowState.focusSessions.push(session);
    workflowState.focusSessions = workflowState.focusSessions.slice(-200);
    const match = planItemForTask(focus.taskId, focus.planDate);
    let completion = null;
    if (complete && task) {
      completion = completeTaskRecord(task);
      if (match.item) {
        match.item.status = 'done';
        match.item.completedAt = now;
      }
    } else if (match.item) {
      match.item.status = 'planned';
    }
    if (match.plan) match.plan.updatedAt = now;
    workflowState.activeFocus = null;
    saveTaskAndWorkflowState();
    return { workflow: getWorkflowState(now), session: cloneData(session), completion };
  } catch (error) {
    tasks = before.tasks;
    workflowState = before.workflow;
    throw error;
  }
}

function getDailyReview(date, now) {
  return createDailyReview(getAllTasks(), workflowState, date, now);
}

function saveDailyReview(date, input) {
  const plan = workflowState.dailyPlans[date];
  if (!plan) throw new Error('没有找到这一天的计划');
  if (workflowState.activeFocus && workflowState.activeFocus.planDate === date) {
    throw new Error('请先结束当前专注，再保存今日复盘');
  }
  const previousPlan = cloneData(plan);
  const review = Object.assign({}, getDailyReview(date), {
    note: String(input && input.note || '').trim().slice(0, 1000),
    unfinishedReasons: Array.isArray(input && input.unfinishedReasons)
      ? input.unfinishedReasons.slice(0, 20).map((entry) => ({ taskId: Number(entry.taskId), reason: String(entry.reason || '').trim().slice(0, 200) }))
      : []
  });
  plan.review = review;
  plan.status = 'completed';
  plan.revision += 1;
  plan.updatedAt = Date.now();
  saveWorkflow();
  return { review: cloneData(review), plan: cloneData(plan), previousPlan };
}

/* ---------- 备份 ---------- */
function getBackupPayload() {
  return { version: 5, tasks, memos, agentState, workflow: workflowState };
}

function backup() {
  ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `tasks-${stamp}.json`);
  writeJson(file, getBackupPayload());
  // 只保留最近 14 份
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('tasks-')).sort();
  while (files.length > 14) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
  return file;
}

/* 列出备份目录中的所有备份文件（含时间、大小） */
function listBackups() {
  ensureDir(BACKUP_DIR);
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('tasks-') && f.endsWith('.json'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      // 从文件名解析时间戳：tasks-2026-08-19T10-30-00.json
      const m = f.match(/tasks-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      let time = '';
      if (m) time = `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
      return { name: f, path: full, size: stat.size, time };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // 新的在前
}

/* 从指定备份文件恢复任务数据（覆盖当前任务） */
function restoreFromBackup(filePath) {
  if (!filePath) throw new Error('未指定备份文件');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.tasks || []);
  if (!Array.isArray(list)) throw new Error('备份文件格式不正确');
  // 恢复前先做一次当前数据备份，防止误操作丢失
  backup();
  tasks = list.map((t) => Object.assign({}, t, {
    estimatedMinutes: normalizeEstimatedMinutes(t.estimatedMinutes),
    workLogs: normalizeWorkLogs(t.workLogs),
    updatedAt: Number(t.updatedAt) || Number(t.createdAt) || Date.now()
  }));
  // 重新计算最大 id
  seq = 100;
  tasks.forEach((t) => { if (t.id > seq) seq = t.id; });
  saveTasks();
  if (!Array.isArray(data) && Array.isArray(data.memos)) {
    memoSeq = 1000;
    memos = data.memos.map(normalizeMemo);
    memos.forEach((memo) => { if (memo.id > memoSeq) memoSeq = memo.id; });
    saveMemos();
  }
  if (!Array.isArray(data) && data.agentState) {
    agentState = normalizeAgentState(data.agentState);
    writeJson(AGENT_STATE_FILE, agentState);
  } else {
    clearAgentState();
  }
  workflowState = !Array.isArray(data) && data.workflow
    ? normalizeWorkflowState(data.workflow)
    : normalizeWorkflowState({});
  saveWorkflow();
  return { ok: true, count: tasks.length, memoCount: getAllMemos().length, workflowRestored: !!(!Array.isArray(data) && data.workflow) };
}

/* 一键备份到外部指定文件夹（防止数据目录丢失） */
function backupToDir(dir) {
  if (!dir) throw new Error('未指定目标文件夹');
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `work-helper-backup-${stamp}.json`);
  writeJson(file, getBackupPayload());
  return file;
}

/* ---------- 导出 ---------- */
function exportJSON() {
  return JSON.stringify({ version: 3, tasks: getAllTasks(), memos: getAllMemos(), workflow: getWorkflowState() }, null, 2);
}

function exportCSV() {
  const header = ['id', 'title', 'desc', 'pri', 'due', 'tags', 'project', 'status', 'repeat', 'remind', 'estimatedMinutes'];
  const rows = getAllTasks().map((t) => [
    t.id, t.title, t.desc, t.pri, t.due || '', (t.tags || []).join('|'), t.project, t.status, t.repeat, t.remind, t.estimatedMinutes || ''
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  return csv;
}

/* ---------- 保存 ---------- */
function saveTasks() {
  if (agentTransactionDepth) return;
  writeJson(TASKS_FILE, tasks);
}

function saveMemos() {
  if (agentTransactionDepth) return;
  writeJson(MEMOS_FILE, memos);
}

/* ---------- 报告事实快照 ---------- */
function reportDateRange(periodValue, offsetValue, nowValue) {
  const period = periodValue === 'daily' ? 'daily' : 'weekly';
  const offset = Math.max(-366, Math.min(366, Math.round(Number(offsetValue) || 0)));
  const now = nowValue instanceof Date ? new Date(nowValue) : new Date(nowValue || Date.now());
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'daily') start.setDate(start.getDate() + offset);
  else {
    const weekday = start.getDay() || 7;
    start.setDate(start.getDate() - weekday + 1 + offset * 7);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + (period === 'daily' ? 1 : 7));
  const nextStart = new Date(end);
  const nextEnd = new Date(nextStart);
  nextEnd.setDate(nextEnd.getDate() + (period === 'daily' ? 1 : 7));
  return { period, offset, now, start, end, nextStart, nextEnd };
}

function reportTaskDue(task) {
  if (!task || !task.due) return null;
  const date = new Date(String(task.due).replace(' ', 'T') + ':00');
  return Number.isNaN(date.getTime()) ? null : date;
}

function reportSourceIdPart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 100) || 'item';
}

function buildReportSnapshot(input) {
  const source = input && typeof input === 'object' ? input : {};
  const range = reportDateRange(source.period, source.offset, source.now);
  const inRange = (value, start = range.start, end = range.end) => {
    const time = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
  };
  const dateInRange = (date, start = range.start, end = range.end) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
    const time = new Date(`${date}T00:00:00`).getTime();
    return time >= start.getTime() && time < end.getTime();
  };
  const all = tasks.filter((task) => task && !task._deleted);
  const workLogRecords = all.flatMap((task) => normalizeWorkLogs(task.workLogs)
    .filter((log) => inRange(log.createdAt))
    .map((log) => ({ task, log })));
  const loggedTasks = workLogRecords.map((entry) => entry.task);
  const completed = all.filter((task) => task.status === 'done' && inRange(task.completedAt));
  const created = all.filter((task) => inRange(task.createdAt));
  const due = all.filter((task) => {
    const value = reportTaskDue(task);
    return value && inRange(value);
  });
  const unfinished = due.filter((task) => !['done', 'archived'].includes(task.status));
  const overdue = all.filter((task) => {
    const value = reportTaskDue(task);
    return value && !['done', 'archived'].includes(task.status) && value.getTime() < range.now.getTime();
  });
  const active = all.filter((task) => task.status === 'doing');
  const nextDue = all.filter((task) => {
    const value = reportTaskDue(task);
    return value && !['done', 'archived'].includes(task.status) && inRange(value, range.nextStart, range.nextEnd);
  });
  const relevantTasks = [...new Map([...completed, ...created, ...loggedTasks, ...due, ...overdue, ...active, ...nextDue].map((task) => [task.id, task])).values()];
  const sources = [];
  const taskSourceIds = new Map();

  relevantTasks.forEach((task) => {
    const id = `task-${reportSourceIdPart(task.id)}`;
    const children = Array.isArray(task.children) ? task.children : [];
    const completedChildren = children.filter((child) => child && child.done);
    taskSourceIds.set(task.id, id);
    sources.push({
      id,
      type: 'task',
      title: task.title,
      detail: [
        task.status === 'done' ? '已完成' : task.status === 'doing' ? '进行中' : '待办',
        task.project ? `项目：${task.project}` : '',
        task.due ? `截止：${task.due}` : '',
        task.completedAt ? `完成：${new Date(task.completedAt).toLocaleString('zh-CN')}` : '',
        task.desc ? `说明：${String(task.desc).slice(0, 500)}` : '',
        children.length ? `子任务：已完成 ${completedChildren.length}/${children.length}${completedChildren.length ? `（${completedChildren.map((child) => child.title).join('、')}）` : ''}` : '',
        task.tags && task.tags.length ? `标签：${task.tags.join('、')}` : ''
      ].filter(Boolean).join('；'),
      taskId: task.id,
      status: task.status,
      due: task.due || null,
      completedAt: task.completedAt || null,
      priority: Number(task.pri) || 0,
      description: String(task.desc || '').slice(0, 500),
      createdAt: task.createdAt || null,
      createdInPeriod: inRange(task.createdAt),
      childProgress: children.length ? {
        completed: completedChildren.length,
        total: children.length,
        completedTitles: completedChildren.map((child) => child.title).slice(0, 20),
        pendingTitles: children.filter((child) => child && !child.done).map((child) => child.title).slice(0, 20)
      } : null,
      project: task.project || '',
      tags: Array.isArray(task.tags) ? task.tags.slice(0, 20) : []
    });
  });
  const workLogSourceIds = [];
  const workLogKinds = { outcome: [], progress: [], blocker: [], decision: [], next: [] };
  workLogRecords.forEach(({ task, log }) => {
    const id = `worklog-${reportSourceIdPart(task.id)}-${reportSourceIdPart(log.id)}`;
    workLogSourceIds.push(id);
    workLogKinds[log.kind].push(id);
    sources.push({
      id,
      type: 'worklog',
      title: task.title,
      detail: log.text,
      taskId: task.id,
      kind: log.kind,
      text: log.text,
      project: task.project || '',
      tags: Array.isArray(task.tags) ? task.tags.slice(0, 20) : [],
      createdAt: log.createdAt,
      updatedAt: log.updatedAt
    });
  });

  const plans = Object.entries(workflowState.dailyPlans || {})
    .filter(([date]) => dateInRange(date))
    .sort(([a], [b]) => a.localeCompare(b));
  const planItemSources = [];
  const reviews = [];
  plans.forEach(([date, plan]) => {
    (plan.items || []).forEach((item, index) => {
      const id = `plan-${date}-${reportSourceIdPart(item.id || `${item.taskId}-${index + 1}`)}`;
      const entry = {
        id,
        type: 'plan',
        title: item.title,
        detail: `${date} 计划 ${item.plannedMinutes} 分钟${item.plannedStart ? `，${item.plannedStart}-${item.plannedEnd}` : ''}；状态：${item.status}`,
        date,
        taskId: item.taskId,
        plannedMinutes: Number(item.plannedMinutes) || 0,
        plannedStart: item.plannedStart || '',
        plannedEnd: item.plannedEnd || '',
        status: item.status
      };
      planItemSources.push(entry);
      sources.push(entry);
    });
    if (plan.review) {
      const review = {
        id: `review-${date}`,
        type: 'review',
        title: `${date} 工作复盘`,
        detail: `计划完成率 ${Number(plan.review.completionRate) || 0}%；${String(plan.review.note || plan.review.suggestion || '无备注')}`,
        date,
        completionRate: Number(plan.review.completionRate) || 0,
        note: String(plan.review.note || '').slice(0, 500),
        suggestion: String(plan.review.suggestion || '').slice(0, 500),
        unfinishedReasons: Array.isArray(plan.review.unfinishedReasons)
          ? plan.review.unfinishedReasons.slice(0, 20).map((item) => ({
              taskId: Number(item.taskId) || null,
              reason: String(item.reason || '').slice(0, 200)
            }))
          : []
      };
      reviews.push(review);
      sources.push(review);
    }
  });

  const focusSessions = (workflowState.focusSessions || []).filter((session) => dateInRange(session.planDate));
  focusSessions.forEach((session) => {
    sources.push({
      id: `focus-${reportSourceIdPart(session.id)}`,
      type: 'focus',
      title: session.title,
      detail: `${session.planDate} 专注 ${Math.round(Number(session.focusedMs || 0) / 60000)} 分钟；打断 ${(session.interruptions || []).length} 次；${session.outcome === 'completed' ? '完成' : '结束'}`,
      date: session.planDate,
      taskId: session.taskId,
      focusedMinutes: Math.round(Number(session.focusedMs || 0) / 60000),
      interruptionCount: (session.interruptions || []).length,
      outcome: session.outcome
    });
  });
  const activeFocus = workflowState.activeFocus && dateInRange(workflowState.activeFocus.planDate)
    ? workflowState.activeFocus
    : null;
  if (activeFocus) {
    sources.push({
      id: `focus-active-${reportSourceIdPart(activeFocus.id)}`,
      type: 'focus',
      title: activeFocus.title,
      detail: `${activeFocus.planDate} 正在专注；已投入 ${Math.round(focusElapsedMs(activeFocus, range.now.getTime()) / 60000)} 分钟；打断 ${(activeFocus.interruptions || []).length} 次`,
      date: activeFocus.planDate,
      taskId: activeFocus.taskId,
      focusedMinutes: Math.round(focusElapsedMs(activeFocus, range.now.getTime()) / 60000),
      interruptionCount: (activeFocus.interruptions || []).length,
      outcome: 'active'
    });
  }

  const idsFor = (list) => list.map((task) => taskSourceIds.get(task.id)).filter(Boolean);
  const projectMap = new Map();
  const tagMap = new Map();
  relevantTasks.forEach((task) => {
    const sourceId = taskSourceIds.get(task.id);
    const project = task.project || '未分类';
    if (!projectMap.has(project)) projectMap.set(project, { name: project, taskIds: [], sourceIds: [], completedCount: 0 });
    const projectStat = projectMap.get(project);
    projectStat.taskIds.push(task.id);
    projectStat.sourceIds.push(sourceId);
    if (completed.includes(task)) projectStat.completedCount += 1;
    (task.tags || []).forEach((tag) => {
      if (!tagMap.has(tag)) tagMap.set(tag, { name: tag, taskIds: [], sourceIds: [], completedCount: 0 });
      const tagStat = tagMap.get(tag);
      tagStat.taskIds.push(task.id);
      tagStat.sourceIds.push(sourceId);
      if (completed.includes(task)) tagStat.completedCount += 1;
    });
  });
  workLogRecords.forEach(({ task, log }) => {
    const sourceId = `worklog-${reportSourceIdPart(task.id)}-${reportSourceIdPart(log.id)}`;
    const project = task.project || '未分类';
    if (!projectMap.has(project)) projectMap.set(project, { name: project, taskIds: [], sourceIds: [], completedCount: 0 });
    const projectStat = projectMap.get(project);
    if (!projectStat.taskIds.includes(task.id)) projectStat.taskIds.push(task.id);
    if (!projectStat.sourceIds.includes(sourceId)) projectStat.sourceIds.push(sourceId);
    (task.tags || []).forEach((tag) => {
      if (!tagMap.has(tag)) tagMap.set(tag, { name: tag, taskIds: [], sourceIds: [], completedCount: 0 });
      const tagStat = tagMap.get(tag);
      if (!tagStat.taskIds.includes(task.id)) tagStat.taskIds.push(task.id);
      if (!tagStat.sourceIds.includes(sourceId)) tagStat.sourceIds.push(sourceId);
    });
  });
  const plannedCompleted = planItemSources.filter((item) => item.status === 'done').length;
  const plannedSkipped = planItemSources.filter((item) => item.status === 'skipped').length;
  const activeFocusedMinutes = activeFocus ? Math.round(focusElapsedMs(activeFocus, range.now.getTime()) / 60000) : 0;
  const focusedMinutes = focusSessions.reduce((sum, session) => sum + Math.round(Number(session.focusedMs || 0) / 60000), 0) + activeFocusedMinutes;
  const interruptionCount = focusSessions.reduce((sum, session) => sum + (session.interruptions || []).length, 0) +
    (activeFocus ? (activeFocus.interruptions || []).length : 0);
  const focusSourceIds = [
    ...focusSessions.map((session) => `focus-${reportSourceIdPart(session.id)}`),
    ...(activeFocus ? [`focus-active-${reportSourceIdPart(activeFocus.id)}`] : [])
  ];
  const semantic = {
    period: range.period,
    offset: range.offset,
    range: { start: localDateKey(range.start), end: localDateKey(new Date(range.end.getTime() - 1)) },
    sources
  };
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
  return {
    version: 1,
    generatedAt: Date.now(),
    period: range.period,
    offset: range.offset,
    range: semantic.range,
    nextRange: { start: localDateKey(range.nextStart), end: localDateKey(new Date(range.nextEnd.getTime() - 1)) },
    summary: {
      completed: { count: completed.length, sourceIds: idsFor(completed) },
      created: { count: created.length, sourceIds: idsFor(created) },
      due: { count: due.length, sourceIds: idsFor(due) },
      unfinished: { count: unfinished.length, sourceIds: idsFor(unfinished) },
      overdueRisks: { count: overdue.length, sourceIds: idsFor(overdue) },
      active: { count: active.length, sourceIds: idsFor(active) },
      nextDue: { count: nextDue.length, sourceIds: idsFor(nextDue) },
      planExecution: {
        plannedCount: planItemSources.length,
        completedCount: plannedCompleted,
        skippedCount: plannedSkipped,
        completionRate: planItemSources.length ? Math.round(plannedCompleted / planItemSources.length * 100) : 0,
        scheduledMinutes: planItemSources.reduce((sum, item) => sum + item.plannedMinutes, 0),
        sourceIds: planItemSources.map((item) => item.id)
      },
      focus: {
        sessionCount: focusSourceIds.length,
        focusedMinutes,
        interruptionCount,
        sourceIds: focusSourceIds
      },
      workLogs: {
        count: workLogSourceIds.length,
        sourceIds: workLogSourceIds,
        byKind: Object.fromEntries(Object.entries(workLogKinds).map(([kind, ids]) => [kind, { count: ids.length, sourceIds: ids }]))
      }
    },
    projects: [...projectMap.values()].sort((a, b) => b.completedCount - a.completedCount || a.name.localeCompare(b.name, 'zh-CN')),
    tags: [...tagMap.values()].sort((a, b) => b.completedCount - a.completedCount || a.name.localeCompare(b.name, 'zh-CN')),
    reviews: reviews.map((review) => review.id),
    sources,
    sourceFingerprint
  };
}

/* ---------- 周报生成 ---------- */
/**
 * 生成周报 Markdown
 * @param {number} weekOffset 0=本周, -1=上周, 1=下周
 * @returns {string} Markdown 周报文本
 */
function generateWeeklyReport(weekOffset) {
  const offset = Number(weekOffset) || 0;
  const now = new Date();
  // 计算本周一（周一为一周起点）
  const day = now.getDay() || 7; // 周日=7
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day - 1) + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const weekLabel = `${fmt(monday)} ~ ${fmt(sunday)}`;
  const periodName = offset === -1 ? '上周' : offset === 1 ? '下周' : '本周';
  const nextMonday = new Date(sunday);
  nextMonday.setDate(sunday.getDate() + 1);
  nextMonday.setHours(0, 0, 0, 0);
  const nextSunday = new Date(nextMonday);
  nextSunday.setDate(nextMonday.getDate() + 6);
  nextSunday.setHours(23, 59, 59, 999);

  const all = tasks.filter((t) => !t._deleted);
  const inWeek = (t) => {
    if (!t.completedAt) return false;
    const c = new Date(t.completedAt);
    return c >= monday && c <= sunday;
  };
  const dueInWeek = (t) => {
    if (!t.due) return false;
    const d = new Date(t.due.replace(' ', 'T') + ':00');
    return d >= monday && d <= sunday;
  };
  const dueInNextWeek = (t) => {
    if (!t.due) return false;
    const d = new Date(t.due.replace(' ', 'T') + ':00');
    return d >= nextMonday && d <= nextSunday;
  };

  const doneThisWeek = all.filter((t) => t.status === 'done' && inWeek(t));
  const doingNow = all.filter((t) => t.status === 'doing');
  const todoNow = all.filter((t) => t.status === 'todo');
  const dueThisWeek = all.filter((t) => t.status !== 'done' && t.status !== 'archived' && dueInWeek(t));

  // 按项目统计本周完成
  const projAcc = {};
  doneThisWeek.forEach((t) => {
    const p = t.project || '未分类';
    if (!projAcc[p]) projAcc[p] = [];
    projAcc[p].push(t);
  });

  // 按标签统计本周完成
  const tagAcc = {};
  doneThisWeek.forEach((t) => (t.tags || []).forEach((tag) => {
    if (!tagAcc[tag]) tagAcc[tag] = [];
    tagAcc[tag].push(t);
  }));

  const lines = [];
  lines.push(`# 工作周报（${weekLabel}）`);
  lines.push('');
  lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push(`## 一、${periodName}概览`);
  lines.push('');
  lines.push(`- ✅ ${periodName}完成：**${doneThisWeek.length}** 项`);
  lines.push(`- 🔄 当前进行中：**${doingNow.length}** 项`);
  lines.push(`- 📋 当前待办：**${todoNow.length}** 项`);
  lines.push(`- ⏰ ${periodName}到期未完成：**${dueThisWeek.length}** 项`);
  lines.push('');

  lines.push(`## 二、${periodName}完成明细`);
  lines.push('');
  if (doneThisWeek.length) {
    doneThisWeek
      .slice()
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
      .forEach((t, i) => {
        const c = t.completedAt ? new Date(t.completedAt) : null;
        const dayStr = c ? `${c.getMonth() + 1}/${c.getDate()}` : '';
        const priStr = { 4: '🔴', 3: '🟠', 2: '🟡', 1: '⚪' }[t.pri] || '';
        const proj = t.project ? `（${t.project}）` : '';
        lines.push(`${i + 1}. ${priStr} ${t.title}${proj} — ${dayStr}`);
        if (t.desc) lines.push(`   - ${t.desc}`);
      });
  } else {
    lines.push(`（${periodName}暂无完成任务）`);
  }
  lines.push('');

  lines.push('## 三、按项目统计');
  lines.push('');
  if (Object.keys(projAcc).length) {
    Object.keys(projAcc)
      .sort((a, b) => projAcc[b].length - projAcc[a].length)
      .forEach((p) => {
        lines.push(`- **${p}**：完成 ${projAcc[p].length} 项`);
      });
  } else {
    lines.push('（无）');
  }
  lines.push('');

  lines.push('## 四、按标签统计');
  lines.push('');
  if (Object.keys(tagAcc).length) {
    Object.keys(tagAcc)
      .sort((a, b) => tagAcc[b].length - tagAcc[a].length)
      .forEach((tag) => {
        lines.push(`- **#${tag}**：完成 ${tagAcc[tag].length} 项`);
      });
  } else {
    lines.push('（无）');
  }
  lines.push('');

  lines.push('## 五、当前进行中');
  lines.push('');
  if (doingNow.length) {
    doingNow.forEach((t) => {
      const due = t.due ? `（截止 ${t.due}）` : '';
      lines.push(`- ${t.title}${due}`);
    });
  } else {
    lines.push('（无进行中任务）');
  }
  lines.push('');

  lines.push(`## 六、${periodName}到期未完成`);
  lines.push('');
  if (dueThisWeek.length) {
    dueThisWeek
      .slice()
      .sort((a, b) => (a.due || '').localeCompare(b.due || ''))
      .forEach((t) => {
        lines.push(`- ${t.title}（${t.due}）`);
      });
  } else {
    lines.push('（无）');
  }
  lines.push('');

  lines.push(`## 七、下一周计划建议（${fmt(nextMonday)} ~ ${fmt(nextSunday)}）`);
  lines.push('');
  const nextTodo = all.filter((t) => t.status === 'todo' && dueInNextWeek(t))
    .sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  if (nextTodo.length) {
    nextTodo.slice(0, 10).forEach((t) => {
      lines.push(`- [ ] ${t.title}（${t.due}）`);
    });
  } else {
    lines.push('（暂无带截止时间的待办）');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * 生成日报 Markdown
 * @param {number} dayOffset 0=今天, -1=昨天, 1=明天
 * @returns {string} Markdown 日报文本
 */
function generateDailyReport(dayOffset) {
  const offset = Number(dayOffset) || 0;
  const now = new Date();
  const target = new Date(now);
  target.setDate(now.getDate() + offset);
  const date = localDateKey(target);
  const all = tasks.filter((t) => !t._deleted);
  const isSameDate = (value) => value && localDateKey(value) === date;
  const dueOnDate = (task) => task.due && String(task.due).startsWith(date);
  const completed = all.filter((t) => t.status === 'done' && isSameDate(t.completedAt));
  const dueTasks = all.filter((t) => t.status !== 'archived' && dueOnDate(t));
  const unfinished = dueTasks.filter((t) => t.status !== 'done');
  const overdue = all.filter((t) => t.status !== 'done' && t.status !== 'archived' && t.due && t.due < `${date} 00:00`);
  const plan = workflowState.dailyPlans[date] || null;
  const sessions = workflowState.focusSessions.filter((session) => session.planDate === date);
  const focusedMinutes = Math.round(sessions.reduce((sum, session) => sum + Number(session.focusedMs || 0), 0) / 60000);
  const interruptionCount = sessions.reduce((sum, session) => sum + (Array.isArray(session.interruptions) ? session.interruptions.length : 0), 0);
  const periodName = offset === -1 ? '昨天' : offset === 1 ? '明天' : '今天';
  const lines = [];

  lines.push(`# 工作日报（${date}）`);
  lines.push('');
  lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push(`## 一、${periodName}概览`);
  lines.push('');
  lines.push(`- ✅ 完成任务：**${completed.length}** 项`);
  lines.push(`- 📅 ${periodName}到期：**${dueTasks.length}** 项`);
  lines.push(`- ⏳ ${periodName}未完成：**${unfinished.length}** 项`);
  lines.push(`- 🔥 当前逾期：**${overdue.length}** 项`);
  lines.push(`- 🎯 专注投入：**${focusedMinutes}** 分钟，打断 **${interruptionCount}** 次`);
  lines.push('');

  lines.push(`## 二、${periodName}完成明细`);
  lines.push('');
  if (completed.length) {
    completed
      .slice()
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
      .forEach((task, index) => {
        const time = task.completedAt ? new Date(task.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        const project = task.project ? `（${task.project}）` : '';
        lines.push(`${index + 1}. ${task.title}${project}${time ? ` — ${time}` : ''}`);
        if (task.desc) lines.push(`   - ${task.desc}`);
      });
  } else {
    lines.push(`（${periodName}暂无完成任务）`);
  }
  lines.push('');

  lines.push(`## 三、${periodName}计划与到期任务`);
  lines.push('');
  if (plan && plan.items && plan.items.length) {
    plan.items.forEach((item, index) => {
      const status = item.status === 'done' ? 'x' : ' ';
      lines.push(`${index + 1}. [${status}] ${item.title}（${item.plannedMinutes} 分钟）`);
    });
  } else if (dueTasks.length) {
    dueTasks.forEach((task) => lines.push(`- [${task.status === 'done' ? 'x' : ' '}] ${task.title}${task.due ? `（${task.due}）` : ''}`));
  } else {
    lines.push('（没有记录今日计划或到期任务）');
  }
  lines.push('');

  lines.push('## 四、需要关注');
  lines.push('');
  if (unfinished.length) unfinished.forEach((task) => lines.push(`- ${task.title}${task.due ? `（截止 ${task.due}）` : ''}`));
  if (overdue.length) overdue.slice(0, 10).forEach((task) => lines.push(`- 逾期：${task.title}（${task.due}）`));
  if (!unfinished.length && !overdue.length) lines.push('（暂无需要特别关注的任务）');
  lines.push('');

  lines.push('## 五、工作复盘');
  lines.push('');
  const review = plan && plan.review;
  if (review) {
    lines.push(`- 计划完成率：${review.completionRate}%（${review.completedCount}/${review.plannedCount}）`);
    if (review.note) lines.push(`- 复盘备注：${review.note}`);
    if (review.suggestion) lines.push(`- 建议：${review.suggestion}`);
  } else if (completed.length || focusedMinutes) {
    lines.push(`- 今天完成 ${completed.length} 项任务，累计专注 ${focusedMinutes} 分钟。`);
    lines.push('- 可以在结束工作后补充一次复盘，让明天的安排更准确。');
  } else {
    lines.push('（尚未保存复盘）');
  }

  return lines.join('\n');
}

function generateReport(input) {
  const source = typeof input === 'string' ? { period: input } : (input || {});
  const period = source.period === 'daily' ? 'daily' : 'weekly';
  return period === 'daily' ? generateDailyReport(source.offset) : generateWeeklyReport(source.offset);
}

module.exports = {
  init,
  getDataDir,
  getAllTasks,
  getTask,
  createTask,
  createAdditions,
  removeCreatedAdditions,
  runAgentTransaction,
  restoreAgentTransaction,
  updateTask,
  deleteTask,
  restoreTask,
  archiveTask,
  unarchiveTask,
  hardDeleteTask,
  getDeletedTasks,
  purgeTask,
  emptyTrash,
  batchUpdate,
  batchComplete,
  batchDelete,
  reorderTasks,
  completeTask,
  saveAndCompleteTask,
  addTaskWorkLog,
  updateTaskWorkLog,
  removeTaskWorkLog,
  postponeTask,
  clearAllTasks,
  importTasks,
  resetTasks,
  getAllMemos,
  getMemo,
  createMemo,
  updateMemo,
  deleteMemo,
  getDeletedMemos,
  restoreMemo,
  purgeMemo,
  emptyMemoTrash,
  importMemos,
  getSettings,
  updateSettings,
  getChatLog,
  appendChat,
  appendChatEntries,
  clearChat,
  getAgentState,
  updateAgentState,
  clearAgentState,
  getWorkflowState,
  updateWorkPreferences,
  getDailyCopilot,
  updateDailyCopilot,
  previewDailyPlan,
  applyDailyPlan,
  updateDailyPlan,
  restoreDailyPlan,
  startFocus,
  pauseFocus,
  resumeFocus,
  recordInterruption,
  finishFocus,
  getDailyReview,
  saveDailyReview,
  backup,
  listBackups,
  restoreFromBackup,
  backupToDir,
  exportJSON,
  exportCSV,
  buildReportSnapshot,
  generateWeeklyReport,
  generateDailyReport,
  generateReport
};
