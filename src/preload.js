'use strict';

/**
 * 预加载脚本 - 通过 contextBridge 暴露安全的 IPC API
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
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
    postpone: (id, days) => ipcRenderer.invoke('tasks:postpone', id, days),
    reorder: (ids) => ipcRenderer.invoke('tasks:reorder', ids),
    batchUpdate: (ids, patch) => ipcRenderer.invoke('tasks:batchUpdate', ids, patch),
    batchComplete: (ids) => ipcRenderer.invoke('tasks:batchComplete', ids),
    batchDelete: (ids) => ipcRenderer.invoke('tasks:batchDelete', ids),
    getDeleted: () => ipcRenderer.invoke('tasks:getDeleted'),
    emptyTrash: () => ipcRenderer.invoke('tasks:emptyTrash')
  },
  /* 备忘录 */
  memos: {
    getAll: () => ipcRenderer.invoke('memos:getAll'),
    create: (data) => ipcRenderer.invoke('memos:create', data),
    update: (id, patch) => ipcRenderer.invoke('memos:update', id, patch),
    remove: (id) => ipcRenderer.invoke('memos:delete', id),
    getDeleted: () => ipcRenderer.invoke('memos:getDeleted'),
    restore: (id) => ipcRenderer.invoke('memos:restore', id),
    emptyTrash: () => ipcRenderer.invoke('memos:emptyTrash'),
    import: (list) => ipcRenderer.invoke('memos:import', list)
  },
  /* 设置 */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },
  /* AI */
  ai: {
    handle: (text) => ipcRenderer.invoke('ai:handle', text),
    resolve: (intent, params, taskId, label) => ipcRenderer.invoke('ai:resolve', intent, params, taskId, label),
    test: () => ipcRenderer.invoke('ai:test'),
    config: () => ipcRenderer.invoke('ai:config'),
    parse: (text) => ipcRenderer.invoke('ai:parse', text),
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
    pickDir: () => ipcRenderer.invoke('data:pickDir'),
    listBackups: () => ipcRenderer.invoke('data:listBackups'),
    restoreBackup: (filePath) => ipcRenderer.invoke('data:restoreBackup', filePath),
    backupToDir: () => ipcRenderer.invoke('data:backupToDir'),
    pickBackupFile: () => ipcRenderer.invoke('data:pickBackupFile'),
    weeklyReport: (weekOffset) => ipcRenderer.invoke('data:weeklyReport', weekOffset)
  },
  /* 桌宠 */
  pet: {
    setPosition: (pos) => ipcRenderer.invoke('pet:setPosition', pos),
    getPosition: () => ipcRenderer.invoke('pet:getPosition'),
    openView: (view) => ipcRenderer.invoke('pet:openView', view),
    contextMenu: () => ipcRenderer.invoke('pet:contextMenu'),
    setVisible: (visible) => ipcRenderer.invoke('pet:setVisible', visible),
    snapToEdge: () => ipcRenderer.invoke('pet:snapToEdge')
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
    const valid = ['app:new-task', 'app:focus-ai', 'app:reminder', 'app:switch-view', 'window:maximized', 'pet:remind', 'pet:theme'];
    if (!valid.includes(channel)) return;
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
