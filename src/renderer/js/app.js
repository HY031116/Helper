'use strict';

/* ============================================================
 * 渲染进程主逻辑 - 工作台助手
 * 视图：今日 / 所有任务 / 备忘录 / 看板 / 日历 / 统计 / 设置
 * 右侧：AI 助手面板
 * ============================================================ */

/* ---------- 状态 ---------- */
let tasks = [];
let memos = [];
let settings = {};
let currentView = 'today';
let currentFilter = 'all';
let advancedFiltersOpen = false;
let currentSearch = '';
let editingTask = null; // 正在编辑的任务（null = 新建）
let calCursor = new Date();
calCursor.setDate(1);
let calSelected = null;
let calFocusDate = null;
let statInited = false;
let selectedIds = new Set(); // 批量选择
let batchMode = false;
let visibleTaskIds = [];
let expandedIds = new Set(); // 展开的子任务
let trashList = []; // 回收站列表
let deletedMemos = [];
let selectedMemoId = null;
let memoFocusId = null;
let memoSearch = '';
let memoSaveTimer = null;
let memoSaveChain = Promise.resolve();
let memoDirty = false;
let memoCreating = false;
let reportWeek = 0; // 周报选择的周（0=本周, -1=上周, 1=下周）
let quickParseTimer = null;
let quickParseToken = 0;
let quickParseCache = { raw: '', parsed: null };
let modalSaving = false;
let modalReturnFocus = null;
let modalInitialSnapshot = '';
let aiSending = false;
let aiRuntimeState = null; // null | ready | degraded
let eventsBound = false;
const dataLoadErrors = { tasks: null, memos: null };
const systemTheme = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false, addEventListener() {} };

systemTheme.addEventListener('change', () => {
  if ((settings.theme || 'auto') === 'auto') applyTheme();
});

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function loadErrorHtml(source, compact) {
  const labels = {
    tasks: ['任务暂时无法读取', '已有数据不会被修改，请重试。'],
    memos: ['备忘录暂时无法读取', '已有内容不会被修改，请重试。'],
    trash: ['回收站暂时无法读取', '请稍后重试。'],
    startup: ['工作台暂时无法启动', '本地数据不会被修改，请重试。']
  };
  const [title, detail] = labels[source] || labels.startup;
  return `<div class="load-state error${compact ? ' compact' : ''}" role="alert">
    <div><strong>${title}</strong><span>${detail}</span></div>
    <button type="button" class="btn mini ghost load-action" data-retry-source="${source}">重试</button>
  </div>`;
}

function applyDataLoadStates() {
  if (dataLoadErrors.tasks) {
    ['today-list', 'tasks-list', 'board-cols', 'cal-body', 'stat-body'].forEach((id) => {
      const target = document.getElementById(id);
      if (target) target.innerHTML = loadErrorHtml('tasks');
    });
    $('#today-sub').textContent = '任务数据暂时不可用';
    $('#tasks-sub').textContent = '任务数据暂时不可用';
    $('#cal-sub').textContent = '任务数据暂时不可用';
  }
  const memoError = $('#memo-load-error');
  if (memoError) {
    memoError.classList.toggle('hidden', !dataLoadErrors.memos);
    if (dataLoadErrors.memos) {
      memoError.innerHTML = loadErrorHtml('memos');
      $('#memo-empty').classList.add('hidden');
      $('#memo-editor').classList.add('hidden');
      $('#memo-list').innerHTML = '<div class="memo-list-empty">备忘录暂时不可用</div>';
      $('#memos-sub').textContent = '读取失败';
    }
  }
}

async function retryDataSource(source, button) {
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '重试中…';
  }
  try {
    if (source === 'tasks') {
      tasks = await window.api.tasks.getAll();
      dataLoadErrors.tasks = null;
      try { trashList = await window.api.tasks.getDeleted(); } catch (e) { /* 徽标稍后同步 */ }
    } else if (source === 'memos') {
      memos = await window.api.memos.getAll();
      dataLoadErrors.memos = null;
      try { deletedMemos = await window.api.memos.getDeleted(); } catch (e) { /* 徽标稍后同步 */ }
    } else if (source === 'trash') {
      await loadTrash();
      return;
    } else {
      await init();
      return;
    }
    renderAll();
    toast(source === 'tasks' ? '任务已重新载入' : '备忘录已重新载入', 2500, null, 'ok');
  } catch (error) {
    if (source === 'tasks' || source === 'memos') dataLoadErrors[source] = error;
    applyDataLoadStates();
    toast('仍然无法读取，请稍后重试', 3500, null, 'err');
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = '重试';
    }
  }
}

function renderStartupError(error) {
  console.error('Work Helper init failed:', error);
  $$('.view').forEach((view) => { view.style.display = view.id === 'view-today' ? '' : 'none'; });
  $('#today-sub').textContent = '启动失败';
  $('#today-list').innerHTML = loadErrorHtml('startup');
  $('#ai-chat').innerHTML = '<div class="load-state error compact" role="alert"><div><strong>助手暂时不可用</strong><span>工作台恢复后会自动同步。</span></div></div>';
  const panelStage = $('.ai-stage');
  if (panelStage) panelStage.textContent = '暂时不可用';
  if (!eventsBound) {
    const retry = $('#today-list [data-retry-source="startup"]');
    if (retry) retry.addEventListener('click', () => retryDataSource('startup', retry));
  }
}

const PRI_NAME = { 4: '紧急', 3: '高', 2: '中', 1: '低' };
const STATE_NAME = { todo: '待办', doing: '进行中', done: '已完成', archived: '已归档' };
const STATE_NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
const BOARD_COLUMNS = [
  { k: 'todo', name: '待办' },
  { k: 'doing', name: '进行中' },
  { k: 'done', name: '已完成' }
];

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
function toast(message, ms, actions, type) {
  const layer = $('#toast-layer');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' t-' + type : '');
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.setAttribute('aria-atomic', 'true');
  const icons = { ok: '✓', err: '✕', warn: '⚠' };
  if (icons[type]) {
    const icon = document.createElement('span');
    icon.className = 't-ico';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = icons[type];
    el.appendChild(icon);
  }
  const text = document.createElement('span');
  text.textContent = String(message == null ? '' : message);
  el.appendChild(text);
  if (actions) {
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 't-undo';
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        try {
          await a.run();
          el.remove();
        } catch (error) {
          b.disabled = false;
          b.setAttribute('aria-busy', 'false');
          console.error('[toast] action failed:', error);
          toast('操作失败，请稍后重试', 4000, null, 'err');
        }
      });
      el.appendChild(b);
    });
  }
  layer.appendChild(el);
  while (layer.children.length > 3) layer.firstElementChild.remove();
  setTimeout(() => el.remove(), ms || 3000);
}

if (typeof window.addEventListener === 'function') {
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    const reason = event.reason;
    console.error('Unhandled renderer operation:', reason);
    toast('操作未完成，请稍后重试', 4500, null, 'err');
  });
}

/* ---------- 统一确认框 ---------- */
function confirmDialog(message, onOk, okText) {
  const mask = $('#confirm-mask');
  const title = $('#confirm-title');
  const text = $('#confirm-text');
  const okBtn = $('#confirm-ok');
  const cancelBtn = $('#confirm-cancel');
  const returnFocus = document.activeElement;
  const actionText = okText || '删除';
  title.textContent = `确认${actionText}`;
  text.textContent = message;
  okBtn.textContent = actionText;
  mask.classList.remove('hidden');
  mask.setAttribute('aria-hidden', 'false');
  const onOkClick = async () => {
    if (okBtn.disabled) return;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    okBtn.setAttribute('aria-busy', 'true');
    okBtn.textContent = `${actionText}中…`;
    try {
      await onOk();
      cleanup();
    } catch (error) {
      console.error('[confirm] action failed:', error);
      okBtn.disabled = false;
      cancelBtn.disabled = false;
      okBtn.setAttribute('aria-busy', 'false');
      okBtn.textContent = actionText;
      toast('操作失败，请稍后重试', 4000, null, 'err');
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !okBtn.disabled) { cleanup(); }
    if (e.key === 'Tab') trapFocus(mask, e);
  };
  function cleanup() {
    mask.classList.add('hidden');
    mask.setAttribute('aria-hidden', 'true');
    cancelBtn.removeEventListener('click', cleanup);
    okBtn.removeEventListener('click', onOkClick);
    document.removeEventListener('keydown', onKey);
    okBtn.disabled = false;
    cancelBtn.disabled = false;
    okBtn.setAttribute('aria-busy', 'false');
    if (returnFocus && returnFocus.isConnected && !returnFocus.closest('.hidden')) returnFocus.focus();
  }
  cancelBtn.addEventListener('click', cleanup);
  okBtn.addEventListener('click', onOkClick);
  document.addEventListener('keydown', onKey);
  // 焦点交给「取消」（默认安全选项），避免误触破坏性操作
  cancelBtn.focus();
}

function trapFocus(container, event) {
  const focusable = Array.from(container.querySelectorAll('button, input, select, textarea, [tabindex]'))
    .filter((el) => !el.disabled && el.tabIndex !== -1 && !el.closest('.hidden'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindRadioGroupKeyboard(group) {
  if (!group) return;
  const radios = Array.from(group.querySelectorAll('[role="radio"]'));
  if (!radios.length) return;
  const syncTabStops = () => {
    const checked = radios.find((radio) => radio.getAttribute('aria-checked') === 'true') || radios[0];
    radios.forEach((radio) => { radio.tabIndex = radio === checked ? 0 : -1; });
  };
  syncTabStops();
  radios.forEach((radio, index) => {
    radio.addEventListener('click', syncTabStops);
    radio.addEventListener('keydown', (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = radios.length - 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + radios.length) % radios.length;
      else nextIndex = (index + 1) % radios.length;
      radios[nextIndex].focus();
      radios[nextIndex].click();
    });
  });
}

function bindPressedGroupKeyboard(group, selector) {
  if (!group || typeof group.querySelectorAll !== 'function') return;
  const buttons = Array.from(group.querySelectorAll(selector))
    .filter((button) => !button.disabled && !button.closest('.hidden'));
  if (!buttons.length) return;
  const syncTabStops = () => {
    const pressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'true') || buttons[0];
    buttons.forEach((button) => { button.tabIndex = button === pressed ? 0 : -1; });
  };
  syncTabStops();
  buttons.forEach((button, index) => {
    button.addEventListener('click', syncTabStops);
    button.addEventListener('keydown', (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = buttons.length - 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + buttons.length) % buttons.length;
      else nextIndex = (index + 1) % buttons.length;
      buttons[nextIndex].focus();
      buttons[nextIndex].click();
    });
  });
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
  const isSelected = selectedIds.has(t.id);
  const check = batchMode ? (isSelected ? '✓' : '') : (t.status === 'done' ? '✓' : '');
  const selected = isSelected ? ' sel' : '';
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
    ? `<span class="row-actions"><button type="button" class="ra" data-act="unarchive" title="恢复" aria-label="恢复任务">↩</button><button type="button" class="ra danger" data-act="delete" title="删除" aria-label="删除任务">⌫</button></span>`
    : `<span class="row-actions"><button type="button" class="ra" data-act="edit" title="编辑" aria-label="编辑任务">✎</button><button type="button" class="ra" data-act="copy" title="复制" aria-label="复制任务">⧉</button><button type="button" class="ra" data-act="archive" title="归档" aria-label="归档任务">□</button><button type="button" class="ra danger" data-act="delete" title="删除" aria-label="删除任务">⌫</button></span>`;
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
  const checkLabel = batchMode
    ? `${isSelected ? '取消选择' : '选择'}任务「${t.title}」`
    : (t.status === 'done' ? '重新打开' : '完成任务');
  return `<div class="task-row${t.status === 'done' ? ' done' : ''}${t.status === 'archived' ? ' archived' : ''}${batchMode ? ' selecting' : ''}${selected}${overdueCls}" data-id="${t.id}" draggable="${!batchMode}">
    <button type="button" class="task-check" title="${esc(checkLabel)}" aria-label="${esc(checkLabel)}" aria-pressed="${batchMode ? isSelected : t.status === 'done'}">${check}</button>
    <button type="button" class="pri-dot p${t.pri}" title="点击切换优先级（当前：${PRI_NAME[t.pri]}）" aria-label="当前${PRI_NAME[t.pri]}优先级，点击切换" data-pri-toggle${batchMode ? ' tabindex="-1"' : ''}>${PRI_NAME[t.pri]}</button>
    ${hasChildren ? `<button type="button" class="task-expand${expanded ? ' open' : ''}" title="${expanded ? '收起' : '展开'}子任务" aria-expanded="${expanded}"${batchMode ? ' tabindex="-1"' : ''}>▸</button>` : ''}
    <div class="task-main"${batchMode ? ' inert' : ''}>
      <button type="button" class="tname task-title-btn" aria-expanded="${detailOpen}">${titleHtml}</button>
      ${sub.length ? `<div class="tsub">${sub.join(' · ')}</div>` : ''}
      ${hasChildren && expanded ? `<div class="child-list">${t.children.map((c) => {
        const x = childLabel(c);
        return `<button type="button" class="child-item${x.done ? ' done' : ''}" data-child-id="${x.id}" data-parent-id="${t.id}" aria-pressed="${x.done}">
          <span class="child-check">${x.done ? '✓' : ''}</span>
          <span class="child-title">${esc(x.title)}</span>
        </button>`;
      }).join('')}</div>` : ''}
      ${detailHtml}
    </div>
    <div class="task-meta"${batchMode ? ' inert' : ''}>
      ${repeatTag}
      ${dueHtml}
      ${doneTime}
      <button type="button" class="statectl s-${t.status}" title="切换任务状态" aria-label="当前状态：${STATE_NAME[t.status]}，点击切换">${STATE_NAME[t.status]}</button>
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

function quickPreviewModel(raw, parsed) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const params = parsed && parsed.params;
  const isCreate = parsed && parsed.intent === 'create' && params && params.title;
  if (!isCreate) {
    return { label: '普通任务', title: value, fallback: true, meta: ['中优先级'] };
  }
  const meta = [];
  if (params.due) meta.push(relDue(params.due));
  meta.push(`${PRI_NAME[params.pri || 2]}优先级`);
  (params.tags || []).forEach((tag) => meta.push(`#${tag}`));
  return { label: '识别结果', title: params.title, fallback: false, meta };
}

function renderQuickPreview(raw, parsed) {
  const preview = $('#quick-preview');
  if (!preview) return;
  const model = quickPreviewModel(raw, parsed);
  if (!model) {
    preview.classList.add('hidden');
    preview.classList.remove('fallback');
    preview.innerHTML = '';
    return;
  }
  preview.classList.remove('hidden');
  preview.classList.toggle('fallback', model.fallback);
  preview.innerHTML = `<span class="quick-preview-label">${model.label}</span>
    <strong class="quick-preview-title" title="${esc(model.title)}">${esc(model.title)}</strong>
    <span class="quick-preview-meta">${model.meta.map((item) => `<span class="quick-preview-chip">${esc(item)}</span>`).join('')}</span>`;
}

function resetQuickPreview() {
  clearTimeout(quickParseTimer);
  quickParseToken++;
  quickParseCache = { raw: '', parsed: null };
  renderQuickPreview('', null);
}

function scheduleQuickPreview(raw) {
  clearTimeout(quickParseTimer);
  const value = String(raw || '').trim();
  if (!value) {
    resetQuickPreview();
    return;
  }
  const token = ++quickParseToken;
  quickParseTimer = setTimeout(async () => {
    try {
      const parsed = await window.api.ai.parse(value);
      if (token !== quickParseToken || $('#quick-input').value.trim() !== value) return;
      quickParseCache = { raw: value, parsed };
      renderQuickPreview(value, parsed);
    } catch (e) {
      if (token !== quickParseToken) return;
      quickParseCache = { raw: value, parsed: null };
      renderQuickPreview(value, null);
    }
  }, 180);
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
    if (currentSearch) {
      container.innerHTML = `<div class="empty">
        <div class="big" aria-hidden="true">⌕</div>
        <div class="empty-title">没有匹配的任务</div>
        <p class="empty-hint">换个关键词，或清除搜索查看全部任务。</p>
        <button type="button" class="btn mini ghost empty-cta" id="empty-clear-search">清除搜索</button>
      </div>`;
      container.querySelector('#empty-clear-search').addEventListener('click', () => {
        currentSearch = '';
        const input = $('#search-input');
        input.value = '';
        renderTasks();
        input.focus();
      });
      return;
    }
    // 空状态 = 指引时刻：说明现状 + 给出下一步动作
    const emptyStates = {
      today: { ico: '◐', title: '今天没有到期任务', hint: '可以继续当前工作，或安排下一件要紧事。' },
      all: { ico: '＋', title: '还没有任务', hint: '在快速添加框输入一句话，或让助手记下第一件事。' },
      active: { ico: '✓', title: '没有未完成的任务', hint: '当前待办已经处理完。' },
      done: { ico: '✓', title: '还没有已完成的任务', hint: '完成的任务会集中显示在这里。' },
      archived: { ico: '□', title: '没有已归档的任务', hint: '暂时收起的任务会保存在这里。' },
      nodate: { ico: '—', title: '所有任务都设了截止日期', hint: '当前没有遗漏截止时间的任务。' },
      overdue: { ico: '✓', title: '没有过期任务', hint: '当前任务都在计划内。' },
      week: { ico: '▦', title: '本周没有新任务', hint: '可以继续处理已有事项。' }
    };
    const key = currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:') ? 'all' : currentFilter;
    const st = emptyStates[key] || emptyStates.all;
    const showBtn = currentFilter === 'all' || currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:');
    container.innerHTML = `<div class="empty">
      <div class="big" aria-hidden="true">${st.ico}</div>
      <div class="empty-title">${st.title}</div>
      <p class="empty-hint">${st.hint}</p>
      ${showBtn ? '<button type="button" class="btn mini empty-cta" id="empty-new-task">新建任务</button>' : ''}
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
    html += `<div class="today-group overdue"><span>已过期</span><strong>${overdue.length}</strong></div>`;
    html += overdue.map((t) => rowHTML(t) + `<div class="overdue-actions" data-id="${t.id}"><button type="button" class="btn mini" data-postpone="1">顺延到明天</button><button type="button" class="btn mini ghost" data-postpone="7">顺延一周</button></div>`).join('');
  }
  if (todays.length) {
    html += `<div class="today-group due"><span>今天到期</span><strong>${todays.length}</strong></div>`;
    html += todays.map(rowHTML).join('');
  }
  if (!html) {
    html = `<div class="empty">
      <div class="big" aria-hidden="true">◐</div>
      <div class="empty-title">今天没有到期任务</div>
      <p class="empty-hint">可以继续处理已有事项，或安排下一件要紧事。</p>
      <div class="empty-actions">
        <button type="button" class="btn mini ghost" id="today-empty-all">查看所有任务</button>
        <button type="button" class="btn mini" id="today-empty-new">新建任务</button>
      </div>
    </div>`;
  }
  $('#today-list').innerHTML = html;
  $('#today-empty-all')?.addEventListener('click', () => switchView('tasks'));
  $('#today-empty-new')?.addEventListener('click', () => openModal(null));
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
  visibleTaskIds = list.map((t) => t.id);
  const visibleSet = new Set(visibleTaskIds);
  selectedIds = new Set([...selectedIds].filter((id) => visibleSet.has(id)));
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
  const advancedCount = projs.length + tags.length;
  const advancedSelected = currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:');
  const advancedLabel = currentFilter.startsWith('proj:')
    ? `◈ ${currentFilter.slice(5)}`
    : currentFilter.startsWith('tag:')
      ? `#${currentFilter.slice(4)}`
      : `更多筛选 ${advancedCount}`;

  let html = `<div class="smart-row">
    ${smart.map((s) => `<button type="button" class="fchip ${currentFilter === s.k ? 'active' : ''}" aria-pressed="${currentFilter === s.k}" data-filter="${s.k}">${s.n}</button>`).join('')}
    ${advancedCount ? `<button type="button" class="fchip smart-more ${advancedSelected && !advancedFiltersOpen ? 'active' : ''}" id="smart-more" aria-expanded="${advancedFiltersOpen}" aria-controls="smart-advanced" aria-label="${advancedFiltersOpen ? '收起' : '展开'}项目和标签筛选">${esc(advancedLabel)} <span aria-hidden="true">${advancedFiltersOpen ? '▴' : '▾'}</span></button>` : ''}
  </div>`;
  if (advancedCount) html += `<div class="smart-advanced ${advancedFiltersOpen ? '' : 'hidden'}" id="smart-advanced" role="group" aria-label="项目和标签筛选">`;
  if (advancedCount && projs.length) {
    html += `<div class="smart-row smart-sub">
      <span class="smart-label">项目</span>
      ${projs.map((p) => `<button type="button" class="fchip ${currentFilter === 'proj:' + p ? 'active' : ''}" aria-pressed="${currentFilter === 'proj:' + p}" data-filter="proj:${esc(p)}">◈ ${esc(p)}</button>`).join('')}
    </div>`;
  }
  if (advancedCount && tags.length) {
    html += `<div class="smart-row smart-sub">
      <span class="smart-label">标签</span>
      ${tags.map((t) => `<button type="button" class="fchip ${currentFilter === 'tag:' + t ? 'active' : ''}" aria-pressed="${currentFilter === 'tag:' + t}" data-filter="tag:${esc(t)}">#${esc(t)}</button>`).join('')}
    </div>`;
  }
  if (advancedCount) html += '</div>';
  wrap.innerHTML = html;
  const more = $('#smart-more');
  if (more) {
    more.addEventListener('click', () => {
      advancedFiltersOpen = !advancedFiltersOpen;
      renderSmartFilters();
      $('#smart-more').focus();
    });
  }
  // 绑定事件
  $$('#smart-filters .fchip[data-filter]').forEach((c) => {
    c.addEventListener('click', () => {
      currentFilter = c.dataset.filter;
      renderTasks();
      const active = $$('#smart-filters .fchip').find((x) => x.dataset.filter === currentFilter);
      if (active) active.focus();
    });
  });
  bindPressedGroupKeyboard(wrap, '.fchip[data-filter]');
}

/* ---------- 批量操作栏 ---------- */
function renderBatchBar() {
  const bar = $('#batch-bar');
  if (!bar) return;
  if (!batchMode) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const count = selectedIds.size;
  const completableCount = tasks.filter((t) => selectedIds.has(t.id) && t.status !== 'done' && t.status !== 'archived').length;
  $('#batch-count').textContent = count ? `已选 ${count} 项` : '请选择任务';
  const doneButton = $('#batch-done');
  doneButton.disabled = completableCount === 0;
  doneButton.textContent = completableCount ? `✓ 完成 ${completableCount} 项` : '✓ 完成';
  doneButton.title = count > completableCount ? '已完成或已归档任务将自动跳过' : '';
  $('#batch-pri').disabled = count === 0;
  $('#batch-delete').disabled = count === 0;
  const selectAll = $('#batch-select-all');
  const allSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((id) => selectedIds.has(id));
  selectAll.disabled = visibleTaskIds.length === 0;
  selectAll.textContent = allSelected ? '取消全选' : '全选当前';
}

function setBatchMode(enabled, shouldRender = true) {
  batchMode = enabled;
  selectedIds.clear();
  $('#view-tasks')?.classList.toggle('batch-mode', enabled);
  const trigger = $('#btn-select-mode');
  if (trigger) {
    trigger.setAttribute('aria-pressed', String(enabled));
    trigger.textContent = '批量操作';
    trigger.classList.toggle('hidden', enabled);
  }
  if (shouldRender) renderTasks();
}

/* ---------- 视图：看板 ---------- */
function renderBoard() {
  const cols = BOARD_COLUMNS;
  const boardTasks = tasks.filter((t) => !t._deleted && t.status !== 'archived');
  const grouped = Object.fromEntries(cols.map((col) => [
    col.k,
    boardTasks.filter((task) => task.status === col.k).sort((a, b) => b.pri - a.pri)
  ]));
  $('#board-sub').textContent = cols.map((col) => `${col.name} ${grouped[col.k].length}`).join(' · ');
  let html = '<div class="board-cols">';
  cols.forEach((col) => {
    const cards = grouped[col.k];
    const colId = `board-col-${col.k}`;
    html += `<section class="board-col" data-col="${col.k}" aria-labelledby="${colId}">
      <h3 class="bc-head" id="${colId}">${col.name} <span class="n">${cards.length}</span></h3>
      <div class="bc-cards${cards.length ? '' : ' is-empty'}" ${cards.length ? `role="list" aria-label="${col.name}任务"` : ''}>
        ${cards.map((t) => `
          <div class="bc-card-item" role="listitem">
            <button type="button" class="bc-card" draggable="true" data-id="${t.id}" title="编辑任务" aria-label="编辑任务：${esc(t.title)}">
              <span class="cb"><span class="nm">${esc(t.title)}</span><span class="pri-dot p${t.pri}" aria-label="优先级：${PRI_NAME[t.pri]}">${PRI_NAME[t.pri]}</span></span>
              ${t.due ? `<span class="cd${isOverdue(t.due, t.status) ? ' over' : ''}">${esc(t.due)}</span>` : ''}
              ${t.tags && t.tags.length ? `<span class="cd">${t.tags.map((x) => '#' + esc(x)).join(' ')}</span>` : ''}
              ${t.children && t.children.length ? `<span class="cd">子任务 ${childProgress(t).done}/${t.children.length}</span>` : ''}
            </button>
            <div class="bc-card-foot">
              <select class="bc-status" data-board-status data-id="${t.id}" aria-label="移动任务「${esc(t.title)}」到其他状态">
                ${cols.map((target) => `<option value="${target.k}" ${target.k === t.status ? 'selected' : ''}>${target.name}</option>`).join('')}
              </select>
            </div>
          </div>`).join('')}
        ${cards.length ? '' : `<div class="board-empty"><span role="status">暂无${col.name}任务</span>${!boardTasks.length && col.k === 'todo' ? '<button type="button" class="btn mini" id="board-new-task">新建任务</button>' : ''}</div>`}
      </div>
    </section>`;
  });
  html += '</div>';
  $('#board-cols').innerHTML = html;
  $('#board-new-task')?.addEventListener('click', () => openModal(null));
}

async function moveBoardTask(id, targetStatus, trigger) {
  const task = tasks.find((item) => item.id === parseInt(id, 10));
  if (!task || !BOARD_COLUMNS.some((column) => column.k === targetStatus)) return false;
  if (task.status === targetStatus) return true;
  const board = $('#board-cols');
  if (board) board.setAttribute('aria-busy', 'true');
  if (trigger) {
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
  }
  try {
    if (targetStatus === 'done') {
      await toggleDone(task);
    } else {
      await window.api.tasks.update(task.id, { status: targetStatus });
      toast(`「${task.title}」已移至「${STATE_NAME[targetStatus]}」`);
      await refreshTasksAfterMutation('任务状态已更新，但看板刷新失败');
    }
    if (trigger) {
      const nextTrigger = document.querySelector(`#board-cols [data-board-status][data-id="${task.id}"]`);
      if (nextTrigger) nextTrigger.focus();
    }
    return true;
  } catch (error) {
    console.error('[board] task move failed:', error);
    if (trigger) trigger.value = task.status;
    toast('移动任务失败，请稍后重试', 3000, null, 'err');
    return false;
  } finally {
    if (board) board.setAttribute('aria-busy', 'false');
    if (trigger) {
      trigger.disabled = false;
      trigger.setAttribute('aria-busy', 'false');
    }
  }
}

/* ---------- 视图：日历 ---------- */
function calKey(d) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function calendarDateFromKey(key) {
  const parts = String(key || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return calKey(date) === key ? date : null;
}
function shiftCalendarKey(key, dayDelta, monthDelta) {
  const date = calendarDateFromKey(key);
  if (!date) return null;
  if (monthDelta) {
    const day = date.getDate();
    const targetMonth = date.getMonth() + monthDelta;
    const lastDay = new Date(date.getFullYear(), targetMonth + 1, 0).getDate();
    date.setDate(1);
    date.setMonth(targetMonth);
    date.setDate(Math.min(day, lastDay));
  }
  if (dayDelta) date.setDate(date.getDate() + dayDelta);
  return calKey(date);
}
function calendarDayLabel(key, taskCount, isCurrentDay, isOtherMonth) {
  const date = calendarDateFromKey(key);
  if (!date) return key;
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  const taskText = taskCount ? `${taskCount} 项任务` : '无任务';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日，${weekday}，${taskText}${isCurrentDay ? '，今天' : ''}${isOtherMonth ? '，非本月' : ''}`;
}
function tasksOnDay(key) {
  return tasks.filter((t) => !t._deleted && t.status !== 'archived' && t.due && t.due.slice(0, 10) === key);
}
function focusCalendarCell(key) {
  const grid = $('#cal-body .cal-grid');
  if (!grid) return false;
  const cells = Array.from(grid.querySelectorAll('.cal-cell[data-day]'));
  const target = cells.find((cell) => cell.dataset.day === key);
  if (!target) return false;
  cells.forEach((cell) => { cell.tabIndex = cell === target ? 0 : -1; });
  calFocusDate = key;
  target.focus();
  return true;
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
  const cellKeys = new Set(cells.map((cell) => cell.key));
  const firstMonthKey = calKey(new Date(y, m, 1));
  const focusKey = cellKeys.has(calFocusDate)
    ? calFocusDate
    : cellKeys.has(todayKey) ? todayKey : firstMonthKey;
  calFocusDate = focusKey;

  let html = `<div class="cal-head">
    <div class="cal-nav">
      <button type="button" class="cal-btn" data-cal="prev" title="上个月" aria-label="上个月">‹</button>
      <button type="button" class="cal-btn" data-cal="today" title="回到本月" aria-label="回到本月">今</button>
      <button type="button" class="cal-btn" data-cal="next" title="下个月" aria-label="下个月">›</button>
    </div>
    <span class="cal-title" aria-live="polite">${y} 年 ${m + 1} 月</span>
  </div>
  <div class="cal-grid" role="grid" aria-label="${y}年${m + 1}月日历，使用方向键浏览日期">
    ${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<div class="cal-dow" role="columnheader">${w}</div>`).join('')}`;

  cells.forEach((c) => {
    const dayTasks = tasksOnDay(c.key);
    const cls = ['cal-cell', c.other ? 'other' : '', c.key === todayKey ? 'today' : '', calSelected === c.key ? 'selected' : ''].filter(Boolean).join(' ');
    const dots = dayTasks.map((t) => {
      const dotCls = t.status === 'done' ? 'done' : (isOverdue(t.due, t.status) ? 'over' : '');
      return `<span class="cal-dot ${dotCls}" aria-hidden="true"></span>`;
    }).join('');
    html += `<button type="button" role="gridcell" class="${cls}" data-day="${c.key}" tabindex="${c.key === focusKey ? 0 : -1}" aria-selected="${calSelected === c.key}" ${c.key === todayKey ? 'aria-current="date"' : ''} aria-label="${calendarDayLabel(c.key, dayTasks.length, c.key === todayKey, c.other)}">
      <span class="cal-day">${c.day}</span>
      ${dayTasks.length ? `<span class="cal-num">${dayTasks.length}</span>` : ''}
      ${dots ? `<span class="cal-dots">${dots}</span>` : ''}
    </button>`;
  });
  html += '</div>';

  if (calSelected) {
    const selTasks = tasksOnDay(calSelected);
    html += `<section class="cal-detail" aria-labelledby="cal-detail-title"><h3 class="cd-title" id="cal-detail-title">${calSelected} 的任务（${selTasks.length}）</h3>`;
    html += `<div class="cal-add-row"><button type="button" class="btn mini" id="cal-add-task">＋ 在该天新建任务</button></div>`;
    html += selTasks.length ? selTasks.map(rowHTML).join('') : '<div class="empty compact"><div class="big">◐</div><div class="empty-title">当天没有到期任务</div></div>';
    html += '</section>';
  }

  $('#cal-body').innerHTML = html;
  $('#cal-sub').textContent = calSelected ? `${calSelected} 明细` : `${m + 1} 月 · ${daysInMonth} 天`;
}

/* ---------- 视图：统计 ---------- */
function weeklyReportFileName(weekOffset) {
  const date = new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - (day - 1) + weekOffset * 7);
  const pad = (n) => String(n).padStart(2, '0');
  const weekName = weekOffset === -1 ? '上周' : weekOffset === 1 ? '下周' : '本周';
  return `工作周报-${weekName}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

function renderStat() {
  const all = tasks.filter((t) => !t._deleted && t.status !== 'archived');
  const done = all.filter((t) => t.status === 'done').length;
  const doing = all.filter((t) => t.status === 'doing').length;
  const rate = all.length ? Math.round(done / all.length * 100) + '%' : '0%';
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
  const recentDone = trend.reduce((sum, count) => sum + count, 0);
  $('#stat-sub').textContent = all.length
    ? `${all.length} 项未归档任务 · 近 7 天完成 ${recentDone} 项`
    : '暂无任务数据 · 可先创建一项任务';

  let html = '';
  if (!all.length) {
    html = `<div class="empty stat-empty">
      <div class="big" aria-hidden="true">◫</div>
      <div class="empty-title">还没有任务数据</div>
      <button type="button" class="btn mini" id="stat-new-task">新建任务</button>
    </div>`;
  } else {
    html = `<dl class="stat-grid">
      <div class="stat-card"><dt class="sc-t">任务总数</dt><dd class="sc-v">${all.length}</dd></div>
      <div class="stat-card"><dt class="sc-t">已完成</dt><dd class="sc-v">${done}</dd></div>
      <div class="stat-card"><dt class="sc-t">进行中</dt><dd class="sc-v">${doing}</dd></div>
      <div class="stat-card"><dt class="sc-t">完成率</dt><dd class="sc-v">${rate}</dd></div>
    </dl>`;
  // 近 7 天完成趋势（按真实 completedAt 统计）
  const maxTrend = Math.max(1, ...trend);
    html += `<div class="stat-chart-row">
    <section class="stat-panel">
      <h3 class="stat-panel-title">近 7 天完成趋势</h3>
      ${recentDone ? `<div class="trend-chart" role="list" aria-label="近 7 天完成数量">
        ${trend.map((v, i) => `
          <div class="trend-column" role="listitem" aria-label="${days[i]} 完成 ${v} 项">
            <span class="trend-value" aria-hidden="true">${v}</span>
            <span class="trend-bar" aria-hidden="true" style="--bar-h:${v ? Math.max(4, v / maxTrend * 120) : 0}px;--bar-opacity:${0.46 + i * 0.07}"></span>
            <span class="trend-label" aria-hidden="true">${days[i]}</span>
          </div>`).join('')}
      </div>` : '<div class="trend-chart is-empty" role="status">近 7 天还没有完成记录</div>'}
    </section>
    <section class="stat-panel">
      <h3 class="stat-panel-title">优先级分布</h3>
      <div class="metric-list">
        ${[4, 3, 2, 1].map((p) => {
          const n = all.filter((t) => t.pri === p).length;
          const pct = all.length ? Math.round(n / all.length * 100) : 0;
          return `<div class="metric-row">
            <span class="metric-name">${PRI_NAME[p]}</span>
            <span class="metric-track" role="meter" aria-label="${PRI_NAME[p]}任务占比" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="metric-fill priority-${p}" style="--meter:${pct}%"></span></span>
            <span class="metric-count">${n}</span>
          </div>`;
        }).join('')}
      </div>
    </section>
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
        <span class="tr-track" role="meter" aria-label="#${esc(d.name)}任务占比" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(d.count / all.length * 100)}"><span class="tr-fill" style="width:${pct}%"></span></span>
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
    html += `<div class="stat-chart-row stat-section-gap">
      <section class="stat-panel">
        <h3 class="stat-panel-title">项目完成率</h3>
        <div class="metric-list">
          ${projRank.map((d) => {
            const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
            return `<div class="metric-row wide-label">
              <span class="metric-name" title="${esc(d.name)}">◈ ${esc(d.name)}</span>
              <span class="metric-track" role="meter" aria-label="${esc(d.name)}项目完成率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="metric-fill" style="--meter:${pct}%"></span></span>
              <span class="metric-count rate">${d.done}/${d.total} ${pct}%</span>
            </div>`;
          }).join('')}
        </div>
      </section>
      <section class="stat-panel">
        <h3 class="stat-panel-title">标签完成率</h3>
        <div class="metric-list">
          ${tagRank.slice(0, 6).map((d) => {
            const tagged = all.filter((t) => (t.tags || []).includes(d.name));
            const doneN = tagged.filter((t) => t.status === 'done').length;
            const pct = tagged.length ? Math.round(doneN / tagged.length * 100) : 0;
            return `<div class="metric-row wide-label">
              <span class="metric-name" title="${esc(d.name)}">#${esc(d.name)}</span>
              <span class="metric-track tag" role="meter" aria-label="#${esc(d.name)}标签完成率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="metric-fill tag" style="--meter:${pct}%"></span></span>
              <span class="metric-count rate">${doneN}/${tagged.length} ${pct}%</span>
            </div>`;
          }).join('')}
        </div>
      </section>
    </div>`;
  }
  }

  // 周报生成
  html += `<section class="report-panel">
      <h3 class="stat-panel-title">周报生成</h3>
      <div class="report-actions">
        <div class="seg" id="report-week-seg" role="radiogroup" aria-label="周报周期">
          <button type="button" role="radio" aria-checked="${reportWeek === -1}" class="seg-it ${reportWeek === -1 ? 'active' : ''}" data-week="-1">上周</button>
          <button type="button" role="radio" aria-checked="${reportWeek === 0}" class="seg-it ${reportWeek === 0 ? 'active' : ''}" data-week="0">本周</button>
          <button type="button" role="radio" aria-checked="${reportWeek === 1}" class="seg-it ${reportWeek === 1 ? 'active' : ''}" data-week="1">下周</button>
        </div>
        <button type="button" class="btn mini" id="btn-report-gen">生成周报</button>
        <button type="button" class="btn mini ghost hidden" id="btn-report-copy">复制</button>
        <button type="button" class="btn mini ghost hidden" id="btn-report-download">下载 .md</button>
      </div>
      <div id="report-preview" class="report-preview hidden" role="region" aria-label="周报预览" tabindex="0"></div>
  </section>`;

  $('#stat-body').innerHTML = html;
  $('#stat-new-task')?.addEventListener('click', () => openModal(null));

  // 周报：选择周
  $$('#report-week-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', () => {
      $$('#report-week-seg .seg-it').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
      });
      seg.classList.add('active');
      seg.setAttribute('aria-checked', 'true');
      reportWeek = parseInt(seg.dataset.week, 10);
      $('#report-preview').textContent = '';
      $('#report-preview').classList.add('hidden');
      $('#btn-report-copy').classList.add('hidden');
      $('#btn-report-download').classList.add('hidden');
    });
  });
  bindRadioGroupKeyboard($('#report-week-seg'));
  // 周报：生成
  $('#btn-report-gen').addEventListener('click', async () => {
    const preview = $('#report-preview');
    const copyBtn = $('#btn-report-copy');
    const dlBtn = $('#btn-report-download');
    const generateBtn = $('#btn-report-gen');
    generateBtn.disabled = true;
    generateBtn.setAttribute('aria-busy', 'true');
    generateBtn.textContent = '生成中…';
    try {
      const md = await window.api.data.weeklyReport(reportWeek);
      preview.textContent = md;
      preview.classList.remove('hidden');
      copyBtn.classList.remove('hidden');
      dlBtn.classList.remove('hidden');
      preview.focus({ preventScroll: true });
      preview.scrollIntoView({ block: 'nearest' });
      toast('周报已生成');
    } catch (e) {
      console.error('[report] generation failed:', e);
      toast('周报生成失败，请稍后重试', 3000, null, 'err');
    } finally {
      generateBtn.disabled = false;
      generateBtn.setAttribute('aria-busy', 'false');
      generateBtn.textContent = '生成周报';
    }
  });
  // 周报：复制
  $('#btn-report-copy').addEventListener('click', async () => {
    const md = $('#report-preview').textContent;
    try {
      await navigator.clipboard.writeText(md);
      const copyBtn = $('#btn-report-copy');
      copyBtn.textContent = '已复制';
      setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制'; }, 1200);
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
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = weeklyReportFileName(reportWeek);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast('周报已下载');
  });
}

/* ---------- 视图：设置 ---------- */
function renderSettings() {
  const s = settings;
  const sw = (key, label, desc) => `
    <div class="set-row">
      <div><div class="sr-t">${label}</div><div class="sr-d">${desc}</div></div>
      <button type="button" class="switch ${s[key] ? 'on' : ''}" data-switch="${key}" role="switch" aria-checked="${!!s[key]}" aria-label="${label}"></button>
    </div>`;

  const providers = [
    { v: 'openai', n: 'OpenAI' },
    { v: 'deepseek', n: 'DeepSeek' },
    { v: 'opencode-go', n: 'OpenCode Go' },
    { v: 'custom', n: '自定义（OpenAI 兼容）' }
  ];

  let html = `<nav class="settings-nav" aria-label="设置章节">
    <button type="button" class="settings-nav-item" data-settings-target="settings-general">数据</button>
    <button type="button" class="settings-nav-item" data-settings-target="settings-assistant">助手</button>
    <button type="button" class="settings-nav-item" data-settings-target="settings-shortcuts">快捷键</button>
    <button type="button" class="settings-nav-item danger" data-settings-target="settings-danger">危险操作</button>
  </nav>
  <section class="set-group" id="settings-general" tabindex="-1" aria-labelledby="settings-general-title">
    <h3 class="set-group-title" id="settings-general-title">常规与数据</h3>
    <div class="set-row privacy-row">
      <div><div class="sr-t">本地数据</div><div class="sr-d">任务、备忘录、设置和对话记录保存在本机。使用真实模型时，当前输入、最近 6 轮对话、最多 30 条未归档任务和 20 条备忘录摘要会发送给所选服务商。</div></div>
      <span class="status-badge">本地存储</span>
    </div>
    ${sw('autoBackup', '自动备份', '每日 22:00 将数据快照备份到备份目录')}
    ${sw('autoStart', '开机自启', '登录系统后后台常驻，不弹主窗口')}
    ${sw('notify', '系统通知提醒', '任务到点经系统通知中心推送')}
    ${sw('petEnabled', '桌面桌宠', '常驻桌面最表层的可爱助手，可拖拽、气泡提醒')}
    <div class="set-row">
      <div><div class="sr-t">本地数据文件夹</div><div class="sr-d data-path" id="data-dir" title="${esc(s.dataDir || '')}">${esc(s.dataDir || '')}</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini ghost" id="btn-open-dir">打开文件夹</button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">导出与备份</div><div class="sr-d">JSON 包含任务与备忘录，CSV 仅包含任务</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini ghost" id="btn-export-json">导出 JSON</button>
        <button type="button" class="btn mini ghost" id="btn-export-csv">导出 CSV</button>
        <button type="button" class="btn mini ghost" id="btn-import-json">导入 JSON</button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">备份管理</div><div class="sr-d">查看自动备份，可一键恢复到任意备份点</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini" id="btn-backup-now">立即备份</button>
        <button type="button" class="btn mini ghost" id="btn-backup-to-dir">备份到文件夹</button>
        <button type="button" class="btn mini ghost" id="btn-restore-file">从文件恢复</button>
      </div>
    </div>
    <div class="backup-list" id="backup-list" role="region" aria-label="备份记录" aria-live="polite"></div>
    <div class="set-row">
      <div><div class="sr-t">外观主题</div><div class="sr-d">浅色 / 深色 / 跟随系统</div></div>
      <div class="seg" id="theme-seg" role="radiogroup" aria-label="外观主题">
        <button type="button" role="radio" aria-checked="${s.theme === 'light'}" class="seg-it ${s.theme === 'light' ? 'active' : ''}" data-theme="light">浅色</button>
        <button type="button" role="radio" aria-checked="${s.theme === 'dark'}" class="seg-it ${s.theme === 'dark' ? 'active' : ''}" data-theme="dark">深色</button>
        <button type="button" role="radio" aria-checked="${s.theme === 'auto'}" class="seg-it ${s.theme === 'auto' ? 'active' : ''}" data-theme="auto">自动</button>
      </div>
    </div>
  </section>

  <!-- AI 接入配置 -->
  <section class="set-group" id="settings-assistant" tabindex="-1" aria-labelledby="settings-assistant-title">
    <h3 class="set-group-title" id="settings-assistant-title">助手接入</h3>
    <div class="set-row">
      <div><div class="sr-t">AI 助手引擎</div><div class="sr-d">本地助手无需配置；真实模型负责理解意图，任务操作仍由本地执行</div></div>
      <div class="seg" id="ai-stage-seg" role="radiogroup" aria-label="AI 助手引擎">
        <button type="button" role="radio" aria-checked="${s.aiStage === 'mock'}" class="seg-it ${s.aiStage === 'mock' ? 'active' : ''}" data-stage="mock">本地助手</button>
        <button type="button" role="radio" aria-checked="${s.aiStage === 'llm'}" class="seg-it ${s.aiStage === 'llm' ? 'active' : ''}" data-stage="llm">真实模型</button>
      </div>
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-provider">供应商</label><div class="sr-d" id="ai-provider-desc">选择模型供应商，或自定义 OpenAI 兼容接口</div></div>
      <select id="ai-provider" class="setting-control" aria-describedby="ai-provider-desc">
        ${providers.map((p) => `<option value="${p.v}" ${s.aiProvider === p.v ? 'selected' : ''}>${p.n}</option>`).join('')}
      </select>
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-base-url">API Base URL</label><div class="sr-d" id="ai-base-url-desc">OpenAI 兼容接口地址</div></div>
      <input id="ai-base-url" class="setting-control wide" type="url" inputmode="url" autocomplete="off" spellcheck="false" aria-describedby="ai-base-url-desc" placeholder="https://api.openai.com/v1" value="${esc(s.aiBaseUrl || '')}">
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-api-key">API Key</label><div class="sr-d" id="ai-api-key-desc">保存在本机，请求时仅用于所选服务商鉴权</div></div>
      <input id="ai-api-key" class="setting-control wide" type="password" autocomplete="off" spellcheck="false" aria-describedby="ai-api-key-desc" placeholder="sk-..." value="${esc(s.aiApiKey || '')}">
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-model">模型名称</label><div class="sr-d" id="ai-model-desc">如 gpt-4o-mini / deepseek-chat</div></div>
      <input id="ai-model" class="setting-control wide" type="text" autocomplete="off" spellcheck="false" aria-describedby="ai-model-desc" placeholder="gpt-4o-mini" value="${esc(s.aiModel || '')}">
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-temperature">温度</label><div class="sr-d" id="ai-temperature-desc">越低越稳定，建议 0.2</div></div>
      <input id="ai-temperature" class="setting-control number" type="number" min="0" max="2" step="0.1" aria-describedby="ai-temperature-desc" value="${s.aiTemperature != null ? s.aiTemperature : 0.2}">
    </div>
    <div class="set-row ai-config-row">
      <div><div class="sr-t">连接测试</div><div class="sr-d" id="ai-test-result" role="status" aria-live="polite">未测试</div></div>
      <button type="button" class="btn mini ghost" id="btn-ai-test">测试连接</button>
    </div>
    <div class="set-row ai-config-row">
      <div><div class="sr-t">保存配置</div><div class="sr-d">保存后 AI 面板将使用所选引擎</div></div>
      <button type="button" class="btn mini" id="btn-ai-save">保存 AI 配置</button>
    </div>
  </section>

  <section class="set-group" id="settings-shortcuts" tabindex="-1" aria-labelledby="settings-shortcuts-title">
    <h3 class="set-group-title" id="settings-shortcuts-title">快捷键</h3>
    <p class="set-group-intro">全局有效。聚焦输入框后，直接按下新的组合键。</p>
    ${shortcutRow('sc-ai', '唤起助手输入框', s.shortcuts && s.shortcuts.ai || 'CommandOrControl+J')}
    ${shortcutRow('sc-newTask', '新建任务', s.shortcuts && s.shortcuts.newTask || 'CommandOrControl+N')}
    ${shortcutRow('sc-today', '打开今日视图', s.shortcuts && s.shortcuts.today || 'CommandOrControl+1')}
    ${shortcutRow('sc-stat', '打开统计视图', s.shortcuts && s.shortcuts.stat || 'CommandOrControl+5')}
  </section>
  <section class="set-group danger-zone" id="settings-danger" tabindex="-1" aria-labelledby="settings-danger-title">
    <h3 class="set-group-title" id="settings-danger-title">危险操作</h3>
    <div class="set-row">
      <div><div class="sr-t">重置演示任务</div><div class="sr-d">用初始演示任务替换当前全部任务，备忘录不受影响</div></div>
      <button type="button" class="btn mini danger" id="btn-reset">重置任务</button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">清空全部任务</div><div class="sr-d">删除所有任务（含已完成与归档），备忘录不受影响</div></div>
      <button type="button" class="btn mini danger" id="btn-clear-all">清空任务</button>
    </div>
  </section>`;

  $('#settings-body').innerHTML = html;
  bindSettingsEvents();
}

function focusSettingsSection(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  const content = target.closest('.content');
  const nav = $('#settings-body .settings-nav');
  if (content && nav) {
    const gap = 8;
    const offset = target.getBoundingClientRect().top - nav.getBoundingClientRect().bottom - gap;
    content.scrollTop += offset;
  }
  target.focus({ preventScroll: true });
  return true;
}

function bindSettingsEvents() {
  async function runSettingsAction(button, busyText, action, failureMessage) {
    if (!button || button.disabled) return;
    const idleText = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyText;
    try {
      await action();
    } catch (error) {
      console.error('[settings] action failed:', error);
      toast(failureMessage, 4000, null, 'err');
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = idleText;
    }
  }

  function downloadSettingsFile(content, type, fileName) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  $$('#settings-body [data-settings-target]').forEach((button) => {
    button.addEventListener('click', () => focusSettingsSection(button.dataset.settingsTarget));
  });

  $$('#settings-body .switch[data-switch]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const previous = sw.classList.contains('on');
      const on = sw.classList.toggle('on');
      sw.setAttribute('aria-checked', String(on));
      const key = sw.dataset.switch;
      settings[key] = on;
      sw.disabled = true;
      sw.setAttribute('aria-busy', 'true');
      try {
        await window.api.settings.update({ [key]: on });
        const names = { autoBackup: '自动备份', autoStart: '开机自启', notify: '系统通知提醒', petEnabled: '桌面桌宠' };
        toast(`已${on ? '开启' : '关闭'}「${names[key]}」`);
      } catch (error) {
        settings[key] = previous;
        sw.classList.toggle('on', previous);
        sw.setAttribute('aria-checked', String(previous));
        toast('设置保存失败，已恢复原状态', 3500, null, 'err');
      } finally {
        sw.disabled = false;
        sw.setAttribute('aria-busy', 'false');
      }
    });
  });

  // AI 引擎切换
  $$('#ai-stage-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', async () => {
      const previous = settings.aiStage || 'mock';
      $$('#ai-stage-seg .seg-it').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
      });
      seg.classList.add('active');
      seg.setAttribute('aria-checked', 'true');
      settings.aiStage = seg.dataset.stage;
      try {
        await window.api.settings.update({ aiStage: seg.dataset.stage });
        aiRuntimeState = null;
        syncAiConfigVisibility();
        updateAiBadge();
        toast(`AI 引擎已切换为「${seg.textContent}」`);
      } catch (error) {
        settings.aiStage = previous;
        $$('#ai-stage-seg .seg-it').forEach((x) => {
          const active = x.dataset.stage === previous;
          x.classList.toggle('active', active);
          x.setAttribute('aria-checked', String(active));
        });
        syncAiConfigVisibility();
        updateAiBadge();
        toast('AI 引擎切换失败，已恢复原设置', 3500, null, 'err');
      }
    });
  });
  bindRadioGroupKeyboard($('#ai-stage-seg'));

  function syncAiConfigVisibility() {
    const show = settings.aiStage === 'llm';
    $$('#settings-body .ai-config-row').forEach((row) => row.classList.toggle('hidden', !show));
  }
  syncAiConfigVisibility();

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
    const button = $('#btn-ai-test');
    resultEl.textContent = '测试中…';
    resultEl.className = 'sr-d test-result testing';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      // 先保存当前输入到设置，再测试
      await saveAiConfig(false);
      const res = await window.api.ai.test();
      resultEl.textContent = res.message;
      resultEl.className = `sr-d test-result ${res.ok ? 'success' : 'failure'}`;
      setAiRuntimeState(res.ok ? 'ready' : 'degraded');
    } catch (error) {
      resultEl.textContent = '测试失败，请检查配置或网络';
      resultEl.className = 'sr-d test-result failure';
      setAiRuntimeState('degraded');
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    }
  });

  // 保存 AI 配置
  $('#btn-ai-save').addEventListener('click', async () => {
    const button = $('#btn-ai-save');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await saveAiConfig(true);
    } catch (error) {
      toast('AI 配置保存失败，请重试', 3500, null, 'err');
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    }
  });

  async function saveAiConfig(showToast) {
    const temperature = parseFloat($('#ai-temperature').value);
    const patch = {
      aiProvider: $('#ai-provider').value,
      aiBaseUrl: $('#ai-base-url').value.trim(),
      // 清理 API Key 中的所有空白字符（粘贴时常带换行/空格）
      aiApiKey: $('#ai-api-key').value.replace(/\s+/g, '').trim(),
      aiModel: $('#ai-model').value.trim(),
      aiTemperature: Number.isFinite(temperature) ? temperature : 0.2
    };
    const previous = settings;
    settings = Object.assign({}, settings, patch);
    try {
      await window.api.settings.update(patch);
    } catch (error) {
      settings = previous;
      updateAiBadge();
      throw error;
    }
    if (showToast) toast('AI 配置已保存');
    aiRuntimeState = null;
    updateAiBadge();
  }

  $('#btn-export-json').addEventListener('click', () => {
    const button = $('#btn-export-json');
    runSettingsAction(button, '导出中…', async () => {
      const json = await window.api.data.exportJSON();
      downloadSettingsFile(json, 'application/json', `work-helper-${new Date().toISOString().slice(0, 10)}.json`);
      toast('已导出 JSON 备份', 2500, null, 'ok');
    }, 'JSON 导出失败，请稍后重试');
  });
  $('#btn-export-csv').addEventListener('click', () => {
    const button = $('#btn-export-csv');
    runSettingsAction(button, '导出中…', async () => {
      const csv = await window.api.data.exportCSV();
      downloadSettingsFile('\ufeff' + csv, 'text/csv;charset=utf-8', `work-helper-${new Date().toISOString().slice(0, 10)}.csv`);
      toast('已导出 CSV 表格', 2500, null, 'ok');
    }, 'CSV 导出失败，请稍后重试');
  });
  $('#btn-open-dir').addEventListener('click', async () => {
    const button = $('#btn-open-dir');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '打开中…';
    try {
      await window.api.data.openDir();
      toast('已打开本地数据文件夹');
    } catch (error) {
      console.error('[settings] open data folder failed:', error);
      toast('无法打开数据文件夹，请稍后重试', 3500, null, 'err');
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = '打开文件夹';
    }
  });
  const importButton = $('#btn-import-json');
  importButton.addEventListener('click', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      importButton.disabled = true;
      importButton.setAttribute('aria-busy', 'true');
      importButton.textContent = '导入中…';
      try {
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch (error) {
          toast(`无法读取导入文件：${error.message}`, 4000, null, 'err');
          return;
        }
        const taskList = Array.isArray(data) ? data : (Array.isArray(data.tasks) ? data.tasks : []);
        const memoList = Array.isArray(data) ? [] : (Array.isArray(data.memos) ? data.memos : []);
        if (!taskList.length && !memoList.length) {
          toast('导入文件为空或格式不正确', 3500, null, 'warn');
          return;
        }

        let imported = [];
        let importedMemos = [];
        try {
          if (taskList.length) imported = (await window.api.tasks.import(taskList)) || [];
        } catch (error) {
          toast(`任务导入失败：${error.message}`, 4000, null, 'err');
          return;
        }
        try {
          if (memoList.length) importedMemos = (await window.api.memos.import(memoList)) || [];
        } catch (error) {
          const partial = imported.length ? `已导入 ${imported.length} 条任务，但` : '';
          toast(`${partial}备忘录导入失败：${error.message}`, 5000, null, imported.length ? 'warn' : 'err');
          if (imported.length) await refreshTasksAfterMutation('任务已导入，但列表刷新失败');
          return;
        }

        const parts = [];
        if (imported.length) parts.push(`${imported.length} 条任务`);
        if (importedMemos.length) parts.push(`${importedMemos.length} 条备忘录`);
        toast(parts.length ? `已导入 ${parts.join('、')}` : '没有可导入的新内容', 3500, null, parts.length ? 'ok' : 'warn');
        await Promise.all([
          imported.length ? refreshTasksAfterMutation('任务已导入，但列表刷新失败') : Promise.resolve(),
          importedMemos.length ? refreshMemosAfterMutation('备忘录已导入，但列表刷新失败') : Promise.resolve()
        ]);
      } finally {
        importButton.disabled = false;
        importButton.setAttribute('aria-busy', 'false');
        importButton.textContent = '导入 JSON';
      }
    });
    input.click();
  });

  // 备份管理
  async function loadBackupList() {
    const box = $('#backup-list');
    if (!box) return;
    box.setAttribute('aria-busy', 'true');
    box.innerHTML = '<div class="load-state compact" role="status"><span class="load-indicator" aria-hidden="true"></span><div><strong>正在读取备份</strong></div></div>';
    try {
      const list = await window.api.data.listBackups();
      if (!list.length) {
        box.innerHTML = '<div class="backup-empty">暂无备份，点击「立即备份」创建第一份</div>';
        return;
      }
      box.innerHTML = list.map((b) => `
        <div class="backup-row">
          <span class="backup-time">${esc(b.time || b.name)}</span>
          <span class="backup-size">${(b.size / 1024).toFixed(1)} KB</span>
          <button type="button" class="btn mini ghost" data-restore="${esc(b.path)}">恢复</button>
        </div>`).join('');
      box.querySelectorAll('[data-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const filePath = btn.dataset.restore;
          confirmDialog('确定要恢复到该备份点吗？当前数据会先自动备份，然后被该备份覆盖。', async () => {
            if ((await saveMemoNow()) === false) return;
            const result = await window.api.data.restoreBackup(filePath);
            await reloadRestoredWorkspace(result, '已恢复到备份点');
          }, '恢复');
        });
      });
    } catch (e) {
      console.error('[settings] backup list failed:', e);
      box.innerHTML = '<div class="backup-empty error"><span>备份列表加载失败</span><button type="button" class="btn mini ghost" id="backup-retry">重试</button></div>';
      $('#backup-retry').addEventListener('click', loadBackupList);
    } finally {
      box.setAttribute('aria-busy', 'false');
    }
  }

  $('#btn-backup-now').addEventListener('click', () => {
    const button = $('#btn-backup-now');
    runSettingsAction(button, '备份中…', async () => {
      await window.api.data.backup();
      toast('已创建备份', 2500, null, 'ok');
      await loadBackupList();
    }, '备份失败，请稍后重试');
  });
  $('#btn-backup-to-dir').addEventListener('click', () => {
    const button = $('#btn-backup-to-dir');
    runSettingsAction(button, '选择中…', async () => {
      const res = await window.api.data.backupToDir();
      if (res.ok) toast(`已备份到：${res.file}`, 4000, null, 'ok');
      else if (res.error) throw new Error(res.error);
    }, '备份到文件夹失败，请稍后重试');
  });
  $('#btn-restore-file').addEventListener('click', () => {
    const button = $('#btn-restore-file');
    runSettingsAction(button, '选择中…', async () => {
      const res = await window.api.data.pickBackupFile();
      if (!res.ok) return;
      confirmDialog('确定要从该文件恢复吗？当前数据会先自动备份，然后被该文件覆盖。', async () => {
        if ((await saveMemoNow()) === false) return;
        const result = await window.api.data.restoreBackup(res.file);
        await reloadRestoredWorkspace(result, '已从文件恢复');
      }, '恢复');
    }, '无法选择备份文件，请稍后重试');
  });
  loadBackupList();
  $$('#theme-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', async () => {
      const previous = settings.theme || 'auto';
      $$('#theme-seg .seg-it').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
      });
      seg.classList.add('active');
      seg.setAttribute('aria-checked', 'true');
      settings.theme = seg.dataset.theme;
      applyTheme();
      try {
        await window.api.settings.update({ theme: seg.dataset.theme });
        toast(`主题已切换为「${seg.textContent}」`);
      } catch (error) {
        settings.theme = previous;
        $$('#theme-seg .seg-it').forEach((x) => {
          const active = x.dataset.theme === previous;
          x.classList.toggle('active', active);
          x.setAttribute('aria-checked', String(active));
        });
        applyTheme();
        toast('主题保存失败，已恢复原设置', 3500, null, 'err');
      }
    });
  });
  bindRadioGroupKeyboard($('#theme-seg'));
  $('#btn-reset').addEventListener('click', () => {
    confirmDialog('确定用初始演示任务替换当前全部任务吗？现有任务将被覆盖，备忘录不受影响。', async () => {
      tasks = await window.api.tasks.reset();
      renderAll();
      toast('任务已重置为演示数据', 3000, null, 'ok');
    }, '重置');
  });
  $('#btn-clear-all').addEventListener('click', async () => {
    confirmDialog('确定要清空全部任务吗？此操作不可恢复，备忘录不受影响。', async () => {
      tasks = await window.api.tasks.clearAll();
      renderAll();
      toast('已清空全部任务', 3000, null, 'ok');
    }, '清空任务');
  });

  // 快捷键自定义：保留现有值，聚焦后直接录入新组合键。
  ['sc-ai', 'sc-newTask', 'sc-today', 'sc-stat'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('focus', () => {
      el.placeholder = '按下新组合键…';
      el.select();
    });
    el.addEventListener('blur', () => {
      el.value = shortcutLabel(el.dataset.accelerator);
      el.placeholder = 'Ctrl+J';
    });
    el.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        el.blur();
        return;
      }
      e.preventDefault();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const mods = [];
      if (e.ctrlKey) mods.push('CommandOrControl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!mods.length) {
        el.value = shortcutLabel(el.dataset.accelerator);
        el.placeholder = '需要包含修饰键（Ctrl/Alt/Shift）';
        return;
      }
      const combo = [...mods, key].join('+');
      const previousAccelerator = el.dataset.accelerator;
      const previousShortcuts = Object.assign({}, settings.shortcuts || {});
      el.dataset.accelerator = combo;
      el.value = shortcutLabel(combo);
      el.placeholder = 'Ctrl+J';
      const keyMap = { 'sc-ai': 'ai', 'sc-newTask': 'newTask', 'sc-today': 'today', 'sc-stat': 'stat' };
      const shortcuts = Object.assign({}, previousShortcuts, { [keyMap[id]]: combo });
      settings.shortcuts = shortcuts;
      try {
        await window.api.settings.update({ shortcuts });
        toast(`快捷键已更新：${shortcutLabel(combo)}`, 2500, null, 'ok');
        el.blur();
      } catch (error) {
        settings.shortcuts = previousShortcuts;
        el.dataset.accelerator = previousAccelerator;
        el.value = shortcutLabel(previousAccelerator);
        toast('快捷键保存失败，已恢复原设置', 3500, null, 'err');
      }
    });
  });
}

function shortcutLabel(accelerator) {
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || '');
  return String(accelerator || '').split('+').map((part) => {
    if (part === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
    if (part === 'Super') return isMac ? '⌘' : 'Win';
    return part;
  }).join('+');
}

function shortcutRow(id, label, accelerator) {
  return `<div class="shortcut-row"><label for="${id}">${label}</label><input class="shortcut-input" id="${id}" data-accelerator="${esc(accelerator)}" value="${esc(shortcutLabel(accelerator))}" placeholder="Ctrl+J"></div>`;
}

function applyTheme() {
  const t = settings.theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
}

/* ---------- 备忘录 ---------- */
function parseMemoTags(value) {
  return String(value || '').split(/[，,\s]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 5);
}

function memoTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const today = new Date();
  if (localDateKey(ts) === localDateKey(today.getTime())) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function currentMemo() {
  return memos.find((memo) => memo.id === selectedMemoId) || null;
}

function memoDraft() {
  return {
    title: $('#memo-title').value.trim() || '无标题备忘录',
    content: $('#memo-content').value,
    tags: parseMemoTags($('#memo-tags').value)
  };
}

function visibleMemos() {
  const query = memoSearch.trim().toLowerCase();
  return memos
    .filter((memo) => {
      if (!query) return true;
      return [memo.title, memo.content, ...(memo.tags || [])].join(' ').toLowerCase().includes(query);
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function focusMemoListItem(id) {
  const list = $('#memo-list');
  if (!list) return false;
  const items = Array.from(list.querySelectorAll('[data-memo-id]'));
  const target = items.find((item) => parseInt(item.dataset.memoId, 10) === id);
  if (!target) return false;
  items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
  memoFocusId = id;
  target.focus();
  return true;
}

function renderMemoList() {
  const list = $('#memo-list');
  if (!list) return;
  const query = memoSearch.trim().toLowerCase();
  const visible = visibleMemos();
  $('#memos-sub').textContent = `${memos.length} 条${memos.some((memo) => memo.pinned) ? ' · 含置顶' : ''}`;
  if (!visible.length) {
    list.innerHTML = `<div class="memo-list-empty">${query ? '没有匹配的备忘录' : '暂无备忘录'}</div>`;
    return;
  }
  const visibleIds = new Set(visible.map((memo) => memo.id));
  const focusId = visibleIds.has(memoFocusId)
    ? memoFocusId
    : visibleIds.has(selectedMemoId) ? selectedMemoId : visible[0].id;
  memoFocusId = focusId;
  list.innerHTML = visible.map((memo) => {
    const preview = memo.content.trim().replace(/\s+/g, ' ') || (memo.tags || []).map((tag) => `#${tag}`).join(' ') || '空白备忘录';
    return `<button type="button" class="memo-list-item${memo.id === selectedMemoId ? ' active' : ''}${memo.pinned ? ' pinned' : ''}" data-memo-id="${memo.id}" role="option" tabindex="${memo.id === focusId ? 0 : -1}" aria-selected="${memo.id === selectedMemoId}">
      <span class="memo-list-title">${esc(memo.title)}</span>
      <span class="memo-list-preview">${esc(preview)}</span>
      <span class="memo-list-time">${memo.pinned ? '置顶 · ' : ''}${esc(memoTime(memo.updatedAt))}</span>
    </button>`;
  }).join('');
}

function renderMemoEditor() {
  const memo = currentMemo();
  $('#memo-empty').classList.toggle('hidden', !!memo);
  $('#memo-editor').classList.toggle('hidden', !memo);
  if (!memo) return;
  const copyButton = $('#memo-copy');
  copyButton.classList.remove('copied');
  copyButton.querySelector('span').textContent = '⧉';
  copyButton.dataset.tooltip = '复制';
  copyButton.disabled = false;
  $('#memo-title').value = memo.title;
  $('#memo-content').value = memo.content || '';
  $('#memo-tags').value = (memo.tags || []).join(' ');
  $('#memo-pin').classList.toggle('active', !!memo.pinned);
  $('#memo-pin').setAttribute('aria-pressed', String(!!memo.pinned));
  $('#memo-pin').setAttribute('aria-label', memo.pinned ? '取消置顶备忘录' : '置顶备忘录');
  $('#memo-pin').dataset.tooltip = memo.pinned ? '取消置顶' : '置顶';
  $('#memo-save-state').textContent = '已保存';
  $('#memo-updated').textContent = `最近编辑 ${memoTime(memo.updatedAt)}`;
  memoDirty = false;
}

function renderMemos() {
  if (selectedMemoId && !currentMemo()) {
    selectedMemoId = null;
    memoFocusId = null;
  }
  if (!selectedMemoId && memos.length) {
    selectedMemoId = memos[0].id;
    memoFocusId = selectedMemoId;
  }
  renderMemoList();
  if (!memoDirty) renderMemoEditor();
}

function saveMemoNow() {
  if (memoSaveTimer) {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = null;
  }
  if (!memoDirty) return memoSaveChain;
  const id = selectedMemoId;
  if (!id || !currentMemo() || $('#memo-editor').classList.contains('hidden')) return memoSaveChain;
  const patch = memoDraft();
  memoDirty = false;
  $('#memo-save-state').textContent = '保存中…';
  memoSaveChain = memoSaveChain.then(async () => {
    const updated = await window.api.memos.update(id, patch);
    const index = memos.findIndex((memo) => memo.id === id);
    if (index >= 0) memos[index] = updated;
    memos.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    renderMemoList();
    if (selectedMemoId === id) {
      $('#memo-save-state').textContent = '已保存';
      $('#memo-updated').textContent = `最近编辑 ${memoTime(updated.updatedAt)}`;
    }
  }).catch((error) => {
    memoDirty = true;
    if (selectedMemoId === id) $('#memo-save-state').textContent = '保存失败';
    toast(`备忘录保存失败：${error.message}`, 4000, null, 'err');
    return false;
  });
  return memoSaveChain;
}

function scheduleMemoSave() {
  memoDirty = true;
  $('#memo-save-state').textContent = '等待保存…';
  if (memoSaveTimer) clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(saveMemoNow, 450);
}

async function selectMemo(id, restoreFocus) {
  if ((await saveMemoNow()) === false) return false;
  selectedMemoId = id;
  memoFocusId = id;
  renderMemoList();
  renderMemoEditor();
  if (restoreFocus) focusMemoListItem(id);
  return true;
}

async function onMemoListKeyDown(event) {
  const item = event.target.closest('[data-memo-id]');
  if (!item) return;
  const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(item.closest('#memo-list').querySelectorAll('[data-memo-id]'));
  const index = items.indexOf(item);
  let nextIndex = index;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = items.length - 1;
  else if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
  else nextIndex = Math.min(items.length - 1, index + 1);
  const targetId = parseInt(items[nextIndex].dataset.memoId, 10);
  await selectMemo(targetId, true);
}

async function createMemo() {
  if (memoCreating || (await saveMemoNow()) === false) return;
  memoCreating = true;
  $('#memo-new').disabled = true;
  $('#memo-empty-new').disabled = true;
  try {
    const memo = await window.api.memos.create({ title: '无标题备忘录', content: '', tags: [] });
    memos.unshift(memo);
    selectedMemoId = memo.id;
    memoFocusId = memo.id;
    renderMemos();
    $('#memo-title').select();
  } catch (error) {
    toast(`新建备忘录失败：${error.message}`, 4000, null, 'err');
  } finally {
    memoCreating = false;
    $('#memo-new').disabled = false;
    $('#memo-empty-new').disabled = false;
  }
}

async function refreshMemos() {
  if ((await saveMemoNow()) === false) return false;
  try {
    memos = await window.api.memos.getAll();
    dataLoadErrors.memos = null;
    try { deletedMemos = await window.api.memos.getDeleted(); } catch (e) { /* 忽略 */ }
    renderMemos();
    renderNavBadges();
    applyDataLoadStates();
    return true;
  } catch (error) {
    dataLoadErrors.memos = error;
    applyDataLoadStates();
    throw error;
  }
}

async function refreshMemosAfterMutation(message) {
  try {
    const refreshed = await refreshMemos();
    if (refreshed === false) {
      toast(`${message}：仍有备忘录未保存`, 5000, null, 'warn');
      return false;
    }
    return true;
  } catch (error) {
    toast(`${message}：${error.message}`, 5000, null, 'warn');
    return false;
  }
}

async function reloadRestoredWorkspace(result, label) {
  if (memoSaveTimer) clearTimeout(memoSaveTimer);
  memoSaveTimer = null;
  memoDirty = false;
  memoSaveChain = Promise.resolve();

  const [taskResult, memoResult, taskTrashResult, memoTrashResult] = await Promise.allSettled([
    window.api.tasks.getAll(),
    window.api.memos.getAll(),
    window.api.tasks.getDeleted(),
    window.api.memos.getDeleted()
  ]);
  tasks = taskResult.status === 'fulfilled' ? taskResult.value : [];
  memos = memoResult.status === 'fulfilled' ? memoResult.value : [];
  trashList = taskTrashResult.status === 'fulfilled' ? taskTrashResult.value : [];
  deletedMemos = memoTrashResult.status === 'fulfilled' ? memoTrashResult.value : [];
  dataLoadErrors.tasks = taskResult.status === 'rejected' ? taskResult.reason : null;
  dataLoadErrors.memos = memoResult.status === 'rejected' ? memoResult.reason : null;
  if (!memos.some((memo) => memo.id === selectedMemoId)) {
    selectedMemoId = memos.length ? memos[0].id : null;
    memoFocusId = selectedMemoId;
  }
  renderAll();

  toast(`${label}（${result.count} 条任务、${result.memoCount || 0} 条备忘录）`, 3500, null, 'ok');
  if (dataLoadErrors.tasks || dataLoadErrors.memos) {
    toast('数据已经恢复，但界面未完整刷新，请使用页面中的重试按钮', 5000, null, 'warn');
  }
}

/* ---------- 视图切换 ---------- */
function switchView(view) {
  if (currentView === 'memos' && view !== 'memos') saveMemoNow();
  currentView = view;
  $$('.nav-item').forEach((n) => {
    const active = n.dataset.view === view;
    n.classList.toggle('active', active);
    if (active) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
  $$('.view').forEach((v) => { v.style.display = v.id === `view-${view}` ? '' : 'none'; });
  const content = $('.content');
  if (content) content.scrollTop = 0;
  // 切换视图时退出批量模式，避免隐藏选择残留。
  setBatchMode(false, false);
  // 视图切换动画
  const activeView = document.getElementById(`view-${view}`);
  if (activeView) {
    activeView.classList.remove('view-enter');
    void activeView.offsetWidth;
    activeView.classList.add('view-enter');
  }
  // 标题栏显示当前视图名
  const viewNames = { today: '今天', tasks: '所有任务', memos: '备忘录', board: '看板', cal: '日历', stat: '统计', trash: '回收站', settings: '设置' };
  const tbTitle = $('#tb-title');
  if (tbTitle) tbTitle.textContent = `工作台助手 · ${viewNames[view] || ''}`;
  if (view === 'today') renderToday();
  if (view === 'tasks') renderTasks();
  if (view === 'memos') renderMemos();
  if (view === 'board') renderBoard();
  if (view === 'cal') renderCal();
  if (view === 'stat') renderStat();
  if (view === 'settings') renderSettings();
  if (view === 'trash') loadTrash();
  applyDataLoadStates();
}

/* ---------- 侧边栏计数徽标 ---------- */
function renderNavBadges() {
  const active = tasks.filter((t) => !t._deleted && t.status !== 'done' && t.status !== 'archived').length;
  const trashCount = trashList.length + deletedMemos.length;
  const todayCount = tasks.filter((t) => !t._deleted && t.status !== 'done' && t.status !== 'archived' && isToday(t.due)).length;
  const badge = (view, count) => {
    const el = document.querySelector(`.nav-item[data-view="${view}"] .nav-badge`);
    if (!el) return;
    el.textContent = count > 99 ? '99+' : count;
    el.classList.toggle('hidden', count <= 0);
  };
  badge('today', todayCount);
  badge('tasks', active);
  badge('memos', memos.length);
  badge('trash', trashCount);
}

/* ---------- 标题栏最大化按钮 ---------- */
function updateMaxBtn(maximized) {
  const btn = $('#tb-max');
  if (!btn) return;
  btn.textContent = maximized ? '❐' : '□';
  btn.title = maximized ? '还原' : '最大化';
  btn.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口');
}

/* ---------- 弹窗 ---------- */
function splitDue(due) {
  // "YYYY-MM-DD HH:mm" → { date: "YYYY-MM-DD", time: "HH:mm" }
  if (!due) return { date: '', time: '18:00' };
  const m = String(due).match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
  return { date: m ? m[1] : '', time: m && m[2] ? m[2] : '18:00' };
}

function openModal(task) {
  const active = document.activeElement;
  modalReturnFocus = {
    element: active,
    selector: task ? `.task-row[data-id="${task.id}"] .task-title-btn` : (active && active.id ? `#${active.id}` : '#btn-new')
  };
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
  setTitleError('');
  setModalError('');
  setModalBusy(false);
  captureModalInitialState();
  const mask = $('#modal-mask');
  mask.classList.remove('hidden');
  mask.setAttribute('aria-hidden', 'false');
  $('#m-title').focus();
}

function restoreModalFocus() {
  if (!modalReturnFocus) return;
  const target = modalReturnFocus.element && modalReturnFocus.element.isConnected
    ? modalReturnFocus.element
    : $(modalReturnFocus.selector);
  modalReturnFocus = null;
  if (target) target.focus({ preventScroll: true });
}

function closeModal(shouldRestoreFocus = true) {
  if (modalSaving) return;
  const mask = $('#modal-mask');
  mask.classList.add('hidden');
  mask.setAttribute('aria-hidden', 'true');
  editingTask = null;
  modalInitialSnapshot = '';
  if (shouldRestoreFocus) restoreModalFocus();
}

function taskFormSnapshot() {
  return $$('#task-form input, #task-form select, #task-form textarea')
    .map((field) => `${field.id}:${field.value}`)
    .join('\u001f');
}

function captureModalInitialState() {
  modalInitialSnapshot = taskFormSnapshot();
}

function isTaskModalDirty() {
  return !$('#modal-mask').classList.contains('hidden') && taskFormSnapshot() !== modalInitialSnapshot;
}

function requestCloseModal() {
  if (modalSaving) return;
  if (!isTaskModalDirty()) {
    closeModal();
    return;
  }
  confirmDialog('放弃尚未保存的更改吗？', async () => closeModal(), '放弃');
}

function setTitleError(message) {
  const title = $('#m-title');
  const error = $('#m-title-error');
  title.setAttribute('aria-invalid', String(!!message));
  error.textContent = message || '';
  error.classList.toggle('hidden', !message);
}

function setModalError(message) {
  const error = $('#modal-error');
  error.textContent = message || '';
  error.classList.toggle('hidden', !message);
}

function setModalBusy(busy) {
  modalSaving = busy;
  const save = $('#m-save');
  save.disabled = busy;
  save.setAttribute('aria-busy', String(busy));
  save.textContent = busy ? '保存中…' : (editingTask ? '保存' : '创建');
  $$('#task-form button[type="button"]').forEach((button) => { button.disabled = busy; });
}

async function saveModal(event) {
  if (event) event.preventDefault();
  if (modalSaving) return;
  const title = $('#m-title').value.trim();
  if (!title) {
    setTitleError('请输入任务标题');
    $('#m-title').focus();
    return;
  }
  setTitleError('');
  setModalError('');
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
  const wasEditing = !!editingTask;
  const shouldComplete = data.status === 'done' && (!editingTask || editingTask.status !== 'done');
  let completion = null;
  try {
    setModalBusy(true);
    if (shouldComplete) {
      completion = await window.api.tasks.saveAndComplete(editingTask ? editingTask.id : null, data);
    } else if (editingTask) {
      await window.api.tasks.update(editingTask.id, data);
    } else {
      await window.api.tasks.create(data);
    }
  } catch (err) {
    console.error('[task-modal] save failed:', err);
    setModalError('保存失败，请稍后重试。任务内容仍保留在窗口中。');
    return;
  } finally {
    setModalBusy(false);
  }
  closeModal(false);
  restoreModalFocus();
  const nextText = completion && completion.next ? ` · 已安排下一次（${completion.next.due}）` : '';
  toast(`${wasEditing ? '已保存' : '已创建'}「${title}」${nextText}`, nextText ? 5000 : 3000, null, 'ok');
  await refreshTasksAfterMutation(`任务已${wasEditing ? '保存' : '创建'}，但列表刷新失败`);
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
      toast('已恢复');
      await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
    }
  }]);
  await refreshTasksAfterMutation('任务已删除，但列表刷新失败');
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
      toast('已恢复');
      await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
    }
  }]);
  await refreshTasksAfterMutation('任务已归档，但列表刷新失败');
}

async function unarchiveEditingTask() {
  if (!editingTask) return;
  const id = editingTask.id;
  closeModal();
  await window.api.tasks.unarchive(id);
  toast('已恢复为待办');
  await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
}

/* ---------- AI 对话 ---------- */
async function copyMessageText(button, body) {
  try {
    await navigator.clipboard.writeText(body.textContent || '');
    const previous = button.textContent;
    button.textContent = '✓';
    button.classList.add('copied');
    button.title = '已复制';
    button.setAttribute('aria-label', '已复制');
    setTimeout(() => {
      button.textContent = previous;
      button.classList.remove('copied');
      button.title = '复制消息';
      button.setAttribute('aria-label', '复制消息');
    }, 1200);
  } catch (e) {
    console.error('[assistant] copy failed:', e);
    toast('复制失败，请重试', 4000, null, 'err');
  }
}

function createMessage(role, text, ts) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.setAttribute('role', 'article');
  const body = document.createElement('span');
  body.className = 'msg-text';
  body.textContent = text;
  const meta = document.createElement('span');
  meta.className = 'mt';
  const timeText = new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  meta.textContent = timeText;
  el.setAttribute('aria-label', `${role === 'user' ? '你' : '工作台助手'}，${timeText}`);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-copy';
  copy.textContent = '⧉';
  copy.title = '复制消息';
  copy.setAttribute('aria-label', '复制消息');
  copy.setAttribute('aria-live', 'polite');
  copy.addEventListener('click', () => copyMessageText(copy, body));
  const footer = document.createElement('span');
  footer.className = 'msg-footer';
  footer.append(meta, copy);
  el.append(body, footer);
  return el;
}

function scrollChat() {
  const chat = $('#ai-chat');
  chat.scrollTop = chat.scrollHeight;
}

function addMsg(role, text, extra) {
  const chat = $('#ai-chat');
  const el = createMessage(role, text);
  if (extra) el.appendChild(extra);
  chat.appendChild(el);
  scrollChat();
  return el;
}

function setAiBusy(busy) {
  aiSending = busy;
  const chat = $('#ai-chat');
  const send = $('#ai-send');
  chat.setAttribute('aria-busy', String(busy));
  send.disabled = busy;
  send.setAttribute('aria-busy', String(busy));
  send.textContent = busy ? '处理中…' : '发送';
  const clear = $('#ai-clear');
  if (clear) clear.disabled = busy;
  $$('#ai-chips .chip').forEach((chip) => { chip.disabled = busy; });
  $$('.turn-action').forEach((action) => { action.disabled = busy; });
}

function resizeAiInput() {
  const input = $('#ai-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
}

function opCard(result) {
  const card = document.createElement('div');
  card.className = 'op-card';
  const titles = {
    create: '已创建',
    complete: '已完成',
    start: '已开始',
    delete: '已删除',
    archive: '已归档',
    split: '已拆分',
    update: '已更新',
    child: '已添加子任务',
    postpone: '已顺延',
    restore: '已恢复',
    memo_create: '已记录',
    memo_delete: '已删除备忘录',
    memo_pin: result.memo && result.memo.pinned ? '已置顶' : '已取消置顶',
    memo_to_task: '已转为任务',
    memo_split: '已拆成任务'
  };
  card.innerHTML = `<div class="op-title">${titles[result.type] || '操作'}</div>`;
  if (result.undoable && result.undo) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'undo';
    undo.textContent = '撤销';
    undo.addEventListener('click', async () => {
      try {
        const undoResult = await window.api.ai.undo(result.undo);
        if (undoResult && undoResult.ok === false) {
          toast(undoResult.message || '无法撤销', 4000, null, 'warn');
          undo.remove();
          return;
        }
        await Promise.all([refreshTasks(), refreshMemos()]);
        toast('已撤销');
        card.remove();
      } catch (e) {
        toast(`撤销失败：${e.message}`, 4000, null, 'err');
      }
    });
    card.appendChild(undo);
  }
  return card;
}

function turnActions(items, label) {
  const bar = document.createElement('div');
  bar.className = 'turn-actions';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', label || '下一步');
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `turn-action${item.kind ? ` ${item.kind}` : ''}`;
    button.textContent = item.label;
    button.disabled = aiSending;
    button.addEventListener('click', item.run);
    bar.appendChild(button);
  });
  return bar;
}

function getFollowUps(result) {
  if (!result || !Array.isArray(result.followUps)) return [];
  return result.followUps
    .filter((item) => item && typeof item.label === 'string' && typeof item.prompt === 'string')
    .slice(0, 2);
}

function clearTurnActions() {
  $$('#ai-chat .turn-actions').forEach((actions) => actions.remove());
}

function setAiContext(type) {
  const context = $('#ai-context');
  const text = $('#ai-context-text');
  if (!context || !text) return;
  const labels = {
    ask: '等待选择 · 选择后继续原操作',
    confirm: '等待确认 · 任务尚未执行',
    clarify: '等待补充 · 回答上一个问题即可继续',
    error: '请求未完成 · 可重试或检查模型'
  };
  const label = labels[type];
  context.classList.toggle('hidden', !label);
  if (label) context.dataset.state = type;
  else delete context.dataset.state;
  text.textContent = label || '';
  const input = $('#ai-input');
  if (!input) return;
  const placeholders = {
    ask: '选择上方候选，或输入更完整的标题…',
    confirm: '也可以输入“确认执行”或“取消”…',
    clarify: '继续补充刚才缺少的信息…'
  };
  input.placeholder = placeholders[type] || '描述任务，或继续补充…';
}

function setAiRuntimeState(state) {
  aiRuntimeState = ['ready', 'degraded'].includes(state) ? state : null;
  updateAiBadge();
}

function openAiSettings() {
  switchView('settings');
  setTimeout(() => {
    const target = $('#btn-ai-test') || $('#ai-stage-seg');
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus();
  }, 0);
}

function assistantStatusSummary() {
  if (dataLoadErrors.tasks) return '任务数据暂时无法读取，恢复后我会同步最新工作状态。';
  const active = tasks.filter((task) => !task._deleted && task.status !== 'done' && task.status !== 'archived');
  const byDue = (a, b) => String(a.due || '').localeCompare(String(b.due || ''));
  const overdue = active.filter((task) => isOverdue(task.due, task.status)).sort(byDue);
  const dueToday = active.filter((task) => isToday(task.due)).sort(byDue);
  if (overdue.length) return `当前有 ${overdue.length} 项逾期任务，建议先处理「${overdue[0].title}」。`;
  if (dueToday.length) return `今天还有 ${dueToday.length} 项任务，下一项是「${dueToday[0].title}」。`;
  if (active.length) return `当前有 ${active.length} 项待办，今天没有到期任务。`;
  return '当前没有待办任务。';
}

function clearAssistantConversation() {
  confirmDialog('清空当前对话吗？任务和备忘录不会受影响。', async () => {
    await window.api.chat.clear();
    clearTurnActions();
    setAiContext(null);
    setAiRuntimeState(null);
    $('#ai-chat').innerHTML = '';
    addMsg('ai', assistantStatusSummary());
    $('#ai-input').focus();
    toast('对话已清空', 2500, null, 'ok');
  }, '清空对话');
}

function candidateLabel(candidate) {
  const context = [];
  if (candidate.entityType === 'memo') {
    if (candidate.pinned) context.push('置顶');
    if (candidate.preview) context.push(candidate.preview);
  }
  if (candidate.project) context.push(`◈ ${candidate.project}`);
  if (candidate.due) context.push(candidate.due);
  if (candidate.status) context.push(STATE_NAME[candidate.status] || candidate.status);
  return context.length ? `${candidate.title} · ${context.join(' · ')}` : candidate.title;
}

function retryAction(retry) {
  let actions;
  actions = turnActions([{
    label: '重试',
    run: () => {
      actions.remove();
      retry();
    }
  }], '错误恢复');
  return actions;
}

function assistantRequestFailureMessage() {
  return settings.aiStage === 'llm'
    ? '模型暂时没有响应。请检查网络和模型配置后重试。'
    : '助手暂时没有响应。请重试一次。';
}

async function runAiTurn(request, retry) {
  if (aiSending) return;
  setAiContext(null);
  setAiBusy(true);
  const pending = addMsg('ai', '正在理解…');
  pending.classList.add('pending');
  try {
    let result;
    try {
      result = await request();
    } catch (e) {
      console.error('[assistant] request failed:', e);
      pending.classList.remove('pending');
      pending.classList.add('error');
      pending.querySelector('.msg-text').textContent = assistantRequestFailureMessage();
      pending.appendChild(retryAction(retry));
      setAiContext('error');
      if (settings.aiStage === 'llm') setAiRuntimeState('degraded');
      return;
    }

    try {
      pending.classList.remove('pending', 'error');
      pending.querySelector('.msg-text').textContent = result.message;
      if (settings.aiStage === 'llm') setAiRuntimeState(result.degraded ? 'degraded' : 'ready');

      if (result.degraded) {
        const tip = document.createElement('div');
        tip.className = 'ai-notice';
        const noticeText = document.createElement('span');
        noticeText.textContent = result.degradeNotice || '模型服务短暂异常，本轮已由本地助手继续处理';
        const settingsButton = document.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'ai-notice-action';
        settingsButton.textContent = '检查模型';
        settingsButton.addEventListener('click', openAiSettings);
        tip.append(noticeText, settingsButton);
        pending.appendChild(tip);
      }

      const operationTypes = ['create', 'memo_create', 'memo_delete', 'memo_pin', 'memo_to_task', 'memo_split', 'complete', 'start', 'delete', 'archive', 'split', 'update', 'child', 'postpone', 'restore'];
      if (operationTypes.includes(result.type)) pending.appendChild(opCard(result));
      if (String(result.type).startsWith('memo_')) await refreshMemos();

      if (result.type === 'ask' && result.candidates && result.candidates.length) {
        const choices = turnActions(result.candidates.map((candidate) => {
          const label = candidateLabel(candidate);
          return {
            label,
            run: async () => {
              choices.querySelectorAll('button').forEach((button) => { button.disabled = true; });
              choices.remove();
              await resolveCandidate(result, candidate, label);
            }
          };
        }), result.candidates.some((candidate) => candidate.entityType === 'memo') ? '选择备忘录' : '选择任务');
        pending.appendChild(choices);
        setAiContext('ask');
      } else if (result.type === 'confirm') {
        pending.appendChild(turnActions([
          { label: '确认执行', kind: 'primary', run: () => sendPrompt('确认执行') },
          { label: '取消', kind: 'quiet', run: () => sendPrompt('取消') }
        ], '确认操作'));
        setAiContext('confirm');
      } else if (result.type === 'clarify') {
        setAiContext('clarify');
      } else {
        setAiContext(null);
        const followUps = getFollowUps(result);
        if (followUps.length) {
          pending.appendChild(turnActions(followUps.map((item) => ({
            label: item.label,
            run: () => sendPrompt(item.prompt)
          }))));
        }
      }
    } catch (e) {
      console.error('[assistant] response rendering failed:', e);
      pending.classList.remove('pending');
      pending.querySelector('.msg-text').textContent = result.message;
      toast('回复已收到，但操作按钮没有完整显示。请刷新后重试。', 5000, null, 'warn');
    }

    try {
      await refreshTasks();
    } catch (e) {
      console.error('[assistant] task refresh failed:', e);
      toast('操作已完成，但任务列表没有刷新。请稍后重新打开当前视图。', 5000, null, 'warn');
    }
  } finally {
    setAiBusy(false);
    scrollChat();
    $('#ai-input').focus();
  }
}

async function resolveCandidate(result, candidate, label) {
  if (aiSending) return;
  clearTurnActions();
  addMsg('user', label);
  await runResolvedTurn(result, candidate, label);
}

async function runResolvedTurn(result, candidate, label) {
  await runAiTurn(() => window.api.ai.resolve(
    result.intent,
    result.params,
    candidate.id,
    label
  ), () => runResolvedTurn(result, candidate, label));
}

async function runPrompt(raw) {
  await runAiTurn(() => window.api.ai.handle(raw), () => runPrompt(raw));
}

async function sendPrompt(text) {
  const input = $('#ai-input');
  const fromComposer = typeof text !== 'string';
  const raw = (fromComposer ? input.value : text).trim();
  if (!raw || aiSending) return;
  clearTurnActions();
  if (fromComposer) {
    input.value = '';
    resizeAiInput();
  }
  addMsg('user', raw);
  await runPrompt(raw);
}

/* ---------- 聊天历史 ---------- */
async function loadChatHistory() {
  const chat = $('#ai-chat');
  try {
    const log = await window.api.chat.get();
    chat.innerHTML = '';
    if (!log || !log.length) return;
    log.slice(-50).forEach((entry) => {
      chat.appendChild(createMessage(entry.role, entry.text, entry.ts));
    });
    scrollChat();
  } catch (e) {
    // 历史加载失败不阻塞当前工作状态展示。
    chat.innerHTML = '';
  }
}

/* ---------- AI 引擎徽标 ---------- */
function updateAiBadge() {
  const badge = $('#tb-ai-stage');
  if (!badge) return;
  const panelStage = $('.ai-stage');
  const stage = settings.aiStage || 'mock';
  const providerReady = settings.aiProvider !== 'custom' || !!settings.aiBaseUrl;
  const configured = !!(settings.aiApiKey && settings.aiModel && providerReady);
  const degraded = stage === 'llm' && configured && aiRuntimeState === 'degraded';
  const stateClass = stage === 'llm' ? (configured && !degraded ? 'stage-ready' : 'stage-warning') : 'stage-local';
  ['stage-ready', 'stage-warning', 'stage-local'].forEach((name) => {
    badge.classList.toggle(name, name === stateClass);
    if (panelStage) panelStage.classList.toggle(name, name === stateClass);
  });
  if (degraded) {
    badge.textContent = '模型异常';
    if (panelStage) panelStage.textContent = '真实模型 · 已切换本地';
  } else if (stage === 'llm' && configured) {
    badge.textContent = '真实模型';
    if (panelStage) panelStage.textContent = `真实模型 · ${settings.aiModel}`;
  } else if (stage === 'llm' && !configured) {
    badge.textContent = '待配置';
    if (panelStage) panelStage.textContent = '真实模型 · 待配置';
  } else {
    badge.textContent = '本地助手';
    if (panelStage) panelStage.textContent = '本地规则引擎';
  }
}

/* ---------- 刷新 ---------- */
async function refreshTasks() {
  try {
    tasks = await window.api.tasks.getAll();
    dataLoadErrors.tasks = null;
    // 同步回收站列表，保证侧边栏回收站徽标准确
    try { trashList = await window.api.tasks.getDeleted(); } catch (e) { /* 忽略 */ }
    renderAll();
  } catch (error) {
    dataLoadErrors.tasks = error;
    renderAll();
    throw error;
  }
}

async function refreshTasksAfterMutation(message) {
  try {
    await refreshTasks();
    return true;
  } catch (error) {
    toast(`${message}：${error.message}`, 5000, null, 'warn');
    return false;
  }
}

function renderAll() {
  renderToday();
  renderTasks();
  renderMemos();
  renderBoard();
  renderCal();
  renderNavBadges();
  if (currentView === 'stat') renderStat();
  if (currentView === 'settings') renderSettings();
  if (currentView === 'trash') loadTrash();
  applyDataLoadStates();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('.content').addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry-source]');
    if (!retry) return;
    event.preventDefault();
    event.stopPropagation();
    retryDataSource(retry.dataset.retrySource, retry);
  });
  // 导航
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
  $('#sidebar-new').addEventListener('click', () => {
    switchView('tasks');
    openModal(null);
  });

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
  $('#cal-body').addEventListener('keydown', onCalKeyDown);

  // 备忘录
  $('#memo-new').addEventListener('click', createMemo);
  $('#memo-empty-new').addEventListener('click', createMemo);
  $('#memo-search').addEventListener('input', (event) => {
    memoSearch = event.target.value;
    renderMemoList();
  });
  $('#memo-search').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    const target = $('#memo-list [data-memo-id][tabindex="0"]');
    if (!target) return;
    event.preventDefault();
    target.focus();
  });
  $('#memo-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-memo-id]');
    if (item) selectMemo(parseInt(item.dataset.memoId, 10), true);
  });
  $('#memo-list').addEventListener('keydown', onMemoListKeyDown);
  ['memo-title', 'memo-tags', 'memo-content'].forEach((id) => {
    $(`#${id}`).addEventListener('input', scheduleMemoSave);
  });
  $('#memo-pin').addEventListener('click', async () => {
    if ((await saveMemoNow()) === false) return;
    const memo = currentMemo();
    if (!memo) return;
    const button = $('#memo-pin');
    button.disabled = true;
    try {
      const updated = await window.api.memos.update(memo.id, { pinned: !memo.pinned });
      memos = memos.map((item) => item.id === updated.id ? updated : item)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
      renderMemos();
    } catch (error) {
      toast(`置顶操作失败：${error.message}`, 3000, null, 'err');
    } finally {
      button.disabled = false;
    }
  });
  $('#memo-copy').addEventListener('click', async () => {
    if ((await saveMemoNow()) === false) return;
    const memo = currentMemo();
    if (!memo) return;
    const text = [memo.title, memo.content, (memo.tags || []).map((tag) => `#${tag}`).join(' ')].filter(Boolean).join('\n\n');
    try {
      const button = $('#memo-copy');
      button.disabled = true;
      await navigator.clipboard.writeText(text);
      button.classList.add('copied');
      button.querySelector('span').textContent = '✓';
      button.dataset.tooltip = '已复制';
      toast('备忘录已复制', 2500, null, 'ok');
      setTimeout(() => {
        button.classList.remove('copied');
        button.querySelector('span').textContent = '⧉';
        button.dataset.tooltip = '复制';
        button.disabled = false;
      }, 1200);
    } catch (error) {
      $('#memo-copy').disabled = false;
      toast('复制失败，请稍后重试', 3000, null, 'err');
    }
  });
  $('#memo-to-task').addEventListener('click', async () => {
    if ((await saveMemoNow()) === false) return;
    const memo = currentMemo();
    if (!memo) return;
    const button = $('#memo-to-task');
    const label = button.querySelector('span:last-child');
    button.disabled = true;
    label.textContent = '创建中…';
    let task;
    try {
      task = await window.api.tasks.create({ title: memo.title, desc: memo.content, tags: memo.tags || [], pri: 2, status: 'todo' });
    } catch (error) {
      toast(`创建任务失败：${error.message}`, 3000, null, 'err');
      return;
    } finally {
      label.textContent = '转为任务';
      button.disabled = false;
    }
    toast(`已创建任务「${task.title}」`, 3000, null, 'ok');
    await refreshTasksAfterMutation('任务已创建，但列表刷新失败');
  });
  $('#memo-delete').addEventListener('click', async () => {
    if ((await saveMemoNow()) === false) return;
    const memo = currentMemo();
    if (!memo) return;
    confirmDialog(`确定删除备忘录「${memo.title}」吗？`, async () => {
      await window.api.memos.remove(memo.id);
      memos = memos.filter((item) => item.id !== memo.id);
      selectedMemoId = memos.length ? memos[0].id : null;
      memoFocusId = selectedMemoId;
      deletedMemos = await window.api.memos.getDeleted();
      renderMemos();
      renderNavBadges();
      toast('备忘录已移到回收站', 3000, null, 'ok');
    });
  });

  // 搜索
  $('#search-input').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    renderTasks();
  });

  // 快建：支持自然语言（如「明天下午3点 交周报 #工作 紧急」）
  async function createQuickTask() {
    const input = $('#quick-input');
    const button = $('#btn-quick-add');
    const raw = input.value.trim();
    if (!raw || button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '添加中…';
    let createdTitle = raw;
    let createdDue = null;
    try {
      const parsed = quickParseCache.raw === raw && quickParseCache.parsed
        ? quickParseCache.parsed
        : await window.api.ai.parse(raw);
      if (parsed.intent === 'create' && parsed.params.title) {
        const p = parsed.params;
        await window.api.tasks.create({
          title: p.title,
          pri: p.pri || 2,
          due: p.due || null,
          tags: p.tags || []
        });
        createdTitle = p.title;
        createdDue = p.due || null;
      } else {
        await window.api.tasks.create({ title: raw, pri: 2 });
      }
    } catch (err) {
      toast('创建失败：' + err.message, 4000, null, 'err');
      return;
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = '快速添加';
    }
    input.value = '';
    resetQuickPreview();
    toast(`已创建「${createdTitle}」${createdDue ? ' · ' + createdDue : ''}`, 3000, null, 'ok');
    await refreshTasksAfterMutation('任务已创建，但列表刷新失败');
    input.focus();
  }
  $('#quick-input').addEventListener('input', (e) => scheduleQuickPreview(e.target.value));
  $('#quick-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    createQuickTask();
  });
  $('#btn-quick-add').addEventListener('click', createQuickTask);
  $('#btn-new').addEventListener('click', () => openModal(null));
  $('#btn-select-mode').addEventListener('click', () => setBatchMode(!batchMode));

  // 看板拖拽
  $('#board-cols').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.bc-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.closest('.bc-card-item').classList.add('dragging');
  });
  $('#board-cols').addEventListener('dragend', (e) => {
    const card = e.target.closest('.bc-card');
    if (card) card.closest('.bc-card-item').classList.remove('dragging');
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
    if (t.status !== col.dataset.col) {
      await moveBoardTask(t.id, col.dataset.col);
      return;
    }
    const board = $('#board-cols');
    board.setAttribute('aria-busy', 'true');
    try {
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
        toast('已调整卡片顺序');
        await refreshTasksAfterMutation('顺序已保存，但看板刷新失败');
      }
    } catch (error) {
      console.error('[board] task move failed:', error);
      toast('移动任务失败，请稍后重试', 3000, null, 'err');
    } finally {
      board.setAttribute('aria-busy', 'false');
    }
  });
  $('#board-cols').addEventListener('change', (e) => {
    const status = e.target.closest('[data-board-status]');
    if (!status) return;
    moveBoardTask(status.dataset.id, status.value, status);
  });
  // 看板卡片点击编辑
  $('#board-cols').addEventListener('click', (e) => {
    const card = e.target.closest('.bc-card');
    if (!card) return;
    const t = tasks.find((x) => x.id === parseInt(card.dataset.id, 10));
    if (t) openModal(t);
  });

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
    toast('已调整任务顺序');
    await refreshTasksAfterMutation('顺序已保存，但列表刷新失败');
  });

  // 批量操作
  $('#batch-select-all').addEventListener('click', () => {
    const allSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((id) => selectedIds.has(id));
    selectedIds = allSelected ? new Set() : new Set(visibleTaskIds);
    renderTasks();
  });
  $('#batch-done').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const result = await window.api.tasks.batchComplete(ids);
    setBatchMode(false, false);
    const generated = result.generated && result.generated.length;
    const detail = [
      result.skipped ? `跳过 ${result.skipped} 项` : '',
      generated ? `已安排 ${generated} 个下次任务` : ''
    ].filter(Boolean).join(' · ');
    toast(`已完成 ${result.completed} 项任务${detail ? ' · ' + detail : ''}`);
    await refreshTasksAfterMutation('批量完成已保存，但列表刷新失败');
  });
  $('#batch-delete').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    confirmDialog(`确定删除选中的 ${ids.length} 项任务吗？`, async () => {
      await window.api.tasks.batchDelete(ids);
      setBatchMode(false, false);
      toast(`已删除 ${ids.length} 项任务`, 3000, null, 'ok');
      await refreshTasksAfterMutation('批量删除已完成，但列表刷新失败');
    });
  });
  $('#batch-pri').addEventListener('change', async () => {
    const pri = parseInt($('#batch-pri').value, 10);
    if (!pri) return;
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    await window.api.tasks.batchUpdate(ids, { pri });
    setBatchMode(false, false);
    $('#batch-pri').value = '';
    toast(`已更新 ${ids.length} 项任务优先级`);
    await refreshTasksAfterMutation('优先级已更新，但列表刷新失败');
  });
  $('#batch-clear').addEventListener('click', () => setBatchMode(false));

  // 回收站
  $('#trash-empty').addEventListener('click', () => {
    const parts = [];
    if (trashList.length) parts.push(`${trashList.length} 条任务`);
    if (deletedMemos.length) parts.push(`${deletedMemos.length} 条备忘录`);
    const summary = parts.join('、') || '全部内容';
    confirmDialog(`确定永久删除回收站中的 ${summary}吗？此操作不可恢复。`, async () => {
      const results = await Promise.allSettled([
        window.api.tasks.emptyTrash(),
        window.api.memos.emptyTrash()
      ]);
      await loadTrash();
      focusTrashAfterMutation(0);
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed === 2) throw new Error('回收站未能清空，请重试');
      if (failed === 1) {
        toast('部分内容已永久删除，其余内容未能清空。请重试。', 4500, null, 'warn');
        return;
      }
      toast('回收站已永久清空', 3000, null, 'ok');
    }, '永久清空');
  });

  // AI
  $('#ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendPrompt();
  });
  $('#ai-input').addEventListener('input', resizeAiInput);
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    sendPrompt();
  });
  $('#ai-clear').addEventListener('click', clearAssistantConversation);
  $('#ai-collapse').addEventListener('click', () => {
    const panel = $('#ai-panel');
    const collapsed = panel.classList.toggle('collapsed');
    const control = $('#ai-collapse');
    // 收起时显示「«」（点击展开），展开时显示「»」（点击收起）
    control.textContent = collapsed ? '«' : '»';
    control.title = collapsed ? '展开助手' : '收起助手';
    control.setAttribute('aria-label', collapsed ? '展开助手' : '收起助手');
    control.setAttribute('aria-expanded', String(!collapsed));
    // 收起/展开时清除内联宽度，避免与 collapsed 的窄条样式冲突
    if (collapsed) {
      panel.style.width = '';
      panel.style.flexBasis = '';
    }
  });
  $$('#ai-chips .chip').forEach((chip) => chip.addEventListener('click', () => {
    if (chip.dataset.aiAction === 'new-task') {
      switchView('tasks');
      openModal(null);
      return;
    }
    sendPrompt(chip.dataset.prompt);
  }));
  // AI 面板宽度可调（拖拽左边缘）
  (function () {
    const panel = $('#ai-panel');
    const handle = document.createElement('div');
    handle.className = 'ai-resize';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', '调整助手面板宽度');
    handle.setAttribute('aria-valuemin', '260');
    panel.insertBefore(handle, panel.firstChild);
    let resizing = false, startX = 0, startW = 0;
    const maxWidth = () => Math.max(260, Math.min(480, window.innerWidth - 540));
    handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
    const setPanelWidth = (width) => {
      const value = Math.max(260, Math.min(maxWidth(), width));
      panel.style.width = value + 'px';
      panel.style.flexBasis = value + 'px';
      handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
      handle.setAttribute('aria-valuenow', String(Math.round(value)));
    };
    handle.setAttribute('aria-valuenow', String(Math.round(panel.offsetWidth)));
    handle.addEventListener('mousedown', (e) => {
      resizing = true;
      startX = e.clientX;
      startW = panel.offsetWidth;
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      setPanelWidth(startW - (e.clientX - startX));
    });
    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.classList.remove('resizing');
      }
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setPanelWidth(panel.offsetWidth + (e.key === 'ArrowLeft' ? 16 : -16));
    });
    window.addEventListener('resize', () => {
      handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
      if (panel.style.width) setPanelWidth(panel.offsetWidth);
    });
  })();

  // 弹窗
  $('#m-cancel').addEventListener('click', requestCloseModal);
  $('#m-close').addEventListener('click', requestCloseModal);
  $('#task-form').addEventListener('submit', saveModal);
  $('#m-title').addEventListener('input', () => {
    if ($('#m-title').value.trim()) setTitleError('');
  });
  $('#m-delete').addEventListener('click', deleteEditingTask);
  $('#m-archive').addEventListener('click', archiveEditingTask);
  $('#m-unarchive').addEventListener('click', unarchiveEditingTask);
  $('#m-due-clear').addEventListener('click', () => {
    $('#m-due-date').value = '';
    $('#m-due-time').value = '18:00';
  });
  $('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) requestCloseModal(); });
  // 表单原生处理 Enter 提交；此处负责 Esc 和焦点循环。
  $('#modal-mask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestCloseModal();
    }
    if (e.key === 'Tab') trapFocus($('#modal-mask'), e);
  });

  // 主进程事件
  window.api.on('app:new-task', () => { switchView('tasks'); openModal(null); });
  window.api.on('app:focus-ai', () => {
    const panel = $('#ai-panel');
    panel.classList.remove('collapsed');
    $('#ai-collapse').textContent = '»';
    $('#ai-collapse').title = '收起助手';
    $('#ai-collapse').setAttribute('aria-label', '收起助手');
    $('#ai-collapse').setAttribute('aria-expanded', 'true');
    $('#ai-input').focus();
  });
  window.api.on('app:switch-view', (view) => {
    if (['today', 'tasks', 'memos', 'board', 'cal', 'stat', 'settings', 'trash'].includes(view)) switchView(view);
  });
  window.api.on('app:reminder', (data) => {
    toast(`提醒 · ${data.title}${data.due ? ' · ' + data.due : ''}`, 6000);
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
      setBatchMode(false, false);
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
    // N 在当前工作区新建内容
    if (e.key === 'n' || e.key === 'N') {
      if (currentView === 'memos') createMemo();
      else openModal(null);
      return;
    }
    // Esc 退出批量模式
    if (e.key === 'Escape') {
      if (batchMode) setBatchMode(false);
    }
  });
}

/* ---------- 回收站 ---------- */
function trashDeletedTime(item) {
  return item && item.deletedAt ? `删除于 ${memoTime(item.deletedAt)}` : '删除时间未知';
}

function focusTrashAfterMutation(rowIndex) {
  const rows = $$('#trash-list .trash-row');
  if (rows.length) {
    const target = rows[Math.min(Math.max(rowIndex, 0), rows.length - 1)].querySelector('button');
    if (target) target.focus();
    return;
  }
  const list = $('#trash-list');
  if (list) list.focus();
}

async function loadTrash() {
  const list = $('#trash-list');
  if (!list) return;
  list.setAttribute('tabindex', '-1');
  list.setAttribute('aria-busy', 'true');
  list.removeAttribute('role');
  $('#trash-sub').textContent = '正在读取已删除内容…';
  list.innerHTML = '<div class="load-state" role="status"><span class="load-indicator" aria-hidden="true"></span><div><strong>正在读取回收站</strong></div></div>';
  try {
    [trashList, deletedMemos] = await Promise.all([window.api.tasks.getDeleted(), window.api.memos.getDeleted()]);
  } catch (error) {
    list.innerHTML = loadErrorHtml('trash');
    $('#trash-empty').classList.add('hidden');
    $('#trash-sub').textContent = '读取失败 · 请重试';
    list.setAttribute('aria-busy', 'false');
    return;
  }
  renderNavBadges();
  if (!trashList.length && !deletedMemos.length) {
    list.innerHTML = '<div class="empty compact"><div class="big">⌫</div><div class="empty-title">回收站是空的</div><p class="empty-hint">删除的任务和备忘录会显示在这里，并可随时恢复。</p></div>';
    $('#trash-empty').classList.add('hidden');
    $('#trash-sub').textContent = '回收站为空 · 删除的内容可从这里恢复';
    list.setAttribute('aria-busy', 'false');
    return;
  }
  const total = trashList.length + deletedMemos.length;
  const parts = [];
  if (trashList.length) parts.push(`${trashList.length} 条任务`);
  if (deletedMemos.length) parts.push(`${deletedMemos.length} 条备忘录`);
  $('#trash-sub').textContent = `${total} 项内容 · ${parts.join('、')}`;
  $('#trash-empty').classList.remove('hidden');
  list.setAttribute('role', 'list');
  const taskRows = trashList.map((t) => `
    <div class="trash-row" role="listitem" data-id="${t.id}">
      <div class="trash-main">
        <div class="trash-heading"><span class="trash-title">${esc(t.title)}</span><span class="trash-kind">任务</span></div>
        <span class="trash-time">${esc(trashDeletedTime(t))}</span>
      </div>
      <div class="trash-actions">
        <button type="button" class="btn mini trash-restore" data-restore-task="${t.id}" aria-label="恢复任务「${esc(t.title)}」">恢复</button>
        <button type="button" class="btn mini danger" data-purge-task="${t.id}" aria-label="永久删除任务「${esc(t.title)}」">永久删除</button>
      </div>
    </div>`).join('');
  const memoRows = deletedMemos.map((memo) => `
    <div class="trash-row" role="listitem" data-id="${memo.id}">
      <div class="trash-main">
        <div class="trash-heading"><span class="trash-title">${esc(memo.title)}</span><span class="trash-kind">备忘录</span></div>
        <span class="trash-time">${esc(trashDeletedTime(memo))}</span>
      </div>
      <div class="trash-actions">
        <button type="button" class="btn mini trash-restore" data-restore-memo="${memo.id}" aria-label="恢复备忘录「${esc(memo.title)}」">恢复</button>
        <button type="button" class="btn mini danger" data-purge-memo="${memo.id}" aria-label="永久删除备忘录「${esc(memo.title)}」">永久删除</button>
      </div>
    </div>`).join('');
  list.innerHTML = taskRows + memoRows;
  // 绑定恢复按钮
  $$('#trash-list [data-restore-task]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.restoreTask, 10);
      const rowIndex = Array.from(list.children).indexOf(b.closest('.trash-row'));
      const rowButtons = Array.from(b.closest('.trash-row').querySelectorAll('button'));
      rowButtons.forEach((button) => { button.disabled = true; });
      b.setAttribute('aria-busy', 'true');
      b.textContent = '恢复中…';
      try {
        await window.api.tasks.restore(id);
        toast('已恢复任务', 2500, null, 'ok');
        await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
        await loadTrash();
        focusTrashAfterMutation(rowIndex);
      } catch (error) {
        toast('任务恢复失败，请重试', 3500, null, 'err');
        rowButtons.forEach((button) => { button.disabled = false; });
        b.setAttribute('aria-busy', 'false');
        b.textContent = '恢复';
      }
    });
  });
  $$('#trash-list [data-restore-memo]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.restoreMemo, 10);
      const rowIndex = Array.from(list.children).indexOf(b.closest('.trash-row'));
      const rowButtons = Array.from(b.closest('.trash-row').querySelectorAll('button'));
      rowButtons.forEach((button) => { button.disabled = true; });
      b.setAttribute('aria-busy', 'true');
      b.textContent = '恢复中…';
      try {
        await window.api.memos.restore(id);
        toast('已恢复备忘录', 2500, null, 'ok');
        await refreshMemosAfterMutation('备忘录已恢复，但列表刷新失败');
        await loadTrash();
        focusTrashAfterMutation(rowIndex);
      } catch (error) {
        toast('备忘录恢复失败，请重试', 3500, null, 'err');
        rowButtons.forEach((button) => { button.disabled = false; });
        b.setAttribute('aria-busy', 'false');
        b.textContent = '恢复';
      }
    });
  });
  $$('#trash-list [data-purge-task]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = parseInt(button.dataset.purgeTask, 10);
      const task = trashList.find((item) => item.id === id);
      const rowIndex = Array.from(list.children).indexOf(button.closest('.trash-row'));
      confirmDialog(`确定永久删除任务「${task ? task.title : '未命名任务'}」吗？此操作不可恢复。`, async () => {
        await window.api.tasks.purge(id);
        toast('任务已永久删除', 2500, null, 'ok');
        await loadTrash();
        focusTrashAfterMutation(rowIndex);
      }, '永久删除');
    });
  });
  $$('#trash-list [data-purge-memo]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = parseInt(button.dataset.purgeMemo, 10);
      const memo = deletedMemos.find((item) => item.id === id);
      const rowIndex = Array.from(list.children).indexOf(button.closest('.trash-row'));
      confirmDialog(`确定永久删除备忘录「${memo ? memo.title : '无标题备忘录'}」吗？此操作不可恢复。`, async () => {
        await window.api.memos.purge(id);
        toast('备忘录已永久删除', 2500, null, 'ok');
        await loadTrash();
        focusTrashAfterMutation(rowIndex);
      }, '永久删除');
    });
  });
  list.setAttribute('aria-busy', 'false');
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
  const selectionRow = e.target.closest('.task-row');
  if (batchMode && currentView === 'tasks' && selectionRow) {
    toggleSelect(parseInt(selectionRow.dataset.id, 10));
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
    if (currentView === 'tasks' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      setBatchMode(true, false);
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
    await refreshTasksAfterMutation('优先级已更新，但列表刷新失败');
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
  await refreshTasksAfterMutation('任务已复制，但列表刷新失败');
}

/* 归档/恢复/删除（带撤销） */
async function archiveTaskById(id, title) {
  await window.api.tasks.archive(id);
  toast(`已归档「${title}」`, 5000, [{
    label: '撤销',
    run: async () => {
      await window.api.tasks.unarchive(id);
      toast('已恢复');
      await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
    }
  }]);
  await refreshTasksAfterMutation('任务已归档，但列表刷新失败');
}

async function unarchiveTaskById(id) {
  await window.api.tasks.unarchive(id);
  toast('已恢复为待办');
  await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
}

async function deleteTaskById(id, title) {
  await window.api.tasks.remove(id);
  toast(`已删除「${title}」`, 5000, [{
    label: '撤销',
    run: async () => {
      await window.api.tasks.restore(id);
      toast('已恢复');
      await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
    }
  }]);
  await refreshTasksAfterMutation('任务已删除，但列表刷新失败');
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
  await refreshTasksAfterMutation('子任务已更新，但列表刷新失败');
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  renderTasks();
  const control = document.querySelector(`.task-row[data-id="${id}"] .task-check`);
  if (control) control.focus({ preventScroll: true });
}

async function toggleDone(t) {
  if (t.status === 'done') {
    await window.api.tasks.update(t.id, { status: 'todo' });
    toast(`已重新打开「${t.title}」`);
    await refreshTasksAfterMutation('任务已重新打开，但列表刷新失败');
    return;
  }
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
  await refreshTasksAfterMutation('任务已完成，但列表刷新失败');
}

async function postponeTask(id, days) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  await window.api.tasks.postpone(id, days);
  toast(`「${t.title}」已顺延${days === 1 ? '到明天' : '一周'}`);
  await refreshTasksAfterMutation('任务已顺延，但列表刷新失败');
}

async function cycleState(t) {
  const next = STATE_NEXT[t.status] || 'todo';
  if (next === 'done') await toggleDone(t);
  else {
    await window.api.tasks.update(t.id, { status: next });
    await refreshTasksAfterMutation('任务状态已更新，但列表刷新失败');
  }
}

function onCalClick(e) {
  const addBtn = e.target.closest('#cal-add-task');
  if (addBtn) {
    // 在该天新建任务：预填截止日期
    openModal(null);
    $('#m-due-date').value = calSelected;
    $('#m-due-time').value = '18:00';
    captureModalInitialState();
    return;
  }
  const cell = e.target.closest('.cal-cell');
  if (cell) {
    calSelected = cell.dataset.day;
    calFocusDate = calSelected;
    const selectedDate = calendarDateFromKey(calSelected);
    if (selectedDate && (selectedDate.getFullYear() !== calCursor.getFullYear() || selectedDate.getMonth() !== calCursor.getMonth())) {
      calCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    }
    renderCal();
    focusCalendarCell(calSelected);
    return;
  }
  const btn = e.target.closest('[data-cal]');
  if (btn) {
    if (btn.dataset.cal === 'prev') calCursor.setMonth(calCursor.getMonth() - 1);
    if (btn.dataset.cal === 'next') calCursor.setMonth(calCursor.getMonth() + 1);
    if (btn.dataset.cal === 'today') {
      const today = new Date();
      calCursor = new Date(today.getFullYear(), today.getMonth(), 1);
      calFocusDate = calKey(today);
    } else {
      calFocusDate = calKey(new Date(calCursor.getFullYear(), calCursor.getMonth(), 1));
    }
    calSelected = null;
    const control = btn.dataset.cal;
    renderCal();
    $(`#cal-body [data-cal="${control}"]`)?.focus();
    return;
  }
  onTaskClick(e);
}

function onCalKeyDown(e) {
  const cell = e.target.closest('.cal-cell[data-day]');
  if (!cell) return;
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();

  const grid = cell.closest('.cal-grid');
  const cells = Array.from(grid.querySelectorAll('.cal-cell[data-day]'));
  const index = cells.indexOf(cell);
  let targetKey = null;
  if (e.key === 'Home') targetKey = cells[index - (index % 7)]?.dataset.day;
  else if (e.key === 'End') targetKey = cells[index + (6 - (index % 7))]?.dataset.day;
  else if (e.key === 'PageUp') targetKey = shiftCalendarKey(cell.dataset.day, 0, -1);
  else if (e.key === 'PageDown') targetKey = shiftCalendarKey(cell.dataset.day, 0, 1);
  else {
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    targetKey = shiftCalendarKey(cell.dataset.day, deltas[e.key], 0);
  }
  if (!targetKey) return;

  calFocusDate = targetKey;
  if (focusCalendarCell(targetKey)) return;
  const targetDate = calendarDateFromKey(targetKey);
  if (!targetDate) return;
  calCursor = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  renderCal();
  focusCalendarCell(targetKey);
}

/* ---------- 初始化 ---------- */
async function init() {
  document.body.setAttribute('aria-busy', 'true');
  $('#ai-chat').setAttribute('aria-busy', 'true');
  try {
    const [settingsResult, tasksResult, memosResult, taskTrashResult, memoTrashResult, dirResult] = await Promise.allSettled([
      window.api.settings.get(),
      window.api.tasks.getAll(),
      window.api.memos.getAll(),
      window.api.tasks.getDeleted(),
      window.api.memos.getDeleted(),
      window.api.data.getDir()
    ]);

    settings = settingsResult.status === 'fulfilled'
      ? (settingsResult.value || {})
      : { theme: 'auto', aiStage: 'local', shortcuts: {} };
    tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
    memos = memosResult.status === 'fulfilled' ? memosResult.value : [];
    trashList = taskTrashResult.status === 'fulfilled' ? taskTrashResult.value : [];
    deletedMemos = memoTrashResult.status === 'fulfilled' ? memoTrashResult.value : [];
    settings.dataDir = dirResult.status === 'fulfilled' ? dirResult.value : '暂时无法读取';
    dataLoadErrors.tasks = tasksResult.status === 'rejected' ? tasksResult.reason : null;
    dataLoadErrors.memos = memosResult.status === 'rejected' ? memosResult.reason : null;

    applyTheme();
    if (!eventsBound) {
      bindEvents();
      eventsBound = true;
    }
    renderAll();
    updateAiBadge();
    await loadChatHistory();

    const chat = $('#ai-chat');
    if (!chat.children.length) {
      addMsg('ai', assistantStatusSummary());
    }
    if (settingsResult.status === 'rejected') {
      toast('偏好设置暂时无法读取，已使用默认外观', 4000, null, 'warn');
    }
  } catch (error) {
    renderStartupError(error);
  } finally {
    document.body.setAttribute('aria-busy', 'false');
    $('#ai-chat').setAttribute('aria-busy', 'false');
  }
}

document.addEventListener('DOMContentLoaded', init);
