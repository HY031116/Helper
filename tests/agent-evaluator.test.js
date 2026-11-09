'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const evaluator = require('../src/main/agent/evaluator');
const { RequestCoordinator } = require('../src/main/agent/request-coordinator');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agent-eval-scenarios.json'), 'utf8'));
const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'agent-eval.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function state(taskPatch) {
  return {
    tasks: [Object.assign({ id: 101, title: '核对清单', status: 'todo', pri: 2, due: null }, taskPatch || {})],
    memos: []
  };
}

test('Agent 评测器：按结果、数据状态和待处理状态给出可读失败原因', () => {
  const before = state();
  const after = state({ status: 'done' });
  const store = { getAgentState: () => ({ pending: null }) };
  const failures = evaluator.evaluateTurn({
    result: { intent: 'complete', type: 'complete' },
    tasks: [{ title: '核对清单', status: 'done' }],
    pendingKind: null
  }, {
    intent: 'complete', type: 'complete', task: after.tasks[0]
  }, before, after, store);
  assert.deepStrictEqual(failures, []);

  const unsafe = evaluator.evaluateTurn({ noDataMutation: true }, { type: 'confirm' }, before, after, store);
  assert.deepStrictEqual(unsafe, ['本轮不应修改任务或备忘录']);
});

test('Agent 请求协调器：活动重复、完成重放和取消都不会创建第二次执行', () => {
  let now = 1000;
  const coordinator = new RequestCoordinator({ ttlMs: 300, maxCompleted: 2, now: () => now });
  const first = coordinator.begin('window-1', 'request-1');
  assert.strictEqual(first.status, 'started');
  assert.strictEqual(coordinator.begin('window-1', 'request-1').status, 'active');
  assert.strictEqual(coordinator.cancel('window-2', 'request-1'), false);
  assert.strictEqual(coordinator.cancel('window-1', 'request-1'), true);
  assert.strictEqual(first.controller.signal.aborted, true);

  const persisted = { type: 'cancelled', chatPersisted: true };
  coordinator.complete(first.key, persisted);
  coordinator.release(first.key);
  const replay = coordinator.begin('window-1', 'request-1');
  assert.strictEqual(replay.status, 'completed');
  assert.strictEqual(replay.result, persisted);

  now += 301;
  assert.strictEqual(coordinator.begin('window-1', 'request-1').status, 'started');
});

test('Agent 评测器：报告只保留结构化结果并正确计算验收指标', () => {
  assert.deepStrictEqual(evaluator.sanitizeResult({
    intent: 'delete', type: 'confirm', confidence: 'high', engine: 'llm', message: '敏感正文', params: { secret: 'x' }
  }), {
    intent: 'delete', type: 'confirm', confidence: 'high', engine: 'llm', agentSteps: [], degraded: false,
    fallbackMode: null, retryable: false, operationCount: 0
  });
  const metrics = evaluator.summarizeScenarios([
    { passed: true, dangerous: true, recovery: false, failures: [], unnecessaryClarifications: 0, turns: [{ durationMs: 100, firstFeedbackMs: 20, engine: 'local-fast' }] },
    { passed: false, dangerous: false, recovery: true, failures: ['失败'], unnecessaryClarifications: 1, turns: [{ durationMs: 300, firstFeedbackMs: 400, engine: 'llm' }] }
  ]);
  assert.strictEqual(metrics.successRate, 50);
  assert.strictEqual(metrics.dangerousMisoperations, 0);
  assert.strictEqual(metrics.unnecessaryClarificationRate, 50);
  assert.strictEqual(metrics.recoveryFailures, 1);
  assert.strictEqual(metrics.averageLatencyMs, 200);
  assert.strictEqual(metrics.p95LatencyMs, 300);
  assert.strictEqual(metrics.p95FirstFeedbackMs, 400);
  assert.strictEqual(metrics.fastPathTurns, 1);
  assert.strictEqual(metrics.p95FastPathMs, 100);
  assert.strictEqual(metrics.slowFirstFeedbackTurns, 1);
});

test('Agent 评测器：多步轨迹按相对顺序断言且报告保留步骤名', () => {
  const store = { getAgentState: () => ({ pending: null }) };
  const before = state();
  const result = { intent: 'start', type: 'start', agentSteps: ['query', 'start'] };

  assert.deepStrictEqual(evaluator.evaluateTurn({
    agentStepsIncludes: ['query', 'start']
  }, result, before, before, store), []);
  // 乱序、缺失和空轨迹都要给出可读失败
  assert.deepStrictEqual(evaluator.evaluateTurn({
    agentStepsIncludes: ['start', 'query']
  }, result, before, before, store),
  ['result.agentSteps 未按顺序包含 query，实际 ["query","start"]']);
  assert.deepStrictEqual(evaluator.evaluateTurn({
    agentStepsIncludes: ['start']
  }, { type: 'start' }, before, before, store), ['result.agentSteps 未按顺序包含 start，实际 []']);
  assert.deepStrictEqual(evaluator.evaluateTurn({
    agentSteps: ['query', 'start']
  }, result, before, before, store), []);
  assert.ok(evaluator.evaluateTurn({ agentSteps: ['start', 'query'] }, result, before, before, store)
    .some((failure) => failure.includes('agentSteps 期望')));
  // sanitize 只保留步骤名，不带入正文
  assert.deepStrictEqual(evaluator.sanitizeResult(result).agentSteps, ['query', 'start']);
});

test('Agent 评测场景：覆盖核心类别、安全和恢复路径', () => {
  assert.strictEqual(fixture.version, 2);
  assert.ok(fixture.scenarios.length >= 15);
  const ids = fixture.scenarios.map((scenario) => scenario.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(fixture.scenarios.some((scenario) => scenario.dangerous));
  assert.ok(fixture.scenarios.some((scenario) => scenario.recovery));
  assert.ok(fixture.scenarios.some((scenario) => scenario.liveOnly && scenario.turns.some((turn) => turn.cancelOnStage)));
  assert.ok(fixture.scenarios.some((scenario) => scenario.category === 'multi-action'));
  // Agent 多步轨迹场景是回归基线的一部分
  assert.ok(fixture.scenarios.filter((scenario) => scenario.category === 'agent-loop').length >= 2);
  assert.ok(Array.isArray(fixture.offlineScenarios) && fixture.offlineScenarios.length >= 5);
  assert.ok(fixture.offlineScenarios.some((scenario) => scenario.dangerous));
  fixture.scenarios.forEach((scenario) => {
    assert.ok(scenario.id && scenario.category);
    assert.ok(Array.isArray(scenario.turns) && scenario.turns.length > 0);
    scenario.turns.forEach((turn) => assert.ok(turn.input && turn.expect));
  });
});

test('Agent 评测入口：默认真实模型、支持离线和单场景回放且报告目录被忽略', () => {
  assert.match(packageJson.scripts['eval:agent'], /scripts\/agent-eval\.js/);
  assert.match(packageJson.scripts['eval:agent:offline'], /--offline/);
  assert.match(runner, /--scenario/);
  assert.match(runner, /retryAttempts/);
  assert.match(runner, /result\.retryable/);
  assert.match(runner, /transientModelFailure/);
  assert.match(runner, /maxFirstFeedbackMs/);
  assert.match(runner, /progressStages/);
  assert.match(runner, /AI_REQUEST_CANCELLED/);
  assert.match(runner, /controller\.abort\(\)/);
  assert.match(runner, /fixture\.offlineScenarios/);
  assert.match(runner, /latest-\$\{report\.mode\}\.json/);
  assert.match(runner, /error\.code === 'EPIPE'/);
  assert.doesNotMatch(runner, /process\.stdout\.write\(`\[agent-eval\]/);
  assert.match(runner, /work-helper-agent-eval-/);
  assert.match(runner, /\.work-helper-data', 'agent-eval/);
  assert.doesNotMatch(runner, /process\.stdout\.write\([^\n]*aiApiKey/);
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.work-helper-data\/$/m);
});
