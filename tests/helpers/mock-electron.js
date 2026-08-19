'use strict';

/**
 * Electron mock - 让 store.js / ai.js 可在纯 Node 环境下测试
 * 通过 module 拦截 require('electron') 返回假 app
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-helper-test-'));

const mockApp = {
  getPath: (name) => {
    if (name === 'userData') return path.join(tmpRoot, 'userData');
    return path.join(tmpRoot, name || '');
  },
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
  setLoginItemSettings: () => {}
};

// 拦截 require('electron')
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.js');
  return originalResolve.call(this, request, ...args);
};

module.exports = { mockApp, tmpRoot };