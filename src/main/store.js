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
  tasks = list.map((t) => Object.assign({}, t));
  // 重新计算最大 id
  seq = 100;
  tasks.forEach((t) => { if (t.id > seq) seq = t.id; });
  saveTasks();
  return { ok: true, count: tasks.length };
}

/* 一键备份到外部指定文件夹（防止数据目录丢失） */
function backupToDir(dir) {
  if (!dir) throw new Error('未指定目标文件夹');
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `work-helper-backup-${stamp}.json`);
  fs.copyFileSync(TASKS_FILE, file);
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
  lines.push('## 一、本周概览');
  lines.push('');
  lines.push(`- ✅ 本周完成：**${doneThisWeek.length}** 项`);
  lines.push(`- 🔄 进行中：**${doingNow.length}** 项`);
  lines.push(`- 📋 待办：**${todoNow.length}** 项`);
  lines.push(`- ⏰ 本周到期未完成：**${dueThisWeek.length}** 项`);
  lines.push('');

  lines.push('## 二、本周完成明细');
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
    lines.push('（本周暂无完成任务）');
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

  lines.push('## 六、本周到期未完成');
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

  lines.push('## 七、下周计划建议');
  lines.push('');
  const nextTodo = all.filter((t) => t.status === 'todo' && t.due)
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
  batchComplete,
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
  listBackups,
  restoreFromBackup,
  backupToDir,
  exportJSON,
  exportCSV,
  generateWeeklyReport
};
