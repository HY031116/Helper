'use strict';

/**
 * AI 规则引擎回归测试集
 * 覆盖 PRD 第 6 章：8 类意图 + 兜底场景
 * 运行：node --test tests/ai-project.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// 先加载 electron mock（拦截 require('electron')）
require('./helpers/mock-electron');

const store = require('../src/main/store');
const ai = require('../src/main/ai');

const DATA_DIR = process.env.WORK_HELPER_DATA_DIR || path.join(require('os').tmpdir(), 'work-helper-ai-test-' + Date.now());

before(() => {
  process.env.WORK_HELPER_DATA_DIR = DATA_DIR;
  store.init();
});

after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ---------- 工具 ---------- */
function reset() {
  store.resetTasks();
}

/* ============ 1. 创建意图 ============ */
test('创建：明天下午3点 交周报 #工作 紧急', () => {
  reset();
  const r = ai.handle('明天下午3点 交周报 #工作 紧急');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.type, 'create');
  assert.ok(r.task);
  assert.strictEqual(r.task.title, '交周报');
  assert.strictEqual(r.task.pri, 4);
  assert.strictEqual(r.task.tags[0], '工作');
  assert.ok(r.task.due && r.task.due.includes('15:00'));
});

test('创建：记一下 买牛奶', () => {
  reset();
  const r = ai.handle('记一下 买牛奶');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '买牛奶');
  assert.strictEqual(r.task.pri, 2); // 默认中优先级
});

test('创建：后天 交季度报告 高优先级', () => {
  reset();
  const r = ai.handle('后天 交季度报告 高优先级');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '交季度报告');
  assert.strictEqual(r.task.pri, 3);
});

test('创建：周一下午2点 团队评审', () => {
  reset();
  const r = ai.handle('周一下午2点 团队评审');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '团队评审');
  assert.ok(r.task.due && r.task.due.includes('14:00'));
});

/* ============ 2. 查询意图 ============ */
test('查询：今天我要做什么', () => {
  reset();
  const r = ai.handle('今天我要做什么');
  assert.strictEqual(r.intent, 'query');
  assert.strictEqual(r.type, 'query');
  assert.ok(r.message.includes('共'));
});

test('查询：列一下我的任务', () => {
  reset();
  const r = ai.handle('列一下我的任务');
  assert.strictEqual(r.intent, 'query');
});

/* ============ 3. 完成意图 ============ */
test('完成：完成 交周报', () => {
  reset();
  const r = ai.handle('完成 交周报');
  assert.strictEqual(r.intent, 'complete');
  assert.strictEqual(r.type, 'complete');
  assert.ok(r.undoable);
  // 验证数据已更新
  const t = store.getAllTasks().find((x) => x.title === '交周报');
  assert.strictEqual(t.status, 'done');
  assert.ok(t.completedAt, '完成时应记录 completedAt');
});

test('完成：不存在的任务 → 报错不误操作', () => {
  reset();
  const r = ai.handle('完成 不存在的任务xyz');
  assert.strictEqual(r.type, 'error');
});

test('完成：多候选 → 追问不默认选择', () => {
  reset();
  // 创建两个相似任务
  store.createTask({ title: '写方案A' });
  store.createTask({ title: '写方案B' });
  const r = ai.handle('完成 写方案');
  assert.strictEqual(r.type, 'ask');
  assert.ok(r.candidates && r.candidates.length >= 2);
});

/* ============ 4. 开始意图 ============ */
test('开始：开始 写季度方案', () => {
  reset();
  const r = ai.handle('开始 写季度方案');
  assert.strictEqual(r.intent, 'start');
  assert.strictEqual(r.type, 'start');
  const t = store.getAllTasks().find((x) => x.title === '写季度方案');
  assert.strictEqual(t.status, 'doing');
});

/* ============ 5. 删除意图 ============ */
test('删除：删除 整理报销单据', () => {
  reset();
  const r = ai.handle('删除 整理报销单据');
  assert.strictEqual(r.intent, 'delete');
  assert.strictEqual(r.type, 'delete');
  assert.ok(r.undoable);
  // 软删除
  const all = store.getAllTasks();
  assert.ok(!all.some((x) => x.title === '整理报销单据'));
});

/* ============ 6. 归档意图 ============ */
test('归档：归档 写季度方案', () => {
  reset();
  const r = ai.handle('归档 写季度方案');
  assert.strictEqual(r.intent, 'archive');
  assert.strictEqual(r.type, 'archive');
  assert.ok(r.undoable);
  const t = store.getAllTasks().find((x) => x.title === '写季度方案');
  assert.strictEqual(t.status, 'archived');
});

/* ============ 7. 拆分意图 ============ */
test('拆分：把 写季度方案 拆成三步', () => {
  reset();
  const r = ai.handle('把 写季度方案 拆成三步');
  assert.strictEqual(r.intent, 'split');
  assert.strictEqual(r.type, 'split');
  const t = store.getAllTasks().find((x) => x.title === '写季度方案');
  assert.ok(t.children && t.children.length === 3);
});

/* ============ 8. 建议意图 ============ */
test('建议：怎么安排今天的优先级', () => {
  reset();
  const r = ai.handle('怎么安排今天的优先级');
  assert.strictEqual(r.intent, 'suggest');
  assert.strictEqual(r.type, 'suggest');
  assert.ok(r.message.includes('建议'));
});

/* ============ 9. 小结意图 ============ */
test('小结：今天完成了什么', () => {
  reset();
  const r = ai.handle('今天完成了什么');
  assert.strictEqual(r.intent, 'summary');
  assert.strictEqual(r.type, 'summary');
  assert.ok(r.message.includes('已完成'));
});

/* ============ 10. 兜底场景 ============ */
test('兜底：非任务内容 → 通用对话，不执行任何操作', () => {
  reset();
  const before = store.getAllTasks().length;
  const r = ai.handle('今天天气怎么样');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.type, 'chat');
  assert.strictEqual(store.getAllTasks().length, before, '闲聊不应改动数据');
});

test('兜底：空输入 → 提示', () => {
  const r = ai.handle('');
  assert.strictEqual(r.intent, 'unknown');
});

test('兜底：参数缺失 → 按默认值执行并明示', () => {
  reset();
  const r = ai.handle('创建 一个任务');
  assert.strictEqual(r.type, 'create');
  assert.strictEqual(r.task.pri, 2);
});

/* ============ 11. 撤销链路 ============ */
test('撤销：删除后可恢复', () => {
  reset();
  const r = ai.handle('删除 整理报销单据');
  assert.ok(r.undo && r.undo.action === 'restore');
  const restored = store.restoreTask(r.undo.id);
  assert.strictEqual(restored.title, '整理报销单据');
});

test('撤销：归档后可恢复', () => {
  reset();
  const r = ai.handle('归档 写季度方案');
  assert.ok(r.undo && r.undo.action === 'unarchive');
  const restored = store.unarchiveTask(r.undo.id);
  assert.strictEqual(restored.status, 'todo');
});

/* ============ 12. 子任务完成进度 ============ */
test('子任务：完成父任务时逐步推进', () => {
  reset();
  const t = store.createTask({ title: '多步任务', children: [{ title: '步骤1', done: false }, { title: '步骤2', done: false }] });
  const r1 = ai.handle('完成 多步任务');
  assert.strictEqual(r1.type, 'complete');
  const t1 = store.getTask(t.id);
  assert.strictEqual(t1.children.filter((c) => c.done).length, 1);
  assert.strictEqual(t1.status, 'todo', '未全部完成时父任务不应完成');
  const r2 = ai.handle('完成 多步任务');
  const t2 = store.getTask(t.id);
  assert.strictEqual(t2.children.filter((c) => c.done).length, 2);
  assert.strictEqual(t2.status, 'done', '全部子任务完成时父任务完成');
});

/* ============ 13. 统计口径 ============ */
test('统计：completedAt 记录真实完成时间', () => {
  reset();
  const t = store.createTask({ title: '统计测试任务' });
  store.updateTask(t.id, { status: 'done' });
  const done = store.getTask(t.id);
  assert.ok(done.completedAt);
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(new Date(done.completedAt).toISOString().slice(0, 10), today);
});

/* ============ 14. 数据层 ============ */
test('数据层：导入任务', () => {
  reset();
  const imported = store.importTasks([
    { title: '导入任务1', pri: 3 },
    { title: '导入任务2', due: '2026-12-31 18:00' }
  ]);
  assert.strictEqual(imported.length, 2);
  assert.strictEqual(store.getAllTasks().length, 10); // 8 种子 + 2 导入
});

test('数据层：清空全部', () => {
  reset();
  store.clearAllTasks();
  assert.strictEqual(store.getAllTasks().length, 0);
});

test('数据层：归档与恢复', () => {
  reset();
  const t = store.createTask({ title: '归档测试' });
  store.archiveTask(t.id);
  assert.strictEqual(store.getTask(t.id).status, 'archived');
  store.unarchiveTask(t.id);
  assert.strictEqual(store.getTask(t.id).status, 'todo');
});

/* ============ 15. 意图识别准确率基线 ============ */
test('基线：100 条典型语句识别准确率 ≥ 85%', () => {
  reset();
  const corpus = [
    // 创建（20 条）
    '明天下午3点 交周报', '记一下 买牛奶', '新建 写方案', '添加 预约牙医',
    '帮我记 取快递', '加一个 整理桌面', '建一个 学习计划', '记个 交电费',
    '后天 交季度报告', '周一下午2点 团队评审', '今天 完成周报', '明天 开会',
    '周五 交总结', '3月5日 交年报', '安排 出差报销', '创建 健身计划',
    '明天早上9点 晨会', '今晚8点 看直播', '下午4点 交材料', '明天下午 面试',
    // 查询（12 条）
    '今天我要做什么', '列一下我的任务', '我的任务', '有什么待办', '最近一周的任务',
    '查一下 交周报', '看看今天', '有哪些任务', '待办列表', '今天有什么',
    '本周任务', '所有任务',
    // 完成（12 条）
    '完成 交周报', '搞定 写方案', '做完了 回复邮件', '办完了 整理报销',
    '勾掉 团队周会', '完成 学习TypeScript', '搞定 更新OKR', '做完了 预约体检',
    '完成 写季度方案', '搞定 交周报', '完成 回复客户邮件', '做完了 整理报销单据',
    // 开始（8 条）
    '开始 写方案', '动手做 交周报', '着手 写季度方案', '开始 学习',
    '开始 整理报销', '动手做 回复邮件', '开始 写代码', '着手 做PPT',
    // 删除（8 条）
    '删除 整理报销单据', '去掉 买牛奶', '不做了 学习计划', '取消这个 预约牙医',
    '移除 取快递', '删除 交电费', '去掉 整理桌面', '删除 写方案',
    // 归档（4 条）
    '归档 写季度方案', '收起来 交周报', '移入归档 学习计划', '归档 整理报销',
    // 拆分（6 条）
    '把 写方案 拆成三步', '拆分 交周报', '把 学习 分解成五步', '把 写季度方案 拆成两步',
    '拆分 做PPT', '把 健身计划 分成四步',
    // 建议（8 条）
    '怎么安排今天的优先级', '先做什么', '建议一下', '优先级排序',
    '今天先做什么', '怎么安排', '安排一下', '排序一下任务',
    // 小结（8 条）
    '今天完成了什么', '今日小结', '总结一下', '复盘今天',
    '今天做了什么', '小结一下', '完成了什么', '今日复盘',
    // 未知（14 条）
    '今天天气怎么样', '你好', '帮我写首诗', '什么是量子力学',
    '推荐一部电影', '讲个笑话', '现在几点', '今天股市怎么样',
    '帮我翻译一下', '写个菜谱', '推荐一本书', '什么是爱',
    '帮我算一下', '随便聊聊'
  ];
  let correct = 0;
  const expected = {
    '明天下午3点 交周报': 'create', '记一下 买牛奶': 'create', '新建 写方案': 'create', '添加 预约牙医': 'create',
    '帮我记 取快递': 'create', '加一个 整理桌面': 'create', '建一个 学习计划': 'create', '记个 交电费': 'create',
    '后天 交季度报告': 'create', '周一下午2点 团队评审': 'create', '今天 完成周报': 'create', '明天 开会': 'create',
    '周五 交总结': 'create', '3月5日 交年报': 'create', '安排 出差报销': 'create', '创建 健身计划': 'create',
    '明天早上9点 晨会': 'create', '今晚8点 看直播': 'create', '下午4点 交材料': 'create', '明天下午 面试': 'create',
    '今天我要做什么': 'query', '列一下我的任务': 'query', '我的任务': 'query', '有什么待办': 'query', '最近一周的任务': 'query',
    '查一下 交周报': 'query', '看看今天': 'query', '有哪些任务': 'query', '待办列表': 'query', '今天有什么': 'query',
    '本周任务': 'query', '所有任务': 'query',
    '完成 交周报': 'complete', '搞定 写方案': 'complete', '做完了 回复邮件': 'complete', '办完了 整理报销': 'complete',
    '勾掉 团队周会': 'complete', '完成 学习TypeScript': 'complete', '搞定 更新OKR': 'complete', '做完了 预约体检': 'complete',
    '完成 写季度方案': 'complete', '搞定 交周报': 'complete', '完成 回复客户邮件': 'complete', '做完了 整理报销单据': 'complete',
    '开始 写方案': 'start', '动手做 交周报': 'start', '着手 写季度方案': 'start', '开始 学习': 'start',
    '开始 整理报销': 'start', '动手做 回复邮件': 'start', '开始 写代码': 'start', '着手 做PPT': 'start',
    '删除 整理报销单据': 'delete', '去掉 买牛奶': 'delete', '不做了 学习计划': 'delete', '取消这个 预约牙医': 'delete',
    '移除 取快递': 'delete', '删除 交电费': 'delete', '去掉 整理桌面': 'delete', '删除 写方案': 'delete',
    '归档 写季度方案': 'archive', '收起来 交周报': 'archive', '移入归档 学习计划': 'archive', '归档 整理报销': 'archive',
    '把 写方案 拆成三步': 'split', '拆分 交周报': 'split', '把 学习 分解成五步': 'split', '把 写季度方案 拆成两步': 'split',
    '拆分 做PPT': 'split', '把 健身计划 分成四步': 'split',
    '怎么安排今天的优先级': 'suggest', '先做什么': 'suggest', '建议一下': 'suggest', '优先级排序': 'suggest',
    '今天先做什么': 'suggest', '怎么安排': 'suggest', '安排一下': 'suggest', '排序一下任务': 'suggest',
    '今天完成了什么': 'summary', '今日小结': 'summary', '总结一下': 'summary', '复盘今天': 'summary',
    '今天做了什么': 'summary', '小结一下': 'summary', '完成了什么': 'summary', '今日复盘': 'summary',
    '今天天气怎么样': 'chat', '你好': 'greeting', '帮我写首诗': 'chat', '什么是量子力学': 'chat',
    '推荐一部电影': 'chat', '讲个笑话': 'chat', '现在几点': 'chat', '今天股市怎么样': 'chat',
    '帮我翻译一下': 'chat', '写个菜谱': 'chat', '推荐一本书': 'chat', '什么是爱': 'chat',
    '帮我算一下': 'chat', '随便聊聊': 'chat'
  };
  corpus.forEach((s) => {
    const r = ai.handle(s);
    if (r.intent === expected[s]) correct++;
  });
  const rate = correct / corpus.length;
  assert.ok(rate >= 0.85, `意图识别准确率 ${(rate * 100).toFixed(1)}% < 85% 基线（${correct}/${corpus.length}）`);
});

/* ============ 16. 重复任务 ============ */
test('重复任务：完成时自动生成下一次', () => {
  reset();
  const t = store.createTask({ title: '每日晨会', repeat: 'daily', due: '2026-08-18 09:00' });
  const res = store.completeTask(t.id);
  assert.strictEqual(res.task.status, 'done');
  assert.ok(res.next, '应生成下一次任务');
  assert.strictEqual(res.next.title, '每日晨会');
  assert.strictEqual(res.next.repeat, 'daily');
  assert.strictEqual(res.next.due, '2026-08-19 09:00', '每日任务应顺延一天');
});

test('重复任务：每周任务顺延 7 天', () => {
  reset();
  const t = store.createTask({ title: '周报', repeat: 'weekly', due: '2026-08-18 18:00' });
  const res = store.completeTask(t.id);
  assert.strictEqual(res.next.due, '2026-08-25 18:00');
});

test('重复任务：重新打开或重复完成不会复制下一次任务', () => {
  reset();
  const task = store.createTask({ title: '每日站会', repeat: 'daily', due: '2026-08-18 09:00' });
  const first = store.completeTask(task.id);
  store.updateTask(task.id, { status: 'todo' });
  const reopened = store.completeTask(task.id);
  const repeated = store.completeTask(task.id);
  const successors = store.getAllTasks().filter((t) => t.repeatSourceId === task.id);

  assert.strictEqual(successors.length, 1);
  assert.strictEqual(reopened.next.id, first.next.id);
  assert.strictEqual(repeated.next.id, first.next.id);
  assert.strictEqual(repeated.alreadyDone, true);
  assert.strictEqual(store.getTask(task.id).repeatNextId, first.next.id);
});

test('重复任务：升级前生成的下一次任务会被复用并补齐链路', () => {
  reset();
  const source = store.createTask({
    title: '旧版每日任务',
    repeat: 'daily',
    due: '2026-08-18 09:00',
    status: 'done'
  });
  const legacyNext = store.createTask({
    title: '旧版每日任务',
    repeat: 'daily',
    due: '2026-08-19 09:00'
  });
  store.updateTask(source.id, { status: 'todo' });

  const result = store.completeTask(source.id);
  const matches = store.getAllTasks().filter((t) => t.title === source.title && t.due === legacyNext.due);
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(result.next.id, legacyNext.id);
  assert.strictEqual(store.getTask(source.id).repeatNextId, legacyNext.id);
  assert.strictEqual(store.getTask(legacyNext.id).repeatSourceId, source.id);
});

test('保存并完成：新建和编辑均保留完整完成语义', () => {
  reset();
  const originalRename = fs.renameSync;
  let writes = 0;
  let created;
  let updated;
  try {
    fs.renameSync = (...args) => {
      writes++;
      return originalRename(...args);
    };
    created = store.saveAndCompleteTask(null, {
      title: '每日整理',
      repeat: 'daily',
      due: '2026-08-18 19:00',
      pri: 3
    });
    assert.strictEqual(writes, 1, '新建并完成应只写盘一次');

    const existing = store.createTask({ title: '待完善', due: '2026-08-20 18:00' });
    writes = 0;
    updated = store.saveAndCompleteTask(existing.id, {
      title: '已经完善',
      due: '2026-08-21 18:00',
      pri: 4,
      status: 'done'
    });
    assert.strictEqual(writes, 1, '编辑并完成应只写盘一次');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(created.task.status, 'done');
  assert.strictEqual(created.next.due, '2026-08-19 19:00');
  assert.strictEqual(updated.task.title, '已经完善');
  assert.strictEqual(updated.task.pri, 4);
  assert.strictEqual(updated.task.status, 'done');
  assert.ok(updated.task.completedAt);
});

test('重复任务：无截止时间不生成', () => {
  reset();
  const t = store.createTask({ title: '无截止重复', repeat: 'daily', due: null });
  const res = store.completeTask(t.id);
  assert.strictEqual(res.next, null);
});

/* ============ 17. 子任务 ============ */
test('子任务：对象化带 id，可单独勾选', () => {
  reset();
  const t = store.createTask({ title: '带子任务', children: ['步骤1', '步骤2'] });
  assert.ok(t.children[0].id, '子任务应有 id');
  assert.strictEqual(t.children[0].title, '步骤1');
  assert.strictEqual(t.children[0].done, false);
  // 勾选第一个
  const children = t.children.map((c, i) => i === 0 ? Object.assign({}, c, { done: true }) : c);
  const updated = store.updateTask(t.id, { children });
  assert.strictEqual(updated.children[0].done, true);
});

/* ============ 18. 排序 ============ */
test('排序：reorderTasks 持久化顺序', () => {
  reset();
  const a = store.createTask({ title: '排序A' });
  const b = store.createTask({ title: '排序B' });
  const c = store.createTask({ title: '排序C' });
  store.reorderTasks([c.id, a.id, b.id]);
  const all = store.getAllTasks();
  const order = all.filter((t) => [a.id, b.id, c.id].includes(t.id))
    .sort((x, y) => x.order - y.order).map((t) => t.title);
  assert.deepStrictEqual(order, ['排序C', '排序A', '排序B']);
});

/* ============ 19. 批量操作 ============ */
test('批量：batchUpdate 批量完成', () => {
  reset();
  const a = store.createTask({ title: '批量1' });
  const b = store.createTask({ title: '批量2' });
  store.batchUpdate([a.id, b.id], { status: 'done' });
  assert.strictEqual(store.getTask(a.id).status, 'done');
  assert.strictEqual(store.getTask(b.id).status, 'done');
});

test('批量完成：重复任务生成下一次并跳过已完成与归档任务', () => {
  reset();
  const recurring = store.createTask({ title: '每日复盘', repeat: 'daily', due: '2026-08-18 20:00' });
  const done = store.createTask({ title: '已经完成' });
  const archived = store.createTask({ title: '已经归档' });
  store.completeTask(done.id);
  store.archiveTask(archived.id);

  const result = store.batchComplete([recurring.id, done.id, archived.id, recurring.id]);

  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.skipped, 2);
  assert.strictEqual(result.generated.length, 1);
  assert.strictEqual(result.generated[0].due, '2026-08-19 20:00');
  assert.strictEqual(store.getTask(recurring.id).status, 'done');
  assert.strictEqual(store.getTask(archived.id).status, 'archived');
});

test('批量：batchDelete 批量删除进回收站', () => {
  reset();
  const a = store.createTask({ title: '批量删1' });
  const b = store.createTask({ title: '批量删2' });
  store.batchDelete([a.id, b.id]);
  assert.strictEqual(store.getDeletedTasks().length, 2);
});

/* ============ 20. 回收站 ============ */
test('回收站：删除后可查询并恢复', () => {
  reset();
  const t = store.createTask({ title: '回收站测试' });
  store.deleteTask(t.id);
  const deleted = store.getDeletedTasks();
  assert.strictEqual(deleted.length, 1);
  assert.strictEqual(deleted[0].title, '回收站测试');
  const restored = store.restoreTask(t.id);
  assert.strictEqual(restored.title, '回收站测试');
  assert.strictEqual(store.getDeletedTasks().length, 0);
});

test('回收站：emptyTrash 清空', () => {
  reset();
  const t = store.createTask({ title: '清空测试' });
  store.deleteTask(t.id);
  store.emptyTrash();
  assert.strictEqual(store.getDeletedTasks().length, 0);
});

/* ============ 21. 顺延 ============ */
test('顺延：postponeTask 推迟到明天', () => {
  reset();
  const t = store.createTask({ title: '顺延测试', due: '2026-08-18 10:00' });
  const updated = store.postponeTask(t.id, 1);
  assert.strictEqual(updated.due, '2026-08-19 10:00');
});

/* ============ 22. AI 完成重复任务 ============ */
test('AI：完成重复任务自动生成下一次', () => {
  reset();
  const t = store.createTask({ title: 'AI重复任务', repeat: 'weekly', due: '2026-08-18 15:00' });
  const r = ai.handle('完成 AI重复任务');
  assert.strictEqual(r.type, 'complete');
  const next = store.getAllTasks().find((x) => x.title === 'AI重复任务' && x.status !== 'done');
  assert.ok(next, '应生成下一次任务');
  assert.strictEqual(next.due, '2026-08-25 15:00');
});

/* ============ 23. 词库扩充 ============ */
test('扩充：帮我看看今天有什么 → query', () => {
  reset();
  const r = ai.handle('帮我看看今天有什么');
  assert.strictEqual(r.intent, 'query');
});

test('扩充：记得周五交材料 → create', () => {
  reset();
  const r = ai.handle('记得周五交材料');
  assert.strictEqual(r.intent, 'create');
  assert.strictEqual(r.task.title, '交材料');
});

test('扩充：把那个方案删掉 → delete', () => {
  reset();
  store.createTask({ title: '产品方案' });
  const r = ai.handle('把那个方案删掉');
  assert.strictEqual(r.intent, 'delete');
});

test('扩充：明天要交周报吗 → 不误判 create', () => {
  reset();
  const r = ai.handle('明天要交周报吗');
  // 含疑问词「吗」，不应误判为 create
  assert.notStrictEqual(r.intent, 'create');
});

test('歧义选择：按任务 ID 继续原操作，不重新猜测任务名', () => {
  reset();
  const first = store.createTask({ title: '产品方案 A', pri: 2 });
  const second = store.createTask({ title: '产品方案 B', pri: 2 });
  const ask = ai.handle('把 产品方案 改成紧急');

  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.intent, 'update');
  assert.strictEqual(ask.params.pri, 4);
  assert.strictEqual(ask.candidates.length, 2);
  assert.deepStrictEqual(ask.candidates[1], {
    id: second.id,
    title: '产品方案 B',
    project: '',
    due: null,
    status: 'todo'
  });

  const result = ai.resolve(ask.intent, ask.params, second.id);
  assert.strictEqual(result.type, 'update');
  assert.strictEqual(store.getTask(first.id).pri, 2);
  assert.strictEqual(store.getTask(second.id).pri, 4);
});

test('歧义选择：拒绝不支持的意图', () => {
  reset();
  const task = store.createTask({ title: '保留任务' });
  const result = ai.resolve('batch', { text: '清除所有任务' }, task.id);
  assert.strictEqual(result.type, 'error');
  assert.ok(store.getTask(task.id));
});

test('歧义选择：可按任务 ID 从回收站恢复指定任务', () => {
  reset();
  const first = store.createTask({ title: '恢复候选 A' });
  const second = store.createTask({ title: '恢复候选 B' });
  store.deleteTask(first.id);
  store.deleteTask(second.id);

  const ask = ai.handle('恢复 恢复候选');
  assert.strictEqual(ask.type, 'ask');
  assert.strictEqual(ask.intent, 'restore');

  const result = ai.resolve(ask.intent, ask.params, second.id);
  assert.strictEqual(result.type, 'restore');
  assert.ok(store.getTask(second.id));
  assert.ok(store.getDeletedTasks().some((task) => task.id === first.id));
});

/* ============ 24. 查询筛选 ============ */
test('筛选：我有哪些紧急任务 → pri=4', () => {
  reset();
  store.createTask({ title: '紧急任务A', pri: 4 });
  store.createTask({ title: '普通任务B', pri: 2 });
  const r = ai.handle('我有哪些紧急任务');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('紧急任务A'));
  assert.ok(!r.message.includes('普通任务B'));
});

test('筛选：#工作 的任务 → 按标签过滤', () => {
  reset();
  store.createTask({ title: '工作项', tags: ['工作'] });
  store.createTask({ title: '生活项', tags: ['生活'] });
  const r = ai.handle('#工作 的任务');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('工作项'));
  assert.ok(!r.message.includes('生活项'));
});

test('筛选：进行中的任务 → status=doing', () => {
  reset();
  store.createTask({ title: '进行中的A', status: 'doing' });
  store.createTask({ title: '待办的B', status: 'todo' });
  const r = ai.handle('进行中的任务有哪些');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('进行中的A'));
  assert.ok(!r.message.includes('待办的B'));
});

/* ============ 25. 统计问答 ============ */
test('统计：今天完成了多少 → stats', () => {
  reset();
  const t = store.createTask({ title: '统计任务' });
  store.updateTask(t.id, { status: 'done' });
  const r = ai.handle('今天完成了多少');
  assert.strictEqual(r.intent, 'stats');
  assert.ok(r.message.includes('今天已完成'));
});

test('统计：完成率 → stats', () => {
  reset();
  const a = store.createTask({ title: '完成率A' });
  store.updateTask(a.id, { status: 'done' });
  const r = ai.handle('完成率多少');
  assert.strictEqual(r.intent, 'stats');
  assert.ok(r.message.includes('完成率'));
});

/* ============ 26. 多轮上下文 ============ */
test('多轮：指代「那个任务」', () => {
  reset();
  store.createTask({ title: '上下文任务' });
  ai.handle('开始 上下文任务');
  const r = ai.handle('那个任务完成了吗');
  assert.strictEqual(r.intent, 'query');
  assert.ok(r.message.includes('上下文任务'));
});

/* ============ 27. 问候 ============ */
test('问候：你好', () => {
  reset();
  const r = ai.handle('你好');
  assert.strictEqual(r.intent, 'greeting');
  assert.ok(r.message.includes('你好'));
});

test('感谢：谢谢', () => {
  reset();
  const r = ai.handle('谢谢');
  assert.strictEqual(r.intent, 'thanks');
});

/* ============ 28. 通用对话（知识问答） ============ */
test('知识问答：什么是番茄工作法 → chat + 知识库命中', () => {
  reset();
  const r = ai.handle('什么是番茄工作法');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.type, 'chat');
  assert.ok(r.message.includes('番茄'));
});

test('知识问答：四象限法则', () => {
  reset();
  const r = ai.handle('什么是四象限法则');
  assert.strictEqual(r.intent, 'chat');
  assert.ok(r.message.includes('四象限'));
});

test('知识问答：你是谁', () => {
  reset();
  const r = ai.handle('你是谁');
  assert.strictEqual(r.intent, 'chat');
  assert.ok(r.message.includes('工作台助手'));
});

test('知识问答：今天星期几', () => {
  reset();
  const r = ai.handle('今天星期几');
  assert.strictEqual(r.intent, 'chat');
  assert.ok(r.message.includes('星期'));
});

test('闲聊：未命中知识库 → 引导配置', () => {
  reset();
  const r = ai.handle('给我讲个关于宇宙的故事');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.type, 'chat');
  assert.ok(r.message.length > 0);
});

test('闲聊：不执行任何任务操作', () => {
  reset();
  const before = store.getAllTasks().length;
  ai.handle('推荐一部好看的电影');
  assert.strictEqual(store.getAllTasks().length, before, '闲聊不应创建任务');
});

/* ============ 29. 批量操作 ============ */
test('批量：清除所有任务', () => {
  reset();
  const before = store.getAllTasks().length;
  const r = ai.handle('清除所有任务');
  assert.strictEqual(r.intent, 'batch');
  assert.strictEqual(r.type, 'batch');
  assert.ok(r.message.includes('清除'));
  assert.strictEqual(store.getAllTasks().length, 0);
});

test('批量：全部完成', () => {
  reset();
  const originalPending = store.getAllTasks().filter((t) => t.status !== 'done' && t.status !== 'archived');
  const recurring = originalPending.find((t) => t.repeat && t.due);
  const r = ai.handle('全部任务都完成');
  assert.strictEqual(r.intent, 'batch');
  assert.strictEqual(r.type, 'batch');
  originalPending.forEach((task) => {
    assert.strictEqual(store.getTask(task.id).status, 'done', `原任务「${task.title}」应已完成`);
  });
  if (recurring) {
    const generated = store.getAllTasks().find((t) => t.id !== recurring.id && t.title === recurring.title && t.status === 'todo');
    assert.ok(generated, '重复任务应生成下一次待办');
    assert.ok(r.message.includes('下次任务'));
  }
});

test('批量：按优先级删除紧急任务', () => {
  reset();
  store.createTask({ title: '紧急A', pri: 4 });
  store.createTask({ title: '普通B', pri: 2 });
  const r = ai.handle('把紧急任务都删掉');
  assert.strictEqual(r.intent, 'batch');
  assert.strictEqual(r.type, 'batch');
  const urgent = store.getAllTasks().filter((t) => t.pri === 4);
  assert.strictEqual(urgent.length, 0, '紧急任务应被删除');
  assert.ok(store.getAllTasks().some((t) => t.title === '普通B'), '普通任务应保留');
});

test('批量：按标签删除', () => {
  reset();
  store.createTask({ title: '工作项', tags: ['工作'] });
  store.createTask({ title: '生活项', tags: ['生活'] });
  const r = ai.handle('把所有工作标签的任务删掉');
  assert.strictEqual(r.intent, 'batch');
  assert.strictEqual(r.type, 'batch');
  assert.ok(!store.getAllTasks().some((t) => t.title === '工作项'), '工作标签任务应删除');
  assert.ok(store.getAllTasks().some((t) => t.title === '生活项'), '生活标签任务应保留');
});

test('批量：清空回收站', () => {
  reset();
  const t = store.createTask({ title: '待删任务' });
  store.deleteTask(t.id);
  const r = ai.handle('清空回收站');
  assert.strictEqual(r.intent, 'batch');
  assert.strictEqual(r.type, 'batch');
  assert.strictEqual(store.getDeletedTasks().length, 0, '回收站应清空');
});

/* ============ 备份与恢复 ============ */
test('备份：创建备份并列出', () => {
  reset();
  const file = store.backup();
  assert.ok(file, '应返回备份文件路径');
  const list = store.listBackups();
  assert.ok(Array.isArray(list), '应返回备份列表');
  assert.ok(list.length >= 1, '至少有一份备份');
  assert.ok(list[0].name && list[0].path && list[0].size >= 0, '备份项应含名称/路径/大小');
});

test('备份：从备份恢复覆盖当前数据', () => {
  reset();
  // 先创建一份备份（含当前种子数据）
  const file = store.backup();
  // 清空并新增一条任务，模拟数据变化
  store.clearAllTasks();
  store.createTask({ title: '临时任务' });
  assert.strictEqual(store.getAllTasks().length, 1, '当前应只有临时任务');
  // 恢复到备份点
  const res = store.restoreFromBackup(file);
  assert.strictEqual(res.ok, true);
  assert.ok(res.count > 1, '恢复后任务数应多于 1');
  assert.ok(!store.getAllTasks().some((t) => t.title === '临时任务'), '临时任务应被覆盖');
});

test('备份：备份到外部目录', () => {
  reset();
  const dir = path.join(DATA_DIR, 'external-backup');
  const file = store.backupToDir(dir);
  assert.ok(file, '应返回外部备份文件路径');
  assert.ok(fs.existsSync(file), '外部备份文件应存在');
});

/* ============ 周报生成 ============ */
test('周报：生成本周 Markdown 周报', () => {
  reset();
  // 完成一条任务，确保有完成记录
  const t = store.createTask({ title: '周报测试任务', project: '测试项目', tags: ['工作'] });
  store.completeTask(t.id);
  const md = store.generateWeeklyReport(0);
  assert.ok(md.includes('# 工作周报'), '应包含周报标题');
  assert.ok(md.includes('本周完成'), '应包含本周概览');
  assert.ok(md.includes('周报测试任务'), '应包含完成的任务');
  assert.ok(md.includes('测试项目'), '应包含项目统计');
  assert.ok(md.includes('工作'), '应包含标签统计');
});

test('周报：上周/下周偏移不报错', () => {
  reset();
  const last = store.generateWeeklyReport(-1);
  const next = store.generateWeeklyReport(1);
  assert.ok(last.includes('# 工作周报'));
  assert.ok(next.includes('# 工作周报'));
});

/* ============ 精细化管理：update / child / postpone / restore ============ */
test('精细修改：改优先级', () => {
  reset();
  const t = store.createTask({ title: '写方案', pri: 2 });
  const r = ai.handle('把 写方案 改成紧急');
  assert.strictEqual(r.intent, 'update');
  assert.strictEqual(r.type, 'update');
  const updated = store.getTask(t.id);
  assert.strictEqual(updated.pri, 4, '优先级应改为紧急');
  assert.deepStrictEqual(r.undo.patch, { pri: 2 });
  assert.deepStrictEqual(r.undo.expected, { pri: 4 });
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(t.id).pri, 2, '撤销后应恢复原优先级');
});

test('引擎选择：本地助手模式不调用已配置的真实模型', async () => {
  reset();
  const previous = store.getSettings();
  store.updateSettings({
    aiStage: 'mock',
    aiProvider: 'custom',
    aiBaseUrl: 'https://example.invalid/v1',
    aiApiKey: 'test-key',
    aiModel: 'test-model'
  });
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('不应调用真实模型');
  };
  try {
    const r = await ai.handleAuto('你好');
    assert.strictEqual(r.engine, 'mock');
    assert.strictEqual(r.degraded, undefined);
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    store.updateSettings({
      aiStage: previous.aiStage,
      aiProvider: previous.aiProvider,
      aiBaseUrl: previous.aiBaseUrl,
      aiApiKey: previous.aiApiKey,
      aiModel: previous.aiModel
    });
  }
});

test('精细修改：旧撤销不覆盖后续修改', () => {
  reset();
  const t = store.createTask({ title: '写方案', pri: 2 });
  const r = ai.handle('把 写方案 改成紧急');
  store.updateTask(t.id, { pri: 3 });
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, false);
  assert.strictEqual(undone.reason, 'conflict');
  assert.strictEqual(store.getTask(t.id).pri, 3, '冲突时应保留后续修改');
});

test('精细修改：改截止时间', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('把 写方案 改到明天下午3点');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.ok(updated.due && updated.due.includes('15:00'), '截止时间应改为 15:00');
});

test('精细修改：改项目', () => {
  reset();
  const t = store.createTask({ title: '写方案', project: 'Q3 规划' });
  const r = ai.handle('把 写方案 移到 日常工作');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.strictEqual(updated.project, '日常工作', '项目应改为日常工作');
});

test('精细修改：加标签', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('给 写方案 加标签 重要');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.ok(updated.tags.includes('重要'), '应添加标签「重要」');
  // 加标签「重要」不应误改优先级
  assert.strictEqual(updated.pri, 2, '优先级不应被误改');
});

test('精细修改：加备注', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('给 写方案 加备注 记得带资料');
  assert.strictEqual(r.intent, 'update');
  const updated = store.getTask(t.id);
  assert.strictEqual(updated.desc, '记得带资料', '应更新备注');
});

test('子任务：加子任务', () => {
  reset();
  const t = store.createTask({ title: '写方案' });
  const r = ai.handle('给 写方案 加子任务 搭框架');
  assert.strictEqual(r.intent, 'child');
  const updated = store.getTask(t.id);
  assert.ok(updated.children.some((c) => (c.title || c) === '搭框架'), '应添加子任务「搭框架」');
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(t.id).children.length, 0, '撤销后应移除新增子任务');
});

test('顺延：推迟任务', () => {
  reset();
  const t = store.createTask({ title: '写方案', due: '2026-08-20 15:00' });
  const r = ai.handle('把 写方案 推迟 3 天');
  assert.strictEqual(r.intent, 'postpone');
  const updated = store.getTask(t.id);
  assert.ok(updated.due.includes('2026-08-23'), '应推迟 3 天');
  const undone = ai.undoAction(r.undo);
  assert.strictEqual(undone.ok, true);
  assert.strictEqual(store.getTask(t.id).due, '2026-08-20 15:00', '撤销后应恢复原截止时间');
});

test('恢复：从回收站恢复', () => {
  reset();
  const t = store.createTask({ title: '待恢复任务' });
  store.deleteTask(t.id);
  const r = ai.handle('恢复 待恢复任务');
  assert.strictEqual(r.intent, 'restore');
  assert.ok(store.getAllTasks().some((x) => x.title === '待恢复任务'), '任务应恢复');
});
