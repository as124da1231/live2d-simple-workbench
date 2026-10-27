/**
 * 简易工作台预览：两个层级共用同一个 kit 身体。
 *  桌面层：真实屏幕尺寸 / S / 地板 / 活动范围 / 拖动测试
 *  身体层：256 logo 盒 / fit / 命中圈 / 锚点 / 偏差读数
 * 只使用 Coo 的 kit + 包内渲染内核；不做原生 exp3 / motion 播放。
 */
const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const stage = $('#stage');
const root = $('#root');
const overlay = $('#overlay');
const hud = $('#hud');
const boot = $('#boot');

const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const send = (m) => { try { if (window.parent !== window) parent.postMessage(m, '*'); } catch { /* ignore */ } };
const log = (level, text) => send({ t: 'log', level, text: String(text) });
function logError(text) {
  const now = performance.now();
  const msg = String(text);
  if (msg === state.lastError && now - state.lastErrorAt < 3000) return;
  state.lastError = msg;
  state.lastErrorAt = now;
  log('error', msg);
}
window.addEventListener('error', (e) => logError(e.message || e.error));
window.addEventListener('unhandledrejection', (e) => logError((e.reason && e.reason.message) || e.reason));

const state = {
  env: {
    w: Math.max(480, window.screen?.width || 1366),
    h: Math.max(360, window.screen?.height || 768),
    availH: Math.max(360, window.screen?.availHeight || window.screen?.height || 768),
    below: 0,
    scale: 1.7,
    petX: null,
    rememberPosition: false,
  },
  layer: 'body',
  motion: 'free',
  bounds: { W: 1366, H: 768, floorY: 720, S: .714 },
  body: null,
  info: null,
  fit: null,
  layout: null,
  viewScale: 1,
  mode100: false,
  pressing: false,
  dragStart: null,
  lastP: null,
  drop: null,
  fitDrag: null,
  remeasureAt: 0,
  lastInfo: 0,
  last: 0,
  lastError: '',
  lastErrorAt: 0,
  words: [],
  envApplied: false,
};

state.env.below = Math.max(0, state.env.h - state.env.availH);
state.bounds = {
  W: state.env.w,
  H: state.env.h,
  floorY: Math.max(80, state.env.h - 2 - state.env.below),
  S: .42 * state.env.scale,
};

const host = {
  root,
  bounds: () => state.bounds,
  emit: (kind, detail) => send({ t: 'event', kind, detail }),
  sound: () => {},
  start: { x: state.bounds.W * .7, facing: 1 },
};

const loadImage = (u) => new Promise((ok, bad) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => ok(img);
  img.onerror = () => bad(new Error('图片加载失败 ' + u));
  img.src = String(u);
});

/* ---------------- 舞台 / 视图缩放 ---------------- */

function layoutStage() {
  const b = state.bounds;
  stage.style.width = b.W + 'px';
  stage.style.height = b.H + 'px';
  overlay.setAttribute('viewBox', `0 0 ${b.W} ${b.H}`);
  overlay.setAttribute('width', b.W);
  overlay.setAttribute('height', b.H);
  resizeView();
}

function resizeView() {
  const r = viewport.getBoundingClientRect();
  const b = state.bounds;
  if (state.mode100) {
    // 100% 时对准宠物，而不是屏幕中心：否则 70%W 的她会被裁在视口外
    const fx = state.layout?.x ?? (state.layer === 'desktop' ? b.W * .7 : b.W / 2);
    const fy = state.layout?.box ? state.layout.box.y + state.layout.box.h / 2 : (state.layer === 'desktop' ? b.floorY - 100 : b.H / 2);
    state.viewScale = 1;
    stage.style.transform = `translate(-50%, -50%) translate(${b.W / 2 - fx}px, ${b.H / 2 - fy}px) scale(1)`;
    send({ t: 'view', view: 1, mode100: true });
    return;
  }
  const k = Math.min((r.width - 28) / b.W, (r.height - 28) / b.H);
  state.viewScale = clamp(k || .2, .05, 4);
  stage.style.transform = `translate(-50%, -50%) scale(${state.viewScale})`;
  send({ t: 'view', view: state.viewScale, mode100: false });
}

function desktopBounds() {
  const e = state.env;
  const W = Math.max(320, e.w);
  const H = Math.max(240, e.h);
  return { W, H, floorY: Math.max(80, H - 2 - (e.below || 0)), S: .42 * e.scale };
}

function applyLayer(layer, o = {}) {
  if (!state.body) return;
  const prevShare = state.layer === 'desktop' && state.bounds.W ? (state.layout?.x ?? state.bounds.W * .7) / state.bounds.W : state.xShare;
  state.layer = layer;
  stage.dataset.layer = layer;

  if (layer === 'desktop') {
    state.bounds = desktopBounds();
    layoutStage();
    state.body.resize();
    const S = state.bounds.S;
    const minX = 104 * S + 8;
    const maxX = state.bounds.W - minX;
    const want = o.init && state.env.rememberPosition && state.env.petX != null
      ? state.env.petX
      : (o.petX != null ? o.petX : (prevShare ?? .7));
    const x = clamp(want * state.bounds.W, minX, maxX);
    try { state.body.place(x, 1); } catch { /* ignore */ }
    state.xShare = x / state.bounds.W;
  } else {
    state.bounds = { W: 620, H: 620, floorY: 512, S: 2 };
    layoutStage();
    state.body.resize();
    try { state.body.place(state.bounds.W / 2, 1); } catch { /* ignore */ }
  }
  state.layout = state.body.layout?.() ?? null;
  send({ t: 'layer', layer });
}

/* ---------------- 绘制辅助线 ---------------- */

function add(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  overlay.appendChild(el);
  return el;
}

function logoToStage(lx, ly, anchorX, floorY, S) {
  return { x: anchorX + (lx - 128) * S, y: floorY - (256 - ly) * S };
}

function headHit(ext, hits) {
  // 头圈是否真的盖住头顶：用第一段命中圈的圆心/半径和可见范围顶部比，
  // 不再“有圈就算过”（那样永远为真）。ext / info.hits 都是 256 logo 坐标。
  if (!ext || !hits?.length) return null;
  const c = hits[0];
  const cy = Array.isArray(c) ? c[1] : c?.y;
  const r = Array.isArray(c) ? c[2] : c?.r;
  if (!Number.isFinite(cy) || !Number.isFinite(r)) return null;
  return Math.abs(cy - ext[1]) <= r;
}

function drawDesktop(b, layout) {
  const W = b.W, H = b.H, S = b.S, floorY = b.floorY;
  const minX = 104 * S + 8, maxX = W - minX;
  const anchorX = layout?.x ?? W * .7;

  add('rect', { class: 'taskbar', x: 0, y: floorY + 2, width: W, height: Math.max(0, H - floorY - 2) });
  add('rect', { class: 'band', x: minX, y: 0, width: Math.max(0, maxX - minX), height: floorY });
  add('line', { class: 'guide accent', x1: minX, y1: 0, x2: minX, y2: floorY });
  add('line', { class: 'guide accent', x1: maxX, y1: 0, x2: maxX, y2: floorY });
  add('line', { class: 'guide', x1: 0, y1: floorY, x2: W, y2: floorY });
  add('text', { class: 'label', x: minX + 10, y: 26 }, '可移动 · 中心范围');
  add('text', { class: 'label', x: Math.max(10, minX + 10), y: floorY - 10 }, '地板');

  const heldY = floorY - 25 * S;
  add('rect', { class: 'band held', x: minX, y: heldY, width: Math.max(0, maxX - minX), height: 25 * S });
  add('text', { class: 'label warn', x: minX + 10, y: heldY + 22 }, '拎起最多 25·S');

  if (layout?.box) {
    add('rect', { class: 'guide warn', x: layout.box.x, y: layout.box.y, width: layout.box.w, height: layout.box.h });
    add('text', { class: 'label warn', x: layout.box.x + 6, y: layout.box.y - 8 }, '可见范围');
  }
  if (layout?.mode !== 'drag') {
    const bx = anchorX - 128 * S, by = floorY - 256 * S;
    add('rect', { class: 'guide dim', x: bx, y: by, width: 256 * S, height: 256 * S });
  }
  for (const c of layout?.hit ?? []) add('circle', { class: 'hit', cx: c.x, cy: c.y, r: c.r });

  // facing arrow
  const dir = (layout?.facing ?? 1) < 0 ? -1 : 1;
  const ay = floorY - 14;
  add('polygon', { class: 'marker', points: `${anchorX},${ay} ${anchorX + 26 * dir},${ay - 8} ${anchorX + 26 * dir},${ay + 8}` });
  add('text', { class: 'label', x: anchorX + 32 * dir - (dir < 0 ? 40 : 0), y: ay + 5 }, dir > 0 ? '朝向 →' : '← 朝向');

  // home / saved / current
  add('polygon', { class: 'marker home', points: `${W * .7},${floorY - 20} ${W * .7 - 8},${floorY - 4} ${W * .7 + 8},${floorY - 4}` });
  add('text', { class: 'label', x: W * .7 + 12, y: floorY - 8 }, '0.7W');
  if (state.env.petX != null) {
    const sx = clamp(state.env.petX, 0, 1) * W;
    add('line', { class: 'guide warn', x1: sx, y1: floorY - 26, x2: sx, y2: floorY + 2 });
    add('text', { class: 'label warn', x: sx + 6, y: floorY + 18 }, '记忆位置');
  }
  add('line', { class: 'guide accent', x1: anchorX, y1: floorY - 34, x2: anchorX, y2: floorY + 2 });
  add('text', { class: 'label accent', x: anchorX + 6, y: floorY + 18 }, '当前');

  if (state.drop) {
    add('circle', { class: 'hit miss', cx: state.drop.x, cy: state.drop.y, r: 10 });
    add('text', { class: 'label danger', x: state.drop.x + 14, y: state.drop.y + 6 }, '松手位置');
  }
  if (state.pressing && state.dragStart && state.lastP) {
    add('line', { class: 'guide accent', x1: state.dragStart.x, y1: state.dragStart.y, x2: state.lastP.x, y2: state.lastP.y });
    add('circle', { class: 'dot', cx: state.dragStart.x, cy: state.dragStart.y, r: 5 });
  }
}

function drawBody(b, layout, info) {
  const W = b.W, H = b.H, S = b.S, floorY = b.floorY;
  const anchorX = layout?.x ?? W / 2;
  const x0 = anchorX - 128 * S;
  const y0 = floorY - 256 * S;

  add('rect', { class: 'guide accent', x: x0, y: y0, width: 256 * S, height: 256 * S });
  add('text', { class: 'label dark accent', x: x0 + 8, y: y0 + 22 }, '256 logo box');
  add('line', { class: 'guide dark', x1: x0, y1: y0 + 256 * S, x2: x0 + 256 * S, y2: y0 + 256 * S });
  add('text', { class: 'label dark', x: x0 + 8, y: y0 + 256 * S - 8 }, '脚 256 · 地板');

  const sx = x0 + 128 * S, sy = y0 + 36 * S;
  add('line', { class: 'guide dark warn', x1: sx - 12, y1: sy, x2: sx + 12, y2: sy });
  add('line', { class: 'guide dark warn', x1: sx, y1: sy - 12, x2: sx, y2: sy + 12 });
  add('text', { class: 'label dark warn', x: sx + 16, y: sy + 6 }, '抓取点 128, 36');

  const ext = info?.extent;
  if (ext) {
    add('rect', {
      class: 'guide warn', x: x0 + ext[0] * S, y: y0 + ext[1] * S,
      width: Math.max(0, (ext[2] - ext[0]) * S), height: Math.max(0, (ext[3] - ext[1]) * S),
    });
    add('text', { class: 'label dark warn', x: x0 + ext[0] * S + 6, y: y0 + ext[1] * S - 8 }, '可见范围 extent');
  }

  for (const c of layout?.hit ?? []) add('circle', { class: 'hit', cx: c.x, cy: c.y, r: c.r });

  const anchors = info?.anchors ?? {};
  const dot = (name, cls, list) => {
    if (!Array.isArray(list)) return;
    add('circle', { class: `dot ${cls}`, cx: x0 + list[0] * S, cy: y0 + list[1] * S, r: 6 });
    add('text', { class: 'label dark', x: x0 + list[0] * S + 9, y: y0 + list[1] * S + 5 }, name);
  };
  dot('视线', '', anchors.gaze);
  dot('泪', 'tear', anchors.tear);
  dot('z', 'z', anchors.z);
  dot('气泡', '', anchors.bubble);
  if (Array.isArray(anchors.hearts)) {
    add('circle', { class: 'dot heart', cx: x0 + anchors.hearts[0] * S, cy: y0 + anchors.hearts[1] * S, r: 10 });
    add('text', { class: 'label dark', x: x0 + anchors.hearts[0] * S + 14, y: y0 + anchors.hearts[1] * S + 5 }, '心');
  }

  add('text', { class: 'label dark', x: x0 + 8, y: y0 + 256 * S + 26 }, `S = ${S.toFixed(2)} · 视图 ${(state.viewScale * 100).toFixed(0)}%`);
}

function draw() {
  overlay.replaceChildren();
  const b = state.bounds;
  const layout = state.layout;
  state.info = globalThis.__l2dInfo ?? state.info;
  if (state.layer === 'desktop') drawDesktop(b, layout);
  else drawBody(b, layout, state.info);

  const S = b.S;
  hud.textContent = state.layer === 'desktop'
    ? `桌面层 · ${b.W}×${b.H} · S=${S.toFixed(3)} · 地板 ${Math.round(b.floorY)} · 视图 ${(state.viewScale * 100).toFixed(0)}%`
    : `身体层 · 256 box · S=${S.toFixed(2)} · 视图 ${(state.viewScale * 100).toFixed(0)}%`;
}

/* ---------------- 读数回传 ---------------- */

function sendInfo() {
  const b = state.bounds;
  const info = globalThis.__l2dInfo ?? state.info;
  const layout = state.layout;
  const ext = info?.extent ?? null;
  const dS = .42 * state.env.scale;
  if (state.layer === 'desktop' && layout) state.xShare = clamp(layout.x / b.W, 0, 1);
  const bodyCx = info?.hits?.[1]?.[0] ?? (ext ? (ext[0] + ext[2]) / 2 : null);
  const hit = ext ? headHit(ext, info?.hits) : null;
  const metrics = ext ? {
    grab: +(((ext[1] - 36) * dS).toFixed(1)),
    feet: +(((256 - ext[3]) * dS).toFixed(1)),
    center: +(((bodyCx ?? (ext[0] + ext[2]) / 2) - 128) * dS).toFixed(1),
    height: +(((ext[3] - ext[1]) * dS).toFixed(1)),
    head: hit,
  } : null;
  send({
    t: 'info',
    layer: state.layer,
    view: state.viewScale,
    mode100: state.mode100,
    bounds: { ...b },
    s: b.S,
    desktopS: dS,
    motion: state.motion,
    floorY: b.floorY,
    ext,
    measured: info?.measured ?? null,
    fit: info?.fit ?? state.fit,
    hits: info?.hits ?? null,
    anchors: info?.anchors ?? null,
    layout: layout && {
      x: layout.x, facing: layout.facing, mode: layout.mode, cursor: layout.cursor,
      pressing: layout.pressing, box: layout.box, hit: layout.hit,
    },
    metrics,
    words: state.words,
    env: { ...state.env },
  });
}

/* ---------------- 指针 ---------------- */

function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / state.viewScale,
    y: (e.clientY - r.top) / state.viewScale,
  };
}

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.body) return;
  if (state.layer === 'body') {
    state.fitDrag = {
      x: e.clientX, y: e.clientY,
      offset: [...(state.fit?.offset ?? [0, 0])],
    };
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
    return;
  }
  const p = stagePoint(e);
  state.body.pointer('down', { ...p, t: performance.now() });
  const hit = !!state.body.hit?.(p);
  state.pressing = hit;
  state.dragStart = hit ? p : null;
  state.lastP = p;
  state.drop = null;
  if (hit) { try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ } e.preventDefault(); }
});

stage.addEventListener('pointermove', (e) => {
  if (!state.body) return;
  if (state.layer === 'body') {
    if (!state.fitDrag) return;
    const r = stage.getBoundingClientRect();
    const dx = 2 * (e.clientX - state.fitDrag.x) / Math.max(1, r.width);
    const dy = -2 * (e.clientY - state.fitDrag.y) / Math.max(1, r.height);
    const fit = { ...(state.fit ?? {}), offset: [clamp(state.fitDrag.offset[0] + dx, -1, 1), clamp(state.fitDrag.offset[1] + dy, -1, 1)], autoFit: false };
    state.fit = fit;
    globalThis.__l2dFit?.set?.({ offset: fit.offset, autoFit: false });
    state.autoFit = false;
    state.remeasureAt = performance.now() + 120;
    send({ t: 'fitState', fit });
    e.preventDefault();
    return;
  }
  const p = stagePoint(e);
  state.body.pointer('move', { ...p, t: performance.now() });
  state.lastP = p;
  const cur = state.layout?.cursor || '';
  stage.style.cursor = cur === 'grab' ? 'grab' : cur === 'grabbing' ? 'grabbing' : 'default';
});

const endPointer = (e) => {
  if (!state.body) return;
  if (state.layer === 'body') { state.fitDrag = null; return; }
  const p = e ? stagePoint(e) : (state.lastP ?? { x: 0, y: 0 });
  state.body.pointer('up', { ...p, t: performance.now() });
  state.drop = state.pressing ? p : state.drop;
  state.pressing = false;
  state.dragStart = null;
  stage.style.cursor = 'default';
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
window.addEventListener('pointerleave', () => { if (state.layer === 'desktop') state.body?.pointer('leave', {}); });
stage.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- 帧循环 ---------------- */

function tick(now) {
  try {
    const dt = clamp((now - (state.last || now)) / 1000, .001, .05);
    state.last = now;
    if (state.body) {
      state.body.step(dt);
      state.layout = state.body.layout?.() ?? state.layout;
      if (state.layer === 'desktop' && state.layout) state.xShare = clamp(state.layout.x / state.bounds.W, 0, 1);
    }
    if (state.remeasureAt && now >= state.remeasureAt) {
      state.remeasureAt = 0;
      try { state.body.step(.001); globalThis.__l2dRemesure?.(); } catch { /* ignore */ }
    }
    draw();
    if (now - state.lastInfo > 180) { state.lastInfo = now; sendInfo(); }
  } catch (e) {
    logError((e && e.stack) || e?.message || e);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  tick(now);
}

// 浏览器窗口被遮挡时 rAF 会被完全暂停；给预览一个低频兜底，至少不会“卡死在第一帧”。
setInterval(() => {
  if (performance.now() - (state.last || 0) > 250) tick(performance.now());
}, 120);

/* ---------------- 消息 ---------------- */

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'env') {
    Object.assign(state.env, m.env || {});
    state.env.below = Math.max(0, state.env.h - state.env.availH);
    const first = !state.envApplied;
    state.envApplied = true;
    if (state.layer === 'desktop') applyLayer('desktop', first ? { petX: state.env.petX, init: true } : {});
    else applyLayer('body');
  } else if (m.t === 'layer') {
    if (m.layer === 'desktop' || m.layer === 'body') applyLayer(m.layer);
  } else if (m.t === 'fit') {
    state.fit = { ...(state.fit ?? {}), ...(m.fit || {}) };
    globalThis.__l2dFit?.set?.(m.fit || {});
    // autoFit 时不要用普通 remeasure 抢在自动贴合前面把 extent 定死
    if (m.fit?.autoFit !== true) state.remeasureAt = performance.now() + 120;
  } else if (m.t === 'autofit') {
    let tries = 0;
    const run = () => {
      const r = globalThis.__l2dAutoFit?.();
      if (!r) return false;
      state.fit = globalThis.__l2dFit?.get?.() ?? state.fit;
      state.autoFit = true;
      state.remeasureAt = performance.now() + 120;
      sendInfo();
      return true;
    };
    // 刚 ready 时贴图可能还没就绪，__l2dAutoFit 会返回 null；重试到模型可测为止
    if (!run()) {
      const timer = setInterval(() => {
        tries += 1;
        if (run() || tries > 20) clearInterval(timer);
      }, 250);
    }
  } else if (m.t === 'word') {
    state.body?.do?.(m.word);
  } else if (m.t === 'reset') {
    state.xShare = .7;
    if (state.layer === 'desktop') applyLayer('desktop', { petX: .7 });
    else { state.body?.place?.(state.bounds.W / 2, 1); }
  } else if (m.t === 'view') {
    state.mode100 = m.mode === '100';
    resizeView();
  } else if (m.t === 'motion') {
    const v = m.value === 'off' || m.value === 'free' ? m.value : 'calm';
    state.motion = v;
    globalThis.__l2dMotionSpeed?.(m.speed);
    state.body?.set?.({ roam: v });
  } else if (m.t === 'cover') {
    let r = null;
    try { r = globalThis.__l2dCover?.(); }
    catch (e) { logError((e && e.stack) || e?.message || e); }
    if (r && r.png) send({ t: 'cover', ok: true, id: m.id, png: r.png, png128: r.png128 });
    else send({ t: 'cover', ok: false, id: m.id, error: '封面接口不可用' });
  } else if (m.t === 'reload') {
    location.reload();
  }
});

/* ---------------- 启动 ---------------- */

(async () => {
  try {
    const kit = await import('/kit/body.js');
    const mod = await import('/pack/figure.js');
    state.body = await mod.createFigureBody(new URL('/pack/', location.origin), {
      kit, host, loadImage, scheme: '', model: undefined,
    });
    state.body.set?.({ roam: 'free' });
    state.motion = 'free';
    state.words = state.body.words ?? [];
    state.info = globalThis.__l2dInfo ?? null;
    state.fit = globalThis.__l2dFit?.get?.() ?? state.info?.fit ?? null;
    applyLayer(state.layer === 'body' ? 'body' : 'desktop');
    boot.hidden = true;
    send({ t: 'ready', words: state.words, info: state.info });
    requestAnimationFrame(frame);
  } catch (e) {
    boot.classList.add('bad');
    boot.textContent = '加载失败：' + (e?.message ?? e);
    log('error', (e && e.stack) || e);
  }
})();

new ResizeObserver(() => resizeView()).observe(viewport);
window.__preview = {
  state,
  get info() { return globalThis.__l2dInfo ?? null; },
  get layout() { return state.layout; },
  applyLayer,
  body: () => state.body,
};
