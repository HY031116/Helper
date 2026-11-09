'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

let stdoutAvailable = true;
let stderrAvailable = true;
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') stdoutAvailable = false;
});
process.stderr.on('error', (error) => {
  if (error && error.code === 'EPIPE') stderrAvailable = false;
});

function writeOutput(message) {
  if (!stdoutAvailable || process.stdout.destroyed) return;
  try {
    process.stdout.write(message);
  } catch (error) {
    if (error && error.code === 'EPIPE') stdoutAvailable = false;
  }
}

function writeError(message) {
  if (!stderrAvailable || process.stderr.destroyed) return;
  try {
    process.stderr.write(message);
  } catch (error) {
    if (error && error.code === 'EPIPE') stderrAvailable = false;
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function resolveDue(value) {
  const match = String(value || '').match(/^@(today|tomorrow|yesterday)(?:\s+(\d{2}:\d{2}))?$/);
  if (!match) return value || null;
  const date = new Date();
  if (match[1] === 'tomorrow') date.setDate(date.getDate() + 1);
  if (match[1] === 'yesterday') date.setDate(date.getDate() - 1);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${match[2] || '18:00'}`;
}

function resolveFixtureEntity(entity) {
  return Object.assign({}, entity, { due: resolveDue(entity && entity.due) });
}

function scenarioHash(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

function transientModelFailure(result) {
  if (!result || !result.degraded) return false;
  return /(aborted|timeout|network unavailable|fetch failed|\(429\)|\(5\d\d\))/i.test(String(result.degradeReason || ''));
}

function restoreAgentState(store, snapshot) {
  store.clearAgentState();
  if (snapshot) store.updateAgentState(snapshot);
}

function resetScenario(store, scenario) {
  store.clearAllTasks();
  store.getAllMemos().forEach((memo) => store.deleteMemo(memo.id));
  store.emptyMemoTrash();
  store.clearChat();
  const tasks = store.importTasks((scenario.setup && scenario.setup.tasks || []).map(resolveFixtureEntity));
  store.importMemos((scenario.setup && scenario.setup.memos || []).map(resolveFixtureEntity));
  (scenario.setup && scenario.setup.deletedTasks || []).forEach((title) => {
    const task = tasks.find((item) => item.title === title);
    if (task) store.deleteTask(task.id);
  });
}

async function runScenario(scenario, ai, store, evaluator, live) {
  resetScenario(store, scenario);
  const turns = [];
  const failures = [];
  let clarificationCount = 0;

  for (let index = 0; index < scenario.turns.length; index++) {
    const turn = scenario.turns[index];
    const before = evaluator.comparableState(store);
    const agentBefore = JSON.parse(JSON.stringify(store.getAgentState()));
    const startedAt = Date.now();
    let result;
    let retryAttempts = 0;
    let firstFeedbackMs = null;
    const progressStages = [];
    const controller = new AbortController();
    for (;;) {
      try {
        result = live ? await ai.handleAuto(turn.input, {
          signal: controller.signal,
          onProgress(progress) {
            if (firstFeedbackMs === null) firstFeedbackMs = Date.now() - startedAt;
            if (progress && progress.stage && !progressStages.includes(progress.stage)) progressStages.push(progress.stage);
            if (turn.cancelOnStage && progress && progress.stage === turn.cancelOnStage && !controller.signal.aborted) {
              controller.abort();
            }
          }
        }) : ai.handle(turn.input);
      } catch (error) {
        result = error && error.code === 'AI_REQUEST_CANCELLED'
          ? { intent: 'cancel', type: 'cancelled', cancelled: true, message: '已停止。本次请求没有执行任何操作。' }
          : { intent: 'unknown', type: 'error', message: error.message, unhandled: true };
      }
      const retryableResult = result && ((result.type === 'error' && result.retryable) || transientModelFailure(result));
      const retryableWithoutMutation = live && retryAttempts < 1 && retryableResult &&
        JSON.stringify(before) === JSON.stringify(evaluator.comparableState(store));
      if (!retryableWithoutMutation) break;
      retryAttempts += 1;
      restoreAgentState(store, agentBefore);
    }
    const durationMs = Date.now() - startedAt;
    const after = evaluator.comparableState(store);
    const turnFailures = evaluator.evaluateTurn(turn.expect, result, before, after, store);
    if (Number.isFinite(turn.expect.maxDurationMs) && durationMs > turn.expect.maxDurationMs) {
      turnFailures.push(`耗时 ${durationMs}ms 超过 ${turn.expect.maxDurationMs}ms`);
    }
    if (Number.isFinite(turn.expect.maxFirstFeedbackMs) &&
      (!Number.isFinite(firstFeedbackMs) || firstFeedbackMs > turn.expect.maxFirstFeedbackMs)) {
      turnFailures.push(`首个反馈 ${firstFeedbackMs === null ? '缺失' : `${firstFeedbackMs}ms`}，目标 ${turn.expect.maxFirstFeedbackMs}ms`);
    }
    if (result.type === 'ask' || result.type === 'clarify') clarificationCount += 1;
    failures.push(...turnFailures.map((failure) => `第 ${index + 1} 轮：${failure}`));
    turns.push(Object.assign({ index: index + 1, durationMs, firstFeedbackMs, progressStages, retryAttempts }, evaluator.sanitizeResult(result)));
    try {
      store.appendChatEntries([
        { role: 'user', text: turn.input, ts: Date.now() },
        { role: 'ai', text: result.message || '', ts: Date.now() + 1 }
      ]);
    } catch (error) {
      failures.push(`第 ${index + 1} 轮：对话记录写入失败`);
    }
  }

  const unnecessaryClarifications = Math.max(0, clarificationCount - Number(scenario.maxClarifications || 0));
  if (unnecessaryClarifications) failures.push(`出现 ${unnecessaryClarifications} 次超出预期的追问`);
  return {
    id: scenario.id,
    idHash: scenarioHash(scenario.id),
    category: scenario.category,
    dangerous: !!scenario.dangerous,
    recovery: !!scenario.recovery,
    passed: failures.length === 0,
    unnecessaryClarifications,
    failures,
    turns
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const fixtureFile = path.resolve(argValue('--fixtures') || path.join(root, 'tests', 'fixtures', 'agent-eval-scenarios.json'));
  const productionSettingsFile = path.resolve(argValue('--settings') || path.join(app.getPath('appData'), 'work-helper', 'data', 'settings.json'));
  const live = !hasArg('--offline');
  if (live && !fs.existsSync(productionSettingsFile)) throw new Error('没有找到工作台助手的真实模型配置');

  const productionSettings = live ? readJson(productionSettingsFile) : {};
  if (live && !(productionSettings.aiApiKey && productionSettings.aiBaseUrl && productionSettings.aiModel)) {
    throw new Error('真实模型配置不完整，请先在软件设置中完成连接配置');
  }

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-helper-agent-eval-'));
  process.env.WORK_HELPER_DATA_DIR = path.join(sandboxRoot, 'data');
  const store = require('../src/main/store');
  const ai = require('../src/main/ai');
  const evaluator = require('../src/main/agent/evaluator');
  const fixture = readJson(fixtureFile);
  const requestedId = argValue('--scenario');
  const limit = Number(argValue('--limit')) || 0;
  let scenarios = live ? (fixture.scenarios || []) : (fixture.offlineScenarios || []);
  if (requestedId) scenarios = scenarios.filter((scenario) => scenario.id === requestedId);
  if (limit > 0) scenarios = scenarios.slice(0, limit);
  if (!scenarios.length) throw new Error('没有匹配的评测场景');

  store.init();
  if (live) {
    store.updateSettings({
      aiStage: 'llm',
      aiProvider: productionSettings.aiProvider,
      aiBaseUrl: productionSettings.aiBaseUrl,
      aiApiKey: productionSettings.aiApiKey,
      aiModel: productionSettings.aiModel,
      aiTemperature: productionSettings.aiTemperature
    });
  }

  const results = [];
  try {
    for (const scenario of scenarios) {
      writeOutput(`[agent-eval] ${scenario.id} ... `);
      const result = await runScenario(scenario, ai, store, evaluator, live);
      results.push(result);
      writeOutput(`${result.passed ? 'PASS' : 'FAIL'}\n`);
    }
  } finally {
    try { fs.rmSync(sandboxRoot, { recursive: true, force: true }); } catch (error) { /* best effort */ }
  }

  const metrics = evaluator.summarizeScenarios(results);
  const report = {
    schemaVersion: 1,
    runAt: new Date().toISOString(),
    mode: live ? 'live' : 'offline',
    provider: live ? productionSettings.aiProvider : 'local',
    model: live ? productionSettings.aiModel : 'local-rules',
    fixtureVersion: fixture.version,
    metrics,
    scenarios: results
  };
  const outputDir = path.resolve(argValue('--output') || path.join(root, '.work-helper-data', 'agent-eval'));
  const stamp = report.runAt.replace(/[:.]/g, '-');
  const reportFile = path.join(outputDir, `agent-eval-${stamp}.json`);
  writeJson(reportFile, report);
  writeJson(path.join(outputDir, 'latest.json'), report);
  writeJson(path.join(outputDir, `latest-${report.mode}.json`), report);

  writeOutput(`\nAgent eval: ${metrics.passed}/${metrics.total} passed (${metrics.successRate}%)\n`);
  writeOutput(`Dangerous misoperations: ${metrics.dangerousMisoperations}\n`);
  writeOutput(`Unnecessary clarification rate: ${metrics.unnecessaryClarificationRate}%\n`);
  writeOutput(`Latency: avg ${metrics.averageLatencyMs}ms, p95 ${metrics.p95LatencyMs}ms\n`);
  writeOutput(`First feedback: avg ${metrics.averageFirstFeedbackMs}ms, p95 ${metrics.p95FirstFeedbackMs}ms\n`);
  writeOutput(`Report: ${reportFile}\n`);
  results.filter((result) => !result.passed).forEach((result) => {
    writeOutput(`- ${result.id}: ${result.failures.join('; ')}\n`);
  });
  process.exitCode = metrics.failed || metrics.dangerousMisoperations ? 1 : 0;
}

app.whenReady().then(main).then(() => app.exit(process.exitCode || 0)).catch((error) => {
  writeError(`[agent-eval] ${error.message}\n`);
  app.exit(1);
});
