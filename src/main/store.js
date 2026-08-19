'use strict';

/**
 * 数据存储层 - 纯本地 JSON 文件存储
 * 数据主权第一原则：所有任务、设置、AI 会话记录全部存于本机
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/* ---------- 路径 ---------- */
function getDataDir() {
  // 允许通过环境变量覆盖（测试用）
  if (process.env.WORK_HELPER_DATA_DIR) return process.env.WORK_HELPER_DATA_DIR;
  return path.join(app.getPath('userData'), 'data');
}

const DATA_DIR = getDataDir();
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
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
let settings = {};
let chatLog = [];
let seq = 100;

/* ---------- 初始化 ---------- */
function init() {
  ensureDir(DATA_DIR);
  ensureDir(BACKUP_DIR);

  tasks = readJson(TASKS_FILE, null);
  if (!tasks || !Array.isArray(tasks)) {
    tasks = seedTasks();
    saveTasks();
  }
  // 计算最大 id
  tasks.forEach((t) => { if (t.id > seq) seq = t.id; });

  settings = Object.assign({}, getDefaultSettings(), readJson(SETTINGS_FILE, {}));
  chatLog = readJson(CHAT_FILE, []);
}

function getDefaultSettings() {
  return {
    localOnly: true,
    autoBackup: true,
    autoStart: false,
    notify: true,
    theme: 'auto',
    aiStage: 'llm', // 'mock' | 'llm' 默认 LLM（配置 Key 即生效），未配置时自动降级规则引擎
    aiProvider: 'openai', // 'openai' | 'deepseek' | 'custom'
    aiBaseUrl: '',
    aiApiKey: '',
    aiModel: '',
    aiTemperature: 0.2,
    petPosition: null, // { x, y } 桌宠位置
    petEnabled: true, // 桌宠是否显示
    shortcuts: { ai: 'CommandOrControl+J', newTask: 'CommandOrControl+N' }
  };
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

function createTask(data) {
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
    children: normalizeChildren(data.children),
    completedAt: data.completedAt || null,
    order: data.order != null ? Number(data.order) : Date.now(),
    createdAt: Date.now()
  };
  if (!task.title) throw new Error('标题不能为空');
  tasks.push(task);
  saveTasks();
  return task;
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

function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
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
  if (patch.remind !== undefined && [0, 10, 30, 60].includes(Number(patch.remind))) t.remind = Number(patch.remind);
  if (patch.children !== undefined) t.children = normalizeChildren(patch.children);
  if (patch.order !== undefined) t.order = Number(patch.order);
  saveTasks();
  return t;
}

function deleteTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  t._deleted = true; // 软删除，支持撤销
  saveTasks();
  return { ok: true, id };
}

function restoreTask(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error('任务不存在');
  delete t._deleted;
  saveTasks();
  return t;
}

function archiveTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  t.status = 'archived';
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
  return tasks.filter((t) => t._deleted);
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
function completeTask(id) {
  const t = getTask(id);
  if (!t) throw new Error('任务不存在');
  t.status = 'done';
  t.completedAt = Date.now();
  let next = null;
  if (t.repeat && t.due) {
    const nextDue = nextDueForRepeat(t.repeat, t.due);
    if (nextDue) {
      next = createTask({
        title: t.title,
        desc: t.desc,
        pri: t.pri,
        due: nextDue,
        tags: t.tags,
        project: t.project,
        repeat: t.repeat,
        remind: t.remind,
        children: t.children
      });
    }
  }
  saveTasks();
  return { task: t, next };
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
  saveTasks();
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
      children: Array.isArray(raw.children) ? raw.children : [],
      completedAt: raw.completedAt || null,
      order: raw.order != null ? Number(raw.order) : Date.now(),
      createdAt: raw.createdAt || Date.now()
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
  saveTasks();
  return tasks;
}

/* ---------- 设置 ---------- */
function getSettings() {
  return Object.assign({}, settings);
}

function updateSettings(patch) {
  settings = Object.assign({}, settings, patch);
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
  chatLog.push(entry);
  if (chatLog.length > 500) chatLog = chatLog.slice(-500);
  writeJson(CHAT_FILE, chatLog);
  return entry;
}

function clearChat() {
  chatLog = [];
  writeJson(CHAT_FILE, []);
  return chatLog;
}

/* ---------- 备份 ---------- */
function backup() {
  ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `tasks-${stamp}.json`);
  fs.copyFileSync(TASKS_FILE, file);
  // 只保留最近 14 份
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('tasks-')).sort();
  while (files.length > 14) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
  return file;
}

/* ---------- 导出 ---------- */
function exportJSON() {
  return JSON.stringify(getAllTasks(), null, 2);
}

function exportCSV() {
  const header = ['id', 'title', 'desc', 'pri', 'due', 'tags', 'project', 'status', 'repeat', 'remind'];
  const rows = getAllTasks().map((t) => [
    t.id, t.title, t.desc, t.pri, t.due || '', (t.tags || []).join('|'), t.project, t.status, t.repeat, t.remind
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  return csv;
}

/* ---------- 保存 ---------- */
function saveTasks() {
  writeJson(TASKS_FILE, tasks);
}

module.exports = {
  init,
  getDataDir,
  getAllTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  restoreTask,
  archiveTask,
  unarchiveTask,
  hardDeleteTask,
  getDeletedTasks,
  emptyTrash,
  batchUpdate,
  batchDelete,
  reorderTasks,
  completeTask,
  postponeTask,
  clearAllTasks,
  importTasks,
  resetTasks,
  getSettings,
  updateSettings,
  getChatLog,
  appendChat,
  clearChat,
  backup,
  exportJSON,
  exportCSV
};