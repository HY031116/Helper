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
const iconApp = fs.readFileSync(path.join(ROOT, 'src/renderer/js/ui-icons.js'), 'utf8');
const iconCss = fs.readFileSync(path.join(ROOT, 'src/renderer/css/icons.css'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
const petHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/pet.html'), 'utf8');
const petApp = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/pet.js'), 'utf8');
const petCss = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/pet.css'), 'utf8');
const petPanelHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/panel.html'), 'utf8');
const petPanelApp = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/panel.js'), 'utf8');
const petPanelCss = fs.readFileSync(path.join(ROOT, 'src/renderer/pet/panel.css'), 'utf8');
const aiSource = fs.readFileSync(path.join(ROOT, 'src/main/ai.js'), 'utf8');
const buildWin = fs.readFileSync(path.join(ROOT, 'scripts/build-win.ps1'), 'utf8');
const iconGenerator = fs.readFileSync(path.join(ROOT, 'scripts/generate-app-icons.js'), 'utf8');
const appIconSvg = fs.readFileSync(path.join(ROOT, 'src/assets/app-icon.svg'), 'utf8');
const appIconIco = fs.readFileSync(path.join(ROOT, 'src/assets/app-icon.ico'));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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
      body: elements.__body,
      activeElement: elements.__activeElement || null,
      querySelector: (selector) => elements[selector] || null,
      querySelectorAll: (selector) => elements.__querySelectorAll ? elements.__querySelectorAll(selector) : [],
      getElementById: (id) => elements['#' + id] || elements[id] || null,
      createElement: (tag) => elements.__createElement ? elements.__createElement(tag) : null,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    window: elements.__window || {},
    navigator: elements.__navigator || {},
    testValues: elements.__testValues || {}
  });
  vm.runInContext(iconApp, context);
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
    disabled: false,
    dataset: {},
    offsetWidth: 160,
    addEventListener(name, listener) { listeners[name] = listener; },
    click() { if (listeners.click) return listeners.click({ stopPropagation() {} }); },
    setAttribute(name, value) { attrs[name] = value; },
    focus() { this.focused = true; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function loadPetRuntime(elements, tasks) {
  elements['pet-reminder'] = elements['pet-reminder'] || fakePetElement(['hidden']);
  elements['pet-reminder-text'] = elements['pet-reminder-text'] || fakePetElement();
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
          commitPosition: async () => ({ ok: true }),
          togglePanel: async () => ({ ok: true, visible: true }),
          closePanel: async () => ({ ok: true }),
          openView: elements.__openView || (async () => ({ ok: true })),
          openTask: async () => ({ ok: true }),
          contextMenu: async () => ({ ok: true })
        },
        on: () => () => {}
      }
    },
    testValues: elements.__testValues || {}
  });
  vm.runInContext(petApp, context);
  return { run: (source) => vm.runInContext(source, context), documentListeners };
}

test('应用品牌图标覆盖标题栏、窗口、托盘、通知和 Windows 构建', () => {
  assert.strictEqual(packageJson.productName, '工作台助手');
  const dataPathSetup = main.slice(main.indexOf("app.setName('工作台助手')"), main.indexOf("const store = require('./main/store')"));
  assert.match(dataPathSetup, /if \(isolatedDataArg\)[\s\S]*?app\.setPath\('userData', isolatedRoot\)/);
  assert.match(dataPathSetup, /else \{[\s\S]*?app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'work-helper'\)\)/);
  assert.ok(dataPathSetup.indexOf("app.setPath('userData'") < main.indexOf("const store = require('./main/store')"));
  assert.match(appIconSvg, /<rect[^>]+fill="#2E6390"/);
  assert.match(appIconSvg, /<path[^>]+fill="#FFFFFF"/);
  assert.match(appIconSvg, /<circle[^>]+fill="#2E6390"/);
  assert.strictEqual(appIconIco.readUInt16LE(2), 1);
  assert.strictEqual(appIconIco.readUInt16LE(4), 9);
  [16, 20, 24, 32, 40, 48, 64, 128, 256, 512].forEach((size) => {
    assert.ok(fs.statSync(path.join(ROOT, `src/assets/app-icon-${size}.png`)).size > 0);
  });
  assert.match(html, /<link rel="icon" href="\.\.\/assets\/app-icon-32\.png"/);
  assert.match(html, /<img class="tb-logo" src="\.\.\/assets\/app-icon\.svg"/);
  assert.match(main, /const APP_ICON_PATH = path\.join\(__dirname, 'assets', 'app-icon-256\.png'\)/);
  assert.match(main, /icon: APP_ICON_PATH/);
  assert.match(main, /petWindow = new BrowserWindow\(\{[\s\S]*?title: '桌宠'/);
  assert.match(main, /nativeImage\.createFromPath\(TRAY_ICON_PATH\)/);
  assert.doesNotMatch(main, /new Tray\(nativeImage\.createEmpty\(\)\)/);
  assert.match(main, /app\.setAppUserModelId\('com\.workhelper\.desktop'\)/);
  assert.match(iconGenerator, /const sizes = \[16, 20, 24, 32, 40, 48, 64, 128, 256, 512\]/);
  assert.match(buildWin, /scripts\\icon-generator/);
  assert.match(buildWin, /Get-Content -LiteralPath \$packagePath -Raw -Encoding UTF8 \| ConvertFrom-Json/);
  assert.match(buildWin, /set-win-icon\.ps1/);
  assert.match(buildWin, /-ExePath \$exePath -IconPath \$iconPath/);
});

test('主导航和任务工具栏使用可聚焦控件', () => {
  assert.match(html, /<nav class="sidebar" aria-label="主导航">/);
  assert.match(html, /<link rel="stylesheet" href="css\/icons\.css">/);
  assert.match(html, /<script src="js\/ui-icons\.js"><\/script>\s*<script src="js\/app\.js"><\/script>/);
  assert.match(iconApp, /id="ui-icon-sprite"/);
  assert.strictEqual((html.match(/class="nav-ico" aria-hidden="true"><svg class="ui-icon"/g) || []).length, 4);
  assert.match(iconCss, /\.ui-icon \{[\s\S]*?stroke: currentColor;[\s\S]*?stroke-width: 2;/);
  assert.match(html, /id="sidebar-new" aria-label="新建任务"/);
  assert.match(html, /<button type="button" class="nav-item active"[^>]+aria-current="page"/);
  assert.doesNotMatch(html, /<div class="nav-item/);
  for (const view of ['today', 'list', 'records', 'settings']) {
    assert.match(html, new RegExp(`<button type="button" class="nav-item[^"]*" data-view="${view}"`));
  }
  assert.match(html, /<div class="task-search-row">\s*<input id="search-input" type="search" aria-label="搜索任务"/);
  assert.match(html, /<div class="quick-add">\s*<input id="quick-input" aria-label="快速添加任务"/);
  assert.match(html, /id="btn-quick-add">快速添加<\/button>/);
  assert.match(html, /id="btn-new">详细创建<\/button>/);
  assert.match(app, /viewScrollPositions\.set\(previousView, content\.scrollTop\)/);
  assert.match(app, /content\.scrollTop = viewScrollPositions\.get\(view\) \|\| 0/);
});

test('视图切换保留各自滚动位置且重复选择不会跳回顶部', () => {
  const content = { scrollTop: 120 };
  const title = { textContent: '' };
  const makeNav = (view) => ({
    dataset: { view }, classList: fakeClassList(), attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; }
  });
  const todayNav = makeNav('today');
  const listNav = makeNav('list');
  const todayView = { id: 'view-today', style: {}, isConnected: true, classList: fakeClassList() };
  const listView = { id: 'view-list', style: {}, isConnected: true, classList: fakeClassList() };
  const run = loadRendererRuntime({
    '.content': content,
    '#tb-title': title,
    'view-today': todayView,
    'view-list': listView,
    __querySelectorAll: (selector) => {
      if (selector === '.nav-item') return [todayNav, listNav];
      if (selector === '.view') return [todayView, listView];
      return [];
    }
  });
  run(`
    closeTaskMenus = () => {};
    playTransientClass = () => {};
    renderToday = () => {};
    renderTasks = () => {};
    renderMemos = () => {};
    renderRecords = () => {};
    renderSettings = () => {};
    loadTrash = () => {};
    applyDataLoadStates = () => {};
    currentView = 'today';
    viewScrollPositions.clear();
    viewScrollPositions.set('list', 55);
    switchView('list');
  `);
  assert.strictEqual(content.scrollTop, 55);
  assert.strictEqual(run(`viewScrollPositions.get('today')`), 120);
  assert.strictEqual(listNav.attrs['aria-current'], 'page');
  content.scrollTop = 80;
  run(`switchView('today')`);
  assert.strictEqual(content.scrollTop, 120);
  assert.strictEqual(run(`viewScrollPositions.get('list')`), 80);
  content.scrollTop = 135;
  run(`switchView('today')`);
  assert.strictEqual(content.scrollTop, 135);
});

test('高频任务操作和设置开关暴露键盘与状态语义', () => {
  assert.match(app, /<button type="button" class="task-check"[^>]+aria-label=/);
  assert.match(app, /class="tname task-title-btn" aria-expanded=/);
  assert.match(app, /role="switch" aria-checked=/);
  assert.match(html, /<button type="button" class="chip" data-prompt=/);
  assert.match(app, /class="task-more" aria-haspopup="menu" aria-controls="\$\{menuId\}" aria-expanded="false"/);
  assert.match(app, /class="task-menu hidden" id="\$\{menuId\}" role="menu"/);
  assert.match(css, /\.task-more \{[\s\S]*?width: 28px; height: 28px;/);
  assert.match(app, /const checkIcon = checked \? uiIcon\('check'\) : ''/);
  assert.match(css, /\.task-check \.ui-icon \{ width: 12px; height: 12px;/);
  assert.match(app, /class="repeat-chip">\$\{uiIcon\('refresh'\)\}<span>/);
  assert.doesNotMatch(app, /◈|↻/);
});

test('任务行复选框完成任务，标题按钮展开详情', async () => {
  const row = { dataset: { id: '1' } };
  const taskCheck = {};
  const makeTarget = (control) => ({
    classList: { contains: () => false },
    closest(selector) {
      if (selector === '.task-row') return row;
      if (selector === '.task-check') return control === 'check' ? taskCheck : null;
      if (selector === '.tname') return control === 'title' ? {} : null;
      return null;
    }
  });
  const calls = [];
  const run = loadRendererRuntime({
    __testValues: {
      checkEvent: { target: makeTarget('check'), ctrlKey: false, metaKey: false, shiftKey: false },
      titleEvent: { target: makeTarget('title') },
      calls
    }
  });
  run(`tasks = [{ id: 1, title: '交周报', status: 'todo' }];
    currentView = 'tasks';
    toggleDone = (task) => testValues.calls.push('done:' + task.id);
    renderAll = () => testValues.calls.push('render');`);
  await run('onTaskClick(testValues.checkEvent)');
  await run('onTaskClick(testValues.titleEvent)');
  assert.deepStrictEqual(calls, ['done:1', 'render']);
  assert.strictEqual(run(`expandedIds.has('d1')`), true);
});

test('任务低频操作收进统一菜单并支持方向键浏览', () => {
  assert.match(iconApp, /function uiIcon\(name, extraClass\)/);
  assert.match(app, /\$\{uiIcon\('ellipsis'\)\}/);
  assert.match(app, /\['delete', 'trash', '删除', 'danger'\]/);
  assert.match(app, /function openTaskMenu\(trigger, focusLast\)/);
  assert.match(app, /menuRect\.bottom > window\.innerHeight - 12/);
  assert.match(app, /function focusTaskAfterMutation\(id, previousIndex, preferredSelector\)/);
  assert.match(app, /document\.getElementById\(id\)\.addEventListener\('keydown', onTaskMenuKeyDown\)/);
  assert.match(app, /if \(!event\.target\.closest\('\.task-overflow'\)\) closeTaskMenus\(false\)/);
  assert.match(css, /\.task-menu\.opens-up \{ top: auto; bottom: calc\(100% \+ 4px\); \}/);
  assert.match(css, /\.task-menu-item\.danger/);
  assert.match(css, /--layer-popover: 60;/);
  assert.match(css, /\.task-row:has\(\.task-more\[aria-expanded="true"\]\) \{ z-index: var\(--layer-popover\); \}/);
  assert.match(css, /\.task-menu \{[\s\S]*?position: absolute; z-index: 1;/);
  assert.doesNotMatch(css, /\.task-row\.archived\s*\{\s*opacity:/);
  assert.match(css, /\.task-row\.archived \.task-meta > :not\(\.task-overflow\) \{ opacity: 0\.55; \}/);
  assert.doesNotMatch(app, /class="row-actions"/);
  assert.doesNotMatch(css, /\.row-actions|\.ra(?:\W|$)/);

  let menu;
  const makeItem = () => ({
    tabIndex: -1,
    focused: false,
    closest(selector) {
      if (selector === '.task-more') return null;
      if (selector === '.task-menu-item[role="menuitem"]') return this;
      if (selector === '.task-menu') return menu;
      return null;
    },
    focus() { this.focused = true; }
  });
  const items = [makeItem(), makeItem(), makeItem()];
  menu = { querySelectorAll: () => items };
  const event = {
    key: 'ArrowDown',
    target: items[0],
    preventDefaultCalled: false,
    preventDefault() { this.preventDefaultCalled = true; }
  };
  const run = loadRendererRuntime({ __testValues: { event } });
  run('onTaskMenuKeyDown(testValues.event)');
  assert.strictEqual(event.preventDefaultCalled, true);
  assert.deepStrictEqual(items.map((item) => item.tabIndex), [-1, 0, -1]);
  assert.strictEqual(items[1].focused, true);
});

test('任务上下文 Agent 独立小窗已下线，主窗口不再保留唤起入口', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/renderer/task-agent')));
  assert.doesNotMatch(app, /task-agent-btn|openTaskAgent|window\.api\.taskAgent/);
  assert.doesNotMatch(html, /id="m-agent"/);
  assert.doesNotMatch(css, /\.task-agent-btn|\.modal-agent-btn|\.task-worklog/);
  assert.doesNotMatch(preload, /taskAgent|'task-agent:session'/);
  assert.doesNotMatch(main, /createTaskAgentWindow|'task-agent:open'|'task-agent:close'|isTaskAgentSender/);
});

/* 任务对话小窗运行时：预览确认流 + 非任务操作回退全局对话 */
function fakeTaElement(tag) {
  const children = [];
  const listeners = {};
  const classList = fakeClassList();
  const nativeContains = classList.contains;
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    value: '',
    dataset: {},
    style: {},
    attrs: {},
    children,
    listeners,
    classList,
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { children.push(child); return child; },
    append(...nodes) { nodes.forEach((node) => children.push(node)); },
    prepend(...nodes) { nodes.forEach((node) => children.unshift(node)); },
    replaceChildren(...nodes) { children.length = 0; nodes.forEach((node) => children.push(node)); },
    addEventListener(name, listener) { listeners[name] = listener; },
    removeEventListener() {},
    querySelector(selector) {
      const cls = selector.replace(/^\./, '');
      for (const child of children) {
        if (child.classList && child.classList.contains(cls)) return child;
        const found = child.querySelector ? child.querySelector(selector) : null;
        if (found) return found;
      }
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return { remove() {} }; },
    focus() { this.focused = true; },
    requestSubmit() { if (listeners.submit) listeners.submit({ preventDefault() {} }); },
    setSelectionRange() {},
    scrollIntoView() {},
    scrollTop: 0,
    scrollHeight: 0
  };
  // 生产代码用 className 赋值，querySelector 用 classList.contains：这里做同步
  classList.contains = (name) => nativeContains.call(classList, name) ||
    String(el.className || '').split(/\s+/).includes(name);
  return el;
}

test('快速添加同时支持按钮和回车，并防止重复提交', () => {
  assert.match(app, /async function createQuickTask\(\)/);
  assert.match(app, /if \(!raw \|\| button\.disabled\) return/);
  assert.match(app, /#btn-quick-add'\)\.addEventListener\('click', createQuickTask\)/);
  assert.match(app, /if \(e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);\s*createQuickTask\(\)/);
  assert.match(app, /toast\(`已创建「\$\{createdTitle\}」/);
  assert.match(app, /await refreshTasksAfterMutation\('任务已创建，但列表刷新失败'\)/);
  assert.match(app, /setQuickCreateBusy\(input, button, true\)/);
  assert.match(app, /if \(input\.value\.trim\(\) === raw\) input\.value = ''/);

  const input = { readOnly: false, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const button = { disabled: false, attrs: {}, textContent: '', setAttribute(name, value) { this.attrs[name] = value; } };
  const run = loadRendererRuntime({ __testValues: { input, button } });
  run(`setQuickCreateBusy(testValues.input, testValues.button, true)`);
  assert.strictEqual(input.readOnly, true);
  assert.strictEqual(input.attrs['aria-busy'], 'true');
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.textContent, '添加中…');
  run(`setQuickCreateBusy(testValues.input, testValues.button, false)`);
  assert.strictEqual(input.readOnly, false);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.textContent, '快速添加');
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
  assert.match(app, /save\.setAttribute\('aria-busy', String\(busy && action === 'save'\)\)/);
  assert.match(app, /form\.setAttribute\('aria-busy', String\(busy\)\)/);
  assert.match(app, /#task-form input, #task-form select, #task-form textarea, #task-form button/);
  assert.match(app, /setModalBusy\(true, 'archive'\)/);
  assert.match(app, /setModalBusy\(true, 'unarchive'\)/);
  assert.match(app, /restoreModalFocus\(\)/);
  assert.match(app, /shouldComplete = data\.status === 'done'/);
  assert.match(app, /completion = await window\.api\.tasks\.saveAndComplete\(editingTask \? editingTask\.id : null, data\)/);
  assert.match(main, /ipcMain\.handle\('tasks:saveAndComplete', \(e, id, data\) => runTaskMutation\(\(\) => store\.saveAndCompleteTask\(id, data\)\)\)/);
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

test('任务弹窗以统一事务状态锁定字段并保持操作按钮宽度', () => {
  const makeControl = (text) => ({
    attrs: {}, disabled: false, textContent: text || '',
    setAttribute(name, value) { this.attrs[name] = value; }
  });
  const form = makeControl();
  const title = makeControl();
  const select = makeControl();
  const textarea = makeControl();
  const save = makeControl('保存');
  const remove = makeControl('删除');
  const archive = makeControl('归档');
  const unarchive = makeControl('恢复');
  const cancel = makeControl('取消');
  const close = makeControl();
  const controls = [title, select, textarea, save, remove, archive, unarchive, cancel];
  const run = loadRendererRuntime({
    '#task-form': form,
    '#m-save': save,
    '#m-delete': remove,
    '#m-archive': archive,
    '#m-unarchive': unarchive,
    '#m-close': close,
    __querySelectorAll: (selector) => selector.startsWith('#task-form ') ? controls : []
  });

  run(`editingTask = { id: 7, title: '测试任务' }; setModalBusy(true, 'archive')`);
  assert.strictEqual(form.attrs['aria-busy'], 'true');
  assert.ok(controls.every((control) => control.disabled));
  assert.strictEqual(close.disabled, true);
  assert.strictEqual(archive.textContent, '归档中…');
  assert.strictEqual(archive.attrs['aria-busy'], 'true');
  assert.strictEqual(save.textContent, '保存');

  run(`setModalBusy(false)`);
  assert.strictEqual(form.attrs['aria-busy'], 'false');
  assert.ok(controls.every((control) => !control.disabled));
  assert.strictEqual(close.disabled, false);
  assert.strictEqual(archive.textContent, '归档');
  assert.strictEqual(archive.attrs['aria-busy'], 'false');
  assert.match(css, /\.task-modal #m-save \{ width: 88px; \}/);
  assert.match(css, /\.task-modal #m-delete,[\s\S]*?min-width: 88px;/);
  assert.match(css, /\.task-modal \.m-actions \.btn \{ padding-inline: 8px; white-space: nowrap; \}/);
});

test('任务删除需确认，归档与恢复失败时保留编辑上下文', () => {
  const deleteFlow = app.slice(app.indexOf('async function deleteEditingTask()'), app.indexOf('async function archiveEditingTask()'));
  const archiveFlow = app.slice(app.indexOf('async function archiveEditingTask()'), app.indexOf('async function unarchiveEditingTask()'));
  const unarchiveFlow = app.slice(app.indexOf('async function unarchiveEditingTask()'), app.indexOf('/* ---------- AI 对话 ---------- */'));
  assert.match(deleteFlow, /confirmDialog\(`确定删除任务/);
  assert.ok(deleteFlow.indexOf('await window.api.tasks.remove(id)') < deleteFlow.indexOf('closeModal(false)'));
  assert.match(deleteFlow, /return \{ focusTarget: '#sidebar-new' \}/);
  assert.ok(archiveFlow.indexOf('await window.api.tasks.archive(id)') < archiveFlow.indexOf('closeModal(false)'));
  assert.match(archiveFlow, /setModalError\('归档失败，请稍后重试。任务内容仍保留在窗口中。'\)/);
  assert.match(archiveFlow, /#m-archive'\)\.focus\(\{ preventScroll: true \}\)/);
  assert.ok(unarchiveFlow.indexOf('await window.api.tasks.unarchive(id)') < unarchiveFlow.indexOf('closeModal(false)'));
  assert.match(unarchiveFlow, /setModalError\('恢复失败，请稍后重试。任务内容仍保留在窗口中。'\)/);
  assert.match(unarchiveFlow, /#m-unarchive'\)\.focus\(\{ preventScroll: true \}\)/);
});

test('任务弹窗保护未保存内容并保证截止日期完整显示', () => {
  assert.match(html, /<label for="m-due-date">截止日期<\/label>\s*<div class="due-row">\s*<input id="m-due-date" type="date">\s*<input id="m-due-time" type="time" value="18:00"/);
  assert.match(css, /\.due-row \{ display: flex; gap: 6px; align-items: center; \}/);
  assert.match(app, /let modalInitialSnapshot = ''/);
  assert.match(app, /function taskFormSnapshot\(\)/);
  assert.match(app, /function captureModalInitialState\(\)/);
  assert.match(app, /function isTaskModalDirty\(\)/);
  assert.match(app, /confirmDialog\('放弃尚未保存的更改吗？', async \(\) => closeModal\(\), '放弃'\)/);
  assert.match(app, /#m-cancel'\)\.addEventListener\('click', requestCloseModal\)/);
  assert.match(app, /#m-close'\)\.addEventListener\('click', requestCloseModal\)/);
  assert.match(app, /if \(e\.target === \$\('#modal-mask'\)\) requestCloseModal\(\)/);
  assert.match(app, /if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*requestCloseModal\(\)/);
  assert.match(app, /function splitDue\(due\)[\s\S]{0,260}time: m && m\[2\] \? m\[2\] : '18:00'/);
  assert.match(app, /\$\('#m-due-date'\)\.value = due\.date;\s*\$\('#m-due-time'\)\.value = due\.time;/);
  assert.match(app, /captureModalInitialState\(\);\s*const mask = \$\('#modal-mask'\)/);
  assert.match(app, /console\.error\('\[task-modal\] save failed:', err\)/);
  assert.match(app, /setModalError\('保存失败，请稍后重试。任务内容仍保留在窗口中。'\)/);
});

test('确认框遵循安全的原生键盘行为', () => {
  assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text confirm-error"/);
  assert.match(html, /id="confirm-error" role="alert"/);
  assert.match(html, /class="btn neutral" id="confirm-cancel">取消<\/button>/);
  assert.match(css, /\.btn\.neutral \{[^}]*border: 1px solid var\(--rule\);[^}]*color: var\(--ink2\);/);
  assert.match(app, /if \(e\.key === 'Tab'\) trapFocus\(mask, e\)/);
  assert.doesNotMatch(app, /if \(e\.key === 'Enter'\) \{ onOkClick\(\); \}/);
  assert.match(app, /const onOkClick = async \(\) => \{/);
  assert.match(app, /title\.textContent = `确认\$\{actionText\}`/);
  assert.match(app, /okBtn\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /const outcome = await onOk\(\)/);
  assert.match(app, /if \(outcome === false\)[\s\S]*?尚未\$\{actionText\}，请处理当前错误后重试/);
  assert.match(app, /cleanup\(outcome && outcome\.focusTarget\)/);
  assert.match(app, /console\.error\('\[confirm\] action failed:', error\)/);
  assert.match(app, /errorBox\.textContent = `未能\$\{actionText\}，请稍后重试。`/);
  assert.match(app, /errorBox\.classList\.remove\('hidden'\)/);
  assert.match(app, /toast\(`未能\$\{actionText\}，请稍后重试`, 4000, null, 'err'\)/);
  assert.match(app, /hideModalMask\(mask, \(\) => \{/);
  assert.match(css, /\.modal-mask\.is-closing \{[\s\S]*?animation: maskOut/);
  assert.match(css, /\.modal-mask\.is-closing \.modal \{[\s\S]*?animation: modalOut/);
});

test('确认操作失败后保留弹窗、恢复按钮并显示内联错误', async () => {
  const makeElement = (initial) => ({
    attrs: {}, listeners: {}, textContent: '', disabled: false,
    classList: fakeClassList(initial),
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    removeEventListener(name) { delete this.listeners[name]; },
    focus() { this.focused = true; },
    closest() { return null; }
  });
  const mask = makeElement(['hidden']);
  const title = makeElement();
  const text = makeElement();
  const errorBox = makeElement(['hidden']);
  const ok = makeElement();
  const cancel = makeElement();
  const run = loadRendererRuntime({
    '#confirm-mask': mask,
    '#confirm-title': title,
    '#confirm-text': text,
    '#confirm-error': errorBox,
    '#confirm-ok': ok,
    '#confirm-cancel': cancel
  });
  run(`document.activeElement = null; toast = () => {}; confirmDialog('永久删除吗？', async () => { throw new Error('失败'); }, '永久删除')`);
  await ok.listeners.click();
  assert.strictEqual(mask.classList.contains('hidden'), false);
  assert.strictEqual(ok.disabled, false);
  assert.strictEqual(cancel.disabled, false);
  assert.strictEqual(ok.textContent, '永久删除');
  assert.strictEqual(errorBox.textContent, '未能永久删除，请稍后重试。');
  assert.strictEqual(errorBox.classList.contains('hidden'), false);
});

test('确认操作可保留待解决状态并在重绘后恢复到新控件', async () => {
  const makeElement = (initial) => ({
    attrs: {}, listeners: {}, textContent: '', disabled: false, isConnected: true,
    classList: fakeClassList(initial),
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    removeEventListener(name) { delete this.listeners[name]; },
    focus(options) { this.focused = true; this.focusOptions = options; },
    closest() { return null; }
  });
  const mask = makeElement(['hidden']);
  const title = makeElement();
  const text = makeElement();
  const errorBox = makeElement(['hidden']);
  const ok = makeElement();
  const cancel = makeElement();
  const fresh = makeElement();
  const run = loadRendererRuntime({
    '#confirm-mask': mask,
    '#confirm-title': title,
    '#confirm-text': text,
    '#confirm-error': errorBox,
    '#confirm-ok': ok,
    '#confirm-cancel': cancel,
    '#fresh-control': fresh
  });

  run(`document.activeElement = null; confirmDialog('恢复吗？', async () => false, '恢复')`);
  await ok.listeners.click();
  assert.strictEqual(mask.classList.contains('hidden'), false);
  assert.strictEqual(errorBox.textContent, '尚未恢复，请处理当前错误后重试。');
  assert.strictEqual(ok.disabled, false);

  run(`hideModalMask = (target, callback) => callback(); confirmDialog('恢复吗？', async () => ({ focusTarget: '#fresh-control' }), '恢复')`);
  await ok.listeners.click();
  assert.strictEqual(fresh.focused, true);
  assert.strictEqual(fresh.focusOptions.preventScroll, true);
});

test('设置中的破坏性任务操作均需确认且文案准确', () => {
  assert.match(app, /id="btn-reset">\$\{uiIcon\('refresh'\)\}<span>重置任务<\/span><\/button>/);
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
  assert.match(app, /if \(b\.disabled\) return;[\s\S]*?if \(el\._dismissTimer\) clearTimeout\(el\._dismissTimer\);[\s\S]*?b\.disabled = true;/);
  assert.match(app, /b\.textContent = a\.busyLabel \|\| `\$\{a\.label\}中…`/);
  assert.match(app, /const outcome = await a\.run\(\);\s*if \(outcome === false\) throw new Error\('操作未完成'\);\s*dismissToast\(el\)/);
  assert.match(app, /b\.textContent = '重试';\s*actionStatus\.textContent = '失败'/);
  assert.match(app, /scheduleToastDismiss\(el, 5000\);\s*b\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /function scheduleToastDismiss[\s\S]*?if \(element\.classList\.contains\('is-action-busy'\)\) return/);
  assert.match(app, /const normalizedMessage = String\(message == null \? '' : message\)/);
  assert.match(app, /text\.textContent = normalizedMessage/);
  assert.match(app, /icon\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(app, /icon\.appendChild\(uiIconElement\(icons\[type\]\)\)/);
  assert.match(iconApp, /function uiIconElement\(name, extraClass\)[\s\S]*?document\.createElementNS/);
  assert.match(app, /layer\.appendChild\(el\);\s*while \(layer\.children\.length > 3\) \{[\s\S]*?!item\.classList\.contains\('is-action-busy'\) && !item\.contains\(document\.activeElement\)/);
  assert.match(app, /item\.dataset\.message === normalizedMessage/);
  assert.match(app, /el\.addEventListener\('mouseenter'/);
  assert.match(css, /\.toast\.is-leaving \{ animation: toastOut/);
  assert.doesNotMatch(app.slice(app.indexOf('function toast('), app.indexOf("if (typeof window.addEventListener")), /innerHTML/);
  assert.match(css, /\.toast \.t-undo:focus-visible/);
  assert.match(css, /\.toast\.is-action-busy/);
  assert.match(css, /\.toast\.t-action-error/);
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
  assert.match(app, /if \(next === 'done'\) await toggleDone\(t\)/);
  assert.match(app, /if \(t\.status === 'done'\) \{\s*await window\.api\.tasks\.update\(t\.id, \{ status: 'todo' \}\)/);
  assert.match(app, /const res = await window\.api\.tasks\.complete\(t\.id\)/);
});

test('任务完成反馈在列表刷新前可见', async () => {
  const calls = [];
  const row = {
    classList: {
      add(name) { calls.push(`class:${name}`); }
    }
  };
  const run = loadRendererRuntime({
    '.task-row[data-id="7"]': row,
    __window: {
      api: { tasks: { complete: async () => { calls.push('complete'); return { next: null }; } } }
    },
    __testValues: { calls, task: { id: 7, title: '提交周报', status: 'todo' } }
  });
  run(`
    toast = () => testValues.calls.push('toast');
    motionDelay = async (ms) => testValues.calls.push('delay:' + ms);
    refreshTasksAfterMutation = async () => testValues.calls.push('refresh');
  `);
  await run(`toggleDone(testValues.task)`);
  assert.deepStrictEqual(calls, ['complete', 'toast', 'class:just-done', 'delay:220', 'refresh']);
});

test('单任务写操作立即锁定整行并拒绝重复提交', async () => {
  const rowButton = { disabled: false };
  const row = {
    attrs: {},
    classList: fakeClassList(),
    draggable: true,
    setAttribute(name, value) { this.attrs[name] = value; },
    querySelectorAll() { return [rowButton]; }
  };
  const postponeButton = { disabled: false };
  const control = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const calls = [];
  const run = loadRendererRuntime({
    __querySelectorAll(selector) {
      if (selector === '.task-row[data-id="7"]') return [row];
      if (selector === '.overdue-actions[data-id="7"] button') return [postponeButton];
      return [];
    },
    __testValues: { control, calls }
  });
  run(`testValues.first = runTaskRowMutation({
    taskId: 7,
    control: testValues.control,
    operation: () => new Promise((resolve) => { testValues.release = resolve; }),
    errorMessage: '写入失败'
  })`);
  assert.strictEqual(run('taskMutationLocks.has(7)'), true);
  assert.strictEqual(row.classList.contains('is-busy'), true);
  assert.strictEqual(row.attrs['aria-busy'], 'true');
  assert.strictEqual(rowButton.disabled, true);
  assert.strictEqual(postponeButton.disabled, true);

  const duplicate = await run(`runTaskRowMutation({
    taskId: 7,
    operation: async () => testValues.calls.push('duplicate')
  })`);
  assert.strictEqual(duplicate, false);
  assert.deepStrictEqual(calls, []);

  await run('testValues.release(); testValues.first');
  assert.strictEqual(run('taskMutationLocks.has(7)'), false);
  assert.strictEqual(row.classList.contains('is-busy'), false);
  assert.strictEqual(row.attrs['aria-busy'], 'false');
  assert.strictEqual(rowButton.disabled, false);
  assert.strictEqual(postponeButton.disabled, false);
  assert.strictEqual(control.attrs['aria-busy'], 'false');
  assert.match(css, /\.task-row\.is-busy::before \{[\s\S]*?animation: taskBusyRail var\(--motion-loop\)/);
  assert.match(css, /#memo-save-state\[data-state="saving"\]::before,[\s\S]*?\.task-row\.is-busy::before,/);
});

test('批量与优先级批量调整已从主界面裁剪，复杂调整交由 AI 对话', () => {
  assert.doesNotMatch(html, /btn-select-mode|batch-bar|batch-done|batch-delete|batch-pri/);
  assert.doesNotMatch(app, /setBatchMode\(|runBatchMutation\(|\bselectedIds\b|\bbatchMode\b|renderBatchBar|setBatchBusy|visibleTaskIds/);
  assert.doesNotMatch(app, /window\.api\.tasks\.batchComplete|window\.api\.tasks\.batchUpdate/);
  assert.doesNotMatch(css, /\.batch-bar|\.batch-pri|\.task-row\.selecting|\.memo-batch-bar|\.memo-select-mode|\.memo-check/);
  assert.match(html, /<button type="button" class="chip" data-prompt=/);
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

test('真实模型设置明确数据范围并校验自定义服务地址', () => {
  assert.match(app, /当前输入、最近 6 轮对话、与当前问题最相关的最多 40 条未归档任务和 30 条备忘录摘要会发送给所选服务商/);
  assert.match(app, /settings\.aiProvider !== 'custom' \|\| !!settings\.aiBaseUrl/);
  assert.match(app, /s\.aiStage === 'llm'/);
});

test('助手输入支持多行、提交中状态和失败重试', () => {
  assert.match(html, /id="ai-chat" role="log"[^>]+aria-live="polite"[^>]+aria-busy="true"/);
  assert.match(html, /<form class="ai-input-row" id="ai-form">\s*<textarea id="ai-input" rows="1" maxlength="1000"/);
  assert.match(app, /#ai-form'\)\.addEventListener\('submit'/);
  assert.match(app, /e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.isComposing/);
  assert.match(app, /if \(!raw \|\| aiSending\) return/);
  assert.match(main, /ipcMain\.handle\('ai:cancel'/);
  assert.match(main, /aiRequestCoordinator\.begin\(e\.sender\.id, requestId\)/);
  assert.match(main, /request\.status === 'completed'/);
  assert.match(main, /request\.status === 'active'/);
  assert.match(main, /aiRequestCoordinator\.complete\(key, persisted\)/);
  assert.match(preload, /cancel: \(requestId\) => ipcRenderer\.invoke\('ai:cancel', requestId\)/);
  assert.match(preload, /ipcRenderer\.on\('ai:progress', listener\)/);
  assert.match(app, /function cancelActiveAiRequest\(\)/);
  assert.match(app, /window\.api\.ai\.handle\(raw, requestId\)/);
  assert.match(app, /typeof progress\.delta === 'string'/);
  assert.match(app, /pending\.querySelector\('\.msg-text'\)\.textContent = assistantRequestFailureMessage\(\)/);
  assert.doesNotMatch(app, /暂时没有处理成功：\$\{e\.message\}/);
  assert.match(app, /function retryAction\(retry, draft\)/);
  assert.match(app, /actions\.remove\(\);\s*retry\(\)/);
  assert.match(app, /操作已完成，但任务列表没有刷新。请稍后重新打开当前视图。/);
  assert.match(app, /result\.degraded \? \(result\.degradeNotice \|\| '模型服务短暂异常，已进入受控降级。'/);
  assert.match(app, /if \(result\.retryable && retry\)/);
  assert.match(app, /if \(result\.resumed && result\.retryText\)/);
  assert.match(app, /label: '重试刚才回答'/);
  assert.match(app, /run: \(\) => runPrompt\(result\.retryText\)/);
  assert.match(app, /memo_split: '已拆成任务'/);
  assert.match(app, /plan: `已完成 \$\{Array\.isArray\(result\.operations\) \? result\.operations\.length : 0\} 项操作`/);
  assert.match(app, /result\.type === 'plan'/);
  assert.match(main, /function persistAiExchange\(userText, result\)/);
  assert.match(main, /store\.appendChatEntries\(\[/);
  assert.match(app, /if \(result\.chatPersisted === false\)/);
  assert.match(app, /result\.historyNotice \|\| '本轮对话未能写入历史记录。'/);
  assert.match(css, /\.ai-input-row textarea \{/);
  assert.match(app, /#ai-chat'\)\.setAttribute\('aria-busy', 'false'\)/);

  const attrs = {};
  const send = {
    disabled: false,
    textContent: '',
    setAttribute: (name, value) => { attrs[`send-${name}`] = value; }
  };
  const run = loadRendererRuntime({
    '#ai-chat': { setAttribute: (name, value) => { attrs[name] = value; } },
    '#ai-send': send
  });
  run('setAiBusy(true)');
  assert.strictEqual(attrs['aria-busy'], 'true');
  assert.strictEqual(attrs['send-aria-busy'], 'true');
  assert.strictEqual(send.disabled, true);
  assert.strictEqual(send.textContent, '处理中…');
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

test('助手流式回复尊重阅读位置并提供主动回到底部入口', () => {
  assert.match(html, /class="ai-chat-wrap"/);
  assert.match(html, /id="ai-jump-latest" aria-label="查看最新回复"/);
  assert.match(app, /function isChatNearEnd\(chat, threshold\)/);
  assert.match(app, /scrollChat\(false\)/);
  assert.match(app, /#ai-chat'\)\.addEventListener\('scroll', syncAiChatFollowState/);
  assert.match(app, /latest\.focus\(\{ preventScroll: true \}\)/);
  assert.match(css, /\.ai-jump-latest \{/);
  assert.match(css, /\.msg:focus-visible \{/);

  const jump = { classList: fakeClassList(['hidden']) };
  const chat = { scrollHeight: 900, scrollTop: 120, clientHeight: 300 };
  const run = loadRendererRuntime({ '#ai-chat': chat, '#ai-jump-latest': jump });

  run('aiChatFollowing = false; scrollChat(false)');
  assert.strictEqual(chat.scrollTop, 120);
  assert.strictEqual(jump.classList.contains('hidden'), false);

  run('scrollChat(true)');
  assert.strictEqual(chat.scrollTop, 900);
  assert.strictEqual(jump.classList.contains('hidden'), true);

  chat.scrollTop = 540;
  assert.strictEqual(run('isChatNearEnd(document.querySelector("#ai-chat"))'), false);
  chat.scrollTop = 550;
  assert.strictEqual(run('isChatNearEnd(document.querySelector("#ai-chat"))'), true);
});

test('助手请求状态沿消息原位更新并保留失败输入', () => {
  assert.match(app, /setAssistantMessageState\(pending, 'working', '正在理解'\)/);
  assert.match(app, /setAssistantMessageState\(pending, 'error', '请求未完成'\)/);
  assert.match(app, /operationTypes\.includes\(result\.type\) \? '操作完成' : '已回复'/);
  assert.match(app, /retryAction\(retry, options && options\.draft\)/);
  assert.match(css, /\.msg\.ai\[data-request-state="streaming"\]::before/);
  assert.match(css, /\.msg-state \{/);

  const input = {
    value: '',
    scrollHeight: 48,
    style: {},
    focusOptions: null,
    focus(options) { this.focusOptions = options; }
  };
  const notices = [];
  const run = loadRendererRuntime({ '#ai-input': input, __testValues: { notices } });
  run('toast = (message) => testValues.notices.push(message)');

  assert.strictEqual(run(`restoreAiDraftForEditing('重新安排今天')`), true);
  assert.strictEqual(input.value, '重新安排今天');
  assert.strictEqual(input.focusOptions.preventScroll, true);

  input.value = '不要覆盖这条新草稿';
  assert.strictEqual(run(`restoreAiDraftForEditing('旧请求')`), false);
  assert.strictEqual(input.value, '不要覆盖这条新草稿');
});

test('助手请求结束只在原交互仍停留于面板时恢复输入焦点', () => {
  const input = { focused: false, focus() { this.focused = true; } };
  const send = { disabled: false, closest: () => ({}) };
  const outside = { closest: () => null };
  const outsideRun = loadRendererRuntime({
    '#ai-input': input,
    '#ai-send': send,
    __activeElement: outside
  });
  assert.strictEqual(outsideRun('restoreAiComposerFocus()'), false);
  assert.strictEqual(input.focused, false);

  const composerInput = { focused: false, focusOptions: null, focus(options) { this.focused = true; this.focusOptions = options; } };
  const composerSend = { disabled: false, closest: () => ({}) };
  const composerRun = loadRendererRuntime({
    '#ai-input': composerInput,
    '#ai-send': composerSend,
    __activeElement: composerSend
  });
  assert.strictEqual(composerRun('restoreAiComposerFocus()'), true);
  assert.strictEqual(composerInput.focused, true);
  assert.strictEqual(composerInput.focusOptions.preventScroll, true);
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

test('助手重启后可重试失败的澄清回答而不重复写入用户消息', () => {
  const makeElement = () => ({
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); },
    setAttribute() {},
    addEventListener(name, listener) { this.listeners[name] = listener; }
  });
  const context = { classList: fakeClassList(['hidden']), dataset: {} };
  const contextText = { textContent: '' };
  const input = { placeholder: '' };
  const run = loadRendererRuntime({
    '#ai-context': context,
    '#ai-context-text': contextText,
    '#ai-input': input,
    __createElement: makeElement
  });

  const controls = run(`(() => {
    globalThis.__retried = '';
    globalThis.__cancelled = '';
    runPrompt = (text) => { globalThis.__retried = text; };
    sendPrompt = (text) => { globalThis.__cancelled = text; };
    const container = { children: [], appendChild(child) { this.children.push(child); } };
    appendAssistantTurnControls(container, {
      type: 'clarify', resumed: true, retryText: '备忘录那条'
    });
    return container.children[0];
  })()`);
  assert.strictEqual(controls.children[0].textContent, '重试刚才回答');
  assert.strictEqual(controls.children[1].textContent, '取消操作');
  controls.children[0].listeners.click();
  assert.strictEqual(run('globalThis.__retried'), '备忘录那条');
  assert.strictEqual(contextText.textContent, '请求未完成 · 可重试或检查模型');
});

test('助手歧义选择走结构化解析，并提供上下文下一步', () => {
  assert.match(main, /ipcMain\.handle\('ai:resolve'/);
  assert.match(preload, /resolve: \(intent, params, taskId, label\) => ipcRenderer\.invoke\('ai:resolve'/);
  assert.match(app, /window\.api\.ai\.resolve\(/);
  assert.match(app, /result\.type === 'ask' && result\.candidates/);
  assert.match(css, /\.turn-actions \{/);
  assert.match(app, /index: String\(index \+ 1\)/);
  assert.match(app, /ariaLabel: `第 \$\{index \+ 1\} 项，\$\{label\}`/);
  assert.match(app, /'candidate-actions'/);
  assert.match(css, /\.turn-actions\.candidate-actions \{[^}]*display: grid;/);

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
    '季度方案 · 项目 Q3 · 2026-08-20 18:00 · 进行中'
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

test('助手重启后恢复待处理按钮且不重复聊天消息', async () => {
  assert.match(main, /ipcMain\.handle\('ai:session', \(\) => ai\.getSessionState\(\)\)/);
  assert.match(preload, /session: \(\) => ipcRenderer\.invoke\('ai:session'\)/);
  assert.match(app, /appendAssistantTurnControls\(target, session\.pending\)/);

  const chat = {
    children: [],
    scrollTop: 0,
    scrollHeight: 100,
    appendChild(child) { this.children.push(child); },
    querySelectorAll(selector) { return selector === '.msg.ai' ? this.children.filter((item) => item.role === 'ai') : []; }
  };
  Object.defineProperty(chat, 'innerHTML', {
    get() { return ''; },
    set() { this.children = []; }
  });
  const run = loadRendererRuntime({
    '#ai-chat': chat,
    __window: {
      api: {
        chat: { get: async () => [{ role: 'user', text: '删除报告' }, { role: 'ai', text: '确认删除吗？' }] },
        ai: { session: async () => ({ pending: { type: 'confirm', message: '确认删除吗？' } }) }
      }
    }
  });
  await run(`(async () => {
    createMessage = (role, text) => ({ role, text, restored: null, appendChild() {} });
    appendAssistantTurnControls = (target, result) => { target.restored = result.type; };
    await loadChatHistory();
  })()`);
  assert.strictEqual(chat.children.length, 2);
  assert.strictEqual(chat.children[1].restored, 'confirm');
});

test('助手确认与澄清状态提供明确的继续操作', () => {
  assert.match(app, /result\.type === 'confirm'/);
  assert.match(app, /label: '确认执行', kind: 'primary', run: \(\) => sendPrompt\('确认执行'\)/);
  assert.match(app, /label: '取消', kind: 'quiet', run: \(\) => sendPrompt\('取消'\)/);
  assert.match(app, /result\.type === 'clarify'/);
  assert.match(app, /继续补充刚才缺少的信息/);
  assert.match(app, /\{ label: '取消操作', kind: 'quiet', run: \(\) => sendPrompt\('取消'\) \}/);
  assert.match(app, /if \(result\.localFailure\) \{\s*setAiContext\('error'\);\s*return;/);
});

test('助手操作组使用单一 Tab 停靠点并支持方向键浏览', () => {
  assert.match(app, /button\.tabIndex = index === 0 \? 0 : -1/);
  assert.match(app, /bar\.addEventListener\('keydown', onTurnActionsKeyDown\)/);
  assert.match(app, /event\.key === 'Home'/);
  assert.match(app, /event\.key === 'End'/);
  assert.match(css, /\.turn-action:focus-visible \{/);

  const first = { tabIndex: 0, focused: false, focus() { this.focused = true; } };
  const second = { tabIndex: -1, focused: false, focus() { this.focused = true; } };
  const buttons = [first, second];
  const event = {
    key: 'ArrowDown',
    target: { closest: () => first },
    currentTarget: { querySelectorAll: () => buttons },
    preventDefaultCalled: false,
    preventDefault() { this.preventDefaultCalled = true; }
  };
  const run = loadRendererRuntime({ __testValues: { event } });
  run('onTurnActionsKeyDown(testValues.event)');
  assert.strictEqual(event.preventDefaultCalled, true);
  assert.strictEqual(first.tabIndex, -1);
  assert.strictEqual(second.tabIndex, 0);
  assert.strictEqual(second.focused, true);

});

test('助手持续展示待处理上下文并让模型故障可恢复', () => {
  assert.match(html, /id="ai-context" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="ai-health" role="status" aria-live="polite"/);
  assert.match(html, /id="ai-health-action">检查模型/);
  assert.match(html, /id="ai-input"[^>]+aria-describedby="ai-context"/);
  assert.match(app, /ask: '等待选择 · 选择后继续原操作'/);
  assert.match(app, /working: settings\.aiStage === 'llm'/);
  assert.match(app, /confirm: '等待确认 · 操作尚未执行'/);
  assert.match(app, /clarify: '等待补充 · 回答上一个问题即可继续'/);
  assert.match(app, /aiRuntimeNotice = aiRuntimeState === 'degraded'/);
  assert.match(app, /healthText\.textContent = visible \? aiRuntimeNotice : ''/);
  assert.doesNotMatch(app, /pending\.appendChild\(tip\)/);
  assert.match(app, /badge\.textContent = '模型异常'/);
  assert.match(app, /panelStage\.textContent = '真实模型 · 受控降级'/);
  assert.match(css, /\.ai-context \{/);
  assert.match(css, /\.ai-health-action \{/);

  const context = { classList: fakeClassList(['hidden']), dataset: {} };
  const contextText = { textContent: '' };
  const input = { placeholder: '' };
  const badge = { classList: fakeClassList(), textContent: '' };
  const stage = { classList: fakeClassList(), textContent: '' };
  const health = { classList: fakeClassList(['hidden']) };
  const healthText = { textContent: '' };
  const run = loadRendererRuntime({
    '#ai-context': context,
    '#ai-context-text': contextText,
    '#ai-input': input,
    '#tb-ai-stage': badge,
    '.ai-stage': stage,
    '#ai-health': health,
    '#ai-health-text': healthText
  });
  run(`setAiContext('confirm')`);
  assert.strictEqual(context.classList.contains('hidden'), false);
  assert.strictEqual(context.dataset.state, 'confirm');
  assert.strictEqual(contextText.textContent, '等待确认 · 操作尚未执行');
  assert.match(input.placeholder, /确认执行/);

  run(`settings = { aiStage: 'llm', aiModel: 'deepseek-v4-flash' }; setAiContext('working')`);
  assert.strictEqual(context.dataset.state, 'working');
  assert.strictEqual(contextText.textContent, '真实模型正在处理 · deepseek-v4-flash');

  run(`settings = { aiStage: 'llm', aiProvider: 'deepseek', aiApiKey: 'key', aiModel: 'deepseek-v4-flash' }; setAiRuntimeState('degraded', '模型服务短暂异常，已进入受控降级。')`);
  assert.strictEqual(badge.textContent, '模型异常');
  assert.strictEqual(stage.textContent, '真实模型 · 受控降级');
  assert.strictEqual(stage.classList.contains('stage-warning'), true);
  assert.strictEqual(health.classList.contains('hidden'), false);
  assert.strictEqual(healthText.textContent, '模型服务短暂异常，已进入受控降级。');
  run(`setAiRuntimeState('ready')`);
  assert.strictEqual(health.classList.contains('hidden'), true);
});

test('助手快捷入口不写入演示数据且支持安全清空历史', () => {
  assert.match(html, /class="chip" data-ai-action="new-task">新建任务/);
  assert.doesNotMatch(html, /data-prompt="明天下午3点 交周报/);
  assert.doesNotMatch(html, /data-prompt="把 写季度方案 拆成三步/);
  assert.match(html, /data-prompt="看看我的备忘录">查看备忘/);
  assert.match(html, /id="ai-clear" title="清空对话" aria-label="清空对话"/);
  assert.match(app, /if \(chip\.dataset\.aiAction === 'new-task'\)[\s\S]*?openModal\(null\)/);
  assert.match(app, /window\.api\.chat\.clear\(\)/);
  assert.match(app, /清空当前对话吗？任务和备忘录不会受影响。/);
  assert.match(app, /addMsg\('ai', assistantStatusSummary\(\)\)/);
});

test('对话消息支持选择、按钮复制和原生右键复制', async () => {
  assert.match(css, /\.msg-text \{[^}]*user-select: text;[^}]*-webkit-user-select: text;/);
  assert.match(css, /\.msg-copy \{[^}]*width: 24px; height: 24px;[^}]*opacity: 0\.5;/);
  assert.match(app, /copy\.className = 'msg-copy'/);
  assert.match(app, /copy\.setAttribute\('aria-label', '复制消息'\)/);
  assert.match(app, /copy\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(app, /el\.setAttribute\('role', 'article'\)/);
  assert.match(app, /role === 'user' \? '你' : '工作台助手'/);
  assert.match(app, /toast\('复制失败，请重试'/);
  assert.doesNotMatch(app, /toast\(`复制失败：\$\{esc\(e\.message\)\}`/);
  assert.match(main, /mainWindow\.webContents\.on\('context-menu'/);
  assert.match(main, /params\.selectionText[\s\S]*?\{ label: '复制', role: 'copy' \}/);

  let copied = '';
  const attrs = {};
  const button = {
    innerHTML: '<svg>copy</svg>',
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
  assert.match(button.innerHTML, /#ui-i-check/);
  assert.strictEqual(button.title, '已复制');
  assert.strictEqual(attrs['aria-label'], '已复制');
  assert.strictEqual(button.classList.contains('copied'), true);
});

test('桌宠自由拖放并通过独立小窗提供概览和连续 Agent 对话', async () => {
  assert.match(petHtml, /<link rel="stylesheet" href="\.\.\/css\/icons\.css">/);
  assert.match(petHtml, /<script src="\.\.\/js\/ui-icons\.js"><\/script>\s*<script src="pet\.js"><\/script>/);
  assert.match(petHtml, /id="pet-bubble" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(petHtml, /id="pet-menu" role="dialog"[^>]+aria-hidden="true"/);
  assert.match(petHtml, /id="pet-menu-next" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(petHtml, /class="pm-primary"[\s\S]*?data-pet="new"[\s\S]*?data-pet="ai"/);
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet=/g) || []).length, 4);
  assert.match(petHtml, /class="pm-grid" role="toolbar" aria-label="打开视图"/);
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet="[^"]+" tabindex="0"/g) || []).length, 1);
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet="[^"]+" tabindex="-1"/g) || []).length, 3);
  assert.match(petHtml, /id="pet" role="button" tabindex="0"[^>]+aria-expanded="false"/);
  assert.match(petCss, /\.pm-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(petCss, /\.pm-close \.ui-icon \{ width: 14px; height: 14px; \}/);
  assert.match(petCss, /\.pm-main \.ui-icon \{ width: 13px; height: 13px; \}/);
  assert.match(petCss, /\.pm-main \{[\s\S]*?white-space: nowrap;/);
  assert.match(petCss, /\.pet-menu \.pm-it \.ui-icon \{ width: 14px; height: 14px; \}/);
  for (const name of ['x', 'plus', 'message', 'today', 'tasks', 'stat', 'settings', 'external']) {
    assert.match(petHtml, new RegExp(`href="#ui-i-${name}"`));
  }
  assert.doesNotMatch(petHtml, /[＋✎◧▤▦◫⌫⚙×]/);
  assert.doesNotMatch(petHtml, /data-pet="board"|data-pet="cal"|data-pet="stat"|data-pet="trash"/);
  assert.match(petCss, /\.pet-bubble \{[\s\S]*?width: calc\(100% - 8px\);[\s\S]*?max-width: none;/);
  assert.match(petCss, /\.pet-bubble \{[\s\S]*?-webkit-line-clamp: 4;[\s\S]*?overflow: hidden;/);
  assert.match(petHtml, /id="pet-reminder"[^>]+aria-label="查看提醒任务"/);
  assert.match(petCss, /\.pm-reminder \{[\s\S]*?transition:/);
  assert.match(petCss, /\.pet-menu\.has-reminder \.pm-next \{ display: none; \}/);
  assert.match(petCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(petCss, /\.pet-menu\.is-leaving,[\s\S]*?\.pet-bubble\.is-leaving[\s\S]*?animation: pet-layer-out/);
  assert.match(petCss, /\.pet\.alert \{ animation: pet-notice var\(--pet-motion-slow\) var\(--pet-ease-enter\) 1; \}/);
  assert.match(petApp, /function hidePetLayer\(element, immediate, onHidden\)/);
  assert.match(petApp, /hidePetLayer\(petMenu, !!immediate/);
  assert.match(petApp, /async function openPetDestination\(control, destination, label\)/);
  assert.match(petApp, /if \(petNavigationBusy\) return false/);
  assert.match(petCss, /\.pet-menu\[aria-busy="true"\] \[data-pet\]/);
  assert.match(main, /if \(view === 'new'\) \{\s*sendToMain\('app:new-task'\)/);
  assert.match(main, /ipcMain\.handle\('pet:openTask'[\s\S]*?sendToMain\('app:open-task'/);
  assert.match(preload, /openTask: \(taskId\) => ipcRenderer\.invoke\('pet:openTask', taskId\)/);
  assert.match(petApp, /pendingReminder = \{ id: data\.id, title: data\.title, due: data\.due \|\| '' \}/);
  assert.match(petApp, /petMenu\.classList\.toggle\('has-reminder', !!pendingReminder\)/);
  assert.match(petApp, /await window\.api\.pet\.openTask\(reminder\.id\)/);
  assert.match(petApp, /queuePosition\(\{ x, y \}\)/);
  assert.match(petApp, /currentMood = 'moving';/);
  assert.match(petApp, /window\.api\.pet\.commitPosition\(\)/);
  assert.match(petApp, /window\.api\.pet\.togglePanel\('overview'\)/);
  assert.doesNotMatch(petApp, /snapToEdge\(/);
  assert.match(main, /ipcMain\.handle\('pet:setPosition'[\s\S]*?petWindow\.setPosition[\s\S]*?return \{ ok: true \};/);
  const petSetPositionHandler = main.slice(main.indexOf("ipcMain.handle('pet:setPosition'"), main.indexOf("ipcMain.handle('pet:commitPosition'"));
  assert.doesNotMatch(petSetPositionHandler, /store\.updateSettings/);
  const petCommitHandler = main.slice(main.indexOf("ipcMain.handle('pet:commitPosition'"), main.indexOf("ipcMain.handle('pet:getPosition'"));
  assert.match(petCommitHandler, /store\.updateSettings\(\{ petPosition: \{ \.\.\.next, version: 2 \} \}\)/);
  assert.match(main, /const PET_WINDOW_SIZE = Object\.freeze\(\{ width: 160, height: 268 \}\)/);
  assert.match(main, /function clampPetPosition\(pos\)[\s\S]*?screen\.getDisplayNearestPoint\(point\)/);
  assert.match(main, /function placePetPanel\(\)[\s\S]*?roomRight[\s\S]*?roomLeft/);
  assert.match(main, /ipcMain\.handle\('pet:togglePanel'[\s\S]*?petPanelWindow\.show\(\)[\s\S]*?'pet-panel:shown'/);
  assert.match(preload, /commitPosition: \(\) => ipcRenderer\.invoke\('pet:commitPosition'\)/);
  assert.match(preload, /togglePanel: \(mode\) => ipcRenderer\.invoke\('pet:togglePanel', mode\)/);

  assert.match(petPanelHtml, /role="tablist" aria-label="桌宠助手功能"/);
  assert.match(petPanelHtml, /id="panel-overview" role="tabpanel"/);
  assert.match(petPanelHtml, /id="panel-chat" role="tabpanel"/);
  assert.match(petPanelHtml, /id="pet-chat-input"[^>]+Shift\+Enter 换行/);
  assert.match(petPanelHtml, /id="pet-chat-form"/);
  assert.match(petPanelApp, /window\.api\.chat\.get\(\)/);
  assert.match(petPanelApp, /window\.api\.ai\.handle\(text, requestId\)/);
  assert.match(petPanelApp, /window\.api\.ai\.resolve\(result\.intent, result\.params, candidate\.id, candidate\.title\)/);
  assert.match(petPanelApp, /window\.api\.ai\.undo\(result\.undo\)/);
  assert.match(petPanelApp, /window\.api\.ai\.cancel\(activeRequest\.id\)/);
  assert.match(petPanelApp, /result\.type === 'confirm'/);
  assert.match(petPanelCss, /\.chat-page \{[\s\S]*?grid-template-rows:/);
  assert.match(petPanelCss, /\.chat-log \{[\s\S]*?user-select: text;/);
  assert.match(petPanelCss, /@media \(prefers-reduced-motion: reduce\)/);

  const elements = {
    pet: fakePetElement(),
    'pet-wrap': fakePetElement(),
    'pet-bubble': fakePetElement(['hidden']),
    'pet-menu': fakePetElement(['hidden']),
    'pet-menu-close': fakePetElement(),
    'pet-menu-title': fakePetElement(),
    'pet-menu-count': fakePetElement(),
    'pet-menu-next': fakePetElement(),
    'pet-sprite': fakePetElement()
  };
  const firstAction = fakePetElement();
  elements['pet-menu'].querySelector = () => firstAction;
  elements['pet-menu'].querySelectorAll = () => [firstAction, elements['pet-menu-close']];
  const { run } = loadPetRuntime(elements, []);
  await Promise.resolve();

  run(`statusSnapshot = {
    todo: 3,
    overdue: 1,
    next: { title: '提交周报', due: '2026-08-19 18:00' }
  }; renderStatus(); setMenuOpen(true, false);`);
  assert.strictEqual(elements['pet-menu-count'].textContent, '3 项待办');
  assert.strictEqual(elements['pet-menu-title'].textContent, '工作台 · 1 项逾期');
  assert.match(elements['pet-menu-next'].textContent, /优先处理.*提交周报/);
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), false);
  assert.strictEqual(elements.pet.attrs['aria-expanded'], 'true');
  assert.strictEqual(firstAction.focused, true);

  run(`remind({ id: 9, title: '提交周报', due: '2026-08-19 18:00' }); setMenuOpen(true, false);`);
  assert.strictEqual(elements['pet-reminder'].classList.contains('hidden'), false);
  assert.match(elements['pet-reminder-text'].textContent, /查看.*提交周报/);

  run(`showBubble('截止时间到了', true, 3000)`);
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), true);
  assert.strictEqual(elements['pet-bubble'].classList.contains('hidden'), true);

  elements.pet.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await elements.pet.listeners.click({ stopPropagation() {} });
  assert.strictEqual(elements.pet.attrs['aria-expanded'], 'true');

  assert.match(petApp, /if \(e\.key !== 'Enter' && e\.key !== ' '\) return;[\s\S]*?petEl\.click\(\)/);
  assert.match(petPanelApp, /function onTabKeyDown\(event\)/);
  assert.match(petPanelApp, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(petPanelApp, /const viewButtons = \$\$\('\.overview-views button'\)/);
  assert.match(petApp, /await refreshStatus\(false\)/);
  assert.doesNotMatch(petApp, /await refreshStatus\(true\)/);
  assert.strictEqual(run(`formatPetDue('${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')} 18:00')`), '今天 18:00');
});

test('桌宠打开视图会阻止重复命令并在失败后保留菜单和焦点', async () => {
  let mode = 'pending';
  let resolvePending;
  const calls = [];
  const label = { textContent: '看板' };
  const action = fakePetElement();
  action.dataset.pet = 'board';
  action.querySelector = (selector) => selector === 'span' ? label : null;
  const grid = fakePetElement();
  const elements = {
    pet: fakePetElement(),
    'pet-wrap': fakePetElement(),
    'pet-bubble': fakePetElement(['hidden']),
    'pet-menu': fakePetElement(),
    'pet-menu-close': fakePetElement(),
    'pet-menu-title': fakePetElement(),
    'pet-menu-count': fakePetElement(),
    'pet-menu-next': fakePetElement(),
    'pet-sprite': fakePetElement(),
    __openView: (destination) => {
      calls.push(destination);
      if (mode === 'pending') return new Promise((resolve) => { resolvePending = resolve; });
      if (mode === 'fail') return Promise.reject(new Error('主窗口未响应'));
      return Promise.resolve({ ok: true });
    },
    __testValues: { action }
  };
  elements['pet-menu'].querySelector = (selector) => selector === '.pm-grid' ? grid : action;
  elements['pet-menu'].querySelectorAll = (selector) => selector === '[data-pet]' ? [action] : [action, elements['pet-menu-close']];
  const { run } = loadPetRuntime(elements, []);
  await Promise.resolve();

  assert.strictEqual(run(`testValues.pending = openPetDestination(testValues.action, 'board', '看板'); petNavigationBusy`), true);
  assert.strictEqual(await run(`openPetDestination(testValues.action, 'board', '看板')`), false);
  assert.deepStrictEqual(calls, ['board']);
  assert.strictEqual(action.disabled, true);
  assert.strictEqual(action.attrs['aria-busy'], 'true');
  assert.strictEqual(label.textContent, '看板');
  resolvePending({ ok: true });
  assert.strictEqual(await run('testValues.pending'), true);
  assert.strictEqual(run('petNavigationBusy'), false);
  assert.strictEqual(action.disabled, false);
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), true);

  mode = 'fail';
  elements['pet-menu'].classList.remove('hidden');
  action.focused = false;
  assert.strictEqual(await run(`openPetDestination(testValues.action, 'board', '看板')`), false);
  assert.strictEqual(elements['pet-menu'].classList.contains('hidden'), false);
  assert.strictEqual(elements['pet-menu-next'].textContent, '暂时无法打开，请重试');
  assert.strictEqual(elements['pet-menu-next'].classList.contains('is-error'), true);
  assert.strictEqual(action.focused, true);
  assert.strictEqual(action.attrs['aria-busy'], 'false');
  assert.strictEqual(label.textContent, '看板');
});

test('桌宠视图工具栏支持二维方向键且只保留一个 Tab 入口', () => {
  const elements = {
    pet: fakePetElement(),
    'pet-wrap': fakePetElement(),
    'pet-bubble': fakePetElement(['hidden']),
    'pet-menu': fakePetElement(['hidden']),
    'pet-menu-close': fakePetElement(),
    'pet-menu-title': fakePetElement(),
    'pet-menu-count': fakePetElement(),
    'pet-menu-next': fakePetElement(),
    'pet-sprite': fakePetElement()
  };
  const buttons = Array.from({ length: 6 }, () => fakePetElement());
  buttons.forEach((button, index) => { button.tabIndex = index === 0 ? 0 : -1; });
  elements['pet-menu'].querySelector = () => ({ addEventListener() {} });
  elements['pet-menu'].querySelectorAll = () => buttons.filter((button) => button.tabIndex === 0);
  const event = {
    key: 'ArrowDown', target: { closest: () => buttons[0] },
    currentTarget: { querySelectorAll: () => buttons }, prevented: false,
    preventDefault() { this.prevented = true; }
  };
  elements.__testValues = { event };
  const { run: runKey } = loadPetRuntime(elements);
  runKey('onViewGridKeyDown(testValues.event)');
  assert.strictEqual(event.prevented, true);
  assert.strictEqual(buttons[0].tabIndex, -1);
  assert.strictEqual(buttons[3].tabIndex, 0);
  assert.strictEqual(buttons[3].focused, true);
  assert.match(petApp, /else target = \(index \+ 3\) % items\.length/);
});

test('提醒可从系统通知、主界面和桌宠准确继续到对应任务', () => {
  assert.match(preload, /'app:open-task'/);
  assert.match(app, /async function openReminderTask\(data\)/);
  assert.match(app, /tasks\.find\(\(item\) => item\.id === id\)/);
  assert.match(app, /switchView\('list'\);\s*openModal\(task\)/);
  assert.match(app, /window\.api\.on\('app:open-task'[\s\S]*?openReminderTask\(data\)/);
  assert.match(app, /window\.api\.on\('app:reminder'[\s\S]*?label: '查看'[\s\S]*?run: \(\) => openReminderTask\(data\)/);
  assert.match(main, /n\.on\('click', \(\) => sendToMain\('app:open-task', \{ id: t\.id \}\)\)/);
  assert.match(main, /function sendWhenReady\(target, channel, payload\)[\s\S]*?if \(target\.webContents\.isLoadingMainFrame\(\)\) target\.webContents\.once\('did-finish-load', send\)/);
  assert.match(main, /sendWhenReady\(mainWindow, 'app:reminder'/);
  assert.match(main, /sendWhenReady\(petWindow, 'pet:remind'/);
});

test('主题和 AI 引擎分段控件暴露并同步选中状态', () => {
  assert.match(app, /id="theme-seg" role="radiogroup" aria-label="外观主题"/);
  assert.match(app, /id="ai-stage-seg" role="radiogroup" aria-label="AI 助手引擎"/);
  assert.ok((app.match(/role="radio" aria-checked=/g) || []).length >= 5);
  assert.ok((app.match(/setAttribute\('aria-checked', 'false'\)/g) || []).length >= 2);
  assert.ok((app.match(/setAttribute\('aria-checked', 'true'\)/g) || []).length >= 2);
  assert.match(html, /id="ai-collapse"[^>]+aria-expanded="true"/);
  assert.match(app, /control\.setAttribute\('aria-expanded', String\(!collapsed\)\)/);
  assert.match(app, /function syncAiCollapseControl\(collapsed\)/);
  assert.match(app, /uiIcon\(collapsed \? 'chevrons-left' : 'chevrons-right'\)/);
  assert.match(html, /id="ai-collapse"[^>]*>[\s\S]*?href="#ui-i-chevrons-right"/);
});

test('外观主题提供液态玻璃、极简单色与暗色并归一旧设置值', () => {
  assert.match(app, /const THEME_VALUES = \['glass', 'mono', 'dark'\]/);
  assert.match(app, /return THEME_VALUES\.includes\(value\) \? value : 'glass';/);
  assert.match(app, /document\.body\.classList\.toggle\('dark', t === 'dark'\)/);
  assert.match(app, /data-theme="glass"[^>]*>液态玻璃</);
  assert.match(app, /data-theme="mono"[^>]*>极简单色</);
  assert.match(app, /data-theme="dark"[^>]*>暗色</);
  assert.match(app, /const previous = normalizeTheme\(settings\.theme\)/);
  assert.match(app, /await window\.api\.settings\.update\(\{ theme: next \}\)/);
  assert.match(html, /href="css\/app\.css"[\s\S]*?href="css\/themes\.css"/);
  assert.match(petApp, /\['light', 'dark', 'auto', 'glass', 'mono'\]\.includes\(theme\)/);
  assert.match(petPanelApp, /\['light', 'dark', 'auto', 'glass', 'mono'\]\.includes\(theme\)/);

  const themesCss = fs.readFileSync(path.join(ROOT, 'src/renderer/css/themes.css'), 'utf8');
  assert.match(themesCss, /html\[data-theme="glass"\] body:not\(\.dark\) \{/);
  assert.match(themesCss, /html\[data-theme="mono"\] body:not\(\.dark\) \{/);
  assert.match(themesCss, /glassAurora/);
  assert.doesNotMatch(themesCss, /html\[data-theme="glass"\] body\.dark/);

  // 行为验证：旧值 light/auto/未知值归一为 glass，dark 仍走 body.dark
  const body = { classList: fakeClassList([]), insertAdjacentHTML() {} };
  const run = loadRendererRuntime({ __body: body });
  const result = run(`(function () {
    const out = {};
    settings = { theme: 'light' };
    applyTheme();
    out.lightTheme = normalizeTheme(settings.theme);
    out.lightDark = document.body.classList.contains('dark');
    settings = { theme: 'auto' };
    out.autoTheme = normalizeTheme(settings.theme);
    settings = { theme: 'mono' };
    applyTheme();
    out.monoDark = document.body.classList.contains('dark');
    settings = { theme: 'dark' };
    applyTheme();
    out.darkTheme = normalizeTheme(settings.theme);
    out.darkDark = document.body.classList.contains('dark');
    settings = { theme: '未知值' };
    out.unknownTheme = normalizeTheme(settings.theme);
    return JSON.stringify(out);
  })()`);
  assert.deepStrictEqual(JSON.parse(result), {
    lightTheme: 'glass',
    lightDark: false,
    autoTheme: 'glass',
    monoDark: false,
    darkTheme: 'dark',
    darkDark: true,
    unknownTheme: 'glass'
  });
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

test('任务筛选使用单一 Tab 停靠点并支持方向键切换', () => {
  let buttons;
  const makeButton = (pressed, hidden = false) => {
    const attrs = { 'aria-pressed': String(pressed) };
    const listeners = {};
    return {
      attrs,
      listeners,
      disabled: false,
      tabIndex: null,
      focused: false,
      getAttribute(name) { return attrs[name]; },
      addEventListener(name, listener) { listeners[name] = listener; },
      closest(selector) { return selector === '.hidden' && hidden ? {} : null; },
      focus() { this.focused = true; },
      click() {
        buttons.forEach((button) => { button.attrs['aria-pressed'] = 'false'; });
        attrs['aria-pressed'] = 'true';
        listeners.click();
      }
    };
  };
  buttons = [makeButton(true), makeButton(false), makeButton(false), makeButton(true, true)];
  const group = { querySelectorAll: () => buttons };
  const run = loadRendererRuntime({ __testValues: { group } });
  run(`bindPressedGroupKeyboard(testValues.group, '.fchip[data-filter]')`);
  assert.deepStrictEqual(buttons.slice(0, 3).map((button) => button.tabIndex), [0, -1, -1]);

  let prevented = false;
  buttons[0].listeners.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.strictEqual(buttons[1].focused, true);
  assert.deepStrictEqual(buttons.slice(0, 3).map((button) => button.tabIndex), [-1, 0, -1]);
});

test('无历史对话时助手直接汇报工作状态', () => {
  assert.match(app, /const overdue = active\.filter/);
  assert.match(app, /当前有 \$\{overdue\.length\} 项逾期任务/);
  assert.doesNotMatch(app, /想记点什么？直接说就行，例如/);
});

test('界面样式包含窄容器和低动态偏好支持', () => {
  assert.match(css, /@container \(max-width: 560px\)/);
  assert.match(css, /\.sr-only \{[\s\S]*?clip-path: inset\(50%\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  for (const [name, value] of Object.entries({ instant: 80, fast: 140, base: 220, slow: 320, loop: 800, pulse: 1200 })) {
    assert.match(css, new RegExp(`--motion-${name}: ${value}ms`));
  }
  assert.doesNotMatch(css, /var\(--(?:dur|ease)\)/);
  assert.match(app, /const MOTION_MS = Object\.freeze\(\{ instant: 80, fast: 140, base: 220, slow: 320 \}\)/);
  assert.match(app, /motionDelay\(MOTION_MS\.base\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?:root \{ --motion-shift: 0px; \}/);
  assert.match(css, /\.view-enter,[\s\S]*?\.modal-mask\.is-closing \.modal \{ animation: none !important; \}/);
  assert.match(petCss, /--pet-motion-(?:fast|base|slow|loop):/);
  assert.match(petApp, /const PET_MOTION_MS = Object\.freeze\(\{ fast: 140, base: 220, slow: 320 \}\)/);
  assert.match(petCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pet-sprite \{[\s\S]*?animation: none !important;[\s\S]*?background-position: 0 var\(--sprite-y\);/);
  assert.match(css, /\.task-row:focus-within \.task-more/);
  // 分层与印章使用渐变，但应避免全局滥用：只允许在指定的「思笺 / 印章 / 展开淡墨」签名元素内出现 gradient
  assert.match(css, /\.msg-reasoning[\s\S]*?\.(?:msg-reasoning-seal|msg-reasoning-body|msg-reasoning::before)[\s\S]*?(?:linear|radial)-gradient\(/);
  // 不允许在任务行、表单、工具按钮、弹窗外的通用表面层滥用 gradient 做假分层
  const surfaceAbuse = css.match(/\.(?:task-row|sidebar|panel-surface|toolbar|nav-item|m-actions|trash-row|batch-bar|memo-workspace|board-card)\s*\{[^}]*?(?:linear|radial)-gradient\(/g);
  assert.ok(surfaceAbuse === null, `通用表面层不应滥用 gradient：${JSON.stringify(surfaceAbuse||[])}`);
  assert.match(css, /\.board-cols \{[^}]*overflow-x: auto;/);
  assert.match(css, /@container \(max-width: 560px\)[\s\S]*?\.trash-row \{ grid-template-columns: 1fr; align-items: start; \}/);
});

test('窗口控件和任务弹窗提供明确语义与小窗布局', () => {
  assert.match(html, /id="tb-min"[^>]+aria-label="最小化窗口"/);
  assert.match(html, /id="tb-max"[^>]+aria-label="最大化窗口"/);
  assert.match(html, /id="m-close"[^>]+aria-label="关闭任务编辑"/);
  assert.match(html, /id="tb-min"[^>]*>[\s\S]*?href="#ui-i-minus"/);
  assert.match(html, /id="tb-max"[^>]*>[\s\S]*?href="#ui-i-square"/);
  assert.match(html, /id="tb-quit"[^>]*>[\s\S]*?href="#ui-i-x"/);
  assert.match(html, /id="m-close"[^>]*>[\s\S]*?href="#ui-i-x"/);
  assert.match(html, /id="m-due-clear"[^>]*>[\s\S]*?href="#ui-i-x"/);
  assert.match(app, /btn\.innerHTML = uiIcon\(maximized \? 'copy' : 'square'\)/);
  assert.match(css, /\.tb-btn \.ui-icon \{ width: 13px; height: 13px; \}/);
  assert.match(css, /#m-due-clear \{ width: 30px; height: 30px; flex: 0 0 30px;/);
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
  assert.match(css, /--accent-hover: #A03627/);
  assert.match(css, /--muted-rgb: 115, 123, 131/);
  assert.match(css, /--control-md: 36px/);
  assert.doesNotMatch(css, /rgba\((?:196, 69, 59|199, 138, 43|62, 142, 90|122, 111, 96|240, 140, 80)/);
  assert.doesNotMatch(css, /#E8743B/i);
  assert.doesNotMatch(app, /badge\.style\.(?:background|color|borderColor)/);
  assert.match(app, /const stateClass = stage === 'llm'/);
});

test('统计与看板日历已裁剪，记录视图就位并保留报告基建', () => {
  assert.doesNotMatch(app, /function renderStat\(|function renderBoard\(|function renderCal\(|function beginReportAction|reportActionBusy|stat-grid|trend-chart|renderSmartFilters/);
  assert.doesNotMatch(html, /id="view-stat"|id="view-board"|id="view-cal"|id="smart-filters"|id="report-preview"/);
  // 记录视图占位（阶段 4 填充工作记录）
  assert.match(html, /<section class="view" id="view-records"/);
  assert.match(html, /id="records-sub" aria-live="polite"/);
  assert.match(html, /<div class="view-body" id="records-body"><\/div>/);
  assert.match(app, /async function renderRecords\(\)/);
  assert.match(app, /window\.api\.worklog\.get\(\)/);
  // 报告基建保留：AI 报告通道与文件名助手供对话报告使用
  assert.match(preload, /report: \(input, requestId\) => ipcRenderer\.invoke\('ai:report'/);
  assert.match(main, /ipcMain\.handle\('ai:report'/);
  assert.match(app, /function reportCard\(result\)/);
  assert.match(app, /function weeklyReportFileName\(weekOffset\)/);
  assert.match(app, /function dailyReportFileName\(dayOffset\)/);
  assert.match(app, /result\.degradeNotice \|\| '模型未启用，已降级为本地事实模板'/);
  assert.match(css, /\.report-degrade-reason \{[^}]*color: var\(--warn\)/);
});

test('任务列表拖拽排序阻止并发写入并在失败后恢复原界面', async () => {
  let release;
  let reorderCalls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const surfaceAttrs = {};
  const surface = { setAttribute(name, value) { surfaceAttrs[name] = value; } };
  const item = { isConnected: true, classList: fakeClassList() };
  const toasts = [];
  const run = loadRendererRuntime({
    '#tasks-list': surface,
    __window: { api: { tasks: { reorder: async () => { reorderCalls++; await pending; } } } },
    __testValues: { item, toasts }
  });
  run(`
    toast = (message) => testValues.toasts.push(message);
    refreshTasksAfterMutation = async () => {};
  `);
  const first = run(`commitTaskOrder([2, 1], testValues.item, '已调整任务顺序', '刷新失败')`);
  const duplicate = await run(`commitTaskOrder([1, 2], testValues.item, '已调整任务顺序', '刷新失败')`);
  assert.strictEqual(duplicate, false);
  assert.strictEqual(reorderCalls, 1);
  assert.strictEqual(surfaceAttrs['aria-busy'], 'true');
  release();
  assert.strictEqual(await first, true);
  assert.strictEqual(surfaceAttrs['aria-busy'], 'false');
  assert.strictEqual(item.classList.contains('reorder-commit'), false);

  run(`
    window.api.tasks.reorder = async () => { throw new Error('写入失败'); };
    playTransientClass = (element, name) => element.classList.add(name);
  `);
  assert.strictEqual(await run(`commitTaskOrder([2, 1], testValues.item, '已调整任务顺序', '刷新失败')`), false);
  assert.strictEqual(run('taskReorderBusy'), false);
  assert.strictEqual(surfaceAttrs['aria-busy'], 'false');
  assert.strictEqual(item.classList.contains('reorder-error'), true);
  assert.match(toasts[toasts.length - 1], /任务仍在原位置/);
  assert.match(css, /\.task-row\.reorder-commit,[\s\S]*?animation: reorderCommit/);
  assert.match(css, /\.task-row\.reorder-error,[\s\S]*?animation: reorderError/);
});

test('清单支持键盘重排并在重绘后恢复到同一任务', async () => {
  const orders = [];
  const makeItem = (id) => ({
    dataset: { id: String(id) },
    classList: fakeClassList(),
    isConnected: true
  });
  const first = makeItem(1);
  const second = makeItem(2);
  const focused = { focus(options) { this.focused = true; this.options = options; } };
  const listAttrs = {};
  const listEl = {
    querySelectorAll() { return [first, second]; },
    setAttribute(name, value) { listAttrs[name] = value; },
    removeAttribute(name) { delete listAttrs[name]; }
  };
  const run = loadRendererRuntime({
    '#tasks-list': listEl,
    '#tasks-list .task-row[data-id="2"]': second,
    '#tasks-list .task-row[data-id="2"] .task-title-btn': focused,
    __window: { api: { tasks: { reorder: async (ids) => { orders.push(ids); } } } }
  });
  run(`refreshTasksAfterMutation = async () => {}; toast = () => {}`);
  assert.strictEqual(await run(`reorderTaskByKeyboard(2, -1)`), true);
  assert.strictEqual(JSON.stringify(orders), JSON.stringify([[2, 1]]));
  assert.strictEqual(focused.focused, true);
  assert.strictEqual(focused.options.preventScroll, true);
  assert.match(app, /#tasks-list'\)\.addEventListener\('keydown', onTaskReorderKeyDown\)/);
  assert.match(app, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
});

test('任务搜索、今日空态与清单视图形成完整且一致的工作流', () => {
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

  runSearch(`currentSearch = ''; renderList(testValues.container, [])`);
  assert.match(container.innerHTML, /还没有任务/);
  assert.match(container.innerHTML, /id="empty-new-task">新建任务/);

  const listSub = { textContent: '占位' };
  const runTasks = loadRendererRuntime({
    '#tasks-list': { innerHTML: '', insertAdjacentHTML(where, html) { this.innerHTML += html; } },
    '#list-sub': listSub
  });
  runTasks(`
    tasks = [
      { id: 1, title: '可见任务', status: 'todo', order: 1, createdAt: 1 },
      { id: 2, title: '归档任务', status: 'archived', order: 2, createdAt: 2 }
    ];
    listTab = 'tasks';
    renderTasks();
  `);
  assert.match(listSub.textContent, /显示 2 · 完成 0 \/ 1/);
  runTasks(`listTab = 'memos'; renderTasks();`);
  assert.match(listSub.textContent, /显示 2/);

  // 旧视图名映射到四个视图（今天/清单/记录/设置）
  assert.match(app, /const VIEW_ALIASES = \{[\s\S]*?tasks: 'list',[\s\S]*?trash: 'settings',[\s\S]*?stat: 'records'/);
  assert.match(app, /if \(\['today', 'list', 'records', 'settings', 'tasks', 'memos', 'board', 'cal', 'stat', 'stats', 'trash'\]\.includes\(view\)\) switchView\(view\)/);
  assert.match(app, /\$\('#today-empty-all'\)\?\.addEventListener\('click', \(\) => \{\s*switchView\('list'\);\s*setListTab\('tasks'\);/);
  assert.match(app, /\$\('#today-empty-new'\)\?\.addEventListener\('click', \(\) => openModal\(null\)\)/);
  assert.match(app, /uiIcon\('search'\)/);
});

test('设置页提供章节导航并将焦点送到真实内容分组', () => {
  assert.match(app, /class="settings-nav" aria-label="设置章节"/);
  assert.match(app, /data-settings-target="settings-general" aria-controls="settings-general" aria-current="location" tabindex="0">数据<\/button>/);
  assert.match(app, /function setSettingsNavActive\(targetId\)/);
  assert.match(app, /function syncSettingsNavFromScroll\(\)/);
  assert.match(app, /content\.scrollTop >= maxScrollTop - 2[\s\S]*?setSettingsNavActive\(sections\[sections\.length - 1\]\.id\)/);
  assert.match(app, /content\.addEventListener\('scroll', \(\) =>/);
  assert.match(app, /button\.classList\.toggle\('active', active\)/);
  assert.match(app, /setSettingsNavActive\(targetId\);/);
  assert.strictEqual((app.match(/class="settings-nav-item[^>]+tabindex="-1"/g) || []).length, 3);
  assert.match(app, /settings-body \.settings-nav'\)\?\.addEventListener\('keydown', onSettingsNavKeyDown\)/);
  assert.match(app, /function onSettingsNavKeyDown\(event\)/);
  assert.match(app, /id="settings-assistant" tabindex="-1" aria-labelledby="settings-assistant-title"/);
  assert.match(app, /id="settings-shortcuts" tabindex="-1" aria-labelledby="settings-shortcuts-title"/);
  assert.match(app, /id="settings-danger" tabindex="-1" aria-labelledby="settings-danger-title"/);
  assert.match(css, /\.settings-nav \{[^}]*position: sticky;[^}]*overflow-x: auto;/);
  assert.match(css, /\.settings-nav-item\.active \{[^}]*border-bottom-color: var\(--accent2\);/);
  assert.match(css, /\.settings-nav-item\.danger\.active \{[^}]*border-bottom-color: var\(--danger\);/);
  assert.match(css, /\.set-group \{[^}]*scroll-margin-top: 52px;/);

  const target = {
    scrollOptions: null,
    focusOptions: null,
    scrollIntoView(options) { this.scrollOptions = options; },
    focus(options) { this.focusOptions = options; },
    closest() { return null; }
  };
  const run = loadRendererRuntime({ '#settings-shortcuts': target });
  assert.strictEqual(run(`focusSettingsSection('settings-shortcuts')`), true);
  assert.strictEqual(target.scrollOptions.block, 'start');
  assert.strictEqual(target.focusOptions.preventScroll, true);

  const first = { tabIndex: 0, focused: false, focus() { this.focused = true; }, closest() { return this; } };
  const second = { tabIndex: -1, focused: false, focus() { this.focused = true; }, closest() { return this; } };
  const event = {
    key: 'ArrowRight', target: first, currentTarget: { querySelectorAll: () => [first, second] },
    prevented: false, preventDefault() { this.prevented = true; }
  };
  const runNav = loadRendererRuntime({ __testValues: { event } });
  runNav('onSettingsNavKeyDown(testValues.event)');
  assert.strictEqual(event.prevented, true);
  assert.strictEqual(first.tabIndex, -1);
  assert.strictEqual(second.tabIndex, 0);
  assert.strictEqual(second.focused, true);

  const sectionIds = ['settings-general', 'settings-assistant', 'settings-shortcuts', 'settings-danger'];
  const sectionButtons = sectionIds.map((id) => ({
    dataset: { settingsTarget: id },
    classList: fakeClassList(),
    tabIndex: -1,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }
  }));
  const sections = sectionIds.map((id, index) => ({
    id,
    getBoundingClientRect: () => ({ top: 100 + index * 240 })
  }));
  const scrollContent = {
    scrollTop: 600,
    scrollHeight: 1200,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0 })
  };
  const stickyNav = { getBoundingClientRect: () => ({ height: 42 }) };
  const runScroll = loadRendererRuntime({
    '.content': scrollContent,
    '#settings-body .settings-nav': stickyNav,
    __querySelectorAll: (selector) => {
      if (selector === '#settings-body .set-group') return sections;
      if (selector === '#settings-body .settings-nav [data-settings-target]') return sectionButtons;
      return [];
    }
  });
  runScroll('syncSettingsNavFromScroll()');
  assert.strictEqual(sectionButtons[3].attributes['aria-current'], 'location');
  assert.strictEqual(sectionButtons[3].tabIndex, 0);
  assert.strictEqual(sectionButtons[0].attributes['aria-current'], undefined);
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
  assert.match(app, /list\.innerHTML = loadErrorHtml\('trash'\)/);
  assert.match(css, /\.load-state\.error \{/);
  assert.match(css, /@keyframes loadSpin/);
  assert.match(main, /--work-helper-data-dir=/);
  assert.match(main, /app\.setPath\('userData', isolatedRoot\)/);
});

test('设置操作失败时恢复原状态并结束忙碌反馈', () => {
  assert.match(app, /设置保存失败，已恢复原状态/);
  assert.match(app, /sw\.classList\.toggle\('on', previous\)/);
  assert.match(app, /AI 引擎切换失败，已恢复原设置/);
  assert.match(app, /主题保存失败，已恢复原设置/);
  assert.match(app, /测试失败，请检查配置或网络/);
  assert.match(app, /res\.ok \? '' : \(res\.message \|\| '模型连接测试未通过，请检查配置后重试。'\)/);
  assert.match(app, /setAiRuntimeState\('degraded', '模型连接测试未通过，请检查配置或网络。'\)/);
  assert.match(app, /box\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /box\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(app, /await window\.api\.data\.openDir\(\)/);
  assert.match(app, /无法打开数据文件夹，请稍后重试/);
  assert.match(app, /runSettingsAction\(button, '打开中…'/);
  assert.match(app, /'无法打开数据文件夹，请稍后重试', 'data'\)/);
  assert.match(main, /ipcMain\.handle\('data:openDir'[\s\S]*?shell\.openPath\(store\.getDataDir\(\)\)/);
  assert.match(preload, /openDir: \(\) => ipcRenderer\.invoke\('data:openDir'\)/);
  assert.doesNotMatch(app, /id="btn-pick-dir"/);
  assert.doesNotMatch(main, /ipcMain\.handle\('data:pickDir'/);
  assert.doesNotMatch(preload, /pickDir: \(\) => ipcRenderer\.invoke\('data:pickDir'\)/);
});

test('设置同组操作共享互斥锁并在完成后恢复全部控件', async () => {
  const makeControl = () => ({
    attrs: {}, disabled: false, isConnected: true, innerHTML: '<span>操作</span>', textContent: '',
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    closest() { return null; },
    focus(options) { this.focused = true; this.focusOptions = options; }
  });
  const button = makeControl();
  const peer = makeControl();
  const run = loadRendererRuntime({
    __activeElement: button,
    __testValues: { button },
    __querySelectorAll(selector) {
      return selector === '#settings-body [data-settings-scope="data"]' ? [button, peer] : [];
    }
  });

  run(`
    globalThis.__settingsRuns = 0;
    globalThis.__settingsPending = runSettingsAction(
      testValues.button,
      '处理中…',
      () => new Promise((resolve) => {
        globalThis.__settingsRuns += 1;
        globalThis.__finishSettings = resolve;
      }),
      '操作失败',
      'data'
    );
  `);
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(peer.disabled, true);
  assert.strictEqual(button.attrs['aria-busy'], 'true');
  assert.strictEqual(peer.attrs['data-scope-locked'], 'true');

  const duplicate = await run(`runSettingsAction(testValues.button, '处理中…', async () => {
    globalThis.__settingsRuns += 1;
  }, '操作失败', 'data')`);
  assert.strictEqual(duplicate, false);
  assert.strictEqual(run('globalThis.__settingsRuns'), 1);

  run(`globalThis.__finishSettings('done')`);
  assert.strictEqual(await run('globalThis.__settingsPending'), 'done');
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(peer.disabled, false);
  assert.strictEqual(button.attrs['aria-busy'], 'false');
  assert.strictEqual(peer.attrs['data-scope-locked'], undefined);
  assert.strictEqual(run(`settingsActionScopes.has('data')`), false);
});

test('设置、统计与回收站补齐标签、键盘退出和可恢复状态', () => {
  assert.match(html, /id="records-sub" aria-live="polite"/);
  assert.match(html, /id="trash-sub" aria-live="polite"/);
  ['ai-provider', 'ai-base-url', 'ai-api-key', 'ai-model', 'ai-temperature'].forEach((id) => {
    assert.match(app, new RegExp(`<label class="sr-t" for="${id}">`));
    assert.match(app, new RegExp(`id="${id}"[^>]+aria-describedby="${id}-desc"`));
  });
  assert.match(app, /Number\.isFinite\(temperature\) \? temperature : 0\.2/);
  assert.match(app, /if \(e\.key === 'Tab'\) return/);
  assert.match(app, /if \(e\.key === 'Escape'\)[\s\S]*?el\.blur\(\)/);
  assert.match(app, /快捷键保存失败，已恢复原设置/);
  assert.match(app, /el\.readOnly = true;\s*el\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /el\.readOnly = false;\s*el\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(app, /function runSettingsAction\(button, busyText, action, failureMessage, scope\)/);
  assert.match(app, /const idleHtml = button\.innerHTML;[\s\S]*?button\.innerHTML = idleHtml/);
  assert.match(app, /id="btn-export-json"[^>]+data-settings-scope="data">\$\{uiIcon\('download'\)\}<span>导出 JSON<\/span>/);
  assert.match(app, /id="btn-import-json"[^>]+data-settings-scope="data">\$\{uiIcon\('upload'\)\}<span>导入 JSON<\/span>/);
  assert.match(app, /id="btn-backup-now"[^>]+data-settings-scope="data">\$\{uiIcon\('save'\)\}<span>立即备份<\/span>/);
  assert.match(app, /function downloadSettingsFile\(content, type, fileName\)[\s\S]*?URL\.revokeObjectURL\(url\)/);
  assert.match(app, /id="backup-retry">重试/);
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
  assert.match(app, /class="trash-kind task">\$\{uiIcon\('tasks'\)\}<span>任务<\/span>/);
  assert.match(app, /class="trash-kind memo">\$\{uiIcon\('memos'\)\}<span>备忘录<\/span>/);
  assert.match(app, /data-restore-task="\$\{t\.id\}"[^>]*>\$\{uiIcon\('undo'\)\}<span>恢复<\/span>/);
  assert.match(app, /data-purge-task="\$\{t\.id\}"[^>]*>\$\{uiIcon\('trash'\)\}<span>永久删除<\/span>/);
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
  assert.match(css, /\.trash-kind \.ui-icon \{ width: 11px; height: 11px; \}/);
});

test('数据导入区分解析、部分写入与刷新结果', () => {
  assert.match(app, /runSettingsAction\(importButton, '导入中…'/);
  assert.match(app, /无法读取导入文件/);
  assert.match(app, /任务导入失败/);
  assert.match(app, /已导入 \$\{imported\.length\} 条任务，但/);
  assert.match(app, /refreshTasksAfterMutation\('任务已导入，但列表刷新失败'\)/);
  assert.match(app, /refreshMemosAfterMutation\('备忘录已导入，但列表刷新失败'\)/);
  assert.match(app, /'导入失败，请检查文件后重试', 'data'\)/);
  assert.doesNotMatch(app, /<button(?![^>]*type=)/);
});

test('备份恢复等待自动保存并独立处理界面重载', () => {
  assert.match(app, /async function reloadRestoredWorkspace\(result, label, focusTarget\)/);
  assert.match(app, /if \(memoSaveTimer\) clearTimeout\(memoSaveTimer\)/);
  assert.match(app, /const \[taskResult, memoResult, taskTrashResult, memoTrashResult\] = await Promise\.allSettled/);
  assert.match(app, /数据已经恢复，但界面未完整刷新/);
  assert.match(app, /if \(\(await saveMemoNow\(\)\) === false\) return false;\s*const result = await window\.api\.data\.restoreBackup/);
  assert.match(app, /return reloadRestoredWorkspace\(result, '已恢复到备份点', '#btn-backup-now'\)/);
  assert.match(app, /return reloadRestoredWorkspace\(result, '已从文件恢复', '#btn-restore-file'\)/);
  assert.match(app, /return \{ focusTarget \};/);
  assert.match(app, /box\.classList\.toggle\('is-refreshing', hasContent\)/);
  assert.match(css, /\.backup-list\.is-refreshing::before/);
});

test('暗色搜索聚焦保持深色背景，主操作色满足白字对比度', () => {
  assert.match(css, /body\.dark \.task-tools #search-input:focus,\s*body\.dark \.quick-add input:focus \{ background: var\(--bg2\); \}/);

  const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const dark = css.match(/body\.dark\s*\{([\s\S]*?)\}/)[1];
  assert.ok(contrastRatio(cssVar(root, 'grad'), '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio(cssVar(dark, 'grad'), '#FFFFFF') >= 4.5);
  ['solid-accent', 'solid-info', 'solid-ok', 'solid-warn', 'solid-danger', 'solid-neutral'].forEach((name) => {
    assert.ok(contrastRatio(cssVar(root, name), '#FFFFFF') >= 4.5, `${name} 与白字对比度不足`);
  });
  assert.match(css, /\.pri-dot\.p3 \{ background: var\(--solid-warn\); \}/);
  assert.match(css, /body\.dark \.turn-action\.primary \{ border-color: var\(--solid-accent\); background: var\(--solid-accent\);/);

  const petRoot = petCss.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const petDark = petCss.match(/body\.dark\s*\{([\s\S]*?)\}/)[1];
  assert.ok(contrastRatio(cssVar(petRoot, 'pet-primary'), '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio(cssVar(petDark, 'pet-primary'), '#FFFFFF') >= 4.5);
  assert.match(petCss, /\.pm-main \{[\s\S]*?background: var\(--pet-primary\); color: #F7F6F2;/);
});

test('备忘录工作区具备可访问导航、编辑与完整 IPC', () => {
  assert.match(html, /id="list-tab-memos"/);
  assert.match(html, /id="list-memos-panel"/);
  assert.match(html, /id="memo-list" role="listbox"/);
  assert.match(app, /role="option" tabindex="\$\{memo\.id === focusId \? 0 : -1\}" aria-selected=/);
  assert.match(html, /id="memo-content"[^>]+aria-label="备忘录正文"/);
  assert.match(html, /id="memo-pin"[^>]+aria-pressed="false"/);
  assert.match(main, /ipcMain\.handle\('memos:create'/);
  assert.match(main, /ipcMain\.handle\('memos:emptyTrash'/);
  assert.match(preload, /memos:\s*\{/);
  assert.match(preload, /update: \(id, patch\) => ipcRenderer\.invoke\('memos:update', id, patch\)/);
});

test('备忘录列表使用单一 Tab 停靠点并支持方向键选择', async () => {
  let items;
  const list = { querySelectorAll: () => items };
  const makeItem = (id) => ({
    dataset: { memoId: String(id) },
    closest(selector) {
      if (selector === '[data-memo-id]') return this;
      if (selector === '#memo-list') return list;
      return null;
    }
  });
  items = [makeItem(1), makeItem(2), makeItem(3)];
  const selected = [];
  let prevented = false;
  const event = { target: items[0], key: 'ArrowDown', preventDefault() { prevented = true; } };
  const run = loadRendererRuntime({ __testValues: { event, selected, items } });
  run(`selectMemo = async (id, restoreFocus) => { testValues.selected.push([id, restoreFocus]); return true; }`);
  await run('onMemoListKeyDown(testValues.event)');
  assert.strictEqual(prevented, true);
  assert.strictEqual(JSON.stringify(selected), JSON.stringify([[2, true]]));

  await run(`testValues.event.target = testValues.items[2]; testValues.event.key = 'Home'; onMemoListKeyDown(testValues.event)`);
  assert.strictEqual(JSON.stringify(selected), JSON.stringify([[2, true], [1, true]]));
  assert.match(app, /#memo-list'\)\.addEventListener\('keydown', onMemoListKeyDown\)/);
  assert.match(app, /#memo-search'\)\.addEventListener\('keydown'[\s\S]*?event\.key !== 'ArrowDown'/);
});

test('备忘录操作栏使用统一工具按钮并提供即时状态反馈', () => {
  assert.match(html, /class="memo-actions" role="group" aria-label="备忘录操作"/);
  assert.match(html, /class="memo-action-group"/);
  assert.match(html, /id="memo-copy" data-tooltip="复制" aria-label="复制备忘录"/);
  assert.match(html, /class="memo-tool memo-delete-tool" id="memo-delete" data-tooltip="删除"/);
  assert.match(html, /class="memo-task-action" id="memo-to-task"/);
  assert.match(html, /id="memo-pin"[\s\S]*?href="#ui-i-pin"/);
  assert.match(html, /id="memo-copy"[\s\S]*?href="#ui-i-copy"/);
  assert.match(html, /id="memo-delete"[\s\S]*?href="#ui-i-trash"/);
  assert.match(css, /\.memo-tool\[data-tooltip\]::after/);
  assert.match(css, /\.memo-delete-tool:hover,[\s\S]*color: var\(--danger\)/);
  assert.match(app, /button\.classList\.add\('copied'\)/);
  assert.match(app, /button\.innerHTML = uiIcon\('check'\)/);
  assert.match(app, /beginMemoAction\(button, '创建中…'\)/);
  assert.match(app, /beginMemoAction\(button, '置顶中…'\)/);
  assert.match(css, /\.memo-tool\.is-busy \.ui-icon,[\s\S]*?animation: buttonBusySpin/);
});

test('备忘录工具栏从保存前开始互斥并在结束后恢复焦点', () => {
  const makeControl = (id, withLabel) => {
    const label = withLabel ? { textContent: '转为任务' } : null;
    return {
      id,
      attrs: {},
      classList: fakeClassList(),
      dataset: {},
      disabled: false,
      focused: false,
      setAttribute(name, value) { this.attrs[name] = value; },
      querySelector() { return label; },
      focus() { this.focused = true; },
      label
    };
  };
  const controls = {
    '#memo-pin': makeControl('memo-pin'),
    '#memo-copy': makeControl('memo-copy'),
    '#memo-to-task': makeControl('memo-to-task', true),
    '#memo-delete': makeControl('memo-delete')
  };
  const saveState = { dataset: {}, textContent: '' };
  const run = loadRendererRuntime({
    ...controls,
    '#memo-save-state': saveState
  });
  run(`
    currentView = 'memos';
    memos = [{ id: 1, title: '发布清单', content: '', tags: [], pinned: false }];
    selectedMemoId = 1;
    memoDirty = false;
    memoSavePending = 0;
    currentView = 'list'; listTab = 'memos'; testValues.release = beginMemoAction(document.getElementById('memo-to-task'), '创建中…');
  `);
  assert.strictEqual(run('memoActionBusy'), true);
  assert.ok(Object.values(controls).every((control) => control.disabled));
  assert.strictEqual(controls['#memo-to-task'].attrs['aria-busy'], 'true');
  assert.strictEqual(controls['#memo-to-task'].label.textContent, '创建中…');
  assert.strictEqual(run(`beginMemoAction(document.getElementById('memo-pin'), '置顶中…')`), null);

  run('testValues.release()');
  assert.strictEqual(run('memoActionBusy'), false);
  assert.ok(Object.values(controls).every((control) => !control.disabled));
  assert.strictEqual(controls['#memo-to-task'].attrs['aria-busy'], 'false');
  assert.strictEqual(controls['#memo-to-task'].label.textContent, '转为任务');
  assert.strictEqual(controls['#memo-to-task'].focused, true);
});

test('新建备忘录先进草稿：等待旧保存时拒绝重复进入，且不当场落库', async () => {
  const makeButton = () => ({
    attrs: {}, disabled: false,
    setAttribute(name, value) { this.attrs[name] = value; }
  });
  const newButton = makeButton();
  const emptyButton = makeButton();
  const title = { focusCalled: false, focus() { this.focusCalled = true; } };
  let createCalls = 0;
  const run = loadRendererRuntime({
    '#memo-new': newButton,
    '#memo-empty-new': emptyButton,
    '#memo-title': title,
    __window: {
      api: {
        memos: {
          create: async () => {
            createCalls++;
            return { id: 8, title: '新内容', content: '新内容', tags: [], pinned: false };
          }
        }
      }
    }
  });
  run(`
    saveMemoNow = () => new Promise((resolve) => { testValues.releaseSave = resolve; });
    renderMemos = () => {};
    toast = () => {};
    testValues.first = createMemo();
  `);
  assert.strictEqual(run('memoCreating'), true);
  assert.strictEqual(newButton.disabled, true);
  assert.strictEqual(emptyButton.disabled, true);
  assert.strictEqual(await run('createMemo()'), false);
  assert.strictEqual(createCalls, 0);

  await run('testValues.releaseSave(true); testValues.first');
  // 新建不再直接创建记录，只进入未保存草稿
  assert.strictEqual(createCalls, 0, '点新建不该立刻落库');
  assert.strictEqual(run('!!memoDraftMemo'), true);
  assert.strictEqual(run('selectedMemoId'), run('MEMO_DRAFT_ID'));
  assert.strictEqual(run('memoCreating'), false);
  assert.strictEqual(newButton.disabled, false);
  assert.strictEqual(emptyButton.disabled, false);
  assert.strictEqual(title.focusCalled, true);
  // 已有草稿时再次点新建回到同一份草稿，不产生第二份
  assert.strictEqual(await run('createMemo()'), true);
  assert.strictEqual(run('memoDraftMemo ? 1 : 0'), 1);
});

test('草稿只有写下内容才落库，空草稿切走即丢弃', async () => {
  const created = [];
  const title = { value: '' };
  const content = { value: '' };
  const tags = { value: '' };
  const run = loadRendererRuntime({
    '#memo-title': title,
    '#memo-content': content,
    '#memo-tags': tags,
    '#memo-editor': { classList: fakeClassList([]) },
    '#memo-save-state': { dataset: {}, textContent: '' },
    '#memo-updated': { textContent: '' },
    __window: {
      api: {
        memos: {
          create: async (data) => {
            created.push(data);
            return Object.assign({ id: 9, pinned: false, updatedAt: Date.now() }, data);
          }
        }
      }
    }
  });
  run('renderMemos = () => {}; toast = () => {};');
  run('memos = []; memoDraftMemo = { id: MEMO_DRAFT_ID, title: "", content: "", tags: [], _draft: true }; selectedMemoId = MEMO_DRAFT_ID;');
  await run('saveMemoNow()');
  assert.strictEqual(created.length, 0, '空草稿不该落库');
  assert.strictEqual(run('memoDraftMemo'), null, '空草稿切走时应直接丢弃');

  run('memos = []; memoDraftMemo = { id: MEMO_DRAFT_ID, title: "", content: "", tags: [], _draft: true }; selectedMemoId = MEMO_DRAFT_ID;');
  content.value = '随机事件规格分级的三条主线，先落文档再排优先级';
  await run('saveMemoNow()');
  assert.strictEqual(created.length, 1, '写下内容才创建一条');
  assert.match(created[0].title, /随机事件规格分级/, '标题留空时应取正文开头');
  assert.strictEqual(run('selectedMemoId'), 9);
  assert.strictEqual(run('memoDraftMemo'), null);
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
  assert.match(app, /window\.api\.memos\.emptyTrash\(\)/);
  assert.match(css, /\.memo-list-item\.pinned::before/);
  assert.match(css, /\.memo-content \{[\s\S]*user-select: text;/);
  assert.match(app, /const revision = memoDraftRevision/);
  assert.match(app, /selectedMemoId === id && revision === memoDraftRevision/);
  assert.match(css, /#memo-save-state\[data-state="saving"\]::before/);
});

test('备忘录只有最新草稿完成后才显示已保存', async () => {
  let releaseFirst;
  let releaseSecond;
  let updateCalls = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const title = { value: '会议记录' };
  const content = { value: '第一版' };
  const tags = { value: '' };
  const saveState = { dataset: {}, textContent: '' };
  const updatedLabel = { textContent: '' };
  const editor = { classList: fakeClassList() };
  const run = loadRendererRuntime({
    '#memo-title': title,
    '#memo-content': content,
    '#memo-tags': tags,
    '#memo-save-state': saveState,
    '#memo-updated': updatedLabel,
    '#memo-editor': editor,
    __window: {
      api: {
        memos: {
          update: async (id, patch) => {
            updateCalls++;
            await (updateCalls === 1 ? firstGate : secondGate);
            return { id, ...patch, pinned: false, updatedAt: Date.now() };
          }
        }
      }
    }
  });
  run(`
    memos = [{ id: 1, title: '会议记录', content: '', tags: [], pinned: false, updatedAt: 1 }];
    selectedMemoId = 1;
    memoDirty = true;
    memoDraftRevision = 1;
    renderMemoList = () => {};
    toast = () => {};
  `);
  const firstSave = run('saveMemoNow()');
  await Promise.resolve();
  content.value = '第二版';
  run(`memoDirty = true; memoDraftRevision = 2; setMemoSaveState('waiting', '等待保存…')`);
  const secondSave = run('saveMemoNow()');
  assert.strictEqual(saveState.textContent, '保存中…');
  releaseFirst();
  await firstSave;
  await Promise.resolve();
  assert.strictEqual(updateCalls, 2);
  assert.strictEqual(saveState.textContent, '保存中…');
  releaseSecond();
  await secondSave;
  assert.strictEqual(saveState.dataset.state, 'saved');
  assert.strictEqual(saveState.textContent, '已保存');
  assert.strictEqual(run(`memos[0].content`), '第二版');
  assert.strictEqual(run('memoSavePending'), 0);
});

test('备忘录列表在运行时支持置顶排序展示和标签解析', () => {
  const list = { innerHTML: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const sub = { textContent: '' };
  const filters = { innerHTML: '' };
  const run = loadRendererRuntime({ '#memo-list': list, '#list-sub': sub, '#memo-filters': filters });
  run("listTab = 'memos';");
  const tags = JSON.parse(run(`JSON.stringify(parseMemoTags('工作， 灵感,产品  复盘'))`));
  assert.deepStrictEqual(tags, ['工作', '灵感', '产品', '复盘']);
  run(`memos = [
    { id: 2, title: '普通记录', content: '稍后处理', tags: [], pinned: false, updatedAt: Date.now() - 1000 },
    { id: 1, title: '重点记录', content: '优先查看', tags: ['工作'], pinned: true, updatedAt: Date.now() }
  ]; selectedMemoId = 1; renderMemoList();`);
  assert.match(sub.textContent, /2 条 · 1 条置顶/);
  assert.ok(list.innerHTML.indexOf('重点记录') < list.innerHTML.indexOf('普通记录'));
  assert.match(list.innerHTML, /memo-list-item active pinned/);
  assert.strictEqual((list.innerHTML.match(/tabindex="0"/g) || []).length, 1);
  assert.strictEqual((list.innerHTML.match(/tabindex="-1"/g) || []).length, 1);
  // 条目上直接可见标签，筛选条给出可点击的标签 chip
  assert.match(list.innerHTML, /class="tag-chip">#工作<\/span>/);
  assert.match(filters.innerHTML, /data-memo-filter="tag:工作"/);
  assert.match(filters.innerHTML, /aria-pressed="true" data-memo-filter="all"/);
});

test('备忘录筛选与批量只作用于当前可见条目', () => {
  const list = { innerHTML: '', attrs: {}, focus: () => {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const sub = { textContent: '' };
  const filters = { innerHTML: '' };
  const bar = { classList: fakeClassList(['hidden']), attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const run = loadRendererRuntime({
    '#memo-list': list,
    '#list-sub': sub,
    '#memo-filters': filters,
    '#memo-batch-bar': bar,
    '#memo-batch-count': { textContent: '' },
    '#memo-batch-select-all': { disabled: false, textContent: '' },
    '#memo-batch-pin': { disabled: false },
    '#memo-batch-unpin': { disabled: false },
    '#memo-batch-delete': { disabled: false },
    '#memo-batch-clear': { disabled: false },
    '#memo-select-mode': { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, querySelector: () => null, focus: () => {} },
    '#memo-editor': { classList: fakeClassList([]), toggleAttribute: () => {} }
  });
  run(`memos = [
    { id: 1, title: '甲', content: 'a', tags: ['工作'], pinned: false, updatedAt: 3 },
    { id: 2, title: '乙', content: 'b', tags: ['灵感'], pinned: false, updatedAt: 2 },
    { id: 3, title: '丙', content: 'c', tags: ['工作'], pinned: false, updatedAt: 1 }
  ]; selectedMemoId = 1; memoFocusId = 1;`);
  // 标签筛选只留下命中的条目
  run("listTab = 'memos';");
  run('memoFilter = "tag:工作"; renderMemoList();');
  assert.match(list.innerHTML, /甲/);
  assert.match(list.innerHTML, /丙/);
  assert.ok(!/乙/.test(list.innerHTML), '未命中标签的条目不应出现');
  assert.match(sub.textContent, /筛选出 2 条 · 共 3 条/);
  // 批量选择只统计当前可见且已选中的
  run("listTab = 'memos';");
  // 进入批量模式后列表允许多选
  assert.doesNotMatch(list.innerHTML, /memo-list-item selectable/);
  assert.doesNotMatch(list.innerHTML, /class="memo-check"/);
});

test('草稿行只显示草稿自己的标题，不串用上一条备忘录', () => {
  const list = { innerHTML: '', attrs: {}, focus: () => {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const run = loadRendererRuntime({
    '#memo-list': list,
    '#list-sub': { textContent: '' },
    '#memo-filters': { innerHTML: '' },
    '#memo-title': { value: '上一条备忘录的标题' },
    '#memo-content': { value: '' },
    '#memo-tags': { value: '' },
    '#memo-save-state': { dataset: {}, textContent: '' }
  });
  run('saveMemoNow = () => {};');
  run(`
    memos = [{ id: 5, title: '上一条备忘录的标题', content: 'x', tags: [], pinned: false, updatedAt: 1 }];
    selectedMemoId = MEMO_DRAFT_ID;
    memoDraftMemo = { id: MEMO_DRAFT_ID, title: '', content: '', tags: [], _draft: true };
    renderMemoList();
  `);
  assert.match(list.innerHTML, /memo-list-item draft active/);
  assert.match(list.innerHTML, /<span class="memo-list-title">新备忘录<\/span>/);
  assert.ok(!/上一条备忘录的标题/.test(list.innerHTML.split('memo-list-item draft')[1].split('memo-list-item"')[0]), '草稿行不得沿用编辑器里上一条的标题');

  // 输入时草稿行跟着更新，并同步回草稿状态
  run(`
    document.getElementById('memo-title').value = '';
    document.getElementById('memo-content').value = '召唤物遗物构筑的三条入口';
    scheduleMemoSave();
  `);
  assert.strictEqual(run('memoDraftMemo.title'), '召唤物遗物构筑的三条入口');
  run('renderMemoList();');
  assert.match(list.innerHTML, /<span class="memo-list-title">召唤物遗物构筑的三条入口<\/span>/);
});

test('备忘录标签以 chip 呈现且可移除，编辑器高度链锁死', () => {
  const chips = { innerHTML: '' };
  const tagsInput = { value: '', focus: () => {} };
  const run = loadRendererRuntime({
    '#memo-tag-chips': chips,
    '#memo-tags': tagsInput,
    '#memo-title': { value: '' },
    '#memo-content': { value: '' },
    '#memo-save-state': { dataset: {}, textContent: '' }
  });
  run('saveMemoNow = () => {}; renderMemoList = () => {}; testValues.saved = 0; scheduleMemoSave = () => { testValues.saved++; };');

  // chip 只渲染已提交的标签，不重复显示输入框里的片段
  run('memoTagCommitted = ["设计","灵感","召唤物"]; document.getElementById("memo-tags").value = ""; renderMemoTagChips();');
  assert.strictEqual((chips.innerHTML.match(/memo-tag-chip/g) || []).length, 3);
  assert.match(chips.innerHTML, /data-memo-tag-remove="灵感"/);
  assert.match(chips.innerHTML, /aria-label="移除标签 灵感"/);

  run('removeMemoTag("灵感");');
  assert.deepStrictEqual(JSON.parse(run('JSON.stringify(memoTagCommitted)')), ['设计', '召唤物']);
  assert.strictEqual(run('testValues.saved'), 1);
  assert.strictEqual((chips.innerHTML.match(/memo-tag-chip/g) || []).length, 2);

  // 分隔符提交：片段变成 chip，输入框清空，memoDraft 取到全部标签
  run('document.getElementById("memo-tags").value = "玩法"; commitMemoTags();');
  assert.deepStrictEqual(JSON.parse(run('JSON.stringify(memoTagCommitted)')), ['设计', '召唤物', '玩法']);
  assert.strictEqual(tagsInput.value, '');
  assert.deepStrictEqual(JSON.parse(run('JSON.stringify(memoDraft().tags)')), ['设计', '召唤物', '玩法']);
  // 已存在的标签不会被重复提交
  run('document.getElementById("memo-tags").value = "设计"; commitMemoTags();');
  assert.strictEqual(run('memoTagCommitted.length'), 3);

  // 高度链：行高锁死 + 书写面弹性填充，否则长正文会被 overflow: hidden 裁掉
  assert.match(css, /\.memo-workspace \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(css, /\.memo-pane \{[^}]*display: flex; flex-direction: column; overflow: hidden;/);
  assert.match(css, /\.memo-editor \{ flex: 1; min-height: 0; display: flex; flex-direction: column; \}/);
  assert.match(css, /\.memo-content \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 120px;/);
  // 窄容器不再把工具条挤到第二行，而是收成图标
  assert.match(css, /@container \(max-width: 700px\)[\s\S]*?\.memo-task-action span \{ display: none; \}/);
  assert.doesNotMatch(css, /@container \(max-width: 700px\)[\s\S]*?\.memo-editor-head \{[^}]*flex-wrap: wrap/);
  assert.match(html, /id="memo-to-task" aria-label="转为任务"/);
});

test('窄窗口助手面板让位：自动按视口收起，手动优先，跨阈值交还自动', () => {
  const panel = { classList: fakeClassList([]), style: {} };
  const control = { innerHTML: '', title: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const run = loadRendererRuntime({
    '#ai-panel': panel,
    '#ai-collapse': control,
    __window: { innerWidth: 1180, addEventListener: () => {}, api: {} }
  });

  // 默认窗口 1180 < 1360：自动让位收起，并同步展开按钮语义
  run('aiPanelMode = "auto"; applyAiPanelMode();');
  assert.strictEqual(panel.classList.contains('collapsed'), true);
  assert.strictEqual(control.attrs['aria-expanded'], 'false');
  assert.strictEqual(control.title, '展开助手');
  // 收起时清掉拖拽宽度，避免与窄条样式打架
  run('document.getElementById("ai-panel").style.width = "480px"; applyAiPanelMode();');
  assert.strictEqual(panel.style.width, '');

  // 宽窗口自动展开
  run('window.innerWidth = 1600; aiPanelMode = "auto"; applyAiPanelMode();');
  assert.strictEqual(panel.classList.contains('collapsed'), false);
  assert.strictEqual(control.attrs['aria-expanded'], 'true');

  // 手动展开后即使窗口变窄也不再收起；手动收起后即使窗口变宽也保持收起
  run('window.innerWidth = 1180; aiPanelMode = "expanded"; applyAiPanelMode();');
  assert.strictEqual(panel.classList.contains('collapsed'), false);
  run('window.innerWidth = 1600; aiPanelMode = "collapsed"; applyAiPanelMode();');
  assert.strictEqual(panel.classList.contains('collapsed'), true);

  // 跨过阈值把决定权交还自动：回到窄窗口应再次让位
  run('aiPanelMode = "auto"; window.innerWidth = 1180; applyAiPanelMode();');
  assert.strictEqual(panel.classList.contains('collapsed'), true);

  // 发问必须让回复可见：实时轮次的漏斗 runAiTurn 在写入对话前展开（重试同样经过它）
  assert.match(app, /async function runAiTurn\(request, retry, options\) \{\s*if \(aiSending\) return;\s*\/\/[^\n]*\n\s*setAiPanelExpanded\(\);/);
  assert.match(app, /window\.api\.on\('app:focus-ai', \(\) => \{\s*setAiPanelExpanded\(\);/);
  assert.match(app, /document\.addEventListener\('DOMContentLoaded', \(\) => \{[\s\S]{0,120}applyAiPanelMode\(\);\s*init\(\);/);
});

test('助手进度阶段不再覆盖已流出的回答正文', async () => {
  // 消费端防线：流开始后任何阶段文案只能更新状态，不允许写正文
  assert.match(app, /if \(message && activeAiRequest\.pending && !activeAiRequest\.streamStarted && !reasoningDelta && !progress\.reasoningDone\) \{/);
  // 主进程契约：完成阶段只承载生命周期，不再携带可被误用为正文的文案
  assert.match(main, /sendAiProgress\(e\.sender, requestId, \{ stage: 'done' \}\)/);
  assert.doesNotMatch(main, /stage: 'done', message: /);

  const body = { textContent: '' };
  const state = { textContent: '', classList: fakeClassList(['msg-state']) };
  const reasoningBody = { textContent: '' };
  const reasoningBlock = {
    classList: fakeClassList(['msg-reasoning']),
    open: true,
    querySelector(selector) {
      return selector === '.msg-reasoning-body' ? reasoningBody : null;
    }
  };
  const pending = {
    classList: fakeClassList(['msg', 'ai', 'pending']),
    dataset: {},
    querySelector(selector) {
      if (selector === '.msg-text') return body;
      if (selector === '.msg-state') return state;
      if (selector === '.msg-reasoning') return reasoningBlock;
      return null;
    }
  };
  const run = loadRendererRuntime({
    '#ai-input': { focus() {} },
    __testValues: { pending },
    __activeElement: { closest: () => null }
  });
  run(`
    addMsg = () => testValues.pending;
    setAiBusy = () => {};
    setAiContext = () => {};
    scrollChat = () => {};
    refreshTasks = async () => {};
    toast = () => {};
  `);

  await run(`(async () => {
    testValues.midStream = [];
    const snapshot = () => testValues.pending.querySelector('.msg-text').textContent;
    const note = (label) => testValues.midStream.push([label, snapshot()]);
    await runAiTurn(async (requestId) => {
      updateAiRequestProgress({ requestId, stage: 'understanding', message: '正在理解你的要求…' });
      note('understanding');
      updateAiRequestProgress({ requestId, stage: 'streaming', message: '正在生成回复…', delta: '真正的' });
      updateAiRequestProgress({ requestId, stage: 'streaming', message: '正在生成回复…', delta: '回答' });
      testValues.midStream.push(['streamed', snapshot(), testValues.pending.classList.contains('pending')]);
      updateAiRequestProgress({ requestId, stage: 'executing', message: '正在执行工具…' });
      updateAiRequestProgress({ requestId, stage: 'done', message: '处理完成' });
      testValues.midStream.push(['done', snapshot(), testValues.pending.querySelector('.msg-state').textContent]);
      updateAiRequestProgress({ requestId, reasoningDone: true, cumulativeReasoning: '模型思考内容' });
      note('reasoningDone');
      updateAiRequestProgress({ requestId: '其他请求', stage: 'streaming', message: '污染', delta: '污染' });
      note('isolated');
      return { type: 'chat', message: '最终完整回答' };
    }, () => {}, { cancellable: true });
  })()`);

  assert.deepStrictEqual(JSON.parse(run('JSON.stringify(testValues.midStream)')), [
    ['understanding', '正在理解你的要求…'],
    ['streamed', '真正的回答', false],
    ['done', '真正的回答', '正在整理结果'],
    ['reasoningDone', '真正的回答'],
    ['isolated', '真正的回答']
  ]);
  // done 阶段仍参与状态生命周期（状态栏显示“正在整理结果”），但只更新状态栏，不碰正文
  assert.strictEqual(reasoningBody.textContent, '模型思考内容');
  // 最终 IPC 结果照常替换流式累计内容
  assert.strictEqual(body.textContent, '最终完整回答');
  assert.strictEqual(state.textContent, '已回复');
  assert.strictEqual(run('testValues.pending.dataset.requestState'), 'complete');
  assert.strictEqual(run('activeAiRequest'), null);
});

test('桌宠面板正文保留流开始防护且完成事件不带文案', () => {
  assert.match(petPanelApp, /if \(!activeRequest\.streamStarted && !delta && !reasoningDelta\) \{\s*activeRequest\.pendingText\.textContent = message;/);
  assert.match(petPanelApp, /chatState\.textContent = message;/);
});

test('模型流被中断时思考块在轮次收尾处折叠而不是悬浮成回答', async () => {
  // 主窗口：请求失败路径收尾思考块
  const makeEl = (cls) => {
    const el = fakeTaElement('div');
    el.className = cls || '';
    return el;
  };
  const pendingMain = makeEl('msg ai pending');
  pendingMain.appendChild(makeEl('msg-text'));
  const mainRun = loadRendererRuntime({
    '#ai-input': { focus() {} },
    __testValues: { pending: pendingMain },
    __activeElement: { closest: () => null },
    __createElement: makeEl
  });
  mainRun(`
    addMsg = () => testValues.pending;
    setAiBusy = () => {};
    setAiContext = () => {};
    scrollChat = () => {};
    refreshTasks = async () => {};
    toast = () => {};
    retryAction = () => ({ remove() {} });
  `);
  await mainRun(`(async () => {
    await runAiTurn(async () => {
      updateAiRequestProgress({ requestId: '', reasoningDelta: '模型正在推演任务列表…' });
      throw new Error('连接中断');
    }, null);
  })()`);
  const mainBlock = pendingMain.querySelector('.msg-reasoning');
  assert.ok(mainBlock, '思考块应已创建');
  assert.strictEqual(mainBlock.classList.contains('is-streaming'), false);
  assert.strictEqual(mainBlock.classList.contains('is-done'), true);
  assert.strictEqual(mainBlock.open, false);
  assert.strictEqual(mainBlock.querySelector('.msg-reasoning-body').textContent, '模型正在推演任务列表…');
});

/* ---------- MCP 服务设置 ---------- */
test('MCP 服务设置：开关、状态与配置预览的结构、提示与样式', () => {
  assert.match(app, /<div class="set-row mcp-row">/);
  assert.match(app, /<div class="sr-d" id="mcp-desc">开启后，本机其他 AI agent 可经 MCP 读写任务、备忘录、日计划与报告/);
  assert.match(app, /class="switch \$\{s\.mcpEnabled \? 'on' : ''\}" id="mcp-enabled" role="switch" aria-checked="\$\{!!s\.mcpEnabled\}" aria-label="MCP 服务" aria-describedby="mcp-desc" data-settings-scope="mcp"/);
  assert.match(app, /<div class="sr-d" id="mcp-status" role="status" aria-live="polite">正在读取…<\/div>/);
  ['btn-mcp-refresh', 'btn-mcp-rotate', 'btn-mcp-copy-stdio', 'btn-mcp-copy-http'].forEach((id) => {
    assert.match(app, new RegExp(`id="${id}" data-settings-scope="mcp"`));
  });
  assert.match(app, /<pre class="mcp-config-preview" id="mcp-config-preview" tabindex="0" aria-label="MCP 客户端配置预览" hidden><\/pre>/);
  assert.match(app, /只监听 127\.0\.0\.1 并校验 token/);
  assert.match(app, /破坏性操作仍需二次确认/);
  assert.match(app, /请只连接你信任的客户端/);
  assert.match(app, /stdio 适配所有客户端，用应用自带运行时，无需另装 Node/);
  assert.match(app, /配置含 token，请勿分享/);
  assert.match(app, /function mcpStatusText\(status\)/);
  assert.match(app, /function renderMcpStatus\(\)/);
  assert.match(app, /async function refreshMcpStatus\(\)/);
  assert.match(app, /if \(!node \|\| node\.isConnected === false\) return;/);
  assert.match(app, /hasAttribute\('data-scope-locked'\)\) button\.disabled = !running/);
  assert.match(app, /toast\('请先开启 MCP 服务', 3000, null, 'warn'\)/);
  assert.match(app, /复制失败，已展开配置，请手动选择复制/);
  assert.match(app, /token 已轮换，旧配置立即失效，请重新复制到客户端/);
  assert.match(app, /window\.api\.on\('memos:changed', async \(\) => \{[\s\S]*?refreshMemosAfterMutation\('备忘录已在其他入口修改，但列表刷新失败'\)/);
  assert.match(css, /\.mcp-config-preview \{[\s\S]{0,400}?max-height: 220px; overflow: auto;/);
  assert.match(css, /\.mcp-config-preview \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.mcp-config-preview\[\s*hidden\] \{ display: none; \}/);
  assert.match(css, /\.mcp-config-preview:focus-visible \{ border-color: var\(--accent2\); box-shadow: 0 0 0 3px rgba\(var\(--accent2-rgb\), 0\.14\); outline: none; \}/);
});

function makeMcpControl(initialAttrs) {
  const attrs = Object.assign({}, initialAttrs);
  return {
    attrs,
    disabled: false,
    isConnected: true,
    hidden: false,
    textContent: '',
    focused: false,
    classList: fakeClassList(),
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    setAttribute(name, value) { attrs[name] = value; },
    removeAttribute(name) { delete attrs[name]; },
    focus() { this.focused = true; },
    addEventListener() {},
    closest() { return null; }
  };
}

test('MCP 状态渲染：运行态、关闭态、失败态与互斥锁期间不抢控件', async () => {
  const statusEl = makeMcpControl();
  const previewEl = makeMcpControl();
  const copyStdio = makeMcpControl();
  const copyHttp = makeMcpControl();
  const rotate = makeMcpControl();
  const run = loadRendererRuntime({
    '#mcp-status': statusEl,
    '#mcp-config-preview': previewEl,
    '#btn-mcp-copy-stdio': copyStdio,
    '#btn-mcp-copy-http': copyHttp,
    '#btn-mcp-rotate': rotate,
    '#mcp-enabled': makeMcpControl()
  });

  run(`mcpStatus = { running: true, enabled: true, url: 'http://127.0.0.1:4571/mcp', toolCount: 32, clientSessions: 1, configs: { stdio: { json: 'STDIO_CONFIG' }, http: { json: 'HTTP_CONFIG' } } }; renderMcpStatus();`);
  assert.strictEqual(statusEl.textContent, '运行中 · http://127.0.0.1:4571/mcp · 32 个工具 · 1 个客户端会话');
  assert.strictEqual(previewEl.hidden, false);
  assert.strictEqual(previewEl.textContent, 'STDIO_CONFIG');
  assert.strictEqual(copyStdio.disabled, false);
  assert.strictEqual(copyHttp.disabled, false);
  assert.strictEqual(rotate.disabled, false);

  run(`mcpStatus = { running: false, enabled: false }; renderMcpStatus();`);
  assert.strictEqual(statusEl.textContent, '已关闭，没有监听任何端口。');
  assert.strictEqual(previewEl.hidden, true);
  assert.strictEqual(previewEl.textContent, '');
  assert.strictEqual(copyStdio.disabled, true);
  assert.strictEqual(copyHttp.disabled, true);
  assert.strictEqual(rotate.disabled, true);

  run(`mcpStatus = { running: false, enabled: true, lastError: '端口被占用' }; renderMcpStatus();`);
  assert.strictEqual(statusEl.textContent, '已开启但启动失败：端口被占用');

  // 同组操作互斥锁生效期间，renderMcpStatus 不得抢回控件状态
  copyHttp.attrs['data-scope-locked'] = 'true';
  copyHttp.disabled = true;
  run(`mcpStatus = { running: true, enabled: true, url: 'http://127.0.0.1:4571/mcp', toolCount: 32, clientSessions: 0, configs: { stdio: { json: 'S' }, http: { json: 'H' } } }; renderMcpStatus();`);
  assert.strictEqual(copyHttp.disabled, true, '互斥锁期间控件应保持锁定');
  assert.strictEqual(copyStdio.disabled, false, '其余控件恢复正常');
  delete copyHttp.attrs['data-scope-locked'];
});

test('MCP 状态刷新：同步开关与设置，过期结果不写入', async () => {
  const statusEl = makeMcpControl();
  const previewEl = makeMcpControl();
  const toggle = makeMcpControl();
  let statusResult = {
    running: true, enabled: true, url: 'http://127.0.0.1:4571/mcp', toolCount: 32,
    clientSessions: 0, configs: { stdio: { json: 'STDIO_CONFIG' }, http: { json: 'HTTP_CONFIG' } }
  };
  const run = loadRendererRuntime({
    '#mcp-status': statusEl,
    '#mcp-config-preview': previewEl,
    '#mcp-enabled': toggle,
    '#btn-mcp-copy-stdio': makeMcpControl(),
    '#btn-mcp-copy-http': makeMcpControl(),
    '#btn-mcp-rotate': makeMcpControl(),
    __window: { api: { mcp: { status: async () => statusResult } } }
  });

  await run(`refreshMcpStatus()`);
  assert.strictEqual(run(`mcpStatus && mcpStatus.running`), true);
  assert.strictEqual(run(`settings.mcpEnabled`), true);
  assert.strictEqual(toggle.classList.contains('on'), true);
  assert.strictEqual(toggle.attrs['aria-checked'], 'true');
  assert.strictEqual(statusEl.textContent, '运行中 · http://127.0.0.1:4571/mcp · 32 个工具');
  assert.strictEqual(previewEl.textContent, 'STDIO_CONFIG');

  // 设置页已重渲染（元素被替换）后，旧结果不得写入新状态
  statusResult = { running: false, enabled: false };
  statusEl.isConnected = false;
  await run(`refreshMcpStatus()`);
  assert.strictEqual(run(`mcpStatus && mcpStatus.enabled`), true, '过期结果必须被丢弃');

  // 读取失败时把错误写进状态行，而不是抛出
  statusEl.isConnected = true;
  const failing = loadRendererRuntime({
    '#mcp-status': statusEl,
    '#mcp-config-preview': previewEl,
    '#mcp-enabled': toggle,
    __window: { api: { mcp: { status: async () => { throw new Error('连接断开'); } } } }
  });
  await failing(`refreshMcpStatus()`);
  assert.strictEqual(statusEl.textContent, '读取 MCP 状态失败：连接断开');
});
