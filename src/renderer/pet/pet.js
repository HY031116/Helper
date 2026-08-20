'use strict';

/* ============================================================
 * 桌宠渲染逻辑（deepseek酱 鲸鱼娘 sprite 版）
 * 常驻桌面最表层：可拖拽、气泡提醒、快捷菜单、sprite 帧动画
 * ============================================================ */

const petEl = document.getElementById('pet');
const petWrap = document.getElementById('pet-wrap');
const petBubble = document.getElementById('pet-bubble');
const petMenu = document.getElementById('pet-menu');
const petMenuClose = document.getElementById('pet-menu-close');
const petMenuTitle = document.getElementById('pet-menu-title');
const petMenuCount = document.getElementById('pet-menu-count');
const petMenuNext = document.getElementById('pet-menu-next');
const petSprite = document.getElementById('pet-sprite');

let bubbleTimer = null;
let idleTimer = null;
let currentMood = 'normal'; // normal | happy | surprised | sad
let wasDragging = false; // 标记最近一次是否发生了拖拽（用于区分点击）
let statusSnapshot = { todo: 0, overdue: 0, next: null };
let themePreference = 'auto';
const systemTheme = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false, addEventListener() {} };

function applyTheme(theme) {
  themePreference = ['light', 'dark', 'auto'].includes(theme) ? theme : 'auto';
  const dark = themePreference === 'dark' || (themePreference === 'auto' && systemTheme.matches);
  document.body.classList.toggle('dark', dark);
}

systemTheme.addEventListener('change', () => {
  if (themePreference === 'auto') applyTheme('auto');
});

/* ---------- 精灵图动作表（Petdex deepseek酱，192x208/帧，8x9 网格） ---------- */
const SPRITE_STATES = {
  idle:           { row: 0, frames: 6, duration: 1100 },
  'running-right':{ row: 1, frames: 8, duration: 1060 },
  'running-left': { row: 2, frames: 8, duration: 1060 },
  waving:         { row: 3, frames: 4, duration: 800 },
  jumping:        { row: 4, frames: 5, duration: 900 },
  failed:         { row: 5, frames: 8, duration: 1060 },
  waiting:        { row: 6, frames: 6, duration: 1100 },
  running:        { row: 7, frames: 6, duration: 700 },
  review:         { row: 8, frames: 6, duration: 1100 }
};

/* 情绪 → 动作 映射 */
const MOOD_TO_STATE = { normal: 'idle', happy: 'waving', surprised: 'jumping', sad: 'failed' };

/* 播放指定动作（切换行/帧数/时长，动画自动循环） */
function playSprite(state) {
  const s = SPRITE_STATES[state] || SPRITE_STATES.idle;
  petSprite.style.setProperty('--sprite-row', s.row);
  petSprite.style.setProperty('--sprite-frames', s.frames);
  petSprite.style.setProperty('--sprite-duration', s.duration + 'ms');
}

/* ---------- 表情（映射到 sprite 动作） ---------- */
function setMood(mood) {
  currentMood = mood;
  playSprite(MOOD_TO_STATE[mood] || 'idle');
}

/* ---------- 气泡 ---------- */
function setMenuOpen(open, returnFocus) {
  const wasOpen = !petMenu.classList.contains('hidden');
  petMenu.classList.toggle('hidden', !open);
  petMenu.setAttribute('aria-hidden', String(!open));
  petEl.setAttribute('aria-expanded', String(open));
  if (open) {
    clearTimeout(bubbleTimer);
    petBubble.classList.add('hidden');
    setMood('happy');
    refreshStatus(false);
    setTimeout(() => {
      const firstAction = petMenu.querySelector('[data-pet]');
      if (firstAction) firstAction.focus();
    }, 0);
  } else {
    if (wasOpen) setMood('normal');
    if (returnFocus) petEl.focus();
  }
}

function trapMenuFocus(e) {
  if (e.key !== 'Tab' || petMenu.classList.contains('hidden')) return;
  const focusable = Array.from(petMenu.querySelectorAll('button:not([disabled]):not([tabindex="-1"])'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function onViewGridKeyDown(e) {
  const item = e.target.closest('.pm-it');
  if (!item) return;
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll('.pm-it'));
  const index = items.indexOf(item);
  if (index < 0 || !items.length) return;
  e.preventDefault();
  let target = index;
  if (e.key === 'Home') target = 0;
  else if (e.key === 'End') target = items.length - 1;
  else if (e.key === 'ArrowLeft') target = (index - 1 + items.length) % items.length;
  else if (e.key === 'ArrowRight') target = (index + 1) % items.length;
  else if (e.key === 'ArrowUp') target = (index - 3 + items.length) % items.length;
  else target = (index + 3) % items.length;
  items.forEach((button, itemIndex) => { button.tabIndex = itemIndex === target ? 0 : -1; });
  items[target].focus();
}

function showBubble(text, hot, ms) {
  setMenuOpen(false, false);
  petBubble.textContent = text;
  petBubble.classList.toggle('hot', !!hot);
  petBubble.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => petBubble.classList.add('hidden'), ms || 4000);
}

/* ---------- 空闲小动作：随机挥手/审视/等待后回归待机 ---------- */
function startIdle() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (currentMood !== 'normal') return;
    const acts = ['waving', 'review', 'waiting'];
    playSprite(acts[Math.floor(Math.random() * acts.length)]);
    setTimeout(() => {
      if (currentMood === 'normal') playSprite('idle');
    }, 1500);
  }, 8000);
}

/* ---------- 提醒 ---------- */
function remind(data) {
  petEl.classList.remove('alert');
  void petEl.offsetWidth; // 重启动画
  petEl.classList.add('alert');
  setMood('surprised');
  showBubble(`提醒 · ${data.title}${data.due ? ' · ' + data.due : ''}`, true, 6000);
  // 3 秒后恢复
  setTimeout(() => setMood('normal'), 3000);
}

/* ---------- 拖拽 ---------- */
(function () {
  let dragging = false;
  let moved = false; // 是否真正移动过（区分点击与拖拽）
  let offsetX = 0, offsetY = 0; // 鼠标在窗口内的偏移
  let startX = 0, startY = 0; // 按下时的鼠标位置
  const DRAG_THRESHOLD = 5; // 超过 5px 才算拖拽

  petWrap.addEventListener('mousedown', async (e) => {
    if (e.target.closest('.pet-menu')) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    // 记录鼠标在窗口内的偏移（clientX 是窗口内坐标）
    offsetX = e.clientX;
    offsetY = e.clientY;
    petWrap.classList.add('dragging');
    playSprite('waiting'); // 准备抓取
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // 判断是否超过拖拽阈值
    if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) {
      return;
    }
    moved = true;
    setMenuOpen(false, false);
    // 跟随鼠标移动方向播放奔跑动画
    playSprite(e.clientX >= startX ? 'running-right' : 'running-left');
    // 新窗口位置 = 鼠标屏幕坐标 - 鼠标在窗口内的偏移
    const x = e.screenX - offsetX;
    const y = e.screenY - offsetY;
    window.api.pet.setPosition({ x, y });
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      petWrap.classList.remove('dragging');
      // 只有真正拖拽过才吸附边缘；否则视为点击（交给 click 事件）
      if (moved) {
        wasDragging = true;
        setMood('happy');
        setTimeout(() => setMood('normal'), 1500);
        snapToEdge();
        // 短暂延迟后清除拖拽标记，避免本次 click 被误判
        setTimeout(() => { wasDragging = false; }, 100);
      } else {
        // 未拖动松手，恢复待机
        setMood('normal');
      }
    }
  });
})();

/* ---------- 吸附屏幕边缘 ---------- */
function snapToEdge() {
  window.api.pet.snapToEdge().catch(() => {});
}

/* ---------- 菜单 ---------- */
petEl.addEventListener('click', (e) => {
  e.stopPropagation();
  // 刚拖拽过松手触发的 click，忽略（避免拖完弹菜单）
  if (wasDragging) return;
  setMenuOpen(petMenu.classList.contains('hidden'), false);
});

petEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  setMenuOpen(petMenu.classList.contains('hidden'), false);
});

// 双击直接打开主窗口
petEl.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  setMenuOpen(false, false);
  setMood('happy');
  window.api.pet.openView('today');
  setTimeout(() => setMood('normal'), 1500);
});

document.addEventListener('click', (e) => {
  if (!petMenu.classList.contains('hidden') && !e.target.closest('#pet-menu') && !e.target.closest('#pet')) {
    setMenuOpen(false, false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !petMenu.classList.contains('hidden')) {
    e.preventDefault();
    setMenuOpen(false, true);
  }
});

petMenuClose.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenuOpen(false, true);
});

petMenu.addEventListener('keydown', trapMenuFocus);
petMenu.querySelector('.pm-grid').addEventListener('keydown', onViewGridKeyDown);

petMenu.addEventListener('click', async (e) => {
  const it = e.target.closest('[data-pet]');
  if (!it) return;
  setMenuOpen(false, false);
  const map = {
    new: '新建任务',
    ai: '工作台助手',
    today: '今日视图',
    board: '看板',
    cal: '日历',
    stat: '统计',
    trash: '回收站',
    settings: '设置'
  };
  showBubble(`正在打开「${map[it.dataset.pet]}」`, false, 1800);
  // 联动主窗口：唤起对应视图
  const viewMap = { new: 'new', ai: 'ai', today: 'today', board: 'board', cal: 'cal', stat: 'stat', trash: 'trash', settings: 'settings' };
  try {
    await window.api.pet.openView(viewMap[it.dataset.pet] || 'today');
  } catch (error) {
    showBubble('主窗口暂时没有打开，请再试一次', true, 3000);
  }
});

/* ---------- 右键菜单 ---------- */
petEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  setMenuOpen(false, false);
  // 通过主进程显示原生菜单
  window.api.pet.contextMenu();
});

/* ---------- 状态刷新 ---------- */
function formatPetDue(value) {
  if (!value) return '';
  const [dateKey, time = ''] = String(value).split(' ');
  const dueDate = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(dueDate.getTime())) return value;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((dueDate.getTime() - today.getTime()) / 86400000);
  let day;
  if (dayDiff === -1) day = '昨天';
  else if (dayDiff === 0) day = '今天';
  else if (dayDiff === 1) day = '明天';
  else if (dayDiff > 1 && dayDiff < 7) day = `周${'日一二三四五六'[dueDate.getDay()]}`;
  else day = dateKey.slice(5).replace('-', '月') + '日';
  return `${day}${time ? ` ${time}` : ''}`;
}

function renderStatus() {
  petMenuTitle.textContent = statusSnapshot.overdue ? `工作台 · ${statusSnapshot.overdue} 项逾期` : '工作台';
  petMenuCount.textContent = `${statusSnapshot.todo} 项待办`;
  petMenu.classList.toggle('has-overdue', statusSnapshot.overdue > 0);
  if (statusSnapshot.overdue) {
    petMenuNext.textContent = `优先处理 · ${statusSnapshot.next.title}${statusSnapshot.next.due ? ` · ${formatPetDue(statusSnapshot.next.due)}` : ''}`;
  } else if (statusSnapshot.next) {
    petMenuNext.textContent = `下一项 · ${statusSnapshot.next.title}${statusSnapshot.next.due ? ` · ${formatPetDue(statusSnapshot.next.due)}` : ''}`;
  } else if (statusSnapshot.todo) {
    petMenuNext.textContent = '待办尚未安排时间 · 打开今天查看';
  } else {
    petMenuNext.textContent = '今天已清空 · 可以新建任务';
  }
}

async function refreshStatus(announce) {
  try {
    const tasks = await window.api.tasks.getAll();
    const active = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
    const now = new Date();
    const overdue = active
      .filter((t) => t.due && new Date(t.due.replace(' ', 'T') + ':00') < now)
      .sort((a, b) => a.due.localeCompare(b.due));
    const upcoming = active
      .filter((t) => t.due && new Date(t.due.replace(' ', 'T') + ':00') >= now)
      .sort((a, b) => a.due.localeCompare(b.due));
    statusSnapshot = { todo: active.length, overdue: overdue.length, next: overdue[0] || upcoming[0] || null };
    renderStatus();
    if (announce) {
      const detail = statusSnapshot.next ? ` · ${statusSnapshot.overdue ? '先处理' : '下一项'} ${statusSnapshot.next.title}` : '';
      showBubble(`${statusSnapshot.todo} 项待办${detail}`, statusSnapshot.overdue > 0, 4000);
    }
  } catch (e) {
    petMenuCount.textContent = '暂时无法同步';
    petMenuNext.textContent = '打开工作台后可查看最新任务';
    if (announce) showBubble('暂时无法同步任务', true, 3000);
  }
}

/* ---------- 主进程事件 ---------- */
if (window.api && typeof window.api.on === 'function') {
  window.api.on('pet:remind', remind);
  window.api.on('pet:theme', applyTheme);
}

/* ---------- 初始化 ---------- */
(async function init() {
  try {
    const petSettings = await window.api.settings.get();
    applyTheme(petSettings && petSettings.theme);
  } catch (e) {
    applyTheme('auto');
  }
  playSprite('idle');
  startIdle();
  await refreshStatus(false);
  // 每分钟静默刷新菜单状态，不主动打断用户。
  setInterval(() => refreshStatus(false), 60000);
})();
