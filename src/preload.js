'use strict';

/**
 * 预加载脚本 - 通过 contextBridge 暴露安全的 IPC API
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  worklog: {
    get: (start, end) => ipcRenderer.invoke('worklog:get', start, end),
    addNote: (date, text) => ipcRenderer.invoke('worklog:addNote', date, text),
    removeNote: (date, id) => ipcRenderer.invoke('worklog:removeNote', date, id)
  },
  /* 任务 */
  tasks: {
    getAll: () => ipcRenderer.invoke('tasks:getAll'),
    create: (data) => ipcRenderer.invoke('tasks:create', data),
    update: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
    remove: (id) => ipcRenderer.invoke('tasks:delete', id),
    restore: (id) => ipcRenderer.invoke('tasks:restore', id),
    archive: (id) => ipcRenderer.invoke('tasks:archive', id),
    unarchive: (id) => ipcRenderer.invoke('tasks:unarchive', id),
    reset: () => ipcRenderer.invoke('tasks:reset'),
    clearAll: () => ipcRenderer.invoke('tasks:clearAll'),
    import: (list) => ipcRenderer.invoke('tasks:import', list),
    complete: (id) => ipcRenderer.invoke('tasks:complete', id),
    saveAndComplete: (id, data) => ipcRenderer.invoke('tasks:saveAndComplete', id, data),
    addWorkLog: (taskId, input) => ipcRenderer.invoke('tasks:addWorkLog', taskId, input),
    updateWorkLog: (taskId, logId, patch) => ipcRenderer.invoke('tasks:updateWorkLog', taskId, logId, patch),
    removeWorkLog: (taskId, logId) => ipcRenderer.invoke('tasks:removeWorkLog', taskId, logId),
    postpone: (id, days) => ipcRenderer.invoke('tasks:postpone', id, days),
    reorder: (ids) => ipcRenderer.invoke('tasks:reorder', ids),
    batchUpdate: (ids, patch) => ipcRenderer.invoke('tasks:batchUpdate', ids, patch),
    batchComplete: (ids) => ipcRenderer.invoke('tasks:batchComplete', ids),
    batchDelete: (ids) => ipcRenderer.invoke('tasks:batchDelete', ids),
    getDeleted: () => ipcRenderer.invoke('tasks:getDeleted'),
    purge: (id) => ipcRenderer.invoke('tasks:purge', id),
    emptyTrash: () => ipcRenderer.invoke('tasks:emptyTrash')
  },
  /* 备忘录 */
  memos: {
    convert: (id) => ipcRenderer.invoke('memos:convert', id),
    getAll: () => ipcRenderer.invoke('memos:getAll'),
    create: (data) => ipcRenderer.invoke('memos:create', data),
    update: (id, patch) => ipcRenderer.invoke('memos:update', id, patch),
    remove: (id) => ipcRenderer.invoke('memos:delete', id),
    batchUpdate: (ids, patch) => ipcRenderer.invoke('memos:batchUpdate', ids, patch),
    batchDelete: (ids) => ipcRenderer.invoke('memos:batchDelete', ids),
    batchRestore: (ids) => ipcRenderer.invoke('memos:batchRestore', ids),
    getDeleted: () => ipcRenderer.invoke('memos:getDeleted'),
    restore: (id) => ipcRenderer.invoke('memos:restore', id),
    purge: (id) => ipcRenderer.invoke('memos:purge', id),
    emptyTrash: () => ipcRenderer.invoke('memos:emptyTrash'),

  },
  /* 设置 */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },
  /* MCP 服务：供本机其他 AI agent 连接，默认关闭 */
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    setEnabled: (enabled) => ipcRenderer.invoke('mcp:setEnabled', !!enabled),
    rotateToken: () => ipcRenderer.invoke('mcp:rotateToken')
  },
  /* AI */
  ai: {
    // 兼容旧版调用形态：previewTaskAction: (taskId, text, requestId) => ipcRenderer.invoke('ai:previewTaskAction', ...)
    handle: (text, requestId, options) => ipcRenderer.invoke('ai:handle', { text, requestId, history: options && options.history }),
    report: (input, requestId) => ipcRenderer.invoke('ai:report', { ...(input || {}), requestId }),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
    onProgress: (callback) => {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('ai:progress', listener);
      return () => ipcRenderer.removeListener('ai:progress', listener);
    },
    resolve: (intent, params, taskId, label) => ipcRenderer.invoke('ai:resolve', intent, params, taskId, label),
    test: () => ipcRenderer.invoke('ai:test'),
    config: () => ipcRenderer.invoke('ai:config'),
    session: () => ipcRenderer.invoke('ai:session'),
    parse: (text) => ipcRenderer.invoke('ai:parse', text),
    previewTaskAction: (taskId, text, requestId, context, history) => ipcRenderer.invoke('ai:previewTaskAction', { taskId, text, requestId, context, history }),
    applyTaskAction: (previewId) => ipcRenderer.invoke('ai:applyTaskAction', previewId),
    undo: (undo) => ipcRenderer.invoke('ai:undo', undo)
  },
  chat: {
    get: () => ipcRenderer.invoke('chat:get'),
    clear: () => ipcRenderer.invoke('chat:clear')
  },
  /* 数据 */
  data: {
    exportJSON: () => ipcRenderer.invoke('data:exportJSON'),
    exportCSV: () => ipcRenderer.invoke('data:exportCSV'),
    backup: () => ipcRenderer.invoke('data:backup'),
    getDir: () => ipcRenderer.invoke('data:getDir'),
    openDir: () => ipcRenderer.invoke('data:openDir'),
    listBackups: () => ipcRenderer.invoke('data:listBackups'),
    restoreBackup: (filePath) => ipcRenderer.invoke('data:restoreBackup', filePath),
    backupToDir: () => ipcRenderer.invoke('data:backupToDir'),
    pickBackupFile: () => ipcRenderer.invoke('data:pickBackupFile'),
    weeklyReport: (weekOffset) => ipcRenderer.invoke('data:weeklyReport', weekOffset),
    dailyReport: (dayOffset) => ipcRenderer.invoke('data:dailyReport', dayOffset),
    report: (input) => ipcRenderer.invoke('data:report', input)
  },
  /* 桌宠 */
  pet: {
    setPosition: (pos) => ipcRenderer.invoke('pet:setPosition', pos),
    commitPosition: () => ipcRenderer.invoke('pet:commitPosition'),
    getPosition: () => ipcRenderer.invoke('pet:getPosition'),
    togglePanel: (mode) => ipcRenderer.invoke('pet:togglePanel', mode),
    showPanel: (mode) => ipcRenderer.invoke('pet:showPanel', mode),
    closePanel: () => ipcRenderer.invoke('pet:closePanel'),
    openView: (view) => ipcRenderer.invoke('pet:openView', view),
    openTask: (taskId) => ipcRenderer.invoke('pet:openTask', taskId),
    contextMenu: () => ipcRenderer.invoke('pet:contextMenu'),
    setVisible: (visible) => ipcRenderer.invoke('pet:setVisible', visible)
  },
  /* 窗口 */
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    hide: () => ipcRenderer.invoke('window:hide'),
    quit: () => ipcRenderer.invoke('window:quit'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize')
  },
  /* 事件订阅 */
  on: (channel, cb) => {
    const valid = ['app:new-task', 'app:focus-ai', 'app:open-task', 'app:reminder', 'app:switch-view', 'window:maximized', 'pet:remind', 'pet:theme', 'pet-panel:shown', 'pet-panel:visibility', 'tasks:changed', 'memos:changed'];
    if (!valid.includes(channel)) return;
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
