'use strict';

/**
 * AI 助手 - 双阶段架构
 * 第一阶段：模拟 AI（规则引擎）承载对话管理能力
 * 第二阶段：真实大模型（LLM）负责意图识别与参数抽取，输出结构化 JSON
 * 规则引擎负责执行与安全边界，两阶段共用同一套验收口径
 */

const store = require('./store');

/* ---------- 多轮上下文：最近提到的任务标题 ---------- */
let lastMentionedTitle = '';

/* ---------- 意图定义 ---------- */
const INTENTS = ['create', 'query', 'complete', 'start', 'delete', 'archive', 'split', 'suggest', 'summary', 'stats', 'batch', 'chat', 'unknown'];

/* ---------- 优先级词 ---------- */
const PRI_WORDS = {
  '紧急': 4, '加急': 4, '立刻': 4, '马上': 4,
  '高': 3, '重要': 3, '优先': 3,
  '中': 2,
  '低': 1, '不急': 1, '随便': 1
};

/* ---------- 意图识别（词库扩充） ---------- */
function detectIntent(text) {
  // 问候/感谢
  if (/^(你好|您好|嗨|哈喽|早上好|下午好|晚上好|嗨喽|hello|hi)\s*[，。！!?？]?\s*$/.test(text)) return 'greeting';
  if (/^(谢谢|感谢|多谢|辛苦了|ok|好的|谢谢啦)\s*[。！!]?\s*$/.test(text)) return 'thanks';
  // 先检测更具体的意图（避免「安排」被 create 抢走、「完成」被 summary 抢走）
  if (/怎么安排|先做什么|排序|建议|安排一下|优先级.*(怎么|如何|排序)|怎么.*优先级|推荐.*顺序/.test(text)) return 'suggest';
  if (/小结|总结|复盘|进展|今天完成了什么|今天做了什么/.test(text)) return 'summary';
  // 统计问答：计数/完成率/多少个/几条/完成了多少
  if (/(多少个|几条|几项|完成率|有几个|占比|还剩.*(个|条|项)|还有.*(个|条|项)没|完成了多少|做了多少|完成.*多少)/.test(text)) return 'stats';
  if (/拆成|拆分|分解|分成.*步|拆一下/.test(text)) return 'split';
  if (/归档|收起来|移入归档/.test(text)) return 'archive';
  // 批量操作：清除/清空所有、全部完成、按条件批量删/完成
  if (/(清除|清空|清掉|删光|全删|全部.*删|所有.*删|全部.*完成|所有.*完成|批量|一键.*(删|完成|清)|把.*都(删|完成|清)|把.*全(删|完成|清))/.test(text)) return 'batch';
  if (/删除|去掉|不做了|取消这个|移除|删掉|划掉/.test(text)) return 'delete';
  // 「完成了吗/做完了吗」是询问状态，不是完成操作
  if (/完成了吗|做完了吗|搞定了吗|结束了没/.test(text)) return 'query';
  if (/完成|搞定|做完了|办完了|勾掉|结束了|弄完了|做好了/.test(text)) return 'complete';
  if (/开始|动手做|着手|启动/.test(text)) return 'start';
  // 创建：排除疑问词（「明天要交周报吗」是询问）
  if (/创建|添加|记一下|安排|新建|帮我记|加一个|建一个|记个|记得|提醒我|要交|要去/.test(text) && !/吗|呢|？|\?/.test(text)) return 'create';
  // 无动词但有明确时间+任务内容（如「明天下午3点 交周报」）也视为创建
  // 排除疑问词，避免「今天天气怎么样」「今天星期几」被误判为创建
  if (/(今天|明天|后天|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{1,2}[:：点])/.test(text) && !/什么|哪些|几个|怎么样|如何|吗|呢|谁|哪|几/.test(text)) return 'create';
  // 查询：查/看/列/有什么/干嘛/要做/安排 + 时间范围 + 指代 + 标签筛选
  if (/(查|看看|看一下|查看|列|有什么|我的任务|最近|待办|做什么|干嘛|要做|安排|有哪些|都什么|那个任务|完成了吗|做完了吗)/.test(text)) return 'query';
  // 带 #标签 的「任务」是筛选查询
  if (/#[\u4e00-\u9fa5A-Za-z0-9_-]+.*任务|任务.*#[\u4e00-\u9fa5A-Za-z0-9_-]+/.test(text)) return 'query';
  // 其余一律视为通用对话（知识问答/闲聊），交给 LLM 或内置知识库
  return 'chat';
}

/* ---------- 任务匹配（支持描述/标签模糊） ---------- */
function matchTasks(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return store.getAllTasks().filter((t) =>
    t.title.toLowerCase().includes(q) ||
    (t.desc || '').toLowerCase().includes(q) ||
    (t.tags || []).some((x) => x.toLowerCase().includes(q))
  );
}

/* ---------- 相对日期 ---------- */
function parseRelativeDate(text) {
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const fmt = (d, hh, mm) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh)}:${pad(mm)}`;

  // 今天/明天/后天
  if (/今天|今日|今晚/.test(text)) return fmt(now, 18, 0);
  if (/明天|明日/.test(text)) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return fmt(d, 18, 0);
  }
  if (/后天/.test(text)) {
    const d = new Date(now); d.setDate(d.getDate() + 2);
    return fmt(d, 18, 0);
  }
  // 周X
  const weekMatch = text.match(/周([一二三四五六日天])/);
  if (weekMatch) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const target = map[weekMatch[1]];
    let diff = target - now.getDay();
    if (diff <= 0) diff += 7;
    const d = new Date(now); d.setDate(d.getDate() + diff);
    return fmt(d, 18, 0);
  }
  // X月X日
  const mdMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (mdMatch) {
    const d = new Date(now.getFullYear(), parseInt(mdMatch[1], 10) - 1, parseInt(mdMatch[2], 10), 18, 0);
    return fmt(d, 18, 0);
  }
  return null;
}

function parseTime(text) {
  // 下午/晚上/中午 修饰 + HH:mm 或 H点 / H点半
  const period = /(凌晨|早上|上午|中午|下午|晚上|傍晚|夜里)/.exec(text);
  const hm = text.match(/(\d{1,2})[:：点](\d{1,2})/);
  const h = text.match(/(\d{1,2})点/);
  let hour = hm ? parseInt(hm[1], 10) : (h ? parseInt(h[1], 10) : null);
  if (hour === null) return null;
  const minute = hm ? parseInt(hm[2], 10) : 0;
  // 12 小时制修正：下午/晚上/傍晚/夜里 + 1-11 点 → +12
  if (period && /(下午|晚上|傍晚|夜里)/.test(period[1]) && hour < 12) hour += 12;
  // 凌晨/早上 + 12 点 → 0 点
  if (period && /(凌晨|早上)/.test(period[1]) && hour === 12) hour = 0;
  return { h: hour, m: minute };
}

/* ---------- 标签 ---------- */
function parseTags(text) {
  const tags = [];
  const re = /#([\u4e00-\u9fa5A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) tags.push(m[1]);
  return tags;
}

/* ---------- 执行 ---------- */
function execute(intent, params) {
  switch (intent) {
    case 'create': return doCreate(params);
    case 'complete': return doComplete(params);
    case 'start': return doStart(params);
    case 'delete': return doDelete(params);
    case 'archive': return doArchive(params);
    case 'split': return doSplit(params);
    case 'suggest': return doSuggest();
    case 'summary': return doSummary();
    case 'stats': return doStats(params);
    case 'query': return doQuery(params);
    case 'batch': return doBatch(params);
    case 'greeting': return { type: 'info', message: '你好呀！👋 有什么要记的、要查的，尽管说～\n比如：· 明天下午3点 交周报 #工作 · 我有哪些紧急任务 · 今天完成了多少' };
    case 'thanks': return { type: 'info', message: '不客气！随时找我 ☺️' };
    case 'chat': return doChat(params);
    default: return { type: 'unknown', message: buildHelp() };
  }
}

/* ---------- 帮助文案（识别失败时引导） ---------- */
function buildHelp() {
  return '我还没听懂这句，换个说法试试？\n我可以帮你：\n· 记任务：「明天下午3点 交周报 #工作 紧急」\n· 查任务：「我有哪些紧急任务」「#工作 的任务」\n· 改状态：「完成 交周报」「归档 写方案」\n· 统计：「今天完成了多少」「还剩几条没做」\n· 安排：「怎么安排今天的优先级」\n· 闲聊问答：直接问我任何问题，比如「什么是番茄工作法」';
}

/* ---------- 内置知识库（未配置 LLM 时的通用问答兜底） ---------- */
const KNOWLEDGE = [
  { keys: ['番茄工作法', '番茄钟'], answer: '🍅 番茄工作法：把工作切成 25 分钟一段（一个番茄钟），专注做完后休息 5 分钟，每 4 个番茄钟休息 15-30 分钟。能帮你减少分心、保持专注。' },
  { keys: ['gtD', 'gtd', '搞定'], answer: '📋 GTD（Getting Things Done）：把脑子里所有事都记下来，清空大脑，再按「收集→整理→组织→回顾→执行」五步处理。核心是让大脑只负责思考，不负责记忆。' },
  { keys: ['艾森豪威尔', '四象限', '重要紧急'], answer: '🎯 四象限法则：按「重要/紧急」把任务分四类——重要且紧急（马上做）、重要不紧急（计划做）、紧急不重要（委托做）、不重要不紧急（少做）。建议把精力放在「重要不紧急」上。' },
  { keys: ['二八', '帕累托', '80'], answer: '📊 二八法则（帕累托原则）：80% 的结果来自 20% 的努力。找到那 20% 的关键任务优先做，效率会大幅提升。' },
  { keys: ['什么是任务', '任务管理'], answer: '🗂 任务管理就是把要做的事记录下来、排优先级、跟踪进度，避免遗忘。我这个助手就是帮你做这个的——直接说「明天下午3点 交周报」就能记下来。' },
  { keys: ['怎么提高效率', '提高效率', '高效'], answer: '⚡ 提高效率的几个实用方法：1) 用四象限排优先级 2) 番茄钟保持专注 3) 一次只做一件事 4) 把大任务拆成小步 5) 定期复盘。需要的话我可以帮你把任务排个优先级。' },
  { keys: ['什么是ai', '人工智能', '什么是AI'], answer: '🤖 AI（人工智能）是让机器模拟人类智能的技术。我就是一个 AI 助手——既能帮你管理任务，也能陪你聊天、回答知识问题。' },
  { keys: ['你是谁', '你叫什么', '介绍一下你'], answer: '我是「工作台助手」✨ 一个常驻你桌面的 AI 助手。我能帮你：记任务、查任务、排优先级、统计进度，还能陪你聊天、回答各种问题。' },
  { keys: ['今天星期几', '今天几号', '今天日期'], answer: () => { const d = new Date(); const w = ['日','一','二','三','四','五','六'][d.getDay()]; return `今天是 ${d.getFullYear()} 年 ${d.getMonth()+1} 月 ${d.getDate()} 日，星期${w}。`; } },
  { keys: ['现在几点', '几点了', '时间'], answer: () => { const d = new Date(); const p = (n)=>n<10?'0'+n:''+n; return `现在是 ${p(d.getHours())}:${p(d.getMinutes())}。`; } }
];

/* ---------- 通用对话（知识问答/闲聊，规则引擎兜底） ---------- */
function doChat(params) {
  const text = String(params.text || '').toLowerCase();
  // 先查内置知识库
  for (const item of KNOWLEDGE) {
    if (item.keys.some((k) => text.includes(k))) {
      const ans = typeof item.answer === 'function' ? item.answer() : item.answer;
      return { type: 'chat', message: ans };
    }
  }
  // 未命中知识库：引导（配置 LLM 后这里会由真实模型接管）
  return {
    type: 'chat',
    message: '这个问题我暂时答不上来 🤔\n配置真实模型（设置 → AI 接入 → 填 API Key）后，我就能回答各种知识问答和闲聊了。\n\n现在我可以帮你：\n· 记任务：「明天下午3点 交周报」\n· 查任务：「我有哪些紧急任务」\n· 统计：「今天完成了多少」'
  };
}

function doCreate(params) {
  const title = params.title;
  if (!title) return { type: 'error', message: '没听清任务内容，能再说一遍吗？' };
  const task = store.createTask({
    title,
    pri: params.pri || 2,
    due: params.due || null,
    tags: params.tags || []
  });
  return {
    type: 'create',
    task,
    message: `已创建「${task.title}」` + (task.due ? `，截止 ${task.due}` : '') + (task.pri !== 2 ? `，${['', '低', '中', '高', '紧急'][task.pri]}优先级` : ''),
    undoable: false
  };
}

function doComplete(params) {
  const hits = matchTasks(params.target);
  if (!hits.length) return { type: 'error', message: `没找到「${params.target}」相关任务` };
  if (hits.length > 1) {
    return {
      type: 'ask',
      message: '你说的是哪一个？',
      candidates: hits.map((t) => ({ id: t.id, title: t.title }))
    };
  }
  const t = hits[0];
  if (t.status === 'done') return { type: 'info', message: `「${t.title}」已经是完成状态了` };
  // 有子任务时：完成一个子任务，全部完成则父任务完成
  if (t.children && t.children.length) {
    // 兼容旧数据：字符串子任务 → 对象
    const norm = (c) => (typeof c === 'string' ? { title: c, done: false } : c);
    const children = t.children.map(norm);
    const doneChildren = children.filter((c) => c && c.done).length;
    const nextChildren = children.map((c, i) => {
      if (c && c.done) return c;
      if (i === doneChildren) return Object.assign({}, c, { done: true });
      return c;
    });
    const allDone = nextChildren.every((c) => c && c.done);
    if (allDone) {
      // 全部子任务完成 → 先保存子任务状态，再完成父任务（重复任务自动生成下一次）
      store.updateTask(t.id, { children: nextChildren });
      const res = store.completeTask(t.id);
      return {
        type: 'complete',
        task: t,
        message: `「${t.title}」全部子任务完成 🎉` + (res.next ? `，已自动安排下一次（${res.next.due}）` : ''),
        undoable: true,
        undo: { action: 'restore', id: t.id }
      };
    }
    store.updateTask(t.id, { children: nextChildren });
    return {
      type: 'complete',
      task: t,
      message: `「${t.title}」已完成 ${doneChildren + 1}/${t.children.length} 步`,
      undoable: true,
      undo: { action: 'restore', id: t.id }
    };
  }
  // 普通任务完成（重复任务自动生成下一次）
  const res = store.completeTask(t.id);
  return {
    type: 'complete',
    task: t,
    message: `已完成「${t.title}」🎉` + (res.next ? `，已自动安排下一次（${res.next.due}）` : ''),
    undoable: true,
    undo: { action: 'restore', id: t.id }
  };
}

function doStart(params) {
  const hits = matchTasks(params.target);
  if (!hits.length) return { type: 'error', message: `没找到「${params.target}」相关任务` };
  if (hits.length > 1) {
    return {
      type: 'ask',
      message: '你说的是哪一个？',
      candidates: hits.map((t) => ({ id: t.id, title: t.title }))
    };
  }
  const t = hits[0];
  store.updateTask(t.id, { status: 'doing' });
  return { type: 'start', task: t, message: `已开始「${t.title}」，加油！`, undoable: true, undo: { action: 'restore', id: t.id } };
}

function doDelete(params) {
  const hits = matchTasks(params.target);
  if (!hits.length) return { type: 'error', message: `没找到「${params.target}」相关任务` };
  if (hits.length > 1) {
    return {
      type: 'ask',
      message: '你说的是哪一个？',
      candidates: hits.map((t) => ({ id: t.id, title: t.title }))
    };
  }
  const t = hits[0];
  store.deleteTask(t.id);
  return { type: 'delete', task: t, message: `已删除「${t.title}」`, undoable: true, undo: { action: 'restore', id: t.id } };
}

/* ---------- 批量操作 ---------- */
function doBatch(params) {
  const raw = String(params.text || '');
  const all = store.getAllTasks();
  // 判断操作类型
  const isDelete = /(清除|清空|清掉|删光|全删|删除|删掉|移除)/.test(raw);
  const isComplete = /(完成|搞定|做完了)/.test(raw) && !isDelete;
  // 清除所有：仅当没有筛选条件时才视为清除全部
  const hasFilter = params.pri || (params.tags && params.tags.length) || params.status || params.project;
  const isClearAll = !hasFilter && /(清除所有|清空所有|全部.*删|所有.*删|全删|删光|清掉所有|清空全部|全部任务.*删|所有任务.*删)/.test(raw);
  const isEmptyTrash = /(清空回收站|清空回收|清回收站)/.test(raw);

  // 清空回收站
  if (isEmptyTrash) {
    const deleted = store.getDeletedTasks();
    if (!deleted.length) return { type: 'info', message: '回收站已经是空的了' };
    store.emptyTrash();
    return { type: 'batch', message: `已清空回收站（${deleted.length} 项）`, undoable: false };
  }

  // 筛选目标任务
  let targets = all.filter((t) => t.status !== 'archived');
  // 按优先级筛选
  if (params.pri) targets = targets.filter((t) => t.pri === params.pri);
  // 按标签筛选
  if (params.tags && params.tags.length) targets = targets.filter((t) => params.tags.every((tag) => (t.tags || []).includes(tag)));
  // 按状态筛选
  if (params.status) targets = targets.filter((t) => t.status === params.status);
  // 按项目筛选
  if (params.project) targets = targets.filter((t) => (t.project || '') === params.project);

  // 清除所有任务（含已完成）
  if (isClearAll) {
    const count = all.length;
    if (!count) return { type: 'info', message: '当前没有任务可清除' };
    store.clearAllTasks();
    return { type: 'batch', message: `已清除全部 ${count} 项任务`, undoable: false };
  }

  // 完成操作：只针对未完成任务
  if (isComplete) {
    const pending = targets.filter((t) => t.status !== 'done');
    if (!pending.length) return { type: 'info', message: '没有需要完成的任务' };
    store.batchUpdate(pending.map((t) => t.id), { status: 'done' });
    return { type: 'batch', message: `已完成 ${pending.length} 项任务 🎉`, undoable: false };
  }

  // 删除操作：默认删除未完成任务（保留已完成）
  if (isDelete) {
    const toDelete = targets.filter((t) => t.status !== 'done');
    if (!toDelete.length) return { type: 'info', message: '没有符合条件的任务可删除' };
    store.batchDelete(toDelete.map((t) => t.id));
    return { type: 'batch', message: `已删除 ${toDelete.length} 项任务`, undoable: false };
  }

  return { type: 'error', message: '没太明白要批量做什么，试试「清除所有任务」「全部完成」「把紧急任务都删掉」' };
}

function doArchive(params) {
  const hits = matchTasks(params.target);
  if (!hits.length) return { type: 'error', message: `没找到「${params.target}」相关任务` };
  if (hits.length > 1) {
    return {
      type: 'ask',
      message: '你说的是哪一个？',
      candidates: hits.map((t) => ({ id: t.id, title: t.title }))
    };
  }
  const t = hits[0];
  if (t.status === 'archived') return { type: 'info', message: `「${t.title}」已经在归档里了` };
  store.archiveTask(t.id);
  return { type: 'archive', task: t, message: `已归档「${t.title}」`, undoable: true, undo: { action: 'unarchive', id: t.id } };
}

function doSplit(params) {
  const hits = matchTasks(params.target);
  if (!hits.length) return { type: 'error', message: `没找到「${params.target}」相关任务` };
  if (hits.length > 1) {
    return {
      type: 'ask',
      message: '你说的是哪一个？',
      candidates: hits.map((t) => ({ id: t.id, title: t.title }))
    };
  }
  const t = hits[0];
  const n = params.count || 3;
  const steps = [];
  for (let i = 1; i <= n; i++) steps.push(`${t.title}·步骤${i}`);
  store.updateTask(t.id, { children: steps });
  return { type: 'split', task: t, message: `已把「${t.title}」拆成 ${n} 步`, undoable: true, undo: { action: 'restore', id: t.id } };
}

function doSuggest() {
  const all = store.getAllTasks().filter((t) => t.status !== 'done' && t.status !== 'archived');
  const sorted = all.sort((a, b) => {
    const pa = a.pri, pb = b.pri;
    if (pa !== pb) return pb - pa;
    return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
  });
  if (!sorted.length) return { type: 'info', message: '当前没有待办任务，可以休息一下 ☕' };
  const lines = sorted.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}${t.due ? '（' + t.due + '）' : ''}`);
  return {
    type: 'suggest',
    message: '建议按这个顺序来：\n' + lines.join('\n') + '\n\n原则：紧急且早到期优先。'
  };
}

function doSummary() {
  const all = store.getAllTasks();
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // 今日完成：completedAt 落在今天
  const done = all.filter((t) => t.status === 'done' && t.completedAt && new Date(t.completedAt).toISOString().slice(0, 10) === todayKey);
  const todo = all.filter((t) => t.status !== 'done' && t.status !== 'archived');
  const lines = [];
  lines.push(`今日已完成 ${done.length} 项：`);
  lines.push(done.length ? done.slice(0, 5).map((t) => '· ' + t.title).join('\n') : '· （暂无）');
  lines.push(`\n未完成 ${todo.length} 项：`);
  lines.push(todo.length ? todo.slice(0, 5).map((t) => '· ' + t.title).join('\n') : '· （暂无）');
  return { type: 'summary', message: lines.join('\n') };
}

function doQuery(params) {
  const all = store.getAllTasks();
  const range = params.range || 'all';
  let list = all;
  if (range === 'today') {    const today = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const key = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    list = all.filter((t) => t.due && t.due.startsWith(key));
  } else if (range === 'week') {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    list = all.filter((t) => t.createdAt >= weekAgo.getTime());
  } else if (range === 'tomorrow') {
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + 1);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const key = `${tmr.getFullYear()}-${pad(tmr.getMonth() + 1)}-${pad(tmr.getDate())}`;
    list = all.filter((t) => t.due && t.due.startsWith(key));
  } else if (range === 'yesterday') {
    const yst = new Date();
    yst.setDate(yst.getDate() - 1);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const key = `${yst.getFullYear()}-${pad(yst.getMonth() + 1)}-${pad(yst.getDate())}`;
    list = all.filter((t) => t.due && t.due.startsWith(key));
  } else if (range === 'overdue') {
    list = all.filter((t) => t.status !== 'done' && t.status !== 'archived' && t.due && new Date(t.due.replace(' ', 'T') + ':00') < new Date());
  }
  // 筛选：优先级
  if (params.pri) list = list.filter((t) => t.pri === params.pri);
  // 筛选：标签
  if (params.tags && params.tags.length) list = list.filter((t) => params.tags.every((tag) => (t.tags || []).includes(tag)));
  // 筛选：项目
  if (params.project) list = list.filter((t) => (t.project || '') === params.project);
  // 筛选：状态
  if (params.status) list = list.filter((t) => t.status === params.status);
  // 筛选：指定任务标题
  if (params.target) list = list.filter((t) => t.title.includes(params.target));
  // 默认隐藏归档
  list = list.filter((t) => t.status !== 'archived');
  if (!list.length) return { type: 'info', message: '没有符合条件的任务' };
  const lines = list.slice(0, 20).map((t) => `· ${t.status === 'done' ? '✓' : '○'} ${t.title}${t.due ? '（' + relDueText(t.due) + '）' : ''}${t.pri !== 2 ? ' [' + ['', '低', '中', '高', '紧急'][t.pri] + ']' : ''}`);
  const extra = list.length > 20 ? `\n…还有 ${list.length - 20} 条` : '';
  return { type: 'query', message: `共 ${list.length} 条：\n` + lines.join('\n') + extra };
}

/* ---------- 相对时间显示（查询用） ---------- */
function relDueText(due) {
  if (!due) return '';
  const d = new Date(due.replace(' ', 'T') + ':00');
  if (isNaN(d.getTime())) return due;
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dueKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dueKey === todayKey) return `今天 ${timeStr}`;
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  const tmrKey = `${tmr.getFullYear()}-${pad(tmr.getMonth() + 1)}-${pad(tmr.getDate())}`;
  if (dueKey === tmrKey) return `明天 ${timeStr}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${timeStr}`;
}

/* ---------- 统计问答 ---------- */
function doStats(params) {
  const all = store.getAllTasks().filter((t) => t.status !== 'archived');
  const done = all.filter((t) => t.status === 'done').length;
  const doing = all.filter((t) => t.status === 'doing').length;
  const todo = all.filter((t) => t.status === 'todo').length;
  const rate = all.length ? Math.round(done / all.length * 100) : 0;
  // 今日完成
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const doneToday = all.filter((t) => t.status === 'done' && t.completedAt && new Date(t.completedAt).toISOString().slice(0, 10) === todayKey).length;
  // 剩几天内到期
  const soon = all.filter((t) => t.status !== 'done' && t.due && (() => {
    const d = new Date(t.due.replace(' ', 'T') + ':00');
    return d.getTime() - Date.now() < 3 * 86400000 && d.getTime() >= Date.now();
  })()).length;

  const lines = [
    `· 任务总数 ${all.length}（已完成 ${done}，进行中 ${doing}，待办 ${todo}）`,
    `· 完成率 ${rate}%`,
    `· 今天已完成 ${doneToday} 项`,
    `· 未来 3 天内到期 ${soon} 项`
  ];
  return { type: 'stats', message: '📊 当前统计：\n' + lines.join('\n') };
}

/* ---------- 解析入口 ---------- */
function parse(text) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'unknown', params: {}, message: '请输入指令' };

  const intent = detectIntent(raw);
  const params = {};

  // 通用对话：直接保留原文，交给 doChat / LLM
  if (intent === 'chat') {
    params.text = raw;
    return { intent, params };
  }

  // 批量操作：保留原文 + 抽取筛选条件
  if (intent === 'batch') {
    params.text = raw;
    // 优先级筛选
    if (/紧急|加急|立刻|马上/.test(raw)) params.pri = 4;
    else if (/高优先级|重要|优先/.test(raw)) params.pri = 3;
    else if (/低优先级|不急|随便/.test(raw)) params.pri = 1;
    // 状态筛选
    if (/进行中|正在做/.test(raw)) params.status = 'doing';
    else if (/未完成|没做|待办/.test(raw)) params.status = 'todo';
    else if (/(已完成|做完了)(?!吗)/.test(raw)) params.status = 'done';
    // 标签筛选
    params.tags = parseTags(raw);
    // 支持「X标签」格式（如「工作标签」「生活标签」）——X 为不含虚词的 1-4 字词
    const tagMatch = raw.match(/([^\s把的所有将这些那些]{1,4})标签/);
    if (tagMatch && !params.tags.includes(tagMatch[1])) params.tags.push(tagMatch[1]);
    // 项目筛选
    const projMatch = raw.match(/(?:项目|◈)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,12})/);
    if (projMatch) params.project = projMatch[1];
    return { intent, params };
  }

  // 抽取优先级
  for (const word in PRI_WORDS) {
    if (raw.includes(word)) { params.pri = PRI_WORDS[word]; break; }
  }

  // 抽取截止时间
  const due = parseRelativeDate(raw);
  const time = parseTime(raw);
  if (due) {
    params.due = due;
    if (time) {
      const [datePart] = due.split(' ');
      params.due = `${datePart} ${String(time.h).padStart(2, '0')}:${String(time.m).padStart(2, '0')}`;
    }
  } else if (time) {
    const now = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    params.due = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${String(time.h).padStart(2, '0')}:${String(time.m).padStart(2, '0')}`;
  }

  // 抽取标签
  params.tags = parseTags(raw);

  // 按意图抽取标题/目标
  if (intent === 'create') {
    let title = raw
      .replace(/^(创建|添加|记一下|安排|新建|帮我记|加一个|建一个|记个|记得|提醒我|要交|要去)\s*/g, '')
      .replace(/(今天|明天|后天|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{1,2}[:：点]\d{0,2}|\d{1,2}点|凌晨|早上|上午|中午|下午|晚上|傍晚|夜里|半)/g, '')
      .replace(/(紧急|加急|立刻|马上|高优先级|中优先级|低优先级|重要|优先|高|中|低|不急|随便)/g, '')
      .replace(/#[\u4e00-\u9fa5A-Za-z0-9_-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    params.title = title;
  } else if (intent === 'split') {
    const m = raw.match(/拆成\s*(\d+)\s*步|拆成\s*(\d+)\s*部分/);
    params.count = m ? parseInt(m[1] || m[2], 10) : 3;
    const target = raw.replace(/^(把|将)?\s*/, '').replace(/拆成.*$/, '').trim();
    params.target = target;
  } else if (intent === 'query' || intent === 'stats') {
    // 查询/统计：抽取筛选条件
    // 指代：查最近提到的任务
    if (/那个任务|刚说的那个|刚刚那个|它/.test(raw) && lastMentionedTitle) {
      params.target = lastMentionedTitle;
      params.useLastMention = true;
    }
    // 优先级（紧急/高优先级/重要）
    if (/紧急|加急|立刻|马上/.test(raw)) params.pri = 4;
    else if (/高优先级|重要|优先/.test(raw)) params.pri = 3;
    else if (/低优先级|不急|随便/.test(raw)) params.pri = 1;
    // 状态（进行中/未完成/已完成）——「完成了吗」是询问，不设状态
    if (/进行中|正在做|doing/.test(raw)) params.status = 'doing';
    else if (/未完成|没做|待办/.test(raw)) params.status = 'todo';
    else if (/(已完成|做完了|完成了)(?!吗)/.test(raw)) params.status = 'done';
    // 项目：◈ 前缀或「项目X」
    const projMatch = raw.match(/(?:项目|◈)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,12})/);
    if (projMatch) params.project = projMatch[1];
    // 范围：明天/过期
    if (/明天|明日/.test(raw) && intent === 'query') params.range = 'tomorrow';
    if (/过期|逾期|晚了/.test(raw)) params.range = 'overdue';
  } else {
    // complete/start/delete/archive: 去掉意图词后的文本作为目标
    // 支持「那个任务」「刚说的那个」指代
    const target = raw
      .replace(/^(完成|搞定|做完了|办完了|勾掉|结束了|弄完了|做好了|开始|动手做|着手|启动|删除|去掉|不做了|取消这个|移除|删掉|划掉|归档|收起来|移入归档)\s*/g, '')
      .replace(/#[\u4e00-\u9fa5A-Za-z0-9_-]+/g, '')
      .trim();
    if (/那个任务|刚说的那个|刚刚那个|它/.test(target)) {
      params.target = lastMentionedTitle || '';
      params.useLastMention = true;
    } else {
      params.target = target;
    }
  }

  // 查询范围
  if (intent === 'query' || intent === 'stats') {
    if (!params.range) {
      if (/今天|今日/.test(raw)) params.range = 'today';
      else if (/最近一周|本周|这周|最近/.test(raw)) params.range = 'week';
      else if (/昨天/.test(raw)) params.range = 'yesterday';
      else params.range = 'all';
    }
  }

  return { intent, params };
}

/* ---------- 对外主入口 ---------- */
function handle(text) {
  const { intent, params } = parse(text);
  const result = execute(intent, params);
  // 记录最近提到的任务标题（供多轮指代）
  if (result.task && result.task.title) lastMentionedTitle = result.task.title;
  return Object.assign({ intent, raw: text }, result);
}

/* ============================================================
 * 第二阶段：真实大模型接入
 * LLM 负责意图识别 + 参数抽取（输出结构化 JSON）
 * 规则引擎负责执行（保留安全边界与可撤销性）
 * ============================================================ */

const PROVIDERS = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  'opencode-go': { name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', defaultModel: 'deepseek-v4-flash' },
  custom: { name: '自定义', baseUrl: '', defaultModel: '' }
};

function getLLMConfig() {
  const s = store.getSettings();
  const p = PROVIDERS[s.aiProvider] || PROVIDERS.openai;
  return {
    provider: s.aiProvider || 'openai',
    baseUrl: (s.aiBaseUrl || p.baseUrl).replace(/\/+$/, ''),
    // 防御性清理：去掉 key 中所有空白字符（粘贴时常带换行/空格）
    apiKey: String(s.aiApiKey || '').replace(/\s+/g, ''),
    model: s.aiModel || p.defaultModel,
    temperature: s.aiTemperature != null ? s.aiTemperature : 0.2
  };
}

function isLLMConfigured() {
  const cfg = getLLMConfig();
  return !!(cfg.apiKey && cfg.baseUrl && cfg.model);
}

/* ---------- LLM 调用（OpenAI 兼容协议） ---------- */
async function callLLM(messages, opts) {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) throw new Error('未配置 API Key');
  const url = `${cfg.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (opts && opts.timeout) || 30000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        // 推理模型（如 DeepSeek V4）会先输出 reasoning 再输出 content，需要足够 token 空间
        max_tokens: (opts && opts.maxTokens) || 1000,
        response_format: (opts && opts.jsonMode) ? { type: 'json_object' } : undefined
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('LLM 返回为空');
    // 兼容推理模型：content 为空时尝试从 reasoning 提取
    let content = msg.content || '';
    if (!content && msg.reasoning) {
      // 推理模型可能把答案放在 reasoning 里，尝试提取
      content = msg.reasoning;
    }
    if (!content) throw new Error('LLM 返回为空');
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- 系统提示词（agent 模式：结合任务上下文做智能决策） ---------- */
function buildSystemPrompt() {
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // 提供当前任务上下文，让 LLM 能智能判断
  const tasks = store.getAllTasks().filter((t) => t.status !== 'archived');
  const taskSummary = tasks.slice(0, 30).map((t) =>
    `- id:${t.id} | ${t.title} | 状态:${t.status} | 优先级:${['', '低', '中', '高', '紧急'][t.pri]}${t.due ? ' | 截止:' + t.due : ''}${t.tags && t.tags.length ? ' | 标签:' + t.tags.join(',') : ''}${t.project ? ' | 项目:' + t.project : ''}`
  ).join('\n');
  return `你是「工作台助手」的智能助手（agent）。用户会用日常口语描述任务管理需求，你需要理解意图并解析为结构化 JSON。
当前日期：${today}。

当前任务列表（供你判断意图时参考）：
${taskSummary || '（当前没有任务）'}

请把用户输入解析为结构化 JSON，只输出 JSON，不要输出其他内容。格式：
{
  "intent": "create|query|complete|start|delete|archive|split|suggest|summary|stats|batch|greeting|thanks|unknown",
  "title": "任务标题（create 时必填，去掉时间/优先级/标签等修饰）",
  "target": "目标任务标题关键词（complete/start/delete/archive/split 时填，参考上面的任务列表精确匹配）",
  "count": 拆分步数（split 时填，默认 3）,
  "pri": 1|2|3|4（1低 2中 3高 4紧急，create 或筛选时可选）,
  "due": "截止时间，格式 YYYY-MM-DD HH:mm（create 时可选，相对日期按今天 ${today} 推算）",
  "tags": ["标签数组，create 或按标签筛选时填"],
  "project": "项目名（按项目筛选时填）",
  "status": "todo|doing|done（按状态筛选时填）",
  "range": "today|tomorrow|week|overdue|all（query 时填）"
}

意图判断规则：
- 创建任务：包含任务内容，如「明天下午3点 交周报 #工作 紧急」
- 查询：如「今天我要做什么」「我有哪些紧急任务」「#工作 的任务」「进行中的任务」
- 完成：如「完成 交周报」「搞定 写方案」
- 开始：如「开始 写方案」
- 删除：如「删除 整理报销单据」
- 归档：如「归档 写季度方案」
- 拆分：如「把 写方案 拆成三步」
- 建议：如「怎么安排今天的优先级」「先做什么」
- 小结：如「今天完成了什么」「今日小结」
- 统计：如「今天完成了多少」「完成率多少」「还剩几条没做」
- 批量：如「清除所有任务」「全部完成」「把紧急任务都删掉」「清空回收站」「把所有工作标签的任务删掉」
- 问候：如「你好」「嗨」
- 感谢：如「谢谢」「辛苦了」
- 无法判断（知识问答/闲聊等非任务内容）：intent 填 unknown

批量操作时，请根据任务列表智能判断筛选条件：
- 「清除所有任务」→ intent=batch（无筛选）
- 「把紧急任务都删掉」→ intent=batch, pri=4
- 「把所有工作标签的任务删掉」→ intent=batch, tags=["工作"]
- 「全部完成」→ intent=batch（无筛选，完成所有未完成任务）

时间解析规则：
- 「下午/晚上/傍晚/夜里 X点」→ X+12 点（X<12 时）
- 「早上/上午 X点」→ X 点
- 「今天/明天/后天」→ 对应日期
- 「周X」→ 本周或下周对应星期
- 未指定时间默认 18:00`;
}

/* ---------- LLM 解析 ---------- */
async function parseWithLLM(text) {
  const content = await callLLM([
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: text }
  ], { jsonMode: true, timeout: 15000 });

  // 提取 JSON（兼容模型输出带 ```json 包裹）
  let jsonStr = content;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1];
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM 输出无法解析为 JSON');
  jsonStr = jsonStr.slice(start, end + 1);

  const parsed = JSON.parse(jsonStr);
  const intent = INTENTS.includes(parsed.intent) ? parsed.intent : 'unknown';
  const params = {
    title: parsed.title || '',
    target: parsed.target || '',
    count: parseInt(parsed.count, 10) || 3,
    pri: [1, 2, 3, 4].includes(Number(parsed.pri)) ? Number(parsed.pri) : undefined,
    due: parsed.due || null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
    project: parsed.project || '',
    status: ['todo', 'doing', 'done'].includes(parsed.status) ? parsed.status : undefined,
    range: ['today', 'tomorrow', 'week', 'yesterday', 'overdue', 'all'].includes(parsed.range) ? parsed.range : 'all'
  };
  // 批量操作需要原文判断操作类型
  if (intent === 'batch') params.text = text;
  return { intent, params };
}

/* ---------- 降级：LLM 失败时回退规则引擎 ---------- */
async function handleWithLLM(text) {
  try {
    const { intent, params } = await parseWithLLM(text);
    // LLM 判定为 unknown（非任务）→ 通用对话，直接让 LLM 回答
    if (intent === 'unknown' || intent === 'chat') {
      const reply = await chatWithLLM(text);
      return { intent: 'chat', raw: text, engine: 'llm', type: 'chat', message: reply };
    }
    const result = execute(intent, params);
    if (result.task && result.task.title) lastMentionedTitle = result.task.title;
    return Object.assign({ intent, raw: text, engine: 'llm' }, result);
  } catch (e) {
    console.error('[ai] LLM 调用失败，降级到规则引擎:', e.message);
    // 降级：规则引擎解析 + 执行
    const { intent, params } = parse(text);
    const result = execute(intent, params);
    if (result.task && result.task.title) lastMentionedTitle = result.task.title;
    return Object.assign({ intent, raw: text, engine: 'mock', degraded: true, degradeReason: e.message }, result);
  }
}

/* ---------- LLM 通用对话（知识问答/闲聊） ---------- */
async function chatWithLLM(text) {
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const content = await callLLM([
    {
      role: 'system',
      content: `你是「工作台助手」，一个温暖、亲切的中文 AI 助手，常驻用户桌面。今天是 ${today}。\n用户可能问你知识问题、闲聊、或寻求建议。请用简洁、友好、口语化的中文回答，适当使用 emoji，但不要过度。回答控制在 3-5 句以内。`
    },
    { role: 'user', content: text }
  ], { timeout: 20000, maxTokens: 500 });
  return content.trim();
}

/* ---------- 对外主入口（自动选择引擎） ---------- */
async function handleAuto(text) {
  const s = store.getSettings();
  // 配置了 LLM 则优先用 LLM（更聪明）；否则用增强规则引擎
  if (isLLMConfigured()) {
    return handleWithLLM(text);
  }
  const { intent, params } = parse(text);
  const result = execute(intent, params);
  if (result.task && result.task.title) lastMentionedTitle = result.task.title;
  return Object.assign({ intent, raw: text, engine: 'mock' }, result);
}

/* ---------- 测试连接 ---------- */
async function testConnection() {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) return { ok: false, message: '请先填写 API Key' };
  if (!cfg.baseUrl) return { ok: false, message: '请先填写 API Base URL' };
  if (!cfg.model) return { ok: false, message: '请先填写模型名称' };
  try {
    const content = await callLLM([
      { role: 'system', content: '只回复两个字：正常' },
      { role: 'user', content: '测试' }
    ], { timeout: 30000, maxTokens: 200 });
    return { ok: true, message: `连接成功：${cfg.model}`, reply: content.slice(0, 50) };
  } catch (e) {
    return { ok: false, message: `连接失败：${e.message}` };
  }
}

module.exports = { handle, handleAuto, parse, parseWithLLM, testConnection, isLLMConfigured, getLLMConfig, callLLM, INTENTS, PROVIDERS };