'use strict';

/* ============================================================
 * 渲染进程主逻辑 - 工作台助手
 * 视图：今日 / 所有任务 / 看板 / 日历 / 统计 / 设置
 * 右侧：AI 助手面板
 * ============================================================ */

/* ---------- 状态 ---------- */
let tasks = [];
let settings = {};
let currentView = 'today';
let currentFilter = 'all';
let currentSearch = '';
let editingTask = null; // 正在编辑的任务（null = 新建）
let calCursor = new Date();
calCursor.setDate(1);
let calSelected = null;
let statInited = false;
let selectedIds = new Set(); // 批量选择
let expandedIds = new Set(); // 展开的子任务
let trashList = []; // 回收站列表
let reportWeek = 0; // 周报选择的周（0=本周, -1=上周, 1=下周）

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const PRI_NAME = { 4: '紧急', 3: '高', 2: '中', 1: '低' };
const STATE_NAME = { todo: '待办', doing: '进行中', done: '已完成', archived: '已归档' };
const STATE_NEXT = { todo: 'doing', doing: 'done', done: 'todo' };

function isOverdue(due, status) {
  if (!due || status === 'done' || status === 'archived') return false;
  return new Date(due.replace(' ', 'T') + ':00') < new Date();
}
function isToday(due) {
  if (!due) return false;
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return due.startsWith(key);
}
/* 本地日期键 YYYY-MM-DD（避免 toISOString 的 UTC 时区偏移导致跨天统计错误） */
function localDateKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------- Toast ---------- */
function toast(html, ms, actions, type) {
  const layer = $('#toast-layer');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' t-' + type : '');
  const icons = { ok: '✓', err: '✕', warn: '⚠' };
  el.innerHTML = (icons[type] ? `<span class="t-ico">${icons[type]}</span>` : '') + `<span>${html}</span>`;
  if (actions) {
    actions.forEach((a) => {
      const b = document.createElement('span');
      b.className = 't-undo';
      b.textContent = a.label;
      b.addEventListener('click', () => { a.run(); el.remove(); });
      el.appendChild(b);
    });
  }
  layer.appendChild(el);
  setTimeout(() => el.remove(), ms || 3000);
}

/* ---------- 统一确认框 ---------- */
function confirmDialog(message, onOk, okText) {
  const mask = $('#confirm-mask');
  const text = $('#confirm-text');
  const okBtn = $('#confirm-ok');
  const cancelBtn = $('#confirm-cancel');
  text.textContent = message;
  okBtn.textContent = okText || '删除';
  mask.classList.remove('hidden');
  const onOkClick = () => { cleanup(); onOk(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { cleanup(); }
    if (e.key === 'Enter') { onOkClick(); }
  };
  function cleanup() {
    mask.classList.add('hidden');
    cancelBtn.removeEventListener('click', cleanup);
    okBtn.removeEventListener('click', onOkClick);
    document.removeEventListener('keydown', onKey);
  }
  cancelBtn.addEventListener('click', cleanup);
  okBtn.addEventListener('click', onOkClick);
  document.addEventListener('keydown', onKey);
  // 焦点交给「取消」（默认安全选项），避免误触破坏性操作
  cancelBtn.focus();
}

/* ---------- 任务行渲染 ---------- */
function childProgress(t) {
  if (!t.children || !t.children.length) return null;
  const total = t.children.length;
  const done = t.children.filter((c) => c && typeof c === 'object' && c.done).length;
  return { done, total };
}

function childLabel(c) {
  if (typeof c === 'string') return { title: c, done: false, id: null };
  return { title: (c && c.title) || '', done: !!(c && c.done), id: (c && c.id) || null };
}

function rowHTML(t) {
  const sub = [];
  const cp = childProgress(t);
  if (cp) {
    sub.push(`子任务 ${cp.done}/${cp.total}`);
  }
  if (t.desc) sub.push(esc(t.desc));
  if (t.tags && t.tags.length) sub.push(t.tags.map((x) => `<span class="tag-chip">#${esc(x)}</span>`).join(' '));
  if (t.project) sub.push(`<span class="proj-chip">◈ ${esc(t.project)}</span>`);
  const dueHtml = t.due
    ? `<span class="tdue${isOverdue(t.due, t.status) ? ' over' : ''}" title="${esc(t.due)}">${esc(relDue(t.due))}</span>`
    : '';
  const check = t.status === 'done' ? '✓' : '';
  const selected = selectedIds.has(t.id) ? ' sel' : '';
  const hasChildren = t.children && t.children.length;
  const expanded = expandedIds.has(t.id);
  const repeatTag = t.repeat ? `<span class="repeat-chip">↻ ${t.repeat === 'daily' ? '每天' : t.repeat === 'weekly' ? '每周' : '每月'}</span>` : '';
  // 完成时间
  const doneTime = t.status === 'done' && t.completedAt
    ? `<span class="done-time" title="完成时间">✓ ${fmtTime(t.completedAt)}</span>`
    : '';
  // 搜索高亮
  const titleHtml = currentSearch
    ? highlightText(esc(t.title), currentSearch)
    : esc(t.title);
  // 过期背景
  const overdueCls = isOverdue(t.due, t.status) ? ' overdue-row' : '';
  // hover 快捷操作
  const quickActions = t.status === 'archived'
    ? `<span class="row-actions"><span class="ra" data-act="unarchive" title="恢复">↩</span><span class="ra" data-act="delete" title="删除">🗑</span></span>`
    : `<span class="row-actions"><span class="ra" data-act="edit" title="编辑">✎</span><span class="ra" data-act="copy" title="复制">⧉</span><span class="ra" data-act="archive" title="归档">📦</span><span class="ra danger" data-act="delete" title="删除">🗑</span></span>`;
  // 详情展开区
  const detailOpen = expandedIds.has('d' + t.id);
  const detailHtml = detailOpen ? `<div class="task-detail">
    ${t.desc ? `<div class="td-row"><span class="td-label">描述</span><span class="td-val">${esc(t.desc)}</span></div>` : ''}
    ${t.project ? `<div class="td-row"><span class="td-label">项目</span><span class="td-val">◈ ${esc(t.project)}</span></div>` : ''}
    ${t.tags && t.tags.length ? `<div class="td-row"><span class="td-label">标签</span><span class="td-val">${t.tags.map((x) => `<span class="tag-chip">#${esc(x)}</span>`).join(' ')}</span></div>` : ''}
    ${t.repeat ? `<div class="td-row"><span class="td-label">重复</span><span class="td-val">${t.repeat === 'daily' ? '每天' : t.repeat === 'weekly' ? '每周' : '每月'}</span></div>` : ''}
    ${t.remind ? `<div class="td-row"><span class="td-label">提醒</span><span class="td-val">提前 ${t.remind} 分钟</span></div>` : ''}
    <div class="td-row"><span class="td-label">创建</span><span class="td-val">${fmtTime(t.createdAt)}</span></div>
    ${t.status === 'done' && t.completedAt ? `<div class="td-row"><span class="td-label">完成</span><span class="td-val">${fmtTime(t.completedAt)}</span></div>` : ''}
  </div>` : '';
  return `<div class="task-row${t.status === 'done' ? ' done' : ''}${t.status === 'archived' ? ' archived' : ''}${selected}${overdueCls}" data-id="${t.id}" draggable="true">
    <span class="task-check" title="完成">${check}</span>
    <span class="pri-dot p${t.pri}" title="点击切换优先级（当前：${PRI_NAME[t.pri]}）" data-pri-toggle>${PRI_NAME[t.pri]}</span>
    ${hasChildren ? `<span class="task-expand${expanded ? ' open' : ''}" title="展开子任务">▸</span>` : ''}
    <div class="task-main">
      <div class="tname">${titleHtml}</div>
      ${sub.length ? `<div class="tsub">${sub.join(' · ')}</div>` : ''}
      ${hasChildren && expanded ? `<div class="child-list">${t.children.map((c) => {
        const x = childLabel(c);
        return `<div class="child-item${x.done ? ' done' : ''}" data-child-id="${x.id}" data-parent-id="${t.id}">
          <span class="child-check">${x.done ? '✓' : ''}</span>
          <span class="child-title">${esc(x.title)}</span>
        </div>`;
      }).join('')}</div>` : ''}
      ${detailHtml}
    </div>
    <div class="task-meta">
      ${repeatTag}
      ${dueHtml}
      ${doneTime}
      <span class="statectl s-${t.status}" title="点击流转状态">${STATE_NAME[t.status]}</span>
      ${quickActions}
    </div>
  </div>`;
}

/* 格式化时间戳为 MM-DD HH:mm */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 相对时间显示：今天 18:00 / 明天 / 3 天后 */
function relDue(due) {
  if (!due) return '';
  const d = new Date(due.replace(' ', 'T') + ':00');
  if (isNaN(d.getTime())) return due;
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dueKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dueKey === todayKey) return `今天 ${timeStr}`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  if (dueKey === tomorrowKey) return `明天 ${timeStr}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
  if (dueKey === yesterdayKey) return `昨天 ${timeStr}`;
  // 计算天数差
  const diffDays = Math.round((d.setHours(0, 0, 0, 0) - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  if (diffDays > 0 && diffDays <= 7) return `${diffDays} 天后 ${timeStr}`;
  if (diffDays < 0 && diffDays >= -7) return `${-diffDays} 天前 ${timeStr}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${timeStr}`;
}

/* 搜索关键词高亮（text 已转义） */
function highlightText(text, query) {
  const q = String(query || '').trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return text.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark>$1</mark>');
  } catch (e) {
    return text;
  }
}

function renderList(container, list) {
  container.innerHTML = '';
  if (!list.length) {
    // 空状态 = 指引时刻：说明现状 + 给出下一步动作
    const emptyStates = {
      today: { ico: '🌤', title: '今天没有到期任务', hint: '享受一段不被打扰的专注时间，或现在就安排下一件要紧事。' },
      all: { ico: '◔', title: '还没有任务', hint: '从一句话开始：在下方输入框回车，或让 AI 助手帮你记下第一件事。' },
      active: { ico: '🌱', title: '没有未完成的任务', hint: '手头的事都清了，可以放心收工。' },
      done: { ico: '🎉', title: '还没有已完成的任务', hint: '完成一件任务后，它会出现在这里。' },
      archived: { ico: '📦', title: '没有已归档的任务', hint: '归档的任务会收在这里，随时可恢复。' },
      nodate: { ico: '🗓', title: '所有任务都设了截止日期', hint: '没有遗漏的"无日期"任务。' },
      overdue: { ico: '✨', title: '没有过期任务', hint: '一切都在计划内，继续保持。' },
      week: { ico: '📅', title: '本周没有新任务', hint: '这周很安静，可以专注在已有的事项上。' }
    };
    const key = currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:') ? 'all' : currentFilter;
    const st = emptyStates[key] || emptyStates.all;
    const showBtn = currentFilter === 'all' || currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:');
    container.innerHTML = `<div class="empty">
      <div class="big">${st.ico}</div>
      <div class="empty-title">${st.title}</div>
      <p class="empty-hint">${st.hint}</p>
      ${showBtn ? '<button class="btn mini empty-cta" id="empty-new-task">新建任务</button>' : ''}
    </div>`;
    const cta = container.querySelector('#empty-new-task');
    if (cta) cta.addEventListener('click', () => openModal(null));
    return;
  }
  list.forEach((t) => container.insertAdjacentHTML('beforeend', rowHTML(t)));
}

/* ---------- 视图：今日 ---------- */
function renderToday() {
  const all = tasks.filter((t) => !t._deleted);
  const overdue = all.filter((t) => t.status !== 'done' && t.status !== 'archived' && isOverdue(t.due, t.status));
  const todays = all.filter((t) => t.status !== 'done' && t.status !== 'archived' && isToday(t.due) && !isOverdue(t.due, t.status));
  // 今日完成：按 completedAt 统计
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const doneToday = all.filter((t) => t.status === 'done' && t.completedAt && localDateKey(t.completedAt) === todayKey);
  overdue.sort((a, b) => b.pri - a.pri);
  todays.sort((a, b) => b.pri - a.pri);

  // 今日日期标题
  const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
  const dateTitle = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${weekNames[now.getDay()]}`;
  $('#today-date').textContent = dateTitle;

  let html = '';
  if (overdue.length) {
    html += `<div class="today-group" style="font-size:12px;font-weight:700;color:var(--danger);margin:10px 0 6px">已过期 ${overdue.length}</div>`;
    html += overdue.map((t) => rowHTML(t) + `<div class="overdue-actions" data-id="${t.id}"><button class="btn mini" data-postpone="1">顺延到明天</button><button class="btn mini ghost" data-postpone="7">顺延一周</button></div>`).join('');
  }
  if (todays.length) {
    html += `<div class="today-group" style="font-size:12px;font-weight:700;color:var(--accent);margin:10px 0 6px">今天到期 ${todays.length}</div>`;
    html += todays.map(rowHTML).join('');
  }
  if (!html) {
    html = '<div class="empty"><div class="big">🌤</div>今天没有到期任务，享受专注时间</div>';
  }
  $('#today-list').innerHTML = html;
  $('#today-sub').textContent = `${overdue.length} 过期 · ${todays.length} 今天 · 今日完成 ${doneToday.length}`;
}

/* ---------- 视图：所有任务 ---------- */
function renderTasks() {
  let list = tasks.filter((t) => !t._deleted);
  // 搜索：标题/描述/标签/项目关键词
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    list = list.filter((t) =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.desc || '').toLowerCase().includes(q) ||
      (t.tags || []).some((x) => x.toLowerCase().includes(q)) ||
      (t.project || '').toLowerCase().includes(q)
    );
  }
  if (currentFilter === 'today') list = list.filter((t) => isToday(t.due));
  if (currentFilter === 'active') list = list.filter((t) => t.status !== 'done' && t.status !== 'archived');
  if (currentFilter === 'done') list = list.filter((t) => t.status === 'done');
  if (currentFilter === 'archived') list = list.filter((t) => t.status === 'archived');
  // 智能列表
  if (currentFilter === 'nodate') list = list.filter((t) => !t.due && t.status !== 'done' && t.status !== 'archived');
  if (currentFilter === 'overdue') list = list.filter((t) => t.status !== 'done' && t.status !== 'archived' && isOverdue(t.due, t.status));
  if (currentFilter === 'week') {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    list = list.filter((t) => t.createdAt >= weekAgo.getTime() && t.status !== 'archived');
  }
  // 项目/标签筛选
  if (currentFilter.startsWith('proj:')) {
    const proj = currentFilter.slice(5);
    list = list.filter((t) => (t.project || '') === proj);
  }
  if (currentFilter.startsWith('tag:')) {
    const tag = currentFilter.slice(4);
    list = list.filter((t) => (t.tags || []).includes(tag));
  }
  // 排序：手动 order 优先，其次按状态/优先级
  list.sort((a, b) => {
    if (a.status === 'archived' && b.status !== 'archived') return 1;
    if (a.status !== 'archived' && b.status === 'archived') return -1;
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    if (currentFilter === 'all' || currentFilter === 'active') {
      const oa = a.order != null ? a.order : 0;
      const ob = b.order != null ? b.order : 0;
      if (oa !== ob) return oa - ob;
    }
    return b.pri - a.pri;
  });
  renderList($('#tasks-list'), list);
  const done = tasks.filter((t) => !t._deleted && t.status === 'done').length;
  const total = tasks.filter((t) => !t._deleted && t.status !== 'archived').length;
  $('#tasks-sub').textContent = `完成 ${done} / ${total}${currentSearch ? ' · 搜索：' + currentSearch : ''}`;
  renderBatchBar();
  renderSmartFilters();
}

/* ---------- 智能筛选条 ---------- */
function renderSmartFilters() {
  const wrap = $('#smart-filters');
  if (!wrap) return;
  const smart = [
    { k: 'all', n: '全部' },
    { k: 'active', n: '未完成' },
    { k: 'today', n: '今天' },
    { k: 'overdue', n: '已过期' },
    { k: 'week', n: '本周' },
    { k: 'nodate', n: '无日期' },
    { k: 'done', n: '已完成' },
    { k: 'archived', n: '已归档' }
  ];
  // 项目列表
  const projs = [...new Set(tasks.filter((t) => !t._deleted && t.project).map((t) => t.project))].slice(0, 8);
  // 标签列表
  const tagSet = new Set();
  tasks.filter((t) => !t._deleted).forEach((t) => (t.tags || []).forEach((x) => tagSet.add(x)));
  const tags = [...tagSet].slice(0, 8);

  let html = `<div class="smart-row">
    ${smart.map((s) => `<span class="fchip ${currentFilter === s.k ? 'active' : ''}" data-filter="${s.k}">${s.n}</span>`).join('')}
  </div>`;
  if (projs.length) {
    html += `<div class="smart-row smart-sub">
      <span class="smart-label">项目</span>
      ${projs.map((p) => `<span class="fchip ${currentFilter === 'proj:' + p ? 'active' : ''}" data-filter="proj:${esc(p)}">◈ ${esc(p)}</span>`).join('')}
    </div>`;
  }
  if (tags.length) {
    html += `<div class="smart-row smart-sub">
      <span class="smart-label">标签</span>
      ${tags.map((t) => `<span class="fchip ${currentFilter === 'tag:' + t ? 'active' : ''}" data-filter="tag:${esc(t)}">#${esc(t)}</span>`).join('')}
    </div>`;
  }
  wrap.innerHTML = html;
  // 绑定事件
  $$('#smart-filters .fchip').forEach((c) => {
    c.addEventListener('click', () => {
      $$('#smart-filters .fchip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      currentFilter = c.dataset.filter;
      renderTasks();
    });
  });
}

/* ---------- 批量操作栏 ---------- */
function renderBatchBar() {
  const bar = $('#batch-bar');
  if (!bar) return;
  if (selectedIds.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('#batch-count').textContent = `已选 ${selectedIds.size} 项`;
}

/* ---------- 视图：看板 ---------- */
function renderBoard() {
  const cols = [
    { k: 'todo', name: '待办' },
    { k: 'doing', name: '进行中' },
    { k: 'done', name: '已完成' }
  ];
  let html = '<div class="board-cols">';
  cols.forEach((col) => {
    const cards = tasks.filter((t) => !t._deleted && t.status === col.k)
      .sort((a, b) => b.pri - a.pri);
    html += `<div class="board-col" data-col="${col.k}">
      <div class="bc-head">${col.name} <span class="n">${cards.length}</span></div>
      <div class="bc-cards">
        ${cards.map((t) => `
          <div class="bc-card" draggable="true" data-id="${t.id}" title="点击编辑">
            <div class="cb"><span class="nm">${esc(t.title)}</span><span class="pri-dot p${t.pri}">${PRI_NAME[t.pri]}</span></div>
            ${t.due ? `<div class="cd${isOverdue(t.due, t.status) ? ' over' : ''}">${esc(t.due)}</div>` : ''}
            ${t.tags && t.tags.length ? `<div class="cd">${t.tags.map((x) => '#' + esc(x)).join(' ')}</div>` : ''}
            ${t.children && t.children.length ? `<div class="cd">子任务 ${childProgress(t).done}/${t.children.length}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
  });
  html += '</div>';
  $('#board-cols').innerHTML = html;
}

/* ---------- 视图：日历 ---------- */
function calKey(d) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function tasksOnDay(key) {
  return tasks.filter((t) => !t._deleted && t.due && t.due.slice(0, 10) === key);
}
function renderCal() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayKey = calKey(new Date());
  const cells = [];

  for (let i = startDow - 1; i >= 0; i--) {
    const pd = prevDays - i;
    const d = new Date(y, m - 1, pd);
    cells.push({ key: calKey(d), day: pd, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m, d);
    cells.push({ key: calKey(dt), day: d, other: false });
  }
  let total = cells.length;
  const trailing = (7 - (total % 7)) % 7;
  for (let j = 1; j <= trailing; j++) {
    const dt = new Date(y, m + 1, j);
    cells.push({ key: calKey(dt), day: j, other: true });
  }

  let html = `<div class="cal-head">
    <div class="cal-nav">
      <button class="cal-btn" data-cal="prev">‹</button>
      <button class="cal-btn" data-cal="today">今</button>
      <button class="cal-btn" data-cal="next">›</button>
    </div>
    <span class="cal-title">${y} 年 ${m + 1} 月</span>
  </div>
  <div class="cal-grid">
    ${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<div class="cal-dow">${w}</div>`).join('')}`;

  cells.forEach((c) => {
    const dayTasks = tasksOnDay(c.key);
    const cls = ['cal-cell', c.other ? 'other' : '', c.key === todayKey ? 'today' : '', calSelected === c.key ? 'selected' : ''].filter(Boolean).join(' ');
    const dots = dayTasks.map((t) => {
      const dotCls = t.status === 'done' ? 'done' : (isOverdue(t.due, t.status) ? 'over' : '');
      return `<span class="cal-dot ${dotCls}" title="${esc(t.title)}"></span>`;
    }).join('');
    html += `<div class="${cls}" data-day="${c.key}">
      <span class="cal-day">${c.day}</span>
      ${dayTasks.length ? `<span class="cal-num">${dayTasks.length}</span>` : ''}
      ${dots ? `<div class="cal-dots">${dots}</div>` : ''}
    </div>`;
  });
  html += '</div>';

  if (calSelected) {
    const selTasks = tasksOnDay(calSelected);
    html += `<div class="cal-detail"><div class="cd-title">${calSelected} 的任务（${selTasks.length}）</div>`;
    html += `<div class="cal-add-row"><button class="btn mini" id="cal-add-task">＋ 在该天新建任务</button></div>`;
    html += selTasks.length ? selTasks.map(rowHTML).join('') : '<div class="empty" style="padding:16px 0"><div class="big">🌤</div>当天没有到期任务</div>';
    html += '</div>';
  }

  $('#cal-body').innerHTML = html;
  $('#cal-sub').textContent = calSelected ? `${calSelected} 明细` : `${m + 1} 月 · ${daysInMonth} 天`;
}

/* ---------- 视图：统计 ---------- */
function renderStat() {
  const all = tasks.filter((t) => !t._deleted && t.status !== 'archived');
  const done = all.filter((t) => t.status === 'done').length;
  const doing = all.filter((t) => t.status === 'doing').length;
  const rate = all.length ? Math.round(done / all.length * 100) + '%' : '0%';

  let html = `<div class="stat-grid">
    <div class="stat-card"><div class="sc-t">任务总数</div><div class="sc-v">${all.length}</div></div>
    <div class="stat-card"><div class="sc-t">已完成</div><div class="sc-v">${done}</div></div>
    <div class="stat-card"><div class="sc-t">进行中</div><div class="sc-v">${doing}</div></div>
    <div class="stat-card"><div class="sc-t">完成率</div><div class="sc-v">${rate}</div></div>
  </div>`;

  // 近 7 天完成趋势（按真实 completedAt 统计）
  const days = [];
  const dayKeys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    dayKeys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    days.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  const trend = dayKeys.map((key) =>
    all.filter((t) => t.status === 'done' && t.completedAt && localDateKey(t.completedAt) === key).length
  );
  const maxTrend = Math.max(1, ...trend);
  html += `<div class="stat-chart-row">
    <div>
      <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">近 7 天完成趋势</div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:160px;padding:0 4px">
        ${trend.map((v, i) => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
            <span style="font-size:11px;color:var(--muted)">${v}</span>
            <div style="width:100%;background:linear-gradient(180deg,#E8743B,#F0A04B);border-radius:4px 4px 0 0;height:${Math.max(4, v / maxTrend * 120)}px;opacity:${0.4 + i * 0.08}"></div>
            <span style="font-size:10px;color:var(--muted)">${days[i]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div>
      <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">优先级分布</div>
      <div style="display:flex;flex-direction:column;gap:8px;padding:8px 4px">
        ${[4, 3, 2, 1].map((p) => {
          const n = all.filter((t) => t.pri === p).length;
          const pct = all.length ? Math.round(n / all.length * 100) : 0;
          const colors = { 4: '#C4453B', 3: '#C78A2B', 2: '#E8743B', 1: '#B0A492' };
          return `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
            <span style="flex:0 0 56px;color:var(--muted)">${PRI_NAME[p]}</span>
            <div style="flex:1;height:14px;border-radius:999px;background:rgba(232,116,59,0.08);overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${colors[p]};border-radius:999px"></div>
            </div>
            <span style="flex:0 0 24px;font-family:Consolas,monospace;font-size:11px;color:var(--muted)">${n}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;

  // 标签排行
  const tagAcc = {};
  all.forEach((t) => (t.tags || []).forEach((tag) => { tagAcc[tag] = (tagAcc[tag] || 0) + 1; }));
  const tagRank = Object.keys(tagAcc).map((k) => ({ name: k, count: tagAcc[k] }))
    .sort((a, b) => b.count - a.count).slice(0, 8);
  if (tagRank.length) {
    const maxTag = tagRank[0].count;
    html += `<div class="tag-rank"><div class="tr-title">标签使用频率排行</div>`;
    tagRank.forEach((d) => {
      const pct = Math.max(4, Math.round(d.count / maxTag * 100));
      html += `<div class="tr-bar"><span class="tr-name">#${esc(d.name)}</span>
        <span class="tr-track"><span class="tr-fill" style="width:${pct}%"></span></span>
        <span class="tr-count">${d.count}</span></div>`;
    });
    html += '</div>';
  }

  // 项目完成率对比
  const projAcc = {};
  all.forEach((t) => {
    const p = t.project || '未分类';
    if (!projAcc[p]) projAcc[p] = { total: 0, done: 0 };
    projAcc[p].total++;
    if (t.status === 'done') projAcc[p].done++;
  });
  const projRank = Object.keys(projAcc).map((k) => ({ name: k, ...projAcc[k] }))
    .sort((a, b) => b.total - a.total).slice(0, 6);
  if (projRank.length) {
    html += `<div class="stat-chart-row" style="margin-top:14px">
      <div>
        <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">项目完成率</div>
        <div style="display:flex;flex-direction:column;gap:8px;padding:8px 4px">
          ${projRank.map((d) => {
            const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
            return `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <span style="flex:0 0 90px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">◈ ${esc(d.name)}</span>
              <div style="flex:1;height:14px;border-radius:999px;background:rgba(232,116,59,0.08);overflow:hidden">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#E8743B,#F0A04B);border-radius:999px"></div>
              </div>
              <span style="flex:0 0 64px;font-family:Consolas,monospace;font-size:11px;color:var(--muted)">${d.done}/${d.total} ${pct}%</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">标签完成率</div>
        <div style="display:flex;flex-direction:column;gap:8px;padding:8px 4px">
          ${tagRank.slice(0, 6).map((d) => {
            const tagged = all.filter((t) => (t.tags || []).includes(d.name));
            const doneN = tagged.filter((t) => t.status === 'done').length;
            const pct = tagged.length ? Math.round(doneN / tagged.length * 100) : 0;
            return `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <span style="flex:0 0 90px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">#${esc(d.name)}</span>
              <div style="flex:1;height:14px;border-radius:999px;background:rgba(199,138,43,0.08);overflow:hidden">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#C78A2B,#E8743B);border-radius:999px"></div>
              </div>
              <span style="flex:0 0 64px;font-family:Consolas,monospace;font-size:11px;color:var(--muted)">${doneN}/${tagged.length} ${pct}%</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>`;
  }

  // 周报生成
  html += `<div class="stat-chart-row" style="margin-top:14px">
    <div style="flex:1">
      <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">📄 周报生成</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="seg" id="report-week-seg">
          <span class="seg-it ${reportWeek === -1 ? 'active' : ''}" data-week="-1">上周</span>
          <span class="seg-it ${reportWeek === 0 ? 'active' : ''}" data-week="0">本周</span>
          <span class="seg-it ${reportWeek === 1 ? 'active' : ''}" data-week="1">下周</span>
        </div>
        <button class="btn mini" id="btn-report-gen">生成周报</button>
        <button class="btn mini" id="btn-report-copy" style="display:none">复制</button>
        <button class="btn mini" id="btn-report-download" style="display:none">下载 .md</button>
      </div>
      <div id="report-preview" style="margin-top:10px;max-height:320px;overflow:auto;background:rgba(0,0,0,0.03);border-radius:10px;padding:12px;font-size:12px;line-height:1.6;white-space:pre-wrap;font-family:Consolas,monospace;color:var(--ink);display:none"></div>
    </div>
  </div>`;

  $('#stat-body').innerHTML = html;

  // 周报：选择周
  $$('#report-week-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', () => {
      $$('#report-week-seg .seg-it').forEach((x) => x.classList.remove('active'));
      seg.classList.add('active');
      reportWeek = parseInt(seg.dataset.week, 10);
    });
  });
  // 周报：生成
  $('#btn-report-gen').addEventListener('click', async () => {
    const preview = $('#report-preview');
    const copyBtn = $('#btn-report-copy');
    const dlBtn = $('#btn-report-download');
    try {
      const md = await window.api.data.weeklyReport(reportWeek);
      preview.textContent = md;
      preview.style.display = 'block';
      copyBtn.style.display = '';
      dlBtn.style.display = '';
      toast('周报已生成');
    } catch (e) {
      toast('周报生成失败：' + e.message);
    }
  });
  // 周报：复制
  $('#btn-report-copy').addEventListener('click', async () => {
    const md = $('#report-preview').textContent;
    try {
      await navigator.clipboard.writeText(md);
      toast('周报已复制到剪贴板', 2000, null, 'ok');
    } catch (e) {
      toast('复制失败，请手动选择复制');
    }
  });
  // 周报：下载 .md
  $('#btn-report-download').addEventListener('click', () => {
    const md = $('#report-preview').textContent;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `工作周报-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    toast('周报已下载');
  });
}

/* ---------- 视图：设置 ---------- */
function renderSettings() {
  const s = settings;
  const sw = (key, label, desc) => `
    <div class="set-row">
      <div><div class="sr-t">${label}</div><div class="sr-d">${desc}</div></div>
      <div class="switch ${s[key] ? 'on' : ''}" data-switch="${key}"></div>
    </div>`;

  const providers = [
    { v: 'openai', n: 'OpenAI' },
    { v: 'deepseek', n: 'DeepSeek' },
    { v: 'opencode-go', n: 'OpenCode Go' },
    { v: 'custom', n: '自定义（OpenAI 兼容）' }
  ];

  let html = `<div class="set-group">
    ${sw('localOnly', '本地存储', '数据仅保存在本机，不经过任何云服务器')}
    ${sw('autoBackup', '自动备份', '每日 22:00 将数据快照备份到备份目录')}
    ${sw('autoStart', '开机自启', '登录系统后后台常驻，不弹主窗口')}
    ${sw('notify', '系统通知提醒', '任务到点经系统通知中心推送')}
    ${sw('petEnabled', '桌面桌宠', '常驻桌面最表层的可爱助手，可拖拽、气泡提醒')}
    <div class="set-row">
      <div><div class="sr-t">本地存储位置</div><div class="sr-d" id="data-dir">${esc(s.dataDir || '')}</div></div>
      <button class="btn mini" id="btn-open-dir">打开目录</button>
      <button class="btn mini" id="btn-pick-dir">更改位置</button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">导出与备份</div><div class="sr-d">导出 .json 备份或 .csv 表格</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn mini" id="btn-export-json">导出 JSON</button>
        <button class="btn mini" id="btn-export-csv">导出 CSV</button>
        <button class="btn mini" id="btn-import-json">导入 JSON</button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">备份管理</div><div class="sr-d">查看自动备份，可一键恢复到任意备份点</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn mini" id="btn-backup-now">立即备份</button>
        <button class="btn mini" id="btn-backup-to-dir">备份到文件夹</button>
        <button class="btn mini" id="btn-restore-file">从文件恢复</button>
      </div>
    </div>
    <div class="backup-list" id="backup-list" style="margin-top:6px"></div>
    <div class="set-row">
      <div><div class="sr-t">外观主题</div><div class="sr-d">浅色 / 深色 / 跟随系统</div></div>
      <div class="seg" id="theme-seg">
        <span class="seg-it ${s.theme === 'light' ? 'active' : ''}" data-theme="light">浅色</span>
        <span class="seg-it ${s.theme === 'dark' ? 'active' : ''}" data-theme="dark">深色</span>
        <span class="seg-it ${s.theme === 'auto' ? 'active' : ''}" data-theme="auto">自动</span>
      </div>
    </div>
  </div>

  <!-- AI 接入配置 -->
  <div class="set-group">
    <div class="set-row">
      <div><div class="sr-t">AI 助手引擎</div><div class="sr-d">模拟 AI（规则引擎）无需配置；接入真实模型后由 LLM 识别意图，规则引擎执行</div></div>
      <div class="seg" id="ai-stage-seg">
        <span class="seg-it ${s.aiStage === 'mock' ? 'active' : ''}" data-stage="mock">模拟 AI</span>
        <span class="seg-it ${s.aiStage === 'llm' ? 'active' : ''}" data-stage="llm">真实模型</span>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">供应商</div><div class="sr-d">选择模型供应商，或自定义 OpenAI 兼容接口</div></div>
      <select id="ai-provider" style="width:auto;min-width:180px">
        ${providers.map((p) => `<option value="${p.v}" ${s.aiProvider === p.v ? 'selected' : ''}>${p.n}</option>`).join('')}
      </select>
    </div>
    <div class="set-row">
      <div><div class="sr-t">API Base URL</div><div class="sr-d">OpenAI 兼容接口地址</div></div>
      <input id="ai-base-url" type="text" placeholder="https://api.openai.com/v1" value="${esc(s.aiBaseUrl || '')}" style="width:auto;min-width:240px">
    </div>
    <div class="set-row">
      <div><div class="sr-t">API Key</div><div class="sr-d">仅保存在本机，不会上传</div></div>
      <input id="ai-api-key" type="password" placeholder="sk-..." value="${esc(s.aiApiKey || '')}" style="width:auto;min-width:240px">
    </div>
    <div class="set-row">
      <div><div class="sr-t">模型名称</div><div class="sr-d">如 gpt-4o-mini / deepseek-chat</div></div>
      <input id="ai-model" type="text" placeholder="gpt-4o-mini" value="${esc(s.aiModel || '')}" style="width:auto;min-width:240px">
    </div>
    <div class="set-row">
      <div><div class="sr-t">温度</div><div class="sr-d">越低越稳定，建议 0.2</div></div>
      <input id="ai-temperature" type="number" min="0" max="2" step="0.1" value="${s.aiTemperature != null ? s.aiTemperature : 0.2}" style="width:auto;min-width:80px">
    </div>
    <div class="set-row">
      <div><div class="sr-t">连接测试</div><div class="sr-d" id="ai-test-result">未测试</div></div>
      <button class="btn mini" id="btn-ai-test">测试连接</button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">保存配置</div><div class="sr-d">保存后 AI 面板将使用所选引擎</div></div>
      <button class="btn mini" id="btn-ai-save">保存 AI 配置</button>
    </div>
  </div>

  <div class="set-group">
    <div class="set-row"><div><div class="sr-t">快捷键</div><div class="sr-d">全局有效，可自定义键位（点击输入框后按新组合键）</div></div></div>
    <div class="shortcut-row"><span>唤起 AI 输入框</span><span><input class="shortcut-input" id="sc-ai" value="${esc(s.shortcuts && s.shortcuts.ai || 'CommandOrControl+J')}" placeholder="Ctrl+J"></span></div>
    <div class="shortcut-row"><span>新建任务</span><span><input class="shortcut-input" id="sc-newTask" value="${esc(s.shortcuts && s.shortcuts.newTask || 'CommandOrControl+N')}" placeholder="Ctrl+N"></span></div>
    <div class="shortcut-row"><span>打开今日视图</span><span><input class="shortcut-input" id="sc-today" value="${esc(s.shortcuts && s.shortcuts.today || 'CommandOrControl+1')}" placeholder="Ctrl+1"></span></div>
    <div class="shortcut-row"><span>打开统计视图</span><span><input class="shortcut-input" id="sc-stat" value="${esc(s.shortcuts && s.shortcuts.stat || 'CommandOrControl+5')}" placeholder="Ctrl+5"></span></div>
  </div>
  <div class="set-group">
    <div class="set-row">
      <div><div class="sr-t">演示数据</div><div class="sr-d">重置为初始演示任务</div></div>
      <button class="btn mini danger" id="btn-reset">重置演示数据</button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">清空全部数据</div><div class="sr-d">删除所有任务（含已完成与归档），不可恢复</div></div>
      <button class="btn mini danger" id="btn-clear-all">清空全部</button>
    </div>
  </div>`;

  $('#settings-body').innerHTML = html;
  bindSettingsEvents();
}

function bindSettingsEvents() {
  $$('#settings-body .switch[data-switch]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const on = sw.classList.toggle('on');
      const key = sw.dataset.switch;
      settings[key] = on;
      await window.api.settings.update({ [key]: on });
      const names = { localOnly: '本地存储', autoBackup: '自动备份', autoStart: '开机自启', notify: '系统通知提醒', petEnabled: '桌面桌宠' };
      toast(`已${on ? '开启' : '关闭'}「${names[key]}」`);
    });
  });

  // AI 引擎切换
  $$('#ai-stage-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', async () => {
      $$('#ai-stage-seg .seg-it').forEach((x) => x.classList.remove('active'));
      seg.classList.add('active');
      settings.aiStage = seg.dataset.stage;
      await window.api.settings.update({ aiStage: seg.dataset.stage });
      updateAiBadge();
      toast(`AI 引擎已切换为「${seg.textContent}」`);
    });
  });

  // 供应商切换时自动填充默认 Base URL 和模型
  $('#ai-provider').addEventListener('change', async () => {
    const v = $('#ai-provider').value;
    const defaults = {
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      'opencode-go': { baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash' },
      custom: { baseUrl: '', model: '' }
    };
    const d = defaults[v];
    if (d) {
      $('#ai-base-url').value = d.baseUrl;
      if (d.model) $('#ai-model').value = d.model;
    }
  });

  // 测试连接
  $('#btn-ai-test').addEventListener('click', async () => {
    const resultEl = $('#ai-test-result');
    resultEl.textContent = '测试中…';
    resultEl.style.color = 'var(--muted)';
    // 先保存当前输入到设置，再测试
    await saveAiConfig(false);
    const res = await window.api.ai.test();
    resultEl.textContent = res.message;
    resultEl.style.color = res.ok ? 'var(--ok)' : 'var(--danger)';
  });

  // 保存 AI 配置
  $('#btn-ai-save').addEventListener('click', async () => {
    await saveAiConfig(true);
  });

  async function saveAiConfig(showToast) {
    const patch = {
      aiProvider: $('#ai-provider').value,
      aiBaseUrl: $('#ai-base-url').value.trim(),
      // 清理 API Key 中的所有空白字符（粘贴时常带换行/空格）
      aiApiKey: $('#ai-api-key').value.replace(/\s+/g, '').trim(),
      aiModel: $('#ai-model').value.trim(),
      aiTemperature: parseFloat($('#ai-temperature').value) || 0.2
    };
    settings = Object.assign({}, settings, patch);
    await window.api.settings.update(patch);
    if (showToast) toast('AI 配置已保存');
    updateAiBadge();
  }

  $('#btn-export-json').addEventListener('click', async () => {
    const json = await window.api.data.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `work-helper-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast('已导出 JSON 备份');
  });
  $('#btn-export-csv').addEventListener('click', async () => {
    const csv = await window.api.data.exportCSV();
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `work-helper-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast('已导出 CSV 表格');
  });
  $('#btn-open-dir').addEventListener('click', async () => {
    const dir = await window.api.data.getDir();
    toast(`数据目录：${dir}`);
  });
  $('#btn-pick-dir').addEventListener('click', async () => {
    const res = await window.api.data.pickDir();
    if (res.ok) {
      toast(`已选择新数据目录：${res.dir}（重启后生效）`);
    }
  });
  $('#btn-import-json').addEventListener('click', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : (data.tasks || []);
        if (!list.length) { toast('导入文件为空或格式不正确'); return; }
        const imported = await window.api.tasks.import(list);
        await refreshTasks();
        toast(`已导入 ${imported.length} 条任务`);
      } catch (e) {
        toast('导入失败：' + e.message);
      }
    });
    input.click();
  });

  // 备份管理
  async function loadBackupList() {
    const box = $('#backup-list');
    if (!box) return;
    try {
      const list = await window.api.data.listBackups();
      if (!list.length) {
        box.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 2px">暂无备份，点击「立即备份」创建第一份</div>';
        return;
      }
      box.innerHTML = list.map((b) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:rgba(232,116,59,0.06);margin-bottom:4px;font-size:12px">
          <span style="flex:1;color:var(--muted);font-family:Consolas,monospace">${esc(b.time || b.name)}</span>
          <span style="color:var(--muted)">${(b.size / 1024).toFixed(1)} KB</span>
          <button class="btn mini" data-restore="${esc(b.path)}">恢复</button>
        </div>`).join('');
      box.querySelectorAll('[data-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const filePath = btn.dataset.restore;
          confirmDialog('确定要恢复到该备份点吗？当前数据会先自动备份，然后被该备份覆盖。', async () => {
            try {
              const res = await window.api.data.restoreBackup(filePath);
              if (res.ok) {
                tasks = await window.api.tasks.getAll();
                renderAll();
                toast(`已恢复到备份点（${res.count} 条任务）`, 3000, null, 'ok');
              }
            } catch (e) {
              toast('恢复失败：' + e.message);
            }
          }, '恢复');
        });
      });
    } catch (e) {
      box.innerHTML = '<div style="font-size:12px;color:var(--danger)">备份列表加载失败</div>';
    }
  }

  $('#btn-backup-now').addEventListener('click', async () => {
    try {
      await window.api.data.backup();
      toast('已创建备份');
      loadBackupList();
    } catch (e) {
      toast('备份失败：' + e.message);
    }
  });
  $('#btn-backup-to-dir').addEventListener('click', async () => {
    const res = await window.api.data.backupToDir();
    if (res.ok) toast(`已备份到：${res.file}`, 4000, null, 'ok');
    else if (res.error) toast('备份失败：' + res.error);
  });
  $('#btn-restore-file').addEventListener('click', async () => {
    const res = await window.api.data.pickBackupFile();
    if (!res.ok) return;
    confirmDialog('确定要从该文件恢复吗？当前数据会先自动备份，然后被该文件覆盖。', async () => {
      try {
        const r = await window.api.data.restoreBackup(res.file);
        if (r.ok) {
          tasks = await window.api.tasks.getAll();
          renderAll();
          toast(`已从文件恢复（${r.count} 条任务）`, 3000, null, 'ok');
        }
      } catch (e) {
        toast('恢复失败：' + e.message);
      }
    }, '恢复');
  });
  loadBackupList();
  $$('#theme-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', async () => {
      $$('#theme-seg .seg-it').forEach((x) => x.classList.remove('active'));
      seg.classList.add('active');
      settings.theme = seg.dataset.theme;
      await window.api.settings.update({ theme: seg.dataset.theme });
      applyTheme();
      toast(`主题已切换为「${seg.textContent}」`);
    });
  });
  $('#btn-reset').addEventListener('click', async () => {
    tasks = await window.api.tasks.reset();
    renderAll();
    toast('演示数据已重置');
  });
  $('#btn-clear-all').addEventListener('click', async () => {
    confirmDialog('确定要清空全部任务数据吗？此操作不可恢复！', async () => {
      tasks = await window.api.tasks.clearAll();
      renderAll();
      toast('已清空全部任务数据', 3000, null, 'ok');
    }, '清空');
  });

  // 快捷键自定义：点击输入框后按新组合键
  ['sc-ai', 'sc-newTask', 'sc-today', 'sc-stat'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('focus', () => {
      el.value = '';
      el.placeholder = '按下新组合键…';
    });
    el.addEventListener('keydown', async (e) => {
      e.preventDefault();
      const mods = [];
      if (e.ctrlKey) mods.push('CommandOrControl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!mods.length) { el.value = ''; el.placeholder = '需要包含修饰键（Ctrl/Alt/Shift）'; return; }
      const combo = [...mods, key].join('+');
      el.value = combo;
      el.placeholder = 'Ctrl+J';
      const keyMap = { 'sc-ai': 'ai', 'sc-newTask': 'newTask', 'sc-today': 'today', 'sc-stat': 'stat' };
      const shortcuts = Object.assign({}, settings.shortcuts || {}, { [keyMap[id]]: combo });
      settings.shortcuts = shortcuts;
      await window.api.settings.update({ shortcuts });
      toast(`快捷键已更新：${combo}`);
      el.blur();
    });
  });
}

function applyTheme() {
  const t = settings.theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
}

/* ---------- 视图切换 ---------- */
function switchView(view) {
  currentView = view;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach((v) => { v.style.display = v.id === `view-${view}` ? '' : 'none'; });
  // 切换视图时清除批量选择并隐藏批量栏
  selectedIds.clear();
  const batchBar = $('#batch-bar');
  if (batchBar) batchBar.classList.add('hidden');
  // 视图切换动画
  const activeView = document.getElementById(`view-${view}`);
  if (activeView) {
    activeView.classList.remove('view-enter');
    void activeView.offsetWidth;
    activeView.classList.add('view-enter');
  }
  // 标题栏显示当前视图名
  const viewNames = { today: '今天', tasks: '所有任务', board: '看板', cal: '日历', stat: '统计', trash: '回收站', settings: '设置' };
  const tbTitle = $('#tb-title');
  if (tbTitle) tbTitle.textContent = `工作台助手 · ${viewNames[view] || ''}`;
  if (view === 'today') renderToday();
  if (view === 'tasks') renderTasks();
  if (view === 'board') renderBoard();
  if (view === 'cal') renderCal();
  if (view === 'stat') renderStat();
  if (view === 'settings') renderSettings();
  if (view === 'trash') loadTrash();
}

/* ---------- 侧边栏计数徽标 ---------- */
function renderNavBadges() {
  const active = tasks.filter((t) => !t._deleted && t.status !== 'done' && t.status !== 'archived').length;
  const trashCount = trashList.length;
  const todayCount = tasks.filter((t) => !t._deleted && t.status !== 'done' && t.status !== 'archived' && isToday(t.due)).length;
  const badge = (view, count) => {
    const el = document.querySelector(`.nav-item[data-view="${view}"] .nav-badge`);
    if (!el) return;
    if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.style.display = ''; }
    else el.style.display = 'none';
  };
  badge('today', todayCount);
  badge('tasks', active);
  badge('trash', trashCount);
}

/* ---------- 标题栏最大化按钮 ---------- */
function updateMaxBtn(maximized) {
  const btn = $('#tb-max');
  if (!btn) return;
  btn.textContent = maximized ? '❐' : '□';
  btn.title = maximized ? '还原' : '最大化';
}

/* ---------- 弹窗 ---------- */
function splitDue(due) {
  // "YYYY-MM-DD HH:mm" → { date: "YYYY-MM-DD", time: "HH:mm" }
  if (!due) return { date: '', time: '18:00' };
  const m = String(due).match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
  return { date: m ? m[1] : '', time: m && m[2] ? m[2] : '18:00' };
}

function openModal(task) {
  editingTask = task || null;
  $('#modal-title').textContent = task ? '编辑任务' : '新建任务';
  $('#m-title').value = task ? task.title : '';
  $('#m-desc').value = task ? task.desc || '' : '';
  $('#m-pri').value = task ? String(task.pri) : '2';
  $('#m-status').value = task ? task.status : 'todo';
  const due = splitDue(task ? task.due : '');
  $('#m-due-date').value = due.date;
  $('#m-due-time').value = due.time;
  $('#m-tags').value = task ? (task.tags || []).join(', ') : '';
  $('#m-project').value = task ? task.project || '' : '';
  $('#m-repeat').value = task ? task.repeat || '' : '';
  $('#m-remind').value = task ? String(task.remind || 30) : '30';
  $('#m-children').value = task && task.children && task.children.length
    ? task.children.map((c) => {
        const x = childLabel(c);
        return (x.done ? '[x] ' : '[ ] ') + x.title;
      }).join('\n')
    : '';
  $('#m-delete').classList.toggle('hidden', !task);
  $('#m-archive').classList.toggle('hidden', !task || task.status === 'archived');
  $('#m-unarchive').classList.toggle('hidden', !task || task.status !== 'archived');
  $('#m-save').textContent = task ? '保存' : '创建';
  $('#modal-mask').classList.remove('hidden');
  $('#m-title').focus();
}

function closeModal() {
  $('#modal-mask').classList.add('hidden');
  editingTask = null;
}

async function saveModal() {
  const title = $('#m-title').value.trim();
  if (!title) { $('#m-title').style.borderColor = '#C4453B'; return; }
  // 解析子任务文本：每行一个，[x] 前缀表示已完成
  const children = $('#m-children').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^\[(x|X| )\]\s*(.*)$/);
    if (m) return { title: m[2], done: m[1] !== ' ' && m[1] !== '' };
    return { title: l, done: false };
  });
  // 截止时间：日期 + 时间组合，日期为空则不设截止
  const dueDate = $('#m-due-date').value;
  const dueTime = $('#m-due-time').value || '18:00';
  const due = dueDate ? `${dueDate} ${dueTime}` : null;
  const data = {
    title,
    desc: $('#m-desc').value.trim(),
    pri: parseInt($('#m-pri').value, 10),
    status: $('#m-status').value,
    due,
    tags: $('#m-tags').value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, 5),
    project: $('#m-project').value.trim(),
    repeat: $('#m-repeat').value,
    remind: parseInt($('#m-remind').value, 10),
    children
  };
  if (editingTask) {
    await window.api.tasks.update(editingTask.id, data);
    toast(`已保存「${title}」`);
  } else {
    await window.api.tasks.create(data);
    toast(`已创建「${title}」`);
  }
  closeModal();
  await refreshTasks();
}

async function deleteEditingTask() {
  if (!editingTask) return;
  const id = editingTask.id;
  const title = editingTask.title;
  closeModal();
  await window.api.tasks.remove(id);
  toast(`已删除「${title}」`, 5000, [{
    label: '撤销',
    run: async () => {
      await window.api.tasks.restore(id);
      await refreshTasks();
      toast('已恢复');
    }
  }]);
  await refreshTasks();
}

async function archiveEditingTask() {
  if (!editingTask) return;
  const id = editingTask.id;
  const title = editingTask.title;
  closeModal();
  await window.api.tasks.archive(id);
  toast(`已归档「${title}」`, 5000, [{
    label: '撤销',
    run: async () => {
      await window.api.tasks.unarchive(id);
      await refreshTasks();
      toast('已恢复');
    }
  }]);
  await refreshTasks();
}

async function unarchiveEditingTask() {
  if (!editingTask) return;
  const id = editingTask.id;
  closeModal();
  await window.api.tasks.unarchive(id);
  toast('已恢复为待办');
  await refreshTasks();
}

/* ---------- AI 对话 ---------- */
function addMsg(role, text, extra) {
  const chat = $('#ai-chat');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<span>${esc(text)}</span><span class="mt">${time}</span>`;
  if (extra) el.appendChild(extra);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function opCard(result) {
  const card = document.createElement('div');
  card.className = 'op-card';
  const titles = { create: '已创建', complete: '已完成', start: '已开始', delete: '已删除', archive: '已归档', split: '已拆分' };
  card.innerHTML = `<div class="op-title">${titles[result.type] || '操作'}</div>`;
  if (result.undoable && result.undo) {
    const undo = document.createElement('span');
    undo.className = 'undo';
    undo.textContent = '撤销';
    undo.addEventListener('click', async () => {
      await window.api.ai.undo(result.undo);
      await refreshTasks();
      toast('已撤销');
      card.remove();
    });
    card.appendChild(undo);
  }
  return card;
}

async function sendPrompt(text) {
  const input = $('#ai-input');
  const raw = (text || input.value).trim();
  if (!raw) return;
  input.value = '';
  addMsg('user', raw);
  const typing = addMsg('ai', '…');
  try {
    const result = await window.api.ai.handle(raw);
    // 打字机效果
    const msgEl = typing.querySelector('span');
    const full = result.message;
    msgEl.textContent = '';
    const chat = $('#ai-chat');
    let i = 0;
    const typeTimer = setInterval(() => {
      i += 2;
      msgEl.textContent = full.slice(0, i);
      chat.scrollTop = chat.scrollHeight;
      if (i >= full.length) {
        clearInterval(typeTimer);
        msgEl.textContent = full;
      }
    }, 12);
    // 降级提示：LLM 失败时自动回退规则引擎
    if (result.degraded) {
      const tip = document.createElement('div');
      tip.style.cssText = 'font-size:11px;color:#B5791F;margin-top:6px;background:rgba(199,138,43,0.08);border:1px solid rgba(199,138,43,0.2);border-radius:8px;padding:6px 10px;';
      tip.textContent = '⚠ 模型暂时连不上，已改用本地助手继续帮你';
      typing.appendChild(tip);
    }
    if (result.type === 'create' || result.type === 'complete' || result.type === 'start' || result.type === 'delete' || result.type === 'archive' || result.type === 'split') {
      typing.appendChild(opCard(result));
    }
    await refreshTasks();
  } catch (e) {
    typing.querySelector('span').textContent = '出错了：' + e.message;
  }
}

/* ---------- 聊天历史 ---------- */
async function loadChatHistory() {
  try {
    const log = await window.api.chat.get();
    if (!log || !log.length) return;
    const chat = $('#ai-chat');
    chat.innerHTML = '';
    log.slice(-50).forEach((entry) => {
      const el = document.createElement('div');
      el.className = `msg ${entry.role}`;
      const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `<span>${esc(entry.text)}</span><span class="mt">${time}</span>`;
      chat.appendChild(el);
    });
    chat.scrollTop = chat.scrollHeight;
  } catch (e) {
    // 历史加载失败不阻塞
  }
}

/* ---------- AI 引擎徽标 ---------- */
function updateAiBadge() {
  const badge = $('#tb-ai-stage');
  if (!badge) return;
  const stage = settings.aiStage || 'mock';
  const configured = !!(settings.aiApiKey && settings.aiModel);
  if (stage === 'llm' && configured) {
    badge.textContent = '真实模型';
    badge.style.background = 'rgba(62, 142, 90, 0.1)';
    badge.style.color = 'var(--ok)';
    badge.style.borderColor = 'rgba(62, 142, 90, 0.2)';
  } else if (stage === 'llm' && !configured) {
    badge.textContent = '待配置';
    badge.style.background = 'rgba(199, 138, 43, 0.1)';
    badge.style.color = '#B5791F';
    badge.style.borderColor = 'rgba(199, 138, 43, 0.2)';
  } else {
    badge.textContent = '模拟 AI';
    badge.style.background = 'rgba(232, 116, 59, 0.1)';
    badge.style.color = 'var(--accent)';
    badge.style.borderColor = 'rgba(232, 116, 59, 0.2)';
  }
}

/* ---------- 刷新 ---------- */
async function refreshTasks() {
  tasks = await window.api.tasks.getAll();
  // 同步回收站列表，保证侧边栏回收站徽标准确
  try { trashList = await window.api.tasks.getDeleted(); } catch (e) { /* 忽略 */ }
  renderAll();
}

function renderAll() {
  renderToday();
  renderTasks();
  renderBoard();
  renderCal();
  renderNavBadges();
  if (currentView === 'stat') renderStat();
  if (currentView === 'settings') renderSettings();
  if (currentView === 'trash') loadTrash();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 导航
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));

  // 标题栏
  $('#tb-min').addEventListener('click', () => window.api.window.minimize());
  $('#tb-max').addEventListener('click', async () => {
    const res = await window.api.window.toggleMaximize();
    updateMaxBtn(res && res.maximized);
  });
  $('#tb-quit').addEventListener('click', () => window.api.window.quit());
  // 最大化状态同步
  window.api.on('window:maximized', (maximized) => updateMaxBtn(maximized));
  // 双击标题栏最大化/还原
  $('.titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-right')) return;
    window.api.window.toggleMaximize();
  });

  // 任务列表点击（事件委托）
  $('#today-list').addEventListener('click', onTaskClick);
  $('#tasks-list').addEventListener('click', onTaskClick);
  $('#cal-body').addEventListener('click', onCalClick);

  // 搜索
  $('#search-input').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    renderTasks();
  });

  // 快建：支持自然语言（如「明天下午3点 交周报 #工作 紧急」）
  $('#quick-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const raw = e.target.value.trim();
      if (!raw) return;
      try {
        const parsed = await window.api.ai.parse(raw);
        if (parsed.intent === 'create' && parsed.params.title) {
          const p = parsed.params;
          await window.api.tasks.create({
            title: p.title,
            pri: p.pri || 2,
            due: p.due || null,
            tags: p.tags || []
          });
          e.target.value = '';
          toast(`已创建「${p.title}」${p.due ? ' · ' + p.due : ''}`);
        } else {
          // 非创建意图：退化为纯标题创建
          await window.api.tasks.create({ title: raw, pri: 2 });
          e.target.value = '';
          toast(`已创建「${raw}」`);
        }
      } catch (err) {
        toast('创建失败：' + err.message);
      }
      await refreshTasks();
    }
  });
  $('#btn-new').addEventListener('click', () => openModal(null));

  // 看板拖拽
  $('#board-cols').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.bc-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  $('#board-cols').addEventListener('dragend', (e) => {
    const card = e.target.closest('.bc-card');
    if (card) card.classList.remove('dragging');
    $$('#board-cols .board-col').forEach((c) => c.classList.remove('col-drop'));
  });
  $('#board-cols').addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const col = e.target.closest('.board-col');
    if (col) col.classList.add('col-drop');
  });
  $('#board-cols').addEventListener('dragleave', (e) => {
    const col = e.target.closest('.board-col');
    if (col) col.classList.remove('col-drop');
  });
  $('#board-cols').addEventListener('drop', async (e) => {
    e.preventDefault();
    $$('#board-cols .board-col').forEach((c) => c.classList.remove('col-drop'));
    const col = e.target.closest('.board-col');
    const id = e.dataTransfer.getData('text/plain');
    if (!col || !id) return;
    const t = tasks.find((x) => x.id === parseInt(id, 10));
    if (!t) return;
    // 若拖到同列，仅调整顺序；否则变更状态
    if (t.status === col.dataset.col) {
      // 同列排序：按卡片位置重排
      const cardIds = $$(`#board-cols .board-col[data-col="${col.dataset.col}"] .bc-card`)
        .map((c) => parseInt(c.dataset.id, 10));
      const fromIdx = cardIds.indexOf(parseInt(id, 10));
      const targetCard = e.target.closest('.bc-card');
      let toIdx = cardIds.length;
      if (targetCard) {
        const rect = targetCard.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        toIdx = cardIds.indexOf(parseInt(targetCard.dataset.id, 10));
        if (!before) toIdx++;
      }
      if (fromIdx !== -1 && fromIdx !== toIdx && fromIdx !== toIdx - 1) {
        cardIds.splice(fromIdx, 1);
        if (fromIdx < toIdx) toIdx--;
        cardIds.splice(toIdx, 0, parseInt(id, 10));
        await window.api.tasks.reorder(cardIds);
        await refreshTasks();
        toast('已调整卡片顺序');
      }
      return;
    }
    await window.api.tasks.update(t.id, { status: col.dataset.col });
    toast(`「${t.title}」已移至「${STATE_NAME[col.dataset.col]}」`);
    await refreshTasks();
  });
  // 看板卡片点击编辑
  $('#board-cols').addEventListener('click', (e) => {
    const card = e.target.closest('.bc-card');
    if (!card) return;
    const t = tasks.find((x) => x.id === parseInt(card.dataset.id, 10));
    if (t) openModal(t);
  });

  // 日历
  $('#cal-body').addEventListener('click', onCalClick);

  // 任务列表拖拽排序
  $('#tasks-list').addEventListener('dragstart', (e) => {
    const row = e.target.closest('.task-row');
    if (!row) return;
    e.dataTransfer.setData('text/plain', row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  $('#tasks-list').addEventListener('dragend', (e) => {
    const row = e.target.closest('.task-row');
    if (row) row.classList.remove('dragging');
    $$('#tasks-list .task-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  });
  $('#tasks-list').addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.task-row');
    $$('#tasks-list .task-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (!row) return;
    // 根据鼠标在行内的位置决定插入到上方还是下方
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.add(before ? 'drop-before' : 'drop-after');
  });
  $('#tasks-list').addEventListener('dragleave', (e) => {
    const row = e.target.closest('.task-row');
    if (row) row.classList.remove('drop-before', 'drop-after');
  });
  $('#tasks-list').addEventListener('drop', async (e) => {
    e.preventDefault();
    $$('#tasks-list .task-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    const dragId = e.dataTransfer.getData('text/plain');
    if (!dragId) return;
    const rows = $$('#tasks-list .task-row').map((r) => parseInt(r.dataset.id, 10));
    const fromIdx = rows.indexOf(parseInt(dragId, 10));
    if (fromIdx === -1) return;
    // 目标行（可能为 null = 拖到列表末尾）
    const target = e.target.closest('.task-row');
    let toIdx;
    if (!target) {
      toIdx = rows.length; // 追加到末尾
    } else {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      toIdx = rows.indexOf(parseInt(target.dataset.id, 10));
      if (!before) toIdx++;
    }
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
    rows.splice(fromIdx, 1);
    if (fromIdx < toIdx) toIdx--;
    rows.splice(toIdx, 0, parseInt(dragId, 10));
    await window.api.tasks.reorder(rows);
    await refreshTasks();
    toast('已调整任务顺序');
  });

  // 批量操作
  $('#batch-done').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    await window.api.tasks.batchUpdate(ids, { status: 'done' });
    selectedIds.clear();
    toast(`已完成 ${ids.length} 项任务`);
    await refreshTasks();
  });
  $('#batch-delete').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    confirmDialog(`确定删除选中的 ${ids.length} 项任务吗？`, async () => {
      await window.api.tasks.batchDelete(ids);
      selectedIds.clear();
      toast(`已删除 ${ids.length} 项任务`, 3000, null, 'ok');
      await refreshTasks();
    });
  });
  $('#batch-pri').addEventListener('change', async () => {
    const pri = parseInt($('#batch-pri').value, 10);
    if (!pri) return;
    const ids = Array.from(selectedIds);
    await window.api.tasks.batchUpdate(ids, { pri });
    selectedIds.clear();
    $('#batch-pri').value = '';
    toast(`已更新 ${ids.length} 项任务优先级`);
    await refreshTasks();
  });
  $('#batch-clear').addEventListener('click', () => {
    selectedIds.clear();
    renderAll();
  });

  // 回收站
  $('#trash-empty').addEventListener('click', async () => {
    confirmDialog('确定清空回收站吗？此操作不可恢复！', async () => {
      await window.api.tasks.emptyTrash();
      toast('回收站已清空', 3000, null, 'ok');
      await loadTrash();
    }, '清空');
  });

  // AI
  $('#ai-send').addEventListener('click', () => sendPrompt());
  $('#ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPrompt(); });
  $('#ai-collapse').addEventListener('click', () => {
    const panel = $('#ai-panel');
    const collapsed = panel.classList.toggle('collapsed');
    // 收起时显示「«」（点击展开），展开时显示「»」（点击收起）
    $('#ai-collapse').textContent = collapsed ? '«' : '»';
    $('#ai-collapse').title = collapsed ? '展开 AI 助手' : '收起 AI 助手';
    // 收起/展开时清除内联宽度，避免与 collapsed 的窄条样式冲突
    if (collapsed) {
      panel.style.width = '';
      panel.style.flexBasis = '';
    }
  });
  $$('#ai-chips .chip').forEach((c) => c.addEventListener('click', () => sendPrompt(c.dataset.prompt)));
  // AI 面板宽度可调（拖拽左边缘）
  (function () {
    const panel = $('#ai-panel');
    const handle = document.createElement('div');
    handle.className = 'ai-resize';
    panel.insertBefore(handle, panel.firstChild);
    let resizing = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', (e) => {
      resizing = true;
      startX = e.clientX;
      startW = panel.offsetWidth;
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const w = Math.max(260, Math.min(480, startW - (e.clientX - startX)));
      panel.style.width = w + 'px';
      panel.style.flexBasis = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.classList.remove('resizing');
      }
    });
  })();

  // 弹窗
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', saveModal);
  $('#m-delete').addEventListener('click', deleteEditingTask);
  $('#m-archive').addEventListener('click', archiveEditingTask);
  $('#m-unarchive').addEventListener('click', unarchiveEditingTask);
  $('#m-due-clear').addEventListener('click', () => {
    $('#m-due-date').value = '';
    $('#m-due-time').value = '18:00';
  });
  $('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) closeModal(); });
  // 弹窗快捷键：Enter 保存（textarea 除外）、Esc 关闭
  $('#modal-mask').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      saveModal();
    }
    if (e.key === 'Escape') closeModal();
  });

  // 主进程事件
  window.api.on('app:new-task', () => { switchView('tasks'); openModal(null); });
  window.api.on('app:focus-ai', () => {
    const panel = $('#ai-panel');
    panel.classList.remove('collapsed');
    $('#ai-collapse').textContent = '»';
    $('#ai-collapse').title = '收起 AI 助手';
    $('#ai-input').focus();
  });
  window.api.on('app:switch-view', (view) => {
    if (['today', 'tasks', 'board', 'cal', 'stat', 'settings', 'trash'].includes(view)) switchView(view);
  });
  window.api.on('app:reminder', (data) => {
    toast(`⏰ ${data.title}${data.due ? ' · ' + data.due : ''}`, 6000);
  });

  // 应用内快捷键（不抢输入框焦点）
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // 1/2/3/4 快速改优先级（选中任务时）
    if (selectedIds.size && ['1', '2', '3', '4'].includes(e.key)) {
      const pri = parseInt(e.key, 10);
      const ids = Array.from(selectedIds);
      window.api.tasks.batchUpdate(ids, { pri });
      selectedIds.clear();
      toast(`已设为${PRI_NAME[pri]}优先级`);
      refreshTasks();
      return;
    }
    // T 加今天 / D 加明天
    if (e.key === 't' || e.key === 'T') {
      const now = new Date();
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const due = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 18:00`;
      openModal(null);
      $('#m-due-date').value = due.slice(0, 10);
      $('#m-due-time').value = '18:00';
      return;
    }
    if (e.key === 'd' || e.key === 'D') {
      const now = new Date();
      now.setDate(now.getDate() + 1);
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const due = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 18:00`;
      openModal(null);
      $('#m-due-date').value = due.slice(0, 10);
      $('#m-due-time').value = '18:00';
      return;
    }
    // N 新建任务
    if (e.key === 'n' || e.key === 'N') {
      openModal(null);
      return;
    }
    // Esc 取消选择
    if (e.key === 'Escape') {
      selectedIds.clear();
      renderAll();
    }
  });
}

/* ---------- 回收站 ---------- */
async function loadTrash() {
  trashList = await window.api.tasks.getDeleted();
  const list = $('#trash-list');
  if (!list) return;
  if (!trashList.length) {
    list.innerHTML = '<div class="empty" style="padding:16px 0"><div class="big">🗑</div>回收站是空的</div>';
    $('#trash-empty').classList.add('hidden');
    return;
  }
  $('#trash-empty').classList.remove('hidden');
  list.innerHTML = trashList.map((t) => `
    <div class="trash-row" data-id="${t.id}">
      <span class="trash-title">${esc(t.title)}</span>
      <span class="trash-time">${t.due ? esc(t.due) : '无截止'}</span>
      <button class="btn mini" data-restore="${t.id}">恢复</button>
    </div>`).join('');
  // 绑定恢复按钮
  $$('#trash-list [data-restore]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.restore, 10);
      await window.api.tasks.restore(id);
      toast('已恢复任务');
      await loadTrash();
      await refreshTasks();
    });
  });
}

async function onTaskClick(e) {
  // 顺延按钮
  const postponeBtn = e.target.closest('[data-postpone]');
  if (postponeBtn) {
    const id = parseInt(postponeBtn.closest('.overdue-actions').dataset.id, 10);
    const days = parseInt(postponeBtn.dataset.postpone, 10);
    postponeTask(id, days);
    return;
  }
  // hover 快捷操作
  const ra = e.target.closest('.ra');
  if (ra) {
    const row = ra.closest('.task-row');
    const id = parseInt(row.dataset.id, 10);
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const act = ra.dataset.act;
    if (act === 'edit') openModal(t);
    else if (act === 'copy') duplicateTask(t);
    else if (act === 'archive') archiveTaskById(id, t.title);
    else if (act === 'unarchive') unarchiveTaskById(id);
    else if (act === 'delete') deleteTaskById(id, t.title);
    return;
  }
  // 子任务勾选
  const childItem = e.target.closest('.child-item');
  if (childItem) {
    const parentId = parseInt(childItem.dataset.parentId, 10);
    const childId = childItem.dataset.childId;
    toggleChild(parentId, childId);
    return;
  }
  const row = e.target.closest('.task-row');
  if (!row) return;
  const t = tasks.find((x) => x.id === parseInt(row.dataset.id, 10));
  if (!t) return;
  // 展开/收起子任务
  if (e.target.classList.contains('task-expand')) {
    const id = t.id;
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    renderAll();
    return;
  }
  // 多选（Ctrl/Shift 点击或点击勾选框左侧区域）
  if (e.target.classList.contains('task-check')) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      toggleSelect(t.id);
      return;
    }
    toggleDone(t);
    return;
  }
  // 优先级点击切换（循环 1→2→3→4→1）
  if (e.target.closest('[data-pri-toggle]')) {
    const nextPri = t.pri >= 4 ? 1 : t.pri + 1;
    await window.api.tasks.update(t.id, { pri: nextPri });
    toast(`「${t.title}」已设为${PRI_NAME[nextPri]}优先级`);
    await refreshTasks();
    return;
  }
  if (e.target.classList.contains('statectl')) {
    cycleState(t);
  } else if (e.target.closest('.tname')) {
    // 点击标题：切换详情展开
    const key = 'd' + t.id;
    if (expandedIds.has(key)) expandedIds.delete(key);
    else expandedIds.add(key);
    renderAll();
  }
}

/* 复制任务 */
async function duplicateTask(t) {
  const copy = await window.api.tasks.create({
    title: t.title + '（副本）',
    desc: t.desc,
    pri: t.pri,
    due: t.due,
    tags: t.tags,
    project: t.project,
    repeat: t.repeat,
    remind: t.remind,
    children: t.children
  });
  toast(`已复制为「${copy.title}」`);
  await refreshTasks();
}

/* 归档/恢复/删除（带撤销） */
async function archiveTaskById(id, title) {
  await window.api.tasks.archive(id);
  toast(`已归档「${title}」`, 5000, [{
    label: '撤销',
    run: async () => {
      await window.api.tasks.unarchive(id);
      await refreshTasks();
      toast('已恢复');
    }
  }]);
  await refreshTasks();
}

async function unarchiveTaskById(id) {
  await window.api.tasks.unarchive(id);
  toast('已恢复为待办');
  await refreshTasks();
}

async function deleteTaskById(id, title) {
  await window.api.tasks.remove(id);
  toast(`已删除「${title}」`, 5000, [{
    label: '撤销',
    run: async () => {
      await window.api.tasks.restore(id);
      await refreshTasks();
      toast('已恢复');
    }
  }]);
  await refreshTasks();
}

async function toggleChild(parentId, childId) {
  const t = tasks.find((x) => x.id === parentId);
  if (!t) return;
  const children = (t.children || []).map((c) => {
    const x = childLabel(c);
    if (x.id === childId || String(x.id) === String(childId)) {
      return Object.assign({}, c, { done: !x.done });
    }
    return c;
  });
  await window.api.tasks.update(parentId, { children });
  await refreshTasks();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  renderAll();
}

async function toggleDone(t) {
  // 使用 completeTask：重复任务自动生成下一次
  const res = await window.api.tasks.complete(t.id);
  if (res.next) {
    toast(`「${t.title}」已完成，已自动安排下一次（${res.next.due}）`, 5000);
  } else {
    toast(`已完成「${t.title}」`);
  }
  // 完成动画：找到对应行添加动画类
  const row = document.querySelector(`.task-row[data-id="${t.id}"]`);
  if (row) {
    row.classList.add('just-done');
    setTimeout(() => row.classList.remove('just-done'), 600);
  }
  await refreshTasks();
}

async function postponeTask(id, days) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  await window.api.tasks.postpone(id, days);
  toast(`「${t.title}」已顺延${days === 1 ? '到明天' : '一周'}`);
  await refreshTasks();
}

async function cycleState(t) {
  const next = STATE_NEXT[t.status] || 'todo';
  await window.api.tasks.update(t.id, { status: next });
  await refreshTasks();
}

function onCalClick(e) {
  const addBtn = e.target.closest('#cal-add-task');
  if (addBtn) {
    // 在该天新建任务：预填截止日期
    openModal(null);
    $('#m-due-date').value = calSelected;
    $('#m-due-time').value = '18:00';
    return;
  }
  const cell = e.target.closest('.cal-cell');
  if (cell) {
    calSelected = cell.dataset.day;
    renderCal();
    return;
  }
  const btn = e.target.closest('[data-cal]');
  if (btn) {
    if (btn.dataset.cal === 'prev') calCursor.setMonth(calCursor.getMonth() - 1);
    if (btn.dataset.cal === 'next') calCursor.setMonth(calCursor.getMonth() + 1);
    if (btn.dataset.cal === 'today') { calCursor = new Date(); calCursor.setDate(1); }
    calSelected = null;
    renderCal();
    return;
  }
  onTaskClick(e);
}

/* ---------- 初始化 ---------- */
async function init() {
  settings = await window.api.settings.get();
  applyTheme();
  tasks = await window.api.tasks.getAll();
  const dir = await window.api.data.getDir();
  settings.dataDir = dir;
  bindEvents();
  renderAll();
  updateAiBadge();
  await loadChatHistory();
  // 无历史时显示欢迎消息
  const chat = $('#ai-chat');
  if (!chat.children.length) {
    addMsg('ai', '想记点什么？直接说就行，例如：\n· 明天下午3点 交周报 #工作\n· 今天我要做什么\n· 完成 交周报');
  }
}

document.addEventListener('DOMContentLoaded', init);