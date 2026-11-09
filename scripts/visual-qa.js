'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

const UX_ACCEPTANCE_REQUIREMENTS = Object.freeze([
  { area: '导航与视图', checks: ['calendar-direction-and-focus', 'reduced-motion-main'] },
  { area: '任务写入与弹窗', checks: ['task-row-lock-and-focus', 'task-modal-lock-and-confirm'] },
  { area: '筛选、批量与排序', checks: ['filter-empty-clear-and-focus', 'batch-lock-and-stable-layout', 'board-order-drop-and-focus'] },
  { area: '统计日报与周报', checks: ['report-lock-and-stable-layout', 'report-agent-daily', 'report-agent-evidence-source'] },
  { area: '备忘录', checks: ['memo-toolbar-lock-and-focus'] },
  { area: '设置与危险确认', checks: ['settings-scope-and-focus', 'settings-confirm-retry-and-redraw-focus'] },
  { area: '通知与撤销', checks: ['notification-action-retry'] },
  { area: '助手对话', checks: ['cancel-without-mutation', 'duplicate-request-idempotency', 'assistant-busy-and-cancel', 'assistant-reading-position', 'assistant-edit-retry'] },
  { area: '桌宠', checks: ['pet-free-position-and-panel-anchor', 'pet-reminder-opens-task', 'pet-navigation-lock-error-and-focus', 'pet-inline-agent-chat', 'reduced-motion-pet'] }
]);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(os.tmpdir(), `work-helper-visual-qa-${stamp}`);
const dataDir = path.join(outputDir, 'profile');
process.argv.push(`--work-helper-data-dir=${dataDir}`);

// 瞬态动画类是在 requestAnimationFrame 回调里加的，而 Chromium 会节流被遮挡/后台窗口的渲染帧；
// 不关掉后台化，依赖动画的观察会随机拿不到那一帧。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

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
  await wait(150);
  const image = await window.capturePage();
  const file = path.join(outputDir, name);
  fs.writeFileSync(file, image.toPNG());
  return { file, size: image.getSize(), bytes: fs.statSync(file).size };
}

async function emulateReducedMotion(window, enabled = true) {
  const debuggerSession = window.webContents.debugger;
  if (!debuggerSession.isAttached()) debuggerSession.attach('1.3');
  await debuggerSession.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : 'no-preference' }]
  });
  await wait(50);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const mainWindow = await waitForWindow('工作台助手');
    const petWindow = await waitForWindow('桌宠');
    const petPanelWindow = await waitForWindow('桌宠助手');
    const store = require('../src/main/store');
    const interactionChecks = [];

    const cancelServer = http.createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.write(': connected\n\n');
      request.once('close', () => response.end());
    });
    await new Promise((resolve, reject) => {
      cancelServer.once('error', reject);
      cancelServer.listen(0, '127.0.0.1', resolve);
    });
    const cancelPort = cancelServer.address().port;
    store.updateSettings({
      aiStage: 'llm', aiProvider: 'custom', aiBaseUrl: `http://127.0.0.1:${cancelPort}/v1`,
      aiApiKey: 'visual-qa-key', aiModel: 'visual-qa-model'
    });
    const stateBeforeCancel = JSON.stringify({
      tasks: store.getAllTasks(), memos: store.getAllMemos()
    });
    const cancelCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const requestId = 'visual-cancel-request';
        let resolveStarted;
        const started = new Promise((resolve) => { resolveStarted = resolve; });
        const unsubscribe = window.api.ai.onProgress((progress) => {
          if (progress.requestId === requestId && progress.stage === 'responding') resolveStarted();
        });
        const pending = window.api.ai.handle('聊聊今天的工作节奏', requestId);
        await started;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const cancel = await window.api.ai.cancel(requestId);
        const result = await pending;
        unsubscribe();
        return { cancel, result };
      })()
    `);
    const stateAfterCancel = JSON.stringify({
      tasks: store.getAllTasks(), memos: store.getAllMemos()
    });
    await new Promise((resolve) => cancelServer.close(resolve));
    if (!cancelCheck.cancel.ok || cancelCheck.result.type !== 'cancelled' || stateBeforeCancel !== stateAfterCancel) {
      throw new Error('助手 IPC 取消验证失败');
    }
    interactionChecks.push({ id: 'cancel-without-mutation', passed: true });

    store.clearChat();
    store.updateSettings({ aiStage: 'mock' });
    const duplicateCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const requestId = 'visual-duplicate-request';
        const first = await window.api.ai.handle('新建任务：IPC重复提交验证', requestId);
        const second = await window.api.ai.handle('新建任务：IPC重复提交验证', requestId);
        return { first, second };
      })()
    `);
    const duplicateCount = store.getAllTasks().filter((task) => task.title === 'IPC重复提交验证').length;
    if (duplicateCount !== 1 || duplicateCheck.first.task.id !== duplicateCheck.second.task.id) {
      throw new Error('助手 IPC 重复请求去重验证失败');
    }
    interactionChecks.push({ id: 'duplicate-request-idempotency', passed: true });

    store.resetTasks();
    store.clearChat();
    store.getAllTasks().forEach((task, index) => {
      store.updateTask(task.id, { estimatedMinutes: 25 + index * 10 });
    });
    await Promise.all([reloadWindow(mainWindow), reloadWindow(petWindow), reloadWindow(petPanelWindow)]);

    mainWindow.setSize(1180, 780);
    await mainWindow.webContents.executeJavaScript("document.body.classList.remove('dark')");
    const results = [await capture(mainWindow, 'main-empty-light.png')];

    store.createMemo({ title: '发布前核对', content: '确认版本号、更新说明和回滚方案。', tags: ['发布'] });
    await Promise.all([reloadWindow(mainWindow), reloadWindow(petWindow), reloadWindow(petPanelWindow)]);
    results.push(await capture(mainWindow, 'main-light.png'));

    const taskRowBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        switchView('tasks');
        const row = document.querySelector('#tasks-list .task-row');
        const taskId = Number(row.dataset.id);
        const control = row.querySelector('.task-check');
        window.__visualTaskBusyRelease = null;
        window.__visualTaskBusyDuplicateRan = false;
        window.__visualTaskBusyPromise = runTaskRowMutation({
          taskId,
          control,
          operation: () => new Promise((resolve) => { window.__visualTaskBusyRelease = resolve; }),
          previousIndex: 0,
          focusSelector: '.task-check'
        });
        return {
          taskId,
          busy: row.classList.contains('is-busy') && row.getAttribute('aria-busy') === 'true',
          controlsLocked: Array.from(row.querySelectorAll('button')).every((button) => button.disabled),
          height: row.getBoundingClientRect().height
        };
      })()
    `);
    const taskRowDuplicateCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const duplicate = await runTaskRowMutation({
          taskId: ${taskRowBusyCheck.taskId},
          operation: async () => { window.__visualTaskBusyDuplicateRan = true; }
        });
        return { duplicate, duplicateRan: window.__visualTaskBusyDuplicateRan };
      })()
    `);
    if (!taskRowBusyCheck.busy || !taskRowBusyCheck.controlsLocked || taskRowDuplicateCheck.duplicate || taskRowDuplicateCheck.duplicateRan) {
      throw new Error(`任务行写入锁验证失败：${JSON.stringify({ taskRowBusyCheck, taskRowDuplicateCheck })}`);
    }
    results.push(await capture(mainWindow, 'task-row-busy-light.png'));
    const taskRowReleaseCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        window.__visualTaskBusyRelease();
        await window.__visualTaskBusyPromise;
        const row = document.querySelector('#tasks-list .task-row[data-id="${taskRowBusyCheck.taskId}"]');
        return {
          busy: row.classList.contains('is-busy'),
          controlsReady: Array.from(row.querySelectorAll('button')).every((button) => !button.disabled),
          height: row.getBoundingClientRect().height,
          focusRestored: document.activeElement === row.querySelector('.task-check')
        };
      })()
    `);
    if (taskRowReleaseCheck.busy || !taskRowReleaseCheck.controlsReady || !taskRowReleaseCheck.focusRestored
      || Math.abs(taskRowReleaseCheck.height - taskRowBusyCheck.height) > 0.5) {
      throw new Error(`任务行写入恢复验证失败：${JSON.stringify(taskRowReleaseCheck)}`);
    }
    interactionChecks.push({ id: 'task-row-lock-and-focus', passed: true });

    const boardOrderCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        switchView('board');
        const column = Array.from(document.querySelectorAll('#board-cols .board-col'))
          .find((candidate) => candidate.querySelectorAll('.bc-card-item').length >= 2);
        if (!column) return { missingColumn: true };
        const before = Array.from(column.querySelectorAll('.bc-card-item')).map((item) => Number(item.dataset.id));
        const movedId = before[1];
        const success = await reorderTaskByKeyboard('board', movedId, -1);
        const moved = document.querySelector('#board-cols .bc-card[data-id="' + movedId + '"]');
        const nextColumn = moved.closest('.board-col');
        const after = Array.from(nextColumn.querySelectorAll('.bc-card-item')).map((item) => Number(item.dataset.id));
        const target = nextColumn.querySelector('.bc-card[data-id]:not([data-id="' + movedId + '"])');
        const targetRect = target.getBoundingClientRect();
        boardDragState = { id: movedId, status: tasks.find((task) => task.id === movedId).status };
        showBoardDropFeedback(nextColumn, target, true);
        return {
          success,
          movedId,
          before,
          after,
          persistedAtTarget: after[0] === movedId,
          focusRestored: document.activeElement === moved,
          columnHighlighted: nextColumn.classList.contains('col-drop'),
          insertionShown: target.closest('.bc-card-item').classList.contains('drop-before'),
          targetHeight: targetRect.height
        };
      })()
    `);
    if (boardOrderCheck.missingColumn || !boardOrderCheck.success || !boardOrderCheck.persistedAtTarget
      || !boardOrderCheck.focusRestored || !boardOrderCheck.columnHighlighted || !boardOrderCheck.insertionShown) {
      throw new Error(`看板顺序与落点验证失败：${JSON.stringify(boardOrderCheck)}`);
    }
    interactionChecks.push({ id: 'board-order-drop-and-focus', passed: true });
    results.push(await capture(mainWindow, 'board-drop-target-light.png'));
    await mainWindow.webContents.executeJavaScript(`boardDragState = null; clearBoardDropFeedback(); true;`);

    const calendarStart = await mainWindow.webContents.executeJavaScript(`
      (() => {
        switchView('cal');
        const before = document.querySelector('.cal-title').textContent;
        // 位移类只存在一个动画周期，靠轮询会因 IPC 往返时延漏看，先在点击前挂观察者
        window.__calShiftSeen = false;
        const observer = new MutationObserver(() => {
          const grid = document.querySelector('#cal-body .cal-grid');
          if (grid && (grid.classList.contains('cal-shift-next') || grid.classList.contains('cal-shift-prev'))) {
            window.__calShiftSeen = true;
          }
        });
        observer.observe(document.querySelector('#cal-body'), { attributes: true, attributeFilter: ['class'], subtree: true });
        window.__calShiftObserver = observer;
        document.querySelector('[data-cal="next"]').click();
        return before;
      })()
    `);
    let calendarDirectionSeen = false;
    for (let attempt = 0; attempt < 10 && !calendarDirectionSeen; attempt += 1) {
      await wait(20);
      calendarDirectionSeen = await mainWindow.webContents.executeJavaScript(`window.__calShiftSeen === true`);
    }
    const calendarShiftCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        if (window.__calShiftObserver) window.__calShiftObserver.disconnect();
        return ({
          before: ${JSON.stringify(calendarStart)},
          after: document.querySelector('.cal-title').textContent,
          direction: ${JSON.stringify(calendarDirectionSeen)},
          focusRestored: document.activeElement === document.querySelector('[data-cal="next"]'),
          selectedCells: document.querySelectorAll('.cal-cell.selected').length
        });
      })()
    `);
    if (calendarShiftCheck.before === calendarShiftCheck.after || !calendarShiftCheck.direction
      || !calendarShiftCheck.focusRestored || calendarShiftCheck.selectedCells !== 0) {
      throw new Error(`日历方向与焦点验证失败：${JSON.stringify(calendarShiftCheck)}`);
    }
    interactionChecks.push({ id: 'calendar-direction-and-focus', passed: true });
    results.push(await capture(mainWindow, 'calendar-shift-light.png'));

    await mainWindow.webContents.executeJavaScript(`
      {
      switchView('tasks');
      const input = document.querySelector('#quick-input');
      const button = document.querySelector('#btn-quick-add');
      input.value = '明天下午 3 点提交发布说明';
      renderQuickPreview(input.value, { intent: 'create', params: { title: '提交发布说明', due: '2026-08-22 15:00', pri: 3 } });
      setQuickCreateBusy(input, button, true);
      }
      true;
    `);
    results.push(await capture(mainWindow, 'quick-create-busy-light.png'));
    await mainWindow.webContents.executeJavaScript(`
      setQuickCreateBusy(document.querySelector('#quick-input'), document.querySelector('#btn-quick-add'), false);
      resetQuickPreview();
      switchView('today');
      true;
    `);

    await mainWindow.webContents.executeJavaScript(`
      {
      document.body.classList.remove('dark');
      document.querySelector('#ai-chat').innerHTML = '';
      addMsg('user', '完成旧方案，然后把新方案改成紧急');
      const response = addMsg(
        'ai',
        '我理解你要连续完成 2 项操作：\\n1. 完成「旧方案」\\n2. 将「新方案」的优先级改为紧急\\n\\n确认后会整组执行；任一步失败都不会留下半成品。'
      );
      appendAssistantTurnControls(response, { type: 'confirm' });
      scrollChat();
      }
      true;
    `);
    results.push(await capture(mainWindow, 'assistant-plan.png'));

    mainWindow.setSize(900, 650);
    results.push(await capture(mainWindow, 'main-narrow.png'));

    await mainWindow.webContents.executeJavaScript(`
      (() => {
        document.body.classList.add('dark');
        switchView('board');
        const cards = Array.from(document.querySelectorAll('#board-cols .bc-card'));
        const source = cards[0];
        const sourceTask = tasks.find((task) => task.id === Number(source.dataset.id));
        const target = cards.find((card) => card.closest('.board-col').dataset.col !== sourceTask.status);
        boardDragState = { id: sourceTask.id, status: sourceTask.status };
        showBoardDropFeedback(target.closest('.board-col'), target, true);
        return true;
      })()
    `);
    results.push(await capture(mainWindow, 'board-cross-drop-dark-narrow.png'));
    await mainWindow.webContents.executeJavaScript(`
      boardDragState = null;
      clearBoardDropFeedback();
      switchView('cal');
      calCursor = new Date();
      calCursor.setDate(1);
      calSelected = calKey(new Date());
      calFocusDate = calSelected;
      renderCal(0, true);
      true;
    `);
    results.push(await capture(mainWindow, 'calendar-selected-dark-narrow.png'));
    await mainWindow.webContents.executeJavaScript(`document.body.classList.remove('dark'); true;`);

    const reportBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        switchView('stat');
        const actions = document.querySelector('.report-actions');
        const generate = document.querySelector('#btn-report-gen');
        const before = actions.getBoundingClientRect();
        window.__visualReportRelease = beginReportAction(generate, '生成中…');
        document.querySelector('.report-panel').scrollIntoView({ block: 'end' });
        const after = actions.getBoundingClientRect();
        return {
          busy: reportActionBusy && actions.getAttribute('aria-busy') === 'true',
          controlsLocked: Array.from(actions.querySelectorAll('button')).every((button) => button.disabled),
          duplicateBlocked: beginReportAction(generate, '生成中…') === null,
          label: generate.textContent.trim(),
          beforeHeight: before.height,
          afterHeight: after.height,
          beforeWidth: before.width,
          afterWidth: after.width
        };
      })()
    `);
    if (!reportBusyCheck.busy || !reportBusyCheck.controlsLocked || !reportBusyCheck.duplicateBlocked
      || reportBusyCheck.label !== '生成中…'
      || Math.abs(reportBusyCheck.beforeHeight - reportBusyCheck.afterHeight) > 0.5
      || Math.abs(reportBusyCheck.beforeWidth - reportBusyCheck.afterWidth) > 0.5) {
      throw new Error(`周报操作锁与稳定布局验证失败：${JSON.stringify(reportBusyCheck)}`);
    }
    results.push(await capture(mainWindow, 'report-busy-narrow.png'));
    const reportReleaseCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        window.__visualReportRelease();
        const actions = document.querySelector('.report-actions');
        return {
          busy: reportActionBusy || actions.getAttribute('aria-busy') === 'true',
          controlsReady: Array.from(actions.querySelectorAll('button')).every((button) => !button.disabled),
          label: document.querySelector('#btn-report-gen').textContent.trim()
        };
      })()
    `);
    if (reportReleaseCheck.busy || !reportReleaseCheck.controlsReady || reportReleaseCheck.label !== '生成周报') {
      throw new Error(`周报操作恢复验证失败：${JSON.stringify(reportReleaseCheck)}`);
    }
    interactionChecks.push({ id: 'report-lock-and-stable-layout', passed: true });

    const reportAgentStage = store.getSettings().aiStage;
    store.updateSettings({ aiStage: 'mock' });
    const reportAgentCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const stableWorkState = async () => {
          return { tasks: await window.api.tasks.getAll(), memos: await window.api.memos.getAll() };
        };
        switchView('stat');
        document.querySelector('#report-period-seg [data-period="daily"]').click();
        document.querySelector('#btn-report-gen').click();
        for (let attempt = 0; attempt < 30 && document.querySelector('#report-preview').classList.contains('hidden'); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        const before = JSON.stringify(await stableWorkState());
        const result = await window.api.ai.handle('生成今日日报', 'visual-report-agent');
        const revised = await window.api.ai.handle('语气正式，压缩成五条', 'visual-report-agent-revision');
        window.__visualReportResult = revised;
        const after = JSON.stringify(await stableWorkState());
        const chat = document.querySelector('#ai-chat');
        chat.innerHTML = '';
        // 这里绕过了 runAiTurn 直接铺对话，先补上真实轮次会做的前置：面板必须展开
        setAiPanelExpanded();
        addMsg('user', '语气正式，压缩成五条');
        const response = addMsg('ai', revised.message);
        response.appendChild(reportCard(revised));
        setAiContext('report');
        const sourceToggle = response.querySelector('.report-agent-actions button');
        sourceToggle.click();
        scrollChat(true);
        const cardRect = response.querySelector('.report-agent-card').getBoundingClientRect();
        const panelRect = document.querySelector('#ai-panel').getBoundingClientRect();
        return {
          dailyPreview: !document.querySelector('#report-preview').classList.contains('hidden')
            && document.querySelector('#report-preview').textContent.includes('日报（本地事实版）')
            && document.querySelector('#report-preview').textContent.includes('## 工作概览'),
          dailyControls: !document.querySelector('#report-day-seg').classList.contains('hidden'),
          agentReport: result && result.type === 'report' && result.reportPeriod === 'daily'
            && result.reportSessionActive && result.authoredBy === 'local',
          revisionStable: revised.sourceFingerprint === result.sourceFingerprint
            && revised.preferences.tone === '正式、专业' && revised.preferences.length === '五条以内',
          readOnly: before === after,
          cardReady: !!revised.markdown && !!response.querySelector('.report-evidence-band'),
          sourceOpen: !response.querySelector('.report-source-drawer').classList.contains('hidden')
            && response.querySelectorAll('.report-source-item').length > 0,
          contained: cardRect.left >= panelRect.left && cardRect.right <= panelRect.right + 0.5
        };
      })()
    `);
    store.updateSettings({ aiStage: reportAgentStage });
    if (!reportAgentCheck.dailyPreview || !reportAgentCheck.dailyControls || !reportAgentCheck.agentReport
      || !reportAgentCheck.revisionStable || !reportAgentCheck.readOnly || !reportAgentCheck.cardReady
      || !reportAgentCheck.sourceOpen || !reportAgentCheck.contained) {
      throw new Error(`日报与 Agent 报告验证失败：${JSON.stringify(reportAgentCheck)}`);
    }
    const visibleReportCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const revised = window.__visualReportResult;
        const chat = document.querySelector('#ai-chat');
        chat.innerHTML = '';
        addMsg('user', '语气正式，压缩成五条');
        const response = addMsg('ai', revised.message);
        response.appendChild(reportCard(revised));
        setAiContext('report');
        response.querySelector('.report-agent-actions button').click();
        chat.scrollTop = chat.scrollHeight;
        const preview = response.querySelector('.report-agent-preview');
        const drawer = response.querySelector('.report-source-drawer');
        return {
          preview: preview.textContent.includes('本地事实版'),
          drawer: !drawer.classList.contains('hidden'),
          evidence: response.querySelector('.report-evidence-band').textContent,
          visible: preview.getBoundingClientRect().height > 0 && drawer.getBoundingClientRect().height > 0
        };
      })()
    `);
    if (!visibleReportCheck.preview || !visibleReportCheck.drawer || !visibleReportCheck.visible
      || !visibleReportCheck.evidence.includes('事实')) {
      throw new Error(`报告卡片最终可见状态验证失败：${JSON.stringify(visibleReportCheck)}`);
    }
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        const card = document.querySelector('#ai-chat .report-agent-card');
        const toggle = card.querySelector('.report-agent-actions button');
        if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
        card.scrollIntoView({ block: 'start' });
        return true;
      })()
    `);
    results.push(await capture(mainWindow, 'report-daily-agent-light.png'));
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        const card = document.querySelector('#ai-chat .report-agent-card');
        const toggle = card.querySelector('.report-agent-actions button');
        toggle.click();
        card.querySelector('.report-source-drawer').scrollIntoView({ block: 'start' });
        return true;
      })()
    `);
    results.push(await capture(mainWindow, 'report-agent-sources-narrow.png'));
    await mainWindow.webContents.executeJavaScript(`document.querySelector('#report-period-seg [data-period="weekly"]').click(); true;`);
    interactionChecks.push({ id: 'report-agent-daily', passed: true });
    interactionChecks.push({ id: 'report-agent-evidence-source', passed: true });

    const filterEmptyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        switchView('tasks');
        currentFilter = 'proj:视觉回归空项目';
        currentSearch = '';
        renderTasks();
        const clear = document.querySelector('#empty-clear-filter');
        return {
          visible: !!clear && !clear.closest('.empty').classList.contains('hidden'),
          title: clear?.closest('.empty')?.querySelector('.empty-title')?.textContent || '',
          label: clear?.textContent.trim() || ''
        };
      })()
    `);
    if (!filterEmptyCheck.visible || !filterEmptyCheck.title.includes('视觉回归空项目') || filterEmptyCheck.label !== '清除筛选') {
      throw new Error(`筛选空结果恢复入口验证失败：${JSON.stringify(filterEmptyCheck)}`);
    }
    results.push(await capture(mainWindow, 'filter-empty-narrow.png'));
    const filterClearCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        document.querySelector('#empty-clear-filter').click();
        const all = document.querySelector('#smart-filters .fchip[data-filter="all"]');
        return {
          filter: currentFilter,
          emptyGone: !document.querySelector('#empty-clear-filter'),
          focusRestored: document.activeElement === all
        };
      })()
    `);
    if (filterClearCheck.filter !== 'all' || !filterClearCheck.emptyGone || !filterClearCheck.focusRestored) {
      throw new Error(`筛选清除与焦点恢复验证失败：${JSON.stringify(filterClearCheck)}`);
    }
    interactionChecks.push({ id: 'filter-empty-clear-and-focus', passed: true });

    const batchBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
      switchView('tasks');
      setBatchMode(true);
      selectedIds = new Set(visibleTaskIds.slice(0, 2));
      renderTasks();
      const bar = document.querySelector('#batch-bar');
      const beforeHeight = bar.getBoundingClientRect().height;
      setBatchBusy(true, '正在完成 2 项…', document.querySelector('#batch-done'));
      return {
        busy: batchBusy && bar.getAttribute('aria-busy') === 'true',
        controlsLocked: Array.from(bar.querySelectorAll('button, select')).every((control) => control.disabled),
        message: document.querySelector('#batch-count').textContent,
        beforeHeight,
        afterHeight: bar.getBoundingClientRect().height
      };
      })()
    `);
    if (!batchBusyCheck.busy || !batchBusyCheck.controlsLocked || batchBusyCheck.message !== '正在完成 2 项…'
      || Math.abs(batchBusyCheck.beforeHeight - batchBusyCheck.afterHeight) > 0.5) {
      throw new Error(`批量操作锁与稳定布局验证失败：${JSON.stringify(batchBusyCheck)}`);
    }
    results.push(await capture(mainWindow, 'batch-busy-narrow.png'));
    interactionChecks.push({ id: 'batch-lock-and-stable-layout', passed: true });
    const taskModalBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
      setBatchBusy(false, '', null);
      setBatchMode(false);
      openModal(tasks.find((task) => !task._deleted));
      const actions = document.querySelector('.task-modal .m-actions');
      const height = actions.getBoundingClientRect().height;
      setModalBusy(true);
      return {
        formBusy: document.querySelector('#task-form').getAttribute('aria-busy'),
        fieldsLocked: Array.from(document.querySelectorAll('#task-form input, #task-form select, #task-form textarea')).every((field) => field.disabled),
        closeLocked: document.querySelector('#m-close').disabled,
        saveLabel: document.querySelector('#m-save').textContent,
        height,
        busyHeight: actions.getBoundingClientRect().height
      };
      })()
    `);
    if (taskModalBusyCheck.formBusy !== 'true' || !taskModalBusyCheck.fieldsLocked
      || !taskModalBusyCheck.closeLocked || taskModalBusyCheck.saveLabel !== '保存中…'
      || Math.abs(taskModalBusyCheck.height - taskModalBusyCheck.busyHeight) > 0.5) {
      throw new Error(`任务弹窗写入锁验证失败：${JSON.stringify(taskModalBusyCheck)}`);
    }
    results.push(await capture(mainWindow, 'task-save-busy-narrow.png'));
    const taskDeleteConfirmCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        setModalBusy(false);
        document.querySelector('#m-delete').click();
        return {
          confirmOpen: !document.querySelector('#confirm-mask').classList.contains('hidden'),
          taskOpen: !document.querySelector('#modal-mask').classList.contains('hidden'),
          title: document.querySelector('#confirm-title').textContent,
          safeFocus: document.activeElement === document.querySelector('#confirm-cancel')
        };
      })()
    `);
    if (!taskDeleteConfirmCheck.confirmOpen || !taskDeleteConfirmCheck.taskOpen
      || taskDeleteConfirmCheck.title !== '确认删除' || !taskDeleteConfirmCheck.safeFocus) {
      throw new Error(`任务删除确认验证失败：${JSON.stringify(taskDeleteConfirmCheck)}`);
    }
    interactionChecks.push({ id: 'task-modal-lock-and-confirm', passed: true });
    results.push(await capture(mainWindow, 'task-delete-confirm-narrow.png'));
    await mainWindow.webContents.executeJavaScript(`document.querySelector('#confirm-cancel').click(); true;`);
    await wait(180);
    const memoActionBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        closeModal(false);
        switchView('memos');
        const actions = document.querySelector('.memo-actions');
        const control = document.querySelector('#memo-to-task');
        const height = actions.getBoundingClientRect().height;
        window.__visualMemoActionRelease = beginMemoAction(control, '创建中…');
        return {
          busy: memoActionBusy && control.getAttribute('aria-busy') === 'true',
          controlsLocked: Array.from(actions.querySelectorAll('button')).every((button) => button.disabled),
          label: control.textContent.trim(),
          status: document.querySelector('#memo-save-state').textContent,
          height
        };
      })()
    `);
    if (!memoActionBusyCheck.busy || !memoActionBusyCheck.controlsLocked
      || memoActionBusyCheck.label !== '创建中…' || memoActionBusyCheck.status !== '创建中…') {
      throw new Error(`备忘录工具栏写入锁验证失败：${JSON.stringify(memoActionBusyCheck)}`);
    }
    results.push(await capture(mainWindow, 'memo-save-busy-narrow.png'));
    const memoActionReleaseCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        window.__visualMemoActionRelease();
        const actions = document.querySelector('.memo-actions');
        return {
          busy: memoActionBusy,
          controlsReady: Array.from(actions.querySelectorAll('button')).every((button) => !button.disabled),
          label: document.querySelector('#memo-to-task').textContent.trim(),
          height: actions.getBoundingClientRect().height,
          focusRestored: document.activeElement === document.querySelector('#memo-to-task')
        };
      })()
    `);
    if (memoActionReleaseCheck.busy || !memoActionReleaseCheck.controlsReady
      || memoActionReleaseCheck.label !== '转为任务' || !memoActionReleaseCheck.focusRestored
      || memoActionReleaseCheck.height !== memoActionBusyCheck.height) {
      throw new Error(`备忘录工具栏写入恢复验证失败：${JSON.stringify(memoActionReleaseCheck)}`);
    }
    interactionChecks.push({ id: 'memo-toolbar-lock-and-focus', passed: true });
    const settingsBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        switchView('settings');
        focusSettingsSection('settings-general');
        const button = document.querySelector('#btn-backup-now');
        const controls = Array.from(document.querySelectorAll('[data-settings-scope="data"]'));
        const original = controls.map((control) => control.disabled);
        let finish;
        const pending = new Promise((resolve) => { finish = resolve; });
        window.__visualFinishSettingsScope = finish;
        window.__visualSettingsOriginal = original;
        button.focus();
        const focusedBeforeRun = document.activeElement === button;
        runSettingsAction(button, '备份中…', () => pending, '备份失败', 'data');
        return {
          focusedBeforeRun,
          busy: button.getAttribute('aria-busy') === 'true',
          label: button.textContent.trim(),
          locked: controls.length > 0 && controls.every((control) => control.disabled && control.dataset.scopeLocked === 'true')
        };
      })()
    `);
    if (!settingsBusyCheck.focusedBeforeRun || !settingsBusyCheck.busy || settingsBusyCheck.label !== '备份中…' || !settingsBusyCheck.locked) {
      throw new Error(`设置同组操作锁定验证失败：${JSON.stringify(settingsBusyCheck)}`);
    }
    results.push(await capture(mainWindow, 'settings-data-busy-narrow.png'));
    const settingsReleaseCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        window.__visualFinishSettingsScope(true);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const button = document.querySelector('#btn-backup-now');
        const controls = Array.from(document.querySelectorAll('[data-settings-scope="data"]'));
        const restored = controls.every((control, index) =>
          control.disabled === window.__visualSettingsOriginal[index] && !control.hasAttribute('data-scope-locked'));
        delete window.__visualFinishSettingsScope;
        delete window.__visualSettingsOriginal;
        return {
          restored,
          idle: button.getAttribute('aria-busy') === 'false' && button.textContent.includes('立即备份'),
          focused: document.activeElement === button,
          activeId: document.activeElement && document.activeElement.id
        };
      })()
    `);
    if (!settingsReleaseCheck.restored || !settingsReleaseCheck.idle || !settingsReleaseCheck.focused) {
      throw new Error(`设置操作完成恢复验证失败：${JSON.stringify(settingsReleaseCheck)}`);
    }
    interactionChecks.push({ id: 'settings-scope-and-focus', passed: true });

    const confirmRetryCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        confirmDialog('确定要从该文件恢复吗？当前数据会先自动备份。', async () => false, '恢复');
        document.querySelector('#confirm-ok').click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        const mask = document.querySelector('#confirm-mask');
        const error = document.querySelector('#confirm-error');
        return {
          open: !mask.classList.contains('hidden'),
          errorVisible: !error.classList.contains('hidden') && error.textContent.includes('尚未恢复'),
          retryable: !document.querySelector('#confirm-ok').disabled && !document.querySelector('#confirm-cancel').disabled
        };
      })()
    `);
    if (!confirmRetryCheck.open || !confirmRetryCheck.errorVisible || !confirmRetryCheck.retryable) {
      throw new Error('确认操作失败保留验证失败');
    }
    results.push(await capture(mainWindow, 'settings-confirm-retry-narrow.png'));
    await mainWindow.webContents.executeJavaScript("document.querySelector('#confirm-cancel').click(); true;");

    const settingsRedrawFocusCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        document.querySelector('#btn-reset').focus();
        confirmDialog('验证设置重绘后的焦点恢复。', async () => {
          renderSettings();
          return { focusTarget: '#btn-reset' };
        }, '确认');
        document.querySelector('#confirm-ok').click();
        await new Promise((resolve) => setTimeout(resolve, 220));
        return document.activeElement === document.querySelector('#btn-reset');
      })()
    `);
    if (!settingsRedrawFocusCheck) throw new Error('设置重绘后的焦点恢复验证失败');
    interactionChecks.push({ id: 'settings-confirm-retry-and-redraw-focus', passed: true });
    const toastRetryCheck = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const notice = toast('已删除「发布前核对」', 7000, [{
          label: '撤销',
          run: async () => { throw new Error('视觉回归模拟失败'); }
        }], 'ok');
        const action = notice.querySelector('.t-undo');
        action.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          connected: notice.isConnected,
          retry: action.textContent === '重试' && !action.disabled,
          inlineError: notice.classList.contains('t-action-error') && notice.querySelector('.t-action-status').textContent === '失败',
          focused: document.activeElement === action
        };
      })()
    `);
    if (!toastRetryCheck.connected || !toastRetryCheck.retry || !toastRetryCheck.inlineError || !toastRetryCheck.focused) {
      throw new Error(`通知动作失败恢复验证失败：${JSON.stringify(toastRetryCheck)}`);
    }
    results.push(await capture(mainWindow, 'notification-action-retry-narrow.png'));
    interactionChecks.push({ id: 'notification-action-retry', passed: true });
    await mainWindow.webContents.executeJavaScript("document.querySelectorAll('#toast-layer .toast').forEach((item) => dismissToast(item, true)); true;");
    await mainWindow.webContents.executeJavaScript("switchView('today'); true;");

    await mainWindow.webContents.executeJavaScript(`
      {
      document.querySelector('#ai-chat').innerHTML = '';
      addMsg('user', '结合今天的任务，你觉得我应该先做什么？');
      const pending = addMsg('ai', '正在结合当前工作状态组织回复…');
      pending.classList.add('pending');
      activeAiRequest = {
        id: 'visual-progress',
        pending,
        cancellable: true,
        cancelRequested: false,
        streamStarted: false
      };
      setAssistantMessageState(pending, 'working', '正在理解');
      setAiContext('working', '正在结合当前工作状态组织回复…');
      setAiBusy(true);
      scrollChat();
      }
      true;
    `);
    const assistantBusyCheck = await mainWindow.webContents.executeJavaScript(`
      (() => ({
        chatBusy: document.querySelector('#ai-chat').getAttribute('aria-busy') === 'true',
        sendIsStop: document.querySelector('#ai-send').classList.contains('is-stop')
          && document.querySelector('#ai-send').textContent.trim() === '停止',
        clearLocked: document.querySelector('#ai-clear').disabled,
        suggestionsLocked: Array.from(document.querySelectorAll('#ai-chips .chip')).every((chip) => chip.disabled),
        state: document.querySelector('#ai-chat .msg:last-child').dataset.requestState
      }))()
    `);
    if (!assistantBusyCheck.chatBusy || !assistantBusyCheck.sendIsStop || !assistantBusyCheck.clearLocked
      || !assistantBusyCheck.suggestionsLocked || assistantBusyCheck.state !== 'working') {
      throw new Error(`助手处理中状态验证失败：${JSON.stringify(assistantBusyCheck)}`);
    }
    interactionChecks.push({ id: 'assistant-busy-and-cancel', passed: true });
    results.push(await capture(mainWindow, 'assistant-progress-narrow.png'));

    await mainWindow.webContents.executeJavaScript(`
      updateAiRequestProgress({
        requestId: 'visual-progress',
        stage: 'streaming',
        message: '正在生成回复…',
        delta: '先完成今天最紧急且截止时间最近的任务，'
      });
      updateAiRequestProgress({
        requestId: 'visual-progress',
        stage: 'streaming',
        message: '正在生成回复…',
        delta: '再处理需要连续专注的工作。'
      });
      true;
    `);
    results.push(await capture(mainWindow, 'assistant-streaming-narrow.png'));
    await mainWindow.webContents.executeJavaScript(`
      activeAiRequest = null;
      setAiContext(null);
      setAiBusy(false);
      true;
    `);

    await mainWindow.webContents.executeJavaScript(`
      {
      const chat = document.querySelector('#ai-chat');
      chat.innerHTML = '';
      for (let index = 1; index <= 10; index += 1) {
        chat.appendChild(createMessage(index % 2 ? 'user' : 'ai', '用于验证阅读位置的历史消息 ' + index + '。这段内容保持足够长度，确保窄窗口出现滚动。'));
      }
      const pending = createMessage('ai', '最新回复仍在继续生成，但不会打断你查看上文。');
      chat.appendChild(pending);
      setAssistantMessageState(pending, 'streaming', '正在回复');
      chat.scrollTop = 0;
      aiChatFollowing = false;
      scrollChat(false);
      }
      true;
    `);
    results.push(await capture(mainWindow, 'assistant-reading-hold-narrow.png'));
    const readingHoldCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const chat = document.querySelector('#ai-chat');
        const jump = document.querySelector('#ai-jump-latest');
        const before = chat.scrollTop;
        const shown = !jump.classList.contains('hidden');
        jump.click();
        const latest = chat.querySelector('.msg:last-child');
        return {
          held: before === 0,
          shown,
          atEnd: chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 56,
          focusMoved: document.activeElement === latest
        };
      })()
    `);
    if (!readingHoldCheck.held || !readingHoldCheck.shown || !readingHoldCheck.atEnd || !readingHoldCheck.focusMoved) {
      throw new Error('助手阅读位置保持验证失败');
    }
    interactionChecks.push({ id: 'assistant-reading-position', passed: true });

    await mainWindow.webContents.executeJavaScript(`
      {
      document.querySelector('#ai-chat').innerHTML = '';
      addMsg('user', '把客户记录删了');
      addMsg('ai', '「客户记录」同时存在任务和备忘录。你想删除哪一种？');
      addMsg('user', '备忘录那条');
      const response = addMsg('ai', '模型服务短暂异常。刚才的补充需要模型结合上一轮理解，我没有执行任何操作。');
      appendAssistantTurnControls(response, {
        type: 'clarify',
        resumed: true,
        retryText: '备忘录那条'
      });
      scrollChat();
      }
      true;
    `);
    results.push(await capture(mainWindow, 'assistant-recovery-narrow.png'));

    await mainWindow.webContents.executeJavaScript(`
      {
      document.querySelector('#ai-chat').innerHTML = '';
      addMsg('user', '重新安排今天的优先级');
      const response = addMsg('ai', '模型暂时没有响应。请检查网络和模型配置后重试。');
      response.classList.add('error');
      setAssistantMessageState(response, 'error', '请求未完成');
      response.appendChild(retryAction(() => {}, '重新安排今天的优先级'));
      setAiContext('error');
      scrollChat(true);
      }
      true;
    `);
    results.push(await capture(mainWindow, 'assistant-edit-retry-narrow.png'));
    const editRetryCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const edit = document.querySelector('#ai-chat .turn-action.quiet');
        const input = document.querySelector('#ai-input');
        edit.click();
        const result = { restored: input.value === '重新安排今天的优先级', focused: document.activeElement === input };
        input.value = '';
        resizeAiInput();
        return result;
      })()
    `);
    if (!editRetryCheck.restored || !editRetryCheck.focused) throw new Error('助手失败输入恢复验证失败');
    interactionChecks.push({ id: 'assistant-edit-retry', passed: true });

    await mainWindow.webContents.executeJavaScript(`
      {
      document.querySelector('#ai-chat').innerHTML = '';
      addMsg('user', '今天新建核对发布清单，预计 35 分钟');
      const response = addMsg('ai', '已创建「核对发布清单」，截止今天 18:00。\\n它已加入今天的安排；今天共有 3 项到期。');
      response.appendChild(opCard({
        type: 'create',
        task: { id: 9001, title: '核对发布清单' },
        undoable: true,
        undo: { action: 'removeCreatedAdditions', tasks: [], memos: [] }
      }));
      setAiContext(null);
      scrollChat();
      }
      true;
    `);
    results.push(await capture(mainWindow, 'assistant-created-narrow.png'));

    await mainWindow.webContents.executeJavaScript("document.body.classList.add('dark')");
    results.push(await capture(mainWindow, 'main-dark.png'));

    const reminderTask = store.getAllTasks().find((task) => task.status !== 'done' && task.status !== 'archived');
    if (!reminderTask) throw new Error('视觉回归缺少桌宠提醒任务');

    const workArea = screen.getPrimaryDisplay().workArea;
    const freePosition = {
      x: workArea.x + Math.floor(workArea.width * 0.32),
      y: workArea.y + Math.floor(workArea.height * 0.38)
    };
    await petWindow.webContents.executeJavaScript(`
      document.body.classList.remove('dark');
      window.api.pet.setPosition(${JSON.stringify(freePosition)}).then(() => window.api.pet.commitPosition());
    `);
    await wait(120);
    const petBoundsBeforePanel = petWindow.getBounds();
    await petWindow.webContents.executeJavaScript("window.api.pet.showPanel('overview')");
    await wait(240);
    const petBoundsAfterPanel = petWindow.getBounds();
    const panelBounds = petPanelWindow.getBounds();
    const savedPetPosition = store.getSettings().petPosition;
    const panelInsideWorkArea = panelBounds.x >= workArea.x && panelBounds.y >= workArea.y
      && panelBounds.x + panelBounds.width <= workArea.x + workArea.width
      && panelBounds.y + panelBounds.height <= workArea.y + workArea.height;
    if (petBoundsBeforePanel.x !== petBoundsAfterPanel.x || petBoundsBeforePanel.y !== petBoundsAfterPanel.y
      || savedPetPosition.x !== petBoundsAfterPanel.x || savedPetPosition.y !== petBoundsAfterPanel.y
      || savedPetPosition.version !== 2 || !panelInsideWorkArea) {
      throw new Error(`桌宠自由位置或小窗锚定验证失败：${JSON.stringify({ petBoundsBeforePanel, petBoundsAfterPanel, panelBounds, savedPetPosition, panelInsideWorkArea })}`);
    }
    interactionChecks.push({ id: 'pet-free-position-and-panel-anchor', passed: true });
    results.push(await capture(petWindow, 'pet-free-position.png'));

    await petPanelWindow.webContents.executeJavaScript(`
      document.body.classList.remove('dark');
      pendingReminder = ${JSON.stringify({ id: reminderTask.id, title: reminderTask.title, due: reminderTask.due || '' })};
      refreshOverview();
    `);
    await wait(120);
    results.push(await capture(petPanelWindow, 'pet-panel-overview.png'));
    await petPanelWindow.webContents.executeJavaScript("document.querySelector('#overview-next').click(); true;");
    await new Promise((resolve) => setTimeout(resolve, 260));
    const petReminderOpenCheck = await mainWindow.webContents.executeJavaScript(`
      ({
        open: !document.querySelector('#modal-mask').classList.contains('hidden'),
        taskId: editingTask && editingTask.id,
        title: document.querySelector('#m-title').value
      })
    `);
    if (!petReminderOpenCheck.open || petReminderOpenCheck.taskId !== reminderTask.id || petReminderOpenCheck.title !== reminderTask.title) {
      throw new Error(`桌宠提醒打开任务验证失败：${JSON.stringify(petReminderOpenCheck)}`);
    }
    interactionChecks.push({ id: 'pet-reminder-opens-task', passed: true });
    await mainWindow.webContents.executeJavaScript("closeModal(false); true;");
    await petWindow.webContents.executeJavaScript("window.api.pet.showPanel('overview')");
    await wait(120);

    const petNavigationBusyCheck = await petPanelWindow.webContents.executeJavaScript(`
      (() => {
        const action = document.querySelector('[data-open-view="board"]');
        setOverviewBusy(true, action);
        return {
          busy: overviewBusy,
          controlsLocked: Array.from(document.querySelectorAll('[data-open-view]')).every((button) => button.disabled),
          label: action.textContent.trim(),
          ariaBusy: action.getAttribute('aria-busy')
        };
      })()
    `);
    if (!petNavigationBusyCheck.busy || !petNavigationBusyCheck.controlsLocked
      || petNavigationBusyCheck.label !== '看板' || petNavigationBusyCheck.ariaBusy !== 'true') {
      throw new Error(`桌宠视图打开反馈验证失败：${JSON.stringify(petNavigationBusyCheck)}`);
    }
    results.push(await capture(petPanelWindow, 'pet-panel-navigation-busy.png'));
    const petNavigationErrorCheck = await petPanelWindow.webContents.executeJavaScript(`
      (() => {
        const action = document.querySelector('[data-open-view="board"]');
        setOverviewBusy(false, action);
        const feedback = document.querySelector('#overview-feedback');
        feedback.textContent = '暂时无法打开工作台，请重试。';
        feedback.classList.remove('hidden');
        action.focus();
        return {
          visible: !feedback.classList.contains('hidden'),
          status: feedback.textContent,
          controlsReady: Array.from(document.querySelectorAll('[data-open-view]')).every((button) => !button.disabled),
          focusRestored: document.activeElement === action
        };
      })()
    `);
    if (!petNavigationErrorCheck.visible || petNavigationErrorCheck.status !== '暂时无法打开工作台，请重试。'
      || !petNavigationErrorCheck.controlsReady || !petNavigationErrorCheck.focusRestored) {
      throw new Error(`桌宠视图打开失败恢复验证失败：${JSON.stringify(petNavigationErrorCheck)}`);
    }
    results.push(await capture(petPanelWindow, 'pet-panel-navigation-error.png'));
    interactionChecks.push({ id: 'pet-navigation-lock-error-and-focus', passed: true });

    const petChatCheck = await petPanelWindow.webContents.executeJavaScript(`
      (async () => {
        selectPage('chat');
        await sendPrompt('今天有什么任务');
        return {
          userMessages: document.querySelectorAll('.chat-message.user').length,
          assistantMessages: document.querySelectorAll('.chat-message.ai').length,
          inputEnabled: !document.querySelector('#pet-chat-input').disabled,
          sendLabel: document.querySelector('#pet-chat-send').textContent,
          active: !!activeRequest
        };
      })()
    `);
    if (petChatCheck.userMessages < 1 || petChatCheck.assistantMessages < 1 || !petChatCheck.inputEnabled
      || petChatCheck.sendLabel !== '发送' || petChatCheck.active) {
      throw new Error(`桌宠内联 Agent 对话验证失败：${JSON.stringify(petChatCheck)}`);
    }
    results.push(await capture(petPanelWindow, 'pet-panel-chat.png'));
    interactionChecks.push({ id: 'pet-inline-agent-chat', passed: true });

    await petPanelWindow.webContents.executeJavaScript("document.body.classList.add('dark'); true;");
    results.push(await capture(petPanelWindow, 'pet-panel-chat-dark.png'));
    await petPanelWindow.webContents.executeJavaScript("document.body.classList.remove('dark'); true;");

    await Promise.all([emulateReducedMotion(mainWindow), emulateReducedMotion(petWindow), emulateReducedMotion(petPanelWindow)]);
    const reducedMainCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        switchView('tasks');
        const activeView = document.querySelector('#view-tasks');
        activeView.classList.add('view-enter');
        const notice = toast('低动态模式反馈', 4000, null, 'ok');
        const mask = document.querySelector('#confirm-mask');
        let modalHiddenSynchronously = false;
        showModalMask(mask);
        hideModalMask(mask, () => { modalHiddenSynchronously = true; });
        return {
          matches: prefersReducedMotion(),
          viewAnimation: getComputedStyle(activeView).animationName,
          toastAnimation: getComputedStyle(notice).animationName,
          modalHiddenSynchronously,
          modalHidden: mask.classList.contains('hidden')
        };
      })()
    `);
    if (!reducedMainCheck.matches || reducedMainCheck.viewAnimation !== 'none' || reducedMainCheck.toastAnimation !== 'none'
      || !reducedMainCheck.modalHiddenSynchronously || !reducedMainCheck.modalHidden) {
      throw new Error(`主窗口低动态模式验证失败：${JSON.stringify(reducedMainCheck)}`);
    }
    results.push(await capture(mainWindow, 'main-reduced-motion-narrow.png'));
    interactionChecks.push({ id: 'reduced-motion-main', passed: true });

    const reducedPetCheck = await petWindow.webContents.executeJavaScript(`
      (() => {
        return {
          matches: prefersReducedMotion(),
          spriteAnimation: getComputedStyle(petSprite).animationName
        };
      })()
    `);
    const reducedPetPanelCheck = await petPanelWindow.webContents.executeJavaScript(`({
      matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      panelAnimation: getComputedStyle(document.querySelector('#pet-panel')).animationName
    })`);
    if (!reducedPetCheck.matches || reducedPetCheck.spriteAnimation !== 'none'
      || !reducedPetPanelCheck.matches || reducedPetPanelCheck.panelAnimation !== 'none') {
      throw new Error(`桌宠低动态模式验证失败：${JSON.stringify(reducedPetCheck)}`);
    }
    results.push(await capture(petWindow, 'pet-reduced-motion.png'));
    results.push(await capture(petPanelWindow, 'pet-panel-reduced-motion.png'));
    interactionChecks.push({ id: 'reduced-motion-pet', passed: true });

    const passedCheckIds = new Set(interactionChecks.filter((check) => check.passed).map((check) => check.id));
    const uxCoverage = UX_ACCEPTANCE_REQUIREMENTS.map((requirement) => ({
      area: requirement.area,
      passed: requirement.checks.every((check) => passedCheckIds.has(check)),
      checks: requirement.checks
    }));
    const uncovered = uxCoverage.filter((requirement) => !requirement.passed);
    if (uncovered.length) throw new Error(`UX 验收矩阵存在缺口：${JSON.stringify(uncovered)}`);

    process.stdout.write(`${JSON.stringify({ outputDir, uxCoverage, interactionChecks, results }, null, 2)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  }
});
