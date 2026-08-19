'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/css/app.css'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
const petHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/pet.html'), 'utf8');
const petApp = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/pet.js'), 'utf8');
const petCss = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/pet.css'), 'utf8');

function cssVar(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(match, `缺少 CSS 变量 --${name}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9A-Fa-f]{2}/g).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function loadRendererRuntime(elements) {
  const context = vm.createContext({
    console,
    Date,
    Set,
    Map,
    Math,
    JSON,
    setTimeout: elements.__setTimeout || setTimeout,
    clearTimeout,
    document: {
      querySelector: (selector) => elements[selector] || null,
      querySelectorAll: () => [],
      createElement: (tag) => elements.__createElement ? elements.__createElement(tag) : null,
      addEventListener: () => {}
    },
    window: {},
    navigator: elements.__navigator || {},
    testValues: elements.__testValues || {}
  });
  vm.runInContext(app, context);
  return (source) => vm.runInContext(source, context);
}

function fakeClassList(initial) {
  const values = new Set(initial || []);
  return {
    add: (name) => values.add(name),
    remove: (name) => values.delete(name),
    toggle: (name, force) => {
      if (force === undefined) {
        if (values.has(name)) values.delete(name);
        else values.add(name);
      } else if (force) values.add(name);
      else values.delete(name);
    },
    contains: (name) => values.has(name)
  };
}

function fakePetElement(initial) {
  const attrs = {};
  const listeners = {};
  return {
    attrs,
    listeners,
    classList: fakeClassList(initial),
    style: { setProperty() {} },
    textContent: '',
    focused: false,
    offsetWidth: 160,
    addEventListener(name, listener) { listeners[name] = listener; },
    setAttribute(name, value) { attrs[name] = value; },
    focus() { this.focused = true; },
    closest() { return null; },
    querySelector() { return null; }
  };
}

function loadPetRuntime(elements, tasks) {
  const documentListeners = {};
  const context = vm.createContext({
    console,
    Date,
    Math,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      getElementById: (id) => elements[id],
      addEventListener: (name, listener) => { documentListeners[name] = listener; }
    },
    window: {
      api: {
        tasks: { getAll: async () => tasks || [] },
        pet: {
          setPosition: async () => ({ ok: true }),
          snapToEdge: async () => ({ ok: true }),
          openView: async () => ({ ok: true }),
          contextMenu: async () => ({ ok: true })
        },
        on: () => () => {}
      }
    }
  });
  vm.runInContext(petApp, context);
  return { run: (source) => vm.runInContext(source, context), documentListeners };
}

test('主导航和任务工具栏使用可聚焦控件', () => {
  assert.match(html, /<nav class="sidebar" aria-label="主导航">/);
  assert.match(html, /<button type="button" class="nav-item active"[^>]+aria-current="page"/);
  assert.doesNotMatch(html, /<div class="nav-item/);
  assert.match(html, /<div class="task-search-row">\s*<input id="search-input" type="search" aria-label="搜索任务"/);
  assert.match(html, /<div class="quick-add">\s*<input id="quick-input" aria-label="快速添加任务"/);
  assert.match(html, /id="btn-quick-add">快速添加<\/button>/);
  assert.match(html, /id="btn-new">详细创建<\/button>/);
});

test('高频任务操作和设置开关暴露键盘与状态语义', () => {
  assert.match(app, /<button type="button" class="task-check"[^>]+aria-label=/);
  assert.match(app, /<button type="button" class="pri-dot p\$\{t\.pri\}"[^>]+data-pri-toggle/);
  assert.match(app, /class="task-expand\$\{[^}]+\}"[^>]+aria-expanded=/);
  assert.match(app, /class="tname task-title-btn" aria-expanded=/);
  assert.match(app, /role="switch" aria-checked=/);
  assert.match(html, /<button type="button" class="chip" data-prompt=/);
  assert.match(app, /<button type="button" class="fchip [^`]+aria-pressed=/);
});

test('快速添加同时支持按钮和回车，并防止重复提交', () => {
  assert.match(app, /async function createQuickTask\(\)/);
  assert.match(app, /if \(!raw \|\| button\.disabled\) return/);
  assert.match(app, /#btn-quick-add'\)\.addEventListener\('click', createQuickTask\)/);
  assert.match(app, /if \(e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);\s*createQuickTask\(\)/);
  assert.match(app, /toast\(`已创建「\$\{esc\(p\.title\)\}」/);
  assert.match(app, /toast\(`已创建「\$\{esc\(raw\)\}」`\)/);
});

test('快速添加预览展示解析结果并明确普通任务兜底', () => {
  const preview = { classList: fakeClassList(['hidden']), innerHTML: '' };
  const run = loadRendererRuntime({ '#quick-preview': preview });

  run(`renderQuickPreview('明天下午3点 交周报 #工作 紧急', {
    intent: 'create',
    params: { title: '交周报', pri: 4, tags: ['工作'] }
  })`);
  assert.strictEqual(preview.classList.contains('hidden'), false);
  assert.strictEqual(preview.classList.contains('fallback'), false);
  assert.match(preview.innerHTML, /识别结果/);
  assert.match(preview.innerHTML, /交周报/);
  assert.match(preview.innerHTML, /紧急优先级/);
  assert.match(preview.innerHTML, /#工作/);

  run(`renderQuickPreview('买牛奶', { intent: 'chat', params: {} })`);
  assert.strictEqual(preview.classList.contains('fallback'), true);
  assert.match(preview.innerHTML, /普通任务/);
  assert.match(preview.innerHTML, /买牛奶/);
  assert.match(app, /token !== quickParseToken \|\| \$\('#quick-input'\)\.value\.trim\(\) !== value/);
});

test('任务编辑使用语义表单、内联校验和提交中状态', () => {
  assert.match(html, /id="modal-mask" aria-hidden="true">\s*<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">/);
  assert.match(html, /<form id="task-form" novalidate>/);
  assert.match(html, /id="m-title"[^>]+required aria-describedby="m-title-error"/);
  assert.match(html, /id="modal-error" role="alert"/);
  assert.match(html, /type="submit" class="btn" id="m-save"/);
  assert.match(app, /#task-form'\)\.addEventListener\('submit', saveModal\)/);
  assert.match(app, /save\.setAttribute\('aria-busy', String\(busy\)\)/);
  assert.match(app, /restoreModalFocus\(\)/);
  assert.match(app, /shouldComplete = data\.status === 'done'/);
  assert.match(app, /completion = await window\.api\.tasks\.saveAndComplete\(editingTask \? editingTask\.id : null, data\)/);
  assert.match(main, /ipcMain\.handle\('tasks:saveAndComplete', \(e, id, data\) => store\.saveAndCompleteTask\(id, data\)\)/);
  assert.match(preload, /saveAndComplete: \(id, data\) => ipcRenderer\.invoke\('tasks:saveAndComplete', id, data\)/);

  const title = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, focus() {} };
  const error = { textContent: '', classList: fakeClassList(['hidden']) };
  const run = loadRendererRuntime({ '#m-title': title, '#m-title-error': error });
  run(`setTitleError('请输入任务标题')`);
  assert.strictEqual(title.attrs['aria-invalid'], 'true');
  assert.strictEqual(error.textContent, '请输入任务标题');
  assert.strictEqual(error.classList.contains('hidden'), false);
  run(`setTitleError('')`);
  assert.strictEqual(title.attrs['aria-invalid'], 'false');
  assert.strictEqual(error.classList.contains('hidden'), true);
});

test('确认框遵循安全的原生键盘行为', () => {
  assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text"/);
  assert.match(app, /if \(e\.key === 'Tab'\) trapFocus\(mask, e\)/);
  assert.doesNotMatch(app, /if \(e\.key === 'Enter'\) \{ onOkClick\(\); \}/);
});

test('所有界面完成入口复用重复任务完成语义', () => {
  assert.match(app, /if \(col\.dataset\.col === 'done'\) \{\s*await toggleDone\(t\)/);
  assert.match(app, /if \(next === 'done'\) await toggleDone\(t\)/);
  assert.match(app, /if \(t\.status === 'done'\) \{\s*await window\.api\.tasks\.update\(t\.id, \{ status: 'todo' \}\)/);
});

test('批量模式显式进入，只保留当前可见任务并禁用空操作', () => {
  assert.match(html, /id="btn-select-mode" aria-pressed="false">批量操作/);
  assert.match(html, /id="batch-bar"[\s\S]*?<div class="view-body" id="tasks-list">/);
  assert.match(html, /id="batch-done" disabled/);
  assert.match(html, /id="batch-delete" disabled/);
  assert.match(app, /visibleTaskIds = list\.map\(\(t\) => t\.id\)/);
  assert.match(app, /selectedIds = new Set\(\[\.\.\.selectedIds\]\.filter\(\(id\) => visibleSet\.has\(id\)\)\)/);
  assert.match(app, /completableCount = tasks\.filter\(\(t\) => selectedIds\.has\(t\.id\) && t\.status !== 'done' && t\.status !== 'archived'\)\.length/);
  assert.match(app, /window\.api\.tasks\.batchComplete\(ids\)/);
  assert.match(app, /function setBatchMode\(enabled, shouldRender = true\)/);
  assert.match(app, /class="task-main"\$\{batchMode \? ' inert' : ''\}/);
  assert.match(app, /\.task-row\[data-id="\$\{id\}"\] \.task-check/);
  assert.match(app, /if \(active\) active\.focus\(\)/);
  assert.match(css, /\.task-row\.selecting \.task-check \{[\s\S]*?background: transparent; animation: none;/);
  assert.match(css, /\.batch-bar \{\s*position: sticky; top: 0; margin-bottom: 12px;/);
});

test('批量栏实际按可完成任务数更新状态', () => {
  const classes = new Set(['hidden']);
  const elements = {
    '#batch-bar': { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
    '#batch-count': { textContent: '' },
    '#batch-done': { disabled: true, textContent: '', title: '' },
    '#batch-pri': { disabled: true },
    '#batch-delete': { disabled: true },
    '#batch-select-all': { disabled: true, textContent: '' }
  };
  const run = loadRendererRuntime(elements);

  run(`
    tasks = [
      { id: 1, status: 'todo' },
      { id: 2, status: 'done' },
      { id: 3, status: 'archived' }
    ];
    batchMode = true;
    visibleTaskIds = [1, 2, 3];
    selectedIds = new Set([1, 2, 3]);
    renderBatchBar();
  `);

  assert.strictEqual(classes.has('hidden'), false);
  assert.strictEqual(elements['#batch-count'].textContent, '已选 3 项');
  assert.strictEqual(elements['#batch-done'].disabled, false);
  assert.strictEqual(elements['#batch-done'].textContent, '✓ 完成 1 项');
  assert.strictEqual(elements['#batch-done'].title, '已完成或已归档任务将自动跳过');

  run(`selectedIds = new Set([2, 3]); renderBatchBar();`);
  assert.strictEqual(elements['#batch-done'].disabled, true);
  assert.strictEqual(elements['#batch-done'].textContent, '✓ 完成');
});

test('真实模型设置明确数据范围并校验自定义服务地址', () => {
  assert.match(app, /最多 30 条未归档任务摘要会发送给所选服务商/);
  assert.match(app, /settings\.aiProvider !== 'custom' \|\| !!settings\.aiBaseUrl/);
  assert.match(app, /s\.aiStage === 'llm'/);
});

test('助手输入支持多行、提交中状态和失败重试', () => {
  assert.match(html, /id="ai-chat" role="log"[^>]+aria-live="polite"[^>]+aria-busy="false"/);
  assert.match(html, /<form class="ai-input-row" id="ai-form">\s*<textarea id="ai-input" rows="1" maxlength="1000"/);
  assert.match(app, /#ai-form'\)\.addEventListener\('submit'/);
  assert.match(app, /e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.isComposing/);
  assert.match(app, /if \(!raw \|\| aiSending\) return/);
  assert.match(app, /pending\.querySelector\('\.msg-text'\)\.textContent = `暂时没有处理成功/);
  assert.match(app, /function retryAction\(retry\)/);
  assert.match(app, /actions\.remove\(\);\s*retry\(\)/);
  assert.match(app, /操作已完成，但任务列表刷新失败/);
  assert.match(css, /\.ai-input-row textarea \{/);

  const attrs = {};
  const send = { disabled: false, textContent: '' };
  const run = loadRendererRuntime({
    '#ai-chat': { setAttribute: (name, value) => { attrs[name] = value; } },
    '#ai-send': send
  });
  run('setAiBusy(true)');
  assert.strictEqual(attrs['aria-busy'], 'true');
  assert.strictEqual(send.disabled, true);
  assert.strictEqual(send.textContent, '处理中');
  run('setAiBusy(false)');
  assert.strictEqual(send.textContent, '发送');
});

test('助手刷新失败不重新执行命令，重试操作触发后立即消费', async () => {
  const makeElement = () => ({
    children: [],
    listeners: {},
    removed: false,
    appendChild(child) { this.children.push(child); },
    setAttribute() {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    remove() { this.removed = true; }
  });
  const input = { focus() {} };
  const run = loadRendererRuntime({ '#ai-input': input, __createElement: makeElement });

  const retryBar = run(`retryAction(() => { globalThis.__retryCount = (globalThis.__retryCount || 0) + 1; })`);
  retryBar.children[0].listeners.click();
  assert.strictEqual(retryBar.removed, true);
  assert.strictEqual(run('globalThis.__retryCount'), 1);

  const busyBar = run(`aiSending = true; turnActions([{ label: '候选', run() {} }])`);
  assert.strictEqual(busyBar.children[0].disabled, true);
  run('aiSending = false');

  await run(`(async () => {
    const message = { textContent: '' };
    const pending = {
      classList: { add() {}, remove() {} },
      querySelector() { return message; },
      appendChild() {}
    };
    let requested = 0;
    let retryShown = 0;
    const notices = [];
    addMsg = () => pending;
    setAiBusy = () => {};
    scrollChat = () => {};
    retryAction = () => { retryShown += 1; return {}; };
    refreshTasks = async () => { throw new Error('刷新中断'); };
    toast = (text) => { notices.push(text); };
    await runAiTurn(async () => {
      requested += 1;
      return { type: 'info', message: '操作成功' };
    }, () => {});
    globalThis.__turnResult = { requested, retryShown, notices, message: message.textContent };
  })()`);
  const result = JSON.parse(run('JSON.stringify(globalThis.__turnResult)'));
  assert.strictEqual(result.requested, 1);
  assert.strictEqual(result.retryShown, 0);
  assert.strictEqual(result.message, '操作成功');
  assert.match(result.notices[0], /任务列表刷新失败/);
});

test('助手歧义选择走结构化解析，并提供上下文下一步', () => {
  assert.match(main, /ipcMain\.handle\('ai:resolve'/);
  assert.match(preload, /resolve: \(intent, params, taskId, label\) => ipcRenderer\.invoke\('ai:resolve'/);
  assert.match(app, /window\.api\.ai\.resolve\(/);
  assert.match(app, /result\.type === 'ask' && result\.candidates/);
  assert.match(css, /\.turn-actions \{/);

  const run = loadRendererRuntime({});
  const followUps = JSON.parse(run(`JSON.stringify(getFollowUps({ type: 'complete' }))`));
  assert.deepStrictEqual(followUps, [{ label: '安排剩余任务', prompt: '怎么安排今天的优先级' }]);
  assert.strictEqual(
    run(`candidateLabel({ title: '季度方案', project: 'Q3', due: '2026-08-20 18:00', status: 'doing' })`),
    '季度方案 · ◈ Q3 · 2026-08-20 18:00 · 进行中'
  );
});

test('对话消息支持选择、按钮复制和原生右键复制', async () => {
  assert.match(css, /\.msg-text \{[^}]*user-select: text;[^}]*-webkit-user-select: text;/);
  assert.match(app, /copy\.className = 'msg-copy'/);
  assert.match(app, /copy\.setAttribute\('aria-label', '复制消息'\)/);
  assert.match(main, /mainWindow\.webContents\.on\('context-menu'/);
  assert.match(main, /params\.selectionText[\s\S]*?\{ label: '复制', role: 'copy' \}/);

  let copied = '';
  const button = {
    textContent: '⧉',
    title: '复制消息',
    classList: fakeClassList()
  };
  const run = loadRendererRuntime({
    __navigator: { clipboard: { writeText: async (text) => { copied = text; } } },
    __setTimeout: () => 1,
    __testValues: { button, body: { textContent: '可复制的助手回复' } }
  });
  await run('copyMessageText(testValues.button, testValues.body)');
  assert.strictEqual(copied, '可复制的助手回复');
  assert.strictEqual(button.textContent, '✓');
  assert.strictEqual(button.title, '已复制');
  assert.strictEqual(button.classList.contains('copied'), true);
});

test('桌宠点击弹窗展示任务摘要、快捷操作并与提醒气泡互斥', async () => {
  assert.match(petHtml, /id="pet-menu" role="dialog"[^>]+aria-hidden="true"/);
  assert.match(petHtml, /class="pm-primary"[\s\S]*?data-pet="new"[\s\S]*?data-pet="ai"/);
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet=/g) || []).length, 6);
  assert.match(petHtml, /id="pet" role="button" tabindex="0"[^>]+aria-expanded="false"/);
  assert.match(petCss, /\.pm-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(petCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(main, /if \(view === 'new'\) \{\s*if \(mainWindow\) mainWindow\.webContents\.send\('app:new-task'\)/);

  const elements = {
    pet: fakePetElement(),
    'pet-wrap': fakePetElement(),
    'pet-bubble': fakePetElement(['hidden']),
    'pet-menu': fakePetElement(['hidden']),
    'pet-menu-close': fakePetElement(),
    'pet-menu-count': fakePetElement(),
    'pet-menu-next': fakePetElement(),
    'pet-sprite': fakePetElement()
  };
  const firstAction = fakePetElement();
  elements['pet-menu'].querySelector = () => firstAction;
  const { run } = loadPetRuntime(elements, []);
  await Promise.resolve();

  run(`statusSnapshot = {
    todo: 3,
    overdue: 1,
    next: { title: '提交周报', due: '2026-08-19 18:00' }
  }; renderStatus(); setMenuOpen(true, false);`);
  assert.strictEqual(elements['pet-menu-count'].textContent, '3 项待办');
  assert.match(elements['pet-menu-next'].textContent, /逾期 1 项.*提交周报/);
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), false);
  assert.strictEqual(elements.pet.attrs['aria-expanded'], 'true');
  assert.strictEqual(firstAction.focused, true);

  run(`showBubble('截止时间到了', true, 3000)`);
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), true);
  assert.strictEqual(elements['pet-bubble'].classList.contains('hidden'), true);

  elements.pet.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), false);
});

test('主题和 AI 引擎分段控件暴露并同步选中状态', () => {
  assert.match(app, /id="theme-seg" role="radiogroup" aria-label="外观主题"/);
  assert.match(app, /id="ai-stage-seg" role="radiogroup" aria-label="AI 助手引擎"/);
  assert.ok((app.match(/role="radio" aria-checked=/g) || []).length >= 5);
  assert.ok((app.match(/setAttribute\('aria-checked', 'false'\)/g) || []).length >= 2);
  assert.ok((app.match(/setAttribute\('aria-checked', 'true'\)/g) || []).length >= 2);
});

test('界面样式包含窄容器和低动态偏好支持', () => {
  assert.match(css, /@container \(max-width: 560px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.task-row:focus-within \.row-actions/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient\(/);
});

test('暗色搜索聚焦保持深色背景，主操作色满足白字对比度', () => {
  assert.match(css, /body\.dark \.task-tools #search-input:focus,\s*body\.dark \.quick-add input:focus \{ background: var\(--bg2\); \}/);

  const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const dark = css.match(/body\.dark\s*\{([\s\S]*?)\}/)[1];
  assert.ok(contrastRatio(cssVar(root, 'grad'), '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio(cssVar(dark, 'grad'), '#FFFFFF') >= 4.5);
});
