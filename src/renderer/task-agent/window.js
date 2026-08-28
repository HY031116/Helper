'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const chatLog = $('#ta-thread');
const chatInput = $('#ta-input');
const chatSend = $('#ta-send');
const chatState = $('#ta-state');
const titleEl = $('#ta-title');

let session = { taskId: null, title: '', workLogId: '', workLogKind: '' };
let busy = false;
let activeRequest = null; // { id, pending, streamStarted, reasoningStarted }
let previousAction = null;
let previousText = '';
// 会话自持记忆：任务小窗不读写主窗口侧边栏的对话记录，多轮上下文只在小窗内累积
const SESSION_HISTORY_LIMIT = 12;
let sessionHistory = [];

function rememberTurn(userText, assistantText) {
  const user = String(userText || '').trim();
  const assistant = String(assistantText || '').trim();
  if (user) sessionHistory.push({ role: 'user', content: user.slice(0, 500) });
  if (assistant) sessionHistory.push({ role: 'assistant', content: assistant.slice(0, 800) });
  if (sessionHistory.length > SESSION_HISTORY_LIMIT) {
    sessionHistory = sessionHistory.slice(-SESSION_HISTORY_LIMIT);
  }
}

function currentSessionHistory() {
  return sessionHistory.map((entry) => ({ role: entry.role, content: entry.content }));
}

/* ---------- 基础消息渲染 ---------- */

function scrollToEnd(force) {
  chatLog.scrollTop = chatLog.scrollHeight;
  if (force) chatLog.scrollIntoView({ block: 'end' });
}

function addMessage(role, text) {
  const message = document.createElement('div');
  message.className = `ta-msg ${role === 'user' ? 'user' : 'ai'}`;
  if (role === 'user') {
    message.textContent = String(text || '');
  } else {
    const body = document.createElement('div');
    body.className = 'ta-text';
    body.textContent = String(text || '');
    message.appendChild(body);
  }
  chatLog.appendChild(message);
  scrollToEnd(role === 'user');
  return message;
}

/* ---------- 思考过程 ---------- */

function ensureReasoningBlock(msgEl) {
  if (!msgEl) return null;
  let block = msgEl.querySelector('.ta-reasoning');
  if (block) {
    const body = block.querySelector('.ta-reasoning-body');
    if (body) return { block, body };
  }
  block = document.createElement('details');
  block.className = 'ta-reasoning';
  block.open = true;
  block.setAttribute('aria-label', '思考过程');
  const summary = document.createElement('summary');
  summary.innerHTML = `<span class="ta-reasoning-seal" aria-hidden="true">思</span>
    <span class="ta-reasoning-title">正在思考…</span>`;
  const body = document.createElement('div');
  body.className = 'ta-reasoning-body';
  block.append(summary, body);
  const textBody = msgEl.querySelector('.ta-text');
  if (textBody && textBody.parentNode) {
    textBody.parentNode.insertBefore(block, textBody);
  } else {
    msgEl.prepend(block);
  }
  return { block, body };
}

function finishReasoningBlock(msgEl, cumulativeReasoning) {
  if (!msgEl) return;
  const refs = ensureReasoningBlock(msgEl);
  if (!refs) return;
  const { block, body } = refs;
  if (typeof cumulativeReasoning === 'string' && cumulativeReasoning && !body.textContent) {
    body.textContent = cumulativeReasoning;
  }
  const title = block.querySelector('.ta-reasoning-title');
  const total = (body.textContent || '').trim().length;
  if (title) title.textContent = total ? `思考过程（${total} 字）` : '思考过程';
  block.open = false;
  block.classList.remove('is-streaming');
  block.classList.add('is-done');
}

/* ---------- Agent 轨迹 ---------- */

function appendAgentTrace(message, result) {
  if (!result?.agentTrace || !Array.isArray(result.agentSteps) || result.agentSteps.length <= 1) return;
  const trace = document.createElement('div');
  trace.className = 'ta-trace';
  trace.textContent = `自主执行 ${result.agentSteps.length} 步 · ${result.agentTrace}`;
  message.appendChild(trace);
}

/* ---------- 修改预览卡（任务范围安全流） ---------- */

function renderPreviewCard(message, preview, sourceText) {
  const card = document.createElement('div');
  card.className = 'ta-preview';

  const summary = document.createElement('div');
  summary.className = 'ta-preview-summary';
  summary.textContent = preview.summary || '准备修改任务';
  card.appendChild(summary);

  if (Array.isArray(preview.fields) && preview.fields.length) {
    const fields = document.createElement('div');
    fields.className = 'ta-preview-fields';
    preview.fields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'ta-preview-field';
      const label = document.createElement('span');
      label.className = 'ta-preview-field-label';
      label.textContent = field.label || '';
      const value = document.createElement('span');
      value.className = 'ta-preview-field-value';
      if (field.before !== undefined && field.before !== null && String(field.before) !== '') {
        const was = document.createElement('span');
        was.className = 'was';
        was.textContent = field.before;
        value.appendChild(was);
      }
      const now = document.createElement('span');
      now.className = 'now';
      now.textContent = field.after;
      value.appendChild(now);
      row.append(label, value);
      fields.appendChild(row);
    });
    card.appendChild(fields);
  }

  const actions = document.createElement('div');
  actions.className = 'ta-preview-actions';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'primary';
  applyBtn.textContent = '确认修改';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  actions.append(applyBtn, cancelBtn);
  card.appendChild(actions);
  message.appendChild(card);

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    cancelBtn.disabled = true;
    setState('正在保存修改…', true);
    try {
      const result = await window.api.ai.applyTaskAction(preview.previewId);
      applyBtn.closest('.ta-preview').remove();
      if (result && result.ok !== false) {
        previousAction = { intent: preview.action.intent, params: preview.action.params };
        previousText = preview.action && preview.action.params ? String(preview.action.params.text || '') : '';
        const done = addMessage('ai', result.message || '修改已保存。');
        appendResultActions(done, result);
        rememberTurn(sourceText, result.message);
      } else {
        addMessage('ai', (result && result.message) || '修改没有保存，请重试。');
      }
    } catch (error) {
      applyBtn.disabled = false;
      cancelBtn.disabled = false;
      setState(error.message || '保存失败，请重试');
      return;
    }
    setState('');
    chatInput.focus();
  });
  cancelBtn.addEventListener('click', () => {
    card.remove();
    addMessage('ai', '好的，这次修改已取消。');
  });
}

/* ---------- 全局对话结果操作（确认/候选/撤销兜底） ---------- */

function appendResultActions(message, result) {
  appendAgentTrace(message, result);
  if (!result || !result.type) return;
  const actions = document.createElement('div');
  actions.className = 'ta-actions';
  const addButton = (label, primary, run) => {
    const button = document.createElement('button');
    button.type = 'button';
    if (primary) button.classList.add('primary');
    button.textContent = label;
    button.addEventListener('click', async () => {
      actions.querySelectorAll('button').forEach((control) => { control.disabled = true; });
      try { await run(); } catch (error) {
        actions.querySelectorAll('button').forEach((control) => { control.disabled = false; });
        setState(error.message || '操作没有完成，请重试');
      }
    });
    actions.appendChild(button);
  };

  if (result.type === 'confirm') {
    addButton('确认执行', true, () => sendPrompt('确认执行'));
    addButton('取消', false, () => sendPrompt('取消'));
  } else if (result.type === 'ask' && Array.isArray(result.candidates) && result.candidates.length) {
    result.candidates.slice(0, 6).forEach((candidate, index) => {
      addButton(`${index + 1}. ${candidate.title}`, index === 0, async () => {
        addMessage('user', candidate.title);
        const resolved = await window.api.ai.resolve(result.intent, result.params, candidate.id, candidate.title);
        const done = addMessage('ai', resolved.message || '已完成。');
        appendResultActions(done, resolved);
      });
    });
    addButton('取消', false, () => sendPrompt('取消'));
  } else if (result.type === 'clarify') {
    addButton('取消操作', false, () => sendPrompt('取消'));
  } else if (result.undoable && result.undo) {
    addButton('撤销', false, async () => {
      const undone = await window.api.ai.undo(result.undo);
      addMessage('ai', (undone && undone.message) || '已撤销。');
    });
  } else {
    return; // 无操作不渲染空容器
  }
  message.appendChild(actions);
}

/* ---------- 状态与请求 ---------- */

function setState(text, isBusy) {
  busy = !!isBusy;
  chatState.textContent = text || '';
  chatState.classList.toggle('is-busy', !!isBusy);
  chatInput.disabled = false;
  chatSend.disabled = !!isBusy;
}

function updateProgress(progress) {
  if (!activeRequest || !progress || progress.requestId !== activeRequest.id) return;
  const pending = activeRequest.pending;
  if (!pending) return;
  const message = String(progress.message || '').trim();

  const reasoningDelta = typeof progress.reasoningDelta === 'string' ? progress.reasoningDelta : '';
  if (reasoningDelta) {
    const refs = ensureReasoningBlock(pending);
    if (refs) {
      if (!activeRequest.reasoningStarted) {
        activeRequest.reasoningStarted = true;
        refs.body.textContent = '';
        refs.block.classList.add('is-streaming');
      }
      refs.body.textContent += reasoningDelta;
      scrollToEnd(false);
    }
  }
  if (progress.reasoningDone) {
    finishReasoningBlock(pending, progress.cumulativeReasoning);
    scrollToEnd(false);
  }
  if (typeof progress.delta === 'string' && progress.delta) {
    const body = pending.querySelector('.ta-text');
    if (!activeRequest.streamStarted) {
      activeRequest.streamStarted = true;
      body.textContent = '';
      pending.classList.add('is-streaming');
    }
    body.textContent += progress.delta;
    scrollToEnd(false);
    return;
  }
  if (message && !reasoningDelta && !progress.reasoningDone) {
    pending.querySelector('.ta-text').textContent = message;
    scrollToEnd(false);
  }
}

/* ---------- 发送：任务范围修改优先，全局对话兜底 ---------- */

async function sendPrompt(text) {
  const input = String(text || '').trim();
  if (!input || busy || !session.taskId) return;
  setState('正在理解…', true);
  addMessage('user', input);
  const pending = addMessage('ai', '正在理解…');
  pending.classList.add('is-streaming');

  const requestId = `task-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRequest = { id: requestId, pending, streamStarted: false, reasoningStarted: false };
  previousText = input;

  let preview = null;
  try {
    preview = await window.api.ai.previewTaskAction(session.taskId, input, requestId, {
      previousAction,
      previousText,
      workLogId: session.workLogId,
      workLogKind: session.workLogKind
    }, currentSessionHistory());
  } catch (error) {
    activeRequest = null;
    pending.classList.remove('is-streaming');
    setState(error.message || '请求失败，请重试');
    return;
  }

  activeRequest = null;
  pending.classList.remove('is-streaming');

  if (preview && preview.ok) {
    // 任务范围修改：清掉解析阶段的流式文本，改为预览卡确认
    pending.querySelector('.ta-text').textContent = '';
    renderPreviewCard(pending, preview, input);
    setState('');
    chatInput.focus();
    return;
  }

  if (preview && preview.type === 'duplicate') {
    pending.querySelector('.ta-text').textContent = preview.message || '正在处理上一条指令，请稍候。';
    setState('');
    return;
  }

  // 不是任务内操作（纯聊天/全局查询/全局指令）：交给全局 Agent 对话，流式渲染
  pending.querySelector('.ta-text').textContent = '';
  await runGlobalChat(pending, input);
}

async function runGlobalChat(pending, input) {
  setState('正在思考…', true);
  pending.classList.add('is-streaming');
  const requestId = `task-agent-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRequest = { id: requestId, pending, streamStarted: false, reasoningStarted: false };
  let result;
  try {
    result = await window.api.ai.handle(input, requestId, { history: currentSessionHistory() });
  } catch (error) {
    activeRequest = null;
    pending.classList.remove('is-streaming');
    pending.querySelector('.ta-text').textContent = error.message || '连接模型失败，请稍后重试。';
    setState('');
    return;
  }
  activeRequest = null;
  pending.classList.remove('is-streaming');
  const body = pending.querySelector('.ta-text');
  body.textContent = (result && result.message) || '';
  appendResultActions(pending, result);
  rememberTurn(input, result && result.message);
  setState('');
  chatInput.focus();
}

/* ---------- 会话与事件 ---------- */

function startSession(payload) {
  session = {
    taskId: Number(payload && payload.taskId) || null,
    title: String((payload && payload.title) || ''),
    workLogId: String((payload && payload.workLogId) || ''),
    workLogKind: String((payload && payload.workLogKind) || '')
  };
  previousAction = null;
  previousText = '';
  activeRequest = null;
  busy = false;
  sessionHistory = [];
  titleEl.textContent = session.title || '任务对话';
  chatLog.replaceChildren();
  setState('');
  chatSend.disabled = false;
  chatInput.value = '';
  if (session.draftFill) chatInput.value = session.draftFill;
  const draft = String((payload && payload.draft) || '');
  if (draft) chatInput.value = draft;
  const welcome = session.taskId
    ? '我在这里和你一起推进这项任务。可以说「改到明天」「记录进展：…」「拆成三步」，也可以随便聊聊。'
    : '我在这里待命。打开一项任务的对话入口，就可以开始协作。';
  addMessage('ai', welcome);
  chatInput.focus();
}

window.api.on('task-agent:session', startSession);

$('#ta-close').addEventListener('click', () => window.api.taskAgent.close());
window.api.ai.onProgress(updateProgress);

$$('#ta-chips .ta-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (busy) return;
    const prompt = chip.dataset.prompt || chip.textContent;
    if (prompt.endsWith('：')) {
      chatInput.value = prompt;
      chatInput.focus();
      chatInput.setSelectionRange(prompt.length, prompt.length);
      return;
    }
    sendPrompt(prompt);
  });
});

$('#ta-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = chatInput.value;
  if (!raw.trim() || busy) return;
  chatInput.value = '';
  autoResize();
  sendPrompt(raw);
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  $('#ta-form').requestSubmit();
});

function autoResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(96, chatInput.scrollHeight)}px`;
}
chatInput.addEventListener('input', autoResize);
