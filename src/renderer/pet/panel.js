'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const tabs = $$('.panel-tabs [role="tab"]');
const pages = $$('.panel-page');
const chatLog = $('#pet-chat-log');
const chatInput = $('#pet-chat-input');
const chatSend = $('#pet-chat-send');
const chatState = $('#pet-chat-state');
const latestButton = $('#pet-chat-latest');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

let themePreference = 'auto';
let workflow = { activeFocus: null };
let nextTaskId = null;
let pendingReminder = null;
let activeRequest = null;
let requestSequence = 0;
let followingLatest = true;
let overviewBusy = false;
let focusClock = null;

function applyTheme(theme) {
  themePreference = ['light', 'dark', 'auto'].includes(theme) ? theme : 'auto';
  document.body.classList.toggle('dark', themePreference === 'dark' || (themePreference === 'auto' && systemTheme.matches));
}

systemTheme.addEventListener('change', () => {
  if (themePreference === 'auto') applyTheme('auto');
});

function selectPage(name, focus) {
  const targetName = name === 'chat' ? 'chat' : 'overview';
  tabs.forEach((tab) => {
    const selected = tab.id === `panel-tab-${targetName}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  pages.forEach((page) => page.classList.toggle('hidden', page.id !== `panel-${targetName}`));
  if (targetName === 'chat') {
    loadChatHistory().finally(() => chatInput.focus());
  } else {
    refreshOverview();
  }
}

function onTabKeyDown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = tabs.indexOf(event.currentTarget);
  let next = current;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else next = (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectPage(tabs[next].id.endsWith('chat') ? 'chat' : 'overview', true);
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => selectPage(tab.id.endsWith('chat') ? 'chat' : 'overview'));
  tab.addEventListener('keydown', onTabKeyDown);
});

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDue(value) {
  if (!value) return '';
  const [date, time = ''] = String(value).split(' ');
  const today = localDateKey(new Date());
  return `${date === today ? '今天' : date}${time ? ` ${time}` : ''}`;
}

function focusElapsedMs() {
  const focus = workflow.activeFocus;
  if (!focus) return 0;
  return (Number(focus.accumulatedMs) || 0)
    + (focus.state === 'running' ? Math.max(0, Date.now() - Number(focus.resumedAt || Date.now())) : 0);
}

function renderFocus() {
  const focus = workflow.activeFocus;
  $('#overview-focus').classList.toggle('hidden', !focus);
  if (!focus) return;
  $('#overview-focus-label').textContent = focus.state === 'paused' ? '专注已暂停' : '正在专注';
  $('#overview-focus-title').textContent = focus.title;
  const paused = focus.state === 'paused';
  $('#overview-focus-toggle').innerHTML = uiIcon(paused ? 'play' : 'pause');
  $('#overview-focus-toggle').setAttribute('aria-label', paused ? '继续专注' : '暂停专注');
  $('#overview-focus-toggle').title = paused ? '继续专注' : '暂停专注';
  const seconds = Math.floor(focusElapsedMs() / 1000);
  $('#overview-focus-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function refreshOverview() {
  try {
    const [tasks, nextWorkflow, config] = await Promise.all([
      window.api.tasks.getAll(),
      window.api.workflow.get(),
      window.api.ai.config()
    ]);
    workflow = nextWorkflow || { activeFocus: null };
    const today = localDateKey(new Date());
    const active = tasks.filter((task) => !['done', 'archived'].includes(task.status));
    const overdue = active.filter((task) => task.due && task.due.slice(0, 10) < today);
    const done = tasks.filter((task) => task.status === 'done' && String(task.completedAt || '').slice(0, 10) === today);
    const scheduledNext = [...active].sort((a, b) => {
      const aDue = a.due || '9999-12-31 23:59';
      const bDue = b.due || '9999-12-31 23:59';
      return aDue.localeCompare(bDue) || Number(b.pri || 0) - Number(a.pri || 0);
    })[0];
    const next = pendingReminder
      ? active.find((task) => task.id === pendingReminder.id) || scheduledNext
      : scheduledNext;
    nextTaskId = next?.id || null;
    $('#overview-todo').textContent = String(active.length);
    $('#overview-overdue').textContent = String(overdue.length);
    $('#overview-done').textContent = String(done.length);
    $('#overview-next-title').textContent = next ? next.title : '今天的任务已经处理完了';
    $('#overview-next-meta').textContent = next ? (formatDue(next.due) || '尚未安排时间') : '可以记录新任务或整理备忘录';
    $('#overview-next').disabled = !nextTaskId;
    $('#panel-model').textContent = config.configured && config.model ? `真实模型 · ${config.model}` : '本地工作状态';
    renderFocus();
  } catch (error) {
    $('#overview-next-title').textContent = '工作状态暂时无法读取';
    $('#overview-next-meta').textContent = '稍后重新打开即可重试';
  }
}

$('#overview-next').addEventListener('click', async () => {
  if (!nextTaskId) return;
  const button = $('#overview-next');
  button.disabled = true;
  try {
    await window.api.pet.openTask(nextTaskId);
    pendingReminder = null;
  } catch (error) {
    $('#overview-feedback').textContent = '暂时无法打开这项任务，请重试。';
    $('#overview-feedback').classList.remove('hidden');
    button.disabled = false;
  }
});

async function updateFocus(action) {
  const controls = $$('.overview-focus-actions button');
  controls.forEach((button) => { button.disabled = true; });
  try {
    if (action === 'toggle') {
      workflow = workflow.activeFocus?.state === 'paused'
        ? await window.api.workflow.resumeFocus({})
        : await window.api.workflow.pauseFocus({});
    } else {
      const result = await window.api.workflow.finishFocus({ completeTask: true });
      workflow = result.workflow;
    }
    renderFocus();
    await refreshOverview();
  } catch (error) {
    $('#overview-feedback').textContent = error.message || '专注状态更新失败，请重试。';
    $('#overview-feedback').classList.remove('hidden');
  } finally {
    controls.forEach((button) => { button.disabled = false; });
  }
}

$('#overview-focus-toggle').addEventListener('click', () => updateFocus('toggle'));
$('#overview-focus-complete').addEventListener('click', () => updateFocus('complete'));

function setOverviewBusy(busy, activeControl) {
  overviewBusy = busy;
  $$('[data-open-view]').forEach((button) => { button.disabled = busy; });
  $('#overview-open-chat').disabled = busy;
  if (activeControl) activeControl.setAttribute('aria-busy', String(busy));
}

async function openView(control, view) {
  if (overviewBusy) return;
  const feedback = $('#overview-feedback');
  feedback.classList.add('hidden');
  setOverviewBusy(true, control);
  try {
    await window.api.pet.openView(view);
  } catch (error) {
    feedback.textContent = '暂时无法打开工作台，请重试。';
    feedback.classList.remove('hidden');
    setOverviewBusy(false, control);
    control.focus();
  }
}

$$('[data-open-view]').forEach((button) => button.addEventListener('click', () => openView(button, button.dataset.openView)));
$('#overview-open-chat').addEventListener('click', () => selectPage('chat'));

const viewButtons = $$('.overview-views button');
$('.overview-views').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = viewButtons.indexOf(document.activeElement);
  let next = current < 0 ? 0 : current;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = viewButtons.length - 1;
  else if (event.key === 'ArrowLeft') next = (next - 1 + viewButtons.length) % viewButtons.length;
  else if (event.key === 'ArrowRight') next = (next + 1) % viewButtons.length;
  else if (event.key === 'ArrowUp') next = (next - 3 + viewButtons.length) % viewButtons.length;
  else next = (next + 3) % viewButtons.length;
  viewButtons.forEach((button, index) => { button.tabIndex = index === next ? 0 : -1; });
  viewButtons[next].focus();
});

function nearChatBottom() {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
}

function scrollToLatest(force) {
  if (force || followingLatest || nearChatBottom()) {
    chatLog.scrollTop = chatLog.scrollHeight;
    followingLatest = true;
    latestButton.classList.add('hidden');
  } else {
    latestButton.classList.remove('hidden');
  }
}

chatLog.addEventListener('scroll', () => {
  followingLatest = nearChatBottom();
  latestButton.classList.toggle('hidden', followingLatest);
});
latestButton.addEventListener('click', () => scrollToLatest(true));

function addMessage(role, text, timestamp) {
  const message = document.createElement('div');
  message.className = `chat-message ${role === 'user' ? 'user' : 'ai'}`;
  message.textContent = String(text || '');
  if (timestamp) message.dataset.timestamp = String(timestamp);
  chatLog.appendChild(message);
  scrollToLatest(role === 'user');
  return message;
}

function addActions(message, items, label) {
  const actions = document.createElement('div');
  actions.className = 'chat-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', label || '继续操作');
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.primary) button.classList.add('primary');
    button.addEventListener('click', async () => {
      actions.querySelectorAll('button').forEach((control) => { control.disabled = true; });
      try { await item.run(); } catch (error) {
        actions.querySelectorAll('button').forEach((control) => { control.disabled = false; });
        chatState.textContent = error.message || '操作没有完成，请重试';
      }
    });
    actions.appendChild(button);
  });
  message.appendChild(actions);
}

function renderResultControls(message, result, retryText) {
  if (result.type === 'ask' && Array.isArray(result.candidates) && result.candidates.length) {
    const items = result.candidates.slice(0, 6).map((candidate, index) => ({
      label: `${index + 1}. ${candidate.title}`,
      run: async () => {
        addMessage('user', candidate.title);
        const resolved = await window.api.ai.resolve(result.intent, result.params, candidate.id, candidate.title);
        renderAssistantResult(resolved);
      }
    }));
    items.push({ label: '取消', run: () => sendPrompt('取消') });
    addActions(message, items, '选择对象');
    return;
  }
  if (result.type === 'confirm') {
    addActions(message, [
      { label: '确认执行', primary: true, run: () => sendPrompt('确认执行') },
      { label: '取消', run: () => sendPrompt('取消') }
    ], '确认操作');
    return;
  }
  if (result.type === 'clarify') {
    addActions(message, [{ label: '取消操作', run: () => sendPrompt('取消') }], '取消当前操作');
    return;
  }
  const items = [];
  if (result.undoable && result.undo) {
    items.push({
      label: '撤销',
      run: async () => {
        const undone = await window.api.ai.undo(result.undo);
        renderAssistantResult(undone);
      }
    });
  }
  if (result.retryable && retryText) items.push({ label: '重试', run: () => sendPrompt(retryText) });
  if (items.length) addActions(message, items);
}

function renderAssistantResult(result, retryText) {
  const message = addMessage('ai', result?.message || '操作已完成。');
  renderResultControls(message, result || {}, retryText);
  chatState.textContent = result?.historyNotice || (result?.cancelled ? '已停止' : '与主工作台共享对话');
  refreshOverview();
  return message;
}

async function loadChatHistory() {
  try {
    const [entries, session] = await Promise.all([window.api.chat.get(), window.api.ai.session()]);
    chatLog.innerHTML = '';
    (Array.isArray(entries) ? entries : []).slice(-24).forEach((entry) => addMessage(entry.role, entry.text, entry.ts));
    if (!chatLog.children.length) addMessage('ai', '可以直接告诉我你想记录、修改或安排什么。');
    if (session?.pending) {
      const last = chatLog.querySelector('.chat-message.ai:last-of-type') || addMessage('ai', session.pending.message);
      renderResultControls(last, session.pending);
    }
    scrollToLatest(true);
  } catch (error) {
    if (!chatLog.children.length) addMessage('ai', '对话记录暂时无法读取，但仍可以发送新消息。');
  }
}

function setChatBusy(busy) {
  chatInput.disabled = busy;
  chatSend.textContent = busy ? '停止' : '发送';
  chatSend.setAttribute('aria-label', busy ? '停止本次请求' : '发送消息');
  $$('.chat-actions button').forEach((button) => { button.disabled = busy; });
}

async function sendPrompt(rawText) {
  const text = String(rawText === undefined ? chatInput.value : rawText).trim();
  if (!text || activeRequest) return;
  if (rawText === undefined) {
    chatInput.value = '';
    resizeInput();
  }
  addMessage('user', text);
  const pending = addMessage('ai', '正在理解你的要求…');
  pending.classList.add('pending');
  const requestId = `pet-${Date.now()}-${++requestSequence}`;
  activeRequest = { id: requestId, text, pending };
  setChatBusy(true);
  chatState.textContent = '正在处理';
  try {
    const result = await window.api.ai.handle(text, requestId);
    pending.remove();
    renderAssistantResult(result, text);
  } catch (error) {
    pending.textContent = '助手暂时没有响应。请检查模型设置后重试。';
    pending.classList.remove('pending');
    addActions(pending, [{ label: '重试', primary: true, run: () => sendPrompt(text) }], '错误恢复');
    chatState.textContent = '请求未完成';
  } finally {
    activeRequest = null;
    setChatBusy(false);
    chatInput.focus();
  }
}

async function cancelRequest() {
  if (!activeRequest) return;
  chatSend.disabled = true;
  chatState.textContent = '正在停止';
  try { await window.api.ai.cancel(activeRequest.id); } finally { chatSend.disabled = false; }
}

function resizeInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 78)}px`;
}

$('#pet-chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (activeRequest) cancelRequest();
  else sendPrompt();
});
chatInput.addEventListener('input', resizeInput);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activeRequest) {
    event.preventDefault();
    cancelRequest();
  } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt();
  }
});

$('#open-full-assistant').addEventListener('click', () => window.api.pet.openView('ai'));
$('#panel-close').addEventListener('click', () => window.api.pet.closePanel());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !activeRequest) {
    event.preventDefault();
    window.api.pet.closePanel();
  }
});

if (window.api.ai.onProgress) {
  window.api.ai.onProgress((progress) => {
    if (!activeRequest || progress?.requestId && progress.requestId !== activeRequest.id) return;
    if (progress?.message) {
      activeRequest.pending.textContent = progress.message;
      chatState.textContent = progress.message;
    }
  });
}

window.api.on('pet-panel:shown', async (mode) => {
  selectPage(mode, false);
  if (mode !== 'chat') $('#panel-tab-overview').focus();
});
window.api.on('pet:theme', applyTheme);
window.api.on('workflow:changed', (state) => {
  workflow = state || workflow;
  renderFocus();
});
window.api.on('pet:remind', (reminder) => {
  pendingReminder = reminder || null;
  refreshOverview();
});

(async function init() {
  try {
    const settings = await window.api.settings.get();
    applyTheme(settings.theme);
  } catch (error) {
    applyTheme('auto');
  }
  await Promise.all([refreshOverview(), loadChatHistory()]);
  focusClock = setInterval(renderFocus, 1000);
})();
