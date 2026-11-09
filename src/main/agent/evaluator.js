'use strict';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function comparableState(store) {
  return {
    tasks: clone(store.getAllTasks()),
    memos: clone(store.getAllMemos())
  };
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesExpected(actual, expected) {
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function dateOffset(dateText) {
  if (!dateText) return null;
  const due = new Date(String(dateText).replace(' ', 'T') + ':00');
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86400000);
}

function findEntity(entities, expectation) {
  if (!expectation) return null;
  if (expectation.fromResult) return null;
  if (expectation.title) return entities.find((entity) => entity.title === expectation.title) || null;
  if (expectation.titleIncludes) {
    return entities.find((entity) => String(entity.title || '').includes(expectation.titleIncludes)) || null;
  }
  return null;
}

function assertEntity(label, entity, expectation, failures) {
  if (!expectation) return;
  const shouldExist = expectation.exists !== false;
  if (!entity) {
    if (shouldExist) failures.push(`${label}不存在`);
    return;
  }
  if (!shouldExist) {
    failures.push(`${label}不应存在`);
    return;
  }
  ['status', 'pri', 'pinned'].forEach((field) => {
    if (expectation[field] !== undefined && !matchesExpected(entity[field], expectation[field])) {
      failures.push(`${label}.${field} 期望 ${JSON.stringify(expectation[field])}，实际 ${JSON.stringify(entity[field])}`);
    }
  });
  if (expectation.titleIncludes && !String(entity.title || '').includes(expectation.titleIncludes)) {
    failures.push(`${label}.title 未包含 ${expectation.titleIncludes}`);
  }
  if (expectation.dueOffsetDays !== undefined && dateOffset(entity.due) !== expectation.dueOffsetDays) {
    failures.push(`${label}.due 不是今天偏移 ${expectation.dueOffsetDays} 天`);
  }
  if (expectation.dueTime !== undefined) {
    const actualTime = String(entity.due || '').split(' ')[1] || '';
    if (actualTime !== expectation.dueTime) {
      failures.push(`${label}.due 时间期望 ${expectation.dueTime}，实际 ${actualTime || '无'}`);
    }
  }
  if (expectation.childCount !== undefined) {
    const children = Array.isArray(entity.children) ? entity.children : [];
    if (children.length !== expectation.childCount) {
      failures.push(`${label}.children 数量期望 ${expectation.childCount}，实际 ${children.length}`);
    }
  }
  if (expectation.meaningfulChildren) {
    const titles = (Array.isArray(entity.children) ? entity.children : [])
      .map((child) => String(child && child.title || child || '').trim())
      .filter(Boolean);
    const unique = new Set(titles);
    const placeholders = titles.filter((title) => /(?:·|\s)?(?:第)?(?:步骤)?[一二三四五六七八九十\d]+$/.test(title));
    if (titles.length < 2 || unique.size !== titles.length || placeholders.length) {
      failures.push(`${label}.children 包含重复、空白或占位步骤`);
    }
  }
}

function evaluateTurn(expectation, result, before, after, store) {
  const expected = expectation || {};
  const failures = [];
  const resultExpected = expected.result || {};
  Object.entries(resultExpected).forEach(([field, value]) => {
    let actual = result && result[field];
    if (field === 'operationCount') actual = Array.isArray(result && result.operations) ? result.operations.length : 0;
    if (!matchesExpected(actual, value)) {
      failures.push(`result.${field} 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(actual)}`);
    }
  });

  // Agent 多步轨迹：要求出现的工具步骤必须全部按相对顺序执行
  if (expected.agentStepsIncludes !== undefined) {
    const actual = Array.isArray(result && result.agentSteps) ? result.agentSteps : [];
    let cursor = 0;
    expected.agentStepsIncludes.forEach((name) => {
      const found = actual.slice(cursor).indexOf(name);
      if (found === -1) failures.push(`result.agentSteps 未按顺序包含 ${name}，实际 ${JSON.stringify(actual)}`);
      else cursor += found + 1;
    });
  }
  if (expected.agentSteps !== undefined) {
    const actual = Array.isArray(result && result.agentSteps) ? result.agentSteps : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected.agentSteps)) {
      failures.push(`result.agentSteps 期望 ${JSON.stringify(expected.agentSteps)}，实际 ${JSON.stringify(actual)}`);
    }
  }

  if (expected.noDataMutation && !sameState(before, after)) failures.push('本轮不应修改任务或备忘录');
  if (expected.counts) {
    if (expected.counts.tasks !== undefined && after.tasks.length !== expected.counts.tasks) {
      failures.push(`任务数期望 ${expected.counts.tasks}，实际 ${after.tasks.length}`);
    }
    if (expected.counts.memos !== undefined && after.memos.length !== expected.counts.memos) {
      failures.push(`备忘录数期望 ${expected.counts.memos}，实际 ${after.memos.length}`);
    }
  }

  const resultTaskExpectation = expected.resultTask;
  const resultMemoExpectation = expected.resultMemo;
  if (resultTaskExpectation) assertEntity('result.task', result && result.task, resultTaskExpectation, failures);
  if (resultMemoExpectation) assertEntity('result.memo', result && result.memo, resultMemoExpectation, failures);
  (expected.tasks || []).forEach((item, index) => {
    assertEntity(`task[${index}]`, findEntity(after.tasks, item), item, failures);
  });
  (expected.memos || []).forEach((item, index) => {
    assertEntity(`memo[${index}]`, findEntity(after.memos, item), item, failures);
  });

  if (expected.pendingKind !== undefined) {
    const pending = store.getAgentState().pending;
    const actual = pending ? pending.kind : null;
    if (!matchesExpected(actual, expected.pendingKind)) {
      failures.push(`pending.kind 期望 ${JSON.stringify(expected.pendingKind)}，实际 ${JSON.stringify(actual)}`);
    }
  }
  if (expected.messageIncludes && !String(result && result.message || '').includes(expected.messageIncludes)) {
    failures.push(`回复未包含 ${expected.messageIncludes}`);
  }
  return failures;
}

function sanitizeResult(result) {
  return {
    intent: result && result.intent || 'unknown',
    type: result && result.type || 'unknown',
    confidence: result && result.confidence || null,
    engine: result && result.engine || null,
    agentSteps: Array.isArray(result && result.agentSteps) ? result.agentSteps : [],
    degraded: !!(result && result.degraded),
    fallbackMode: result && result.fallbackMode || null,
    retryable: !!(result && result.retryable),
    operationCount: Array.isArray(result && result.operations) ? result.operations.length : 0
  };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeScenarios(scenarios) {
  const total = scenarios.length;
  const passed = scenarios.filter((scenario) => scenario.passed).length;
  const latencies = scenarios.flatMap((scenario) => scenario.turns.map((turn) => turn.durationMs));
  const firstFeedbackLatencies = scenarios.flatMap((scenario) => scenario.turns
    .map((turn) => turn.firstFeedbackMs)
    .filter((value) => Number.isFinite(value)));
  const fastPathLatencies = scenarios.flatMap((scenario) => scenario.turns
    .filter((turn) => turn.engine === 'local-fast')
    .map((turn) => turn.durationMs));
  const dangerousMisoperations = scenarios.filter((scenario) => scenario.dangerous && scenario.failures.some((item) => item.includes('不应修改'))).length;
  const repeatClarificationScenarios = scenarios.filter((scenario) => scenario.unnecessaryClarifications > 0).length;
  const recoveryFailures = scenarios.filter((scenario) => scenario.recovery && !scenario.passed).length;
  return {
    total,
    passed,
    failed: total - passed,
    successRate: total ? Number((passed / total * 100).toFixed(1)) : 0,
    dangerousMisoperations,
    unnecessaryClarificationRate: total ? Number((repeatClarificationScenarios / total * 100).toFixed(1)) : 0,
    recoveryFailures,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    p95LatencyMs: percentile(latencies, 0.95),
    averageFirstFeedbackMs: firstFeedbackLatencies.length
      ? Math.round(firstFeedbackLatencies.reduce((sum, value) => sum + value, 0) / firstFeedbackLatencies.length) : 0,
    p95FirstFeedbackMs: percentile(firstFeedbackLatencies, 0.95),
    fastPathTurns: fastPathLatencies.length,
    p95FastPathMs: percentile(fastPathLatencies, 0.95),
    slowFirstFeedbackTurns: firstFeedbackLatencies.filter((value) => value > 300).length
  };
}

module.exports = {
  comparableState,
  evaluateTurn,
  sanitizeResult,
  summarizeScenarios
};
