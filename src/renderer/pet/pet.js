'use strict';

/* ============================================================
 * 桌宠渲染逻辑（deepseek酱 鲸鱼娘 sprite 版）
 * 常驻桌面最表层：可拖拽、气泡提醒、快捷菜单、sprite 帧动画
 * ============================================================ */

const petEl = document.getElementById('pet');
const petWrap = document.getElementById('pet-wrap');
const petBubble = document.getElementById('pet-bubble');
const petMenu = document.getElementById('pet-menu');
const petSprite = document.getElementById('pet-sprite');

let bubbleTimer = null;
let idleTimer = null;
let currentMood = 'normal'; // normal | happy | surprised | sad
let wasDragging = false; // 标记最近一次是否发生了拖拽（用于区分点击）

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
function showBubble(text, hot, ms) {
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
  showBubble(`⏰ ${data.title}${data.due ? ' · ' + data.due : ''}`, true, 6000);
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
  const show = petMenu.classList.toggle('hidden');
  if (!show) {
    setMood('happy');
    showBubble('今日待办 · 点击菜单快速操作', false);
    setTimeout(() => setMood('normal'), 1500);
  }
});

// 双击直接打开主窗口
petEl.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  petMenu.classList.add('hidden');
  setMood('happy');
  window.api.pet.openView('today');
  setTimeout(() => setMood('normal'), 1500);
});

document.addEventListener('click', (e) => {
  if (!petMenu.classList.contains('hidden') && !e.target.closest('#pet-menu')) {
    petMenu.classList.add('hidden');
  }
});

petMenu.addEventListener('click', (e) => {
  const it = e.target.closest('.pm-it');
  if (!it) return;
  petMenu.classList.add('hidden');
  const map = {
    new: '新建任务',
    ai: 'AI 对话',
    today: '今日视图',
    board: '看板',
    cal: '日历',
    stat: '统计',
    trash: '回收站',
    settings: '设置'
  };
  showBubble(`已唤起「${map[it.dataset.pet]}」`, false);
  // 联动主窗口：唤起对应视图
  const viewMap = { new: 'tasks', ai: 'ai', today: 'today', board: 'board', cal: 'cal', stat: 'stat', trash: 'trash', settings: 'settings' };
  window.api.pet.openView(viewMap[it.dataset.pet] || 'today');
});

/* ---------- 右键菜单 ---------- */
petEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  petMenu.classList.add('hidden');
  // 通过主进程显示原生菜单
  window.api.pet.contextMenu();
});

/* ---------- 状态刷新 ---------- */
async function refreshStatus() {
  try {
    const tasks = await window.api.tasks.getAll();
    const active = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
    const todo = active.length;
    // 下一项：最近到期且未过期的任务
    const now = new Date();
    const upcoming = active
      .filter((t) => t.due && new Date(t.due.replace(' ', 'T') + ':00') >= now)
      .sort((a, b) => a.due.localeCompare(b.due));
    const next = upcoming[0];
    if (next) {
      showBubble(`今日待办 ${todo} 项 · 下一项 ${next.title}`, false, 5000);
    } else {
      showBubble(`今日待办 ${todo} 项`, false, 4000);
    }
  } catch (e) {
    showBubble('工作台助手', false);
  }
}

/* ---------- 主进程事件 ---------- */
if (window.api && typeof window.api.on === 'function') {
  window.api.on('pet:remind', remind);
}

/* ---------- 初始化 ---------- */
(async function init() {
  playSprite('idle');
  startIdle();
  await refreshStatus();
  // 每分钟刷新待办数
  setInterval(refreshStatus, 60000);
})();