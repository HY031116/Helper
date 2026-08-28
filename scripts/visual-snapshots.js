'use strict';

/* 轻量视觉快照：启动真实窗口、种入演示数据并按视图/主题截图。
   与 visual-qa.js 的区别：只做截屏不做交互断言，用于设计验收。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(os.tmpdir(), `work-helper-design-shots-${stamp}`);
const dataDir = path.join(outputDir, 'profile');
process.argv.push(`--work-helper-data-dir=${dataDir}`);

require('../src/main');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWindow(title) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === title);
    if (window && !window.isDestroyed()) return window;
    await wait(100);
  }
  throw new Error(`未找到窗口：${title}`);
}

function reloadWindow(window) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`窗口重载超时：${window.getTitle()}`)), 10000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    window.reload();
  });
}

async function capture(window, name) {
  await wait(220);
  const image = await window.capturePage();
  const file = path.join(outputDir, name);
  fs.writeFileSync(file, image.toPNG());
  return { file, bytes: fs.statSync(file).size };
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const mainWindow = await waitForWindow('工作台助手');
    const petWindow = await waitForWindow('桌宠');
    const petPanelWindow = await waitForWindow('桌宠助手');
    const store = require('../src/main/store');
    const results = [];

    mainWindow.setSize(1180, 780);

    // 种入有层次的演示数据：不同优先级、到期、状态与标签
    store.resetTasks();
    store.clearChat();
    store.updateSettings({ aiStage: 'mock' });
    store.updateWorkPreferences({ workdayStart: '09:00', workdayEnd: '23:59' });
    const now = new Date();
    const fmt = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const today = now;
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const nextWeek = new Date(now.getTime() + 6 * 24 * 3600 * 1000);
    store.getAllTasks().forEach((task, index) => {
      store.updateTask(task.id, { estimatedMinutes: 25 + index * 10 });
    });
    store.createTask({ title: '发布 0.3 版本：核对更新说明与回滚方案', pri: 4, due: `${fmt(today)} 18:00`, tags: ['发布'], project: 'Q3 规划', estimatedMinutes: 60 });
    store.createTask({ title: '逾期：提交上月差旅报销', pri: 3, due: `${fmt(yesterday)} 12:00`, tags: ['行政'], estimatedMinutes: 20 });
    store.createTask({ title: '整理客户访谈纪要并同步给团队', pri: 2, due: `${fmt(tomorrow)} 15:00`, tags: ['调研'], project: 'Q3 规划', estimatedMinutes: 45 });
    store.createTask({ title: '规划下季度 OKR 草案', pri: 3, due: `${fmt(nextWeek)} 18:00`, tags: ['规划'], estimatedMinutes: 90 });
    const seeded = store.getAllTasks().filter((task) => task.status === 'todo');
    if (seeded[2]) store.completeTask(seeded[2].id);
    store.createMemo({ title: '发布前核对', content: '确认版本号、更新说明和回滚方案。\n记得把安装包同步到内网。', tags: ['发布'] });
    store.createMemo({ title: '键盘快捷键速记', content: '全局唤起：Alt+Shift+W\n快速新建：Ctrl+N', tags: ['技巧'] });
    const plan = store.previewDailyPlan({ availableMinutes: 150 });
    if (plan.items.length) store.applyDailyPlan(plan);
    const focusTask = plan.items.length ? plan.items[0].taskId : seeded[0].id;
    if (focusTask) store.startFocus(focusTask, { targetMinutes: 25 });

    await Promise.all([reloadWindow(mainWindow), reloadWindow(petWindow), reloadWindow(petPanelWindow)]);

    // 固定每日 Agent 简报，保证今天视图首屏有建议内容
    const briefing = store.getDailyCopilot(new Date('2026-08-25T09:15:00').getTime());
    await mainWindow.webContents.executeJavaScript(`
      document.body.classList.remove('dark');
      dailyCopilot = ${JSON.stringify(briefing)};
      copilotSourcesOpen = false;
      switchView('today');
      renderDailyCopilot();
      true;
    `);
    results.push(await capture(mainWindow, '01-today-light.png'));

    // 宽窗口：展示「今天」视图的双栏图纸台布局
    mainWindow.setSize(1440, 860);
    await wait(250);
    results.push(await capture(mainWindow, '01b-today-wide-light.png'));
    mainWindow.setSize(1180, 780);
    await wait(200);

    // 滚动到逾期分组：核对顺延按钮与行分隔线的排版关系
    await mainWindow.webContents.executeJavaScript(`
      switchView('today');
      const overdueGroup = document.querySelector('.today-group.overdue');
      if (overdueGroup) overdueGroup.scrollIntoView({ block: 'start' });
      true;
    `);
    results.push(await capture(mainWindow, '01c-today-overdue-light.png'));
    await mainWindow.webContents.executeJavaScript(`
      document.body.classList.add('dark');
      true;
    `);
    results.push(await capture(mainWindow, '01d-today-overdue-dark.png'));
    await mainWindow.webContents.executeJavaScript(`
      document.body.classList.remove('dark');
      true;
    `);

    await mainWindow.webContents.executeJavaScript(`
      copilotSourcesOpen = true;
      renderDailyCopilot();
      true;
    `);
    results.push(await capture(mainWindow, '02-copilot-sources-light.png'));

    for (const [view, name] of [
      ['tasks', '03-tasks-light'],
      ['memos', '04-memos-light'],
      ['board', '05-board-light'],
      ['cal', '06-calendar-light'],
      ['stat', '07-stats-light'],
      ['settings', '08-settings-light'],
      ['trash', '09-trash-light']
    ]) {
      await mainWindow.webContents.executeJavaScript(`switchView('${view}'); true;`);
      results.push(await capture(mainWindow, `${name}.png`));
    }

    // AI 助手对话样例
    await mainWindow.webContents.executeJavaScript(`
      switchView('today');
      document.querySelector('#ai-chat').innerHTML = '';
      addMsg('user', '把客户访谈挪到明天下午，顺便看看今天还剩什么');
      const response = addMsg('ai', '好的，已把「整理客户访谈纪要」改到明天 15:00。\\n今天还剩 4 项待办，其中「发布 0.3 版本」截止 18:00，建议先做。');
      response.appendChild(opCard({
        type: 'update',
        task: { id: 9001, title: '整理客户访谈纪要并同步给团队' },
        undoable: true,
        undo: { action: 'removeCreatedAdditions', tasks: [], memos: [] }
      }));
      scrollChat();
      true;
    `);
    results.push(await capture(mainWindow, '10-assistant-light.png'));

    // 任务编辑弹窗（头部下划线与表单布局）；先清掉瞬态提醒，保证截图可验收
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        document.body.classList.remove('dark');
        document.querySelectorAll('#toast-layer .toast').forEach((item) => dismissToast(item, true));
        switchView('tasks');
        openModal(tasks.find((task) => task.status !== 'archived'));
        return true;
      })()
    `);
    results.push(await capture(mainWindow, '19-task-modal-light.png'));
    await mainWindow.webContents.executeJavaScript(`closeModal(false); true;`);

    // 任务 Agent 独立小窗
    const agentTask = store.getAllTasks().find((task) => task.status !== 'done' && task.status !== 'archived');
    await mainWindow.webContents.executeJavaScript(`
      window.api.taskAgent.open({ taskId: ${agentTask.id}, title: ${JSON.stringify(agentTask.title)}, draft: '', workLogId: '', workLogKind: '' });
      true;
    `);
    const agentWindow = await waitForWindow('任务对话');
    await agentWindow.webContents.executeJavaScript(`
      const thread = document.querySelector('#ta-thread');
      const userMsg = document.createElement('div');
      userMsg.className = 'ta-msg user';
      userMsg.textContent = '拆成三步';
      thread.appendChild(userMsg);
      const aiMsg = document.createElement('div');
      aiMsg.className = 'ta-msg ai';
      aiMsg.textContent = '建议拆成：1）列出核对项；2）逐项确认回滚方案；3）打包并内网同步。确认后我来更新子任务。';
      thread.appendChild(aiMsg);
      true;
    `);
    results.push(await capture(agentWindow, '11-task-agent-light.png'));
    await agentWindow.close();

    // 深色主题
    await mainWindow.webContents.executeJavaScript(`
      document.body.classList.add('dark');
      switchView('today');
      true;
    `);
    results.push(await capture(mainWindow, '12-today-dark.png'));
    await mainWindow.webContents.executeJavaScript(`switchView('board'); true;`);
    results.push(await capture(mainWindow, '13-board-dark.png'));

    // 窄窗口
    mainWindow.setSize(900, 650);
    await mainWindow.webContents.executeJavaScript(`
      document.body.classList.remove('dark');
      switchView('today');
      true;
    `);
    results.push(await capture(mainWindow, '14-today-narrow-light.png'));

    // 桌宠与面板
    results.push(await capture(petWindow, '15-pet-light.png'));
    await petPanelWindow.webContents.executeJavaScript(`
      document.body.classList.remove('dark');
      true;
    `);
    results.push(await capture(petPanelWindow, '16-pet-panel-light.png'));
    await petPanelWindow.webContents.executeJavaScript(`selectPage('chat'); true;`);
    results.push(await capture(petPanelWindow, '17-pet-panel-chat-light.png'));
    await petPanelWindow.webContents.executeJavaScript(`
      document.body.classList.add('dark');
      true;
    `);
    results.push(await capture(petPanelWindow, '18-pet-panel-chat-dark.png'));

    process.stdout.write(`${JSON.stringify({ outputDir, count: results.length, results }, null, 2)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  }
});
