'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/css/app.css'), 'utf8');

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

test('主导航和任务工具栏使用可聚焦控件', () => {
  assert.match(html, /<nav class="sidebar" aria-label="主导航">/);
  assert.match(html, /<button type="button" class="nav-item active"[^>]+aria-current="page"/);
  assert.doesNotMatch(html, /<div class="nav-item/);
  assert.match(html, /<div class="task-tools">\s*<input id="search-input" aria-label="搜索任务"/);
  assert.match(html, /<div class="quick-add">\s*<input id="quick-input"/);
});

test('高频任务操作和设置开关暴露键盘与状态语义', () => {
  assert.match(app, /<button type="button" class="task-check"[^>]+aria-label=/);
  assert.match(app, /<button type="button" class="pri-dot p\$\{t\.pri\}"[^>]+data-pri-toggle/);
  assert.match(app, /class="task-expand\$\{[^}]+\}"[^>]+aria-expanded=/);
  assert.match(app, /class="tname task-title-btn" aria-expanded=/);
  assert.match(app, /role="switch" aria-checked=/);
});

test('真实模型设置明确数据范围并校验自定义服务地址', () => {
  assert.match(app, /最多 30 条未归档任务摘要会发送给所选服务商/);
  assert.match(app, /settings\.aiProvider !== 'custom' \|\| !!settings\.aiBaseUrl/);
  assert.match(app, /s\.aiStage === 'llm'/);
});

test('主题和 AI 引擎分段控件暴露并同步选中状态', () => {
  assert.match(app, /id="theme-seg" role="radiogroup" aria-label="外观主题"/);
  assert.match(app, /id="ai-stage-seg" role="radiogroup" aria-label="AI 助手引擎"/);
  assert.ok((app.match(/role="radio" aria-checked=/g) || []).length >= 5);
  assert.ok((app.match(/setAttribute\('aria-checked', 'false'\)/g) || []).length >= 2);
  assert.ok((app.match(/setAttribute\('aria-checked', 'true'\)/g) || []).length >= 2);
});

test('界面样式包含窄容器和低动态偏好支持', () => {
  assert.match(css, /@container \(max-width: 560px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.task-row:focus-within \.row-actions/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient\(/);
});

test('暗色搜索聚焦保持深色背景，主操作色满足白字对比度', () => {
  assert.match(css, /body\.dark \.task-tools #search-input:focus,\s*body\.dark \.quick-add input:focus \{ background: var\(--bg2\); \}/);

  const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const dark = css.match(/body\.dark\s*\{([\s\S]*?)\}/)[1];
  assert.ok(contrastRatio(cssVar(root, 'grad'), '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio(cssVar(dark, 'grad'), '#FFFFFF') >= 4.5);
});
