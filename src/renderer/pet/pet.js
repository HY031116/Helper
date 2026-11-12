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
const petReminder = document.getElementById('pet-reminder');
const petReminderText = document.getElementById('pet-reminder-text');
const petSprite = document.getElementById('pet-sprite');

let bubbleTimer = null;
let idleTimer = null;
let moodTimer = null;
let currentMood = 'normal'; // normal | happy | surprised | sad
let wasDragging = false; // 标记最近一次是否发生了拖拽（用于区分点击）
let statusSnapshot = { todo: 0, overdue: 0, next: null };
let pendingReminder = null;
let petNavigationBusy = false;
let petNavigationFeedback = null;
let statusRequestSequence = 0;
let themePreference = 'auto';
const PET_MOTION_MS = Object.freeze({ fast: 140, base: 220, slow: 320 });
const systemTheme = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false, addEventListener() {} };

function applyTheme(theme) {
  // 桌宠只有浅色/暗色两套外观；液态玻璃与极简单色都按浅色处理
  themePreference = ['light', 'dark', 'auto', 'glass', 'mono'].includes(theme) ? theme : 'auto';
  const dark = themePreference === 'dark' || (themePreference === 'auto' && systemTheme.matches);
  document.body.classList.toggle('dark', dark);
}

systemTheme.addEventListener('change', () => {
  if (themePreference === 'auto') applyTheme('auto');
});

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function showPetLayer(element) {
  if (element._hideTimer) clearTimeout(element._hideTimer);
  element._hideTimer = null;
  element.classList.remove('hidden', 'is-leaving');
  element.inert = false;
}

function hidePetLayer(element, immediate, onHidden) {
  if (element._hideTimer) clearTimeout(element._hideTimer);
  const finish = () => {
    element._hideTimer = null;
    element.classList.remove('is-leaving');
    element.classList.add('hidden');
    if (onHidden) onHidden();
  };
  element.inert = true;
  if (immediate || element.classList.contains('hidden') || prefersReducedMotion()) {
    finish();
    return;
  }
  element.classList.add('is-leaving');
  element._hideTimer = setTimeout(finish, PET_MOTION_MS.fast);
}

function isMenuOpen() {
  return !petMenu.classList.contains('hidden') && !petMenu.classList.contains('is-leaving');
}

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
  if (moodTimer) clearTimeout(moodTimer);
  moodTimer = null;
  currentMood = mood;
  playSprite(MOOD_TO_STATE[mood] || 'idle');
}

function setTemporaryMood(mood, milliseconds) {
  setMood(mood);
  moodTimer = setTimeout(() => {
    moodTimer = null;
    if (currentMood === mood) setMood('normal');
  }, milliseconds);
}

/* ---------- 气泡 ---------- */
function setMenuOpen(open, returnFocus, immediate) {
  const wasOpen = isMenuOpen();
  petMenu.setAttribute('aria-hidden', String(!open));
  petEl.setAttribute('aria-expanded', String(open));
  if (open) {
    if (!wasOpen && !petNavigationBusy) petNavigationFeedback = null;
    clearTimeout(bubbleTimer);
    hidePetLayer(petBubble, true);
    showPetLayer(petMenu);
    setMood('happy');
    refreshStatus(false);
    setTimeout(() => {
      const firstAction = pendingReminder ? petReminder : petMenu.querySelector('[data-pet]');
      if (firstAction) firstAction.focus();
    }, 0);
  } else {
    hidePetLayer(petMenu, !!immediate, () => {
      if (returnFocus) petEl.focus();
    });
    if (wasOpen) setMood('normal');
  }
}

async function openPetDestination(control, destination, label) {
  if (petNavigationBusy) return false;
  const menuWasOpen = isMenuOpen();
  const controls = Array.from(petMenu.querySelectorAll('[data-pet]'));
  const states = controls.map((button) => ({ button, disabled: button.disabled }));
  petNavigationBusy = true;
  petNavigationFeedback = { message: `正在打开「${label}」`, type: 'busy' };
  petMenu.setAttribute('aria-busy', 'true');
  controls.forEach((button) => { button.disabled = true; });
  if (control) {
    control.setAttribute('aria-busy', 'true');
    control.classList.add('is-busy');
  }
  renderStatus();
  try {
    await window.api.pet.openView(destination);
    petNavigationFeedback = null;
    if (menuWasOpen) setMenuOpen(false, false);
    setTemporaryMood('happy', 1500);
    return true;
  } catch (error) {
    petNavigationFeedback = { message: '暂时无法打开，请重试', type: 'error' };
    setTemporaryMood('sad', 1800);
    if (menuWasOpen && isMenuOpen()) renderStatus();
    else showBubble('主窗口暂时无法打开，请再试一次', true, 3000);
    return false;
  } finally {
    states.forEach(({ button, disabled }) => { button.disabled = disabled; });
    petMenu.setAttribute('aria-busy', 'false');
    petNavigationBusy = false;
    if (control) {
      control.setAttribute('aria-busy', 'false');
      control.classList.remove('is-busy');
      if (menuWasOpen && isMenuOpen()) control.focus();
    }
  }
}

function trapMenuFocus(e) {
  if (e.key !== 'Tab' || !isMenuOpen()) return;
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
  setMenuOpen(false, false, true);
  petBubble.textContent = text;
  petBubble.classList.toggle('hot', !!hot);
  showPetLayer(petBubble);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => hidePetLayer(petBubble, false), ms || 4000);
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
  pendingReminder = { id: data.id, title: data.title, due: data.due || '' };
  renderStatus();
  showBubble(`提醒 · ${data.title}${data.due ? ' · ' + data.due : ''}`, true, 6000);
  setTemporaryMood('surprised', 3000);
}

/* ---------- 拖拽 ---------- */
(function () {
  let dragging = false;
  let moved = false; // 是否真正移动过（区分点击与拖拽）
  let moveFrame = null;
  let pendingPosition = null;
  let offsetX = 0, offsetY = 0; // 鼠标在窗口内的偏移
  let startX = 0, startY = 0; // 按下时的鼠标位置
  const DRAG_THRESHOLD = 5; // 超过 5px 才算拖拽

  const flushPosition = () => {
    moveFrame = null;
    if (!pendingPosition) return;
    const position = pendingPosition;
    pendingPosition = null;
    window.api.pet.setPosition(position).catch(() => {});
  };

  const queuePosition = (position) => {
    pendingPosition = position;
    if (moveFrame !== null) return;
    const requestFrame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback) => setTimeout(callback, 16);
    moveFrame = requestFrame(flushPosition);
  };

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
    if (!moved) {
      moved = true;
      setMenuOpen(false, false, true);
      window.api.pet.closePanel().catch(() => {});
      if (moodTimer) clearTimeout(moodTimer);
      moodTimer = null;
      currentMood = 'moving';
    }
    // 跟随鼠标移动方向播放奔跑动画
    playSprite(e.clientX >= startX ? 'running-right' : 'running-left');
    // 新窗口位置 = 鼠标屏幕坐标 - 鼠标在窗口内的偏移
    const x = e.screenX - offsetX;
    const y = e.screenY - offsetY;
    queuePosition({ x, y });
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      petWrap.classList.remove('dragging');
      // 只有真正拖拽过才保存最终位置；主进程负责多屏边界钳制。
      if (moved) {
        wasDragging = true;
        flushPosition();
        setTemporaryMood('happy', 1500);
        window.api.pet.commitPosition().catch(() => {
          showBubble('位置暂时无法保存，下次启动可能会复位', true, 3000);
        });
        // 短暂延迟后清除拖拽标记，避免本次 click 被误判
        setTimeout(() => { wasDragging = false; }, 100);
      } else {
        // 未拖动松手，恢复待机
        setMood('normal');
      }
    }
  });
})();

/* ---------- 菜单 ---------- */
petEl.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (wasDragging) return;
  try {
    const result = await window.api.pet.togglePanel('overview');
    petEl.setAttribute('aria-expanded', String(!!result?.visible));
    setTemporaryMood(result?.visible ? 'happy' : 'normal', 1200);
  } catch (error) {
    showBubble('桌宠助手暂时无法打开，请重试', true, 3000);
  }
});

petEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  petEl.click();
});

// 双击直接打开主窗口
petEl.addEventListener('dblclick', async (e) => {
  e.stopPropagation();
  setMenuOpen(false, false);
  await window.api.pet.closePanel();
  await openPetDestination(null, 'today', '今日视图');
});

document.addEventListener('click', (e) => {
  if (isMenuOpen() && !e.target.closest('#pet-menu') && !e.target.closest('#pet')) {
    setMenuOpen(false, false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isMenuOpen()) {
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
  const map = {
    new: '新建任务',
    ai: '工作台助手',
    today: '今日视图',
    list: '清单',
    records: '记录',
    settings: '设置'
  };
  // 联动主窗口：唤起对应视图
  const viewMap = { new: 'new', ai: 'ai', today: 'today', list: 'list', records: 'records', settings: 'settings' };
  await openPetDestination(it, viewMap[it.dataset.pet] || 'today', map[it.dataset.pet]);
});

petReminder.addEventListener('click', async (event) => {
  event.stopPropagation();
  if (!pendingReminder || petReminder.disabled) return;
  const reminder = pendingReminder;
  petReminder.disabled = true;
  petReminder.setAttribute('aria-busy', 'true');
  petReminderText.textContent = '正在打开…';
  try {
    await window.api.pet.openTask(reminder.id);
    pendingReminder = null;
    setMenuOpen(false, false);
  } catch (error) {
    showBubble('提醒任务暂时无法打开，请再试一次', true, 3000);
  } finally {
    petReminder.disabled = false;
    petReminder.setAttribute('aria-busy', 'false');
    renderStatus();
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
  petMenu.classList.toggle('has-reminder', !!pendingReminder);
  petReminder.classList.toggle('hidden', !pendingReminder);
  if (pendingReminder) {
    petReminderText.textContent = `查看 · ${pendingReminder.title}`;
    petReminder.setAttribute('aria-label', `查看提醒任务：${pendingReminder.title}`);
  }
  petMenuTitle.textContent = statusSnapshot.overdue ? `工作台 · ${statusSnapshot.overdue} 项逾期` : '工作台';
  petMenuCount.textContent = `${statusSnapshot.todo} 项待办`;
  petMenu.classList.toggle('has-overdue', statusSnapshot.overdue > 0);
  petMenuNext.classList.toggle('is-feedback', !!petNavigationFeedback);
  petMenuNext.classList.toggle('is-error', petNavigationFeedback?.type === 'error');
  if (petNavigationFeedback) {
    petMenuNext.textContent = petNavigationFeedback.message;
  } else if (statusSnapshot.overdue) {
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
  const requestId = ++statusRequestSequence;
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
    if (requestId !== statusRequestSequence) return false;
    statusSnapshot = { todo: active.length, overdue: overdue.length, next: overdue[0] || upcoming[0] || null };
    renderStatus();
    if (announce) {
      const detail = statusSnapshot.next ? ` · ${statusSnapshot.overdue ? '先处理' : '下一项'} ${statusSnapshot.next.title}` : '';
      showBubble(`${statusSnapshot.todo} 项待办${detail}`, statusSnapshot.overdue > 0, 4000);
    }
    return true;
  } catch (e) {
    if (requestId !== statusRequestSequence) return false;
    petMenuCount.textContent = '暂时无法同步';
    petMenuNext.textContent = '打开工作台后可查看最新任务';
    if (announce) showBubble('暂时无法同步任务', true, 3000);
    return false;
  }
}

/* ---------- 主进程事件 ---------- */
if (window.api && typeof window.api.on === 'function') {
  window.api.on('pet:remind', remind);
  window.api.on('pet:theme', applyTheme);
  window.api.on('pet-panel:visibility', (visible) => {
    petEl.setAttribute('aria-expanded', String(!!visible));
  });
  window.api.on('tasks:changed', () => refreshStatus(false));
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
