'use strict';

/** electron stub - 被 mock-electron 拦截后 require 到的模块 */
module.exports = {
  app: require('./mock-electron').mockApp,
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  Notification: { isSupported: () => false },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  ipcMain: { handle: () => {} },
  nativeImage: { createEmpty: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  dialog: { showOpenDialog: async () => ({ canceled: true }) }
};