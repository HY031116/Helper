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
      getElementById: (id) => elements['#' + id] || elements[id] || null,
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
      body: fakePetElement(),
      getElementById: (id) => elements[id],
      addEventListener: (name, listener) => { documentListeners[name] = listener; }
    },
    window: {
      api: {
        settings: { get: async () => ({ theme: 'auto' }) },
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
  assert.match(html, /id="sidebar-new" aria-label="新建任务"/);
  assert.match(html, /<button type="button" class="nav-item active"[^>]+aria-current="page"/);
  assert.doesNotMatch(html, /<div class="nav-item/);
  assert.match(html, /<div class="task-search-row">\s*<input id="search-input" type="search" aria-label="搜索任务"/);
  assert.match(html, /<div class="quick-add">\s*<input id="quick-input" aria-label="快速添加任务"/);
  assert.match(html, /id="btn-quick-add">快速添加<\/button>/);
  assert.match(html, /id="btn-new">详细创建<\/button>/);
  assert.match(app, /const content = \$\('\.content'\);\s*if \(content\) content\.scrollTop = 0/);
});

test('高频任务操作和设置开关暴露键盘与状态语义', () => {
  assert.match(app, /<button type="button" class="task-check"[^>]+aria-label=/);
  assert.match(app, /<button type="button" class="pri-dot p\$\{t\.pri\}"[^>]+data-pri-toggle/);
  assert.match(app, /class="task-expand\$\{[^}]+\}"[^>]+aria-expanded=/);
  assert.match(app, /class="tname task-title-btn" aria-expanded=/);
  assert.match(app, /role="switch" aria-checked=/);
  assert.match(html, /<button type="button" class="chip" data-prompt=/);
  assert.match(app, /<button type="button" class="fchip [^`]+aria-pressed=/);
  assert.match(app, /<button type="button" class="bc-card"[^>]+aria-label=/);
  assert.match(app, /<button type="button" class="\$\{cls\}" data-day=[^>]+aria-pressed=/);
});

test('快速添加同时支持按钮和回车，并防止重复提交', () => {
  assert.match(app, /async function createQuickTask\(\)/);
  assert.match(app, /if \(!raw \|\| button\.disabled\) return/);
  assert.match(app, /#btn-quick-add'\)\.addEventListener\('click', createQuickTask\)/);
  assert.match(app, /if \(e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);\s*createQuickTask\(\)/);
  assert.match(app, /toast\(`已创建「\$\{createdTitle\}」/);
  assert.match(app, /await refreshTasksAfterMutation\('任务已创建，但列表刷新失败'\)/);
});

test('任务写入成功与列表刷新失败使用独立反馈', () => {
  assert.match(app, /async function refreshTasksAfterMutation\(message\)[\s\S]*toast\(`\$\{message\}：\$\{error\.message\}`, 5000, null, 'warn'\)/);

  const quickFlow = app.match(/async function createQuickTask\(\) \{([\s\S]*?)\n  \}\n  \$\('#quick-input'\)/)[1];
  assert.ok(quickFlow.indexOf('toast(`已创建') < quickFlow.indexOf("await refreshTasksAfterMutation('任务已创建，但列表刷新失败')"));
  assert.match(quickFlow, /catch \(err\) \{\s*toast\('创建失败：'/);

  const modalFlow = app.slice(app.indexOf('async function saveModal(event)'), app.indexOf('async function deleteEditingTask'));
  assert.ok(modalFlow.indexOf("toast(`${wasEditing ? '已保存' : '已创建'}") < modalFlow.indexOf('await refreshTasksAfterMutation'));

  const memoFlow = app.slice(app.indexOf("$('#memo-to-task').addEventListener"), app.indexOf("$('#memo-delete').addEventListener"));
  assert.ok(memoFlow.indexOf('toast(`已创建任务') < memoFlow.indexOf('await refreshTasksAfterMutation'));
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
  assert.match(html, /id="modal-mask" aria-hidden="true">\s*<div class="modal task-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">/);
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

test('任务弹窗保护未保存内容并保证截止日期完整显示', () => {
  assert.match(html, /<div class="m-row due-tags-row">[\s\S]*?<div class="due-row">/);
  assert.match(css, /\.due-tags-row \{ flex-direction: column; gap: 0; \}/);
  assert.match(app, /let modalInitialSnapshot = ''/);
  assert.match(app, /function taskFormSnapshot\(\)/);
  assert.match(app, /function captureModalInitialState\(\)/);
  assert.match(app, /function isTaskModalDirty\(\)/);
  assert.match(app, /confirmDialog\('放弃尚未保存的更改吗？', async \(\) => closeModal\(\), '放弃'\)/);
  assert.match(app, /#m-cancel'\)\.addEventListener\('click', requestCloseModal\)/);
  assert.match(app, /#m-close'\)\.addEventListener\('click', requestCloseModal\)/);
  assert.match(app, /if \(e\.target === \$\('#modal-mask'\)\) requestCloseModal\(\)/);
  assert.match(app, /if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*requestCloseModal\(\)/);
  assert.match(app, /\$\('#m-due-time'\)\.value = '18:00';\s*captureModalInitialState\(\)/);
  assert.match(app, /console\.error\('\[task-modal\] save failed:', err\)/);
  assert.match(app, /setModalError\('保存失败，请稍后重试。任务内容仍保留在窗口中。'\)/);
});

test('确认框遵循安全的原生键盘行为', () => {
  assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text"/);
  assert.match(app, /if \(e\.key === 'Tab'\) trapFocus\(mask, e\)/);
  assert.doesNotMatch(app, /if \(e\.key === 'Enter'\) \{ onOkClick\(\); \}/);
  assert.match(app, /const onOkClick = async \(\) => \{/);
  assert.match(app, /title\.textContent = `确认\$\{actionText\}`/);
  assert.match(app, /okBtn\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /await onOk\(\);\s*cleanup\(\)/);
  assert.match(app, /console\.error\('\[confirm\] action failed:', error\)/);
  assert.match(app, /toast\('操作失败，请稍后重试', 4000, null, 'err'\)/);
});

test('设置中的破坏性任务操作均需确认且文案准确', () => {
  assert.match(app, /id="btn-reset">重置任务<\/button>/);
  assert.match(app, /#btn-reset'\)\.addEventListener\('click', \(\) => \{\s*confirmDialog\('确定用初始演示任务替换当前全部任务吗？/);
  assert.match(app, /备忘录不受影响。', async \(\) => \{\s*tasks = await window\.api\.tasks\.reset\(\)/);
  assert.match(app, /<div class="sr-t">清空全部任务<\/div>/);
  assert.match(app, /confirmDialog\('确定要清空全部任务吗？此操作不可恢复，备忘录不受影响。'/);
  assert.match(app, /}, '清空任务'\)/);
  assert.doesNotMatch(app, /<div class="sr-t">清空全部数据<\/div>/);
});

test('通知中的撤销操作可聚焦并防止重复执行', () => {
  assert.match(app, /el\.setAttribute\('role', type === 'err' \? 'alert' : 'status'\)/);
  assert.match(app, /el\.setAttribute\('aria-atomic', 'true'\)/);
  assert.match(app, /const b = document\.createElement\('button'\);\s*b\.type = 'button';\s*b\.className = 't-undo'/);
  assert.match(app, /if \(b\.disabled\) return;\s*b\.disabled = true;/);
  assert.match(app, /await a\.run\(\);\s*el\.remove\(\)/);
  assert.match(app, /text\.textContent = String\(message == null \? '' : message\)/);
  assert.match(app, /icon\.setAttribute\('aria-hidden', 'true'\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function toast('), app.indexOf("if (typeof window.addEventListener")), /innerHTML/);
  assert.match(css, /\.toast \.t-undo:focus-visible/);
  assert.match(css, /max-width: calc\(100vw - 32px\)/);
  assert.match(css, /\.toast > span:not\(\.t-ico\).*overflow-wrap: anywhere/);
});

test('无独立错误面板的异步操作不会静默失败', () => {
  assert.match(app, /window\.addEventListener\('unhandledrejection'/);
  assert.match(app, /event\.preventDefault\(\)/);
  assert.match(app, /console\.error\('Unhandled renderer operation:', reason\)/);
  assert.match(app, /toast\('操作未完成，请稍后重试', 4500, null, 'err'\)/);
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
  assert.match(app, /trigger\.classList\.toggle\('hidden', enabled\)/);
  assert.match(app, /\$\('#view-tasks'\)\?\.classList\.toggle\('batch-mode', enabled\)/);
  assert.match(css, /#view-tasks\.batch-mode \.toolbar \{ display: none; \}/);
  assert.match(css, /\.task-row\.selecting \.row-actions \{ display: none; \}/);
  assert.match(css, /\.batch-bar \{\s*position: sticky; top: 0; margin-bottom: 12px;/);
});

test('快捷键设置使用友好显示且聚焦时保留原值', () => {
  assert.match(app, /function shortcutLabel\(accelerator\)/);
  assert.match(app, /part === 'CommandOrControl'\) return isMac \? '⌘' : 'Ctrl'/);
  assert.match(app, /function shortcutRow\(id, label, accelerator\)/);
  assert.match(app, /data-accelerator="\$\{esc\(accelerator\)\}"/);
  assert.match(app, /el\.placeholder = '按下新组合键…';\s*el\.select\(\)/);
  assert.doesNotMatch(app, /el\.addEventListener\('focus',[\s\S]*?el\.value = ''/);
  assert.match(app, /\['Control', 'Alt', 'Shift', 'Meta'\]\.includes\(e\.key\)/);
  assert.match(app, /<p class="set-group-intro">全局有效。聚焦输入框后，直接按下新的组合键。<\/p>/);
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
  assert.match(app, /当前输入、最近 6 轮对话、最多 30 条未归档任务和 20 条备忘录摘要会发送给所选服务商/);
  assert.match(app, /settings\.aiProvider !== 'custom' \|\| !!settings\.aiBaseUrl/);
  assert.match(app, /s\.aiStage === 'llm'/);
});

test('助手输入支持多行、提交中状态和失败重试', () => {
  assert.match(html, /id="ai-chat" role="log"[^>]+aria-live="polite"[^>]+aria-busy="true"/);
  assert.match(html, /<form class="ai-input-row" id="ai-form">\s*<textarea id="ai-input" rows="1" maxlength="1000"/);
  assert.match(app, /#ai-form'\)\.addEventListener\('submit'/);
  assert.match(app, /e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.isComposing/);
  assert.match(app, /if \(!raw \|\| aiSending\) return/);
  assert.match(app, /pending\.querySelector\('\.msg-text'\)\.textContent = assistantRequestFailureMessage\(\)/);
  assert.doesNotMatch(app, /暂时没有处理成功：\$\{e\.message\}/);
  assert.match(app, /function retryAction\(retry\)/);
  assert.match(app, /actions\.remove\(\);\s*retry\(\)/);
  assert.match(app, /操作已完成，但任务列表没有刷新。请稍后重新打开当前视图。/);
  assert.match(app, /result\.degradeNotice \|\| '模型服务短暂异常，本轮已由本地助手继续处理'/);
  assert.match(app, /memo_split: '已拆成任务'/);
  assert.match(css, /\.ai-input-row textarea \{/);
  assert.match(app, /#ai-chat'\)\.setAttribute\('aria-busy', 'false'\)/);

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

  assert.strictEqual(
    run(`settings = { aiStage: 'llm' }; assistantRequestFailureMessage()`),
    '模型暂时没有响应。请检查网络和模型配置后重试。'
  );
  assert.strictEqual(
    run(`settings = { aiStage: 'mock' }; assistantRequestFailureMessage()`),
    '助手暂时没有响应。请重试一次。'
  );
});

test('助手面板宽度在窄窗口受限并支持键盘调节', () => {
  assert.match(app, /handle\.setAttribute\('role', 'separator'\)/);
  assert.match(app, /handle\.setAttribute\('aria-label', '调整助手面板宽度'\)/);
  assert.match(app, /window\.innerWidth - 540/);
  assert.match(app, /e\.key === 'ArrowLeft' \? 16 : -16/);
  assert.match(app, /window\.addEventListener\('resize'/);
  assert.match(css, /\.ai-resize:focus-visible/);
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
  assert.match(result.notices[0], /任务列表没有刷新/);
});

test('助手歧义选择走结构化解析，并提供上下文下一步', () => {
  assert.match(main, /ipcMain\.handle\('ai:resolve'/);
  assert.match(preload, /resolve: \(intent, params, taskId, label\) => ipcRenderer\.invoke\('ai:resolve'/);
  assert.match(app, /window\.api\.ai\.resolve\(/);
  assert.match(app, /result\.type === 'ask' && result\.candidates/);
  assert.match(css, /\.turn-actions \{/);

  const run = loadRendererRuntime({});
  const followUps = JSON.parse(run(`JSON.stringify(getFollowUps({
    type: 'complete',
    followUps: [
      { label: '开始下一项', prompt: '开始 季度方案' },
      { label: 123, prompt: '无效建议' },
      { label: '重新安排', prompt: '怎么安排今天的优先级' },
      { label: '不会展示', prompt: '查看我的任务' }
    ]
  }))`));
  assert.deepStrictEqual(followUps, [
    { label: '开始下一项', prompt: '开始 季度方案' },
    { label: '重新安排', prompt: '怎么安排今天的优先级' }
  ]);
  assert.deepStrictEqual(JSON.parse(run(`JSON.stringify(getFollowUps({ type: 'complete' }))`)), []);
  assert.match(app, /function clearTurnActions\(\)/);
  assert.match(app, /clearTurnActions\(\);\s*addMsg\('user', label\)/);
  assert.match(app, /if \(!raw \|\| aiSending\) return;\s*clearTurnActions\(\);/);
  assert.strictEqual(
    run(`candidateLabel({ title: '季度方案', project: 'Q3', due: '2026-08-20 18:00', status: 'doing' })`),
    '季度方案 · ◈ Q3 · 2026-08-20 18:00 · 进行中'
  );
  assert.strictEqual(
    run(`candidateLabel({ title: '客户记录', entityType: 'memo', pinned: true, preview: '等待确认预算' })`),
    '客户记录 · 置顶 · 等待确认预算'
  );
  assert.match(app, /memo_delete: '已删除备忘录'/);
  assert.match(app, /memo_to_task: '已转为任务'/);
  assert.match(app, /Promise\.all\(\[refreshTasks\(\), refreshMemos\(\)\]\)/);
  assert.match(app, /String\(result\.type\)\.startsWith\('memo_'\)/);
});

test('助手确认与澄清状态提供明确的继续操作', () => {
  assert.match(app, /result\.type === 'confirm'/);
  assert.match(app, /label: '确认执行', run: \(\) => sendPrompt\('确认执行'\)/);
  assert.match(app, /label: '取消', run: \(\) => sendPrompt\('取消'\)/);
  assert.match(app, /result\.type === 'clarify'/);
  assert.match(app, /继续补充刚才缺少的信息/);
});

test('对话消息支持选择、按钮复制和原生右键复制', async () => {
  assert.match(css, /\.msg-text \{[^}]*user-select: text;[^}]*-webkit-user-select: text;/);
  assert.match(css, /\.msg-copy \{[^}]*width: 24px; height: 24px;[^}]*opacity: 0\.5;/);
  assert.match(app, /copy\.className = 'msg-copy'/);
  assert.match(app, /copy\.setAttribute\('aria-label', '复制消息'\)/);
  assert.match(app, /copy\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(app, /toast\('复制失败，请重试'/);
  assert.doesNotMatch(app, /toast\(`复制失败：\$\{esc\(e\.message\)\}`/);
  assert.match(main, /mainWindow\.webContents\.on\('context-menu'/);
  assert.match(main, /params\.selectionText[\s\S]*?\{ label: '复制', role: 'copy' \}/);

  let copied = '';
  const attrs = {};
  const button = {
    textContent: '⧉',
    title: '复制消息',
    classList: fakeClassList(),
    setAttribute(name, value) { attrs[name] = value; }
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
  assert.strictEqual(attrs['aria-label'], '已复制');
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
  assert.match(html, /id="ai-collapse"[^>]+aria-expanded="true"/);
  assert.match(app, /control\.setAttribute\('aria-expanded', String\(!collapsed\)\)/);
  assert.match(app, /systemTheme\.addEventListener\('change'/);
});

test('分段控件支持方向键移动并维持单一 Tab 停靠点', () => {
  let radios;
  const makeRadio = (checked) => {
    const attrs = { 'aria-checked': String(checked) };
    const listeners = {};
    return {
      attrs,
      listeners,
      tabIndex: null,
      focused: false,
      getAttribute(name) { return attrs[name]; },
      addEventListener(name, listener) { listeners[name] = listener; },
      focus() { this.focused = true; },
      click() {
        radios.forEach((radio) => { radio.attrs['aria-checked'] = 'false'; });
        attrs['aria-checked'] = 'true';
        listeners.click();
      }
    };
  };
  radios = [makeRadio(true), makeRadio(false), makeRadio(false)];
  const group = { querySelectorAll: () => radios };
  const run = loadRendererRuntime({ __testValues: { group } });
  run('bindRadioGroupKeyboard(testValues.group)');
  assert.deepStrictEqual(radios.map((radio) => radio.tabIndex), [0, -1, -1]);

  let prevented = false;
  radios[0].listeners.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.strictEqual(radios[1].focused, true);
  assert.deepStrictEqual(radios.map((radio) => radio.tabIndex), [-1, 0, -1]);
});

test('无历史对话时助手直接汇报工作状态', () => {
  assert.match(app, /const overdue = active\.filter/);
  assert.match(app, /当前有 \$\{overdue\.length\} 项逾期任务/);
  assert.doesNotMatch(app, /想记点什么？直接说就行，例如/);
});

test('界面样式包含窄容器和低动态偏好支持', () => {
  assert.match(css, /@container \(max-width: 560px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.task-row:focus-within \.row-actions/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient\(/);
  assert.match(css, /\.board-cols \{[^}]*overflow-x: auto;/);
  assert.match(css, /@container \(max-width: 560px\)[\s\S]*?\.trash-row \{ grid-template-columns: 1fr; align-items: start; \}/);
});

test('窗口控件和任务弹窗提供明确语义与小窗布局', () => {
  assert.match(html, /id="tb-min"[^>]+aria-label="最小化窗口"/);
  assert.match(html, /id="tb-max"[^>]+aria-label="最大化窗口"/);
  assert.match(html, /id="m-close"[^>]+aria-label="关闭任务编辑"/);
  assert.match(app, /#m-close'\)\.addEventListener\('click', requestCloseModal\)/);
  assert.match(app, /returnFocus\.isConnected && !returnFocus\.closest\('\.hidden'\)/);
  assert.match(app, /setAttribute\('aria-label', maximized \? '还原窗口' : '最大化窗口'\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.m-row \{ flex-direction: column; gap: 0; \}/);
  assert.match(css, /\.modal > h5 \{ margin-bottom: 14px; \}/);
  assert.match(css, /\.task-detail \{[\s\S]*?background: transparent;[\s\S]*?border-left: 2px solid/);
});

test('任务弹窗固定操作区并让字段区独立滚动', () => {
  assert.match(html, /class="modal task-modal" role="dialog"/);
  assert.match(html, /<form id="task-form" novalidate>\s*<div class="task-modal-fields">[\s\S]*?<div class="m-actions">/);
  assert.match(css, /\.task-modal \{[^}]*display: flex;[^}]*overflow: hidden;/);
  assert.match(css, /\.task-modal-fields \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.task-modal \.m-actions \{[^}]*flex: 0 0 auto;[^}]*border-top: 1px solid var\(--rule\);/);
});

test('界面颜色与间距由统一设计令牌驱动', () => {
  assert.match(css, /--accent-hover: #AC4938/);
  assert.match(css, /--muted-rgb: 102, 113, 127/);
  assert.match(css, /--control-md: 36px/);
  assert.doesNotMatch(css, /rgba\((?:196, 69, 59|199, 138, 43|62, 142, 90|122, 111, 96|240, 140, 80)/);
  assert.doesNotMatch(css, /#E8743B/i);
  assert.doesNotMatch(app, /badge\.style\.(?:background|color|borderColor)/);
  assert.match(app, /const stateClass = stage === 'llm'/);
});

test('统计图表模板保持有效的容器闭合结构', () => {
  const renderStatSource = app.slice(app.indexOf('function renderStat()'), app.indexOf('/* ---------- 视图：设置 ---------- */'));
  assert.match(renderStatSource, /<div class="trend-column" role="listitem"[\s\S]*?<span class="trend-label" aria-hidden="true">\$\{days\[i\]\}<\/span>\s*<\/div>`\)\.join/);
  assert.doesNotMatch(renderStatSource, /<\/button>`\)\.join/);
  assert.match(renderStatSource, /<section class="stat-panel">[\s\S]*?标签完成率[\s\S]*?<\/section>\s*<\/div>`;/);
});

test('统计与周报提供准确图表语义、空状态和完整操作反馈', () => {
  const renderStatSource = app.slice(app.indexOf('function weeklyReportFileName'), app.indexOf('/* ---------- 视图：设置 ---------- */'));
  assert.match(renderStatSource, /<dl class="stat-grid">[\s\S]*?<dt class="sc-t">任务总数<\/dt><dd class="sc-v">/);
  assert.match(renderStatSource, /class="trend-chart" role="list"/);
  assert.match(renderStatSource, /role="meter" aria-label="\$\{PRI_NAME\[p\]\}任务占比"/);
  assert.match(renderStatSource, /--bar-h:\$\{v \? Math\.max\(4, v \/ maxTrend \* 120\) : 0\}px/);
  assert.match(css, /\.trend-bar \{[\s\S]*?min-height: 0;/);
  assert.match(renderStatSource, /class="empty stat-empty"[\s\S]*?id="stat-new-task">新建任务/);
  assert.match(renderStatSource, /id="report-week-seg" role="radiogroup" aria-label="周报周期"/);
  assert.match(renderStatSource, /role="radio" aria-checked="\$\{reportWeek === 0\}"/);
  assert.match(renderStatSource, /x\.setAttribute\('aria-checked', 'false'\)/);
  assert.match(renderStatSource, /\$\('#report-preview'\)\.textContent = ''/);
  assert.match(renderStatSource, /id="report-preview"[\s\S]*?role="region" aria-label="周报预览" tabindex="0"/);
  assert.match(renderStatSource, /generateBtn\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(renderStatSource, /preview\.focus\(\{ preventScroll: true \}\);\s*preview\.scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(renderStatSource, /console\.error\('\[report\] generation failed:', e\)/);
  assert.match(renderStatSource, /toast\('周报生成失败，请稍后重试'/);
  assert.match(renderStatSource, /copyBtn\.textContent = '已复制'/);
  assert.match(renderStatSource, /a\.download = weeklyReportFileName\(reportWeek\)/);
  assert.match(renderStatSource, /URL\.revokeObjectURL\(url\)/);
});

test('看板和日历的交互卡片保持有效的按钮闭合结构', () => {
  const boardSource = app.slice(app.indexOf('function renderBoard()'), app.indexOf('/* ---------- 视图：日历 ---------- */'));
  const calendarSource = app.slice(app.indexOf('function renderCal()'), app.indexOf('/* ---------- 视图：统计 ---------- */'));
  assert.match(boardSource, /<div class="bc-card-item" role="listitem">[\s\S]*?<button type="button" class="bc-card"[\s\S]*?<\/button>\s*<\/div>`\)\.join/);
  assert.doesNotMatch(boardSource, /<button type="button" class="bc-card"[\s\S]*?<\/button>\s*<\/button>/);
  assert.match(calendarSource, /\$\{dots \? `<span class="cal-dots">\$\{dots\}<\/span>` : ''\}\s*<\/button>`;/);
  assert.doesNotMatch(calendarSource, /\$\{dots \? `<span class="cal-dots">\$\{dots\}<\/span>` : ''\}\s*<\/div>`;/);
});

test('任务搜索、今日空态、看板与日历形成完整且一致的工作流', () => {
  const container = {
    innerHTML: '',
    querySelector(selector) {
      if (selector !== '#empty-clear-search') return null;
      return { addEventListener() {} };
    }
  };
  const runSearch = loadRendererRuntime({ __testValues: { container } });
  runSearch(`currentSearch = '不存在'; renderList(testValues.container, [])`);
  assert.match(container.innerHTML, /没有匹配的任务/);
  assert.match(container.innerHTML, /id="empty-clear-search">清除搜索/);
  assert.doesNotMatch(container.innerHTML, /还没有任务/);

  const results = {};
  const runCalendar = loadRendererRuntime({ __testValues: { results } });
  runCalendar(`tasks = [
    { id: 1, title: '可见任务', status: 'todo', due: '2026-08-20 12:00' },
    { id: 2, title: '归档任务', status: 'archived', due: '2026-08-20 12:00' },
    { id: 3, title: '已删除任务', status: 'todo', due: '2026-08-20 12:00', _deleted: true }
  ]; testValues.results.titles = tasksOnDay('2026-08-20').map((task) => task.title)`);
  assert.strictEqual(JSON.stringify(results.titles), JSON.stringify(['可见任务']));

  const boardSource = app.slice(app.indexOf('function renderBoard()'), app.indexOf('/* ---------- 视图：日历 ---------- */'));
  const boardEvents = app.slice(app.indexOf('// 看板拖拽'), app.indexOf('// 任务列表拖拽排序'));
  assert.match(html, /id="board-sub"/);
  assert.doesNotMatch(html, /拖拽卡片到目标列变更状态/);
  assert.match(boardSource, /<section class="board-col"[^>]+aria-labelledby="\$\{colId\}"/);
  assert.match(boardSource, /role="list" aria-label="\$\{col\.name\}任务"/);
  assert.match(boardSource, /class="board-empty"><span role="status">暂无\$\{col\.name\}任务/);
  assert.match(boardSource, /id="board-new-task">新建任务/);
  assert.match(boardSource, /\$\('#board-sub'\)\.textContent = cols\.map/);
  assert.match(boardEvents, /board\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(boardEvents, /console\.error\('\[board\] task move failed:', error\)/);
  assert.match(boardEvents, /toast\('移动任务失败，请稍后重试'/);
  assert.match(css, /\.board-cols \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(3, minmax\(150px, 1fr\)\)/);
  assert.match(css, /\.bc-card \.cb \{[^}]*align-items: flex-start;/);
  assert.match(css, /\.bc-card \.pri-dot \{[^}]*flex: 0 0 auto;/);
  assert.match(app, /id="today-empty-all">查看所有任务/);
  assert.match(app, /id="today-empty-new">新建任务/);
  assert.strictEqual((app.match(/#cal-body'\)\.addEventListener\('click', onCalClick\)/g) || []).length, 1);
  assert.match(app, /class="cal-title" aria-live="polite"/);
  assert.match(app, /class="cal-dot \$\{dotCls\}" aria-hidden="true"/);
});

test('响应式宽度不会覆盖助手折叠态', () => {
  assert.match(css, /\.ai-panel\.collapsed \{[^}]*width: 40px;[^}]*flex: 0 0 40px;/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.ai-panel:not\(\.collapsed\) \{ width: 288px; flex-basis: 288px; \}/);
  assert.match(css, /@media \(max-width: 960px\)[\s\S]*?\.ai-panel:not\(\.collapsed\) \{ width: 272px; flex-basis: 272px; \}/);
});

test('启动和异步数据读取提供加载、降级与重试状态', () => {
  assert.match(html, /<body aria-busy="true">/);
  assert.match(html, /id="today-list">[\s\S]*?class="load-state" role="status"/);
  assert.match(html, /id="memo-load-error"/);
  assert.match(app, /Promise\.allSettled\(\[/);
  assert.match(app, /dataLoadErrors\.tasks = tasksResult\.status === 'rejected'/);
  assert.match(app, /dataLoadErrors\.memos = memosResult\.status === 'rejected'/);
  assert.match(app, /function loadErrorHtml\(source, compact\)/);
  assert.match(app, /function applyDataLoadStates\(\)/);
  assert.match(app, /retryDataSource\(retry\.dataset\.retrySource, retry\)/);
  assert.match(app, /if \(view === 'trash'\) loadTrash\(\);\s*applyDataLoadStates\(\)/);
  assert.match(app, /list\.innerHTML = loadErrorHtml\('trash'\)/);
  assert.match(css, /\.load-state\.error \{/);
  assert.match(css, /@keyframes loadSpin/);
});

test('设置操作失败时恢复原状态并结束忙碌反馈', () => {
  assert.match(app, /设置保存失败，已恢复原状态/);
  assert.match(app, /sw\.classList\.toggle\('on', previous\)/);
  assert.match(app, /AI 引擎切换失败，已恢复原设置/);
  assert.match(app, /主题保存失败，已恢复原设置/);
  assert.match(app, /测试失败，请检查配置或网络/);
  assert.match(app, /box\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /box\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(app, /await window\.api\.data\.openDir\(\)/);
  assert.match(app, /无法打开数据文件夹，请稍后重试/);
  assert.match(app, /button\.textContent = '打开中…'/);
  assert.match(app, /button\.textContent = '打开文件夹'/);
  assert.match(main, /ipcMain\.handle\('data:openDir'[\s\S]*?shell\.openPath\(store\.getDataDir\(\)\)/);
  assert.match(preload, /openDir: \(\) => ipcRenderer\.invoke\('data:openDir'\)/);
  assert.doesNotMatch(app, /id="btn-pick-dir"/);
  assert.doesNotMatch(main, /ipcMain\.handle\('data:pickDir'/);
  assert.doesNotMatch(preload, /pickDir: \(\) => ipcRenderer\.invoke\('data:pickDir'\)/);
});

test('设置、统计与回收站补齐标签、键盘退出和可恢复状态', () => {
  assert.match(html, /id="stat-sub" aria-live="polite"/);
  assert.match(html, /id="trash-sub" aria-live="polite"/);
  ['ai-provider', 'ai-base-url', 'ai-api-key', 'ai-model', 'ai-temperature'].forEach((id) => {
    assert.match(app, new RegExp(`<label class="sr-t" for="${id}">`));
    assert.match(app, new RegExp(`id="${id}"[^>]+aria-describedby="${id}-desc"`));
  });
  assert.match(app, /Number\.isFinite\(temperature\) \? temperature : 0\.2/);
  assert.match(app, /if \(e\.key === 'Tab'\) return/);
  assert.match(app, /if \(e\.key === 'Escape'\)[\s\S]*?el\.blur\(\)/);
  assert.match(app, /快捷键保存失败，已恢复原设置/);
  assert.match(app, /function runSettingsAction\(button, busyText, action, failureMessage\)/);
  assert.match(app, /function downloadSettingsFile\(content, type, fileName\)[\s\S]*?URL\.revokeObjectURL\(url\)/);
  assert.match(app, /id="backup-retry">重试/);
  assert.match(app, /class="trend-chart is-empty" role="status">近 7 天还没有完成记录/);
  assert.match(css, /\.trend-chart\.is-empty \{[^}]*height: 96px;/);
  assert.match(app, /function focusTrashAfterMutation\(rowIndex\)/);
  assert.match(app, /focusTrashAfterMutation\(rowIndex\)/);
  assert.match(app, /#trash-sub'\)\.textContent = `\$\{total\} 项内容/);
});

test('回收站明确删除时间、单项永久删除和部分失败状态', () => {
  assert.match(app, /function trashDeletedTime\(item\)/);
  assert.match(app, /`删除于 \$\{memoTime\(item\.deletedAt\)\}`/);
  assert.match(app, /list\.setAttribute\('role', 'list'\)/);
  assert.match(app, /class="trash-row" role="listitem"/);
  assert.match(app, /data-purge-task="\$\{t\.id\}" aria-label="永久删除任务/);
  assert.match(app, /data-purge-memo="\$\{memo\.id\}" aria-label="永久删除备忘录/);
  assert.match(app, /window\.api\.tasks\.purge\(id\)/);
  assert.match(app, /window\.api\.memos\.purge\(id\)/);
  assert.match(app, /确定永久删除回收站中的 \$\{summary\}吗？此操作不可恢复。/);
  assert.match(app, /const summary = parts\.join\('、'\) \|\| '全部内容'/);
  assert.match(app, /const results = await Promise\.allSettled\(\[/);
  assert.match(app, /部分内容已永久删除，其余内容未能清空。请重试。/);
  assert.match(main, /ipcMain\.handle\('tasks:purge'/);
  assert.match(main, /ipcMain\.handle\('memos:purge'/);
  assert.match(preload, /purge: \(id\) => ipcRenderer\.invoke\('tasks:purge', id\)/);
  assert.match(preload, /purge: \(id\) => ipcRenderer\.invoke\('memos:purge', id\)/);
  assert.match(css, /\.trash-row \{[\s\S]*?display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.btn\.trash-restore \{[^}]*color: var\(--ok\)/);
});

test('数据导入区分解析、部分写入与刷新结果', () => {
  assert.match(app, /importButton\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /无法读取导入文件/);
  assert.match(app, /任务导入失败/);
  assert.match(app, /已导入 \$\{imported\.length\} 条任务，但/);
  assert.match(app, /refreshTasksAfterMutation\('任务已导入，但列表刷新失败'\)/);
  assert.match(app, /refreshMemosAfterMutation\('备忘录已导入，但列表刷新失败'\)/);
  assert.match(app, /importButton\.setAttribute\('aria-busy', 'false'\)/);
  assert.doesNotMatch(app, /<button(?![^>]*type=)/);
});

test('备份恢复等待自动保存并独立处理界面重载', () => {
  assert.match(app, /async function reloadRestoredWorkspace\(result, label\)/);
  assert.match(app, /if \(memoSaveTimer\) clearTimeout\(memoSaveTimer\)/);
  assert.match(app, /const \[taskResult, memoResult, taskTrashResult, memoTrashResult\] = await Promise\.allSettled/);
  assert.match(app, /数据已经恢复，但界面未完整刷新/);
  assert.match(app, /if \(\(await saveMemoNow\(\)\) === false\) return;\s*const result = await window\.api\.data\.restoreBackup/);
  assert.match(app, /await reloadRestoredWorkspace\(result, '已恢复到备份点'\)/);
  assert.match(app, /await reloadRestoredWorkspace\(result, '已从文件恢复'\)/);
});

test('暗色搜索聚焦保持深色背景，主操作色满足白字对比度', () => {
  assert.match(css, /body\.dark \.task-tools #search-input:focus,\s*body\.dark \.quick-add input:focus \{ background: var\(--bg2\); \}/);

  const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const dark = css.match(/body\.dark\s*\{([\s\S]*?)\}/)[1];
  assert.ok(contrastRatio(cssVar(root, 'grad'), '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio(cssVar(dark, 'grad'), '#FFFFFF') >= 4.5);
});

test('备忘录工作区具备可访问导航、编辑与完整 IPC', () => {
  assert.match(html, /class="nav-item" data-view="memos"/);
  assert.match(html, /id="view-memos"/);
  assert.match(html, /id="memo-list" role="listbox"/);
  assert.match(html, /id="memo-content"[^>]+aria-label="备忘录正文"/);
  assert.match(html, /id="memo-pin"[^>]+aria-pressed="false"/);
  assert.match(main, /ipcMain\.handle\('memos:create'/);
  assert.match(main, /ipcMain\.handle\('memos:emptyTrash'/);
  assert.match(preload, /memos:\s*\{/);
  assert.match(preload, /update: \(id, patch\) => ipcRenderer\.invoke\('memos:update', id, patch\)/);
});

test('备忘录操作栏使用统一工具按钮并提供即时状态反馈', () => {
  assert.match(html, /class="memo-actions" role="group" aria-label="备忘录操作"/);
  assert.match(html, /class="memo-action-group"/);
  assert.match(html, /id="memo-copy" data-tooltip="复制" aria-label="复制备忘录"/);
  assert.match(html, /class="memo-tool memo-delete-tool" id="memo-delete" data-tooltip="删除"/);
  assert.match(html, /class="memo-task-action" id="memo-to-task"/);
  assert.match(css, /\.memo-tool\[data-tooltip\]::after/);
  assert.match(css, /\.memo-delete-tool:hover,[\s\S]*color: var\(--danger\)/);
  assert.match(app, /button\.classList\.add\('copied'\)/);
  assert.match(app, /label\.textContent = '创建中…'/);
  assert.match(app, /button\.disabled = true;[\s\S]*window\.api\.memos\.update/);
});

test('桌宠跟随应用主题并保留自动主题响应', () => {
  assert.match(main, /patch\.theme !== undefined && petWindow && !petWindow\.isDestroyed\(\)/);
  assert.match(main, /webContents\.send\('pet:theme', s\.theme\)/);
  assert.match(preload, /'pet:theme'/);
  assert.match(petApp, /window\.api\.settings\.get\(\)/);
  assert.match(petApp, /window\.api\.on\('pet:theme', applyTheme\)/);
  assert.match(petApp, /themePreference === 'auto' && systemTheme\.matches/);
  assert.match(petCss, /body\.dark\s*\{/);
  assert.doesNotMatch(petCss, /@media \(prefers-color-scheme: dark\)/);
});

test('备忘录支持防串写自动保存、转任务与统一回收站', () => {
  assert.match(app, /const id = selectedMemoId;[\s\S]*memoSaveChain = memoSaveChain\.then/);
  assert.match(app, /if \(currentView === 'memos' && view !== 'memos'\) saveMemoNow\(\)/);
  assert.match(app, /window\.api\.tasks\.create\(\{ title: memo\.title, desc: memo\.content, tags: memo\.tags/);
  assert.match(app, /window\.api\.memos\.emptyTrash\(\)/);
  assert.match(css, /\.memo-list-item\.pinned::before/);
  assert.match(css, /\.memo-content \{[\s\S]*user-select: text;/);
});

test('备忘录列表在运行时支持置顶排序展示和标签解析', () => {
  const list = { innerHTML: '' };
  const sub = { textContent: '' };
  const run = loadRendererRuntime({ '#memo-list': list, '#memos-sub': sub });
  const tags = JSON.parse(run(`JSON.stringify(parseMemoTags('工作， 灵感,产品  复盘'))`));
  assert.deepStrictEqual(tags, ['工作', '灵感', '产品', '复盘']);
  run(`memos = [
    { id: 2, title: '普通记录', content: '稍后处理', tags: [], pinned: false, updatedAt: Date.now() - 1000 },
    { id: 1, title: '重点记录', content: '优先查看', tags: ['工作'], pinned: true, updatedAt: Date.now() }
  ]; selectedMemoId = 1; renderMemoList();`);
  assert.match(sub.textContent, /2 条 · 含置顶/);
  assert.ok(list.innerHTML.indexOf('重点记录') < list.innerHTML.indexOf('普通记录'));
  assert.match(list.innerHTML, /memo-list-item active pinned/);
});
