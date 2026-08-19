'use strict';

/**
 * 主进程入口
 * 职责：窗口管理、系统托盘、系统通知、全局快捷键、提醒引擎、IPC
 */

const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./main/store');
const ai = require('./main/ai');

/* ---------- 全局状态 ---------- */
let mainWindow = null;
let petWindow = null;
let tray = null;
let isQuitting = false;
let reminderTimer = null;
let remindedTaskIds = new Set();

const isDev = process.argv.includes('--dev');

/* ---------- 窗口创建 ---------- */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '工作台助手',
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
  });
}

function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const size = 160; // 桌宠本体宽度
  const winW = 160;
  const winH = 420; // 窗口高度容纳鲸鱼娘 sprite 与向上弹出的菜单/气泡
  const saved = store.getSettings().petPosition;
  // 默认位置：屏幕右下角贴底
  let x = workArea.x + workArea.width - winW - 24;
  let y = workArea.y + workArea.height - winH - 24;
  // 若保存过位置，做边界钳制：窗口必须完整落在工作区内，否则重置为默认（防止旧数据导致桌宠跑到屏幕外）
  if (saved) {
    const cx = Math.max(workArea.x, Math.min(workArea.x + workArea.width - winW, saved.x));
    const cy = Math.max(workArea.y, Math.min(workArea.y + workArea.height - winH, saved.y));
    x = cx;
    y = cy;
  }

  petWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
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
    petWindow = null;
  });
}

/* ---------- 托盘 ---------- */
function createTray() {
  // 生成一个简单的托盘图标（16x16 圆点）
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('工作台助手');

  const menu = Menu.buildFromTemplate([
    { label: '打开工作台', click: () => showMainWindow() },
    { label: '新建任务', click: () => { showMainWindow(); mainWindow.webContents.send('app:new-task'); } },
    { type: 'separator' },
    { label: '今日视图', click: () => { showMainWindow(); mainWindow.webContents.send('app:switch-view', 'today'); } },
    { label: '统计', click: () => { showMainWindow(); mainWindow.webContents.send('app:switch-view', 'stat'); } },
    { label: '回收站', click: () => { showMainWindow(); mainWindow.webContents.send('app:switch-view', 'trash'); } },
    { type: 'separator' },
    { label: '静音提醒', type: 'checkbox', checked: false, click: (item) => { store.updateSettings({ notify: !item.checked }); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------- 全局快捷键 ---------- */
function registerShortcuts() {
  const s = store.getSettings().shortcuts || {};
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(s.ai || 'CommandOrControl+J', () => {
      showMainWindow();
      mainWindow.webContents.send('app:focus-ai');
    });
    globalShortcut.register(s.newTask || 'CommandOrControl+N', () => {
      showMainWindow();
      mainWindow.webContents.send('app:new-task');
    });
    globalShortcut.register(s.today || 'CommandOrControl+1', () => {
      showMainWindow();
      mainWindow.webContents.send('app:switch-view', 'today');
    });
    globalShortcut.register(s.stat || 'CommandOrControl+5', () => {
      showMainWindow();
      mainWindow.webContents.send('app:switch-view', 'stat');
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
    if (mainWindow) mainWindow.webContents.send('app:reminder', { id: t.id, title: t.title, due: t.due });
    if (petWindow) petWindow.webContents.send('pet:remind', { id: t.id, title: t.title, due: t.due });
    // 系统通知
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '任务提醒',
        body: `${t.title}${t.due ? ' · ' + t.due : ''}`,
        silent: false
      });
      n.on('click', () => showMainWindow());
      n.show();
    }
  });
}

function startReminderEngine() {
  checkReminders();
  reminderTimer = setInterval(checkReminders, 60000); // 每分钟轮询
}

/* ---------- IPC ---------- */
function registerIpc() {
  // 任务
  ipcMain.handle('tasks:getAll', () => store.getAllTasks());
  ipcMain.handle('tasks:create', (e, data) => store.createTask(data));
  ipcMain.handle('tasks:update', (e, id, patch) => store.updateTask(id, patch));
  ipcMain.handle('tasks:delete', (e, id) => store.deleteTask(id));
  ipcMain.handle('tasks:restore', (e, id) => store.restoreTask(id));
  ipcMain.handle('tasks:archive', (e, id) => store.archiveTask(id));
  ipcMain.handle('tasks:unarchive', (e, id) => store.unarchiveTask(id));
  ipcMain.handle('tasks:reset', () => store.resetTasks());
  ipcMain.handle('tasks:clearAll', () => store.clearAllTasks());
  ipcMain.handle('tasks:import', (e, list) => store.importTasks(list));
  ipcMain.handle('tasks:complete', (e, id) => store.completeTask(id));
  ipcMain.handle('tasks:saveAndComplete', (e, id, data) => store.saveAndCompleteTask(id, data));
  ipcMain.handle('tasks:postpone', (e, id, days) => store.postponeTask(id, days));
  ipcMain.handle('tasks:reorder', (e, ids) => store.reorderTasks(ids));
  ipcMain.handle('tasks:batchUpdate', (e, ids, patch) => store.batchUpdate(ids, patch));
  ipcMain.handle('tasks:batchComplete', (e, ids) => store.batchComplete(ids));
  ipcMain.handle('tasks:batchDelete', (e, ids) => store.batchDelete(ids));
  ipcMain.handle('tasks:getDeleted', () => store.getDeletedTasks());
  ipcMain.handle('tasks:emptyTrash', () => store.emptyTrash());

  // 设置
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (e, patch) => {
    const s = store.updateSettings(patch);
    if (patch.shortcuts) registerShortcuts();
    if (patch.autoStart !== undefined) applyAutoStart();
    if (patch.petEnabled !== undefined && petWindow) {
      if (patch.petEnabled) petWindow.show();
      else petWindow.hide();
    }
    return s;
  });

  // AI
  ipcMain.handle('ai:handle', async (e, text) => {
    const result = await ai.handleAuto(text);
    store.appendChat({ role: 'user', text, ts: Date.now() });
    store.appendChat({ role: 'ai', text: result.message, ts: Date.now() });
    return result;
  });
  ipcMain.handle('ai:resolve', (e, intent, params, taskId, label) => {
    const result = ai.resolve(intent, params, taskId);
    store.appendChat({ role: 'user', text: label, ts: Date.now() });
    store.appendChat({ role: 'ai', text: result.message, ts: Date.now() });
    return result;
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
  ipcMain.handle('ai:undo', (e, undo) => {
    return ai.undoAction(undo);
  });
  ipcMain.handle('chat:get', () => store.getChatLog());
  ipcMain.handle('chat:clear', () => store.clearChat());

  // 数据
  ipcMain.handle('data:exportJSON', () => store.exportJSON());
  ipcMain.handle('data:exportCSV', () => store.exportCSV());
  ipcMain.handle('data:backup', () => store.backup());
  ipcMain.handle('data:getDir', () => store.getDataDir());
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
  ipcMain.handle('data:pickDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return { ok: true, dir: res.filePaths[0] };
  });

  // 桌宠位置：移动窗口 + 保存位置
  ipcMain.handle('pet:setPosition', (e, pos) => {
    if (petWindow && pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      petWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
    }
    store.updateSettings({ petPosition: pos });
    return { ok: true };
  });
  // 桌宠当前位置
  ipcMain.handle('pet:getPosition', () => {
    if (!petWindow) return null;
    const [x, y] = petWindow.getPosition();
    return { x, y };
  });
  // 桌宠菜单唤起主窗口视图
  ipcMain.handle('pet:openView', (e, view) => {
    showMainWindow();
    if (view === 'ai') {
      // AI 对话：展开 AI 面板并聚焦输入框
      if (mainWindow) mainWindow.webContents.send('app:focus-ai');
    } else if (mainWindow) {
      mainWindow.webContents.send('app:switch-view', view);
    }
    return { ok: true };
  });
  // 桌宠右键菜单
  ipcMain.handle('pet:contextMenu', () => {
    const menu = Menu.buildFromTemplate([
      { label: '打开工作台', click: () => showMainWindow() },
      { label: '新建任务', click: () => { showMainWindow(); mainWindow.webContents.send('app:new-task'); } },
      { type: 'separator' },
      { label: '今日视图', click: () => { showMainWindow(); mainWindow.webContents.send('app:switch-view', 'today'); } },
      { label: '统计', click: () => { showMainWindow(); mainWindow.webContents.send('app:switch-view', 'stat'); } },
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
      else petWindow.hide();
    }
    return { ok: true };
  });
  // 桌宠吸附屏幕边缘
  ipcMain.handle('pet:snapToEdge', () => {
    if (!petWindow) return { ok: false };
    const { workArea } = screen.getPrimaryDisplay();
    const [winW, winH] = petWindow.getSize();
    const pos = petWindow.getPosition();
    const margin = 8;
    let x = pos[0], y = pos[1];
    // 吸附到左/右边缘
    if (x < workArea.x + workArea.width / 2) {
      x = workArea.x + margin;
    } else {
      x = workArea.x + workArea.width - winW - margin;
    }
    // 吸附到上/下边缘
    if (y < workArea.y + workArea.height / 2) {
      y = workArea.y + margin;
    } else {
      y = workArea.y + workArea.height - winH - margin;
    }
    petWindow.setPosition(x, y);
    store.updateSettings({ petPosition: { x, y } });
    return { ok: true, x, y };
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
  store.init();
  registerIpc();
  createMainWindow();
  createPetWindow();
  createTray();
  registerShortcuts();
  applyAutoStart();
  startReminderEngine();

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
