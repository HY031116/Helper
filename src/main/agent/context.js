'use strict';

function currentEntity(state, tasks, memos) {
  const recent = state && state.lastEntity;
  if (!recent || !recent.id) return null;
  const source = recent.type === 'memo' ? memos : tasks;
  const entity = source.find((item) => item.id === recent.id);
  return entity ? { entityType: recent.type, id: entity.id, title: entity.title } : null;
}

function currentCollection(state, tasks, memos) {
  const recent = state && state.lastCollection;
  if (!recent || !Array.isArray(recent.ids)) return null;
  const source = recent.type === 'memo' ? memos : tasks;
  const ids = new Set(recent.ids);
  const items = source.filter((item) => ids.has(item.id)).map((item) => ({ id: item.id, title: item.title }));
  return items.length ? { entityType: recent.type, items } : null;
}

function queryScore(entity, query) {
  const text = String(query || '').toLowerCase().replace(/\s+/g, '');
  const title = String(entity && entity.title || '').toLowerCase().replace(/\s+/g, '');
  if (!text || !title) return 0;
  if (text.includes(title)) return 1000 + title.length;
  const words = String(query || '').toLowerCase().split(/[\s，。！？、,.!?：:；;（）()【】\[\]「」"']+/).filter((word) => word.length >= 2);
  return words.reduce((score, word) => score + (title.includes(word) || word.includes(title) ? 20 + word.length : 0), 0);
}

function selectEntities(entities, query, limit) {
  return entities.map((entity, index) => ({ entity, index, score: queryScore(entity, query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.entity);
}

function buildWorkspaceSnapshot(store, query) {
  const allTasks = store.getAllTasks().filter((task) => task.status !== 'archived');
  const allMemos = store.getAllMemos();
  const tasks = selectEntities(allTasks, query, 40);
  const memos = selectEntities(allMemos, query, 30);
  const state = store.getAgentState();
  const workflow = store.getWorkflowState();
  const today = (() => {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  })();
  const todayPlan = workflow.dailyPlans && workflow.dailyPlans[today] || null;
  const taskIds = new Set(allTasks.map((task) => task.id));
  const memoIds = new Set(allMemos.map((memo) => memo.id));
  return {
    taskEntities: tasks.map((task) => ({
      entityType: 'task',
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.pri,
      due: task.due || null,
      estimatedMinutes: task.estimatedMinutes || null,
      tags: Array.isArray(task.tags) ? task.tags.slice(0, 5) : [],
      project: task.project || ''
    })),
    memoEntities: memos.map((memo) => ({
      entityType: 'memo',
      id: memo.id,
      title: memo.title,
      pinned: !!memo.pinned,
      tags: Array.isArray(memo.tags) ? memo.tags.slice(0, 5) : [],
      preview: String(memo.content || '').replace(/\s+/g, ' ').slice(0, 160)
    })),
    dailyWorkflow: {
      preferences: workflow.preferences,
      todayPlan: todayPlan ? {
        date: todayPlan.date,
        revision: todayPlan.revision,
        status: todayPlan.status,
        items: todayPlan.items.map((item) => ({
          taskId: item.taskId,
          title: item.title,
          plannedMinutes: item.plannedMinutes,
          plannedStart: item.plannedStart,
          status: item.status
        }))
      } : null,
      activeFocus: workflow.activeFocus ? {
        taskId: workflow.activeFocus.taskId,
        title: workflow.activeFocus.title,
        state: workflow.activeFocus.state,
        targetMinutes: workflow.activeFocus.targetMinutes,
        elapsedMinutes: Math.floor(workflow.activeFocus.elapsedMs / 60000),
        interruptionCount: workflow.activeFocus.interruptions.length
      } : null
    },
    recentFocus: currentEntity(state, allTasks, allMemos),
    recentCollection: currentCollection(state, allTasks, allMemos),
    recentReferences: (Array.isArray(state.references) ? state.references : [])
      .filter((entry) => entry.type === 'memo' ? memoIds.has(entry.id) : taskIds.has(entry.id))
      .slice(0, 8)
      .map((entry) => ({ entityType: entry.type, id: entry.id, title: entry.title }))
  };
}

function serializeWorkspaceSnapshot(store, query) {
  return JSON.stringify(buildWorkspaceSnapshot(store, query), null, 2);
}

module.exports = { buildWorkspaceSnapshot, serializeWorkspaceSnapshot };
