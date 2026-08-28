'use strict';

/**
 * 主进程入口
 * 职责：窗口管理、系统托盘、系统通知、全局快捷键、提醒引擎、IPC
 */

const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, nativeImage, screen, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('工作台助手');

const isolatedDataArg = process.argv.find((arg) => arg.startsWith('--work-helper-data-dir='));
if (isolatedDataArg) {
  const isolatedRoot = path.resolve(isolatedDataArg.slice('--work-helper-data-dir='.length));
  fs.mkdirSync(isolatedRoot, { recursive: true });
  app.setPath('userData', isolatedRoot);
  process.env.WORK_HELPER_DATA_DIR = path.join(isolatedRoot, 'data');
} else {
  // 显示名称可以本地化，但生产数据目录必须保持稳定，避免改名后读取到一套空数据。
  app.setPath('userData', path.join(app.getPath('appData'), 'work-helper'));
}

const store = require('./main/store');
const ai = require('./main/ai');
const { RequestCoordinator } = require('./main/agent/request-coordinator');

const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon-256.png');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'app-icon-32.png');

/* ---------- 全局状态 ---------- */
let mainWindow = null;
let petWindow = null;
let petPanelWindow = null;
let taskAgentWindow = null;
let tray = null;
let isQuitting = false;
let reminderTimer = null;
let remindedTaskIds = new Set();

const isDev = process.argv.includes('--dev');
const PET_WINDOW_SIZE = Object.freeze({ width: 160, height: 268 });
const PET_PANEL_SIZE = Object.freeze({ width: 360, height: 500 });
const TASK_AGENT_WINDOW_SIZE = Object.freeze({ width: 400, height: 620 });
const PET_WINDOW_MARGIN = 8;

/* ---------- 窗口创建 ---------- */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '工作台助手',
    icon: APP_ICON_PATH,
    frame: false, // 无原生标题栏，使用自定义标题栏（避免双份窗口管理按钮）
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('context-menu', (event, params) => {
    const template = params.isEditable
      ? [
          { label: '撤销', role: 'undo' },
          { type: 'separator' },
          { label: '剪切', role: 'cut' },
          { label: '复制', role: 'copy' },
          { label: '粘贴', role: 'paste' },
          { type: 'separator' },
          { label: '全选', role: 'selectAll' }
        ]
      : params.selectionText
        ? [{ label: '复制', role: 'copy' }, { label: '全选', role: 'selectAll' }]
        : [];
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    // 关闭按钮 = 最小化到托盘（除非真正退出）
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // 最大化状态同步到渲染进程（更新标题栏按钮图标）
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (taskAgentWindow && !taskAgentWindow.isDestroyed()) taskAgentWindow.close();
  });
}

function createPetWindow() {
  let { workArea } = screen.getPrimaryDisplay();
  const winW = PET_WINDOW_SIZE.width;
  const winH = PET_WINDOW_SIZE.height;
  const saved = store.getSettings().petPosition;
  // 默认放在右下区域，但之后不再强制吸附边角。
  let x = workArea.x + workArea.width - winW - 24;
  let y = workArea.y + workArea.height - winH - 24;
  // 旧版窗口高 468px；迁移时保留桌宠本体在屏幕上的纵向位置。
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    workArea = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y }).workArea;
    const migratedY = saved.version === 2 ? saved.y : saved.y + 468 - winH;
    const cx = Math.max(workArea.x, Math.min(workArea.x + workArea.width - winW, saved.x));
    const cy = Math.max(workArea.y, Math.min(workArea.y + workArea.height - winH, migratedY));
    x = cx;
    y = cy;
  }

  petWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    title: '桌宠',
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  petWindow.loadFile(path.join(__dirname, 'renderer', 'pet', 'pet.html'));
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  // 根据设置决定是否显示桌宠
  if (store.getSettings().petEnabled === false) {
    petWindow.hide();
  }

  petWindow.on('closed', () => {
    if (petPanelWindow && !petPanelWindow.isDestroyed()) petPanelWindow.close();
    petWindow = null;
  });
}

function placePetPanel() {
  if (!petWindow || petWindow.isDestroyed() || !petPanelWindow || petPanelWindow.isDestroyed()) return;
  const petBounds = petWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: petBounds.x + Math.floor(petBounds.width / 2),
    y: petBounds.y + Math.floor(petBounds.height / 2)
  });
  const area = display.workArea;
  const gap = 10;
  const rightX = petBounds.x + petBounds.width + gap;
  const leftX = petBounds.x - PET_PANEL_SIZE.width - gap;
  const roomRight = area.x + area.width - rightX;
  const roomLeft = petBounds.x - gap - area.x;
  const preferredX = roomRight >= PET_PANEL_SIZE.width || roomRight >= roomLeft ? rightX : leftX;
  const x = Math.max(area.x + PET_WINDOW_MARGIN, Math.min(
    area.x + area.width - PET_PANEL_SIZE.width - PET_WINDOW_MARGIN,
    preferredX
  ));
  const centeredY = petBounds.y + Math.floor((petBounds.height - PET_PANEL_SIZE.height) / 2);
  const y = Math.max(area.y + PET_WINDOW_MARGIN, Math.min(
    area.y + area.height - PET_PANEL_SIZE.height - PET_WINDOW_MARGIN,
    centeredY
  ));
  petPanelWindow.setPosition(Math.round(x), Math.round(y), false);
}

function createPetPanelWindow() {
  petPanelWindow = new BrowserWindow({
    width: PET_PANEL_SIZE.width,
    height: PET_PANEL_SIZE.height,
    show: false,
    title: '桌宠助手',
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  petPanelWindow.loadFile(path.join(__dirname, 'renderer', 'pet', 'panel.html'));
  petPanelWindow.setAlwaysOnTop(true, 'floating');
  petPanelWindow.on('closed', () => {
    petPanelWindow = null;
  });
}

function hidePetPanel() {
  if (petPanelWindow && !petPanelWindow.isDestroyed()) petPanelWindow.hide();
}

/* ---------- 任务 Agent 独立对话小窗 ---------- */
function createTaskAgentWindow() {
  taskAgentWindow = new BrowserWindow({
    width: TASK_AGENT_WINDOW_SIZE.width,
    height: TASK_AGENT_WINDOW_SIZE.height,
    minWidth: 340,
    minHeight: 420,
    show: false,
    title: '任务对话',
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#F7F6F2',
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  taskAgentWindow.loadFile(path.join(__dirname, 'renderer', 'task-agent', 'window.html'));
  taskAgentWindow.setAlwaysOnTop(true, 'floating');
  taskAgentWindow.on('closed', () => {
    taskAgentWindow = null;
  });
}

function positionTaskAgentWindow() {
  if (!taskAgentWindow || taskAgentWindow.isDestroyed()) return;
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : screen.getPrimaryDisplay().workArea;
  const [width, height] = taskAgentWindow.getSize();
  const x = Math.round(bounds.x + bounds.width - width - 24);
  const y = Math.round(bounds.y + 92);
  taskAgentWindow.setPosition(Math.max(0, x), Math.max(0, y), false);
}

function openTaskAgentWindow(input) {
  const payload = input && typeof input === 'object' ? input : {};
  if (!taskAgentWindow || taskAgentWindow.isDestroyed()) createTaskAgentWindow();
  const target = taskAgentWindow;
  const session = {
    taskId: Number(payload.taskId) || null,
    title: String(payload.title || '').slice(0, 200),
    draft: String(payload.draft || '').slice(0, 1000),
    workLogId: String(payload.workLogId || '').slice(0, 100),
    workLogKind: String(payload.workLogKind || '').slice(0, 20)
  };
  const send = () => {
    if (target.isDestroyed()) return;
    positionTaskAgentWindow();
    if (!target.isVisible()) target.show();
    target.focus();
    target.webContents.send('task-agent:session', session);
  };
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send);
  else send();
  return { ok: true };
}

function clampPetPosition(pos) {
  const point = {
    x: Number.isFinite(pos?.x) ? Math.round(pos.x) : 0,
    y: Number.isFinite(pos?.y) ? Math.round(pos.y) : 0
  };
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  return {
    x: Math.max(area.x, Math.min(area.x + area.width - PET_WINDOW_SIZE.width, point.x)),
    y: Math.max(area.y, Math.min(area.y + area.height - PET_WINDOW_SIZE.height, point.y))
  };
}

function ensurePetVisible() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  const next = clampPetPosition({ x, y });
  petWindow.setPosition(next.x, next.y, false);
  store.updateSettings({ petPosition: { ...next, version: 2 } });
  if (petPanelWindow?.isVisible()) placePetPanel();
}

/* ---------- 托盘 ---------- */
function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (icon.isEmpty()) throw new Error(`托盘图标无法读取：${TRAY_ICON_PATH}`);
  tray = new Tray(icon);
  tray.setToolTip('工作台助手');

  const menu = Menu.buildFromTemplate([
    { label: '打开工作台', click: () => showMainWindow() },
    { label: '新建任务', click: () => sendToMain('app:new-task') },
    { type: 'separator' },
    { label: '今日视图', click: () => sendToMain('app:switch-view', 'today') },
    { label: '统计', click: () => sendToMain('app:switch-view', 'stat') },
    { label: '回收站', click: () => sendToMain('app:switch-view', 'trash') },
    { type: 'separator' },
    { label: '静音提醒', type: 'checkbox', checked: false, click: (item) => { store.updateSettings({ notify: !item.checked }); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    mainWindow.once('ready-to-show', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
    });
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function sendWhenReady(target, channel, payload) {
  if (!target || target.isDestroyed()) return;
  const send = () => {
    if (!target.isDestroyed()) target.webContents.send(channel, payload);
  };
  if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', send);
  else send();
}

function sendToMain(channel, payload) {
  showMainWindow();
  sendWhenReady(mainWindow, channel, payload);
}

/* ---------- 全局快捷键 ---------- */
function registerShortcuts() {
  const s = store.getSettings().shortcuts || {};
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(s.ai || 'CommandOrControl+J', () => {
      sendToMain('app:focus-ai');
    });
    globalShortcut.register(s.newTask || 'CommandOrControl+N', () => {
      sendToMain('app:new-task');
    });
    globalShortcut.register(s.today || 'CommandOrControl+1', () => {
      sendToMain('app:switch-view', 'today');
    });
    globalShortcut.register(s.stat || 'CommandOrControl+5', () => {
      sendToMain('app:switch-view', 'stat');
    });
  } catch (e) {
    console.error('[main] 快捷键注册失败:', e.message);
  }
}

/* ---------- 开机自启 ---------- */
function applyAutoStart() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!store.getSettings().autoStart,
      openAsHidden: true
    });
  } catch (e) {
    console.error('[main] 设置开机自启失败:', e.message);
  }
}

/* ---------- 提醒引擎 ---------- */
function checkReminders() {
  if (!store.getSettings().notify) return;
  const now = new Date();
  const tasks = store.getAllTasks();
  tasks.forEach((t) => {
    if (!t.due || t.status === 'done' || t.status === 'archived') return;
    const dueDate = new Date(t.due.replace(' ', 'T') + ':00');
    const remindMs = (t.remind || 0) * 60000;
    const triggerAt = dueDate.getTime() - remindMs;
    // 若提醒时间已过（任务被顺延/修改后 due 在未来），清除已提醒标记，允许再次提醒
    if (triggerAt > now.getTime()) {
      remindedTaskIds.delete(t.id);
      return;
    }
    if (remindedTaskIds.has(t.id)) return;
    remindedTaskIds.add(t.id);
    // 通知主窗口（桌宠气泡）
    sendWhenReady(mainWindow, 'app:reminder', { id: t.id, title: t.title, due: t.due });
    sendWhenReady(petWindow, 'pet:remind', { id: t.id, title: t.title, due: t.due });
    sendWhenReady(petPanelWindow, 'pet:remind', { id: t.id, title: t.title, due: t.due });
    // 系统通知
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '任务提醒',
        body: `${t.title}${t.due ? ' · ' + t.due : ''}`,
        icon: APP_ICON_PATH,
        silent: false
      });
      n.on('click', () => sendToMain('app:open-task', { id: t.id }));
      n.show();
    }
  });
}

function startReminderEngine() {
  checkReminders();
  reminderTimer = setInterval(checkReminders, 60000); // 每分钟轮询
}

function persistAiExchange(userText, result) {
  const ts = Date.now();
  try {
    store.appendChatEntries([
      { role: 'user', text: userText, ts },
      { role: 'ai', text: result.message, ts: ts + 1 }
    ]);
    return result;
  } catch (error) {
    console.error('[assistant] chat persistence failed:', error.message);
    return Object.assign({}, result, {
      chatPersisted: false,
      historyNotice: '操作结果已返回，但本轮对话未能写入历史记录。不会自动重试操作。'
    });
  }
}

/* 任务对话小窗：会话自持记忆，不读写全局侧边栏对话记录 */
function isTaskAgentSender(event) {
  return !!(taskAgentWindow && !taskAgentWindow.isDestroyed() && event && event.sender &&
    event.sender.id === taskAgentWindow.webContents.id);
}

function sanitizeSessionHistory(input) {
  if (!Array.isArray(input)) return null;
  return input
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string' && entry.content.trim())
    .map((entry) => ({ role: entry.role, content: entry.content.trim().slice(0, 800) }))
    .slice(-12);
}

function broadcastWorkflowState() {
  const state = store.getWorkflowState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workflow:changed', state);
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('workflow:changed', state);
  if (petPanelWindow && !petPanelWindow.isDestroyed()) petPanelWindow.webContents.send('workflow:changed', state);
  return state;
}

function runWorkflowMutation(operation) {
  const result = operation();
  broadcastWorkflowState();
  return result;
}

const AGENT_WORKFLOW_RESULT_TYPES = new Set([
  // 保留核心任务工作流类型序列，子任务与拆分也需要同步给桌宠。
  // 'complete', 'start', 'delete', 'archive', 'update', 'postpone', 'restore'
  'complete', 'start', 'delete', 'archive', 'update', 'child', 'split', 'postpone', 'restore', 'plan',
  'daily_plan', 'daily_replan', 'focus_start', 'focus_pause', 'focus_resume',
  'focus_interrupt', 'focus_finish', 'daily_review'
]);

function broadcastAgentWorkflowResult(result) {
  if (result && AGENT_WORKFLOW_RESULT_TYPES.has(result.type)) broadcastWorkflowState();
  return result;
}

const aiRequestCoordinator = new RequestCoordinator({ ttlMs: 5 * 60 * 1000, maxCompleted: 100 });
const taskActionPreviews = new Map();
const TASK_ACTION_PREVIEW_TTL = 10 * 60 * 1000;

function taskActionPreviewKey(senderId, previewId) {
  return `${senderId}:${previewId}`;
}

function rememberTaskActionPreview(senderId, preview) {
  const now = Date.now();
  for (const [key, item] of taskActionPreviews) {
    if (now - item.createdAt > TASK_ACTION_PREVIEW_TTL) taskActionPreviews.delete(key);
  }
  const previewId = `task-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  taskActionPreviews.set(taskActionPreviewKey(senderId, previewId), Object.assign({}, preview.action, { createdAt: Date.now(), previewId, applying: false }));
  return previewId;
}

function sendAiProgress(sender, requestId, progress) {
  if (!sender || sender.isDestroyed()) return;
  sender.send('ai:progress', Object.assign({ requestId }, progress));
}

/* ---------- IPC ---------- */
function registerIpc() {
  // 任务
  ipcMain.handle('tasks:getAll', () => store.getAllTasks());
  ipcMain.handle('tasks:create', (e, data) => runWorkflowMutation(() => store.createTask(data)));
  ipcMain.handle('tasks:update', (e, id, patch) => runWorkflowMutation(() => store.updateTask(id, patch)));
  ipcMain.handle('tasks:delete', (e, id) => runWorkflowMutation(() => store.deleteTask(id)));
  ipcMain.handle('tasks:restore', (e, id) => runWorkflowMutation(() => store.restoreTask(id)));
  ipcMain.handle('tasks:archive', (e, id) => runWorkflowMutation(() => store.archiveTask(id)));
  ipcMain.handle('tasks:unarchive', (e, id) => runWorkflowMutation(() => store.unarchiveTask(id)));
  ipcMain.handle('tasks:reset', () => runWorkflowMutation(() => store.resetTasks()));
  ipcMain.handle('tasks:clearAll', () => runWorkflowMutation(() => store.clearAllTasks()));
  ipcMain.handle('tasks:import', (e, list) => runWorkflowMutation(() => store.importTasks(list)));
  ipcMain.handle('tasks:complete', (e, id) => runWorkflowMutation(() => store.completeTask(id)));
  ipcMain.handle('tasks:saveAndComplete', (e, id, data) => runWorkflowMutation(() => store.saveAndCompleteTask(id, data)));
  ipcMain.handle('tasks:addWorkLog', (e, taskId, input) => store.addTaskWorkLog(taskId, input));
  ipcMain.handle('tasks:updateWorkLog', (e, taskId, logId, patch) => store.updateTaskWorkLog(taskId, logId, patch));
  ipcMain.handle('tasks:removeWorkLog', (e, taskId, logId) => store.removeTaskWorkLog(taskId, logId));
  ipcMain.handle('tasks:postpone', (e, id, days) => runWorkflowMutation(() => store.postponeTask(id, days)));
  ipcMain.handle('tasks:reorder', (e, ids) => runWorkflowMutation(() => store.reorderTasks(ids)));
  ipcMain.handle('tasks:batchUpdate', (e, ids, patch) => runWorkflowMutation(() => store.batchUpdate(ids, patch)));
  ipcMain.handle('tasks:batchComplete', (e, ids) => runWorkflowMutation(() => store.batchComplete(ids)));
  ipcMain.handle('tasks:batchDelete', (e, ids) => runWorkflowMutation(() => store.batchDelete(ids)));
  ipcMain.handle('tasks:getDeleted', () => store.getDeletedTasks());
  ipcMain.handle('tasks:purge', (e, id) => store.purgeTask(id));
  ipcMain.handle('tasks:emptyTrash', () => store.emptyTrash());

  // 每日计划与专注会话
  ipcMain.handle('workflow:get', () => store.getWorkflowState());
  ipcMain.handle('workflow:getCopilot', (e, input) => store.getDailyCopilot(input && input.now));
  ipcMain.handle('workflow:updateCopilot', (e, input) => runWorkflowMutation(() => store.updateDailyCopilot(input)));
  ipcMain.handle('workflow:updatePreferences', (e, patch) => runWorkflowMutation(() => store.updateWorkPreferences(patch)));
  ipcMain.handle('workflow:previewPlan', (e, options) => store.previewDailyPlan(options));
  ipcMain.handle('workflow:previewSmartPlan', async (e, input) => {
    const payload = input && typeof input === 'object' ? input : { text: input };
    const requestId = `workflow-${String(payload.requestId || Date.now()).slice(0, 70)}`;
    const request = aiRequestCoordinator.begin(e.sender.id, requestId);
    if (request.status === 'completed') return request.result;
    if (request.status === 'active') return { type: 'error', duplicate: true, message: '计划仍在生成中，请稍候。' };
    const { key, controller } = request;
    try {
      const result = await ai.previewDailyPlan(String(payload.text || ''), {
        signal: controller.signal,
        timeout: 12000,
        onProgress: (progress) => sendAiProgress(e.sender, requestId, progress)
      });
      return aiRequestCoordinator.complete(key, result);
    } catch (error) {
      if (controller.signal.aborted || error.code === 'AI_REQUEST_CANCELLED') {
        return aiRequestCoordinator.complete(key, {
          type: 'error',
          cancelled: true,
          message: '智能安排已停止，计划尚未保存。'
        });
      }
      console.error('[workflow] 智能安排失败:', error.message);
      return aiRequestCoordinator.complete(key, {
        type: 'error',
        message: '智能安排暂时未完成，请重试；计划尚未保存。'
      });
    } finally {
      aiRequestCoordinator.release(key);
    }
  });
  ipcMain.handle('workflow:applyPlan', (e, plan) => runWorkflowMutation(() => store.applyDailyPlan(plan)));
  ipcMain.handle('workflow:updatePlan', (e, date, input) => runWorkflowMutation(() => store.updateDailyPlan(date, input)));
  ipcMain.handle('workflow:restorePlan', (e, input) => runWorkflowMutation(() => store.restoreDailyPlan(input)));
  ipcMain.handle('workflow:startFocus', (e, taskId, options) => runWorkflowMutation(() => store.startFocus(taskId, options)));
  ipcMain.handle('workflow:pauseFocus', (e, input) => runWorkflowMutation(() => store.pauseFocus(input)));
  ipcMain.handle('workflow:resumeFocus', (e, input) => runWorkflowMutation(() => store.resumeFocus(input)));
  ipcMain.handle('workflow:interrupt', (e, reason, input) => runWorkflowMutation(() => store.recordInterruption(reason, input)));
  ipcMain.handle('workflow:finishFocus', (e, input) => runWorkflowMutation(() => store.finishFocus(input)));
  ipcMain.handle('workflow:getReview', (e, date) => store.getDailyReview(date));
  ipcMain.handle('workflow:saveReview', (e, date, input) => runWorkflowMutation(() => store.saveDailyReview(date, input)));

  // 备忘录
  ipcMain.handle('memos:getAll', () => store.getAllMemos());
  ipcMain.handle('memos:create', (e, data) => store.createMemo(data));
  ipcMain.handle('memos:update', (e, id, patch) => store.updateMemo(id, patch));
  ipcMain.handle('memos:delete', (e, id) => store.deleteMemo(id));
  ipcMain.handle('memos:getDeleted', () => store.getDeletedMemos());
  ipcMain.handle('memos:restore', (e, id) => store.restoreMemo(id));
  ipcMain.handle('memos:purge', (e, id) => store.purgeMemo(id));
  ipcMain.handle('memos:emptyTrash', () => store.emptyMemoTrash());
  ipcMain.handle('memos:import', (e, list) => store.importMemos(list));

  // 设置
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (e, patch) => {
    const s = store.updateSettings(patch);
    if (patch.shortcuts) registerShortcuts();
    if (patch.autoStart !== undefined) applyAutoStart();
    if (patch.theme !== undefined && petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:theme', s.theme);
    }
    if (patch.theme !== undefined && petPanelWindow && !petPanelWindow.isDestroyed()) {
      petPanelWindow.webContents.send('pet:theme', s.theme);
    }
    if (patch.petEnabled !== undefined && petWindow) {
      if (patch.petEnabled) petWindow.show();
      else {
        petWindow.hide();
        hidePetPanel();
      }
    }
    return s;
  });

  // AI
  ipcMain.handle('ai:handle', async (e, input) => {
    const payload = typeof input === 'string' ? { text: input, requestId: `legacy-${Date.now()}` } : (input || {});
    const text = String(payload.text || '').trim();
    const requestId = String(payload.requestId || `request-${Date.now()}`).slice(0, 80);
    const request = aiRequestCoordinator.begin(e.sender.id, requestId);
    if (request.status === 'completed') return request.result;
    if (request.status === 'active') {
      return { intent: 'unknown', type: 'info', duplicate: true, message: '这条请求仍在处理中，没有重复执行。' };
    }
    const { key, controller } = request;
    const isTaskAgent = isTaskAgentSender(e);
    const history = sanitizeSessionHistory(payload.history);
    try {
      const result = broadcastAgentWorkflowResult(await ai.handleAuto(text, {
        signal: controller.signal,
        history,
        onProgress: (progress) => sendAiProgress(e.sender, requestId, progress)
      }));
      sendAiProgress(e.sender, requestId, { stage: 'done', message: '处理完成' });
      // 任务对话小窗：会话记忆由小窗自持，不写入主窗口侧边栏的对话记录
      if (isTaskAgent) return aiRequestCoordinator.complete(key, result);
      const persisted = persistAiExchange(text, result);
      return aiRequestCoordinator.complete(key, persisted);
    } catch (error) {
      if (controller.signal.aborted || error.code === 'AI_REQUEST_CANCELLED') {
        const result = { intent: 'cancel', type: 'cancelled', cancelled: true, message: '已停止。本次请求没有执行任何操作。' };
        sendAiProgress(e.sender, requestId, { stage: 'cancelled', message: result.message });
        if (isTaskAgent) return aiRequestCoordinator.complete(key, result);
        const persisted = persistAiExchange(text, result);
        return aiRequestCoordinator.complete(key, persisted);
      }
      throw error;
    } finally {
      aiRequestCoordinator.release(key);
    }
  });
  ipcMain.handle('ai:cancel', (e, requestId) => {
    const cancelled = aiRequestCoordinator.cancel(e.sender.id, String(requestId || '').slice(0, 80));
    return cancelled ? { ok: true } : { ok: false, message: '请求已经结束' };
  });
  ipcMain.handle('ai:report', async (e, input) => {
    const payload = input && typeof input === 'object' ? input : {};
    const requestId = String(payload.requestId || `report-${Date.now()}`).slice(0, 80);
    const request = aiRequestCoordinator.begin(e.sender.id, requestId);
    if (request.status === 'completed') return request.result;
    if (request.status === 'active') return { type: 'error', duplicate: true, message: '报告仍在生成中，请稍候。' };
    const { key, controller } = request;
    try {
      const result = await ai.generateReport(payload, {
        signal: controller.signal,
        timeout: 45000,
        onProgress: (progress) => sendAiProgress(e.sender, requestId, progress)
      });
      return aiRequestCoordinator.complete(key, result);
    } catch (error) {
      if (controller.signal.aborted || error.code === 'AI_REQUEST_CANCELLED') {
        return aiRequestCoordinator.complete(key, { type: 'cancelled', cancelled: true, message: '报告生成已停止。' });
      }
      throw error;
    } finally {
      aiRequestCoordinator.release(key);
    }
  });
  ipcMain.handle('ai:resolve', (e, intent, params, taskId, label) => {
    const result = broadcastAgentWorkflowResult(ai.resolve(intent, params, taskId));
    if (isTaskAgentSender(e)) return result;
    return persistAiExchange(label, result);
  });
  ipcMain.handle('ai:test', async () => {
    return await ai.testConnection();
  });
  ipcMain.handle('ai:parse', (e, text) => {
    // 只解析不执行：供快建输入框等场景提取参数
    return ai.parse(text);
  });
  ipcMain.handle('ai:config', () => {
    const cfg = ai.getLLMConfig();
    return { ...cfg, configured: ai.isLLMConfigured() };
  });
  ipcMain.handle('ai:session', () => ai.getSessionState());
  ipcMain.handle('ai:undo', (e, undo) => {
    const result = ai.undoAction(undo);
    broadcastWorkflowState();
    return result;
  });
  ipcMain.handle('ai:previewTaskAction', async (e, input) => {
    const payload = input || {};
    const requestId = String(payload.requestId || `task-action-${Date.now()}`).slice(0, 80);
    const request = aiRequestCoordinator.begin(e.sender.id, requestId);
    if (request.status === 'completed') return request.result;
    if (request.status === 'active') return { ok: false, type: 'duplicate', message: '正在理解上一条指令，请稍候。' };
    const { key, controller } = request;
    try {
      const context = payload.context && typeof payload.context === 'object' ? {
        previousAction: payload.context.previousAction && typeof payload.context.previousAction === 'object'
          ? payload.context.previousAction
          : null,
        previousText: String(payload.context.previousText || '').slice(0, 300),
        workLogId: String(payload.context.workLogId || '').slice(0, 100),
        workLogKind: String(payload.context.workLogKind || '').slice(0, 20)
      } : null;
      const preview = await ai.previewTaskAction(Number(payload.taskId), String(payload.text || '').trim(), {
        signal: controller.signal,
        timeout: 12000,
        history: sanitizeSessionHistory(payload.history),
        onProgress: (progress) => sendAiProgress(e.sender, requestId, progress)
      }, context);
      if (preview.ok) preview.previewId = rememberTaskActionPreview(e.sender.id, preview);
      return aiRequestCoordinator.complete(key, preview);
    } finally {
      aiRequestCoordinator.release(key);
    }
  });
  ipcMain.handle('ai:applyTaskAction', (e, previewId) => {
    const key = taskActionPreviewKey(e.sender.id, String(previewId || ''));
    const preview = taskActionPreviews.get(key);
    if (!preview || Date.now() - preview.createdAt > TASK_ACTION_PREVIEW_TTL) {
      taskActionPreviews.delete(key);
      return { ok: false, type: 'error', message: '这个预览已过期，请重新输入。' };
    }
    if (preview.applying) return { ok: false, type: 'duplicate', message: '正在保存这项修改，请稍候。' };
    preview.applying = true;
    try {
      const result = ai.applyTaskAction(preview);
      if (result && result.ok !== false) {
        taskActionPreviews.delete(key);
        broadcastAgentWorkflowResult(result);
        // 修改来自任务对话小窗等非主窗口入口时，通知主窗口刷新任务列表
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
      }
      return result;
    } finally {
      if (taskActionPreviews.has(key)) preview.applying = false;
    }
  });
  ipcMain.handle('task-agent:open', (e, input) => openTaskAgentWindow(input));
  ipcMain.handle('task-agent:close', () => {
    if (taskAgentWindow && !taskAgentWindow.isDestroyed()) taskAgentWindow.hide();
    return { ok: true };
  });
  ipcMain.handle('chat:get', () => store.getChatLog());
  ipcMain.handle('chat:clear', () => store.clearChat());

  // 数据
  ipcMain.handle('data:exportJSON', () => store.exportJSON());
  ipcMain.handle('data:exportCSV', () => store.exportCSV());
  ipcMain.handle('data:backup', () => store.backup());
  ipcMain.handle('data:getDir', () => store.getDataDir());
  ipcMain.handle('data:openDir', async () => {
    const error = await shell.openPath(store.getDataDir());
    if (error) throw new Error(error);
    return { ok: true };
  });
  ipcMain.handle('data:listBackups', () => store.listBackups());
  ipcMain.handle('data:restoreBackup', (e, filePath) => store.restoreFromBackup(filePath));
  ipcMain.handle('data:backupToDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择备份保存文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    try {
      const file = store.backupToDir(res.filePaths[0]);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('data:pickBackupFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要恢复的备份文件',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return { ok: true, file: res.filePaths[0] };
  });
  ipcMain.handle('data:weeklyReport', (e, weekOffset) => store.generateWeeklyReport(weekOffset));
  ipcMain.handle('data:dailyReport', (e, dayOffset) => store.generateDailyReport(dayOffset));
  ipcMain.handle('data:report', (e, input) => store.generateReport(input));
  // 桌宠拖动过程中只移动窗口，结束时再持久化，避免高频写盘。
  ipcMain.handle('pet:setPosition', (e, pos) => {
    if (petWindow && pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      const next = clampPetPosition(pos);
      petWindow.setPosition(next.x, next.y, false);
      if (petPanelWindow?.isVisible()) placePetPanel();
    }
    return { ok: true };
  });
  ipcMain.handle('pet:commitPosition', () => {
    if (!petWindow) return { ok: false };
    const [x, y] = petWindow.getPosition();
    const next = clampPetPosition({ x, y });
    petWindow.setPosition(next.x, next.y, false);
    store.updateSettings({ petPosition: { ...next, version: 2 } });
    return { ok: true, ...next };
  });
  // 桌宠当前位置
  ipcMain.handle('pet:getPosition', () => {
    if (!petWindow) return null;
    const [x, y] = petWindow.getPosition();
    return { x, y };
  });
  // 桌宠菜单唤起主窗口视图
  ipcMain.handle('pet:openView', (e, view) => {
    hidePetPanel();
    if (view === 'new') {
      sendToMain('app:new-task');
    } else if (view === 'ai') {
      // AI 对话：展开 AI 面板并聚焦输入框
      sendToMain('app:focus-ai');
    } else {
      sendToMain('app:switch-view', view);
    }
    return { ok: true };
  });
  ipcMain.handle('pet:openTask', (e, taskId) => {
    hidePetPanel();
    sendToMain('app:open-task', { id: taskId });
    return { ok: true };
  });
  ipcMain.handle('pet:togglePanel', (e, mode) => {
    if (!petPanelWindow || petPanelWindow.isDestroyed()) createPetPanelWindow();
    if (petPanelWindow.isVisible()) {
      hidePetPanel();
      sendWhenReady(petWindow, 'pet-panel:visibility', false);
      return { ok: true, visible: false };
    }
    placePetPanel();
    petPanelWindow.show();
    petPanelWindow.focus();
    sendWhenReady(petPanelWindow, 'pet-panel:shown', mode === 'chat' ? 'chat' : 'overview');
    sendWhenReady(petWindow, 'pet-panel:visibility', true);
    return { ok: true, visible: true };
  });
  ipcMain.handle('pet:showPanel', (e, mode) => {
    if (!petPanelWindow || petPanelWindow.isDestroyed()) createPetPanelWindow();
    placePetPanel();
    petPanelWindow.show();
    petPanelWindow.focus();
    sendWhenReady(petPanelWindow, 'pet-panel:shown', mode === 'chat' ? 'chat' : 'overview');
    sendWhenReady(petWindow, 'pet-panel:visibility', true);
    return { ok: true, visible: true };
  });
  ipcMain.handle('pet:closePanel', () => {
    hidePetPanel();
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-panel:visibility', false);
    return { ok: true };
  });
  // 桌宠右键菜单
  ipcMain.handle('pet:contextMenu', () => {
    const menu = Menu.buildFromTemplate([
      { label: '打开工作台', click: () => showMainWindow() },
      { label: '新建任务', click: () => sendToMain('app:new-task') },
      { type: 'separator' },
      { label: '今日视图', click: () => sendToMain('app:switch-view', 'today') },
      { label: '统计', click: () => sendToMain('app:switch-view', 'stat') },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } }
    ]);
    menu.popup({ window: petWindow });
    return { ok: true };
  });
  // 桌宠显示/隐藏
  ipcMain.handle('pet:setVisible', (e, visible) => {
    if (petWindow) {
      if (visible) petWindow.show();
      else {
        petWindow.hide();
        hidePetPanel();
      }
    }
    return { ok: true };
  });
  // 窗口控制
  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:hide', () => mainWindow && mainWindow.hide());
  ipcMain.handle('window:quit', () => { isQuitting = true; app.quit(); });
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return { ok: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
}

/* ---------- 应用生命周期 ---------- */
app.whenReady().then(() => {
  app.setAppUserModelId('com.workhelper.desktop');
  store.init();
  registerIpc();
  createMainWindow();
  createPetWindow();
  createPetPanelWindow();
  createTray();
  registerShortcuts();
  applyAutoStart();
  startReminderEngine();
  screen.on('display-removed', ensurePetVisible);
  screen.on('display-metrics-changed', ensurePetVisible);

  // 每日备份
  if (store.getSettings().autoBackup) {
    setInterval(() => {
      const h = new Date().getHours();
      if (h === 22) store.backup();
    }, 3600000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createPetWindow();
      createPetPanelWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (reminderTimer) clearInterval(reminderTimer);
});

app.on('window-all-closed', () => {
  // 常驻应用：不因窗口关闭而退出
});
