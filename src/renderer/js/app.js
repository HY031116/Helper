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
const viewScrollPositions = new Map();
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
let batchBusy = false;
let batchBusyMessage = '';
let batchBusyControl = null;
let visibleTaskIds = [];
let taskReorderBusy = false;
let boardMutationBusy = false;
let boardDragState = null;
let expandedIds = new Set(); // 展开的子任务
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
let reportPeriod = 'weekly';
let reportWeek = 0; // 周报选择的周（0=本周, -1=上周, 1=下周）
let reportDay = 0; // 日报选择的日（0=今天, -1=昨天, 1=明天）
let reportActionBusy = false;
let quickParseTimer = null;
let quickParseToken = 0;
let quickParseCache = { raw: '', parsed: null };
let modalSaving = false;
let modalReturnFocus = null;
let modalInitialSnapshot = '';
let taskAgentSessionSequence = 0;
let taskAgentState = { sessionId: 0, taskId: null, trigger: null, previewId: null, busy: false, requestId: null, previousAction: null, previousText: '', turns: [], workLogId: '', workLogKind: '' };
let aiSending = false;
let activeAiRequest = null;
let aiRequestSequence = 0;
let aiChatFollowing = true;
let aiRuntimeState = null; // null | ready | degraded
let aiRuntimeNotice = '';
const settingsActionScopes = new Set();
let workflowState = { preferences: {}, dailyPlans: {}, activeFocus: null, focusSessions: [] };
let workflowDraft = null;
let workflowDraftMeta = null;
let workflowSmartMode = false;
let workflowSmartText = '';
let workflowReview = null;
let workflowTickTimer = null;
let workflowBusy = false;
let dailyCopilot = null;
let copilotBusy = false;
let copilotSourcesOpen = false;
let copilotWakeTimer = null;
let eventsBound = false;
const dataLoadErrors = { tasks: null, memos: null };
const taskMutationLocks = new Set();
const MOTION_MS = Object.freeze({ instant: 80, fast: 140, base: 220, slow: 320 });
const FEEDBACK_HOLD_MS = 1200;
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
const WORK_LOG_NAME = { outcome: '成果', progress: '进展', blocker: '阻塞', decision: '决策', next: '下一步' };
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
  if (t.project) sub.push(`<span class="proj-chip">${uiIcon('folder')}<span>${esc(t.project)}</span></span>`);
  const dueHtml = t.due
    ? `<span class="tdue${isOverdue(t.due, t.status) ? ' over' : ''}" title="${esc(t.due)}">${esc(relDue(t.due))}</span>`
    : '';
  const isSelected = selectedIds.has(t.id);
  const checked = batchMode ? isSelected : t.status === 'done';
  const checkIcon = checked ? uiIcon('check') : '';
  const selected = isSelected ? ' sel' : '';
  const hasChildren = t.children && t.children.length;
  const expanded = expandedIds.has(t.id);
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
  const agentAction = t.status === 'archived' ? '' : `<button type="button" class="task-agent-btn" title="和 Agent 一起修改" aria-label="和 Agent 一起修改任务「${esc(t.title)}」" aria-expanded="false">${uiIcon('message')}</button>`;
  const workLogs = (Array.isArray(t.workLogs) ? t.workLogs : []).slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 4);
  const workLogHtml = `<section class="task-worklog" aria-label="工作记录">
    <div class="task-worklog-head"><strong>工作记录</strong><button type="button" class="task-log-add" data-worklog-add="${t.id}" aria-label="记录「${esc(t.title)}」的工作进展">${uiIcon('plus')}<span>记录</span></button></div>
    ${workLogs.length ? `<div class="task-worklog-list">${workLogs.map((log) => `<article class="task-worklog-item ${esc(log.kind)}">
      <span class="task-worklog-kind">${WORK_LOG_NAME[log.kind] || '进展'}</span>
      <p>${esc(log.text)}</p>
      <time>${fmtTime(log.createdAt)}</time>
      <span class="task-worklog-tools">
        <button type="button" data-worklog-edit="${esc(log.id)}" aria-label="编辑这条工作记录" title="编辑">${uiIcon('pencil')}</button>
        <button type="button" data-worklog-remove="${esc(log.id)}" aria-label="删除这条工作记录" title="删除">${uiIcon('trash')}</button>
      </span>
    </article>`).join('')}</div>` : '<p class="task-worklog-empty">还没有记录进展、成果或阻塞</p>'}
  </section>`;
  // 详情展开区
  const detailOpen = expandedIds.has('d' + t.id);
  const detailHtml = detailOpen ? `<div class="task-detail">
    ${t.desc ? `<div class="td-row"><span class="td-label">描述</span><span class="td-val">${esc(t.desc)}</span></div>` : ''}
    ${t.project ? `<div class="td-row"><span class="td-label">项目</span><span class="td-val td-project">${uiIcon('folder')}<span>${esc(t.project)}</span></span></div>` : ''}
    ${t.tags && t.tags.length ? `<div class="td-row"><span class="td-label">标签</span><span class="td-val">${t.tags.map((x) => `<span class="tag-chip">#${esc(x)}</span>`).join(' ')}</span></div>` : ''}
    ${t.repeat ? `<div class="td-row"><span class="td-label">重复</span><span class="td-val">${t.repeat === 'daily' ? '每天' : t.repeat === 'weekly' ? '每周' : '每月'}</span></div>` : ''}
    ${t.remind ? `<div class="td-row"><span class="td-label">提醒</span><span class="td-val">提前 ${t.remind} 分钟</span></div>` : ''}
    ${t.estimatedMinutes ? `<div class="td-row"><span class="td-label">预计</span><span class="td-val">${t.estimatedMinutes} 分钟</span></div>` : ''}
    <div class="td-row"><span class="td-label">创建</span><span class="td-val">${fmtTime(t.createdAt)}</span></div>
    ${t.status === 'done' && t.completedAt ? `<div class="td-row"><span class="td-label">完成</span><span class="td-val">${fmtTime(t.completedAt)}</span></div>` : ''}
    ${workLogHtml}
  </div>` : '';
  const checkLabel = batchMode
    ? `${isSelected ? '取消选择' : '选择'}任务「${t.title}」`
    : (t.status === 'done' ? '重新打开' : '完成任务');
  return `<div class="task-row${t.status === 'done' ? ' done' : ''}${t.status === 'archived' ? ' archived' : ''}${batchMode ? ' selecting' : ''}${selected}${overdueCls}" data-id="${t.id}" draggable="${!batchMode}">
    <button type="button" class="task-check" title="${esc(checkLabel)}" aria-label="${esc(checkLabel)}" aria-pressed="${batchMode ? isSelected : t.status === 'done'}">${checkIcon}</button>
    <button type="button" class="pri-dot p${t.pri}" title="点击切换优先级（当前：${PRI_NAME[t.pri]}）" aria-label="当前${PRI_NAME[t.pri]}优先级，点击切换" data-pri-toggle${batchMode ? ' tabindex="-1"' : ''}>${PRI_NAME[t.pri]}</button>
    ${hasChildren ? `<button type="button" class="task-expand${expanded ? ' open' : ''}" title="${expanded ? '收起' : '展开'}子任务" aria-label="${expanded ? '收起' : '展开'}子任务" aria-expanded="${expanded}"${batchMode ? ' tabindex="-1"' : ''}>${uiIcon('chevron-right')}</button>` : ''}
    <div class="task-main"${batchMode ? ' inert' : ''}>
      <button type="button" class="tname task-title-btn" aria-expanded="${detailOpen}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">${titleHtml}</button>
      ${sub.length ? `<div class="tsub">${sub.join(' · ')}</div>` : ''}
      ${hasChildren && expanded ? `<div class="child-list">${t.children.map((c) => {
        const x = childLabel(c);
        return `<button type="button" class="child-item${x.done ? ' done' : ''}" data-child-id="${x.id}" data-parent-id="${t.id}" aria-pressed="${x.done}">
          <span class="child-check" aria-hidden="true">${x.done ? uiIcon('check') : ''}</span>
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
      ${agentAction}
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
    if (currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:')) {
      const label = currentFilter.startsWith('proj:') ? currentFilter.slice(5) : `#${currentFilter.slice(4)}`;
      container.innerHTML = `<div class="empty">
        <div class="big" aria-hidden="true">${uiIcon(currentFilter.startsWith('proj:') ? 'folder' : 'search')}</div>
        <div class="empty-title">“${esc(label)}”下没有任务</div>
        <p class="empty-hint">清除当前筛选后可以查看其他任务。</p>
        <button type="button" class="btn mini ghost empty-cta" id="empty-clear-filter">清除筛选</button>
      </div>`;
      container.querySelector('#empty-clear-filter').addEventListener('click', () => {
        currentFilter = 'all';
        renderTasks();
        $('#smart-filters .fchip[data-filter="all"]')?.focus({ preventScroll: true });
      });
      return;
    }
    // 空状态 = 指引时刻：说明现状 + 给出下一步动作
    const emptyStates = {
      today: { ico: 'today', title: '今天没有到期任务', hint: '可以继续当前工作，或安排下一件要紧事。' },
      all: { ico: 'plus', title: '还没有任务', hint: '在快速添加框输入一句话，或让助手记下第一件事。' },
      active: { ico: 'circle-check', title: '没有未完成的任务', hint: '当前待办已经处理完。' },
      done: { ico: 'circle-check', title: '还没有已完成的任务', hint: '完成的任务会集中显示在这里。' },
      archived: { ico: 'archive', title: '没有已归档的任务', hint: '暂时收起的任务会保存在这里。' },
      nodate: { ico: 'calendar', title: '所有任务都设了截止日期', hint: '当前没有遗漏截止时间的任务。' },
      overdue: { ico: 'circle-check', title: '没有过期任务', hint: '当前任务都在计划内。' },
      week: { ico: 'calendar', title: '本周没有新任务', hint: '可以继续处理已有事项。' }
    };
    const key = currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:') ? 'all' : currentFilter;
    const st = emptyStates[key] || emptyStates.all;
    const showBtn = currentFilter === 'all' || currentFilter.startsWith('proj:') || currentFilter.startsWith('tag:');
    container.innerHTML = `<div class="empty">
      <div class="big" aria-hidden="true">${uiIcon(st.ico)}</div>
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

/* ---------- 每日工作闭环 ---------- */
function todayWorkflowKey() {
  return localDateKey(Date.now());
}

function workflowPlan() {
  return workflowState && workflowState.dailyPlans ? workflowState.dailyPlans[todayWorkflowKey()] || null : null;
}

function formatWorkflowDuration(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function formatWorkflowClock(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function workflowItemHtml(item, editable, index, count) {
  const task = tasks.find((entry) => entry.id === item.taskId);
  const status = task && task.status === 'done' ? 'done' : item.status;
  const controls = editable
    ? `<div class="workflow-item-controls">
        <label class="sr-only" for="workflow-minutes-${index}">「${esc(item.title)}」计划分钟数</label>
        <input class="workflow-minutes" id="workflow-minutes-${index}" data-workflow-minutes="${index}" type="number" min="5" max="480" step="5" value="${item.plannedMinutes}">
        <span class="workflow-order">
          <button type="button" class="workflow-icon-btn" data-workflow="move-up" data-index="${index}" title="上移" aria-label="上移「${esc(item.title)}」"${index === 0 ? ' disabled' : ''}>${uiIcon('chevron-up')}</button>
          <button type="button" class="workflow-icon-btn" data-workflow="move-down" data-index="${index}" title="下移" aria-label="下移「${esc(item.title)}」"${index === count - 1 ? ' disabled' : ''}>${uiIcon('chevron-down')}</button>
          <button type="button" class="workflow-icon-btn" data-workflow="remove-item" data-index="${index}" title="从计划移除" aria-label="从计划移除「${esc(item.title)}」">${uiIcon('x')}</button>
        </span>
      </div>`
    : `<div class="workflow-item-controls">${status === 'done'
      ? '<span class="quick-preview-chip">已完成</span>'
      : `<button type="button" class="btn mini${status === 'active' ? ' ghost' : ''}" data-workflow="start" data-task-id="${item.taskId}">${status === 'active' ? '专注中' : '开始'}</button>`}</div>`;
  return `<div class="workflow-item ${esc(status)}" data-plan-task-id="${item.taskId}">
    <span class="workflow-time">${esc(item.plannedStart || '')}${item.plannedEnd ? ` - ${esc(item.plannedEnd)}` : ''}</span>
    <span class="workflow-task"><strong>${esc(item.title)}</strong><span>${esc(item.reason || '')}${item.partial ? ' · 本次先推进一部分' : ''}</span></span>
    ${controls}
  </div>`;
}

function syncWorkflowBusyState() {
  const panel = $('#workflow-panel');
  if (!panel) return;
  panel.classList.toggle('is-busy', workflowBusy);
  panel.setAttribute('aria-busy', String(workflowBusy));
  panel.querySelectorAll('[data-workflow], [data-workflow-minutes], #workflow-review-note').forEach((control) => {
    if (workflowBusy) {
      if (control.dataset.workflowWasDisabled === undefined) {
        control.dataset.workflowWasDisabled = String(control.disabled);
      }
      control.disabled = true;
    } else if (control.dataset.workflowWasDisabled !== undefined) {
      control.disabled = control.dataset.workflowWasDisabled === 'true';
      delete control.dataset.workflowWasDisabled;
    }
  });
}

function setWorkflowBusy(busy, control, action) {
  workflowBusy = busy;
  syncWorkflowBusyState();
  if (!control || !control.setAttribute) return;
  control.setAttribute('aria-busy', String(busy));
  if (busy && control.classList.contains('btn')) {
    control.dataset.workflowIdleLabel = control.textContent;
    const labels = {
      preview: '生成中…', replan: '规划中…', 'apply-plan': '保存中…', start: '开始中…',
      pause: '暂停中…', resume: '继续中…', interrupt: '记录中…', finish: '保存中…',
      'complete-focus': '完成中…', review: '读取中…', 'save-review': '保存中…',
      'smart-preview': '理解中…'
    };
    control.textContent = labels[action] || '处理中…';
  } else if (!busy && control.dataset.workflowIdleLabel !== undefined) {
    control.textContent = control.dataset.workflowIdleLabel;
    delete control.dataset.workflowIdleLabel;
  }
}

function focusWorkflowAfterAction(action, succeeded, context) {
  const panel = $('#workflow-panel');
  if (!panel || typeof panel.querySelector !== 'function') return false;
  const successSelectors = {
    preview: '[data-workflow="apply-plan"]:not([disabled]), [data-workflow="cancel-draft"]',
    replan: '[data-workflow="apply-plan"]:not([disabled]), [data-workflow="cancel-draft"]',
    'apply-plan': '[data-workflow="start"]:not([disabled]), [data-workflow="replan"]',
    start: '[data-workflow="pause"], [data-workflow="resume"]',
    pause: '[data-workflow="resume"]',
    resume: '[data-workflow="pause"]',
    interrupt: '#workflow-interrupt-reason',
    finish: '[data-workflow="start"]:not([disabled]), [data-workflow="review"]',
    'complete-focus': '[data-workflow="start"]:not([disabled]), [data-workflow="review"]',
    review: '#workflow-review-note',
    'save-review': '[data-workflow="review"]',
    'smart-toggle': '#workflow-smart-input',
    'smart-preview': '[data-workflow="apply-plan"]'
  };
  let target = null;
  if (succeeded && successSelectors[action]) target = panel.querySelector(successSelectors[action]);
  if (!target && context && context.taskId) {
    const item = panel.querySelector(`[data-plan-task-id="${context.taskId}"]`);
    if (item) {
      target = item.querySelector(`[data-workflow="${action}"]:not([disabled]), [data-workflow]:not([disabled]), [data-workflow-minutes]:not([disabled])`);
    }
  }
  if (!target && !succeeded) target = panel.querySelector(`[data-workflow="${action}"]:not([disabled])`);
  if (!target) target = panel.querySelector('[data-workflow]:not([disabled]), [data-workflow-minutes]:not([disabled]), textarea:not([disabled])');
  if (!target || typeof target.focus !== 'function') return false;
  target.focus({ preventScroll: true });
  return true;
}

function dailyCopilotSummary(summary) {
  const value = summary && typeof summary === 'object' ? summary : {};
  const parts = [];
  if (value.overdueCount) parts.push(`${value.overdueCount} 项逾期`);
  if (value.dueTodayCount) parts.push(`${value.dueTodayCount} 项今天截止`);
  if (value.plannedCount) parts.push(`计划完成 ${value.completedPlanCount}/${value.plannedCount}`);
  if (!parts.length) parts.push(`${value.openCount || 0} 项待处理`);
  return parts.join(' · ');
}

function nextCopilotWakeDelay(briefing) {
  if (!briefing || !briefing.suppressedBy) return 0;
  const now = new Date();
  let target = 0;
  if (briefing.suppressedBy === 'snoozed') {
    target = Number(briefing.snoozedUntil) || 0;
  } else if (briefing.suppressedBy === 'quiet') {
    const end = String(briefing.quietHours || '').split('-')[1] || '08:00';
    const parts = end.split(':').map(Number);
    const wake = new Date(now);
    wake.setHours(parts[0] || 0, parts[1] || 0, 0, 50);
    if (wake.getTime() <= now.getTime()) wake.setDate(wake.getDate() + 1);
    target = wake.getTime();
  } else if (briefing.suppressedBy === 'muted') {
    const wake = new Date(now);
    wake.setDate(wake.getDate() + 1);
    wake.setHours(0, 0, 0, 50);
    target = wake.getTime();
  }
  return target > now.getTime() ? Math.min(2147483000, target - now.getTime()) : 0;
}

function scheduleDailyCopilotWake(briefing) {
  clearTimeout(copilotWakeTimer);
  copilotWakeTimer = null;
  const delay = nextCopilotWakeDelay(briefing);
  if (!delay) return;
  copilotWakeTimer = setTimeout(() => {
    copilotWakeTimer = null;
    refreshDailyCopilot();
  }, delay);
}

function renderDailyCopilot() {
  const panel = $('#daily-copilot');
  if (!panel) return;
  const briefing = dailyCopilot;
  scheduleDailyCopilotWake(briefing);
  if (!briefing || !briefing.visible || !briefing.suggestion) {
    panel.classList.add('hidden');
    panel.replaceChildren();
    return;
  }
  const item = briefing.suggestion;
  const generated = new Date(briefing.generatedAt || Date.now());
  const time = `${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}`;
  const sources = Array.isArray(item.sources) ? item.sources : [];
  const sourceHtml = sources.length ? `<div class="copilot-sources${copilotSourcesOpen ? '' : ' hidden'}" id="copilot-sources">
    ${sources.map((source) => `<div class="copilot-source"><span>${esc(source.type === 'plan' ? '计划' : source.type === 'focus' ? '专注' : '任务')}</span><div><strong>${esc(source.label)}</strong><small>${esc(source.detail)}</small></div></div>`).join('')}
  </div>` : '';
  panel.className = `daily-copilot urgency-${esc(item.urgency || 'normal')}${copilotBusy ? ' is-busy' : ''}`;
  panel.innerHTML = `<div class="copilot-rail" aria-hidden="true"><span></span><strong>${time}</strong></div>
    <div class="copilot-main">
      <div class="copilot-kicker"><span class="copilot-agent-mark">Agent</span><span>${esc(briefing.heading)}</span><span class="copilot-summary">${esc(dailyCopilotSummary(briefing.summary))}</span></div>
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.detail)}</p>
      <div class="copilot-why"><strong>为什么现在</strong><span>${esc(item.reason)}</span></div>
      ${sourceHtml}
      <div class="copilot-foot">
        <div class="copilot-secondary">
          ${sources.length ? `<button type="button" class="text-action" data-copilot="sources" aria-expanded="${copilotSourcesOpen}" aria-controls="copilot-sources">${copilotSourcesOpen ? '收起依据' : `查看依据 ${sources.length}`}</button>` : ''}
          <button type="button" class="text-action" data-copilot="snooze">30 分钟后提醒</button>
          <button type="button" class="text-action" data-copilot="mute">今天不再提示</button>
        </div>
        <button type="button" class="btn mini copilot-primary" data-copilot="primary"${copilotBusy ? ' disabled aria-busy="true"' : ''}>${copilotBusy ? '处理中…' : esc(item.action && item.action.label || '查看')}</button>
      </div>
    </div>`;
  panel.classList.remove('hidden');
}

async function refreshDailyCopilot() {
  if (!window.api.workflow || !window.api.workflow.getCopilot) return null;
  try {
    dailyCopilot = await window.api.workflow.getCopilot();
    renderDailyCopilot();
    return dailyCopilot;
  } catch (error) {
    console.error('[copilot] briefing failed:', error);
    return null;
  }
}

async function previewCopilotPlan(replan) {
  workflowDraft = await window.api.workflow.previewPlan({});
  workflowDraftMeta = { mode: 'copilot', constraints: {} };
  workflowReview = null;
  if (!workflowDraft.items.length) {
    workflowDraft = null;
    workflowDraftMeta = null;
    throw new Error('当前没有可安排的未完成任务');
  }
  renderWorkflowPanel();
  toast(replan ? '调整方案已生成，确认后才会替换今日计划' : '今日计划草案已生成，确认后才会保存', 3500, null, 'ok');
  $('#workflow-panel [data-workflow="apply-plan"]')?.focus({ preventScroll: true });
}

async function runDailyCopilotPrimary() {
  const item = dailyCopilot && dailyCopilot.suggestion;
  const action = item && item.action;
  if (!action) return;
  if (action.kind === 'preview_plan') await previewCopilotPlan(false);
  else if (action.kind === 'preview_replan') await previewCopilotPlan(true);
  else if (action.kind === 'start_focus') {
    workflowState = await window.api.workflow.startFocus(item.targetId, { targetMinutes: action.targetMinutes });
    await refreshTasksAfterMutation('专注已经开始，但任务列表刷新失败');
  } else if (action.kind === 'resume_focus') {
    workflowState = await window.api.workflow.resumeFocus({});
    renderWorkflowPanel();
    $('#workflow-panel [data-workflow="pause"]')?.focus({ preventScroll: true });
  } else if (action.kind === 'view_focus') {
    $('#workflow-panel')?.scrollIntoView({ block: 'nearest' });
    $('#workflow-panel [data-workflow="pause"], #workflow-panel [data-workflow="resume"]')?.focus({ preventScroll: true });
  } else if (action.kind === 'review_day') {
    workflowReview = await window.api.workflow.getReview(todayWorkflowKey());
    renderWorkflowPanel();
    $('#workflow-review-note')?.focus({ preventScroll: true });
  } else if (action.kind === 'new_task') {
    switchView('tasks');
    openModal(null);
  } else if (action.kind === 'open_daily_report') {
    reportPeriod = 'daily';
    reportDay = 0;
    switchView('stat');
    renderStat();
    $('#btn-report-gen')?.focus({ preventScroll: true });
  }
  await refreshDailyCopilot();
}

async function handleDailyCopilotAction(event) {
  const button = event.target.closest('[data-copilot]');
  if (!button || copilotBusy) return;
  const action = button.dataset.copilot;
  if (action === 'sources') {
    copilotSourcesOpen = !copilotSourcesOpen;
    renderDailyCopilot();
    $('#daily-copilot [data-copilot="sources"]')?.focus({ preventScroll: true });
    return;
  }
  copilotBusy = true;
  renderDailyCopilot();
  try {
    if (action === 'snooze' || action === 'mute') {
      dailyCopilot = await window.api.workflow.updateCopilot({ action: action === 'snooze' ? 'snooze' : 'mute-today', minutes: 30 });
      renderDailyCopilot();
      toast(action === 'snooze' ? '30 分钟内不再显示这条建议' : '今天不再显示主动建议', 5000, [{
        label: '恢复',
        run: async () => {
          dailyCopilot = await window.api.workflow.updateCopilot({ action: 'restore' });
          renderDailyCopilot();
        }
      }], 'ok');
    } else if (action === 'primary') {
      await runDailyCopilotPrimary();
    }
  } catch (error) {
    toast(error.message || '每日助手操作失败，请重试', 4500, null, 'err');
  } finally {
    copilotBusy = false;
    renderDailyCopilot();
  }
}

function renderWorkflowPanel() {
  const panel = $('#workflow-panel');
  if (!panel) return;
  const focus = workflowState && workflowState.activeFocus;
  const plan = workflowDraft || workflowPlan();
  const editable = !!workflowDraft;
  if (!focus && !plan) {
    const actionable = tasks.filter((task) => !task._deleted && ['todo', 'doing'].includes(task.status));
    const fallbackMinutes = Number(workflowState.preferences && workflowState.preferences.defaultTaskMinutes) || 30;
    const estimatedMinutes = actionable.reduce((total, task) => total + (Number(task.estimatedMinutes) || fallbackMinutes), 0);
    panel.innerHTML = `<div class="workflow-empty">
      <div class="workflow-empty-head">
        <span class="workflow-empty-mark" aria-hidden="true">${uiIcon('today')}</span>
        <div class="workflow-title"><strong>安排今天</strong><span>${actionable.length} 项待处理${actionable.length ? ` · 预计 ${formatWorkflowDuration(estimatedMinutes)}` : ''}</span></div>
      </div>
      ${workflowSmartMode ? `<div class="workflow-smart-entry">
        <label for="workflow-smart-input">告诉助手今天的限制或重点</label>
        <textarea id="workflow-smart-input" rows="2" maxlength="240" placeholder="例如：今天只有 3 小时，先做发布相关，14:00-15:00 开会">${esc(workflowSmartText)}</textarea>
        <div class="workflow-smart-foot"><span>只生成草案，确认后才会保存</span><div class="workflow-actions"><button type="button" class="btn mini ghost" data-workflow="smart-cancel">取消</button><button type="button" class="btn mini" data-workflow="smart-preview">生成智能计划</button></div></div>
      </div>` : `<div class="workflow-empty-actions"><button type="button" class="btn mini" data-workflow="preview">生成今日计划</button><button type="button" class="btn mini ghost" data-workflow="smart-toggle">智能安排</button></div>`}
    </div>`;
    syncWorkflowBusyState();
    return;
  }

  let html = '';
  if (focus) {
    const elapsed = Number(focus.elapsedMs) || 0;
    html += `<div class="workflow-focus">
      <div class="workflow-title"><strong>${focus.state === 'paused' ? '已暂停' : '正在专注'} · ${esc(focus.title)}</strong>
        <div class="workflow-clock" id="workflow-clock" data-started="${focus.resumedAt || ''}" data-accumulated="${focus.accumulatedMs || 0}">${formatWorkflowClock(elapsed)}</div>
        <div class="workflow-focus-meta">目标 ${focus.targetMinutes} 分钟 · ${focus.interruptions.length} 次打断</div>
        ${focus.state === 'paused' ? '<div class="workflow-interrupt"><input id="workflow-interrupt-reason" maxlength="160" placeholder="记录这次为什么被打断"><button type="button" class="btn mini ghost" data-workflow="interrupt">记录</button></div>' : ''}
      </div>
      <div class="workflow-actions">
        ${focus.state === 'paused'
          ? '<button type="button" class="btn mini" data-workflow="resume">继续</button>'
          : '<button type="button" class="btn mini ghost" data-workflow="pause">暂停</button>'}
        <button type="button" class="btn mini ghost" data-workflow="finish">结束专注</button>
        <button type="button" class="btn mini" data-workflow="complete-focus">完成任务</button>
      </div>
    </div>`;
  }

  if (plan) {
    const overCapacity = plan.scheduledMinutes > plan.capacityMinutes;
    const smartSummary = workflowDraftMeta && workflowDraftMeta.mode === 'smart'
      ? `<div class="workflow-constraint-summary" role="status"><span class="workflow-constraint-label">智能约束</span><span>${esc(formatWorkflowConstraints(workflowDraftMeta.constraints))}</span></div>`
      : '';
    html += `<div class="workflow-head">
      <div class="workflow-title"><strong>${editable ? '计划预览' : '今日计划'} · ${plan.items.length} 项</strong><span class="${overCapacity ? 'workflow-over' : ''}">${formatWorkflowDuration(plan.scheduledMinutes)} / 可用 ${formatWorkflowDuration(plan.capacityMinutes)}${overCapacity ? ` · 超出 ${formatWorkflowDuration(plan.scheduledMinutes - plan.capacityMinutes)}` : ''}${plan.omittedCount ? ` · 另有 ${plan.omittedCount} 项未排入` : ''}</span></div>
      <div class="workflow-actions">${editable
        ? `<button type="button" class="btn mini ghost" data-workflow="cancel-draft">取消</button><button type="button" class="btn mini" data-workflow="apply-plan"${overCapacity ? ' disabled title="请先缩短计划时长"' : ''}>确认计划</button>`
        : '<button type="button" class="btn mini ghost" data-workflow="replan">重新规划</button><button type="button" class="btn mini" data-workflow="review">结束今天</button>'}</div>
    </div>`;
    html += smartSummary;
    html += `<div class="workflow-list">${plan.items.map((item, index) => workflowItemHtml(item, editable, index, plan.items.length)).join('')}</div>`;
  }

  if (workflowReview) {
    html += `<div class="workflow-review">
      <div class="workflow-title"><strong>今日复盘</strong><span>基于计划、任务完成状态和专注记录生成。</span></div>
      <div class="workflow-review-metrics"><span>完成 ${workflowReview.completedCount}/${workflowReview.plannedCount}</span><span>完成率 ${workflowReview.completionRate}%</span><span>专注 ${workflowReview.focusedMinutes} 分钟</span><span>打断 ${workflowReview.interruptionCount} 次</span></div>
      <p class="workflow-suggestion">${esc(workflowReview.suggestion)}</p>
      <label class="sr-only" for="workflow-review-note">复盘备注</label><textarea id="workflow-review-note" maxlength="1000" placeholder="补充今天有效的方法、卡点或明天需要注意的事"></textarea>
      <div class="workflow-actions"><button type="button" class="btn mini ghost" data-workflow="cancel-review">取消</button><button type="button" class="btn mini" data-workflow="save-review">保存复盘</button></div>
    </div>`;
  }
  panel.innerHTML = html;
  syncWorkflowBusyState();
}

function formatWorkflowConstraints(constraints) {
  const value = constraints && typeof constraints === 'object' ? constraints : {};
  const parts = [];
  if (value.availableMinutes) parts.push(`可用 ${formatWorkflowDuration(value.availableMinutes)}`);
  if (value.startTime && value.endTime) parts.push(`${value.startTime}-${value.endTime}`);
  else if (value.startTime) parts.push(`${value.startTime} 开始`);
  if (value.focus) parts.push(`重点：${value.focus}`);
  if (Array.isArray(value.include) && value.include.length) parts.push(`优先 ${value.include.join('、')}`);
  if (Array.isArray(value.exclude) && value.exclude.length) parts.push(`暂不安排 ${value.exclude.join('、')}`);
  if (Array.isArray(value.blockedTimes) && value.blockedTimes.length) parts.push(`占用 ${value.blockedTimes.join('、')}`);
  return parts.join(' · ') || '已按你的描述生成';
}

function recalculateWorkflowDraft() {
  if (!workflowDraft) return;
  let cursor = workflowDraft.items.length && workflowDraft.items[0].plannedStart
    ? workflowDraft.items[0].plannedStart.split(':').reduce((total, value, index) => total + Number(value) * (index ? 1 : 60), 0)
    : 9 * 60;
  const breakMinutes = Number(workflowState.preferences && workflowState.preferences.shortBreakMinutes) || 5;
  const blocked = (Array.isArray(workflowDraft.blockedTimes) ? workflowDraft.blockedTimes : [])
    .map((value) => String(value).match(/^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/))
    .filter(Boolean)
    .map((match) => ({ start: match[1].split(':').map(Number).reduce((h, m) => h * 60 + m), end: match[2].split(':').map(Number).reduce((h, m) => h * 60 + m) }));
  const skipBlocked = (start, duration) => {
    let next = start;
    blocked.forEach((range) => {
      if (next < range.end && next + duration > range.start) next = range.end;
    });
    return next;
  };
  workflowDraft.items.forEach((item, index) => {
    item.order = index;
    item.plannedMinutes = Math.max(5, Math.min(480, Math.round(Number(item.plannedMinutes) || 30)));
    cursor = skipBlocked(cursor, item.plannedMinutes);
    item.plannedStart = `${String(Math.floor(cursor / 60) % 24).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`;
    cursor += item.plannedMinutes;
    item.plannedEnd = `${String(Math.floor(cursor / 60) % 24).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`;
    cursor += breakMinutes;
  });
  workflowDraft.scheduledMinutes = workflowDraft.items.reduce((sum, item) => sum + item.plannedMinutes, 0);
}

async function refreshWorkflow() {
  if (!window.api.workflow) return;
  const [workflow, copilot] = await Promise.all([
    window.api.workflow.get(),
    window.api.workflow.getCopilot ? window.api.workflow.getCopilot() : Promise.resolve(dailyCopilot)
  ]);
  workflowState = workflow;
  dailyCopilot = copilot;
  renderDailyCopilot();
  renderWorkflowPanel();
}

async function handleWorkflowAction(event) {
  const actionButton = event.target.closest('[data-workflow]');
  const minutesInput = event.target.closest('[data-workflow-minutes]');
  if (minutesInput && workflowDraft) {
    if (workflowBusy) return false;
    workflowDraft.items[Number(minutesInput.dataset.workflowMinutes)].plannedMinutes = Number(minutesInput.value);
    recalculateWorkflowDraft();
    renderWorkflowPanel();
    return true;
  }
  if (!actionButton || !window.api.workflow) return;
  if (workflowBusy) return false;
  const action = actionButton.dataset.workflow;
  const item = actionButton.closest('.workflow-item');
  const focusContext = { taskId: item ? item.dataset.planTaskId : null };
  setWorkflowBusy(true, actionButton, action);
  let succeeded = false;
  try {
    if (action === 'smart-toggle') {
      workflowSmartMode = true;
      workflowSmartText = '';
    } else if (action === 'smart-cancel') {
      workflowSmartMode = false;
      workflowSmartText = '';
    } else if (action === 'smart-preview') {
      const input = $('#workflow-smart-input');
      const text = input ? input.value.trim() : workflowSmartText.trim();
      if (!text) throw new Error('请先填写今天的限制或重点');
      workflowSmartText = text;
      workflowSmartMode = true;
      const result = await window.api.workflow.previewSmartPlan(text, nextAiRequestId());
      if (!result || result.type === 'error') throw new Error(result && result.message || '智能安排暂时不可用，请稍后重试');
      workflowDraft = result.plan;
      workflowDraftMeta = { mode: 'smart', constraints: result.constraints || {} };
      workflowReview = null;
      workflowSmartMode = false;
      workflowSmartText = '';
      if (result.notice) toast(result.notice, 5000, null, 'warn');
      if (!workflowDraft.items.length) {
        const omitted = workflowDraft.omittedCount;
        workflowDraft = null;
        workflowDraftMeta = null;
        workflowSmartMode = true;
        toast(
          omitted ? '今天剩余工作时间不足，未安排任务' : '当前没有符合条件的未完成任务',
          3500,
          null,
          'warn'
        );
      }
    } else if (action === 'preview' || action === 'replan') {
      workflowDraft = await window.api.workflow.previewPlan({});
      workflowDraftMeta = null;
      workflowReview = null;
      workflowSmartMode = false;
      workflowSmartText = '';
      if (!workflowDraft.items.length) {
        toast(
          workflowDraft.omittedCount ? '今天剩余工作时间不足，未继续安排任务' : '当前没有可安排的未完成任务',
          3500,
          null,
          'warn'
        );
      }
    } else if (action === 'cancel-draft') {
      workflowDraft = null;
      workflowDraftMeta = null;
      workflowSmartMode = false;
      workflowSmartText = '';
    } else if (action === 'move-up' || action === 'move-down') {
      const index = Number(actionButton.dataset.index);
      const next = action === 'move-up' ? index - 1 : index + 1;
      if (workflowDraft && next >= 0 && next < workflowDraft.items.length) {
        [workflowDraft.items[index], workflowDraft.items[next]] = [workflowDraft.items[next], workflowDraft.items[index]];
        recalculateWorkflowDraft();
      }
    } else if (action === 'remove-item') {
      workflowDraft.items.splice(Number(actionButton.dataset.index), 1);
      recalculateWorkflowDraft();
    } else if (action === 'apply-plan') {
      if (!workflowDraft.items.length) throw new Error('计划中至少保留一项任务');
      const result = await window.api.workflow.applyPlan(workflowDraft);
      workflowState = await window.api.workflow.get();
      workflowDraft = null;
      workflowDraftMeta = null;
      toast('今日计划已确认', 5000, [{ label: '撤销', run: async () => {
        const undone = await window.api.workflow.restorePlan({ date: result.plan.date, expectedRevision: result.plan.revision, previousPlan: result.previousPlan });
        if (!undone.ok) throw new Error(undone.message);
        await refreshWorkflow();
      } }], 'ok');
    } else if (action === 'start') {
      workflowState = await window.api.workflow.startFocus(Number(actionButton.dataset.taskId), {});
      await refreshTasksAfterMutation('任务已开始，但列表刷新失败');
    } else if (action === 'pause') {
      workflowState = await window.api.workflow.pauseFocus({});
    } else if (action === 'resume') {
      workflowState = await window.api.workflow.resumeFocus({});
    } else if (action === 'interrupt') {
      const input = $('#workflow-interrupt-reason');
      if (!input.value.trim()) throw new Error('请先填写打断原因');
      workflowState = await window.api.workflow.interrupt(input.value.trim(), {});
    } else if (action === 'finish' || action === 'complete-focus') {
      const result = await window.api.workflow.finishFocus({ completeTask: action === 'complete-focus' });
      workflowState = result.workflow;
      await refreshTasksAfterMutation(action === 'complete-focus' ? '任务已完成，但列表刷新失败' : '专注已结束，但列表刷新失败');
      toast(action === 'complete-focus' ? '任务已完成，专注记录已保存' : '专注记录已保存', 3500, null, 'ok');
    } else if (action === 'review') {
      workflowReview = await window.api.workflow.getReview(todayWorkflowKey());
    } else if (action === 'cancel-review') {
      workflowReview = null;
    } else if (action === 'save-review') {
      const note = $('#workflow-review-note')?.value || '';
      const result = await window.api.workflow.saveReview(todayWorkflowKey(), { note });
      workflowReview = null;
      await refreshWorkflow();
      toast('今日复盘已保存', 5000, [{ label: '撤销', run: async () => {
        const undone = await window.api.workflow.restorePlan({
          date: result.plan.date,
          expectedRevision: result.plan.revision,
          previousPlan: result.previousPlan
        });
        if (!undone.ok) throw new Error(undone.message);
        await refreshWorkflow();
      } }], 'ok');
    }
    succeeded = true;
    return true;
  } catch (error) {
    toast(error.message || '工作流操作失败，请重试', 4500, null, 'err');
    return false;
  } finally {
    setWorkflowBusy(false, actionButton, action);
    renderWorkflowPanel();
    focusWorkflowAfterAction(action, succeeded, focusContext);
    if (action === 'smart-preview' && succeeded) {
      setTimeout(() => focusWorkflowAfterAction(action, true, focusContext), 0);
    }
  }
}

function tickWorkflowClock() {
  const clock = $('#workflow-clock');
  if (!clock || !workflowState.activeFocus || workflowState.activeFocus.state !== 'running') return;
  const accumulated = Number(clock.dataset.accumulated) || 0;
  const started = Number(clock.dataset.started) || Date.now();
  clock.textContent = formatWorkflowClock(accumulated + Math.max(0, Date.now() - started));
}

/* ---------- 视图：今日 ---------- */
function renderToday() {
  renderDailyCopilot();
  renderWorkflowPanel();
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
  else if (currentFilter !== 'all') list = list.filter((t) => taskMatchesFilter(t));
  // 排序：手动 order 优先，其次按状态/优先级
  list.sort((a, b) => {
    if (a.status === 'archived' && b.status !== 'archived') return 1;
    if (a.status !== 'archived' && b.status === 'archived') return -1;
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    if (currentFilter === 'all' || currentFilter === 'active') {
      return compareTaskOrder(a, b);
    }
    return b.pri - a.pri;
  });
  visibleTaskIds = list.map((t) => t.id);
  const visibleSet = new Set(visibleTaskIds);
  selectedIds = new Set([...selectedIds].filter((id) => visibleSet.has(id)));
  renderList($('#tasks-list'), list);
  const done = tasks.filter((t) => !t._deleted && t.status === 'done').length;
  const total = tasks.filter((t) => !t._deleted && t.status !== 'archived').length;
  $('#tasks-sub').textContent = `显示 ${list.length} · 完成 ${done} / ${total}${currentSearch ? ' · 搜索：' + currentSearch : ''}`;
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
    ? currentFilter.slice(5)
    : currentFilter.startsWith('tag:')
      ? `#${currentFilter.slice(4)}`
      : `更多筛选 ${advancedCount}`;

  let html = `<div class="smart-row">
    ${smart.map((s) => `<button type="button" class="fchip ${currentFilter === s.k ? 'active' : ''}" aria-pressed="${currentFilter === s.k}" data-filter="${s.k}">${s.n}</button>`).join('')}
    ${advancedCount ? `<button type="button" class="fchip smart-more ${advancedSelected && !advancedFiltersOpen ? 'active' : ''}" id="smart-more" aria-expanded="${advancedFiltersOpen}" aria-controls="smart-advanced" aria-label="${advancedFiltersOpen ? '收起' : '展开'}项目和标签筛选"><span class="smart-more-label">${currentFilter.startsWith('proj:') ? uiIcon('folder') : ''}<span>${esc(advancedLabel)}</span></span>${uiIcon(advancedFiltersOpen ? 'chevron-up' : 'chevron-down')}</button>` : ''}
  </div>`;
  if (advancedCount) html += `<div class="smart-advanced ${advancedFiltersOpen ? '' : 'hidden'}" id="smart-advanced" role="group" aria-label="项目和标签筛选">`;
  if (advancedCount && projs.length) {
    html += `<div class="smart-row smart-sub">
      <span class="smart-label">项目</span>
      ${projs.map((p) => `<button type="button" class="fchip has-icon ${currentFilter === 'proj:' + p ? 'active' : ''}" aria-pressed="${currentFilter === 'proj:' + p}" data-filter="proj:${esc(p)}">${uiIcon('folder')}<span>${esc(p)}</span></button>`).join('')}
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

function compareTaskOrder(a, b) {
  const oa = Number.isFinite(Number(a.order)) ? Number(a.order) : 0;
  const ob = Number.isFinite(Number(b.order)) ? Number(b.order) : 0;
  if (oa !== ob) return oa - ob;
  if (a.pri !== b.pri) return b.pri - a.pri;
  return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
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
  if (bar.setAttribute) bar.setAttribute('aria-busy', String(batchBusy));
  const count = selectedIds.size;
  const completableCount = tasks.filter((t) => selectedIds.has(t.id) && t.status !== 'done' && t.status !== 'archived').length;
  $('#batch-count').textContent = batchBusy ? batchBusyMessage : (count ? `已选 ${count} 项` : '请选择任务');
  const doneButton = $('#batch-done');
  doneButton.disabled = batchBusy || completableCount === 0;
  doneButton.innerHTML = `${uiIcon('check')}<span>${completableCount ? `完成 ${completableCount} 项` : '完成'}</span>`;
  doneButton.title = count > completableCount ? '已完成或已归档任务将自动跳过' : '';
  $('#batch-pri').disabled = batchBusy || count === 0;
  $('#batch-delete').disabled = batchBusy || count === 0;
  $('#batch-clear').disabled = batchBusy;
  const selectAll = $('#batch-select-all');
  const allSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((id) => selectedIds.has(id));
  selectAll.disabled = batchBusy || visibleTaskIds.length === 0;
  selectAll.textContent = allSelected ? '取消全选' : '全选当前';
}

function setBatchBusy(busy, message, control) {
  if (batchBusyControl && batchBusyControl.setAttribute) batchBusyControl.setAttribute('aria-busy', 'false');
  batchBusy = busy;
  batchBusyMessage = busy ? message : '';
  batchBusyControl = busy ? control : null;
  if (batchBusyControl && batchBusyControl.setAttribute) batchBusyControl.setAttribute('aria-busy', 'true');
  renderBatchBar();
}

async function runBatchMutation(options) {
  const ids = options.ids;
  if (batchBusy || !ids.length) return false;
  setBatchBusy(true, options.busyMessage, options.control);
  try {
    const result = await options.action(ids);
    setBatchMode(false, false);
    toast(typeof options.successMessage === 'function' ? options.successMessage(result) : options.successMessage, 3500, null, 'ok');
    await refreshTasksAfterMutation(options.refreshFailureMessage);
    return true;
  } catch (error) {
    console.error('[batch] operation failed:', error);
    if (options.rethrow) throw error;
    toast('批量操作失败，当前选择已保留，请重试', 4000, null, 'err');
    return false;
  } finally {
    setBatchBusy(false, '', null);
  }
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
    boardTasks.filter((task) => task.status === col.k).sort(compareTaskOrder)
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
          <div class="bc-card-item" role="listitem" data-id="${t.id}">
            <button type="button" class="bc-card" draggable="true" data-id="${t.id}" title="编辑任务" aria-label="编辑任务：${esc(t.title)}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
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

function setBoardBusyState(busy, activeControl) {
  const board = $('#board-cols');
  if (!board) return;
  board.setAttribute('aria-busy', String(busy));
  const controls = Array.from(board.querySelectorAll?.('.bc-card, .bc-status, #board-new-task') || []);
  if (activeControl && !controls.includes(activeControl)) controls.push(activeControl);
  controls.forEach((control) => {
    control.disabled = busy;
    if (control.matches?.('.bc-card')) control.draggable = !busy;
    control.setAttribute?.('aria-busy', String(busy && control === activeControl));
  });
}

function clearBoardDropFeedback() {
  $$('#board-cols .board-col').forEach((column) => column.classList.remove('col-drop'));
  $$('#board-cols .bc-card-item').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
}

function showBoardDropFeedback(column, targetCard, before) {
  clearBoardDropFeedback();
  if (!column) return;
  column.classList.add('col-drop');
  if (!boardDragState || boardDragState.status !== column.dataset.col || !targetCard) return;
  if (String(targetCard.dataset.id) === String(boardDragState.id)) return;
  targetCard.closest('.bc-card-item')?.classList.add(before ? 'drop-before' : 'drop-after');
}

async function moveBoardTask(id, targetStatus, trigger) {
  const task = tasks.find((item) => item.id === parseInt(id, 10));
  if (!task || !BOARD_COLUMNS.some((column) => column.k === targetStatus)) return false;
  if (task.status === targetStatus) return true;
  if (boardMutationBusy) {
    if (trigger) trigger.value = task.status;
    return false;
  }
  boardMutationBusy = true;
  setBoardBusyState(true, trigger);
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
    boardMutationBusy = false;
    setBoardBusyState(false, trigger);
  }
}

function reorderedTaskId(item) {
  if (!item) return null;
  const value = item.dataset?.id || item.querySelector?.('[data-id]')?.dataset.id;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function focusReorderedTask(scope, taskId) {
  if (!Number.isFinite(taskId)) return false;
  const selector = scope === 'board'
    ? `#board-cols .bc-card[data-id="${taskId}"]`
    : `#tasks-list .task-row[data-id="${taskId}"] .task-title-btn`;
  const target = document.querySelector(selector);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

async function commitTaskOrder(order, item, surface, scope, successMessage, refreshFailureMessage) {
  const isBoard = scope === 'board';
  if (isBoard ? boardMutationBusy : taskReorderBusy) return false;
  if (isBoard) boardMutationBusy = true;
  else taskReorderBusy = true;
  const taskId = reorderedTaskId(item);
  if (isBoard) setBoardBusyState(true);
  else if (surface) surface.setAttribute('aria-busy', 'true');
  if (item) item.classList.add('reorder-commit');
  try {
    await window.api.tasks.reorder(order);
    toast(successMessage, 2500, null, 'ok');
    await refreshTasksAfterMutation(refreshFailureMessage);
    focusReorderedTask(scope, taskId);
    return true;
  } catch (error) {
    console.error(`[${scope}] task reorder failed:`, error);
    if (item) {
      item.classList.remove('reorder-commit');
      playTransientClass(item, 'reorder-error', MOTION_MS.slow);
    }
    toast('顺序未保存，任务仍在原位置', 3500, null, 'err');
    return false;
  } finally {
    if (item) item.classList.remove('reorder-commit');
    if (isBoard) boardMutationBusy = false;
    else taskReorderBusy = false;
    if (isBoard) setBoardBusyState(false);
    else if (surface) surface.setAttribute('aria-busy', 'false');
  }
}

async function reorderTaskByKeyboard(scope, taskId, delta) {
  const isBoard = scope === 'board';
  if ((isBoard && boardMutationBusy) || (!isBoard && taskReorderBusy)) return false;
  const item = isBoard
    ? document.querySelector(`#board-cols .bc-card-item[data-id="${taskId}"]`)
    : document.querySelector(`#tasks-list .task-row[data-id="${taskId}"]`);
  if (!item) return false;
  const peers = isBoard
    ? Array.from(item.closest('.board-col').querySelectorAll('.bc-card-item[data-id]'))
    : Array.from($('#tasks-list').querySelectorAll('.task-row[data-id]'));
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
    isBoard ? $('#board-cols') : $('#tasks-list'),
    scope,
    delta < 0 ? '已上移任务' : '已下移任务',
    '顺序已保存，但界面刷新失败'
  );
}

function onTaskReorderKeyDown(event, scope) {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const control = scope === 'board'
    ? event.target.closest('.bc-card')
    : event.target.closest('.task-title-btn');
  if (!control) return;
  const item = control.closest(scope === 'board' ? '.bc-card-item' : '.task-row');
  if (!item) return;
  event.preventDefault();
  reorderTaskByKeyboard(scope, Number(item.dataset.id), event.key === 'ArrowUp' ? -1 : 1);
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
function renderCal(direction = 0, selectionChanged = false) {
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
      <button type="button" class="cal-btn" data-cal="prev" title="上个月" aria-label="上个月">${uiIcon('chevron-left')}</button>
      <button type="button" class="cal-btn" data-cal="today" title="回到本月" aria-label="回到本月">今</button>
      <button type="button" class="cal-btn" data-cal="next" title="下个月" aria-label="下个月">${uiIcon('chevron-right')}</button>
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
    html += `<div class="cal-add-row"><button type="button" class="btn mini" id="cal-add-task">${uiIcon('plus')}<span>在该天新建任务</span></button></div>`;
    html += selTasks.length ? selTasks.map(rowHTML).join('') : `<div class="empty compact"><div class="big" aria-hidden="true">${uiIcon('today')}</div><div class="empty-title">当天没有到期任务</div></div>`;
    html += '</section>';
  }

  $('#cal-body').innerHTML = html;
  $('#cal-sub').textContent = calSelected ? `${calSelected} 明细` : `${m + 1} 月 · ${daysInMonth} 天`;
  if (direction) {
    playTransientClass($('#cal-body .cal-grid'), direction < 0 ? 'cal-shift-prev' : 'cal-shift-next', MOTION_MS.base);
  }
  if (selectionChanged) playTransientClass($('#cal-body .cal-detail'), 'cal-detail-enter', MOTION_MS.fast);
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

function dailyReportFileName(dayOffset) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `工作日报-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

function clearReportPreview() {
  $('#report-preview').textContent = '';
  $('#report-preview').classList.add('hidden');
  $('#btn-report-copy').classList.add('hidden');
  $('#btn-report-download').classList.add('hidden');
}

function beginReportAction(button, busyLabel) {
  if (reportActionBusy || !button) return null;
  const panel = button.closest('.report-panel');
  if (!panel) return null;
  const actions = panel.querySelector('.report-actions');
  const weekGroup = panel.querySelector('#report-week-seg');
  const controls = Array.from(panel.querySelectorAll('#report-period-seg .seg-it, #report-week-seg .seg-it, #report-day-seg .seg-it, #btn-report-gen, #btn-report-copy, #btn-report-download'));
  const states = controls.map((control) => ({ control, disabled: control.disabled }));
  const originalContent = button.innerHTML;
  reportActionBusy = true;
  actions?.setAttribute('aria-busy', 'true');
  weekGroup?.setAttribute('aria-busy', 'true');
  controls.forEach((control) => { control.disabled = true; });
  button.setAttribute('aria-busy', 'true');
  setButtonContent(button, busyLabel);
  return () => {
    states.forEach(({ control, disabled }) => {
      if (control.isConnected !== false) control.disabled = disabled;
    });
    if (button.isConnected !== false) {
      button.setAttribute('aria-busy', 'false');
      button.innerHTML = originalContent;
    }
    actions?.setAttribute('aria-busy', 'false');
    weekGroup?.setAttribute('aria-busy', 'false');
    reportActionBusy = false;
  };
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
      <div class="big" aria-hidden="true">${uiIcon('stat')}</div>
      <div class="empty-title">还没有任务数据</div>
      <button type="button" class="btn mini" id="stat-new-task">新建任务</button>
    </div>`;
  } else {
    html = `<dl class="stat-grid">
      <div class="stat-card total"><dt class="sc-t">任务总数</dt><dd class="sc-v">${all.length}</dd></div>
      <div class="stat-card done"><dt class="sc-t">已完成</dt><dd class="sc-v">${done}</dd></div>
      <div class="stat-card doing"><dt class="sc-t">进行中</dt><dd class="sc-v">${doing}</dd></div>
      <div class="stat-card rate"><dt class="sc-t">完成率</dt><dd class="sc-v">${rate}</dd></div>
    </dl>`;
  // 近 7 天完成趋势（按真实 completedAt 统计）
  const maxTrend = Math.max(1, ...trend);
    html += `<div class="stat-chart-row">
    <section class="stat-panel">
      <h3 class="stat-panel-title">近 7 天完成趋势</h3>
      ${recentDone ? `<div class="trend-chart" role="list" aria-label="近 7 天完成数量">
        ${trend.map((v, i) => `
          <div class="trend-column${i === trend.length - 1 ? ' today' : ''}" role="listitem" aria-label="${days[i]} 完成 ${v} 项">
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
              <span class="metric-name project-name" title="${esc(d.name)}">${uiIcon('folder')}<span>${esc(d.name)}</span></span>
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

  // 日报/周报生成
  html += `<section class="report-panel">
      <h3 class="stat-panel-title">工作报告</h3>
      <div class="report-actions">
        <div class="seg" id="report-period-seg" role="radiogroup" aria-label="报告类型">
          <button type="button" role="radio" aria-checked="${reportPeriod === 'daily'}" class="seg-it ${reportPeriod === 'daily' ? 'active' : ''}" data-period="daily">日报</button>
          <button type="button" role="radio" aria-checked="${reportPeriod === 'weekly'}" class="seg-it ${reportPeriod === 'weekly' ? 'active' : ''}" data-period="weekly">周报</button>
        </div>
        <div class="seg" id="report-week-seg" role="radiogroup" aria-label="周报周期">
          <button type="button" role="radio" aria-checked="${reportWeek === -1}" class="seg-it ${reportWeek === -1 ? 'active' : ''}" data-week="-1">上周</button>
          <button type="button" role="radio" aria-checked="${reportWeek === 0}" class="seg-it ${reportWeek === 0 ? 'active' : ''}" data-week="0">本周</button>
          <button type="button" role="radio" aria-checked="${reportWeek === 1}" class="seg-it ${reportWeek === 1 ? 'active' : ''}" data-week="1">下周</button>
        </div>
        <div class="seg hidden" id="report-day-seg" role="radiogroup" aria-label="日报日期">
          <button type="button" role="radio" aria-checked="${reportDay === -1}" class="seg-it ${reportDay === -1 ? 'active' : ''}" data-day="-1">昨天</button>
          <button type="button" role="radio" aria-checked="${reportDay === 0}" class="seg-it ${reportDay === 0 ? 'active' : ''}" data-day="0">今天</button>
          <button type="button" role="radio" aria-checked="${reportDay === 1}" class="seg-it ${reportDay === 1 ? 'active' : ''}" data-day="1">明天</button>
        </div>
        <button type="button" class="btn mini icon-text" id="btn-report-gen">${uiIcon('file-text')}<span>生成周报</span></button>
        <button type="button" class="btn mini ghost icon-text hidden" id="btn-report-copy">${uiIcon('copy')}<span>复制</span></button>
        <button type="button" class="btn mini ghost icon-text hidden" id="btn-report-download">${uiIcon('download')}<span>下载 .md</span></button>
      </div>
      <div id="report-preview" class="report-preview hidden" role="region" aria-label="周报预览" tabindex="0" data-report-label="工作报告预览"></div>
  </section>`;

  $('#stat-body').innerHTML = html;
  $('#stat-new-task')?.addEventListener('click', () => openModal(null));

  const syncReportPeriod = () => {
    const weekly = reportPeriod === 'weekly';
    $('#report-week-seg').classList.toggle('hidden', !weekly);
    $('#report-day-seg').classList.toggle('hidden', weekly);
    $('#btn-report-gen').querySelector('span').textContent = weekly ? '生成周报' : '生成日报';
  };
  $$('#report-period-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', () => {
      if (reportActionBusy) return;
      reportPeriod = seg.dataset.period === 'daily' ? 'daily' : 'weekly';
      $$('#report-period-seg .seg-it').forEach((item) => {
        const active = item === seg;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
      clearReportPreview();
      syncReportPeriod();
    });
  });
  bindRadioGroupKeyboard($('#report-period-seg'));
  // 周报：选择周
  $$('#report-week-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', () => {
      if (reportActionBusy) return;
      $$('#report-week-seg .seg-it').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
      });
      seg.classList.add('active');
      seg.setAttribute('aria-checked', 'true');
      reportWeek = parseInt(seg.dataset.week, 10);
      clearReportPreview();
    });
  });
  bindRadioGroupKeyboard($('#report-week-seg'));
  $$('#report-day-seg .seg-it').forEach((seg) => {
    seg.addEventListener('click', () => {
      if (reportActionBusy) return;
      $$('#report-day-seg .seg-it').forEach((item) => {
        const active = item === seg;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
      reportDay = parseInt(seg.dataset.day, 10);
      clearReportPreview();
    });
  });
  bindRadioGroupKeyboard($('#report-day-seg'));
  syncReportPeriod();
  // 报告：生成
  $('#btn-report-gen').addEventListener('click', async () => {
    const preview = $('#report-preview');
    const copyBtn = $('#btn-report-copy');
    const dlBtn = $('#btn-report-download');
    const generateBtn = $('#btn-report-gen');
    const requestedWeek = reportWeek;
    const requestedPeriod = reportPeriod;
    const requestedOffset = requestedPeriod === 'weekly' ? reportWeek : reportDay;
    const release = beginReportAction(generateBtn, '生成中…');
    if (!release) return;
    let restoreFocus = false;
    try {
      const label = requestedPeriod === 'weekly'
        ? (requestedOffset === -1 ? '上周周报' : requestedOffset === 1 ? '下周周报' : '本周周报')
        : (requestedOffset === -1 ? '昨天日报' : requestedOffset === 1 ? '明天日报' : '今日日报');
      const result = await window.api.ai.report({
        period: requestedPeriod,
        offset: requestedOffset,
        instruction: `生成${label}`
      }, `report-panel-${Date.now()}`);
      if (!result || result.cancelled || result.type !== 'report' || !result.markdown) {
        throw new Error(result && result.message || '报告没有生成完整内容');
      }
      preview.textContent = result.markdown;
      preview.classList.remove('hidden');
      copyBtn.classList.remove('hidden');
      dlBtn.classList.remove('hidden');
      preview.focus({ preventScroll: true });
      preview.scrollIntoView({ block: 'nearest' });
      toast(result.degraded ? '已生成本地事实版报告' : `${requestedPeriod === 'weekly' ? '周报' : '日报'}已由 Agent 生成`, 3000, null, result.degraded ? 'warn' : 'ok');
    } catch (e) {
      console.error('[report] generation failed:', e);
      if (requestedPeriod === 'weekly') toast('周报生成失败，请稍后重试', 3000, null, 'err');
      else toast('日报生成失败，请稍后重试', 3000, null, 'err');
      restoreFocus = true;
    } finally {
      release();
      if (restoreFocus) generateBtn.focus({ preventScroll: true });
    }
  });
  // 报告：复制
  $('#btn-report-copy').addEventListener('click', async () => {
    const md = $('#report-preview').textContent;
    const copyBtn = $('#btn-report-copy');
    const release = beginReportAction(copyBtn, '复制中…');
    if (!release) return;
    try {
      await navigator.clipboard.writeText(md);
      release();
      setButtonContent(copyBtn, '已复制', 'check');
      setTimeout(() => { if (copyBtn.isConnected) setButtonContent(copyBtn, '复制', 'copy'); }, FEEDBACK_HOLD_MS);
      toast('报告已复制到剪贴板', 2000, null, 'ok');
    } catch (e) {
      release();
      copyBtn.focus({ preventScroll: true });
      toast('复制失败，请手动选择复制', 3000, null, 'err');
    }
  });
  // 报告：下载 .md
  $('#btn-report-download').addEventListener('click', () => {
    const md = $('#report-preview').textContent;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    if (reportPeriod === 'weekly') a.download = weeklyReportFileName(reportWeek);
    else a.download = dailyReportFileName(reportDay);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast('报告已下载');
  });
}

/* ---------- 视图：设置 ---------- */
function renderSettings() {
  const s = settings;
  const copilot = workflowState.copilot || { enabled: true, quietStart: '20:00', quietEnd: '08:00' };
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
      <div><div class="sr-t">主动工作建议</div><div class="sr-d">只在今日页展示一条建议；所有修改仍需点击确认</div></div>
      <button type="button" class="switch ${copilot.enabled !== false ? 'on' : ''}" id="copilot-enabled" role="switch" aria-checked="${copilot.enabled !== false}" aria-label="主动工作建议" data-settings-scope="copilot"></button>
    </div>
    <div class="set-row copilot-settings-row">
      <div><div class="sr-t">安静时段</div><div class="sr-d" id="copilot-quiet-desc">这段时间不主动显示晨间简报或工作建议</div></div>
      <div class="quiet-time-controls" aria-describedby="copilot-quiet-desc">
        <label><span>开始</span><input id="copilot-quiet-start" type="time" value="${esc(copilot.quietStart || '20:00')}" data-settings-scope="copilot"></label>
        <label><span>结束</span><input id="copilot-quiet-end" type="time" value="${esc(copilot.quietEnd || '08:00')}" data-settings-scope="copilot"></label>
        <button type="button" class="btn mini ghost" id="btn-copilot-save" data-settings-scope="copilot">保存</button>
      </div>
    </div>
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
      <button type="button" class="btn mini danger icon-text" id="btn-reset">${uiIcon('refresh')}<span>重置任务</span></button>
    </div>
    <div class="set-row">
      <div><div class="sr-t">清空全部任务</div><div class="sr-d">删除所有任务（含已完成与归档），备忘录不受影响</div></div>
      <button type="button" class="btn mini danger icon-text" id="btn-clear-all">${uiIcon('trash')}<span>清空任务</span></button>
    </div>
  </section>`;

  $('#settings-body').innerHTML = html;
  bindSettingsEvents();
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

  $('#copilot-enabled')?.addEventListener('click', async (event) => {
    const control = event.currentTarget;
    const previous = control.classList.contains('on');
    const enabled = !previous;
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
    try {
      dailyCopilot = await window.api.workflow.updateCopilot({ action: 'preferences', enabled });
      workflowState.copilot = dailyCopilot.preferences;
      control.classList.toggle('on', enabled);
      control.setAttribute('aria-checked', String(enabled));
      renderDailyCopilot();
      toast(enabled ? '已开启主动工作建议' : '已关闭主动工作建议');
    } catch (error) {
      control.classList.toggle('on', previous);
      control.setAttribute('aria-checked', String(previous));
      toast('主动建议设置保存失败', 3500, null, 'err');
    } finally {
      control.disabled = false;
      control.setAttribute('aria-busy', 'false');
    }
  });

  $('#btn-copilot-save')?.addEventListener('click', () => {
    const button = $('#btn-copilot-save');
    runSettingsAction(button, '保存中…', async () => {
      const quietStart = $('#copilot-quiet-start').value;
      const quietEnd = $('#copilot-quiet-end').value;
      if (!quietStart || !quietEnd || quietStart === quietEnd) throw new Error('安静时段的开始和结束时间不能相同');
      dailyCopilot = await window.api.workflow.updateCopilot({ action: 'preferences', quietStart, quietEnd });
      workflowState.copilot = dailyCopilot.preferences;
      renderDailyCopilot();
      toast(`安静时段已设为 ${quietStart}-${quietEnd}`);
      return true;
    }, '安静时段保存失败，请检查时间', 'copilot');
  });

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
      const keyMap = { 'sc-ai': 'ai', 'sc-newTask': 'newTask', 'sc-today': 'today', 'sc-stat': 'stat' };
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
  copyButton.innerHTML = uiIcon('copy');
  copyButton.dataset.tooltip = '复制';
  copyButton.disabled = memoActionBusy;
  $('#memo-title').value = memo.title;
  $('#memo-content').value = memo.content || '';
  $('#memo-tags').value = (memo.tags || []).join(' ');
  $('#memo-pin').classList.toggle('active', !!memo.pinned);
  $('#memo-pin').setAttribute('aria-pressed', String(!!memo.pinned));
  $('#memo-pin').setAttribute('aria-label', memo.pinned ? '取消置顶备忘录' : '置顶备忘录');
  $('#memo-pin').dataset.tooltip = memo.pinned ? '取消置顶' : '置顶';
  setMemoSaveState('saved', '已保存');
  $('#memo-updated').textContent = `最近编辑 ${memoTime(memo.updatedAt)}`;
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
    if (restoreFocus && currentView === 'memos' && nextControl && !nextControl.disabled) {
      nextControl.focus({ preventScroll: true });
    }
  };
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
  if (!memoDirty && memoSavePending === 0) renderMemoEditor();
}

function setMemoSaveState(state, label) {
  const element = $('#memo-save-state');
  element.dataset.state = state;
  element.textContent = label;
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
  if (memoCreating) return false;
  memoCreating = true;
  const createButtons = [$('#memo-new'), $('#memo-empty-new')].filter(Boolean);
  createButtons.forEach((button) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  });
  try {
    if ((await saveMemoNow()) === false) return false;
    const memo = await window.api.memos.create({ title: '无标题备忘录', content: '', tags: [] });
    memos.unshift(memo);
    selectedMemoId = memo.id;
    memoFocusId = memo.id;
    renderMemos();
    $('#memo-title').select();
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
function switchView(view) {
  const previousView = currentView;
  const content = $('.content');
  if (previousView === view) return;
  if (currentView === 'memos' && view !== 'memos') saveMemoNow();
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
  // 切换视图时退出批量模式，避免隐藏选择残留。
  setBatchMode(false, false);
  // 视图切换动画
  const activeView = document.getElementById(`view-${view}`);
  playTransientClass(activeView, 'view-enter', MOTION_MS.base);
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
  btn.innerHTML = uiIcon(maximized ? 'copy' : 'square');
  btn.title = maximized ? '还原' : '最大化';
  btn.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口');
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
  $('#m-agent').classList.toggle('hidden', !task);
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
  $('#m-estimate').value = task && task.estimatedMinutes ? String(task.estimatedMinutes) : '';
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
  showModalMask(mask);
  $('#m-title').focus();
}

function refreshOpenTaskModal(task) {
  if (!editingTask || !task || editingTask.id !== task.id) return;
  editingTask = task;
  $('#m-title').value = task.title;
  $('#m-desc').value = task.desc || '';
  $('#m-pri').value = String(task.pri);
  $('#m-status').value = task.status;
  const due = splitDue(task.due);
  $('#m-due-date').value = due.date;
  $('#m-due-time').value = due.time;
  $('#m-tags').value = (task.tags || []).join(', ');
  $('#m-project').value = task.project || '';
  $('#m-repeat').value = task.repeat || '';
  $('#m-remind').value = String(task.remind || 30);
  $('#m-estimate').value = task.estimatedMinutes ? String(task.estimatedMinutes) : '';
  $('#m-children').value = (task.children || []).map((child) => {
    const item = childLabel(child);
    return `${item.done ? '[x]' : '[ ]'} ${item.title}`;
  }).join('\n');
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
    estimatedMinutes: $('#m-estimate').value ? parseInt($('#m-estimate').value, 10) : null,
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
        await Promise.all([refreshTasks(), refreshMemos(), refreshWorkflow()]);
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
  const sourceLabels = { task: '任务', worklog: '记录', plan: '计划', focus: '专注', review: '复盘' };

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
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn mini ghost icon-text';
  open.append(uiIconElement('stat'), Object.assign(document.createElement('span'), { textContent: '打开统计' }));
  open.addEventListener('click', () => {
    reportPeriod = result.reportPeriod === 'daily' ? 'daily' : 'weekly';
    if (reportPeriod === 'daily') reportDay = Number(result.reportOffset) || 0;
    else reportWeek = Number(result.reportOffset) || 0;
    switchView('stats');
    setTimeout(() => {
      const preview = $('#report-preview');
      if (!preview) return;
      preview.textContent = String(result.markdown || '');
      preview.classList.remove('hidden');
      $('#btn-report-copy')?.classList.remove('hidden');
      $('#btn-report-download')?.classList.remove('hidden');
      preview.focus({ preventScroll: true });
    }, 0);
  });
  actions.append(sourceToggle, copy, download, open);
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
  if (message && activeAiRequest.pending && !reasoningDelta && !progress.reasoningDone) {
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
      setAssistantMessageState(pending, 'error', '请求未完成');
      pending.querySelector('.msg-text').textContent = assistantRequestFailureMessage();
      pending.appendChild(retryAction(retry, options && options.draft));
      setAiContext('error');
      if (settings.aiStage === 'llm') setAiRuntimeState('degraded', assistantRequestFailureMessage());
      return;
    }

    try {
      const operationTypes = ['create', 'memo_create', 'memo_delete', 'memo_pin', 'memo_to_task', 'memo_split', 'complete', 'start', 'delete', 'archive', 'split', 'update', 'child', 'postpone', 'restore', 'plan', 'daily_plan', 'daily_replan', 'focus_start', 'focus_pause', 'focus_resume', 'focus_interrupt', 'focus_finish', 'daily_review'];
      const reportTypes = ['report'];
      pending.classList.remove('pending', 'error');
      pending.querySelector('.msg-text').textContent = result.message;
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
      if (operationTypes.includes(result.type)) await refreshWorkflow();

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
  switchView('tasks');
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
  $('#daily-copilot').addEventListener('click', handleDailyCopilotAction);
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
  $('#workflow-panel').addEventListener('click', handleWorkflowAction);
  $('#workflow-panel').addEventListener('change', handleWorkflowAction);
  $('#workflow-panel').addEventListener('input', (event) => {
    if (event.target && event.target.id === 'workflow-smart-input') workflowSmartText = event.target.value;
  });
  $('#today-list').addEventListener('click', onTaskClick);
  $('#tasks-list').addEventListener('click', onTaskClick);
  $('#cal-body').addEventListener('click', onCalClick);
  $('#cal-body').addEventListener('keydown', onCalKeyDown);
  ['today-list', 'tasks-list', 'cal-body'].forEach((id) => {
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
    const item = event.target.closest('[data-memo-id]');
    if (item) selectMemo(parseInt(item.dataset.memoId, 10), true);
  });
  $('#memo-list').addEventListener('keydown', onMemoListKeyDown);
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
      if ((await saveMemoNow()) === false) return;
      setMemoSaveState('saving', '复制中…');
      const memo = currentMemo();
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
      const task = await window.api.tasks.create({ title: memo.title, desc: memo.content, tags: memo.tags || [], pri: 2, status: 'todo' });
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
        await window.api.memos.remove(memo.id);
        memos = memos.filter((item) => item.id !== memo.id);
        selectedMemoId = memos.length ? memos[0].id : null;
        memoFocusId = selectedMemoId;
        deletedMemos = await window.api.memos.getDeleted();
        renderMemos();
        renderNavBadges();
        toast('备忘录已移到回收站', 3000, null, 'ok');
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
  $('#btn-select-mode').addEventListener('click', () => setBatchMode(!batchMode));

  // 看板拖拽
  $('#board-cols').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.bc-card');
    if (!card) return;
    if (boardMutationBusy) { e.preventDefault(); return; }
    const task = tasks.find((item) => item.id === Number(card.dataset.id));
    if (!task) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    boardDragState = { id: task.id, status: task.status };
    card.closest('.bc-card-item').classList.add('dragging');
  });
  $('#board-cols').addEventListener('dragend', (e) => {
    const card = e.target.closest('.bc-card');
    if (card) card.closest('.bc-card-item').classList.remove('dragging');
    boardDragState = null;
    clearBoardDropFeedback();
  });
  $('#board-cols').addEventListener('dragover', (e) => {
    if (!boardDragState || boardMutationBusy) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const col = e.target.closest('.board-col');
    const targetCard = e.target.closest('.bc-card');
    let before = true;
    if (targetCard) {
      const rect = targetCard.getBoundingClientRect();
      before = e.clientY < rect.top + rect.height / 2;
    }
    showBoardDropFeedback(col, targetCard, before);
  });
  $('#board-cols').addEventListener('dragleave', (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) clearBoardDropFeedback();
  });
  $('#board-cols').addEventListener('drop', async (e) => {
    e.preventDefault();
    const col = e.target.closest('.board-col');
    const id = e.dataTransfer.getData('text/plain');
    clearBoardDropFeedback();
    boardDragState = null;
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
        const movedItem = document.querySelector(`#board-cols .bc-card[data-id="${id}"]`)?.closest('.bc-card-item');
        await commitTaskOrder(cardIds, movedItem, board, 'board', '已调整卡片顺序', '顺序已保存，但看板刷新失败');
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
  $('#board-cols').addEventListener('keydown', (e) => onTaskReorderKeyDown(e, 'board'));

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
    await commitTaskOrder(rows, movedRow, $('#tasks-list'), 'list', '已调整任务顺序', '顺序已保存，但列表刷新失败');
  });
  $('#tasks-list').addEventListener('keydown', (e) => onTaskReorderKeyDown(e, 'list'));

  // 批量操作
  $('#batch-select-all').addEventListener('click', () => {
    if (batchBusy) return;
    const allSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((id) => selectedIds.has(id));
    selectedIds = allSelected ? new Set() : new Set(visibleTaskIds);
    renderTasks();
  });
  $('#batch-done').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    await runBatchMutation({
      ids,
      control: $('#batch-done'),
      busyMessage: `正在完成 ${ids.length} 项…`,
      action: (selected) => window.api.tasks.batchComplete(selected),
      successMessage: (result) => {
        const generated = result.generated && result.generated.length;
        const detail = [
          result.skipped ? `跳过 ${result.skipped} 项` : '',
          generated ? `已安排 ${generated} 个下次任务` : ''
        ].filter(Boolean).join(' · ');
        return `已完成 ${result.completed} 项任务${detail ? ' · ' + detail : ''}`;
      },
      refreshFailureMessage: '批量完成已保存，但列表刷新失败'
    });
  });
  $('#batch-delete').addEventListener('click', async () => {
    if (batchBusy) return;
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    confirmDialog(`确定删除选中的 ${ids.length} 项任务吗？`, async () => {
      await runBatchMutation({
        ids,
        control: $('#batch-delete'),
        busyMessage: `正在删除 ${ids.length} 项…`,
        action: (selected) => window.api.tasks.batchDelete(selected),
        successMessage: `已删除 ${ids.length} 项任务`,
        refreshFailureMessage: '批量删除已完成，但列表刷新失败',
        rethrow: true
      });
    });
  });
  $('#batch-pri').addEventListener('change', async () => {
    const pri = parseInt($('#batch-pri').value, 10);
    if (!pri) return;
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const changed = await runBatchMutation({
      ids,
      control: $('#batch-pri'),
      busyMessage: `正在更新 ${ids.length} 项…`,
      action: (selected) => window.api.tasks.batchUpdate(selected, { pri }),
      successMessage: `已更新 ${ids.length} 项任务优先级`,
      refreshFailureMessage: '优先级已更新，但列表刷新失败'
    });
    if (changed) $('#batch-pri').value = '';
  });
  $('#batch-clear').addEventListener('click', () => { if (!batchBusy) setBatchMode(false); });

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
    const panel = $('#ai-panel');
    const collapsed = panel.classList.toggle('collapsed');
    syncAiCollapseControl(collapsed);
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
  $('#m-agent').addEventListener('click', (event) => {
    if (editingTask) openTaskAgent(editingTask, event.currentTarget);
  });
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
    if (!$('#task-agent-popover').classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestCloseModal();
    }
    if (e.key === 'Tab') trapFocus($('#modal-mask'), e);
  });

  $('#task-agent-form').addEventListener('submit', submitTaskAgent);
  $('#task-agent-close').addEventListener('click', () => closeTaskAgent());
  $('#task-agent-cancel').addEventListener('click', () => closeTaskAgent());
  $('.task-agent-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-agent-prompt]');
    if (!chip || taskAgentState.busy) return;
    $('#task-agent-input').value = chip.dataset.agentPrompt;
    resetTaskAgentPreview();
    setTaskAgentStatus('快捷指令已填入，生成预览后再确认。');
    $('#task-agent-form').requestSubmit();
  });
  $('#task-agent-input').addEventListener('input', () => {
    if (taskAgentState.previewId) resetTaskAgentPreview();
    setTaskAgentStatus('先生成预览，确认后才会修改任务。');
  });
  document.addEventListener('click', (event) => {
    if ($('#task-agent-popover').classList.contains('hidden')) return;
    if (event.target.closest('#task-agent-popover, .task-agent-btn, [data-worklog-add], [data-worklog-edit], #m-agent')) return;
    closeTaskAgent(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || $('#task-agent-popover').classList.contains('hidden')) return;
    event.preventDefault();
    event.stopPropagation();
    closeTaskAgent();
  }, true);
  window.addEventListener('resize', () => {
    if (!$('#task-agent-popover').classList.contains('hidden')) positionTaskAgent(taskAgentState.trigger);
  });

  // 主进程事件
  window.api.on('app:new-task', () => { switchView('tasks'); openModal(null); });
  window.api.on('app:focus-ai', () => {
    const panel = $('#ai-panel');
    panel.classList.remove('collapsed');
    syncAiCollapseControl(false);
    $('#ai-input').focus();
  });
  window.api.on('app:switch-view', (view) => {
    if (['today', 'tasks', 'memos', 'board', 'cal', 'stat', 'settings', 'trash'].includes(view)) switchView(view);
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
  window.api.on('workflow:changed', (state) => {
    workflowState = state || workflowState;
    renderWorkflowPanel();
    refreshDailyCopilot();
  });

  // 应用内快捷键（不抢输入框焦点）
  document.addEventListener('keydown', async (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // 1/2/3/4 快速改优先级（选中任务时）
    if (selectedIds.size && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      const pri = parseInt(e.key, 10);
      const ids = Array.from(selectedIds);
      await runBatchMutation({
        ids,
        control: $('#batch-pri'),
        busyMessage: `正在更新 ${ids.length} 项…`,
        action: (selected) => window.api.tasks.batchUpdate(selected, { pri }),
        successMessage: `已更新 ${ids.length} 项任务为${PRI_NAME[pri]}优先级`,
        refreshFailureMessage: '优先级已更新，但列表刷新失败'
      });
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

function positionTaskAgent(trigger) {
  const popover = $('#task-agent-popover');
  if (!popover || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(390, window.innerWidth - 24);
  popover.style.width = `${width}px`;
  const measured = popover.getBoundingClientRect();
  let left = Math.min(rect.right - width, window.innerWidth - width - 12);
  left = Math.max(12, left);
  let top = rect.bottom + 8;
  if (top + measured.height > window.innerHeight - 12) top = Math.max(12, rect.top - measured.height - 8);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function setTaskAgentBusy(busy, label) {
  taskAgentState.busy = busy;
  const popover = $('#task-agent-popover');
  popover.setAttribute('aria-busy', String(busy));
  $('#task-agent-input').disabled = busy;
  $$('.task-agent-chip').forEach((button) => { button.disabled = busy; });
  $('#task-agent-submit').disabled = busy;
  if (label) $('#task-agent-submit').textContent = label;
}

function resetTaskAgentPreview() {
  taskAgentState.previewId = null;
  $('#task-agent-preview').classList.add('hidden');
  $('#task-agent-preview').replaceChildren();
  $('#task-agent-submit').textContent = '生成预览';
}

function setTaskAgentStatus(message, kind) {
  const status = $('#task-agent-status');
  status.textContent = message || '';
  status.classList.toggle('error', kind === 'error');
  status.classList.toggle('notice', kind === 'notice');
}

function openTaskAgent(task, trigger, options) {
  if (!task || task.status === 'archived') return;
  const popover = $('#task-agent-popover');
  if (!popover.classList.contains('hidden')) closeTaskAgent(false);
  closeTaskMenus(false);
  const currentTrigger = taskAgentState.trigger;
  if (currentTrigger && currentTrigger !== trigger) currentTrigger.setAttribute('aria-expanded', 'false');
  const workLog = options && options.workLog || null;
  taskAgentState = { sessionId: ++taskAgentSessionSequence, taskId: task.id, trigger, previewId: null, busy: false, requestId: null, previousAction: null, previousText: '', turns: [], workLogId: workLog && workLog.id || '', workLogKind: workLog && workLog.kind || '' };
  trigger.setAttribute('aria-expanded', 'true');
  $('#task-agent-title').textContent = workLog ? `编辑记录 · ${task.title}` : task.title;
  $('#task-agent-input').value = workLog ? workLog.text : String(options && options.draft || '');
  $('#task-agent-thread').replaceChildren();
  $('#task-agent-thread').classList.add('hidden');
  setTaskAgentStatus('先生成预览，确认后才会修改任务。');
  resetTaskAgentPreview();
  setTaskAgentBusy(false, '生成预览');
  popover.classList.remove('hidden');
  positionTaskAgent(trigger);
  const input = $('#task-agent-input');
  input.focus({ preventScroll: true });
  const inputLength = input.value.length;
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(inputLength, inputLength);
}

function closeTaskAgent(restoreFocus = true) {
  const popover = $('#task-agent-popover');
  if (popover.classList.contains('hidden')) return;
  if (taskAgentState.busy && taskAgentState.requestId) window.api.ai.cancel(taskAgentState.requestId).catch(() => {});
  const trigger = taskAgentState.trigger;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  setTaskAgentBusy(false, '生成预览');
  popover.classList.add('hidden');
  taskAgentState = { sessionId: 0, taskId: null, trigger: null, previewId: null, busy: false, requestId: null, previousAction: null, previousText: '', turns: [], workLogId: '', workLogKind: '' };
  if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
}

function renderTaskAgentPreview(result) {
  const preview = $('#task-agent-preview');
  preview.innerHTML = `<div class="task-agent-summary">${esc(result.summary)}</div>${(result.fields || []).map((field) => `<div class="task-agent-diff">
    <span class="task-agent-diff-label">${esc(field.label)}</span>
    <span class="task-agent-diff-value"><del>${esc(field.before)}</del><ins>${esc(field.after)}</ins></span>
  </div>`).join('')}`;
  preview.classList.remove('hidden');
  taskAgentState.previewId = result.previewId;
  setTaskAgentStatus(result.notice || '请核对变更，确认后才会保存。', result.notice ? 'notice' : '');
  $('#task-agent-submit').textContent = '确认修改';
  positionTaskAgent(taskAgentState.trigger);
}

function renderTaskAgentThread() {
  const thread = $('#task-agent-thread');
  // Keep three user/agent exchanges visible so a correction still has readable context.
  const turns = taskAgentState.turns.slice(-6);
  thread.innerHTML = turns.map((turn) => `<div class="task-agent-turn ${turn.role === 'user' ? 'user' : 'agent'}"><span>${turn.role === 'user' ? '你' : 'Agent'}</span><p>${esc(turn.text)}</p></div>`).join('');
  thread.classList.toggle('hidden', !turns.length);
}

async function submitTaskAgent(event) {
  event.preventDefault();
  if (taskAgentState.busy || !taskAgentState.taskId) return;
  if (taskAgentState.previewId) {
    const sessionId = taskAgentState.sessionId;
    setTaskAgentBusy(true, '保存中…');
    try {
      const result = await window.api.ai.applyTaskAction(taskAgentState.previewId);
      if (taskAgentState.sessionId !== sessionId) return;
      if (!result || result.ok === false) {
        resetTaskAgentPreview();
        setTaskAgentStatus(result && result.message || '修改未保存，请重新生成预览。', 'error');
        return;
      }
      const taskId = taskAgentState.taskId;
      const openedFromModal = taskAgentState.trigger && taskAgentState.trigger.id === 'm-agent';
      closeTaskAgent(false);
      await refreshTasksAfterMutation('任务已修改，但列表刷新失败');
      refreshOpenTaskModal(tasks.find((item) => item.id === taskId));
      const returnTarget = openedFromModal && editingTask
        ? $('#m-agent')
        : $(`.task-row[data-id="${taskId}"] .task-agent-btn`) || $('.task-row .task-agent-btn, .task-row .task-title-btn');
      if (returnTarget) returnTarget.focus({ preventScroll: true });
      toast(result.message || '任务已更新', 5000, result.undoable && result.undo ? [{
        label: '撤销',
        run: async () => {
          const undoResult = await window.api.ai.undo(result.undo);
          if (undoResult && undoResult.ok === false) throw new Error(undoResult.message || '撤销失败');
          await refreshTasksAfterMutation('操作已撤销，但列表刷新失败');
          refreshOpenTaskModal(tasks.find((item) => item.id === taskId));
          toast('已撤销');
        }
      }] : null, 'ok');
    } catch (error) {
      if (taskAgentState.sessionId !== sessionId) return;
      setTaskAgentStatus(error.message || '保存失败，请重试。', 'error');
    } finally {
      if (taskAgentState.sessionId === sessionId && !$('#task-agent-popover').classList.contains('hidden')) {
        setTaskAgentBusy(false, taskAgentState.previewId ? '确认修改' : '生成预览');
      }
    }
    return;
  }
  const text = $('#task-agent-input').value.trim();
  if (!text) {
    setTaskAgentStatus('先说一下你想怎样修改这项任务。', 'error');
    $('#task-agent-input').focus();
    return;
  }
  const sessionId = taskAgentState.sessionId;
  const requestId = `task-popover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  taskAgentState.requestId = requestId;
  taskAgentState.turns.push({ role: 'user', text });
  renderTaskAgentThread();
  setTaskAgentBusy(true, '理解中…');
  setTaskAgentStatus('正在结合这项任务生成变更预览…');
  try {
    const result = await window.api.ai.previewTaskAction(taskAgentState.taskId, text, requestId, {
      previousText: taskAgentState.previousText,
      previousAction: taskAgentState.previousAction,
      workLogId: taskAgentState.workLogId,
      workLogKind: taskAgentState.workLogKind
    });
    if (taskAgentState.sessionId !== sessionId || taskAgentState.requestId !== requestId) return;
    if (!result || !result.ok) {
      setTaskAgentStatus(result && result.message || '暂时无法理解这条指令，请换个说法。', 'error');
      return;
    }
    renderTaskAgentPreview(result);
    taskAgentState.previousText = text;
    taskAgentState.previousAction = result.action;
    taskAgentState.turns.push({ role: 'agent', text: result.summary || '已生成预览，请确认变更。' });
    renderTaskAgentThread();
  } catch (error) {
    if (taskAgentState.sessionId !== sessionId || taskAgentState.requestId !== requestId) return;
    setTaskAgentStatus(error.message || '预览生成失败，请重试。', 'error');
  } finally {
    if (taskAgentState.sessionId !== sessionId || taskAgentState.requestId !== requestId) return;
    taskAgentState.requestId = null;
    setTaskAgentBusy(false, taskAgentState.previewId ? '确认修改' : '生成预览');
    if (taskAgentState.previewId) $('#task-agent-submit').focus({ preventScroll: true });
  }
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
  const selectionRow = e.target.closest('.task-row');
  if (batchMode && currentView === 'tasks' && selectionRow) {
    toggleSelect(parseInt(selectionRow.dataset.id, 10));
    return;
  }
  const workLogAdd = e.target.closest('[data-worklog-add]');
  if (workLogAdd) {
    const task = tasks.find((item) => item.id === Number(workLogAdd.dataset.worklogAdd));
    if (task) openTaskAgent(task, workLogAdd, { draft: '进展：' });
    return;
  }
  const workLogEdit = e.target.closest('[data-worklog-edit]');
  if (workLogEdit) {
    const row = workLogEdit.closest('.task-row');
    const task = tasks.find((item) => item.id === Number(row && row.dataset.id));
    const log = task && (task.workLogs || []).find((item) => item.id === workLogEdit.dataset.worklogEdit);
    if (task && log) openTaskAgent(task, workLogEdit, { workLog: log });
    return;
  }
  const workLogRemove = e.target.closest('[data-worklog-remove]');
  if (workLogRemove) {
    const row = workLogRemove.closest('.task-row');
    const task = tasks.find((item) => item.id === Number(row && row.dataset.id));
    const log = task && (task.workLogs || []).find((item) => item.id === workLogRemove.dataset.worklogRemove);
    if (task && log) confirmDialog(`删除这条${WORK_LOG_NAME[log.kind] || '工作'}记录吗？`, async () => {
      await window.api.tasks.removeWorkLog(task.id, log.id);
      await refreshTasksAfterMutation('工作记录已删除，但列表刷新失败');
      expandedIds.add('d' + task.id);
      renderAll();
      return { focusTarget: `.task-row[data-id="${task.id}"] [data-worklog-add]` };
    }, '删除');
    return;
  }
  const agentButton = e.target.closest('.task-agent-btn');
  if (agentButton) {
    const row = agentButton.closest('.task-row');
    const task = tasks.find((item) => item.id === parseInt(row.dataset.id, 10));
    if (task) openTaskAgent(task, agentButton);
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
  // 子任务勾选
  const childItem = e.target.closest('.child-item');
  if (childItem) {
    const parentId = parseInt(childItem.dataset.parentId, 10);
    const childId = childItem.dataset.childId;
    const row = childItem.closest('.task-row');
    await runTaskRowMutation({
      taskId: parentId,
      control: childItem,
      operation: () => toggleChild(parentId, childId),
      errorMessage: '子任务更新失败，请重试',
      previousIndex: Math.max(0, currentTaskRows().indexOf(row)),
      focusSelector: `.child-item[data-child-id="${childId}"]`
    });
    return;
  }
  const row = e.target.closest('.task-row');
  if (!row) return;
  const t = tasks.find((x) => x.id === parseInt(row.dataset.id, 10));
  if (!t) return;
  // 展开/收起子任务
  if (e.target.closest('.task-expand')) {
    const id = t.id;
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    renderAll();
    return;
  }
  // 多选（Ctrl/Shift 点击或点击勾选框左侧区域）
  if (e.target.closest('.task-check')) {
    if (currentView === 'tasks' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      setBatchMode(true, false);
      toggleSelect(t.id);
      return;
    }
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
  // 优先级点击切换（循环 1→2→3→4→1）
  if (e.target.closest('[data-pri-toggle]')) {
    const nextPri = t.pri >= 4 ? 1 : t.pri + 1;
    await runTaskRowMutation({
      taskId: t.id,
      control: e.target.closest('[data-pri-toggle]'),
      operation: async () => {
        await window.api.tasks.update(t.id, { pri: nextPri });
        toast(`「${t.title}」已设为${PRI_NAME[nextPri]}优先级`);
        await refreshTasksAfterMutation('优先级已更新，但列表刷新失败');
      },
      errorMessage: '优先级更新失败，请重试',
      previousIndex: Math.max(0, currentTaskRows().indexOf(row)),
      focusSelector: '[data-pri-toggle]'
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
    row.draggable = !busy && !batchMode;
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
  let markOutcomeReady;
  const outcomeReady = new Promise((resolve) => { markOutcomeReady = resolve; });
  const message = res.next
    ? `「${t.title}」已完成，已自动安排下一次（${res.next.due}）`
    : `已完成「${t.title}」`;
  toast(message, 7000, [{
    label: '记录成果',
    run: async () => {
      await outcomeReady;
      openCompletionOutcome(t.id);
    }
  }], 'ok');
  // 完成动画：找到对应行添加动画类
  try {
    const row = document.querySelector(`.task-row[data-id="${t.id}"]`);
    if (row) {
      row.classList.add('just-done');
      await motionDelay(MOTION_MS.base);
    }
    await refreshTasksAfterMutation('任务已完成，但列表刷新失败');
  } finally {
    markOutcomeReady();
  }
}

function taskMatchesFilter(t) {
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    const hit = (t.title || '').toLowerCase().includes(q) ||
      (t.desc || '').toLowerCase().includes(q) ||
      (t.tags || []).some((x) => x.toLowerCase().includes(q)) ||
      (t.project || '').toLowerCase().includes(q);
    if (!hit) return false;
  }
  if (currentFilter === 'today') return isToday(t.due);
  if (currentFilter === 'active') return t.status !== 'done' && t.status !== 'archived';
  if (currentFilter === 'done') return t.status === 'done';
  if (currentFilter === 'archived') return t.status === 'archived';
  if (currentFilter === 'nodate') return !t.due && t.status !== 'done' && t.status !== 'archived';
  if (currentFilter === 'overdue') return t.status !== 'done' && t.status !== 'archived' && isOverdue(t.due, t.status);
  if (currentFilter === 'week') {
    const now = new Date();
    return t.createdAt >= new Date(now.getTime() - 7 * 86400000).getTime() && t.status !== 'archived';
  }
  if (currentFilter.startsWith('proj:')) return (t.project || '') === currentFilter.slice(5);
  if (currentFilter.startsWith('tag:')) return (t.tags || []).includes(currentFilter.slice(4));
  return true;
}

function openCompletionOutcome(taskId) {
  const task = tasks.find((item) => item.id === Number(taskId) && !item._deleted);
  if (!task) throw new Error('已完成的任务暂时无法打开');
  // 保持上下文：刚完成的任务在「已完成」筛选下可见，避免跳到所有任务
  const visibleNow = tasks.some((item) => item.id === Number(taskId) && !item._deleted && taskMatchesFilter(item));
  if (!visibleNow) currentFilter = task.status === 'done' ? 'done' : 'all';
  currentSearch = '';
  const search = $('#search-input');
  if (search) search.value = '';
  expandedIds.add('d' + task.id);
  if (currentView === 'tasks') renderTasks();
  else switchView('tasks');
  const trigger = document.querySelector(`.task-row[data-id="${task.id}"] [data-worklog-add]`);
  if (!trigger) throw new Error('任务记录入口暂时不可用');
  openTaskAgent(task, trigger, { draft: '成果：' });
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
    let direction = 0;
    if (selectedDate && (selectedDate.getFullYear() !== calCursor.getFullYear() || selectedDate.getMonth() !== calCursor.getMonth())) {
      direction = selectedDate < calCursor ? -1 : 1;
      calCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    }
    renderCal(direction, true);
    focusCalendarCell(calSelected);
    return;
  }
  const btn = e.target.closest('[data-cal]');
  if (btn) {
    const previousCursor = new Date(calCursor);
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
    const direction = calCursor < previousCursor ? -1 : calCursor > previousCursor ? 1 : 0;
    renderCal(direction);
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
  const direction = targetDate < calCursor ? -1 : 1;
  calCursor = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  renderCal(direction);
  focusCalendarCell(targetKey);
}

/* ---------- 初始化 ---------- */
async function init() {
  document.body.setAttribute('aria-busy', 'true');
  $('#ai-chat').setAttribute('aria-busy', 'true');
  try {
    const [settingsResult, tasksResult, memosResult, taskTrashResult, memoTrashResult, dirResult, workflowResult, copilotResult] = await Promise.allSettled([
      window.api.settings.get(),
      window.api.tasks.getAll(),
      window.api.memos.getAll(),
      window.api.tasks.getDeleted(),
      window.api.memos.getDeleted(),
      window.api.data.getDir(),
      window.api.workflow ? window.api.workflow.get() : Promise.resolve(workflowState),
      window.api.workflow && window.api.workflow.getCopilot ? window.api.workflow.getCopilot() : Promise.resolve(null)
    ]);

    settings = settingsResult.status === 'fulfilled'
      ? (settingsResult.value || {})
      : { theme: 'auto', aiStage: 'local', shortcuts: {} };
    tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
    memos = memosResult.status === 'fulfilled' ? memosResult.value : [];
    trashList = taskTrashResult.status === 'fulfilled' ? taskTrashResult.value : [];
    deletedMemos = memoTrashResult.status === 'fulfilled' ? memoTrashResult.value : [];
    settings.dataDir = dirResult.status === 'fulfilled' ? dirResult.value : '暂时无法读取';
    workflowState = workflowResult.status === 'fulfilled' ? workflowResult.value : workflowState;
    dailyCopilot = copilotResult.status === 'fulfilled' ? copilotResult.value : null;
    dataLoadErrors.tasks = tasksResult.status === 'rejected' ? tasksResult.reason : null;
    dataLoadErrors.memos = memosResult.status === 'rejected' ? memosResult.reason : null;

    applyTheme();
    if (!eventsBound) {
      bindEvents();
      eventsBound = true;
    }
    renderAll();
    clearInterval(workflowTickTimer);
    workflowTickTimer = setInterval(tickWorkflowClock, 1000);
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
