'use strict';

/* ============================================================
 * 渲染进程主逻辑 - 工作台助手
 * 视图：今天 / 清单（任务+备忘录）/ 记录 / 设置
 * 右侧：AI 助手面板
 * ============================================================ */

/* ---------- 状态 ---------- */
let tasks = [];
let memos = [];
let settings = {};
let mcpStatus = null;
let currentView = 'today';
const viewScrollPositions = new Map();
let listTab = 'tasks'; // 清单页内部分区：tasks | memos
let currentSearch = '';
let editingTask = null; // 正在编辑的任务（null = 新建）
let taskReorderBusy = false;
let expandedIds = new Set(); // 展开的任务详情
let trashList = []; // 回收站列表
let deletedMemos = [];
let selectedMemoId = null;
let memoFocusId = null;
let memoSearch = '';
let memoSaveTimer = null;
let memoSaveChain = Promise.resolve();
let memoDirty = false;
let memoDraftRevision = 0;
let memoSavePending = 0;
let memoCreating = false;
let memoActionBusy = false;
let memoActionControlId = '';
let memoActionLabel = '';
// 新建先进草稿，用户真的写下内容才落库，避免留下「无标题备忘录」垃圾条目
const MEMO_DRAFT_ID = -1;
let memoDraftMemo = null;
let memoFilter = 'all';
let quickParseTimer = null;
let quickParseToken = 0;
let quickParseCache = { raw: '', parsed: null };
let modalSaving = false;
let modalReturnFocus = null;
let modalInitialSnapshot = '';
let aiSending = false;

let activeAiRequest = null;
let aiRequestSequence = 0;
let aiChatFollowing = true;
let aiRuntimeState = null; // null | ready | degraded
let aiRuntimeNotice = '';
const settingsActionScopes = new Set();
let eventsBound = false;
const dataLoadErrors = { tasks: null, memos: null };
const taskMutationLocks = new Set();
const MOTION_MS = Object.freeze({ instant: 80, fast: 140, base: 220, slow: 320 });
const FEEDBACK_HOLD_MS = 1200;
/* 外观主题：液态玻璃 / 极简单色 / 暗色。
   旧版本的 light、auto 以及未知值统一归一为液态玻璃，用户手动切换后才会写入新值。 */
const THEME_VALUES = ['glass', 'mono', 'dark'];

function normalizeTheme(value) {
  return THEME_VALUES.includes(value) ? value : 'glass';
}

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setButtonContent(button, label, iconName) {
  if (!button) return;
  const text = document.createElement('span');
  text.textContent = label;
  button.replaceChildren();
  if (iconName) button.appendChild(uiIconElement(iconName));
  button.appendChild(text);
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
    ['today-list', 'tasks-list'].forEach((id) => {
      const target = document.getElementById(id);
      if (target) target.innerHTML = loadErrorHtml('tasks');
    });
    $('#today-sub').textContent = '任务数据暂时不可用';
  }
  const memoError = $('#memo-load-error');
  if (memoError) {
    memoError.classList.toggle('hidden', !dataLoadErrors.memos);
    if (dataLoadErrors.memos) {
      memoError.innerHTML = loadErrorHtml('memos');
      $('#memo-empty').classList.add('hidden');
      $('#memo-editor').classList.add('hidden');
      $('#memo-list').innerHTML = '<div class="memo-list-empty">备忘录暂时不可用</div>';
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

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function motionDelay(milliseconds) {
  if (prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextMotionFrame(callback) {
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(callback);
  else setTimeout(callback, 0);
}

function playTransientClass(element, className, milliseconds) {
  if (!element) return;
  element.classList.remove(className);
  nextMotionFrame(() => {
    if (!element.isConnected) return;
    element.classList.add(className);
    setTimeout(() => element.classList.remove(className), prefersReducedMotion() ? 0 : milliseconds);
  });
}

/* ---------- Toast ---------- */
function dismissToast(element, immediate) {
  if (!element || !element.isConnected) return;
  if (element._dismissTimer) clearTimeout(element._dismissTimer);
  if (immediate || prefersReducedMotion()) {
    element.remove();
    return;
  }
  element.classList.add('is-leaving');
  element._dismissTimer = setTimeout(() => element.remove(), MOTION_MS.fast);
}

function scheduleToastDismiss(element, milliseconds) {
  if (element._dismissTimer) clearTimeout(element._dismissTimer);
  if (element.classList.contains('is-action-busy')) return;
  element._dismissTimer = setTimeout(() => dismissToast(element), milliseconds);
}

function showModalMask(mask) {
  if (!mask) return;
  if (mask._hideTimer) clearTimeout(mask._hideTimer);
  mask._hideTimer = null;
  mask.classList.remove('hidden', 'is-closing');
  mask.setAttribute('aria-hidden', 'false');
  mask.inert = false;
}

function hideModalMask(mask, onHidden) {
  if (!mask) {
    if (onHidden) onHidden();
    return;
  }
  if (mask._hideTimer) clearTimeout(mask._hideTimer);
  mask.setAttribute('aria-hidden', 'true');
  mask.inert = true;
  const finish = () => {
    mask._hideTimer = null;
    mask.classList.remove('is-closing');
    mask.classList.add('hidden');
    if (onHidden) onHidden();
  };
  if (mask.classList.contains('hidden') || prefersReducedMotion()) {
    finish();
    return;
  }
  mask.classList.add('is-closing');
  mask._hideTimer = setTimeout(finish, MOTION_MS.fast);
}

function toast(message, ms, actions, type) {
  const layer = $('#toast-layer');
  const normalizedMessage = String(message == null ? '' : message);
  if (!actions) {
    const repeated = Array.from(layer.children).find((item) => item.dataset.message === normalizedMessage && !item.classList.contains('is-leaving'));
    if (repeated) {
      playTransientClass(repeated, 'is-repeated', MOTION_MS.base);
      scheduleToastDismiss(repeated, ms || 3000);
      return repeated;
    }
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' t-' + type : '');
  el.dataset.message = normalizedMessage;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.setAttribute('aria-atomic', 'true');
  const icons = { ok: 'circle-check', err: 'circle-x', warn: 'triangle-alert' };
  if (icons[type]) {
    const icon = document.createElement('span');
    icon.className = 't-ico';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(uiIconElement(icons[type]));
    el.appendChild(icon);
  }
  const text = document.createElement('span');
  text.textContent = normalizedMessage;
  el.appendChild(text);
  if (actions) {
    const actionStatus = document.createElement('span');
    actionStatus.className = 't-action-status';
    actionStatus.setAttribute('aria-live', 'polite');
    el.appendChild(actionStatus);
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 't-undo';
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        if (el._dismissTimer) clearTimeout(el._dismissTimer);
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        b.textContent = a.busyLabel || `${a.label}中…`;
        actionStatus.textContent = '';
        el.classList.remove('t-action-error');
        el.classList.add('is-action-busy');
        try {
          const outcome = await a.run();
          if (outcome === false) throw new Error('操作未完成');
          dismissToast(el);
        } catch (error) {
          b.disabled = false;
          b.setAttribute('aria-busy', 'false');
          b.textContent = '重试';
          actionStatus.textContent = '失败';
          el.classList.remove('is-action-busy');
          el.classList.add('t-action-error');
          el.setAttribute('role', 'alert');
          console.error('[toast] action failed:', error);
          scheduleToastDismiss(el, 5000);
          b.focus({ preventScroll: true });
        }
      });
      el.appendChild(b);
    });
  }
  layer.appendChild(el);
  while (layer.children.length > 3) {
    const removable = Array.from(layer.children).find((item) =>
      !item.classList.contains('is-action-busy') && !item.contains(document.activeElement));
    if (!removable) break;
    dismissToast(removable, true);
  }
  el.addEventListener('mouseenter', () => {
    if (el._dismissTimer) clearTimeout(el._dismissTimer);
  });
  el.addEventListener('mouseleave', () => scheduleToastDismiss(el, 1200));
  el.addEventListener('focusin', () => {
    if (el._dismissTimer) clearTimeout(el._dismissTimer);
  });
  el.addEventListener('focusout', (event) => {
    if (!event.relatedTarget || !el.contains(event.relatedTarget)) scheduleToastDismiss(el, 1200);
  });
  scheduleToastDismiss(el, ms || 3000);
  return el;
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
  const errorBox = $('#confirm-error');
  const okBtn = $('#confirm-ok');
  const cancelBtn = $('#confirm-cancel');
  const returnFocus = document.activeElement;
  const actionText = okText || '删除';
  title.textContent = `确认${actionText}`;
  text.textContent = message;
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
  okBtn.textContent = actionText;
  showModalMask(mask);
  const onOkClick = async () => {
    if (okBtn.disabled) return;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    okBtn.setAttribute('aria-busy', 'true');
    okBtn.textContent = `${actionText}中…`;
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
    try {
      const outcome = await onOk();
      if (outcome === false) {
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        okBtn.setAttribute('aria-busy', 'false');
        okBtn.textContent = actionText;
        errorBox.textContent = `尚未${actionText}，请处理当前错误后重试。`;
        errorBox.classList.remove('hidden');
        return;
      }
      cleanup(outcome && outcome.focusTarget);
    } catch (error) {
      console.error('[confirm] action failed:', error);
      okBtn.disabled = false;
      cancelBtn.disabled = false;
      okBtn.setAttribute('aria-busy', 'false');
      okBtn.textContent = actionText;
      errorBox.textContent = `未能${actionText}，请稍后重试。`;
      errorBox.classList.remove('hidden');
      toast(`未能${actionText}，请稍后重试`, 4000, null, 'err');
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !okBtn.disabled) { cleanup(); }
    if (e.key === 'Tab') trapFocus(mask, e);
  };
  function cleanup(focusTarget) {
    cancelBtn.removeEventListener('click', cleanup);
    okBtn.removeEventListener('click', onOkClick);
    document.removeEventListener('keydown', onKey);
    okBtn.disabled = false;
    cancelBtn.disabled = false;
    okBtn.setAttribute('aria-busy', 'false');
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
    hideModalMask(mask, () => {
      const target = typeof focusTarget === 'string' ? $(focusTarget) : null;
      if (target && !target.disabled && !target.closest('.hidden')) {
        target.focus({ preventScroll: true });
      } else if (returnFocus && returnFocus.isConnected && !returnFocus.closest('.hidden')) {
        returnFocus.focus({ preventScroll: true });
      }
    });
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
function rowHTML(t) {
  const sub = [];
  if (t.desc) sub.push(esc(t.desc));
  const dueHtml = t.due
    ? `<span class="tdue${isOverdue(t.due, t.status) ? ' over' : ''}" title="${esc(t.due)}">${esc(relDue(t.due))}</span>`
    : '';
  const checked = t.status === 'done';
  const checkIcon = checked ? uiIcon('check') : '';
  const repeatTag = t.repeat ? `<span class="repeat-chip">${uiIcon('refresh')}<span>${t.repeat === 'daily' ? '每天' : t.repeat === 'weekly' ? '每周' : '每月'}</span></span>` : '';
  // 完成时间
  const doneTime = t.status === 'done' && t.completedAt
    ? `<span class="done-time" title="完成时间">${uiIcon('circle-check')}<span>${fmtTime(t.completedAt)}</span></span>`
    : '';
  // 搜索高亮
  const titleHtml = currentSearch
    ? highlightText(esc(t.title), currentSearch)
    : esc(t.title);
  // 过期背景
  const overdueCls = isOverdue(t.due, t.status) ? ' overdue-row' : '';
  const menuItems = t.status === 'archived'
    ? [
        ['unarchive', 'undo', '恢复为待办'],
        ['delete', 'trash', '删除', 'danger']
      ]
    : [
        ['edit', 'pencil', '编辑'],
        ['copy', 'copy', '复制副本'],
        ['archive', 'archive', '归档'],
        ['delete', 'trash', '删除', 'danger']
      ];
  const menuId = `task-menu-${t.id}`;
  const quickActions = `<span class="task-overflow">
    <button type="button" class="task-more" aria-haspopup="menu" aria-controls="${menuId}" aria-expanded="false" title="更多操作" aria-label="打开任务「${esc(t.title)}」的更多操作">${uiIcon('ellipsis')}</button>
    <span class="task-menu hidden" id="${menuId}" role="menu" aria-label="任务「${esc(t.title)}」的更多操作">
      ${menuItems.map(([act, icon, label, kind]) => `<button type="button" class="task-menu-item${kind ? ` ${kind}` : ''}" data-act="${act}" role="menuitem" tabindex="-1"><span class="task-menu-icon">${uiIcon(icon)}</span><span>${label}</span></button>`).join('')}
    </span>
  </span>`;
  // 详情展开区
  const detailOpen = expandedIds.has('d' + t.id);
  const detailHtml = detailOpen ? `<div class="task-detail">
    ${t.desc ? `<div class="td-row"><span class="td-label">描述</span><span class="td-val">${esc(t.desc)}</span></div>` : ''}
    ${t.repeat ? `<div class="td-row"><span class="td-label">重复</span><span class="td-val">${t.repeat === 'daily' ? '每天' : t.repeat === 'weekly' ? '每周' : '每月'}</span></div>` : ''}
    ${t.remind ? `<div class="td-row"><span class="td-label">提醒</span><span class="td-val">提前 ${t.remind} 分钟</span></div>` : ''}
    <div class="td-row"><span class="td-label">创建</span><span class="td-val">${fmtTime(t.createdAt)}</span></div>
    ${t.status === 'done' && t.completedAt ? `<div class="td-row"><span class="td-label">完成</span><span class="td-val">${fmtTime(t.completedAt)}</span></div>` : ''}
  </div>` : '';
  const checkLabel = t.status === 'done' ? '重新打开' : '完成任务';
  return `<div class="task-row${t.status === 'done' ? ' done' : ''}${t.status === 'archived' ? ' archived' : ''}${overdueCls}" data-id="${t.id}" draggable="true">
    <button type="button" class="task-check" title="${esc(checkLabel)}" aria-label="${esc(checkLabel)}" aria-pressed="${checked}">${checkIcon}</button>
    <div class="task-main">
      <button type="button" class="tname task-title-btn" aria-expanded="${detailOpen}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">${titleHtml}</button>
      ${sub.length ? `<div class="tsub">${sub.join(' · ')}</div>` : ''}
      ${detailHtml}
    </div>
    <div class="task-meta">
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

function setQuickCreateBusy(input, button, busy) {
  input.readOnly = busy;
  input.setAttribute('aria-busy', String(busy));
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? '添加中…' : '快速添加';
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
        <div class="big" aria-hidden="true">${uiIcon('search')}</div>
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
    const st = {
      ico: 'plus',
      title: '还没有任务',
      hint: '在快速添加框输入一句话，或让助手记下第一件事。',
      showBtn: true
    };
    container.innerHTML = `<div class="empty">
      <div class="big" aria-hidden="true">${uiIcon(st.ico)}</div>
      <div class="empty-title">${st.title}</div>
      <p class="empty-hint">${st.hint}</p>
      ${st.showBtn ? '<button type="button" class="btn mini empty-cta" id="empty-new-task">新建任务</button>' : ''}
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
      <div class="big" aria-hidden="true">${uiIcon('today')}</div>
      <div class="empty-title">今天没有到期任务</div>
      <p class="empty-hint">可以继续处理已有事项，或安排下一件要紧事。</p>
      <div class="empty-actions">
        <button type="button" class="btn mini ghost" id="today-empty-all">查看所有任务</button>
        <button type="button" class="btn mini" id="today-empty-new">新建任务</button>
      </div>
    </div>`;
  }
  $('#today-list').innerHTML = html;
  $('#today-empty-all')?.addEventListener('click', () => {
    switchView('list');
    setListTab('tasks');
  });
  $('#today-empty-new')?.addEventListener('click', () => openModal(null));
  $('#today-sub').textContent = `${overdue.length} 过期 · ${todays.length} 今天 · 今日完成 ${doneToday.length}`;
}

/* ---------- 视图：清单（任务） ---------- */
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
  // 排序：手动 order 优先，其次按状态/优先级
  list.sort((a, b) => {
    if (a.status === 'archived' && b.status !== 'archived') return 1;
    if (a.status !== 'archived' && b.status === 'archived') return -1;
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    return compareTaskOrder(a, b);
  });
  renderList($('#tasks-list'), list);
  const done = tasks.filter((t) => !t._deleted && t.status === 'done').length;
  const total = tasks.filter((t) => !t._deleted && t.status !== 'archived').length;
  if (listTab === 'tasks') {
    $('#list-sub').textContent = `显示 ${list.length} · 完成 ${done} / ${total}${currentSearch ? ' · 搜索：' + currentSearch : ''}`;
  }
}

function compareTaskOrder(a, b) {
  const oa = Number.isFinite(Number(a.order)) ? Number(a.order) : 0;
  const ob = Number.isFinite(Number(b.order)) ? Number(b.order) : 0;
  if (oa !== ob) return oa - ob;
  if (a.pri !== b.pri) return b.pri - a.pri;
  return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
}

function reorderedTaskId(item) {
  if (!item) return null;
  const value = item.dataset?.id || item.querySelector?.('[data-id]')?.dataset.id;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function focusReorderedTask(taskId) {
  if (!Number.isFinite(taskId)) return false;
  const target = document.querySelector(`#tasks-list .task-row[data-id="${taskId}"] .task-title-btn`);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

async function commitTaskOrder(order, item, successMessage, refreshFailureMessage) {
  if (taskReorderBusy) return false;
  taskReorderBusy = true;
  const taskId = reorderedTaskId(item);
  const surface = $('#tasks-list');
  if (surface) surface.setAttribute('aria-busy', 'true');
  if (item) item.classList.add('reorder-commit');
  try {
    await window.api.tasks.reorder(order);
    toast(successMessage, 2500, null, 'ok');
    await refreshTasksAfterMutation(refreshFailureMessage);
    focusReorderedTask(taskId);
    return true;
  } catch (error) {
    console.error('[tasks] task reorder failed:', error);
    if (item) {
      item.classList.remove('reorder-commit');
      playTransientClass(item, 'reorder-error', MOTION_MS.slow);
    }
    toast('顺序未保存，任务仍在原位置', 3500, null, 'err');
    return false;
  } finally {
    if (item) item.classList.remove('reorder-commit');
    taskReorderBusy = false;
    if (surface) surface.setAttribute('aria-busy', 'false');
  }
}

async function reorderTaskByKeyboard(taskId, delta) {
  if (taskReorderBusy) return false;
  const item = document.querySelector(`#tasks-list .task-row[data-id="${taskId}"]`);
  if (!item) return false;
  const peers = Array.from($('#tasks-list').querySelectorAll('.task-row[data-id]'));
  const ids = peers.map((entry) => Number(entry.dataset.id));
  const from = ids.indexOf(Number(taskId));
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) {
    toast(delta < 0 ? '已经在最上方' : '已经在最下方', 1800);
    return false;
  }
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return commitTaskOrder(
    ids,
    item,
    delta < 0 ? '已上移任务' : '已下移任务',
    '顺序已保存，但界面刷新失败'
  );
}

function onTaskReorderKeyDown(event) {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const control = event.target.closest('.task-title-btn');
  if (!control) return;
  const item = control.closest('.task-row');
  if (!item) return;
  event.preventDefault();
  reorderTaskByKeyboard(Number(item.dataset.id), event.key === 'ArrowUp' ? -1 : 1);
}

/* ---------- AI 报告文件名 ---------- */
function weeklyReportFileName(weekOffset) {
  const date = new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - (day - 1) + weekOffset * 7);
  const pad = (n) => String(n).padStart(2, '0');
  const weekName = weekOffset === -1 ? '上周' : weekOffset === 1 ? '下周' : '本周';
  return `工作周报-${weekName}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

function dailyReportFileName(dayOffset) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `工作日报-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

/* ---------- 视图：记录 ---------- */
let recordsRequest = 0;
async function renderRecords() {
  const body = $('#records-body');
  if (!body || currentView !== 'records') return;
  const request = ++recordsRequest;
  try {
    const days = await window.api.worklog.get();
    if (request !== recordsRequest || currentView !== 'records') return;
    const now = new Date();
    const key = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const today = key(now);
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay()+6)%7));
    const done = date => (days[date]?.items || []).filter(item => item.type === 'task_done').length;
    let streak = 0; const cursor = new Date(now);
    if (!done(key(cursor))) cursor.setDate(cursor.getDate()-1);
    while (done(key(cursor))) { streak++; cursor.setDate(cursor.getDate()-1); }
    const week = Object.keys(days).filter(date => date >= key(monday) && date <= today).reduce((sum,date) => sum + done(date),0);
    const cards = [['今日完成',done(today)],['全部待办',tasks.filter(t => !t._deleted && ['todo','doing'].includes(t.status)).length],['连续完成天数',streak],['本周完成',week]];
    $('#records-sub').textContent = '完成的事，都会留下记录';
    body.innerHTML = `<div class="record-metrics">${cards.map(([label,count]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join('')}</div>
      <div class="record-report"><label>报告周期 <select id="record-period"><option value="daily">日报</option><option value="weekly">周报</option></select></label> <button type="button" id="record-report">生成报告</button><pre id="record-report-output" aria-live="polite"></pre></div>
      ${[...new Set([today,...Object.keys(days)])].sort().reverse().map(date => `<section class="record-day"><h3>${date}</h3>${(days[date]?.items || []).slice().reverse().map(item => `<p><time>${new Date(item.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time> ${item.type === 'task_done' ? '完成' : item.type === 'task_start' ? '开始' : '补充'} · ${esc(item.note || item.title)} ${item.type === 'note' ? `<button type="button" data-note-date="${date}" data-note-id="${item.id}">删除补充</button>` : ''}</p>`).join('') || '<p>暂无记录</p>'}<form data-note-form="${date}"><input aria-label="${date} 补充一句" maxlength="1000" required placeholder="补充一句"><button type="submit">保存补充</button></form></section>`).join('')}`;
    body.querySelectorAll('[data-note-form]').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
      try { await window.api.worklog.addNote(form.dataset.noteForm, form.querySelector('input').value); await renderRecords(); }
      catch(error) { toast(error.message, 5000, null, 'err'); } finally { button.disabled = false; }
    }));
    body.querySelectorAll('[data-note-id]').forEach(button => button.addEventListener('click', () => confirmDialog('删除这条手动补充？', async () => {
      await window.api.worklog.removeNote(button.dataset.noteDate, Number(button.dataset.noteId)); await renderRecords();
    })));
    $('#record-report').addEventListener('click', async event => {
      event.target.disabled = true;
      try { $('#record-report-output').textContent = await window.api.data.report({ period: $('#record-period').value, offset: 0 }); }
      catch(error) { toast(error.message,5000,null,'err'); } finally { event.target.disabled = false; }
    });
  } catch(error) {
    if (request !== recordsRequest) return;
    body.innerHTML = '<p role="alert">工作记录读取失败</p><button id="record-retry" type="button">重试</button>';
    $('#record-retry')?.addEventListener('click', renderRecords);
  }
}

/* ---------- 清单页分区切换 ---------- */
function setListTab(tab) {
  if (!['tasks', 'memos'].includes(tab)) return;
  listTab = tab;
  const tabs = [
    ['tasks', '#list-tab-tasks', '#list-tasks-panel'],
    ['memos', '#list-tab-memos', '#list-memos-panel']
  ];
  tabs.forEach(([key, tabSel, panelSel]) => {
    const tabBtn = $(tabSel);
    const panel = $(panelSel);
    if (tabBtn) {
      tabBtn.classList.toggle('active', key === listTab);
      tabBtn.setAttribute('aria-selected', String(key === listTab));
      tabBtn.tabIndex = key === listTab ? 0 : -1;
    }
    if (panel) panel.hidden = key !== listTab;
  });
  if (currentView === 'list') {
    if (listTab === 'tasks') renderTasks();
    else renderMemos();
  }
}

/* ---------- 视图：设置 ---------- */
/* ---------- MCP 服务设置 ---------- */
function mcpStatusText(status) {
  if (!status) return '正在读取…';
  if (!status.enabled) return '已关闭，没有监听任何端口。';
  if (status.running) {
    const sessions = status.clientSessions ? ` · ${status.clientSessions} 个客户端会话` : '';
    return `运行中 · ${status.url} · ${status.toolCount} 个工具${sessions}`;
  }
  return `已开启但启动失败：${status.lastError || '未知原因'}`;
}

function renderMcpStatus() {
  const node = $('#mcp-status');
  if (!node) return;
  node.textContent = mcpStatusText(mcpStatus);
  const running = !!(mcpStatus && mcpStatus.running);
  const preview = $('#mcp-config-preview');
  if (preview) {
    const config = running && mcpStatus.configs && mcpStatus.configs.stdio ? mcpStatus.configs.stdio.json : '';
    preview.hidden = !config;
    preview.textContent = config;
  }
  ['#btn-mcp-copy-stdio', '#btn-mcp-copy-http', '#btn-mcp-rotate'].forEach((selector) => {
    const button = $(selector);
    // 同组互斥锁生效期间不要抢回控件状态，交给 beginSettingsScope 统一恢复。
    if (button && !button.hasAttribute('data-scope-locked')) button.disabled = !running;
  });
}

async function refreshMcpStatus() {
  try {
    const status = await window.api.mcp.status();
    const node = $('#mcp-status');
    // 设置页可能已被重渲染，丢弃过期结果，避免写进新的 DOM。
    if (!node || node.isConnected === false) return;
    mcpStatus = status;
    settings.mcpEnabled = !!status.enabled;
    const toggle = $('#mcp-enabled');
    if (toggle && !toggle.hasAttribute('data-scope-locked')) {
      toggle.classList.toggle('on', !!status.enabled);
      toggle.setAttribute('aria-checked', String(!!status.enabled));
    }
    renderMcpStatus();
  } catch (error) {
    const node = $('#mcp-status');
    if (node && node.isConnected !== false) node.textContent = `读取 MCP 状态失败：${error.message}`;
  }
}

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
    <button type="button" class="settings-nav-item active" data-settings-target="settings-general" aria-controls="settings-general" aria-current="location" tabindex="0">数据</button>
    <button type="button" class="settings-nav-item" data-settings-target="settings-assistant" aria-controls="settings-assistant" tabindex="-1">助手</button>
    <button type="button" class="settings-nav-item" data-settings-target="settings-shortcuts" aria-controls="settings-shortcuts" tabindex="-1">快捷键</button>
    <button type="button" class="settings-nav-item danger" data-settings-target="settings-danger" aria-controls="settings-danger" tabindex="-1">危险操作</button>
  </nav>
  <section class="set-group" id="settings-general" tabindex="-1" aria-labelledby="settings-general-title">
    <h3 class="set-group-title" id="settings-general-title">常规与数据</h3>
    <div class="set-row privacy-row">
      <div><div class="sr-t">本地数据</div><div class="sr-d">任务、备忘录、设置和对话记录保存在本机。使用真实模型时，当前输入、最近 6 轮对话、与当前问题最相关的最多 40 条未归档任务和 30 条备忘录摘要会发送给所选服务商。</div></div>
      <span class="status-badge">本地存储</span>
    </div>
    ${sw('autoBackup', '自动备份', '每日 22:00 将数据快照备份到备份目录')}
    ${sw('autoStart', '开机自启', '登录系统后后台常驻，不弹主窗口')}
    ${sw('notify', '系统通知提醒', '任务到点经系统通知中心推送')}
    ${sw('petEnabled', '桌面桌宠', '常驻桌面最表层的可爱助手，可拖拽、气泡提醒')}
    <div class="set-row">
      <div><div class="sr-t">本地数据文件夹</div><div class="sr-d data-path" id="data-dir" title="${esc(s.dataDir || '')}">${esc(s.dataDir || '')}</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini ghost icon-text" id="btn-open-dir" data-settings-scope="data">${uiIcon('external')}<span>打开文件夹</span></button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">导出与备份</div><div class="sr-d">JSON 包含任务与备忘录，CSV 仅包含任务</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini ghost icon-text" id="btn-export-json" data-settings-scope="data">${uiIcon('download')}<span>导出 JSON</span></button>
        <button type="button" class="btn mini ghost icon-text" id="btn-export-csv" data-settings-scope="data">${uiIcon('download')}<span>导出 CSV</span></button>
        <button type="button" class="btn mini ghost icon-text" id="btn-import-json" data-settings-scope="data">${uiIcon('upload')}<span>导入 JSON</span></button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">备份管理</div><div class="sr-d">查看自动备份，可一键恢复到任意备份点</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini icon-text" id="btn-backup-now" data-settings-scope="data">${uiIcon('save')}<span>立即备份</span></button>
        <button type="button" class="btn mini ghost icon-text" id="btn-backup-to-dir" data-settings-scope="data">${uiIcon('archive')}<span>备份到文件夹</span></button>
        <button type="button" class="btn mini ghost icon-text" id="btn-restore-file" data-settings-scope="data">${uiIcon('undo')}<span>从文件恢复</span></button>
      </div>
    </div>
    <div class="backup-list" id="backup-list" role="region" aria-label="备份记录" aria-live="polite"></div>
    <div class="set-row">
      <div><div class="sr-t">工作时间</div><div class="sr-d" id="work-hours-desc">AI 解析「今天完成」等表达时按此时间作为当天截止；非工作日按默认 18:00</div></div>
      <div class="quiet-time-controls" aria-describedby="work-hours-desc">
        <label><span>开始</span><input id="wh-start" type="time" value="${esc(s.workHours && s.workHours.start || '09:00')}" data-settings-scope="data"></label>
        <label><span>结束</span><input id="wh-end" type="time" value="${esc(s.workHours && s.workHours.end || '18:00')}" data-settings-scope="data"></label>
        <button type="button" class="btn mini ghost" id="btn-wh-save" data-settings-scope="data">保存</button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">工作日</div><div class="sr-d">勾选每周的工作日；非工作日创建的任务按默认 18:00 截止</div></div>
      <div class="seg wh-days" id="wh-days" role="group" aria-label="工作日">
        ${['日','一','二','三','四','五','六'].map((n, i) => {
          const on = !s.workHours || !Array.isArray(s.workHours.days) || s.workHours.days.includes(i);
          return `<button type="button" role="checkbox" aria-checked="${on}" aria-label="周${n}" class="seg-it ${on ? 'active' : ''}" data-day="${i}">${n}</button>`;
        }).join('')}
        <button type="button" class="btn mini ghost" id="btn-wh-days-save">保存</button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">外观主题</div><div class="sr-d">液态玻璃 / 极简单色 / 暗色</div></div>
      <div class="seg" id="theme-seg" role="radiogroup" aria-label="外观主题">
        <button type="button" role="radio" aria-checked="${normalizeTheme(s.theme) === 'glass'}" class="seg-it ${normalizeTheme(s.theme) === 'glass' ? 'active' : ''}" data-theme="glass">液态玻璃</button>
        <button type="button" role="radio" aria-checked="${normalizeTheme(s.theme) === 'mono'}" class="seg-it ${normalizeTheme(s.theme) === 'mono' ? 'active' : ''}" data-theme="mono">极简单色</button>
        <button type="button" role="radio" aria-checked="${normalizeTheme(s.theme) === 'dark'}" class="seg-it ${normalizeTheme(s.theme) === 'dark' ? 'active' : ''}" data-theme="dark">暗色</button>
      </div>
    </div>
  </section>

  <!-- AI 接入配置 -->
  <section class="set-group" id="settings-assistant" tabindex="-1" aria-labelledby="settings-assistant-title">
    <h3 class="set-group-title" id="settings-assistant-title">助手接入</h3>
    <div class="set-row">
      <div><div class="sr-t">AI 助手引擎</div><div class="sr-d">本地助手无需配置；真实模型负责理解意图，任务操作仍由本地执行</div></div>
      <div class="seg" id="ai-stage-seg" role="radiogroup" aria-label="AI 助手引擎">
        <button type="button" role="radio" aria-checked="${s.aiStage === 'mock'}" class="seg-it ${s.aiStage === 'mock' ? 'active' : ''}" data-stage="mock" data-settings-scope="ai">本地助手</button>
        <button type="button" role="radio" aria-checked="${s.aiStage === 'llm'}" class="seg-it ${s.aiStage === 'llm' ? 'active' : ''}" data-stage="llm" data-settings-scope="ai">真实模型</button>
      </div>
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-provider">供应商</label><div class="sr-d" id="ai-provider-desc">选择模型供应商，或自定义 OpenAI 兼容接口</div></div>
      <select id="ai-provider" class="setting-control" aria-describedby="ai-provider-desc" data-settings-scope="ai">
        ${providers.map((p) => `<option value="${p.v}" ${s.aiProvider === p.v ? 'selected' : ''}>${p.n}</option>`).join('')}
      </select>
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-base-url">API Base URL</label><div class="sr-d" id="ai-base-url-desc">OpenAI 兼容接口地址</div></div>
      <input id="ai-base-url" class="setting-control wide" type="url" inputmode="url" autocomplete="off" spellcheck="false" aria-describedby="ai-base-url-desc" data-settings-scope="ai" placeholder="https://api.openai.com/v1" value="${esc(s.aiBaseUrl || '')}">
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-api-key">API Key</label><div class="sr-d" id="ai-api-key-desc">保存在本机，请求时仅用于所选服务商鉴权</div></div>
      <input id="ai-api-key" class="setting-control wide" type="password" autocomplete="off" spellcheck="false" aria-describedby="ai-api-key-desc" data-settings-scope="ai" placeholder="sk-..." value="${esc(s.aiApiKey || '')}">
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-model">模型名称</label><div class="sr-d" id="ai-model-desc">如 gpt-4o-mini / deepseek-chat</div></div>
      <input id="ai-model" class="setting-control wide" type="text" autocomplete="off" spellcheck="false" aria-describedby="ai-model-desc" data-settings-scope="ai" placeholder="gpt-4o-mini" value="${esc(s.aiModel || '')}">
    </div>
    <div class="set-row ai-config-row">
      <div><label class="sr-t" for="ai-temperature">温度</label><div class="sr-d" id="ai-temperature-desc">越低越稳定，建议 0.2</div></div>
      <input id="ai-temperature" class="setting-control number" type="number" min="0" max="2" step="0.1" aria-describedby="ai-temperature-desc" data-settings-scope="ai" value="${s.aiTemperature != null ? s.aiTemperature : 0.2}">
    </div>
    <div class="set-row ai-config-row">
      <div><div class="sr-t">连接测试</div><div class="sr-d" id="ai-test-result" role="status" aria-live="polite">未测试</div></div>
      <button type="button" class="btn mini ghost icon-text" id="btn-ai-test" data-settings-scope="ai">${uiIcon('refresh')}<span>测试连接</span></button>
    </div>
    <div class="set-row ai-config-row">
      <div><div class="sr-t">保存配置</div><div class="sr-d">保存后 AI 面板将使用所选引擎</div></div>
      <button type="button" class="btn mini icon-text" id="btn-ai-save" data-settings-scope="ai">${uiIcon('save')}<span>保存 AI 配置</span></button>
    </div>
    <div class="set-row mcp-row">
      <div><div class="sr-t">MCP 服务（供其他 AI agent 调用）</div><div class="sr-d" id="mcp-desc">开启后，本机其他 AI agent 可经 MCP 读写任务、备忘录、日计划与报告，共 ${mcpStatus && mcpStatus.toolCount ? mcpStatus.toolCount : 32} 个工具。只监听 127.0.0.1 并校验 token，删除等破坏性操作仍需二次确认。内容会经对方 agent 离开本机，请只连接你信任的客户端。</div></div>
      <button type="button" class="switch ${s.mcpEnabled ? 'on' : ''}" id="mcp-enabled" role="switch" aria-checked="${!!s.mcpEnabled}" aria-label="MCP 服务" aria-describedby="mcp-desc" data-settings-scope="mcp"></button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">连接状态</div><div class="sr-d" id="mcp-status" role="status" aria-live="polite">正在读取…</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini ghost icon-text" id="btn-mcp-refresh" data-settings-scope="mcp">${uiIcon('refresh')}<span>刷新</span></button>
        <button type="button" class="btn mini ghost icon-text" id="btn-mcp-rotate" data-settings-scope="mcp">${uiIcon('refresh')}<span>轮换 token</span></button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="sr-t">客户端配置</div><div class="sr-d" id="mcp-config-hint">stdio 适配所有客户端，用应用自带运行时，无需另装 Node；HTTP 适配支持 streamable HTTP 的客户端。配置含 token，请勿分享。</div></div>
      <div class="setting-actions">
        <button type="button" class="btn mini ghost icon-text" id="btn-mcp-copy-stdio" data-settings-scope="mcp">${uiIcon('copy')}<span>复制 stdio</span></button>
        <button type="button" class="btn mini ghost icon-text" id="btn-mcp-copy-http" data-settings-scope="mcp">${uiIcon('copy')}<span>复制 HTTP</span></button>
      </div>
    </div>
    <pre class="mcp-config-preview" id="mcp-config-preview" tabindex="0" aria-label="MCP 客户端配置预览" hidden></pre>
  </section>

  <section class="set-group" id="settings-shortcuts" tabindex="-1" aria-labelledby="settings-shortcuts-title">
    <h3 class="set-group-title" id="settings-shortcuts-title">快捷键</h3>
    <p class="set-group-intro">全局有效。聚焦输入框后，直接按下新的组合键。</p>
    ${shortcutRow('sc-ai', '唤起助手输入框', s.shortcuts && s.shortcuts.ai || 'CommandOrControl+J')}
    ${shortcutRow('sc-newTask', '新建任务', s.shortcuts && s.shortcuts.newTask || 'CommandOrControl+N')}
    ${shortcutRow('sc-today', '打开今日视图', s.shortcuts && s.shortcuts.today || 'CommandOrControl+1')}
  </section>
  <section class="set-group danger-zone" id="settings-danger" tabindex="-1" aria-labelledby="settings-danger-title">
    <h3 class="set-group-title" id="settings-danger-title">危险操作</h3>
    <div class="set-row">
      <div><div class="sr-t">重置演示任务</div><div class="sr-d">用初始演示任务替换当前全部任务，备忘录不受影响</div></div>
      <button type="button" class="btn mini danger icon-text" id="btn-reset">${uiIcon('refresh')}<span>重置任务</span></button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">清空全部任务</div><div class="sr-d">删除所有任务（含已完成与归档），备忘录不受影响</div></div>
      <button type="button" class="btn mini danger icon-text" id="btn-clear-all">${uiIcon('trash')}<span>清空任务</span></button>
    </div>
  </section>`;

  $('#settings-body').innerHTML = html;
  bindSettingsEvents();
  renderMcpStatus();
  refreshMcpStatus();
}

function setSettingsNavActive(targetId) {
  $$('#settings-body .settings-nav [data-settings-target]').forEach((button) => {
    const active = button.dataset.settingsTarget === targetId;
    button.classList.toggle('active', active);
    button.tabIndex = active ? 0 : -1;
    if (active) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  });
}

function syncSettingsNavFromScroll() {
  const content = $('.content');
  const nav = $('#settings-body .settings-nav');
  if (!content || !nav) return;
  const sections = $$('#settings-body .set-group');
  if (!sections.length) return;
  const maxScrollTop = Math.max(0, content.scrollHeight - content.clientHeight);
  if (maxScrollTop > 0 && content.scrollTop >= maxScrollTop - 2) {
    setSettingsNavActive(sections[sections.length - 1].id);
    return;
  }
  const marker = content.getBoundingClientRect().top + nav.getBoundingClientRect().height + 18;
  let active = sections[0];
  sections.forEach((section) => {
    if (section.getBoundingClientRect().top <= marker) active = section;
  });
  setSettingsNavActive(active.id);
}

function focusSettingsSection(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return false;
  setSettingsNavActive(targetId);
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

function onSettingsNavKeyDown(event) {
  const button = event.target.closest('[data-settings-target]');
  if (!button) return;
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll('[data-settings-target]'));
  const index = buttons.indexOf(button);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  let target = index;
  if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = buttons.length - 1;
  else if (event.key === 'ArrowLeft') target = (index - 1 + buttons.length) % buttons.length;
  else target = (index + 1) % buttons.length;
  buttons.forEach((item, itemIndex) => { item.tabIndex = itemIndex === target ? 0 : -1; });
  buttons[target].focus();
}

function beginSettingsScope(scope, controls) {
  if (!scope) return () => {};
  if (settingsActionScopes.has(scope)) return null;
  settingsActionScopes.add(scope);
  const items = controls || $$(`#settings-body [data-settings-scope="${scope}"]`);
  const states = items.map((control) => ({ control, disabled: !!control.disabled }));
  states.forEach(({ control }) => {
    control.disabled = true;
    control.setAttribute('data-scope-locked', 'true');
  });
  return () => {
    settingsActionScopes.delete(scope);
    states.forEach(({ control, disabled }) => {
      if (control.isConnected === false) return;
      control.disabled = disabled;
      control.removeAttribute('data-scope-locked');
    });
  };
}

async function runSettingsAction(button, busyText, action, failureMessage, scope) {
  if (!button || button.disabled) return false;
  const idleHtml = button.innerHTML;
  const restoreFocus = document.activeElement === button;
  const focusFallback = button.closest('.set-group');
  const releaseScope = beginSettingsScope(scope);
  if (!releaseScope) return false;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyText;
  try {
    return await action();
  } catch (error) {
    console.error('[settings] action failed:', error);
    toast(failureMessage, 4000, null, 'err');
    return false;
  } finally {
    releaseScope();
    if (button.isConnected !== false) {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.innerHTML = idleHtml;
      const active = document.activeElement;
      if (restoreFocus && (!active || active === document.body || active === focusFallback)) {
        button.focus({ preventScroll: true });
      }
    }
  }
}

function bindSettingsEvents() {
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
  $('#settings-body .settings-nav')?.addEventListener('keydown', onSettingsNavKeyDown);
  const content = $('.content');
  if (content && !content.__settingsScrollBound) {
    content.__settingsScrollBound = true;
    content.addEventListener('scroll', () => {
      if (currentView === 'settings') syncSettingsNavFromScroll();
    }, { passive: true });
  }
  syncSettingsNavFromScroll();

  // 工作时间保存
  $('#btn-wh-save')?.addEventListener('click', () => {
    const button = $('#btn-wh-save');
    runSettingsAction(button, '保存中…', async () => {
      const start = $('#wh-start').value;
      const end = $('#wh-end').value;
      if (!start || !end) throw new Error('请选择开始和结束时间');
      if (end <= start) throw new Error('结束时间需要晚于开始时间');
      const current = settings.workHours || {};
      settings.workHours = await window.api.settings.update({
        workHours: { start, end, days: Array.isArray(current.days) ? current.days : [1, 2, 3, 4, 5] }
      }).then((s) => s.workHours);
      toast(`工作时间已设为 ${start}-${end}`);
      return true;
    }, '工作时间保存失败，请检查时间', 'data');
  });

  // 工作日勾选与保存
  $$('#wh-days .seg-it[data-day]').forEach((seg) => {
    seg.addEventListener('click', () => {
      const on = seg.classList.toggle('active');
      seg.setAttribute('aria-checked', String(on));
    });
  });
  $('#btn-wh-days-save')?.addEventListener('click', () => {
    const button = $('#btn-wh-days-save');
    runSettingsAction(button, '保存中…', async () => {
      const days = $$('#wh-days .seg-it.active').map((el) => Number(el.dataset.day)).sort((a, b) => a - b);
      if (!days.length) throw new Error('至少勾选一个工作日');
      const current = settings.workHours || {};
      settings.workHours = await window.api.settings.update({
        workHours: { start: current.start || '09:00', end: current.end || '18:00', days }
      }).then((s) => s.workHours);
      toast(`工作日已更新（每周 ${days.length} 天）`);
      return true;
    }, '工作日保存失败，请稍后重试', 'data');
  });

  // MCP 服务开关：与主进程同一步完成设置写入与端口启停，失败回滚开关
  $('#mcp-enabled')?.addEventListener('click', async (event) => {
    const control = event.currentTarget;
    const previous = control.classList.contains('on');
    const enabled = !previous;
    const releaseScope = beginSettingsScope('mcp');
    if (!releaseScope) return;
    control.classList.toggle('on', enabled);
    control.setAttribute('aria-checked', String(enabled));
    control.setAttribute('aria-busy', 'true');
    try {
      mcpStatus = await window.api.mcp.setEnabled(enabled);
      settings.mcpEnabled = !!mcpStatus.enabled;
      renderMcpStatus();
      if (!enabled) toast('MCP 服务已关闭，端口已释放', 2600, null, 'ok');
      else if (mcpStatus.running) toast(`MCP 服务已开启：${mcpStatus.url}`, 3200, null, 'ok');
      else toast('MCP 已开启但启动失败，请查看连接状态', 4000, null, 'err');
    } catch (error) {
      settings.mcpEnabled = previous;
      control.classList.toggle('on', previous);
      control.setAttribute('aria-checked', String(previous));
      toast('MCP 设置保存失败，已恢复原状态', 3500, null, 'err');
    } finally {
      releaseScope();
      control.setAttribute('aria-busy', 'false');
    }
  });

  $('#btn-mcp-refresh')?.addEventListener('click', () => {
    const button = $('#btn-mcp-refresh');
    runSettingsAction(button, '读取中…', async () => {
      mcpStatus = await window.api.mcp.status();
      settings.mcpEnabled = !!mcpStatus.enabled;
      const toggle = $('#mcp-enabled');
      if (toggle && !toggle.hasAttribute('data-scope-locked')) {
        toggle.classList.toggle('on', !!mcpStatus.enabled);
        toggle.setAttribute('aria-checked', String(!!mcpStatus.enabled));
      }
      renderMcpStatus();
      return true;
    }, '读取 MCP 状态失败，请重试', 'mcp');
  });

  $('#btn-mcp-rotate')?.addEventListener('click', () => {
    const button = $('#btn-mcp-rotate');
    runSettingsAction(button, '轮换中…', async () => {
      mcpStatus = await window.api.mcp.rotateToken();
      renderMcpStatus();
      toast('token 已轮换，旧配置立即失效，请重新复制到客户端', 4200, null, 'ok');
      return true;
    }, 'token 轮换失败，请重试', 'mcp');
  });

  async function copyMcpConfig(kind, button) {
    if (!mcpStatus || !mcpStatus.running) {
      toast('请先开启 MCP 服务', 3000, null, 'warn');
      return;
    }
    const configs = mcpStatus.configs || {};
    const entry = kind === 'http' ? configs.http : configs.stdio;
    if (!entry || !entry.json) {
      toast('暂时拿不到客户端配置，请先刷新连接状态', 3200, null, 'warn');
      return;
    }
    const text = entry.json;
    const releaseScope = beginSettingsScope('mcp', [button]);
    if (!releaseScope) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(kind === 'http' ? 'HTTP 配置已复制，含 token，请勿分享' : 'stdio 配置已复制', 2800, null, 'ok');
    } catch (error) {
      // 复制失败时把配置摊开并聚焦，用户仍可手动选择复制。
      const preview = $('#mcp-config-preview');
      if (preview) {
        preview.hidden = false;
        preview.textContent = text;
        preview.focus({ preventScroll: true });
      }
      toast('复制失败，已展开配置，请手动选择复制', 3500, null, 'err');
    } finally {
      releaseScope();
    }
  }

  $('#btn-mcp-copy-stdio')?.addEventListener('click', (event) => copyMcpConfig('stdio', event.currentTarget));
  $('#btn-mcp-copy-http')?.addEventListener('click', (event) => copyMcpConfig('http', event.currentTarget));

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
      const group = $('#ai-stage-seg');
      const releaseScope = beginSettingsScope('ai');
      if (!releaseScope) return;
      group.setAttribute('aria-busy', 'true');
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
      } finally {
        group.setAttribute('aria-busy', 'false');
        releaseScope();
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
  $('#btn-ai-test').addEventListener('click', () => {
    const resultEl = $('#ai-test-result');
    const button = $('#btn-ai-test');
    runSettingsAction(button, '测试中…', async () => {
      resultEl.textContent = '测试中…';
      resultEl.className = 'sr-d test-result testing';
      try {
        // 先保存当前输入到设置，再测试
        await saveAiConfig(false);
        const res = await window.api.ai.test();
        resultEl.textContent = res.message;
        resultEl.className = `sr-d test-result ${res.ok ? 'success' : 'failure'}`;
        setAiRuntimeState(res.ok ? 'ready' : 'degraded', res.ok ? '' : (res.message || '模型连接测试未通过，请检查配置后重试。'));
      } catch (error) {
        resultEl.textContent = '测试失败，请检查配置或网络';
        resultEl.className = 'sr-d test-result failure';
        setAiRuntimeState('degraded', '模型连接测试未通过，请检查配置或网络。');
        throw error;
      }
    }, '连接测试失败，请检查配置或网络', 'ai');
  });

  // 保存 AI 配置
  $('#btn-ai-save').addEventListener('click', () => {
    const button = $('#btn-ai-save');
    runSettingsAction(button, '保存中…', () => saveAiConfig(true), 'AI 配置保存失败，请重试', 'ai');
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
    }, 'JSON 导出失败，请稍后重试', 'data');
  });
  $('#btn-export-csv').addEventListener('click', () => {
    const button = $('#btn-export-csv');
    runSettingsAction(button, '导出中…', async () => {
      const csv = await window.api.data.exportCSV();
      downloadSettingsFile('\ufeff' + csv, 'text/csv;charset=utf-8', `work-helper-${new Date().toISOString().slice(0, 10)}.csv`);
      toast('已导出 CSV 表格', 2500, null, 'ok');
    }, 'CSV 导出失败，请稍后重试', 'data');
  });
  $('#btn-open-dir').addEventListener('click', () => {
    const button = $('#btn-open-dir');
    runSettingsAction(button, '打开中…', async () => {
      await window.api.data.openDir();
      toast('已打开本地数据文件夹');
    }, '无法打开数据文件夹，请稍后重试', 'data');
  });
  const importButton = $('#btn-import-json');
  importButton.addEventListener('click', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      await runSettingsAction(importButton, '导入中…', async () => {
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
      }, '导入失败，请检查文件后重试', 'data');
    });
    input.click();
  });

  // 备份管理
  async function loadBackupList(restoreFocus) {
    const box = $('#backup-list');
    if (!box || box.getAttribute('aria-busy') === 'true') return false;
    const hasContent = !!box.querySelector('.backup-row, .backup-empty');
    box.setAttribute('aria-busy', 'true');
    box.setAttribute('aria-label', hasContent ? '正在更新备份列表' : '正在读取备份列表');
    box.classList.toggle('is-refreshing', hasContent);
    if (!hasContent) box.innerHTML = '<div class="load-state compact" role="status"><span class="load-indicator" aria-hidden="true"></span><div><strong>正在读取备份</strong></div></div>';
    try {
      const list = await window.api.data.listBackups();
      if (!list.length) {
        box.innerHTML = '<div class="backup-empty">暂无备份，点击「立即备份」创建第一份</div>';
      } else {
        box.innerHTML = list.map((b) => `
          <div class="backup-row">
            <span class="backup-time">${esc(b.time || b.name)}</span>
            <span class="backup-size">${(b.size / 1024).toFixed(1)} KB</span>
            <button type="button" class="btn mini ghost icon-text" data-restore="${esc(b.path)}">${uiIcon('undo')}<span>恢复</span></button>
          </div>`).join('');
        box.querySelectorAll('[data-restore]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const filePath = btn.dataset.restore;
            confirmDialog('确定要恢复到该备份点吗？当前数据会先自动备份，然后被该备份覆盖。', async () => {
              if ((await saveMemoNow()) === false) return false;
              const result = await window.api.data.restoreBackup(filePath);
              return reloadRestoredWorkspace(result, '已恢复到备份点', '#btn-backup-now');
            }, '恢复');
          });
        });
      }
      if (restoreFocus) (box.querySelector('[data-restore]') || $('#btn-backup-now'))?.focus({ preventScroll: true });
      return true;
    } catch (e) {
      console.error('[settings] backup list failed:', e);
      box.innerHTML = '<div class="backup-empty error"><span>备份列表加载失败</span><button type="button" class="btn mini ghost" id="backup-retry">重试</button></div>';
      const retry = $('#backup-retry');
      retry.addEventListener('click', () => loadBackupList(true));
      if (restoreFocus) retry.focus({ preventScroll: true });
      return false;
    } finally {
      box.setAttribute('aria-busy', 'false');
      box.removeAttribute('aria-label');
      box.classList.remove('is-refreshing');
    }
  }

  $('#btn-backup-now').addEventListener('click', () => {
    const button = $('#btn-backup-now');
    runSettingsAction(button, '备份中…', async () => {
      await window.api.data.backup();
      toast('已创建备份', 2500, null, 'ok');
      await loadBackupList();
    }, '备份失败，请稍后重试', 'data');
  });
  $('#btn-backup-to-dir').addEventListener('click', () => {
    const button = $('#btn-backup-to-dir');
    runSettingsAction(button, '选择中…', async () => {
      const res = await window.api.data.backupToDir();
      if (res.ok) toast(`已备份到：${res.file}`, 4000, null, 'ok');
      else if (res.error) throw new Error(res.error);
    }, '备份到文件夹失败，请稍后重试', 'data');
  });
  $('#btn-restore-file').addEventListener('click', () => {
    const button = $('#btn-restore-file');
    runSettingsAction(button, '选择中…', async () => {
      const res = await window.api.data.pickBackupFile();
      if (!res.ok) return;
      confirmDialog('确定要从该文件恢复吗？当前数据会先自动备份，然后被该文件覆盖。', async () => {
        if ((await saveMemoNow()) === false) return false;
        const result = await window.api.data.restoreBackup(res.file);
        return reloadRestoredWorkspace(result, '已从文件恢复', '#btn-restore-file');
      }, '恢复');
    }, '无法选择备份文件，请稍后重试', 'data');
  });
  loadBackupList();
  $$('#theme-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', async () => {
      const group = $('#theme-seg');
      const controls = Array.from(group.querySelectorAll('.seg-it'));
      const releaseScope = beginSettingsScope('theme', controls);
      if (!releaseScope) return;
      group.setAttribute('aria-busy', 'true');
      const previous = normalizeTheme(settings.theme);
      const next = normalizeTheme(seg.dataset.theme);
      $$('#theme-seg .seg-it').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
      });
      seg.classList.add('active');
      seg.setAttribute('aria-checked', 'true');
      settings.theme = next;
      applyTheme();
      try {
        await window.api.settings.update({ theme: next });
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
      } finally {
        group.setAttribute('aria-busy', 'false');
        releaseScope();
      }
    });
  });
  bindRadioGroupKeyboard($('#theme-seg'));
  $('#btn-reset').addEventListener('click', () => {
    confirmDialog('确定用初始演示任务替换当前全部任务吗？现有任务将被覆盖，备忘录不受影响。', async () => {
      tasks = await window.api.tasks.reset();
      renderAll();
      toast('任务已重置为演示数据', 3000, null, 'ok');
      return { focusTarget: '#btn-reset' };
    }, '重置');
  });
  $('#btn-clear-all').addEventListener('click', async () => {
    confirmDialog('确定要清空全部任务吗？此操作不可恢复，备忘录不受影响。', async () => {
      tasks = await window.api.tasks.clearAll();
      renderAll();
      toast('已清空全部任务', 3000, null, 'ok');
      return { focusTarget: '#btn-clear-all' };
    }, '清空任务');
  });

  // 快捷键自定义：保留现有值，聚焦后直接录入新组合键。
  ['sc-ai', 'sc-newTask', 'sc-today'].forEach((id) => {
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
      if (el.getAttribute('aria-busy') === 'true') {
        e.preventDefault();
        return;
      }
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
      const keyMap = { 'sc-ai': 'ai', 'sc-newTask': 'newTask', 'sc-today': 'today' };
      const shortcuts = Object.assign({}, previousShortcuts, { [keyMap[id]]: combo });
      const releaseScope = beginSettingsScope(`shortcut:${id}`, []);
      if (!releaseScope) return;
      settings.shortcuts = shortcuts;
      el.readOnly = true;
      el.setAttribute('aria-busy', 'true');
      try {
        await window.api.settings.update({ shortcuts });
        toast(`快捷键已更新：${shortcutLabel(combo)}`, 2500, null, 'ok');
        el.blur();
      } catch (error) {
        settings.shortcuts = previousShortcuts;
        el.dataset.accelerator = previousAccelerator;
        el.value = shortcutLabel(previousAccelerator);
        toast('快捷键保存失败，已恢复原设置', 3500, null, 'err');
      } finally {
        el.readOnly = false;
        el.setAttribute('aria-busy', 'false');
        releaseScope();
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
  const t = normalizeTheme(settings.theme);
  const root = document.documentElement;
  if (root) root.dataset.theme = t;
  document.body.classList.toggle('dark', t === 'dark');
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
  if (selectedMemoId === MEMO_DRAFT_ID) return memoDraftMemo;
  return memos.find((memo) => memo.id === selectedMemoId) || null;
}

function deriveMemoTitle(content) {
  const firstLine = String(content || '').replace(/\s+/g, ' ').trim();
  if (!firstLine) return '';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

function memoDraft() {
  const title = $('#memo-title').value.trim();
  const content = $('#memo-content').value;
  return {
    title: title || deriveMemoTitle(content) || '无标题备忘录',
    content,
    tags: memoTagsAll()
  };
}

// 草稿是否还空着：空草稿不该落库
function memoEditorIsEmpty() {
  return !$('#memo-title').value.trim() && !$('#memo-content').value.trim();
}

function memoFilterActive() {
  return memoFilter !== 'all';
}

function memoMatchesFilter(memo) {
  if (memoFilter === 'all') return true;
  if (memoFilter === 'pinned') return !!memo.pinned;
  if (memoFilter.startsWith('tag:')) return (memo.tags || []).includes(memoFilter.slice(4));
  return true;
}

function memoTagCounts() {
  const counts = new Map();
  memos.forEach((memo) => (memo.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
}

function visibleMemos() {
  const query = memoSearch.trim().toLowerCase();
  return memos
    .filter((memo) => memoMatchesFilter(memo))
    .filter((memo) => {
      if (!query) return true;
      return [memo.title, memo.content, ...(memo.tags || [])].join(' ').toLowerCase().includes(query);
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function renderMemoFilters() {
  const wrap = $('#memo-filters');
  if (!wrap) return;
  const chip = (value, label) => `<button type="button" class="fchip ${memoFilter === value ? 'active' : ''}" aria-pressed="${memoFilter === value}" data-memo-filter="${esc(value)}">${esc(label)}</button>`;
  const tags = memoTagCounts().slice(0, 8);
  wrap.innerHTML = [chip('all', '全部'), chip('pinned', '置顶'), ...tags.map(([tag]) => chip(`tag:${tag}`, `#${tag}`))].join(' ');
}

function syncMemoDraftRow() {
  if (!memoDraftMemo) return;
  const title = $('#memo-title').value.trim() || deriveMemoTitle($('#memo-content').value);
  memoDraftMemo.title = title;
  const row = document.querySelector(`#memo-list [data-memo-id="${MEMO_DRAFT_ID}"] .memo-list-title`);
  if (row) row.textContent = title || '新备忘录';
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
  renderMemoFilters();
  const query = memoSearch.trim().toLowerCase();
  const visible = visibleMemos();
  const sub = $('#list-sub');
  if (sub && listTab === 'memos') {
    const pinnedCount = memos.filter((memo) => memo.pinned).length;
    sub.textContent = memoFilterActive() || query
      ? `筛选出 ${visible.length} 条 · 共 ${memos.length} 条`
      : `${memos.length} 条${pinnedCount ? ` · ${pinnedCount} 条置顶` : ''}`;
  }
  const draftRow = memoDraftMemo ? `<button type="button" class="memo-list-item draft active" data-memo-id="${MEMO_DRAFT_ID}" role="option" tabindex="0" aria-selected="true">
      <span class="memo-list-body">
        <span class="memo-list-title">${esc(memoDraftMemo.title || '新备忘录')}</span>
        <span class="memo-list-preview">未保存 · 开始输入后自动落库</span>
        <span class="memo-list-meta"><span class="memo-list-time">草稿</span></span>
      </span>
    </button>` : '';
  if (!visible.length) {
    list.innerHTML = `${draftRow}<div class="memo-list-empty">${query || memoFilterActive()
      ? '没有匹配的备忘录<button type="button" class="memo-clear-filter" id="memo-clear-filter">清除筛选</button>'
      : '暂无备忘录'}</div>`;
    return;
  }
  const visibleIds = new Set(visible.map((memo) => memo.id));
  const focusId = visibleIds.has(memoFocusId)
    ? memoFocusId
    : visibleIds.has(selectedMemoId) ? selectedMemoId : visible[0].id;
  memoFocusId = focusId;
  list.innerHTML = draftRow + visible.map((memo) => {
    const preview = memo.content.trim().replace(/\s+/g, ' ') || (memo.tags || []).map((tag) => `#${tag}`).join(' ') || '空白备忘录';
    const tags = (memo.tags || []).slice(0, 3).map((tag) => `<span class="tag-chip">#${esc(tag)}</span>`).join(' ');
    return `<button type="button" class="memo-list-item${memo.id === selectedMemoId ? ' active' : ''}${memo.pinned ? ' pinned' : ''}" data-memo-id="${memo.id}" role="option" tabindex="${memo.id === focusId ? 0 : -1}" aria-selected="${memo.id === selectedMemoId}">
      <span class="memo-list-body">
        <span class="memo-list-title">${esc(memo.title)}</span>
        <span class="memo-list-preview">${esc(preview)}</span>
        <span class="memo-list-meta">${tags}<span class="memo-list-time">${memo.pinned ? '置顶 · ' : ''}${esc(memoTime(memo.updatedAt))}</span></span>
      </span>
    </button>`;
  }).join('');
}

// 标签：chip 是已提交项，输入框只留在输入中的片段，避免同一标签显示两遍
let memoTagCommitted = [];

function memoTagsAll() {
  return [...new Set([...memoTagCommitted, ...parseMemoTags($('#memo-tags').value)])].slice(0, 5);
}

function removeMemoTag(tag) {
  memoTagCommitted = memoTagCommitted.filter((item) => item !== tag);
  $('#memo-tags').value = parseMemoTags($('#memo-tags').value).filter((item) => item !== tag).join(' ');
  renderMemoTagChips();
  scheduleMemoSave();
  $('#memo-tags').focus({ preventScroll: true });
}

function commitMemoTags() {
  const pending = parseMemoTags($('#memo-tags').value);
  if (!pending.length) return false;
  memoTagCommitted = [...new Set([...memoTagCommitted, ...pending])].slice(0, 5);
  $('#memo-tags').value = '';
  renderMemoTagChips();
  scheduleMemoSave();
  return true;
}

function renderMemoTagChips() {
  const wrap = $('#memo-tag-chips');
  if (!wrap) return;
  wrap.innerHTML = memoTagCommitted.map((tag) => `<span class="memo-tag-chip">${esc(tag)}<button type="button" data-memo-tag-remove="${esc(tag)}" aria-label="移除标签 ${esc(tag)}">×</button></span>`).join('');
}

function renderMemoEditor() {
  const memo = currentMemo();
  $('#memo-empty').classList.toggle('hidden', !!memo);
  $('#memo-editor').classList.toggle('hidden', !memo);
  if (!memo) return;
  const copyButton = $('#memo-copy');
  copyButton.classList.remove('copied');
  copyButton.innerHTML = uiIcon('copy');
  copyButton.dataset.tooltip = '复制';
  copyButton.disabled = memoActionBusy;
  $('#memo-title').value = memo.title;
  $('#memo-content').value = memo.content || '';
  $('#memo-tags').value = '';
  memoTagCommitted = [...(memo.tags || [])];
  renderMemoTagChips();
  $('#memo-pin').classList.toggle('active', !!memo.pinned);
  $('#memo-pin').setAttribute('aria-pressed', String(!!memo.pinned));
  $('#memo-pin').setAttribute('aria-label', memo.pinned ? '取消置顶备忘录' : '置顶备忘录');
  $('#memo-pin').dataset.tooltip = memo.pinned ? '取消置顶' : '置顶';
  $('#memo-pin').disabled = memoActionBusy || !!memo._draft;
  $('#memo-to-task').disabled = memoActionBusy || !!memo._draft;
  if (memo._draft) {
    setMemoSaveState('waiting', '未保存');
    $('#memo-updated').textContent = '开始输入后自动落库';
  } else {
    setMemoSaveState('saved', '已保存');
    $('#memo-updated').textContent = `最近编辑 ${memoTime(memo.updatedAt)}`;
  }
  memoDirty = false;
  memoDraftRevision = 0;
  syncMemoActionBusyState();
}

function syncMemoActionBusyState() {
  const controls = ['memo-pin', 'memo-copy', 'memo-to-task', 'memo-delete']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  controls.forEach((control) => {
    const active = memoActionBusy && control.id === memoActionControlId;
    control.disabled = memoActionBusy;
    control.classList.toggle('is-busy', active);
    control.setAttribute('aria-busy', String(active));
    if (active) {
      const label = control.querySelector('span:last-child');
      if (label) label.textContent = memoActionLabel;
      else control.dataset.tooltip = memoActionLabel;
    } else if (!memoActionBusy) {
      const label = control.querySelector('span:last-child');
      if (label) label.textContent = '转为任务';
      else if (control.id === 'memo-pin') {
        const memo = currentMemo();
        control.dataset.tooltip = memo && memo.pinned ? '取消置顶' : '置顶';
      } else if (control.id === 'memo-copy') control.dataset.tooltip = '复制';
      else if (control.id === 'memo-delete') control.dataset.tooltip = '删除';
    }
  });
}

function beginMemoAction(control, label) {
  if (memoActionBusy || !control) return null;
  memoActionBusy = true;
  memoActionControlId = control.id;
  memoActionLabel = label;
  syncMemoActionBusyState();
  setMemoSaveState('saving', label);
  return (restoreFocus = true) => {
    const controlId = memoActionControlId;
    memoActionBusy = false;
    syncMemoActionBusyState();
    memoActionControlId = '';
    memoActionLabel = '';
    if (!memoDirty && memoSavePending === 0 && currentMemo()) setMemoSaveState('saved', '已保存');
    const nextControl = document.getElementById(controlId);
    if (restoreFocus && currentView === 'list' && listTab === 'memos' && nextControl && !nextControl.disabled) {
      nextControl.focus({ preventScroll: true });
    }
  };
}

function renderMemos() {
  if (selectedMemoId === MEMO_DRAFT_ID && !memoDraftMemo) {
    selectedMemoId = null;
    memoFocusId = null;
  }
  if (selectedMemoId && selectedMemoId !== MEMO_DRAFT_ID && !currentMemo()) {
    selectedMemoId = null;
    memoFocusId = null;
  }
  if (!selectedMemoId && !memoDraftMemo && memos.length) {
    selectedMemoId = memos[0].id;
    memoFocusId = selectedMemoId;
  }
  renderMemoList();
  renderNavBadges();
  if (!memoDirty && memoSavePending === 0) renderMemoEditor();
}

function setMemoSaveState(state, label) {
  const element = $('#memo-save-state');
  element.dataset.state = state;
  element.textContent = label;
}

function discardMemoDraft() {
  if (!memoDraftMemo) return;
  memoDraftMemo = null;
  memoDirty = false;
  if (selectedMemoId === MEMO_DRAFT_ID) {
    selectedMemoId = memos.length ? memos[0].id : null;
    memoFocusId = selectedMemoId;
  }
  renderMemos();
}

// 草稿落库：只有真的写下内容才创建记录，空草稿直接丢弃
function saveMemoDraft() {
  if (!memoDraftMemo) return memoSaveChain;
  if ($('#memo-editor').classList.contains('hidden')) return memoSaveChain;
  if (memoEditorIsEmpty()) {
    discardMemoDraft();
    return memoSaveChain;
  }
  if (memoSavePending) return memoSaveChain;
  const patch = memoDraft();
  memoDirty = false;
  memoSavePending++;
  setMemoSaveState('saving', '保存中…');
  memoSaveChain = memoSaveChain.then(async () => {
    const created = await window.api.memos.create(patch);
    memos = [created, ...memos].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    memoDraftMemo = null;
    selectedMemoId = created.id;
    memoFocusId = created.id;
    renderMemos();
    setMemoSaveState('saved', '已保存');
    $('#memo-updated').textContent = `最近编辑 ${memoTime(created.updatedAt)}`;
    return true;
  }).catch((error) => {
    memoDirty = true;
    setMemoSaveState('error', '保存失败');
    toast(`备忘录保存失败：${error.message}`, 4000, null, 'err');
    return false;
  }).finally(() => {
    memoSavePending = Math.max(0, memoSavePending - 1);
  });
  return memoSaveChain;
}

function saveMemoNow() {
  if (memoSaveTimer) {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = null;
  }
  if (selectedMemoId === MEMO_DRAFT_ID) return saveMemoDraft();
  if (!memoDirty) return memoSaveChain;
  const id = selectedMemoId;
  if (!id || !currentMemo() || $('#memo-editor').classList.contains('hidden')) return memoSaveChain;
  const patch = memoDraft();
  const revision = memoDraftRevision;
  memoDirty = false;
  memoSavePending++;
  setMemoSaveState('saving', '保存中…');
  memoSaveChain = memoSaveChain.then(async () => {
    const updated = await window.api.memos.update(id, patch);
    const index = memos.findIndex((memo) => memo.id === id);
    if (index >= 0) memos[index] = updated;
    memos.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    renderMemoList();
    if (selectedMemoId === id && revision === memoDraftRevision) {
      setMemoSaveState('saved', '已保存');
      $('#memo-updated').textContent = `最近编辑 ${memoTime(updated.updatedAt)}`;
    }
  }).catch((error) => {
    if (revision === memoDraftRevision) {
      memoDirty = true;
      if (selectedMemoId === id) setMemoSaveState('error', '保存失败');
    }
    toast(`备忘录保存失败：${error.message}`, 4000, null, 'err');
    return false;
  }).finally(() => {
    memoSavePending = Math.max(0, memoSavePending - 1);
  });
  return memoSaveChain;
}

function scheduleMemoSave() {
  memoDirty = true;
  memoDraftRevision++;
  setMemoSaveState('waiting', '等待保存…');
  syncMemoDraftRow();
  if (memoSaveTimer) clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(saveMemoNow, 450);
}

async function selectMemo(id, restoreFocus) {
  if (id === selectedMemoId) return true;
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
  if (memoCreating) return false;
  // 已有草稿就回到草稿，不重复创建
  if (memoDraftMemo) {
    selectedMemoId = MEMO_DRAFT_ID;
    memoFocusId = MEMO_DRAFT_ID;
    renderMemos();
    $('#memo-title').focus({ preventScroll: true });
    return true;
  }
  memoCreating = true;
  const createButtons = [$('#memo-new'), $('#memo-empty-new')].filter(Boolean);
  createButtons.forEach((button) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  });
  try {
    if ((await saveMemoNow()) === false) return false;
    memoDraftMemo = {
      id: MEMO_DRAFT_ID,
      title: '',
      content: '',
      tags: [],
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _draft: true
    };
    memoTagCommitted = [];
    selectedMemoId = MEMO_DRAFT_ID;
    memoFocusId = MEMO_DRAFT_ID;
    renderMemos();
    $('#memo-title').focus({ preventScroll: true });
    return true;
  } catch (error) {
    toast(`新建备忘录失败：${error.message}`, 4000, null, 'err');
    return false;
  } finally {
    memoCreating = false;
    createButtons.forEach((button) => {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    });
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

async function reloadRestoredWorkspace(result, label, focusTarget) {
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
  return { focusTarget };
}

/* ---------- 视图切换 ---------- */
/* 兼容旧视图名 → 新四视图（今天/清单/记录/设置）的别名映射 */
const VIEW_ALIASES = {
  tasks: 'list',
  memos: 'list',
  board: 'list',
  cal: 'list',
  trash: 'settings',
  stat: 'records',
  stats: 'records'
};

function switchView(view) {
  view = VIEW_ALIASES[view] || view;
  if (!['today', 'list', 'records', 'settings'].includes(view)) return;
  const previousView = currentView;
  const content = $('.content');
  if (previousView === view) return;
  // 清单页备忘录分区离开时落盘草稿
  if (previousView === 'list' && listTab === 'memos' && view !== 'list') saveMemoNow();
  closeTaskMenus(false);
  if (content) viewScrollPositions.set(previousView, content.scrollTop);
  currentView = view;
  $$('.nav-item').forEach((n) => {
    const active = n.dataset.view === view;
    n.classList.toggle('active', active);
    if (active) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
  $$('.view').forEach((v) => { v.style.display = v.id === `view-${view}` ? '' : 'none'; });
  if (content) content.scrollTop = viewScrollPositions.get(view) || 0;
  // 视图切换动画
  const activeView = document.getElementById(`view-${view}`);
  playTransientClass(activeView, 'view-enter', MOTION_MS.base);
  // 标题栏显示当前视图名
  const viewNames = { today: '今天', list: '清单', records: '记录', settings: '设置' };
  const tbTitle = $('#tb-title');
  if (tbTitle) tbTitle.textContent = `工作台助手 · ${viewNames[view] || ''}`;
  if (view === 'today') renderToday();
  if (view === 'list') {
    renderTasks();
    renderMemos();
  }
  if (view === 'records') renderRecords();
  if (view === 'settings') {
    renderSettings();
    loadTrash();
  }
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
  badge('list', active);
  badge('settings', trashCount);
}

/* ---------- 标题栏最大化按钮 ---------- */
function updateMaxBtn(maximized) {
  const btn = $('#tb-max');
  if (!btn) return;
  btn.innerHTML = uiIcon(maximized ? 'copy' : 'square');
  btn.title = maximized ? '还原' : '最大化';
  btn.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口');
}

/* 窄窗口下助手面板让位：默认按视口宽度自动收起，用户手动切换后以手动为准，
   直到视口跨过阈值再交还给自动判断。 */
const AI_PANEL_AUTO_COLLAPSE_BELOW = 1360;
let aiPanelMode = 'auto'; // auto | collapsed | expanded

function aiPanelShouldCollapse() {
  if (aiPanelMode === 'collapsed') return true;
  if (aiPanelMode === 'expanded') return false;
  return window.innerWidth < AI_PANEL_AUTO_COLLAPSE_BELOW;
}

function applyAiPanelMode() {
  const panel = $('#ai-panel');
  if (!panel) return aiPanelShouldCollapse();
  const collapsed = aiPanelShouldCollapse();
  panel.classList.toggle('collapsed', collapsed);
  syncAiCollapseControl(collapsed);
  // 收起时清掉拖拽宽度，避免与窄条样式冲突
  if (collapsed) {
    panel.style.width = '';
    panel.style.flexBasis = '';
  }
  return collapsed;
}

function setAiPanelExpanded() {
  aiPanelMode = 'expanded';
  applyAiPanelMode();
}

function syncAiCollapseControl(collapsed) {
  const control = $('#ai-collapse');
  control.innerHTML = uiIcon(collapsed ? 'chevrons-left' : 'chevrons-right');
  control.title = collapsed ? '展开助手' : '收起助手';
  control.setAttribute('aria-label', collapsed ? '展开助手' : '收起助手');
  control.setAttribute('aria-expanded', String(!collapsed));
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
  $('#m-status').value = task ? task.status : 'todo';
  const due = splitDue(task ? task.due : '');
  $('#m-due-date').value = due.date;
  $('#m-due-time').value = due.time;
  $('#m-repeat').value = task ? task.repeat || '' : '';
  $('#m-remind').value = task ? String(task.remind || 30) : '30';
  $('#m-delete').classList.toggle('hidden', !task);
  $('#m-archive').classList.toggle('hidden', !task || task.status === 'archived');
  $('#m-unarchive').classList.toggle('hidden', !task || task.status !== 'archived');
  setTitleError('');
  setModalError('');
  setModalBusy(false);
  captureModalInitialState();
  const mask = $('#modal-mask');
  showModalMask(mask);
  $('#m-title').focus();
}

function refreshOpenTaskModal(task) {
  if (!editingTask || !task || editingTask.id !== task.id) return;
  editingTask = task;
  $('#m-title').value = task.title;
  $('#m-desc').value = task.desc || '';
  $('#m-status').value = task.status;
  const due = splitDue(task.due);
  $('#m-due-date').value = due.date;
  $('#m-due-time').value = due.time;
  $('#m-repeat').value = task.repeat || '';
  $('#m-remind').value = String(task.remind || 30);
  captureModalInitialState();
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
  editingTask = null;
  modalInitialSnapshot = '';
  hideModalMask(mask, () => {
    if (shouldRestoreFocus) restoreModalFocus();
  });
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
  const mask = $('#modal-mask');
  return !mask.classList.contains('hidden') && !mask.classList.contains('is-closing') && taskFormSnapshot() !== modalInitialSnapshot;
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

function setModalBusy(busy, action = 'save') {
  modalSaving = busy;
  const form = $('#task-form');
  const save = $('#m-save');
  const actionButtons = {
    save,
    delete: $('#m-delete'),
    archive: $('#m-archive'),
    unarchive: $('#m-unarchive')
  };
  const busyLabels = {
    save: editingTask ? '保存中…' : '创建中…',
    delete: '删除中…',
    archive: '归档中…',
    unarchive: '恢复中…'
  };
  const idleLabels = {
    save: editingTask ? '保存' : '创建',
    delete: '删除',
    archive: '归档',
    unarchive: '恢复'
  };
  form.setAttribute('aria-busy', String(busy));
  save.setAttribute('aria-busy', String(busy && action === 'save'));
  $$('#task-form input, #task-form select, #task-form textarea, #task-form button').forEach((control) => {
    control.disabled = busy;
  });
  $('#m-close').disabled = busy;
  Object.entries(actionButtons).forEach(([name, button]) => {
    button.setAttribute('aria-busy', String(busy && name === action));
    button.textContent = busy && name === action ? busyLabels[name] : idleLabels[name];
  });
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
  // 截止时间：日期 + 时间组合，日期为空则不设截止
  const dueDate = $('#m-due-date').value;
  const dueTime = $('#m-due-time').value || '18:00';
  const due = dueDate ? `${dueDate} ${dueTime}` : null;
  // 优先级/标签/项目/子任务等字段已从界面裁剪；applyTaskPatch 为合并语义，此处省略不会清空既有数据
  const data = {
    title,
    desc: $('#m-desc').value.trim(),
    status: $('#m-status').value,
    due,
    repeat: $('#m-repeat').value,
    remind: parseInt($('#m-remind').value, 10)
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
  if (!editingTask || modalSaving) return;
  const id = editingTask.id;
  const title = editingTask.title;
  confirmDialog(`确定删除任务「${title}」吗？删除后可以在回收站恢复。`, async () => {
    setModalError('');
    setModalBusy(true, 'delete');
    try {
      await window.api.tasks.remove(id);
    } finally {
      setModalBusy(false);
    }
    closeModal(false);
    modalReturnFocus = null;
    toast(`已删除「${title}」`, 5000, [{
      label: '撤销',
      run: async () => {
        await window.api.tasks.restore(id);
        toast('已恢复');
        await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
      }
    }]);
    await refreshTasksAfterMutation('任务已删除，但列表刷新失败');
    return { focusTarget: '#sidebar-new' };
  }, '删除');
}

async function archiveEditingTask() {
  if (!editingTask || modalSaving) return;
  const id = editingTask.id;
  const title = editingTask.title;
  let error = null;
  setModalError('');
  setModalBusy(true, 'archive');
  try {
    await window.api.tasks.archive(id);
  } catch (err) {
    error = err;
    console.error('[task-modal] archive failed:', err);
  } finally {
    setModalBusy(false);
  }
  if (error) {
    setModalError('归档失败，请稍后重试。任务内容仍保留在窗口中。');
    $('#m-archive').focus({ preventScroll: true });
    return;
  }
  closeModal(false);
  restoreModalFocus();
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
  if (!editingTask || modalSaving) return;
  const id = editingTask.id;
  let error = null;
  setModalError('');
  setModalBusy(true, 'unarchive');
  try {
    await window.api.tasks.unarchive(id);
  } catch (err) {
    error = err;
    console.error('[task-modal] unarchive failed:', err);
  } finally {
    setModalBusy(false);
  }
  if (error) {
    setModalError('恢复失败，请稍后重试。任务内容仍保留在窗口中。');
    $('#m-unarchive').focus({ preventScroll: true });
    return;
  }
  closeModal(false);
  restoreModalFocus();
  toast('已恢复为待办');
  await refreshTasksAfterMutation('任务已恢复，但列表刷新失败');
}

/* ---------- AI 对话 ---------- */
async function copyMessageText(button, body) {
  try {
    await navigator.clipboard.writeText(body.textContent || '');
    const previous = button.innerHTML;
    button.innerHTML = uiIcon('check');
    button.classList.add('copied');
    button.title = '已复制';
    button.setAttribute('aria-label', '已复制');
    setTimeout(() => {
      button.innerHTML = previous;
      button.classList.remove('copied');
      button.title = '复制消息';
      button.setAttribute('aria-label', '复制消息');
    }, FEEDBACK_HOLD_MS);
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
  copy.innerHTML = uiIcon('copy');
  copy.title = '复制消息';
  copy.setAttribute('aria-label', '复制消息');
  copy.setAttribute('aria-live', 'polite');
  copy.addEventListener('click', () => copyMessageText(copy, body));
  const footer = document.createElement('span');
  footer.className = 'msg-footer';
  if (role === 'ai') {
    const status = document.createElement('span');
    status.className = 'msg-state hidden';
    status.setAttribute('aria-hidden', 'true');
    footer.append(meta, status, copy);
  } else {
    footer.append(meta, copy);
  }
  el.append(body, footer);
  return el;
}

function isChatNearEnd(chat, threshold) {
  if (!chat) return true;
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= (threshold || 56);
}

function setAiJumpVisible(visible) {
  const button = $('#ai-jump-latest');
  if (!button) return;
  button.classList.toggle('hidden', !visible);
}

function syncAiChatFollowState() {
  const chat = $('#ai-chat');
  if (!chat) return;
  aiChatFollowing = isChatNearEnd(chat);
  if (aiChatFollowing) setAiJumpVisible(false);
}

function scrollChat(force) {
  const chat = $('#ai-chat');
  if (!chat) return;
  if (force || aiChatFollowing || isChatNearEnd(chat)) {
    chat.scrollTop = chat.scrollHeight;
    aiChatFollowing = true;
    setAiJumpVisible(false);
    return;
  }
  setAiJumpVisible(true);
}

function addMsg(role, text, extra) {
  const chat = $('#ai-chat');
  const el = createMessage(role, text);
  if (extra) el.appendChild(extra);
  chat.appendChild(el);
  scrollChat(true);
  return el;
}

function setAssistantMessageState(message, state, label) {
  if (!message) return;
  if (message.dataset) {
    if (state) message.dataset.requestState = state;
    else delete message.dataset.requestState;
  }
  const status = message.querySelector && message.querySelector('.msg-state');
  if (!status || !status.classList || !status.classList.contains('msg-state')) return;
  status.textContent = label || '';
  status.classList.toggle('hidden', !label);
}

function aiProgressState(progress) {
  const stage = progress && progress.stage;
  if (stage === 'streaming') return { state: 'streaming', label: '正在回复' };
  if (stage === 'executing') return { state: 'executing', label: '正在执行' };
  if (stage === 'responding') return { state: 'working', label: '正在组织回复' };
  if (stage === 'cancelled') return { state: 'cancelled', label: '正在停止' };
  if (stage === 'done') return { state: 'working', label: '正在整理结果' };
  return { state: 'working', label: '正在理解' };
}

function setAiBusy(busy) {
  aiSending = busy;
  const chat = $('#ai-chat');
  const send = $('#ai-send');
  chat.setAttribute('aria-busy', String(busy));
  const cancellable = busy && activeAiRequest && activeAiRequest.cancellable;
  send.disabled = busy && (!cancellable || activeAiRequest.cancelRequested);
  send.setAttribute('aria-busy', String(busy));
  if (send.classList) send.classList.toggle('is-stop', !!cancellable);
  if (cancellable) send.innerHTML = `${uiIcon('x')}<span>停止</span>`;
  else send.textContent = busy ? '处理中…' : '发送';
  send.title = cancellable ? '停止本次请求' : '';
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
    memo_split: '已拆成任务',
    plan: `已完成 ${Array.isArray(result.operations) ? result.operations.length : 0} 项操作`
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

function reportCard(result) {
  const card = document.createElement('div');
  card.className = 'report-agent-card';
  const report = result.report && typeof result.report === 'object' ? result.report : null;
  const counts = result.evidenceCounts || { facts: 0, analysis: 0, suggestions: 0 };
  const referenced = new Set(report && Array.isArray(report.referencedSourceIds) ? report.referencedSourceIds : []);
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const sourceLabels = { task: '任务', worklog: '记录', memo: '备忘', plan: '计划', focus: '专注', review: '复盘' };

  const head = document.createElement('div');
  head.className = 'report-agent-head';
  const authorship = document.createElement('span');
  authorship.className = `report-author ${result.authoredBy === 'model' ? 'model' : 'local'}`;
  authorship.textContent = result.authoredBy === 'model' ? 'Agent 撰写' : '本地事实版';
  const evidence = document.createElement('div');
  evidence.className = 'report-evidence-band';
  evidence.setAttribute('aria-label', '报告内容构成');
  [
    ['facts', '事实', counts.facts],
    ['analysis', '归纳', counts.analysis],
    ['suggestions', '建议', counts.suggestions]
  ].forEach(([kind, label, count]) => {
    const item = document.createElement('span');
    item.className = `report-evidence ${kind}`;
    item.textContent = `${label} ${Number(count) || 0}`;
    evidence.appendChild(item);
  });
  head.append(authorship, evidence);
  if (result.degraded) {
    const reason = document.createElement('span');
    reason.className = 'report-degrade-reason';
    reason.textContent = result.degradeNotice || '模型未启用，已降级为本地事实模板';
    head.appendChild(reason);
  }

  const preview = document.createElement('pre');
  preview.className = 'report-agent-preview';
  preview.textContent = String(result.markdown || '');
  preview.tabIndex = 0;
  preview.setAttribute('aria-label', 'Agent 报告预览');

  const sourceDrawer = document.createElement('section');
  sourceDrawer.className = 'report-source-drawer hidden';
  sourceDrawer.setAttribute('aria-label', '报告事实来源');
  const sourceHead = document.createElement('div');
  sourceHead.className = 'report-source-head';
  const sourceTitle = document.createElement('strong');
  sourceTitle.textContent = '事实来源';
  const sourceSummary = document.createElement('span');
  sourceSummary.textContent = `引用 ${referenced.size} / 可用 ${sources.length}`;
  sourceHead.append(sourceTitle, sourceSummary);
  const sourceList = document.createElement('div');
  sourceList.className = 'report-source-list';
  sources.slice().sort((a, b) => Number(referenced.has(b.id)) - Number(referenced.has(a.id))).forEach((source) => {
    const row = document.createElement('article');
    row.className = `report-source-item${referenced.has(source.id) ? ' referenced' : ''}`;
    const rowHead = document.createElement('div');
    rowHead.className = 'report-source-item-head';
    const type = document.createElement('span');
    type.className = `report-source-type ${source.type || 'task'}`;
    type.textContent = sourceLabels[source.type] || '来源';
    const title = document.createElement('strong');
    title.textContent = String(source.title || '未命名来源');
    const id = document.createElement('code');
    id.textContent = String(source.id || '');
    rowHead.append(type, title, id);
    const detail = document.createElement('p');
    detail.textContent = String(source.detail || '');
    row.append(rowHead, detail);
    sourceList.appendChild(row);
  });
  if (!sources.length) {
    const empty = document.createElement('p');
    empty.className = 'report-source-empty';
    empty.textContent = '这一版没有可展开的来源记录。';
    sourceList.appendChild(empty);
  }
  sourceDrawer.append(sourceHead, sourceList);

  const actions = document.createElement('div');
  actions.className = 'report-agent-actions';
  const sourceToggle = document.createElement('button');
  sourceToggle.type = 'button';
  sourceToggle.className = 'btn mini ghost icon-text';
  sourceToggle.setAttribute('aria-expanded', 'false');
  sourceToggle.append(uiIconElement('file-text'), Object.assign(document.createElement('span'), { textContent: '核对来源' }));
  sourceToggle.addEventListener('click', () => {
    const opening = sourceDrawer.classList.contains('hidden');
    sourceDrawer.classList.toggle('hidden', !opening);
    sourceToggle.setAttribute('aria-expanded', String(opening));
    sourceToggle.querySelector('span').textContent = opening ? '收起来源' : '核对来源';
    if (opening) sourceDrawer.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn mini ghost icon-text';
  copy.append(uiIconElement('copy'), Object.assign(document.createElement('span'), { textContent: '复制报告' }));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(preview.textContent);
      copy.querySelector('span').textContent = '已复制';
      setTimeout(() => { if (copy.isConnected) copy.querySelector('span').textContent = '复制报告'; }, FEEDBACK_HOLD_MS);
      toast('报告已复制到剪贴板', 2000, null, 'ok');
    } catch (error) {
      toast('复制失败，请手动选择报告内容', 3000, null, 'err');
      preview.focus({ preventScroll: true });
    }
  });
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn mini ghost icon-text';
  download.append(uiIconElement('download'), Object.assign(document.createElement('span'), { textContent: '下载 .md' }));
  download.addEventListener('click', () => {
    const blob = new Blob([preview.textContent], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = result.reportPeriod === 'daily' ? dailyReportFileName(result.reportOffset || 0) : weeklyReportFileName(result.reportOffset || 0);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    toast('报告已下载');
  });
  actions.append(sourceToggle, copy, download);
  if (result.reportSessionActive) {
    const finish = document.createElement('button');
    finish.type = 'button';
    finish.className = 'btn mini ghost icon-text report-finish';
    finish.append(uiIconElement('x'), Object.assign(document.createElement('span'), { textContent: '结束修改' }));
    finish.addEventListener('click', () => {
      finish.disabled = true;
      sendPrompt('结束报告修改');
    });
    actions.appendChild(finish);
  }
  card.append(head, preview, sourceDrawer, actions);
  return card;
}

function onTurnActionsKeyDown(event) {
  const button = event.target.closest('.turn-action');
  if (!button) return;
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll('.turn-action:not(:disabled)'));
  const index = buttons.indexOf(button);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  let targetIndex = index;
  if (event.key === 'Home') targetIndex = 0;
  else if (event.key === 'End') targetIndex = buttons.length - 1;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') targetIndex = (index - 1 + buttons.length) % buttons.length;
  else targetIndex = (index + 1) % buttons.length;
  buttons.forEach((item, itemIndex) => { item.tabIndex = itemIndex === targetIndex ? 0 : -1; });
  buttons[targetIndex].focus();
}

function turnActions(items, label, variant) {
  const bar = document.createElement('div');
  bar.className = `turn-actions${variant ? ` ${variant}` : ''}`;
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', label || '下一步');
  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `turn-action${item.kind ? ` ${item.kind}` : ''}${item.index ? ' candidate' : ''}`;
    button.tabIndex = index === 0 ? 0 : -1;
    if (item.index) {
      const number = document.createElement('span');
      number.className = 'candidate-index';
      number.textContent = item.index;
      number.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'candidate-copy';
      const title = document.createElement('span');
      title.className = 'candidate-title';
      title.textContent = item.label;
      copy.appendChild(title);
      if (item.description) {
        const meta = document.createElement('span');
        meta.className = 'candidate-meta';
        meta.textContent = item.description;
        copy.appendChild(meta);
      }
      button.append(number, copy);
    } else {
      button.textContent = item.label;
    }
    button.setAttribute('aria-label', item.ariaLabel || item.label);
    button.disabled = aiSending;
    button.addEventListener('click', item.run);
    bar.appendChild(button);
  });
  bar.addEventListener('keydown', onTurnActionsKeyDown);
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

function setAiContext(type, detail) {
  const context = $('#ai-context');
  const text = $('#ai-context-text');
  if (!context || !text) return;
  const labels = {
    working: settings.aiStage === 'llm' && settings.aiModel
      ? `真实模型正在处理 · ${settings.aiModel}`
      : '本地助手正在处理',
    ask: '等待选择 · 选择后继续原操作',
    confirm: '等待确认 · 操作尚未执行',
    clarify: '等待补充 · 回答上一个问题即可继续',
    report: '报告修改中 · 直接说受众、重点、语气或篇幅',
    error: '请求未完成 · 可重试或检查模型'
  };
  const label = detail || labels[type];
  context.classList.toggle('hidden', !label);
  if (label) context.dataset.state = type;
  else delete context.dataset.state;
  text.textContent = label || '';
  const input = $('#ai-input');
  if (!input) return;
  const placeholders = {
    ask: '选择上方候选，或输入更完整的标题…',
    confirm: '也可以输入“确认执行”或“取消”…',
    clarify: '继续补充刚才缺少的信息…',
    report: '例如：给老板看，突出项目进展，压缩成五条…'
  };
  input.placeholder = placeholders[type] || '描述任务，或继续补充…';
}

function nextAiRequestId() {
  aiRequestSequence += 1;
  return `assistant-${Date.now()}-${aiRequestSequence}`;
}

function ensureAiReasoningBlock(msgEl) {
  if (!msgEl) return null;
  let block = msgEl.querySelector('.msg-reasoning');
  if (block) {
    const body = block.querySelector('.msg-reasoning-body');
    if (body) return { block, body };
  }
  block = document.createElement('details');
  block.className = 'msg-reasoning';
  block.open = true;
  block.setAttribute('aria-label', '思考过程');
  const summary = document.createElement('summary');
  summary.className = 'msg-reasoning-summary';
  summary.innerHTML = `<span class="msg-reasoning-seal" aria-hidden="true">思</span>
    <span class="msg-reasoning-title">正在思考…</span>
    <span class="msg-reasoning-chevron" aria-hidden="true"></span>`;
  const body = document.createElement('div');
  body.className = 'msg-reasoning-body';
  block.append(summary, body);
  const textBody = msgEl.querySelector('.msg-text');
  if (textBody && textBody.parentNode) {
    textBody.parentNode.insertBefore(block, textBody);
  } else {
    msgEl.prepend(block);
  }
  return { block, body };
}

function finishAiReasoningBlock(msgEl, cumulativeReasoning) {
  if (!msgEl) return;
  const refs = ensureAiReasoningBlock(msgEl);
  if (!refs) return;
  const { block, body } = refs;
  if (typeof cumulativeReasoning === 'string' && cumulativeReasoning && !body.textContent) {
    body.textContent = cumulativeReasoning;
  }
  const title = block.querySelector('.msg-reasoning-title');
  const total = (body.textContent || '').trim().length;
  if (title) title.textContent = total ? `思考过程（${total} 字）` : '思考过程';
  block.open = false;
  block.classList.remove('is-streaming');
  block.classList.add('is-done');
}

/* 轮次结束时兜底收尾思考块：流被中断时 reasoningDone 不会到达，避免思考文本悬浮成"回答主体" */
function settleAiReasoningBlock(msgEl) {
  const block = msgEl && msgEl.querySelector ? msgEl.querySelector('.msg-reasoning') : null;
  if (block && typeof block.querySelector === 'function' && block.querySelector('.msg-reasoning-body')) {
    finishAiReasoningBlock(msgEl);
  }
}

function updateAiRequestProgress(progress) {
  if (!activeAiRequest || !progress || progress.requestId !== activeAiRequest.id) return;
  const message = String(progress.message || '').trim();
  const requestState = aiProgressState(progress);
  setAssistantMessageState(activeAiRequest.pending, requestState.state, requestState.label);

  // 推理 / 思考阶段 delta：优先写入思考块（用户感知"模型不是卡住，是在想"，减少误判超时）
  const reasoningDelta = typeof progress.reasoningDelta === 'string' ? progress.reasoningDelta : '';
  if (reasoningDelta) {
    const refs = ensureAiReasoningBlock(activeAiRequest.pending);
    if (refs) {
      if (!activeAiRequest.reasoningStarted) {
        activeAiRequest.reasoningStarted = true;
        refs.body.textContent = '';
        refs.block.classList.add('is-streaming');
      }
      refs.body.textContent += reasoningDelta;
      setAiContext('working', message || '正在思考…');
      scrollChat(false);
    }
  }
  if (progress.reasoningDone) {
    finishAiReasoningBlock(activeAiRequest.pending, progress.cumulativeReasoning);
    scrollChat(false);
  }

  if (activeAiRequest.pending && typeof progress.delta === 'string' && progress.delta) {
    const body = activeAiRequest.pending.querySelector('.msg-text');
    if (!activeAiRequest.streamStarted) {
      body.textContent = '';
      activeAiRequest.streamStarted = true;
      activeAiRequest.pending.classList.remove('pending');
    }
    body.textContent += progress.delta;
    setAiContext('working', message || '正在生成回复…');
    scrollChat(false);
    return;
  }
  if (message && activeAiRequest.pending && !activeAiRequest.streamStarted && !reasoningDelta && !progress.reasoningDone) {
    activeAiRequest.pending.querySelector('.msg-text').textContent = message;
    setAiContext('working', message);
    scrollChat(false);
  }
}

async function cancelActiveAiRequest() {
  const request = activeAiRequest;
  if (!request || !request.cancellable || request.cancelRequested) return;
  request.cancelRequested = true;
  request.pending.querySelector('.msg-text').textContent = '正在停止本次请求…';
  setAssistantMessageState(request.pending, 'cancelled', '正在停止');
  setAiContext('working', '正在安全停止 · 尚未执行本地操作');
  setAiBusy(true);
  try {
    await window.api.ai.cancel(request.id);
  } catch (error) {
    console.error('[assistant] cancel failed:', error);
  }
}

function setAiRuntimeState(state, notice) {
  aiRuntimeState = ['ready', 'degraded'].includes(state) ? state : null;
  aiRuntimeNotice = aiRuntimeState === 'degraded'
    ? (notice || '真实模型暂时不可用，本轮已由本地助手继续处理。')
    : '';
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
  if (candidate.project) context.push(`项目 ${candidate.project}`);
  if (candidate.due) context.push(candidate.due);
  if (candidate.status) context.push(STATE_NAME[candidate.status] || candidate.status);
  return context.length ? `${candidate.title} · ${context.join(' · ')}` : candidate.title;
}

function restoreAiDraftForEditing(draft) {
  const input = $('#ai-input');
  if (!input) return false;
  const current = input.value.trim();
  if (!current || current === String(draft || '').trim()) {
    input.value = String(draft || '');
    resizeAiInput();
  } else {
    toast('输入框里已有草稿，已为你保留。', 3000, null, 'info');
  }
  input.focus({ preventScroll: true });
  return !current;
}

function retryAction(retry, draft) {
  let actions;
  const items = [{
    label: '重试',
    kind: 'primary',
    run: () => {
      actions.remove();
      retry();
    }
  }];
  if (draft) {
    items.push({
      label: '修改后重试',
      kind: 'quiet',
      run: () => restoreAiDraftForEditing(draft)
    });
  }
  actions = turnActions(items, '错误恢复');
  return actions;
}

function assistantRequestFailureMessage() {
  return settings.aiStage === 'llm'
    ? '模型暂时没有响应。请检查网络和模型配置后重试。'
    : '助手暂时没有响应。请重试一次。';
}

function appendAssistantTurnControls(container, result, retry, draft) {
  if (result.resumed && result.retryText) {
    container.appendChild(turnActions([
      { label: '重试刚才回答', kind: 'primary', run: () => runPrompt(result.retryText) },
      { label: '取消操作', kind: 'quiet', run: () => sendPrompt('取消') }
    ], '恢复未完成操作'));
    setAiContext('error');
    return;
  }
  if (result.type === 'ask' && result.candidates && result.candidates.length) {
    const candidateItems = result.candidates.map((candidate, index) => {
      const label = candidateLabel(candidate);
      const description = label === candidate.title ? '' : label.slice(candidate.title.length + 3);
      return {
        label: candidate.title,
        description,
        index: String(index + 1),
        ariaLabel: `第 ${index + 1} 项，${label}`,
        run: async () => {
          choices.querySelectorAll('button').forEach((button) => { button.disabled = true; });
          choices.remove();
          await resolveCandidate(result, candidate, label);
        }
      };
    });
    candidateItems.push({ label: '取消操作', kind: 'quiet', run: () => sendPrompt('取消') });
    const choices = turnActions(
      candidateItems,
      result.candidates.some((candidate) => candidate.entityType === 'memo') ? '选择备忘录' : '选择任务',
      'candidate-actions'
    );
    container.appendChild(choices);
    setAiContext('ask');
    return;
  }
  if (result.type === 'confirm') {
    container.appendChild(turnActions([
      { label: '确认执行', kind: 'primary', run: () => sendPrompt('确认执行') },
      { label: '取消', kind: 'quiet', run: () => sendPrompt('取消') }
    ], '确认操作'));
    setAiContext('confirm');
    return;
  }
  if (result.type === 'clarify') {
    container.appendChild(turnActions([
      { label: '取消操作', kind: 'quiet', run: () => sendPrompt('取消') }
    ], '取消当前操作'));
    setAiContext('clarify');
    return;
  }
  if (result.localFailure) {
    setAiContext('error');
    return;
  }
  if (result.type === 'report' && result.reportSessionActive) {
    if (result.retryable && retry) container.appendChild(retryAction(retry, draft));
    setAiContext('report', result.degraded
      ? '报告修改中 · 当前为本地事实版，可重试模型或继续调整范围'
      : '报告修改中 · 直接说受众、重点、语气或篇幅');
    return;
  }
  setAiContext(null);
  if (result.retryable && retry) {
    container.appendChild(retryAction(retry, draft));
    setAiContext('error');
    return;
  }
  const followUps = getFollowUps(result);
  if (followUps.length) {
    container.appendChild(turnActions(followUps.map((item) => ({
      label: item.label,
      run: () => sendPrompt(item.prompt)
    }))));
  }
}

async function runAiTurn(request, retry, options) {
  if (aiSending) return;
  // 本轮结果要写进助手对话，面板就不能停在收起态（窄窗口让位在这里让开）
  setAiPanelExpanded();
  const cancellable = !!(options && options.cancellable);
  const requestId = cancellable ? nextAiRequestId() : '';
  setAiContext('working');
  const pending = addMsg('ai', settings.aiStage === 'llm' ? '正在调用模型并理解你的要求…' : '正在理解你的要求…');
  pending.classList.add('pending');
  setAssistantMessageState(pending, 'working', '正在理解');
  activeAiRequest = { id: requestId, pending, cancellable, cancelRequested: false, streamStarted: false };
  setAiBusy(true);
  try {
    let result;
    try {
      result = await request(requestId);
    } catch (e) {
      console.error('[assistant] request failed:', e);
      pending.classList.remove('pending');
      pending.classList.add('error');
      settleAiReasoningBlock(pending);
      setAssistantMessageState(pending, 'error', '请求未完成');
      pending.querySelector('.msg-text').textContent = assistantRequestFailureMessage();
      pending.appendChild(retryAction(retry, options && options.draft));
      setAiContext('error');
      if (settings.aiStage === 'llm') setAiRuntimeState('degraded', assistantRequestFailureMessage());
      return;
    }

    try {
      const operationTypes = ['create', 'memo_create', 'memo_to_task', 'complete', 'delete', 'update', 'plan'];
      const reportTypes = ['report'];
      pending.classList.remove('pending', 'error');
      settleAiReasoningBlock(pending);
      pending.querySelector('.msg-text').textContent = result.message;
      // Agent 自主多步执行轨迹：查询任务 → 开始任务
      if (result.agentTrace && Array.isArray(result.agentSteps) && result.agentSteps.length > 1) {
        const trace = document.createElement('div');
        trace.className = 'msg-agent-trace';
        trace.textContent = `自主执行 ${result.agentSteps.length} 步 · ${result.agentTrace}`;
        pending.querySelector('.msg-text').after(trace);
      }
      if (result.cancelled) {
        pending.classList.add('cancelled');
        setAssistantMessageState(pending, 'cancelled', '已停止');
      } else {
        setAssistantMessageState(pending, 'complete', operationTypes.includes(result.type) ? '操作完成' : '已回复');
        if (reportTypes.includes(result.type)) setAssistantMessageState(pending, 'complete', '报告已生成');
      }
      if (result.chatPersisted === false) {
        toast(result.historyNotice || '本轮对话未能写入历史记录。', 5000, null, 'warn');
      }
      if (settings.aiStage === 'llm') {
        setAiRuntimeState(
          result.degraded ? 'degraded' : 'ready',
          result.degraded ? (result.degradeNotice || '模型服务短暂异常，已进入受控降级。') : ''
        );
      }

      if (operationTypes.includes(result.type)) pending.appendChild(opCard(result));
      if (reportTypes.includes(result.type)) pending.appendChild(reportCard(result));
      if (String(result.type).startsWith('memo_') || result.type === 'plan') await refreshMemos();

      appendAssistantTurnControls(pending, result, retry, options && options.draft);
    } catch (e) {
      console.error('[assistant] response rendering failed:', e);
      pending.classList.remove('pending');
      setAssistantMessageState(pending, 'error', '显示不完整');
      pending.querySelector('.msg-text').textContent = result.message;
      setAiContext('error');
      toast('回复已收到，但操作按钮没有完整显示。请刷新后重试。', 5000, null, 'warn');
    }

    try {
      await refreshTasks();
    } catch (e) {
      console.error('[assistant] task refresh failed:', e);
      toast('操作已完成，但任务列表没有刷新。请稍后重新打开当前视图。', 5000, null, 'warn');
    }
  } finally {
    if (activeAiRequest && activeAiRequest.id === requestId) activeAiRequest = null;
    setAiBusy(false);
    scrollChat(false);
    restoreAiComposerFocus();
  }
}

function restoreAiComposerFocus() {
  const input = $('#ai-input');
  const send = $('#ai-send');
  if (!input) return false;
  const active = document.activeElement;
  const insidePanel = active && typeof active.closest === 'function' && active.closest('#ai-panel');
  const shouldRestore = !active || active === document.body || active === input || active === send || (insidePanel && active.disabled);
  if (!shouldRestore) return false;
  input.focus({ preventScroll: true });
  return true;
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
  await runAiTurn((requestId) => window.api.ai.handle(raw, requestId), () => runPrompt(raw), { cancellable: true, draft: raw });
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
  let log;
  try {
    log = await window.api.chat.get();
    chat.innerHTML = '';
    (Array.isArray(log) ? log : []).slice(-50).forEach((entry) => {
      chat.appendChild(createMessage(entry.role, entry.text, entry.ts));
    });
  } catch (e) {
    // 历史加载失败不阻塞当前工作状态展示。
    chat.innerHTML = '';
    return;
  }
  try {
    const session = await window.api.ai.session();
    if (session && session.pending) {
      const assistantMessages = chat.querySelectorAll('.msg.ai');
      const target = assistantMessages.length
        ? assistantMessages[assistantMessages.length - 1]
        : addMsg('ai', session.pending.message);
      appendAssistantTurnControls(target, session.pending);
    }
  } catch (e) {
    // 会话恢复失败不应抹掉已经载入的聊天历史。
    console.error('[assistant] session restore failed:', e);
  }
  scrollChat(true);
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
    if (panelStage) panelStage.textContent = '真实模型 · 受控降级';
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
  const health = $('#ai-health');
  const healthText = $('#ai-health-text');
  if (health && healthText) {
    const visible = degraded && !!aiRuntimeNotice;
    health.classList.toggle('hidden', !visible);
    healthText.textContent = visible ? aiRuntimeNotice : '';
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
  if (currentView === 'today') renderToday();
  if (currentView === 'list') { renderTasks(); renderMemos(); }
  if (currentView === 'records') renderRecords();
  renderNavBadges();
  if (currentView === 'settings') {
    renderSettings();
    loadTrash();
  }
  applyDataLoadStates();
}

async function openReminderTask(data) {
  const id = Number(data && data.id);
  if (!Number.isFinite(id)) return false;
  const taskMask = $('#modal-mask');
  if (taskMask && !taskMask.classList.contains('hidden') && isTaskModalDirty()) {
    toast('请先保存或放弃当前任务的修改', 4500, null, 'warn');
    return true;
  }
  let task = tasks.find((item) => item.id === id);
  if (!task) {
    await refreshTasks();
    task = tasks.find((item) => item.id === id);
  }
  if (!task) {
    toast('这项任务已不存在或已被删除', 4000, null, 'warn');
    return true;
  }
  switchView('list');
  openModal(task);
  return true;
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
    switchView('list');
    setListTab('tasks');
    openModal(null);
  });

  // 清单页分区切换
  $('#list-tab-tasks')?.addEventListener('click', () => setListTab('tasks'));
  $('#list-tab-memos')?.addEventListener('click', () => setListTab('memos'));

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
  $('#tasks-list').addEventListener('keydown', onTaskReorderKeyDown);
  ['today-list', 'tasks-list'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', onTaskMenuKeyDown);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.task-overflow')) closeTaskMenus(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $$('.task-menu:not(.hidden)').length) closeTaskMenus(true);
  });

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
    const clear = event.target.closest('#memo-clear-filter');
    if (clear) {
      memoFilter = 'all';
      renderMemoList();
      document.querySelector('#memo-filters .fchip[data-memo-filter="all"]')?.focus({ preventScroll: true });
      return;
    }
    const item = event.target.closest('[data-memo-id]');
    if (!item) return;
    const id = parseInt(item.dataset.memoId, 10);
    selectMemo(id, true);
  });
  $('#memo-list').addEventListener('keydown', onMemoListKeyDown);
  const memoTagChips = $('#memo-tag-chips');
  if (memoTagChips) {
    memoTagChips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-memo-tag-remove]');
      if (!button) return;
      removeMemoTag(button.dataset.memoTagRemove);
    });
  }
  $('#memo-tags').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === ' ' || event.key === 'Tab') {
      // 分隔符即提交：chip 表示已提交的标签，输入框只留在输入中的片段
      if (commitMemoTags() && event.key !== 'Tab') event.preventDefault();
      return;
    }
    if (event.key === 'Backspace' && !$('#memo-tags').value && memoTagCommitted.length) {
      event.preventDefault();
      removeMemoTag(memoTagCommitted[memoTagCommitted.length - 1]);
    }
  });
  $('#memo-tags').addEventListener('blur', () => commitMemoTags());
  const memoFilterWrap = $('#memo-filters');
  if (memoFilterWrap) {
    memoFilterWrap.addEventListener('click', (event) => {
      const chip = event.target.closest('.fchip[data-memo-filter]');
      if (!chip || chip.getAttribute('aria-pressed') === 'true') return;
      memoFilter = chip.dataset.memoFilter;
      memoFocusId = null;
      renderMemoList();
      const active = memoFilterWrap.querySelector('.fchip.active') || chip;
      active.focus({ preventScroll: true });
    });
    bindPressedGroupKeyboard(memoFilterWrap, '.fchip[data-memo-filter]');
  }
  ['memo-title', 'memo-tags', 'memo-content'].forEach((id) => {
    $(`#${id}`).addEventListener('input', scheduleMemoSave);
  });
  $('#memo-pin').addEventListener('click', async () => {
    const button = $('#memo-pin');
    const release = beginMemoAction(button, '置顶中…');
    if (!release) return;
    try {
      if ((await saveMemoNow()) === false) return;
      setMemoSaveState('saving', '置顶中…');
      const memo = currentMemo();
      if (!memo) return;
      const updated = await window.api.memos.update(memo.id, { pinned: !memo.pinned });
      memos = memos.map((item) => item.id === updated.id ? updated : item)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
      renderMemos();
      toast(updated.pinned ? '备忘录已置顶' : '已取消置顶', 2500, null, 'ok');
    } catch (error) {
      toast(`置顶操作失败：${error.message}`, 3000, null, 'err');
    } finally {
      release();
    }
  });
  $('#memo-copy').addEventListener('click', async () => {
    const button = $('#memo-copy');
    const release = beginMemoAction(button, '复制中…');
    if (!release) return;
    try {
      const editingDraft = !!memoDraftMemo;
      if (!editingDraft && (await saveMemoNow()) === false) return;
      setMemoSaveState('saving', '复制中…');
      const memo = editingDraft ? { title: memoDraft().title, content: $('#memo-content').value, tags: memoDraft().tags } : currentMemo();
      if (!memo) return;
      const text = [memo.title, memo.content, (memo.tags || []).map((tag) => `#${tag}`).join(' ')].filter(Boolean).join('\n\n');
      await navigator.clipboard.writeText(text);
      button.classList.add('copied');
      button.innerHTML = uiIcon('check');
      button.dataset.tooltip = '已复制';
      toast('备忘录已复制', 2500, null, 'ok');
      setTimeout(() => {
        button.classList.remove('copied');
        button.innerHTML = uiIcon('copy');
        button.dataset.tooltip = '复制';
      }, FEEDBACK_HOLD_MS);
    } catch (error) {
      toast('复制失败，请稍后重试', 3000, null, 'err');
    } finally {
      release();
    }
  });
  $('#memo-to-task').addEventListener('click', async () => {
    const button = $('#memo-to-task');
    const release = beginMemoAction(button, '创建中…');
    if (!release) return;
    try {
      if ((await saveMemoNow()) === false) return;
      setMemoSaveState('saving', '创建任务中…');
      const memo = currentMemo();
      if (!memo) return;
      const converted = await window.api.memos.convert(memo.id);
      const task = converted.value;
      memos = await window.api.memos.getAll();
      selectedMemoId = memos.length ? memos[0].id : null;
      renderMemos();
      toast('已转为任务，原备忘录已移入回收站', 5000, [{ label: '撤销', run: async () => {
        await window.api.ai.undo({ action: 'restoreAgentTransaction', transactionId: converted.transactionId });
        await refreshTasks(); await refreshMemos();
      } }], 'ok');
      toast(`已创建任务「${task.title}」`, 3000, null, 'ok');
      await refreshTasksAfterMutation('任务已创建，但列表刷新失败');
    } catch (error) {
      toast(`创建任务失败：${error.message}`, 3000, null, 'err');
    } finally {
      release();
    }
  });
  $('#memo-delete').addEventListener('click', async () => {
    const button = $('#memo-delete');
    const release = beginMemoAction(button, '准备删除…');
    if (!release) return;
    let openedConfirm = false;
    try {
      if ((await saveMemoNow()) === false) return;
      const memo = currentMemo();
      if (!memo) return;
      confirmDialog(`确定删除备忘录「${memo.title}」吗？`, async () => {
        const removedId = memo.id;
        await window.api.memos.remove(removedId);
        memos = memos.filter((item) => item.id !== removedId);
        selectedMemoId = memos.length ? memos[0].id : null;
        memoFocusId = selectedMemoId;
        deletedMemos = await window.api.memos.getDeleted();
        renderMemos();
        renderNavBadges();
        toast('备忘录已移到回收站', 5000, [{
          label: '撤销',
          run: async () => {
            await window.api.memos.restore(removedId);
            memos = await window.api.memos.getAll();
            deletedMemos = await window.api.memos.getDeleted();
            selectedMemoId = removedId;
            memoFocusId = removedId;
            renderMemos();
            toast('备忘录已恢复', 2500, null, 'ok');
          }
        }], 'ok');
      });
      openedConfirm = true;
    } finally {
      release(!openedConfirm);
    }
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
    setQuickCreateBusy(input, button, true);
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
      input.focus();
      return;
    } finally {
      setQuickCreateBusy(input, button, false);
    }
    if (input.value.trim() === raw) input.value = '';
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

  // 任务列表拖拽排序
  $('#tasks-list').addEventListener('dragstart', (e) => {
    const row = e.target.closest('.task-row');
    if (!row) return;
    if (taskReorderBusy) { e.preventDefault(); return; }
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
    if (row && !row.contains(e.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
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
    const movedRow = document.querySelector(`#tasks-list .task-row[data-id="${dragId}"]`);
    await commitTaskOrder(rows, movedRow, '已调整任务顺序', '顺序已保存，但列表刷新失败');
  });

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
    if (aiSending) {
      cancelActiveAiRequest();
      return;
    }
    sendPrompt();
  });
  $('#ai-input').addEventListener('input', resizeAiInput);
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aiSending) {
      e.preventDefault();
      cancelActiveAiRequest();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    sendPrompt();
  });
  $('#ai-chat').addEventListener('scroll', syncAiChatFollowState, { passive: true });
  $('#ai-jump-latest').addEventListener('click', () => {
    scrollChat(true);
    const latest = $('#ai-chat .msg:last-child');
    if (latest) {
      latest.tabIndex = -1;
      latest.focus({ preventScroll: true });
      latest.scrollIntoView({ block: 'end' });
    }
  });
  $('#ai-clear').addEventListener('click', clearAssistantConversation);
  $('#ai-health-action').addEventListener('click', openAiSettings);
  if (window.api.ai.onProgress) window.api.ai.onProgress(updateAiRequestProgress);
  $('#ai-collapse').addEventListener('click', () => {
    // 手动切换即接管，直到视口跨过阈值才交回自动判断
    aiPanelMode = $('#ai-panel').classList.contains('collapsed') ? 'expanded' : 'collapsed';
    applyAiPanelMode();
  });
  // 视口跨过阈值时把面板交还给自动判断，避免用户早期的手动选择永久压制让位
  let aiPanelNarrow = window.innerWidth < AI_PANEL_AUTO_COLLAPSE_BELOW;
  window.addEventListener('resize', () => {
    const narrow = window.innerWidth < AI_PANEL_AUTO_COLLAPSE_BELOW;
    if (narrow !== aiPanelNarrow) {
      aiPanelNarrow = narrow;
      aiPanelMode = 'auto';
    }
    applyAiPanelMode();
  });
  $$('#ai-chips .chip').forEach((chip) => chip.addEventListener('click', () => {
    if (chip.dataset.aiAction === 'new-task') {
      switchView('list');
      setListTab('tasks');
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
  window.api.on('app:new-task', () => { switchView('list'); setListTab('tasks'); openModal(null); });
  window.api.on('app:focus-ai', () => {
    setAiPanelExpanded();
    $('#ai-input').focus();
  });
  window.api.on('app:switch-view', (view) => {
    // 兼容旧视图名，switchView 内部会做别名映射
    if (['today', 'list', 'records', 'settings', 'tasks', 'memos', 'board', 'cal', 'stat', 'stats', 'trash'].includes(view)) switchView(view);
  });
  window.api.on('app:open-task', (data) => {
    openReminderTask(data).catch((error) => {
      console.error('[reminder] open task failed:', error);
      toast('暂时无法打开提醒任务，请稍后重试', 4500, null, 'err');
    });
  });
  window.api.on('app:reminder', (data) => {
    toast(`提醒 · ${data.title}${data.due ? ' · ' + data.due : ''}`, 7000, [{
      label: '查看',
      busyLabel: '打开中…',
      run: () => openReminderTask(data)
    }], 'warn');
  });
  // 任务对话小窗、MCP 等外部入口修改任务后，主窗口同步刷新列表与编辑弹窗
  window.api.on('tasks:changed', async () => {
    await refreshTasksAfterMutation('任务已在其他入口修改，但列表刷新失败');
    if (editingTask) refreshOpenTaskModal(tasks.find((item) => item.id === editingTask.id));
  });
  // MCP 等外部入口修改备忘录后同步刷新，避免主窗口停留在旧列表
  window.api.on('memos:changed', async () => {
    await refreshMemosAfterMutation('备忘录已在其他入口修改，但列表刷新失败');
  });

  // 应用内快捷键（不抢输入框焦点）
  document.addEventListener('keydown', async (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
      if (currentView === 'list' && listTab === 'memos') createMemo();
      else openModal(null);
      return;
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
    list.innerHTML = `<div class="empty compact"><div class="big">${uiIcon('trash')}</div><div class="empty-title">回收站是空的</div><p class="empty-hint">删除的任务和备忘录会显示在这里，并可随时恢复。</p></div>`;
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
        <div class="trash-heading"><span class="trash-title">${esc(t.title)}</span><span class="trash-kind task">${uiIcon('tasks')}<span>任务</span></span></div>
        <span class="trash-time">${esc(trashDeletedTime(t))}</span>
      </div>
      <div class="trash-actions">
        <button type="button" class="btn mini trash-restore icon-text" data-restore-task="${t.id}" aria-label="恢复任务「${esc(t.title)}」">${uiIcon('undo')}<span>恢复</span></button>
        <button type="button" class="btn mini danger icon-text" data-purge-task="${t.id}" aria-label="永久删除任务「${esc(t.title)}」">${uiIcon('trash')}<span>永久删除</span></button>
      </div>
    </div>`).join('');
  const memoRows = deletedMemos.map((memo) => `
    <div class="trash-row" role="listitem" data-id="${memo.id}">
      <div class="trash-main">
        <div class="trash-heading"><span class="trash-title">${esc(memo.title)}</span><span class="trash-kind memo">${uiIcon('memos')}<span>备忘录</span></span></div>
        <span class="trash-time">${esc(trashDeletedTime(memo))}</span>
      </div>
      <div class="trash-actions">
        <button type="button" class="btn mini trash-restore icon-text" data-restore-memo="${memo.id}" aria-label="恢复备忘录「${esc(memo.title)}」">${uiIcon('undo')}<span>恢复</span></button>
        <button type="button" class="btn mini danger icon-text" data-purge-memo="${memo.id}" aria-label="永久删除备忘录「${esc(memo.title)}」">${uiIcon('trash')}<span>永久删除</span></button>
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
      setButtonContent(b, '恢复中…');
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
        setButtonContent(b, '恢复', 'undo');
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
      setButtonContent(b, '恢复中…');
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
        setButtonContent(b, '恢复', 'undo');
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
    const row = currentTaskRows().find((item) => parseInt(item.dataset.id, 10) === id);
    await runTaskRowMutation({
      taskId: id,
      control: postponeBtn,
      operation: () => postponeTask(id, days),
      errorMessage: '任务顺延失败，请重试',
      previousIndex: Math.max(0, currentTaskRows().indexOf(row))
    });
    return;
  }
  const more = e.target.closest('.task-more');
  if (more) {
    toggleTaskMenu(more);
    return;
  }
  const menuItem = e.target.closest('.task-menu-item[data-act]');
  if (menuItem) {
    const row = menuItem.closest('.task-row');
    const id = parseInt(row.dataset.id, 10);
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    await runTaskMenuAction(menuItem.dataset.act, t, row);
    return;
  }
  const row = e.target.closest('.task-row');
  if (!row) return;
  const t = tasks.find((x) => x.id === parseInt(row.dataset.id, 10));
  if (!t) return;
  // 勾选：完成任务 / 重新打开
  if (e.target.closest('.task-check')) {
    await runTaskRowMutation({
      taskId: t.id,
      control: e.target.closest('.task-check'),
      operation: () => toggleDone(t),
      errorMessage: t.status === 'done' ? '任务重新打开失败，请重试' : '任务完成失败，请重试',
      previousIndex: Math.max(0, currentTaskRows().indexOf(row)),
      focusSelector: '.task-check'
    });
    return;
  }
  if (e.target.classList.contains('statectl')) {
    await runTaskRowMutation({
      taskId: t.id,
      control: e.target,
      operation: () => cycleState(t),
      errorMessage: '任务状态更新失败，请重试',
      previousIndex: Math.max(0, currentTaskRows().indexOf(row)),
      focusSelector: '.statectl'
    });
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
    estimatedMinutes: t.estimatedMinutes,
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

function closeTaskMenus(restoreFocus) {
  let returnTarget = null;
  $$('.task-menu:not(.hidden)').forEach((menu) => {
    const trigger = menu.closest('.task-overflow')?.querySelector('.task-more');
    if (!returnTarget && trigger) returnTarget = trigger;
    menu.classList.add('hidden');
    menu.classList.remove('opens-up');
    menu.querySelectorAll('[role="menuitem"]').forEach((item) => { item.tabIndex = -1; });
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
  if (restoreFocus && returnTarget) returnTarget.focus({ preventScroll: true });
  return returnTarget;
}

function openTaskMenu(trigger, focusLast) {
  closeTaskMenus(false);
  const overflow = trigger.closest('.task-overflow');
  const menu = overflow?.querySelector('.task-menu');
  if (!menu) return false;
  menu.classList.remove('hidden', 'opens-up');
  trigger.setAttribute('aria-expanded', 'true');
  const menuRect = menu.getBoundingClientRect();
  const anchorRect = overflow.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight - 12 && anchorRect.top > menuRect.height + 12) {
    menu.classList.add('opens-up');
  }
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  items.forEach((item) => { item.tabIndex = -1; });
  if (items.length) {
    const target = focusLast ? items[items.length - 1] : items[0];
    target.tabIndex = 0;
    target.focus({ preventScroll: true });
  }
  return true;
}

function toggleTaskMenu(trigger) {
  const menu = trigger.closest('.task-overflow')?.querySelector('.task-menu');
  const wasOpen = !!menu && !menu.classList.contains('hidden');
  closeTaskMenus(false);
  if (!wasOpen) openTaskMenu(trigger, false);
  else trigger.focus({ preventScroll: true });
}

function onTaskMenuKeyDown(event) {
  const trigger = event.target.closest('.task-more');
  if (trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    openTaskMenu(trigger, event.key === 'ArrowUp');
    return;
  }
  const item = event.target.closest('.task-menu-item[role="menuitem"]');
  if (!item) return;
  const menu = item.closest('.task-menu');
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  const index = items.indexOf(item);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeTaskMenus(true);
    return;
  }
  if (event.key === 'Tab') {
    closeTaskMenus(false);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  let target = index;
  if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = items.length - 1;
  else if (event.key === 'ArrowDown') target = (index + 1) % items.length;
  else target = (index - 1 + items.length) % items.length;
  items.forEach((entry, itemIndex) => { entry.tabIndex = itemIndex === target ? 0 : -1; });
  items[target].focus({ preventScroll: true });
}

function currentTaskRows() {
  const view = document.querySelector(`#view-${currentView}`);
  return view ? Array.from(view.querySelectorAll('.task-row')) : [];
}

function focusTaskAfterMutation(id, previousIndex, preferredSelector) {
  const rows = currentTaskRows();
  if (!rows.length) return false;
  const sameTask = rows.find((row) => parseInt(row.dataset.id, 10) === id);
  const target = sameTask || rows[Math.min(Math.max(previousIndex, 0), rows.length - 1)];
  const preferred = sameTask && preferredSelector ? sameTask.querySelector(preferredSelector) : null;
  const control = preferred || target?.querySelector('.task-more, .task-title-btn');
  if (!control) return false;
  control.focus({ preventScroll: true });
  return true;
}

function setTaskRowMutationState(taskId, busy, control) {
  const id = Number(taskId);
  if (!Number.isFinite(id)) return;
  $$(`.task-row[data-id="${id}"]`).forEach((row) => {
    row.classList.toggle('is-busy', busy);
    row.setAttribute('aria-busy', String(busy));
    row.draggable = !busy;
    row.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  });
  $$(`.overdue-actions[data-id="${id}"] button`).forEach((button) => { button.disabled = busy; });
  if (control && control.setAttribute) control.setAttribute('aria-busy', String(busy));
}

async function runTaskRowMutation(options) {
  const taskId = Number(options.taskId);
  if (!Number.isFinite(taskId) || taskMutationLocks.has(taskId)) return false;
  taskMutationLocks.add(taskId);
  setTaskRowMutationState(taskId, true, options.control);
  let succeeded = false;
  try {
    await options.operation();
    succeeded = true;
  } catch (error) {
    console.error('[task-row] operation failed:', error);
    toast(options.errorMessage || '任务操作失败，请重试', 4000, null, 'err');
  } finally {
    taskMutationLocks.delete(taskId);
    setTaskRowMutationState(taskId, false, options.control);
    if (Number.isInteger(options.previousIndex)) {
      focusTaskAfterMutation(taskId, options.previousIndex, options.focusSelector);
    }
  }
  return succeeded;
}

async function runTaskMenuAction(action, task, row) {
  const rows = currentTaskRows();
  const previousIndex = Math.max(0, rows.indexOf(row));
  if (action === 'edit') {
    closeTaskMenus(true);
    openModal(task);
    return;
  }
  closeTaskMenus(false);
  await runTaskRowMutation({
    taskId: task.id,
    control: row.querySelector('.task-more'),
    operation: async () => {
      if (action === 'copy') await duplicateTask(task);
      else if (action === 'archive') await archiveTaskById(task.id, task.title);
      else if (action === 'unarchive') await unarchiveTaskById(task.id);
      else if (action === 'delete') await deleteTaskById(task.id, task.title);
    },
    errorMessage: '任务操作失败，请稍后重试',
    previousIndex
  });
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
  const message = res.next
    ? `「${t.title}」已完成，已自动安排下一次（${res.next.due}）`
    : `已完成「${t.title}」`;
  toast(message, 7000, [], 'ok');
  // 完成动画：找到对应行添加动画类
  const row = document.querySelector(`.task-row[data-id="${t.id}"]`);
  if (row) {
    row.classList.add('just-done');
    await motionDelay(MOTION_MS.base);
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
      : { theme: 'glass', aiStage: 'local', shortcuts: {} };
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
    applyAiPanelMode();
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

document.addEventListener('DOMContentLoaded', () => {
  // 先按视口定好面板状态再进 init，避免窄窗口下先闪一帧宽面板
  applyAiPanelMode();
  init();
});
