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
const taWindowHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/task-agent/window.html'), 'utf8');
const taWindowApp = fs.readFileSync(path.join(ROOT, 'src/renderer/task-agent/window.js'), 'utf8');
const taWindowCss = fs.readFileSync(path.join(ROOT, 'src/renderer/task-agent/window.css'), 'utf8');
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
        workflow: {
          get: async () => ({ dailyPlans: {}, activeFocus: null }),
          pauseFocus: async () => ({ dailyPlans: {}, activeFocus: null }),
          resumeFocus: async () => ({ dailyPlans: {}, activeFocus: null }),
          finishFocus: async () => ({ workflow: { dailyPlans: {}, activeFocus: null } })
        },
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
  assert.match(appIconSvg, /<rect[^>]+fill="#C1523E"/);
  assert.match(appIconSvg, /<circle[^>]+fill="#FFFFFF"/);
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
  assert.strictEqual((html.match(/class="nav-ico" aria-hidden="true"><svg class="ui-icon"/g) || []).length, 8);
  assert.match(iconCss, /\.ui-icon \{[\s\S]*?stroke: currentColor;[\s\S]*?stroke-width: 2;/);
  assert.match(html, /id="sidebar-new" aria-label="新建任务"/);
  assert.match(html, /<button type="button" class="nav-item active"[^>]+aria-current="page"/);
  assert.doesNotMatch(html, /<div class="nav-item/);
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
  const tasksNav = makeNav('tasks');
  const todayView = { id: 'view-today', style: {}, isConnected: true, classList: fakeClassList() };
  const tasksView = { id: 'view-tasks', style: {}, isConnected: true, classList: fakeClassList() };
  const run = loadRendererRuntime({
    '.content': content,
    '#tb-title': title,
    'view-today': todayView,
    'view-tasks': tasksView,
    __querySelectorAll: (selector) => {
      if (selector === '.nav-item') return [todayNav, tasksNav];
      if (selector === '.view') return [todayView, tasksView];
      return [];
    }
  });
  run(`
    closeTaskMenus = () => {};
    setBatchMode = () => {};
    playTransientClass = () => {};
    renderToday = () => {};
    renderTasks = () => {};
    applyDataLoadStates = () => {};
    currentView = 'today';
    viewScrollPositions.clear();
    viewScrollPositions.set('tasks', 55);
    switchView('tasks');
  `);
  assert.strictEqual(content.scrollTop, 55);
  assert.strictEqual(run(`viewScrollPositions.get('today')`), 120);
  assert.strictEqual(tasksNav.attrs['aria-current'], 'page');
  content.scrollTop = 80;
  run(`switchView('today')`);
  assert.strictEqual(content.scrollTop, 120);
  assert.strictEqual(run(`viewScrollPositions.get('tasks')`), 80);
  content.scrollTop = 135;
  run(`switchView('today')`);
  assert.strictEqual(content.scrollTop, 135);
});

test('今日工作闭环在主界面与桌宠共享完整操作入口', () => {
  assert.match(html, /id="workflow-panel"/);
  assert.match(html, /id="m-estimate"/);
  assert.match(app, /window\.api\.workflow\.previewPlan/);
  assert.match(app, /window\.api\.workflow\.previewSmartPlan/);
  assert.match(app, /id="workflow-smart-input"/);
  assert.match(app, /workflowDraftMeta/);
  assert.match(app, /data-workflow="smart-toggle"/);
  assert.match(app, /result\.notice/);
  assert.match(main, /智能安排暂时未完成，请重试；计划尚未保存/);
  assert.match(app, /window\.api\.workflow\.startFocus/);
  assert.match(app, /window\.api\.workflow\.saveReview/);
  assert.match(app, /<strong>安排今天<\/strong><span>\$\{actionable\.length\} 项待处理/);
  assert.match(app, />生成今日计划<\/button>/);
  assert.match(css, /\.workflow-panel \{[\s\S]*?margin: 0 0 16px;[\s\S]*?border-left: 3px solid var\(--accent2\);[\s\S]*?border-radius: 8px;/);
  assert.match(petHtml, /id="pet-focus"/);
  assert.match(petApp, /window\.api\.workflow\.pauseFocus/);
  assert.match(petApp, /window\.api\.workflow\.resumeFocus/);
  assert.match(petApp, /window\.api\.workflow\.finishFocus/);
  assert.match(petApp, /finishFocus\(\{ completeTask: true \}\)[\s\S]*?await refreshStatus\(false\)/);
  assert.match(petApp, /window\.api\.on\('workflow:changed', async \(state\) => \{[\s\S]*?await refreshStatus\(false\)/);
  assert.match(app, /plan\.scheduledMinutes > plan\.capacityMinutes/);
  assert.match(css, /@container \(max-width: 560px\) \{[\s\S]*?\.workflow-item \{ grid-template-columns: 72px minmax\(0, 1fr\); \}/);
  assert.match(css, /\.workflow-smart-entry textarea/);
  assert.match(css, /\.workflow-constraint-summary/);
  assert.match(petHtml, /data-pet-focus="toggle" aria-label="暂停专注"/);
  assert.match(petCss, /\.pm-focus-btn \{ width: 27px; height: 27px;/);
  assert.match(main, /broadcastAgentWorkflowResult/);
  assert.match(main, /'complete', 'start', 'delete', 'archive', 'update', 'postpone', 'restore'/);
  assert.match(app, /if \(operationTypes\.includes\(result\.type\)\) await refreshWorkflow\(\)/);
  assert.match(preload, /workflow:changed/);
});

test('每日 Agent：首页提供单一建议、依据、稍后提醒与安全操作入口', () => {
  assert.match(html, /id="daily-copilot"[^>]+aria-label="每日 Agent 建议"/);
  assert.match(app, /window\.api\.workflow\.getCopilot\(\)/);
  assert.match(app, /window\.api\.workflow\.updateCopilot\(\{ action: action === 'snooze' \? 'snooze' : 'mute-today'/);
  assert.match(app, /data-copilot="primary"/);
  assert.match(app, /为什么现在/);
  assert.match(app, /查看依据/);
  assert.match(app, /30 分钟后提醒/);
  assert.match(app, /今天不再提示/);
  assert.match(app, /id="copilot-enabled"[^>]+role="switch"/);
  assert.match(app, /id="copilot-quiet-start" type="time"/);
  assert.match(app, /id="copilot-quiet-end" type="time"/);
  assert.match(app, /action: 'preferences', quietStart, quietEnd/);
  assert.match(preload, /getCopilot: \(\) => ipcRenderer\.invoke\('workflow:getCopilot'\)/);
  assert.match(preload, /updateCopilot: \(input\) => ipcRenderer\.invoke\('workflow:updateCopilot', input\)/);
  assert.match(main, /ipcMain\.handle\('workflow:getCopilot'/);
  assert.match(main, /ipcMain\.handle\('workflow:updateCopilot'/);
  assert.match(css, /\.daily-copilot \{/);
  assert.match(css, /\.copilot-rail::before/);
  assert.match(css, /\.quiet-time-controls/);
  assert.match(css, /@container \(max-width: 560px\)[\s\S]*?\.copilot-foot \{ align-items: flex-start; flex-direction: column-reverse; \}/);
});

test('今日工作流以面板级操作锁阻止并发写入', async () => {
  const calls = [];
  const confirmButton = { focused: false, focus() { this.focused = true; } };
  const button = {
    attrs: {},
    classList: fakeClassList(['btn']),
    dataset: { workflow: 'preview' },
    disabled: false,
    textContent: '生成今日计划',
    setAttribute(name, value) { this.attrs[name] = value; },
    closest(selector) { return selector === '[data-workflow]' ? this : null; }
  };
  const panel = {
    attrs: {},
    classList: fakeClassList(),
    innerHTML: '',
    setAttribute(name, value) { this.attrs[name] = value; },
    querySelectorAll() { return [button]; },
    querySelector(selector) {
      return selector.includes('[data-workflow="apply-plan"]') ? confirmButton : null;
    }
  };
  const event = { target: button };
  const run = loadRendererRuntime({
    '#workflow-panel': panel,
    __window: { api: { workflow: { previewPlan: async () => ({}) } } },
    __testValues: { event, calls, release: null }
  });
  run(`window.api.workflow.previewPlan = () => {
    testValues.calls.push('preview');
    return new Promise((resolve) => { testValues.release = resolve; });
  };
  toast = () => {};
  tasks = [];
  workflowState = { preferences: {}, dailyPlans: {}, activeFocus: null, focusSessions: [] };
  testValues.first = handleWorkflowAction(testValues.event);`);

  assert.strictEqual(run('workflowBusy'), true);
  assert.strictEqual(panel.classList.contains('is-busy'), true);
  assert.strictEqual(panel.attrs['aria-busy'], 'true');
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.textContent, '生成中…');
  const duplicate = await run('handleWorkflowAction(testValues.event)');
  assert.strictEqual(duplicate, false);
  assert.deepStrictEqual(calls, ['preview']);

  await run(`testValues.release({ items: [], omittedCount: 0, scheduledMinutes: 0, capacityMinutes: 0 }); testValues.first`);
  assert.strictEqual(run('workflowBusy'), false);
  assert.strictEqual(panel.classList.contains('is-busy'), false);
  assert.strictEqual(panel.attrs['aria-busy'], 'false');
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(confirmButton.focused, true);
  assert.match(css, /\.workflow-panel\.is-busy \{[\s\S]*?cursor: progress;/);
  assert.match(app, /focusWorkflowAfterAction\(action, succeeded, focusContext\)/);
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
  assert.match(app, /<button type="button" role="gridcell" class="\$\{cls\}" data-day=[^>]+aria-selected=/);
  assert.match(app, /class="task-more" aria-haspopup="menu" aria-controls="\$\{menuId\}" aria-expanded="false"/);
  assert.match(app, /class="task-menu hidden" id="\$\{menuId\}" role="menu"/);
  assert.match(css, /\.task-more \{[\s\S]*?width: 28px; height: 28px;/);
  assert.match(app, /const checkIcon = checked \? uiIcon\('check'\) : ''/);
  assert.match(app, /class="task-expand[^`]+uiIcon\('chevron-right'\)/);
  assert.match(app, /class="child-check" aria-hidden="true">\$\{x\.done \? uiIcon\('check'\) : ''\}/);
  assert.match(css, /\.task-check \.ui-icon \{ width: 12px; height: 12px;/);
  assert.match(app, /class="proj-chip">\$\{uiIcon\('folder'\)\}<span>/);
  assert.match(app, /class="repeat-chip">\$\{uiIcon\('refresh'\)\}<span>/);
  assert.doesNotMatch(app, /◈|↻/);
});

test('任务行图标子节点仍能触发完成和子任务展开', async () => {
  const row = { dataset: { id: '1' } };
  const taskCheck = {};
  const taskExpand = {};
  const makeTarget = (control) => ({
    classList: { contains: () => false },
    closest(selector) {
      if (selector === '.task-row') return row;
      if (selector === '.task-check') return control === 'check' ? taskCheck : null;
      if (selector === '.task-expand') return control === 'expand' ? taskExpand : null;
      return null;
    }
  });
  const calls = [];
  const run = loadRendererRuntime({
    __testValues: {
      checkEvent: { target: makeTarget('check'), ctrlKey: false, metaKey: false, shiftKey: false },
      expandEvent: { target: makeTarget('expand') },
      calls
    }
  });
  run(`tasks = [{ id: 1, title: '交周报', status: 'todo', children: [{ id: 'a', title: '整理', done: false }] }];
    currentView = 'tasks'; batchMode = false;
    toggleDone = (task) => testValues.calls.push('done:' + task.id);
    renderAll = () => testValues.calls.push('render');`);
  await run('onTaskClick(testValues.checkEvent)');
  await run('onTaskClick(testValues.expandEvent)');
  assert.deepStrictEqual(calls, ['done:1', 'render']);
  assert.strictEqual(run('expandedIds.has(1)'), true);
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

test('任务上下文 Agent 在任务行与编辑弹窗唤起独立对话小窗', () => {
  assert.match(app, /class="task-agent-btn"[^`]+uiIcon\('message'\)/);
  assert.match(html, /id="m-agent"[^>]+aria-label="和 Agent 一起修改这项任务"/);
  // 内嵌 popover 已移除，改为独立悬浮小窗
  assert.ok(!/task-agent-popover/.test(html));
  assert.ok(!/task-agent-popover/.test(app));
  assert.match(preload, /taskAgent: \{\s*open: \(payload\) => ipcRenderer\.invoke\('task-agent:open', payload\)/);
  assert.match(preload, /'task-agent:session'/);
  assert.match(main, /ipcMain\.handle\('task-agent:open'/);
  assert.match(main, /ipcMain\.handle\('task-agent:close'/);
  assert.match(main, /createTaskAgentWindow/);
  assert.match(main, /loadFile\(path\.join\(__dirname, 'renderer', 'task-agent', 'window\.html'\)\)/);
  // 主窗口只负责唤起：入口统一带任务上下文
  assert.match(app, /window\.api\.taskAgent\.open\(\{/);
  assert.match(app, /workLogId: workLog && workLog\.id \|\| ''/);
  // 小窗三件套：对话流 + 快捷指令 + 预览确认
  assert.match(taWindowHtml, /id="ta-thread"[^>]+aria-live="polite"/);
  assert.match(taWindowHtml, /data-prompt="改到明天"/);
  assert.match(taWindowApp, /previewTaskAction\(session\.taskId, input, requestId/);
  assert.match(taWindowApp, /window\.api\.ai\.applyTaskAction\(preview\.previewId\)/);
  assert.match(taWindowApp, /window\.api\.ai\.handle\(input, requestId/);
  assert.match(taWindowApp, /task-agent:session/);
  assert.match(taWindowCss, /\.ta-preview-actions button\.primary/);
  // 主窗口监听小窗修改后的刷新通知
  assert.match(main, /mainWindow\.webContents\.send\('tasks:changed'\)/);
  assert.match(app, /window\.api\.on\('tasks:changed'/);
  // 会话隔离：小窗对话不读写主窗口侧边栏的对话记录
  assert.match(taWindowApp, /const SESSION_HISTORY_LIMIT = 12/);
  assert.match(taWindowApp, /rememberTurn\(sourceText, result\.message\)/);
  assert.match(taWindowApp, /rememberTurn\(input, result && result\.message\)/);
  assert.match(taWindowApp, /\}, currentSessionHistory\(\)\)/);
  assert.match(preload, /history: options && options\.history/);
  assert.match(preload, /context, history\) => ipcRenderer\.invoke\('ai:previewTaskAction', \{ taskId, text, requestId, context, history \}\)/);
  assert.match(main, /isTaskAgentSender\(e\)/);
  assert.match(main, /function sanitizeSessionHistory\(input\)/);
  assert.match(main, /if \(isTaskAgent\) return aiRequestCoordinator\.complete\(key, result\)/);
  assert.match(main, /if \(isTaskAgentSender\(e\)\) return result/);
  assert.match(main, /history: sanitizeSessionHistory\(payload\.history\)/);
  assert.match(aiSource, /function conversationContextMessages\(requestContext\)/);
  assert.match(aiSource, /\.\.\.conversationContextMessages\(requestContext\)/);
  assert.ok(!/\.\.\.getRecentConversationMessages\(\),\s*\n\s*\{ role: 'user', content: text \}/.test(aiSource));
});

test('任务工作记录通过 Agent 安全编辑并进入报告来源', () => {
  const taskSource = app.slice(app.indexOf('function rowHTML('), app.indexOf('function renderList('));
  assert.match(taskSource, /class="task-worklog"/);
  assert.match(taskSource, /data-worklog-add="\$\{t\.id\}"/);
  assert.match(taskSource, /data-worklog-edit="\$\{esc\(log\.id\)\}"/);
  assert.match(taskSource, /data-worklog-remove="\$\{esc\(log\.id\)\}"/);
  assert.match(app, /workLogId: workLog && workLog\.id \|\| ''/);
  assert.match(app, /workLogKind: workLog && workLog\.kind \|\| ''/);
  assert.match(app, /closest\('\[data-worklog-add\]'\)/);
  assert.match(app, /closest\('\[data-worklog-edit\]'\)/);
  assert.match(app, /label: '记录成果'/);
  assert.match(app, /function openCompletionOutcome\(taskId\)/);
  assert.match(app, /worklog: '记录'/);
  assert.match(preload, /addWorkLog: \(taskId, input\) => ipcRenderer\.invoke\('tasks:addWorkLog'/);
  assert.match(main, /ipcMain\.handle\('tasks:addWorkLog'/);
  assert.match(css, /\.task-worklog-item \{[^}]*grid-template-columns:/);
});

test('任务 Agent 入口把任务与工作记录上下文传给独立小窗', () => {
  const opened = [];
  const trigger = { isConnected: true, focused: false, focus() { this.focused = true; } };
  const run = loadRendererRuntime({
    __window: {
      innerWidth: 1200,
      innerHeight: 800,
      api: {
        taskAgent: { open: async (payload) => { opened.push(payload); return { ok: true }; } }
      }
    },
    __testValues: {
      trigger,
      task: { id: 42, title: '独立小窗的任务', status: 'todo' },
      archived: { id: 43, title: '已归档', status: 'archived' },
      log: { id: 'log-7', kind: 'progress', text: '进展：完成一半' }
    }
  });

  run('openTaskAgent(testValues.task, testValues.trigger)');
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].taskId, 42);
  assert.strictEqual(opened[0].title, '独立小窗的任务');
  assert.strictEqual(opened[0].draft, '');
  assert.strictEqual(opened[0].workLogId, '');
  assert.strictEqual(trigger.focused, true);

  // 编辑工作记录入口：带记录上下文与草稿
  run('openTaskAgent(testValues.task, testValues.trigger, { workLog: testValues.log })');
  assert.strictEqual(opened.length, 2);
  assert.strictEqual(opened[1].workLogId, 'log-7');
  assert.strictEqual(opened[1].workLogKind, 'progress');
  assert.strictEqual(opened[1].draft, '进展：完成一半');
  assert.strictEqual(opened[1].title, '编辑记录 · 独立小窗的任务');

  // 归档任务不打开小窗
  run('openTaskAgent(testValues.archived, testValues.trigger)');
  assert.strictEqual(opened.length, 2);
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

function loadTaskAgentWindowRuntime(api) {
  const elements = {};
  ['#ta-thread', '#ta-input', '#ta-send', '#ta-state', '#ta-title', '#ta-close', '#ta-form', '#ta-chips']
    .forEach((id) => { elements[id] = fakeTaElement(id === '#ta-form' ? 'form' : 'div'); });
  const chip = fakeTaElement('button');
  chip.dataset.prompt = '改到明天';
  elements.__chips = [chip];
  const context = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    document: {
      querySelector: (selector) => elements[selector] || null,
      querySelectorAll: (selector) => (selector === '.ta-chips .ta-chip' ? elements.__chips : []),
      createElement: (tag) => fakeTaElement(tag),
      addEventListener() {},
      removeEventListener() {}
    },
    window: { api }
  });
  vm.runInContext(taWindowApp, context);
  return { elements, run: (source) => vm.runInContext(source, context) };
}

test('任务对话小窗：任务修改走预览确认流，非任务操作回退全局 Agent', async () => {
  const calls = { preview: [], handle: [], apply: [] };
  let previewResult = {
    ok: true,
    type: 'task_action_preview',
    summary: '准备更新「独立小窗的任务」',
    fields: [{ label: '截止时间', before: '2026-08-21 18:00', after: '2026-08-22 18:00' }],
    previewId: 'preview-1',
    action: { intent: 'update', params: { due: '2026-08-22 18:00' } }
  };
  const api = {
    on: (channel, cb) => { api.__session = cb; },
    taskAgent: { open: async () => ({ ok: true }), close: () => {} },
    ai: {
      onProgress: () => {},
      previewTaskAction: async (taskId, text, requestId, context, history) => {
        calls.preview.push({ taskId, text, context, history });
        return JSON.parse(JSON.stringify(previewResult));
      },
      applyTaskAction: async (previewId) => {
        calls.apply.push(previewId);
        return { ok: true, type: 'update', message: '已把「独立小窗的任务」改到明天。', undoable: false };
      },
      handle: async (text, requestId, options) => {
        calls.handle.push({ text, history: options && options.history });
        return { type: 'chat', message: '这个安排合理，紧急任务优先处理。' };
      },
      resolve: async () => ({}),
      undo: async () => ({ ok: true })
    }
  };
  const { elements, run } = loadTaskAgentWindowRuntime(api);

  // 会话注入
  api.__session({ taskId: 42, title: '独立小窗的任务', draft: '', workLogId: '', workLogKind: '' });
  assert.strictEqual(elements['#ta-title'].textContent, '独立小窗的任务');
  // 欢迎语 + 用户输入 + agent 消息
  await run('sendPrompt("改到明天")');
  assert.strictEqual(calls.preview.length, 1);
  assert.strictEqual(calls.preview[0].taskId, 42);
  assert.strictEqual(calls.preview[0].text, '改到明天');
  // 会话记忆自持：首轮 history 为空数组（隔离全局侧边栏记录），而不是 undefined
  assert.ok(Array.isArray(calls.preview[0].history));
  assert.strictEqual(calls.preview[0].history.length, 0);

  // 预览卡渲染在最后一条 agent 消息内
  const thread = elements['#ta-thread'];
  const lastMessage = thread.children[thread.children.length - 1];
  const previewCard = lastMessage.children.find((child) => child.classList.contains('ta-preview'));
  assert.ok(previewCard, '应渲染预览卡');
  const actions = previewCard.children.find((child) => child.classList.contains('ta-preview-actions'));
  assert.ok(actions);
  const applyBtn = actions.children.find((button) => button.classList.contains('primary'));
  assert.strictEqual(applyBtn.textContent, '确认修改');

  // 确认修改：走 applyTaskAction，成功后展示结果消息
  await applyBtn.listeners.click();
  assert.deepStrictEqual(calls.apply, ['preview-1']);
  const resultMessage = thread.children[thread.children.length - 1];
  assert.strictEqual(resultMessage.querySelector('.ta-text').textContent, '已把「独立小窗的任务」改到明天。');

  // 非任务操作（如咨询意见）：预览管线不支持 → 回退全局 Agent 对话
  previewResult = { ok: false, type: 'error', message: '我还不能在任务内执行这类操作。' };
  await run('sendPrompt("你觉得这个安排合理吗")');
  assert.strictEqual(calls.handle.length, 1);
  assert.strictEqual(calls.handle[0].text, '你觉得这个安排合理吗');
  // 兜底对话带上会话自持记忆：包含刚才确认过的「改到明天」轮次
  assert.ok(Array.isArray(calls.handle[0].history));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.handle[0].history)), [
    { role: 'user', content: '改到明天' },
    { role: 'assistant', content: '已把「独立小窗的任务」改到明天。' }
  ]);
  // 预览请求同样携带会话记忆，而不是全局侧边栏记录
  assert.strictEqual(calls.preview.length, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.preview[1].history)), JSON.parse(JSON.stringify(calls.handle[0].history)));
  const chatMessage = thread.children[thread.children.length - 1];
  assert.strictEqual(chatMessage.querySelector('.ta-text').textContent, '这个安排合理，紧急任务优先处理。');
});

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
  assert.match(main, /ipcMain\.handle\('tasks:saveAndComplete', \(e, id, data\) => runWorkflowMutation\(\(\) => store\.saveAndCompleteTask\(id, data\)\)\)/);
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
  assert.match(app, /if \(targetStatus === 'done'\) \{\s*await toggleDone\(task\)/);
  assert.match(app, /if \(next === 'done'\) await toggleDone\(t\)/);
  assert.match(app, /if \(t\.status === 'done'\) \{\s*await window\.api\.tasks\.update\(t\.id, \{ status: 'todo' \}\)/);
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

test('键盘批量优先级等待真实写入结果后再结束批量模式', () => {
  const shortcutFlow = app.slice(app.indexOf('// 应用内快捷键（不抢输入框焦点）'), app.indexOf('// T 加今天 / D 加明天'));
  assert.match(shortcutFlow, /document\.addEventListener\('keydown', async \(e\) =>/);
  assert.match(shortcutFlow, /e\.preventDefault\(\);[\s\S]*?await runBatchMutation\(\{/);
  assert.doesNotMatch(shortcutFlow, /window\.api\.tasks\.batchUpdate\(ids/);
  assert.doesNotMatch(shortcutFlow, /setBatchMode\(false/);
});

test('批量模式显式进入，只保留当前可见任务并禁用空操作', () => {
  assert.match(html, /id="btn-select-mode" aria-pressed="false">批量操作/);
  assert.match(html, /id="batch-bar"[\s\S]*?<div class="view-body" id="tasks-list">/);
  assert.match(html, /id="batch-done" disabled/);
  assert.match(html, /id="batch-delete" disabled/);
  assert.match(app, /visibleTaskIds = list\.map\(\(t\) => t\.id\)/);
  assert.match(app, /selectedIds = new Set\(\[\.\.\.selectedIds\]\.filter\(\(id\) => visibleSet\.has\(id\)\)\)/);
  assert.match(app, /completableCount = tasks\.filter\(\(t\) => selectedIds\.has\(t\.id\) && t\.status !== 'done' && t\.status !== 'archived'\)\.length/);
  assert.match(app, /action: \(selected\) => window\.api\.tasks\.batchComplete\(selected\)/);
  assert.match(app, /function setBatchMode\(enabled, shouldRender = true\)/);
  assert.match(app, /class="task-main"\$\{batchMode \? ' inert' : ''\}/);
  assert.match(app, /\.task-row\[data-id="\$\{id\}"\] \.task-check/);
  assert.match(app, /if \(active\) active\.focus\(\)/);
  assert.match(css, /\.task-row\.selecting \.task-check \{[\s\S]*?background: transparent; animation: none;/);
  assert.match(app, /trigger\.classList\.toggle\('hidden', enabled\)/);
  assert.match(app, /\$\('#view-tasks'\)\?\.classList\.toggle\('batch-mode', enabled\)/);
  assert.match(css, /#view-tasks\.batch-mode \.toolbar \{ display: none; \}/);
  assert.match(css, /\.task-row\.selecting \.task-overflow \{ display: none; \}/);
  assert.match(css, /\.batch-bar \{\s*position: sticky; top: 0; margin-bottom: 12px;/);
  assert.match(css, /@container \(max-width: 560px\)[\s\S]*?\.batch-bar \{ flex-wrap: nowrap; gap: 6px; padding: 10px 12px; \}/);
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
    '#batch-bar': { attrs: {}, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, setAttribute(name, value) { this.attrs[name] = value; } },
    '#batch-count': { textContent: '' },
    '#batch-done': { disabled: true, innerHTML: '', title: '' },
    '#batch-pri': { disabled: true },
    '#batch-delete': { disabled: true },
    '#batch-select-all': { disabled: true, textContent: '' },
    '#batch-clear': { disabled: false }
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
  assert.match(elements['#batch-done'].innerHTML, /href="#ui-i-check"/);
  assert.match(elements['#batch-done'].innerHTML, /<span>完成 1 项<\/span>/);
  assert.strictEqual(elements['#batch-done'].title, '已完成或已归档任务将自动跳过');

  run(`setBatchBusy(true, '正在完成 3 项…', null)`);
  assert.strictEqual(elements['#batch-count'].textContent, '正在完成 3 项…');
  assert.strictEqual(elements['#batch-bar'].attrs['aria-busy'], 'true');
  assert.strictEqual(elements['#batch-select-all'].disabled, true);
  assert.strictEqual(elements['#batch-clear'].disabled, true);
  run(`setBatchBusy(false, '', null)`);

  run(`selectedIds = new Set([2, 3]); renderBatchBar();`);
  assert.strictEqual(elements['#batch-done'].disabled, true);
  assert.match(elements['#batch-done'].innerHTML, /<span>完成<\/span>/);
});

test('批量操作失败后保留选择并恢复所有控件', async () => {
  const toasts = [];
  const controls = {
    '#batch-bar': { classList: fakeClassList(), setAttribute() {} },
    '#batch-count': { textContent: '' },
    '#batch-done': { disabled: false, innerHTML: '', title: '', setAttribute() {} },
    '#batch-pri': { disabled: false },
    '#batch-delete': { disabled: false },
    '#batch-select-all': { disabled: false, textContent: '' },
    '#batch-clear': { disabled: false }
  };
  const run = loadRendererRuntime({ ...controls, __testValues: { toasts } });
  run(`
    tasks = [{ id: 1, status: 'todo' }, { id: 2, status: 'todo' }];
    batchMode = true;
    visibleTaskIds = [1, 2];
    selectedIds = new Set([1, 2]);
    toast = (message) => testValues.toasts.push(message);
    refreshTasksAfterMutation = async () => {};
  `);
  const changed = await run(`runBatchMutation({
    ids: [1, 2], control: null, busyMessage: '正在更新 2 项…',
    action: async () => { throw new Error('写入失败'); },
    successMessage: '已更新', refreshFailureMessage: '刷新失败'
  })`);
  assert.strictEqual(changed, false);
  assert.strictEqual(run('batchMode'), true);
  assert.strictEqual(run('selectedIds.size'), 2);
  assert.strictEqual(run('batchBusy'), false);
  assert.strictEqual(controls['#batch-clear'].disabled, false);
  assert.match(toasts[0], /当前选择已保留/);
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
  assert.match(app, /Promise\.all\(\[refreshTasks\(\), refreshMemos\(\), refreshWorkflow\(\)\]\)/);
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
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet=/g) || []).length, 6);
  assert.match(petHtml, /class="pm-grid" role="toolbar" aria-label="打开视图"/);
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet="[^"]+" tabindex="0"/g) || []).length, 1);
  assert.strictEqual((petHtml.match(/class="pm-it" data-pet="[^"]+" tabindex="-1"/g) || []).length, 5);
  assert.match(petHtml, /id="pet" role="button" tabindex="0"[^>]+aria-expanded="false"/);
  assert.match(petCss, /\.pm-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(petCss, /\.pm-close \.ui-icon \{ width: 14px; height: 14px; \}/);
  assert.match(petCss, /\.pm-main \.ui-icon \{ width: 13px; height: 13px; \}/);
  assert.match(petCss, /\.pm-main \{[\s\S]*?white-space: nowrap;/);
  assert.match(petCss, /\.pet-menu \.pm-it \.ui-icon \{ width: 14px; height: 14px; \}/);
  for (const name of ['x', 'plus', 'message', 'today', 'board', 'calendar', 'stat', 'trash', 'settings', 'external']) {
    assert.match(petHtml, new RegExp(`href="#ui-i-${name}"`));
  }
  assert.doesNotMatch(petHtml, /[＋✎◧▤▦◫⌫⚙×]/);
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
  assert.match(petApp, /if \(!action \|\| !workflowSnapshot\.activeFocus \|\| petFocusBusy\) return/);
  assert.match(petApp, /petFocus\.querySelectorAll\('button'\)\.forEach/);
  assert.match(petApp, /if \(!petFocusBusy\) petFocusTitle\.textContent/);
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
    'pet-focus': fakePetElement(['hidden']),
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
    'pet-focus': fakePetElement(['hidden']),
    'pet-focus-title': fakePetElement(),
    'pet-focus-time': fakePetElement(),
    'pet-focus-toggle': fakePetElement(),
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
    'pet-focus': fakePetElement(['hidden']),
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
  assert.match(app, /switchView\('tasks'\);\s*openModal\(task\)/);
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
  assert.match(css, /--accent-hover: #9E4832/);
  assert.match(css, /--muted-rgb: 138, 141, 147/);
  assert.match(css, /--control-md: 36px/);
  assert.doesNotMatch(css, /rgba\((?:196, 69, 59|199, 138, 43|62, 142, 90|122, 111, 96|240, 140, 80)/);
  assert.doesNotMatch(css, /#E8743B/i);
  assert.doesNotMatch(app, /badge\.style\.(?:background|color|borderColor)/);
  assert.match(app, /const stateClass = stage === 'llm'/);
});

test('统计图表模板保持有效的容器闭合结构', () => {
  const renderStatSource = app.slice(app.indexOf('function renderStat()'), app.indexOf('/* ---------- 视图：设置 ---------- */'));
  assert.match(renderStatSource, /<div class="trend-column(?:\$\{i === trend\.length - 1 \? ' today' : ''\})?" role="listitem"[\s\S]*?<span class="trend-label" aria-hidden="true">\$\{days\[i\]\}<\/span>\s*<\/div>`\)\.join/);
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
  assert.match(renderStatSource, /id="report-period-seg" role="radiogroup" aria-label="报告类型"/);
  assert.match(renderStatSource, /id="report-day-seg" role="radiogroup" aria-label="日报日期"/);
  assert.doesNotMatch(renderStatSource, /id="btn-report-agent"/);
  assert.match(renderStatSource, /window\.api\.ai\.report\(\{/);
  assert.match(preload, /report: \(input, requestId\) => ipcRenderer\.invoke\('ai:report'/);
  assert.match(main, /ipcMain\.handle\('ai:report'/);
  assert.match(renderStatSource, /class="stat-card total"/);
  assert.match(renderStatSource, /class="stat-card done"/);
  assert.match(renderStatSource, /class="stat-card doing"/);
  assert.match(renderStatSource, /class="stat-card rate"/);
  assert.match(renderStatSource, /class="trend-column\$\{i === trend\.length - 1 \? ' today' : ''\}"/);
  assert.match(css, /\.stat-card\.done \.sc-v \{ color: var\(--ok\); \}/);
  assert.match(css, /\.trend-column\.today \.trend-bar \{ background: var\(--accent\);/);
  assert.match(renderStatSource, /role="radio" aria-checked="\$\{reportWeek === 0\}"/);
  assert.match(renderStatSource, /x\.setAttribute\('aria-checked', 'false'\)/);
  assert.match(renderStatSource, /\$\('#report-preview'\)\.textContent = ''/);
  assert.match(renderStatSource, /id="report-preview"[\s\S]*?role="region" aria-label="周报预览" tabindex="0"/);
  assert.match(renderStatSource, /function beginReportAction\(button, busyLabel\)/);
  assert.match(renderStatSource, /const requestedWeek = reportWeek/);
  assert.doesNotMatch(renderStatSource, /weeklyReport\(requestedWeek\)/);
  assert.match(renderStatSource, /if \(reportActionBusy\) return/);
  assert.match(css, /#btn-report-gen \{ width: 112px; \}/);
  assert.match(css, /#btn-report-copy \{ width: 84px; \}/);
  assert.match(css, /#btn-report-download \{ width: 108px; \}/);
  assert.match(renderStatSource, /preview\.focus\(\{ preventScroll: true \}\);\s*preview\.scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(renderStatSource, /console\.error\('\[report\] generation failed:', e\)/);
  assert.match(renderStatSource, /toast\('周报生成失败，请稍后重试'/);
  assert.match(renderStatSource, /setButtonContent\(copyBtn, '已复制', 'check'\)/);
  assert.match(renderStatSource, /id="btn-report-gen">\$\{uiIcon\('file-text'\)\}<span>生成周报<\/span>/);
  assert.match(renderStatSource, /id="btn-report-download">\$\{uiIcon\('download'\)\}<span>下载 \.md<\/span>/);
  assert.match(renderStatSource, /a\.download = weeklyReportFileName\(reportWeek\)/);
  assert.match(renderStatSource, /a\.download = dailyReportFileName\(reportDay\)/);
  assert.doesNotMatch(renderStatSource, /window\.api\.data\.dailyReport\(requestedOffset\)/);
  assert.match(app, /function reportCard\(result\)/);
  assert.match(app, /className = 'report-evidence-band'/);
  assert.match(app, /className = 'report-source-drawer hidden'/);
  assert.match(app, /textContent: '核对来源'/);
  assert.match(app, /sendPrompt\('结束报告修改'\)/);
  assert.match(app, /report: '报告修改中 · 直接说受众、重点、语气或篇幅'/);
  assert.match(css, /\.report-agent-head \{[\s\S]*?flex-wrap/);
  assert.match(css, /\.report-evidence-band \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.report-source-list \{ max-height: 220px; overflow: auto;/);
  assert.match(css, /\.report-source-item-head strong \{[^}]*overflow-wrap: anywhere/);
  assert.match(renderStatSource, /URL\.revokeObjectURL\(url\)/);
});

test('周报操作锁会冻结周期和命令并完整恢复原状态', () => {
  const makeControl = (innerHTML = '') => ({
    attrs: {}, disabled: false, innerHTML, isConnected: true, children: [],
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren() { this.children = []; this.innerHTML = ''; },
    appendChild(child) { this.children.push(child); }
  });
  const week = makeControl('本周');
  const generate = makeControl('<svg></svg><span>生成周报</span>');
  const copy = makeControl('<svg></svg><span>复制</span>');
  const download = makeControl('<svg></svg><span>下载 .md</span>');
  const actions = makeControl();
  const weekGroup = makeControl();
  const controls = [week, generate, copy, download];
  const panel = {
    querySelector(selector) { return selector === '.report-actions' ? actions : weekGroup; },
    querySelectorAll() { return controls; }
  };
  generate.closest = (selector) => selector === '.report-panel' ? panel : null;
  const run = loadRendererRuntime({
    __createElement: () => ({ textContent: '' }),
    __testValues: { generate }
  });

  assert.strictEqual(run(`testValues.release = beginReportAction(testValues.generate, '生成中…'); reportActionBusy`), true);
  assert.strictEqual(run(`beginReportAction(testValues.generate, '生成中…')`), null);
  assert.ok(controls.every((control) => control.disabled));
  assert.strictEqual(actions.attrs['aria-busy'], 'true');
  assert.strictEqual(weekGroup.attrs['aria-busy'], 'true');
  assert.strictEqual(generate.attrs['aria-busy'], 'true');
  run('testValues.release()');
  assert.ok(controls.every((control) => !control.disabled));
  assert.strictEqual(run('reportActionBusy'), false);
  assert.strictEqual(actions.attrs['aria-busy'], 'false');
  assert.strictEqual(weekGroup.attrs['aria-busy'], 'false');
  assert.strictEqual(generate.attrs['aria-busy'], 'false');
    assert.match(generate.innerHTML, /生成周报/);
});

test('看板和日历的交互卡片保持有效的按钮闭合结构', () => {
  const boardSource = app.slice(app.indexOf('function renderBoard()'), app.indexOf('/* ---------- 视图：日历 ---------- */'));
  const calendarSource = app.slice(app.indexOf('function renderCal('), app.indexOf('/* ---------- 视图：统计 ---------- */'));
  assert.match(boardSource, /<div class="bc-card-item" role="listitem" data-id="\$\{t\.id\}">[\s\S]*?<button type="button" class="bc-card"[\s\S]*?<\/button>[\s\S]*?class="bc-status"[\s\S]*?<\/div>`\)\.join/);
  assert.doesNotMatch(boardSource, /<button type="button" class="bc-card"[\s\S]*?<\/button>\s*<\/button>/);
  assert.match(calendarSource, /\$\{dots \? `<span class="cal-dots">\$\{dots\}<\/span>` : ''\}\s*<\/button>`;/);
  assert.doesNotMatch(calendarSource, /\$\{dots \? `<span class="cal-dots">\$\{dots\}<\/span>` : ''\}\s*<\/div>`;/);
  assert.match(calendarSource, /class="cal-grid" role="grid" aria-label="\$\{y\}年\$\{m \+ 1\}月日历/);
  assert.match(calendarSource, /role="columnheader"/);
  assert.match(calendarSource, /aria-current="date"/);
  assert.match(calendarSource, /playTransientClass\(\$\('#cal-body \.cal-grid'\), direction < 0 \? 'cal-shift-prev' : 'cal-shift-next'/);
  assert.match(css, /\.cal-grid\.cal-shift-prev \{ animation: calShiftPrev var\(--motion-base\)/);
  assert.match(css, /\.cal-detail\.cal-detail-enter \{ animation: calDetailEnter var\(--motion-fast\)/);
});

test('看板按持久化顺序渲染并区分同列与跨列落点', () => {
  const board = { innerHTML: '' };
  const sub = { textContent: '' };
  const column = { dataset: { col: 'todo' }, classList: fakeClassList() };
  const item = { classList: fakeClassList() };
  const targetCard = {
    dataset: { id: '2' },
    closest(selector) { return selector === '.bc-card-item' ? item : null; }
  };
  const run = loadRendererRuntime({
    '#board-cols': board,
    '#board-sub': sub,
    __querySelectorAll: (selector) => {
      if (selector === '#board-cols .board-col') return [column];
      if (selector === '#board-cols .bc-card-item') return [item];
      return [];
    },
    __testValues: { column, targetCard }
  });
  run(`tasks = [
    { id: 1, title: '后排任务', status: 'todo', pri: 4, order: 20, createdAt: 1 },
    { id: 2, title: '前排任务', status: 'todo', pri: 1, order: 10, createdAt: 2 }
  ]; renderBoard()`);
  assert.ok(board.innerHTML.indexOf('前排任务') < board.innerHTML.indexOf('后排任务'));
  assert.match(board.innerHTML, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);

  run(`boardDragState = { id: 1, status: 'todo' }; showBoardDropFeedback(testValues.column, testValues.targetCard, true)`);
  assert.strictEqual(column.classList.contains('col-drop'), true);
  assert.strictEqual(item.classList.contains('drop-before'), true);
  run(`boardDragState = { id: 1, status: 'doing' }; showBoardDropFeedback(testValues.column, testValues.targetCard, false)`);
  assert.strictEqual(column.classList.contains('col-drop'), true);
  assert.strictEqual(item.classList.contains('drop-before'), false);
  assert.strictEqual(item.classList.contains('drop-after'), false);
  assert.match(css, /\.bc-card-item\.drop-before \{ box-shadow: 0 -3px/);
  assert.match(css, /\.col-drop \.bc-head \{ color: var\(--accent\); \}/);
});

test('看板状态菜单提供非拖拽路径并在重绘后恢复焦点', async () => {
  const boardAttrs = {};
  const triggerAttrs = {};
  const updates = [];
  const board = { setAttribute(name, value) { boardAttrs[name] = value; } };
  const nextTrigger = { focused: false, focus() { this.focused = true; } };
  const trigger = {
    value: 'doing',
    disabled: false,
    setAttribute(name, value) { triggerAttrs[name] = value; }
  };
  const run = loadRendererRuntime({
    '#board-cols': board,
    '#board-cols [data-board-status][data-id="1"]': nextTrigger,
    __window: { api: { tasks: { update: async (id, data) => { updates.push({ id, data }); } } } },
    __testValues: { trigger }
  });
  run(`tasks = [{ id: 1, title: '整理周报', status: 'todo' }]; refreshTasksAfterMutation = async () => {}; toast = () => {}`);
  assert.strictEqual(await run(`moveBoardTask(1, 'doing', testValues.trigger)`), true);
  assert.strictEqual(JSON.stringify(updates), JSON.stringify([{ id: 1, data: { status: 'doing' } }]));
  assert.strictEqual(boardAttrs['aria-busy'], 'false');
  assert.strictEqual(triggerAttrs['aria-busy'], 'false');
  assert.strictEqual(trigger.disabled, false);
  assert.strictEqual(nextTrigger.focused, true);

  const boardSource = app.slice(app.indexOf('function renderBoard()'), app.indexOf('/* ---------- 视图：日历 ---------- */'));
  assert.match(boardSource, /data-board-status data-id="\$\{t\.id\}" aria-label="移动任务/);
  assert.strictEqual((boardSource.match(/<option value="\$\{target\.k\}"/g) || []).length, 1);
  assert.match(app, /#board-cols'\)\.addEventListener\('change'/);
  assert.match(css, /\.bc-card-item:focus-within/);
  assert.match(css, /\.bc-status \{/);
});

test('拖拽排序阻止并发写入并在失败后恢复原界面', async () => {
  let release;
  let reorderCalls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const surfaceAttrs = {};
  const surface = { setAttribute(name, value) { surfaceAttrs[name] = value; } };
  const item = { isConnected: true, classList: fakeClassList() };
  const toasts = [];
  const run = loadRendererRuntime({
    __window: { api: { tasks: { reorder: async () => { reorderCalls++; await pending; } } } },
    __testValues: { surface, item, toasts }
  });
  run(`
    toast = (message) => testValues.toasts.push(message);
    refreshTasksAfterMutation = async () => {};
  `);
  const first = run(`commitTaskOrder([2, 1], testValues.item, testValues.surface, 'list', '已调整任务顺序', '刷新失败')`);
  const duplicate = await run(`commitTaskOrder([1, 2], testValues.item, testValues.surface, 'list', '已调整任务顺序', '刷新失败')`);
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
  assert.strictEqual(await run(`commitTaskOrder([2, 1], testValues.item, testValues.surface, 'list', '已调整任务顺序', '刷新失败')`), false);
  assert.strictEqual(run('taskReorderBusy'), false);
  assert.strictEqual(surfaceAttrs['aria-busy'], 'false');
  assert.strictEqual(item.classList.contains('reorder-error'), true);
  assert.match(toasts[toasts.length - 1], /任务仍在原位置/);
  assert.match(css, /\.task-row\.reorder-commit,[\s\S]*?animation: reorderCommit/);
  assert.match(css, /\.task-row\.reorder-error,[\s\S]*?animation: reorderError/);
});

test('列表与看板支持键盘重排并在重绘后恢复到同一任务', async () => {
  const orders = [];
  const boardAttrs = {};
  const board = {
    setAttribute(name, value) { boardAttrs[name] = value; },
    querySelectorAll() { return []; }
  };
  const column = { querySelectorAll() { return [first, second]; } };
  const makeItem = (id) => ({
    dataset: { id: String(id) },
    classList: fakeClassList(),
    closest(selector) { return selector === '.board-col' ? column : null; }
  });
  const first = makeItem(1);
  const second = makeItem(2);
  const focused = { focus(options) { this.focused = true; this.options = options; } };
  const run = loadRendererRuntime({
    '#board-cols': board,
    '#board-cols .bc-card-item[data-id="2"]': second,
    '#board-cols .bc-card[data-id="2"]': focused,
    __window: { api: { tasks: { reorder: async (ids) => { orders.push(ids); } } } }
  });
  run(`refreshTasksAfterMutation = async () => {}; toast = () => {}`);
  assert.strictEqual(await run(`reorderTaskByKeyboard('board', 2, -1)`), true);
  assert.strictEqual(JSON.stringify(orders), JSON.stringify([[2, 1]]));
  assert.strictEqual(focused.focused, true);
  assert.strictEqual(focused.options.preventScroll, true);
  assert.strictEqual(boardAttrs['aria-busy'], 'false');
  assert.match(app, /#board-cols'\)\.addEventListener\('keydown', \(e\) => onTaskReorderKeyDown\(e, 'board'\)\)/);
  assert.match(app, /#tasks-list'\)\.addEventListener\('keydown', \(e\) => onTaskReorderKeyDown\(e, 'list'\)\)/);
  assert.match(app, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
});

test('日历使用单一 Tab 停靠点并支持二维方向键浏览', () => {
  let cells;
  const grid = {
    querySelectorAll() { return cells; }
  };
  const makeCell = (key, tabIndex) => ({
    dataset: { day: key },
    tabIndex,
    focused: false,
    focus() { this.focused = true; },
    closest(selector) {
      if (selector === '.cal-cell[data-day]') return this;
      if (selector === '.cal-grid') return grid;
      return null;
    }
  });
  cells = Array.from({ length: 14 }, (_, index) => makeCell(`2026-08-${String(index + 2).padStart(2, '0')}`, index === 0 ? 0 : -1));
  let prevented = false;
  const event = { target: cells[0], key: 'ArrowRight', preventDefault() { prevented = true; } };
  const run = loadRendererRuntime({ '#cal-body .cal-grid': grid, __testValues: { event, cells } });
  run('onCalKeyDown(testValues.event)');
  assert.strictEqual(prevented, true);
  assert.strictEqual(cells[1].focused, true);
  assert.deepStrictEqual(cells.map((cell) => cell.tabIndex), [-1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);

  run(`testValues.event.target = testValues.cells[9]; testValues.event.key = 'Home'; onCalKeyDown(testValues.event)`);
  assert.strictEqual(cells[7].focused, true);
  assert.strictEqual(cells.filter((cell) => cell.tabIndex === 0).length, 1);
  assert.strictEqual(run(`shiftCalendarKey('2026-03-31', 0, -1)`), '2026-02-28');
  assert.strictEqual(run(`shiftCalendarKey('2026-08-20', 7, 0)`), '2026-08-27');
  assert.match(app, /#cal-body'\)\.addEventListener\('keydown', onCalKeyDown\)/);
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
  assert.match(app, /function setBoardBusyState\(busy, activeControl\)/);
  assert.match(boardEvents, /showBoardDropFeedback\(col, targetCard, before\)/);
  assert.match(boardEvents, /console\.error\('\[board\] task move failed:', error\)/);
  assert.match(boardEvents, /toast\('移动任务失败，请稍后重试'/);
  assert.match(css, /\.board-cols \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(3, minmax\(150px, 1fr\)\)/);
  assert.match(css, /\.bc-card \.cb \{[^}]*align-items: flex-start;/);
  assert.match(css, /\.bc-card \.pri-dot \{[^}]*flex: 0 0 auto;/);
  assert.match(app, /id="today-empty-all">查看所有任务/);
  assert.match(app, /id="today-empty-new">新建任务/);
  assert.match(app, /uiIcon\('search'\)/);
  assert.match(app, /today: \{ ico: 'today'/);
  assert.match(app, /archived: \{ ico: 'archive'/);
  assert.match(app, /uiIcon\('stat'\)/);
  assert.match(app, /id="cal-add-task">\$\{uiIcon\('plus'\)\}/);
  assert.strictEqual((app.match(/#cal-body'\)\.addEventListener\('click', onCalClick\)/g) || []).length, 1);
  assert.strictEqual((app.match(/#cal-body'\)\.addEventListener\('keydown', onCalKeyDown\)/g) || []).length, 1);
  assert.match(app, /class="cal-title" aria-live="polite"/);
  assert.match(app, /class="cal-dot \$\{dotCls\}" aria-hidden="true"/);
});

test('项目和标签筛选为空时提供清除路径并恢复到全部筛选', () => {
  let clearHandler = null;
  const container = {
    innerHTML: '',
    querySelector(selector) {
      if (selector !== '#empty-clear-filter') return null;
      return { addEventListener(name, handler) { if (name === 'click') clearHandler = handler; } };
    }
  };
  const allFilter = { focused: false, focus() { this.focused = true; } };
  const run = loadRendererRuntime({
    '#smart-filters .fchip[data-filter="all"]': allFilter,
    __testValues: { container }
  });
  run(`currentFilter = 'tag:工作'; renderTasks = () => {}; renderList(testValues.container, [])`);
  assert.match(container.innerHTML, /“#工作”下没有任务/);
  assert.match(container.innerHTML, /id="empty-clear-filter">清除筛选/);
  clearHandler();
  assert.strictEqual(run('currentFilter'), 'all');
  assert.strictEqual(allFilter.focused, true);
  assert.match(app, /\$\('#tasks-sub'\)\.textContent = `显示 \$\{list\.length\} · 完成/);
});

test('任务筛选保留核心状态并将项目标签收进可记忆的更多筛选', () => {
  const wrap = { innerHTML: '' };
  const run = loadRendererRuntime({ '#smart-filters': wrap });
  run(`tasks = [
    { id: 1, project: 'Q3 规划', tags: ['工作', '规划'] },
    { id: 2, project: '日常工作', tags: ['工作'] }
  ]; currentFilter = 'all'; advancedFiltersOpen = false; renderSmartFilters()`);
  assert.match(wrap.innerHTML, /id="smart-more" aria-expanded="false" aria-controls="smart-advanced"/);
  assert.match(wrap.innerHTML, /更多筛选 4/);
  assert.match(wrap.innerHTML, /class="smart-advanced hidden"/);
  assert.match(wrap.innerHTML, /data-filter="proj:Q3 规划"/);
  assert.match(wrap.innerHTML, /data-filter="tag:工作"/);

  run(`currentFilter = 'proj:Q3 规划'; advancedFiltersOpen = true; renderSmartFilters()`);
  assert.match(wrap.innerHTML, /id="smart-more" aria-expanded="true"/);
  assert.match(wrap.innerHTML, /class="smart-more-label"><svg[^>]+>[\s\S]*?href="#ui-i-folder"[\s\S]*?<span>Q3 规划<\/span>[\s\S]*?href="#ui-i-chevron-up"/);
  assert.match(wrap.innerHTML, /class="fchip has-icon active"[^>]+data-filter="proj:Q3 规划"[^>]*>[\s\S]*?href="#ui-i-folder"/);
  assert.doesNotMatch(wrap.innerHTML, /class="smart-advanced hidden"/);
  assert.match(app, /advancedFiltersOpen = !advancedFiltersOpen;\s*renderSmartFilters\(\);\s*\$\('#smart-more'\)\.focus\(\)/);
  assert.match(app, /#smart-filters \.fchip\[data-filter\]/);
  assert.match(css, /\.smart-advanced \{[^}]*border-left: 2px solid/);
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
  assert.match(css, /\.settings-nav-item\.active \{[^}]*border-bottom-color: var\(--accent\);/);
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
  assert.match(app, /if \(view === 'trash'\) loadTrash\(\);\s*applyDataLoadStates\(\)/);
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
  assert.match(app, /el\.readOnly = true;\s*el\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /el\.readOnly = false;\s*el\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(app, /function runSettingsAction\(button, busyText, action, failureMessage, scope\)/);
  assert.match(app, /const idleHtml = button\.innerHTML;[\s\S]*?button\.innerHTML = idleHtml/);
  assert.match(app, /id="btn-export-json"[^>]+data-settings-scope="data">\$\{uiIcon\('download'\)\}<span>导出 JSON<\/span>/);
  assert.match(app, /id="btn-import-json"[^>]+data-settings-scope="data">\$\{uiIcon\('upload'\)\}<span>导入 JSON<\/span>/);
  assert.match(app, /id="btn-backup-now"[^>]+data-settings-scope="data">\$\{uiIcon\('save'\)\}<span>立即备份<\/span>/);
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
  assert.match(html, /class="nav-item" data-view="memos"/);
  assert.match(html, /id="view-memos"/);
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
    testValues.release = beginMemoAction(document.getElementById('memo-to-task'), '创建中…');
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

test('新建备忘录在等待旧草稿保存时拒绝重复创建', async () => {
  const makeButton = () => ({
    attrs: {}, disabled: false,
    setAttribute(name, value) { this.attrs[name] = value; }
  });
  const newButton = makeButton();
  const emptyButton = makeButton();
  const title = { selectCalled: false, select() { this.selectCalled = true; } };
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
            return { id: 8, title: '无标题备忘录', content: '', tags: [], pinned: false };
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
  assert.strictEqual(createCalls, 1);
  assert.strictEqual(run('memoCreating'), false);
  assert.strictEqual(newButton.disabled, false);
  assert.strictEqual(emptyButton.disabled, false);
  assert.strictEqual(title.selectCalled, true);
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
  assert.strictEqual((list.innerHTML.match(/tabindex="0"/g) || []).length, 1);
  assert.strictEqual((list.innerHTML.match(/tabindex="-1"/g) || []).length, 1);
});
