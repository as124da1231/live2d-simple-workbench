const $ = (s) => document.querySelector(s);
const preview = $('#preview');
const empty = $('#empty');
const logEl = $('#log');

const LABELS = {
  neutral: '平静', happy: '开心', wink: '眨眼', love: '喜欢', shy: '害羞',
  surprised: '惊讶', angry: '生气', sad: '难过', sleepy: '困倦', thinking: '思考',
  smug: '得意', pout: '嘟嘴', worried: '担心', determined: '坚定',
  flustered: '慌张', scared: '害怕', excited: '兴奋', cry: '哭', confused: '困惑',
};

const state = {
  env: { w: 1920, h: 1080, availH: 1040, below: 40, scale: 1.7, petX: null, rememberPosition: false },
  plan: null,
  checks: null,
  built: null,
  words: [],
  fit: { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1 },
  autoFit: true,
  planDir: '',
  layer: 'body',
  activeWord: 'neutral',
  previewReady: false,
  autoFitSent: false,
  dirtyBuild: false,
  identity: null,
  motionKind: 'roam',
  motionPreview: 'free',
  motionSpeed: 1,
  bodyGain: 1.8,
  motionStyle: 'natural',
  coo: { connected: false, saved: false, dir: null, figures: null, config: null },
  coverPending: false,
  awaitCover: false,
  coverUrl: '',
  coverTimer: 0,
  lastInfo: null,
};

/* ---------------- 基础 ---------------- */

async function api(path, body) {
  const res = await fetch(path, body == null ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setStatus(text, level = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status' + (level ? ' ' + level : '');
}

/** 构建参数（取景 / 名片 / 运动）改过但还没重新构建。 */
function setDirtyBuild(dirty, reason = '有改动 · 重新构建后安装') {
  state.dirtyBuild = !!dirty;
  syncInstall();
  if (state.dirtyBuild) setStatus(reason, 'warn');
}

function syncInstall() {
  const connected = !!state.coo?.connected;
  const disabled = !state.built || state.dirtyBuild || state.coverPending || !connected;
  $('#install').disabled = disabled;
  $('#install').title = !connected
    ? '未连接 Coo：只能构建 / 预览，不能安装。点右上角 Coo 选择目录。'
    : state.dirtyBuild
      ? '有改动，先重新构建'
      : state.coverPending
        ? '封面生成中…'
        : '复制到 Coo 的 figures/';
}

function log(text, level = '') {
  const line = document.createElement('div');
  if (level) line.className = level;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${t}] ${text}`;
  logEl.appendChild(line);
  while (logEl.children.length > 240) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function post(msg) {
  try { preview.contentWindow?.postMessage(msg, '*'); } catch { /* ignore */ }
}

/* ---------------- 预览消息 ---------------- */

function envPayload() {
  const s = window.screen;
  const w = Math.max(480, s?.width || state.env.w);
  const h = Math.max(360, s?.height || state.env.h);
  const availH = Math.max(240, s?.availHeight || state.env.availH);
  return {
    w, h, availH,
    below: Math.max(0, h - availH),
    scale: state.env.scale,
    petX: state.env.petX,
    rememberPosition: !!state.env.rememberPosition,
  };
}

function fitPayload() {
  return {
    mode: state.fit.mode ?? 'contain',
    anchor: state.fit.anchor ?? 'bottom',
    padding: state.fit.padding ?? [0.04, 0.02],
    zoom: Number(state.fit.zoom) || 1,
    offset: state.fit.offset ?? [0, 0],
    autoFit: !!state.autoFit,
  };
}

function styleOf(v) {
  return ['natural', 'lively', 'calm', 'shy'].includes(v) ? v : 'natural';
}

function defaultIdentity(plan) {
  const name = plan?.identity?.nameZh || plan?.title || plan?.id || '';
  const count = plan?.expressions?.length ?? 0;
  return {
    nameZh: plan?.identity?.nameZh ?? name,
    nameEn: plan?.identity?.nameEn ?? name,
    aboutZh: plan?.identity?.aboutZh ?? `一个正面立绘的 Live2D 形象，支持 ${count} 种底脸表情。`,
    aboutEn: plan?.identity?.aboutEn ?? `A front-facing Live2D figure with ${count} base expressions.`,
    author: plan?.identity?.author ?? '',
    version: plan?.identity?.version ?? '1.0.0',
    credit: plan?.identity?.credit ?? '',
  };
}

function previewMotion() {
  return state.motionKind === 'stand' ? 'off' : (state.motionPreview || 'free');
}

function sendInit() {
  if (!state.previewReady) return;
  post({ t: 'env', env: envPayload() });
  // 不在 init 时覆盖包的 fit：先让 profile.fit（手动/auto）生效，
  // 等第一条 info 回来后再按它决定要不要补一次 auto-fit。
  post({ t: 'layer', layer: state.layer });
  post({ t: 'motion', value: previewMotion(), speed: state.motionSpeed });
  post({ t: 'word', word: state.activeWord });
}

function reloadPreview() {
  state.previewReady = false;
  state.autoFitSent = false;
  preview.src = '/preview.html?v=' + Date.now();
  empty.hidden = !!state.built;
}

window.addEventListener('message', (e) => {
  if (e.source !== preview.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;

  if (m.t === 'ready') {
    state.previewReady = true;
    syncCoverButton();
    sendInit();
    log('预览就绪 · ' + (state.words.length || m.words?.length || 0) + ' 表情', 'ok');
    if (state.awaitCover) requestCover({ wait: true });
    else requestCover();
  } else if (m.t === 'info') {
    state.lastInfo = m;
    if (m.fit) {
      state.fit = { ...state.fit, ...m.fit };
      state.autoFit = m.fit.autoFit !== false;
      syncFitInputs();
      if (state.autoFit && !state.autoFitSent) {
        state.autoFitSent = true;
        post({ t: 'autofit', on: true });
      }
    }
    renderMetrics(m);
  } else if (m.t === 'fitState') {
    state.fit = { ...state.fit, ...(m.fit || {}) };
    state.autoFit = state.fit.autoFit !== false;
    syncFitInputs();
    // 这一条只由“在身体层里拖动模型”发出，算用户改了取景
    setDirtyBuild(true, '取景有改动 · 重新构建后安装');
  } else if (m.t === 'cover') {
    onCover(m);
  } else if (m.t === 'view') {
    $('#viewLabel').textContent = `视图 ${Math.round((m.view ?? 1) * 100)}%`;
  } else if (m.t === 'layer') {
    setLayerUI(m.layer);
  } else if (m.t === 'log') {
    log(m.text || '', m.level === 'error' ? 'bad' : m.level || '');
  } else if (m.t === 'event') {
    const d = m.detail && Object.keys(m.detail).length ? ' ' + JSON.stringify(m.detail) : '';
    log(`event ${m.kind}${d}`);
  }
});

/* ---------------- 渲染 ---------------- */

function renderModelHead() {
  const plan = state.plan;
  const name = plan?.identity?.nameZh || plan?.title || plan?.id || '—';
  $('#modelName').textContent = name;
  $('#modelMeta').textContent = plan
    ? `${plan.identity?.nameZh && plan.identity.nameZh !== plan.id ? plan.id + ' · ' : ''}${plan.params} 参数 · ${plan.roles?.length ?? 0} role`
    : '';
  $('#modelMeta').title = plan
    ? `${plan.textures?.length ?? 0} 贴图 · source ${plan.sourceHash ?? ''}`
    : '';
}

function renderPlan(plan, checks, built) {
  state.plan = plan || null;
  state.checks = checks || null;
  state.built = built || null;
  state.words = built?.words ?? [];
  state.dirtyBuild = false;
  state.coverPending = false;
  state.awaitCover = false;
  state.coverUrl = '';
  clearTimeout(state.coverTimer);
  setCoverPreview('');
  setCoverState('构建后自动生成');
  state.identity = defaultIdentity(plan);
  state.motionKind = plan?.motion?.kind === 'stand' ? 'stand' : 'roam';
  state.motionPreview = state.motionKind === 'stand' ? 'off' : 'free';
  const ms = Number(plan?.motion?.speed);
  state.motionSpeed = Number.isFinite(ms) ? Math.min(2, Math.max(.5, ms)) : 1;
  const tune = plan?.overrides?.performance?.tuning ?? {};
  state.bodyGain = Number.isFinite(tune.bodyGain) ? tune.bodyGain : 1.8;
  state.motionStyle = styleOf(tune.style);

  renderModelHead();
  renderRoles(plan);
  renderWords(plan);
  renderChecks(checks);
  if (plan?.fit) {
    state.fit = { ...state.fit, ...plan.fit };
    state.autoFit = plan.fit.autoFit !== false;
    syncFitInputs();
  }
  const missing = ['eyeSmile', 'browY', 'eyeBallX', 'eyeBallY', 'mouthForm', 'cheek']
    .filter((r) => !plan?.roleTable?.[r]);
  $('#coverageNote').textContent = !plan ? '' : (missing.length ? `缺 ${missing.join(' / ')} → 表情会偏平` : '底脸通道齐全');
  syncMotionUI();
  if (!$('#identityModal').hidden) syncIdentityInputs();
  syncInstall();
  empty.hidden = !!built;
  setStatus(plan ? (built ? `已构建 · ${built.id}` : `扫描完成 · ${plan.roles?.length ?? 0} role`) : '等待模型', plan ? (built ? 'ok' : '') : '');
}

function renderRoles(plan) {
  const box = $('#roles');
  box.replaceChildren();
  if (!plan) return;
  const table = plan.roleTable || {};
  for (const name of Object.keys(table)) {
    const r = table[name];
    const chip = document.createElement('span');
    chip.className = 'chip on';
    chip.textContent = name;
    chip.title = (r.targets || []).join(', ');
    box.appendChild(chip);
  }
  for (const name of plan.unmapped || []) {
    const chip = document.createElement('span');
    chip.className = 'chip off';
    chip.textContent = name;
    chip.title = '模型没有对应参数';
    box.appendChild(chip);
  }
}

function selectWord(id, button) {
  state.activeWord = id;
  for (const el of $('#words').querySelectorAll('.word')) el.classList.toggle('on', el === button);
  const neutral = $('#neutralWord');
  if (neutral) neutral.classList.toggle('on', id === 'neutral');
  post({ t: 'word', word: id });
  log(`表情 → ${LABELS[id] || id}`);
}

function renderWords(plan) {
  const box = $('#words');
  box.replaceChildren();
  if (!plan) return;
  const names = Object.keys(plan.recipes || {});
  if (state.activeWord !== 'neutral' && !names.includes(state.activeWord)) state.activeWord = 'neutral';
  if (!names.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = '这个模型没有可用的表情 role。';
    box.appendChild(p);
    return;
  }
  for (const id of names) {
    const b = document.createElement('button');
    b.className = 'word' + (id === state.activeWord ? ' on' : '');
    b.textContent = LABELS[id] || id;
    b.title = id;
    b.addEventListener('click', () => selectWord(id, b));
    box.appendChild(b);
  }
  const neutral = $('#neutralWord');
  if (neutral) neutral.classList.toggle('on', state.activeWord === 'neutral');
}

function renderChecks(checks) {
  const box = $('#checks');
  const badge = $('#checkBadge');
  box.replaceChildren();
  if (!checks) { badge.textContent = '—'; badge.className = 'badge'; return; }
  const level = checks.level || 'ok';
  badge.textContent = level === 'block' ? '阻断' : level === 'warn' ? '提醒' : '通过';
  badge.className = 'badge ' + (level === 'block' ? 'bad' : level === 'warn' ? 'warn' : 'ok');
  const order = { block: 0, warn: 1, ok: 2, info: 3 };
  const items = [...(checks.items || [])].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'checkItem ' + (it.level || 'info');
    const dot = document.createElement('i');
    const text = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = it.label || it.id || '';
    text.appendChild(b);
    if (it.detail) {
      const em = document.createElement('em');
      em.textContent = ' · ' + it.detail;
      text.appendChild(em);
    }
    row.append(dot, text);
    box.appendChild(row);
  }
}

function renderMetrics(m) {
  const mt = m.metrics;
  const dS = m.desktopS ?? .714;
  const set = (id, text, cls = '') => {
    const el = $(id);
    el.textContent = text;
    el.className = cls;
  };
  if (!mt) {
    set('#mGrab', '—'); set('#mFeet', '—'); set('#mCenter', '—'); set('#mHead', '—');
  } else {
    const sign = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + ' px';
    set('#mGrab', sign(mt.grab), Math.abs(mt.grab) <= 10 ? 'ok' : Math.abs(mt.grab) <= 24 ? 'warn' : 'bad');
    set('#mFeet', sign(mt.feet), Math.abs(mt.feet) <= 2 ? 'ok' : Math.abs(mt.feet) <= 8 ? 'warn' : 'bad');
    set('#mCenter', sign(mt.center), Math.abs(mt.center) <= 6 ? 'ok' : Math.abs(mt.center) <= 20 ? 'warn' : 'bad');
    set('#mHead', mt.head ? '是' : '否', mt.head ? 'ok' : 'bad');
  }
  const b = m.bounds || {};
  const l = m.layout || {};
  const ext = m.ext ? `[${m.ext.join(', ')}]` : '—';
  const clipped = m.ext && (m.ext[0] <= 1 || m.ext[1] <= 1 || m.ext[2] >= 255);
  $('#facts').textContent = [
    `S ${Number(m.s || 0).toFixed(3)} · 桌面 S ${Number(dS).toFixed(3)}`,
    `地板 ${Math.round(m.floorY ?? 0)} / 高 ${b.H ?? '—'}`,
    `extent ${ext}${clipped ? '  ⚠ 贴边/可能裁切' : ''}`,
    `mode ${l.mode ?? '—'} · facing ${l.facing ?? '—'} · 运动 ${m.motion ?? '—'}`,
    `视图 ${m.mode100 ? '100%' : Math.round((m.view ?? 1) * 100) + '%'}`,
  ].join('\n');
  $('#layerLabel').textContent = m.layer === 'body' ? '身体层' : '桌面层';
}

function syncFitInputs() {
  const z = Number(state.fit.zoom ?? 1);
  const [x, y] = state.fit.offset ?? [0, 0];
  $('#fitZoom').value = String(Math.min(3.5, z));
  $('#fitX').value = String(x);
  $('#fitY').value = String(y);
  $('#fitZoomOut').textContent = z.toFixed(2);
  $('#fitXOut').textContent = x.toFixed(2);
  $('#fitYOut').textContent = y.toFixed(2);
  $('#autoFit').checked = !!state.autoFit;
  const st = $('#autoFitState');
  if (st) st.textContent = state.autoFit ? '自动' : '手动';
}

function setLayerUI(layer) {
  state.layer = layer;
  for (const b of document.querySelectorAll('#layers button')) b.classList.toggle('on', b.dataset.layer === layer);
  $('#layerLabel').textContent = layer === 'body' ? '身体层' : '桌面层';
  $('#fitbar').hidden = layer !== 'body';
}

/* ---------------- 名片 / 运动 / 封面 ---------------- */

function syncCoo() {
  const c = state.coo ?? {};
  const on = !!c.connected;
  $('#cooBtn').textContent = on ? 'Coo ✓' : 'Coo 未连接';
  $('#cooBtn').classList.toggle('on', on);
  $('#cooBtn').title = on
    ? `Coo 已连接\n${c.figures ?? ''}\n点击更换`
    : '未检测到 Coo：点击选择 Coopanion 目录';
  $('#cooState').textContent = on ? 'Coo 已连接' : 'Coo 未连接';
  $('#cooState').classList.toggle('on', on);
  let path = on
    ? `figures: ${c.figures ?? '—'}\nconfig: ${c.config ?? '（未找到 config.json，屏幕缩放用默认 1.7）'}`
    : '选择 Coopanion 安装目录，或它的 data/home/companion。只构建 / 预览时可以稍后再选。';
  if (on && !c.saved) path += '\n注意：配置未能写入 workbench.config.json（目录可能只读），下次需要重选。';
  $('#cooPath').textContent = path;
  syncInstall();
}

function syncMotionUI() {
  const sel = $('#motionMode');
  if (sel) {
    sel.value = previewMotion();
    sel.disabled = state.motionKind === 'stand';
    sel.title = state.motionKind === 'stand' ? '构建为站定，预览强制关闭' : '只影响预览；构建方式在名片里改';
  }
  for (const r of document.querySelectorAll('input[name="motionKind"]')) r.checked = r.value === state.motionKind;
}

function setCoverState(text, level = '') {
  const el = $('#coverState');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (level ? ' ' + level : '');
}

function setCoverPreview(url) {
  const img = $('#coverPreview');
  const thumb = $('#modelThumb');
  state.coverUrl = url || '';
  for (const el of [img, thumb]) {
    if (!el) continue;
    if (url) {
      el.src = url;
      el.hidden = false;
    } else {
      el.removeAttribute('src');
      el.hidden = true;
    }
  }
}

function syncIdentityInputs() {
  const id = state.identity ?? defaultIdentity(state.plan);
  $('#idNameZh').value = id.nameZh ?? '';
  $('#idNameEn').value = id.nameEn ?? '';
  $('#idAboutZh').value = id.aboutZh ?? '';
  $('#idAboutEn').value = id.aboutEn ?? '';
  $('#idAuthor').value = id.author ?? '';
  $('#idVersion').value = id.version ?? '1.0.0';
  $('#idCredit').value = id.credit ?? '';
  $('#bodyGain').value = String(state.bodyGain);
  $('#bodyGainOut').textContent = Number(state.bodyGain).toFixed(2);
  $('#motionStyle').value = state.motionStyle;
  $('#idHint').textContent = '保存后需要重新构建';
  syncMotionUI();
  const url = state.coverUrl || (state.built ? '/pack/thumb/cover.png?v=' + encodeURIComponent(state.built.id) : '');
  setCoverPreview(url);
  setCoverState(url ? '已生成 · 可重拍' : '构建后自动生成');
}

function openSettings() {
  if (state.plan) state.identity = state.identity ?? defaultIdentity(state.plan);
  syncCoo();
  syncIdentityInputs();
  const on = !!state.plan;
  for (const id of ['idNameZh', 'idNameEn', 'idAboutZh', 'idAboutEn', 'idAuthor', 'idVersion', 'idCredit', 'bodyGain', 'motionStyle']) {
    $(`#${id}`).disabled = !on;
  }
  for (const r of document.querySelectorAll('input[name="motionKind"]')) r.disabled = !on;
  syncMotionUI();
  $('#identitySave').disabled = !on;
  syncCoverButton();
  $('#idHint').textContent = on ? '保存后需要重新构建' : '先选择模型目录并构建，再编辑名片';
  $('#identityModal').hidden = false;
  if (on) $('#idNameZh').focus();
}

function closeIdentity() {
  $('#identityModal').hidden = true;
}

function saveIdentity() {
  if (!state.plan) { $('#idHint').textContent = '先选择模型目录并构建，再编辑名片'; return; }
  const nameZh = $('#idNameZh').value.trim();
  const nameEn = $('#idNameEn').value.trim() || nameZh;
  const aboutZh = $('#idAboutZh').value.trim();
  const aboutEn = $('#idAboutEn').value.trim() || aboutZh;
  const author = $('#idAuthor').value.trim();
  const version = $('#idVersion').value.trim() || '1.0.0';
  const credit = $('#idCredit').value.trim();
  const motionKind = document.querySelector('input[name="motionKind"]:checked')?.value === 'stand' ? 'stand' : 'roam';
  const motionSpeed = state.motionSpeed;
  const bodyGain = Math.min(3, Math.max(.5, Number($('#bodyGain').value) || 1.8));
  const motionStyle = styleOf($('#motionStyle').value);
  if (!nameZh) { $('#idHint').textContent = '名字不能为空'; return; }
  if (nameZh.length > 40) { $('#idHint').textContent = '名字太长（最多 40 字）'; return; }
  if (!aboutZh) { $('#idHint').textContent = '一句话不能为空'; return; }
  if (aboutZh.length > 240) { $('#idHint').textContent = '一句话太长（最多 240 字）'; return; }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    $('#idHint').textContent = '版本号建议写成 1.0.0';
    return;
  }
  const before = JSON.stringify({ ...(state.identity ?? {}), motion: { kind: state.motionKind, speed: state.motionSpeed }, tune: { bodyGain: state.bodyGain, style: state.motionStyle } });
  const next = { nameZh, nameEn, aboutZh, aboutEn, author, version, credit };
  const after = JSON.stringify({ ...next, motion: { kind: motionKind, speed: motionSpeed }, tune: { bodyGain, style: motionStyle } });
  state.identity = next;
  state.motionKind = motionKind;
  state.motionSpeed = motionSpeed;
  state.bodyGain = bodyGain;
  state.motionStyle = motionStyle;
  state.motionPreview = motionKind === 'stand' ? 'off' : 'free';
  syncMotionUI();
  closeIdentity();
  if (before !== after) {
    setDirtyBuild(true, '名片 / 运动有改动 · 重新构建后安装');
    post({ t: 'motion', value: previewMotion(), speed: state.motionSpeed });
    log(`名片已保存 · ${nameZh}${motionKind === 'stand' ? ' · 站定' : ' · 灵动'}`);
  }
}

function armCoverTimeout() {
  clearTimeout(state.coverTimer);
  state.coverTimer = setTimeout(() => {
    if (!state.coverPending) return;
    state.coverPending = false;
    const wasWaiting = state.awaitCover;
    state.awaitCover = false;
    setCoverState('未生成 · 可重拍', 'warn');
    if (wasWaiting) log('封面超时，仍可安装', 'warn');
    if (wasWaiting && state.built && !state.dirtyBuild) setStatus(`已构建 · ${state.built.id} · 封面未生成`, 'warn');
    syncInstall();
  }, 12000);
}

function syncCoverButton() {
  const b = $('#coverRetake');
  if (b) b.disabled = !state.built || !state.previewReady;
}

function requestCover({ wait = false } = {}) {
  if (!state.built) { setStatus('先构建，再拍封面', 'warn'); return; }
  if (!state.previewReady) { setStatus('预览还没就绪，稍后再拍', 'warn'); return; }
  if (wait) state.awaitCover = true;
  state.coverPending = true;
  syncInstall();
  setCoverState('生成中…');
  post({ t: 'cover', id: state.built.id });
  armCoverTimeout();
}

async function onCover(m) {
  clearTimeout(state.coverTimer);
  state.coverPending = false;
  const waiting = state.awaitCover;
  state.awaitCover = false;
  if (!m.ok || !m.png || !state.built || (m.id && m.id !== state.built.id)) {
    setCoverState('未生成 · 可重拍', 'warn');
    if (waiting) log('封面未生成，仍可安装', 'warn');
    if (waiting && state.built && !state.dirtyBuild) setStatus(`已构建 · ${state.built.id} · 封面未生成`, 'warn');
    syncInstall();
    return;
  }
  try {
    const r = await api('/api/cover', { id: state.built.id, png: m.png, png128: m.png128 });
    setCoverPreview('/pack/' + r.thumb + '?v=' + Date.now());
    setCoverState(`已生成 · ${Math.round((r.bytes || 0) / 1024)} KB`);
    log('封面已生成', 'ok');
    if (state.built && !state.dirtyBuild) setStatus(`已构建 · ${state.built.id}`, 'ok');
  } catch (e) {
    setCoverState('保存失败 · 重拍', 'warn');
    log(e.message, 'bad');
    if (state.built && !state.dirtyBuild) setStatus(`已构建 · ${state.built.id} · 封面保存失败`, 'warn');
  } finally {
    syncInstall();
  }
}

/* ---------------- 操作 ---------------- */

async function buildAll() {
  const dir = $('#modelDir').value.trim();
  if (!dir) { setStatus('先填或选择模型目录', 'warn'); return; }
  const sameModel = !!state.plan && state.planDir === dir;
  // 同一模型上调过取景 / 名片：扫描会读回旧的 overrides，所以先把当前值留住。
  const keepFit = sameModel && state.dirtyBuild ? fitPayload() : null;
  const keepIdentity = sameModel && state.dirtyBuild ? { ...state.identity } : null;
  const keepMotion = sameModel && state.dirtyBuild ? { kind: state.motionKind, speed: state.motionSpeed } : null;
  const keepTune = sameModel && state.dirtyBuild ? { bodyGain: state.bodyGain, style: state.motionStyle } : null;
  clearTimeout(state.coverTimer);
  state.awaitCover = false;
  state.coverPending = false;
  $('#build').disabled = true;
  $('#install').disabled = true;
  try {
    // 每次构建都重新扫描：模型文件可能被替换，不能拿内存里的旧 plan 直接用。
    setStatus('扫描中…');
    const s = await api('/api/scan', { dir });
    state.planDir = dir;
    renderPlan(s.plan, s.checks, s.built);
    if (!state.plan) return;
    log(`扫描完成 · ${s.plan.params} 参数 / ${s.plan.roles?.length ?? 0} role`);
    if (keepFit) {
      state.fit = { ...state.fit, ...keepFit };
      state.autoFit = keepFit.autoFit !== false;
      syncFitInputs();
    }
    if (keepIdentity) state.identity = keepIdentity;
    if (keepTune) {
      state.bodyGain = keepTune.bodyGain;
      state.motionStyle = keepTune.style;
    }
    if (keepMotion) {
      state.motionKind = keepMotion.kind === 'stand' ? 'stand' : 'roam';
      state.motionSpeed = Math.min(2, Math.max(.5, Number(keepMotion.speed) || 1));
    }
    syncMotionUI();
    if (!$('#identityModal').hidden) syncIdentityInputs();

    setStatus('构建中…');
    const id = state.plan.id;
    const r = await api('/api/build', {
      id,
      overrides: {
        fit: fitPayload(),
        motion: { kind: state.motionKind, speed: state.motionSpeed },
        identity: state.identity,
        performance: { tuning: { bodyGain: state.bodyGain, style: state.motionStyle } },
      },
    });
    state.built = { id: r.id, at: Date.now() };
    state.words = r.words || [];
    syncCoverButton();
    state.plan.identity = { ...(state.plan.identity ?? {}), ...(state.identity ?? {}) };
    state.plan.motion = { ...(state.plan.motion ?? {}), kind: state.motionKind, speed: state.motionSpeed };
    state.plan.fit = { ...(state.plan.fit ?? {}), ...fitPayload() };
    renderModelHead();
    state.dirtyBuild = false;
    state.coverUrl = '';
    state.motionPreview = state.motionKind === 'stand' ? 'off' : 'free';
    state.awaitCover = true;
    state.coverPending = true;
    armCoverTimeout();
    syncMotionUI();
    syncInstall();
    empty.hidden = true;
    renderChecks(r.checks || state.checks);
    setStatus(`已构建 · ${r.id} · 生成封面…`, 'ok');
    log(`构建完成 · ${r.id} · ${state.words.length} 词`, 'ok');
    reloadPreview();
  } catch (e) {
    setStatus('构建失败', 'bad');
    log(e.message, 'bad');
  } finally {
    $('#build').disabled = false;
    syncInstall();
  }
}

async function install() {
  if (!state.built) return;
  if (!state.coo?.connected) {
    setStatus('未连接 Coo：先选择 Coopanion 目录', 'warn');
    return;
  }
  $('#install').disabled = true;
  try {
    const r = await api('/api/install', { id: state.built.id, confirm: true });
    log(`已安装 → ${r.target}${r.backup ? '（备份 ' + r.backup + '）' : ''}`, 'ok');
    setStatus(`已安装 · ${state.built.id}`, 'ok');
  } catch (e) {
    log(e.message, 'bad');
    setStatus('安装失败', 'bad');
  } finally {
    syncInstall();
  }
}

/* ---------------- 事件 ---------------- */

async function pickDir() {
  setStatus('选择目录…');
  try {
    const r = await api('/api/pick-dir', {});
    if (r.dir) { $('#modelDir').value = r.dir; setStatus('已选择目录'); }
    else setStatus('未选择目录');
  } catch (e) {
    setStatus('选择失败', 'bad');
    log(e.message, 'bad');
  }
}

async function pickCoo() {
  setStatus('选择 Coo 目录…');
  try {
    const r = await api('/api/pick-coo', {});
    if (r.cancelled) { setStatus(state.coo?.connected ? 'Coo 已连接' : '未选择 Coo 目录'); return; }
    state.coo = r.coo ?? state.coo;
    syncCoo();
    if (state.coo?.connected) {
      log(`Coo 已连接 → ${state.coo.figures}${r.saved ? ' · 已记住' : ' · 配置未保存'}`, r.saved ? 'ok' : 'warn');
      setStatus(state.built ? `已构建 · ${state.built.id} · Coo 已连接` : `Coo 已连接 · ${state.coo.figures}`, 'ok');
    }
  } catch (e) {
    setStatus('Coo 目录无效', 'bad');
    log(e.message, 'bad');
  }
}

$('#pickDir').addEventListener('click', pickDir);
$('#pickCoo').addEventListener('click', pickCoo);
$('#cooBtn').addEventListener('click', openSettings);
$('#neutralWord').addEventListener('click', () => selectWord('neutral', null));
$('#identityBtn').addEventListener('click', openSettings);
$('#identityClose').addEventListener('click', closeIdentity);
$('#identityCancel').addEventListener('click', closeIdentity);
$('#identitySave').addEventListener('click', saveIdentity);
$('#coverRetake').addEventListener('click', () => requestCover({ wait: false }));
$('#identityModal').addEventListener('click', (e) => {
  if (e.target === $('#identityModal')) closeIdentity();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#identityModal').hidden) closeIdentity();
});
$('#modelDir').addEventListener('keydown', (e) => { if (e.key === 'Enter') buildAll(); });
$('#build').addEventListener('click', buildAll);
$('#install').addEventListener('click', install);
$('#fitReset').addEventListener('click', () => {
  state.autoFit = true;
  state.fit = { ...state.fit, zoom: 1, offset: [0, 0], autoFit: true };
  syncFitInputs();
  setDirtyBuild(true, '取景有改动 · 重新构建后安装');
  // 先让渲染内核把 autoFit 置回 true，再自动贴合；
  // 否则 __l2dFit 里仍是 false，info 回来会把开关打回“手动”。
  post({ t: 'fit', fit: { autoFit: true } });
  post({ t: 'autofit', on: true });
});
$('#autoFit').addEventListener('change', () => {
  state.autoFit = $('#autoFit').checked;
  state.fit.autoFit = state.autoFit;
  syncFitInputs();
  setDirtyBuild(true, '取景有改动 · 重新构建后安装');
  post({ t: 'fit', fit: { autoFit: state.autoFit } });
  if (state.autoFit) post({ t: 'autofit', on: true });
});
$('#motionMode').addEventListener('change', () => {
  if (state.motionKind === 'stand') { syncMotionUI(); return; }
  state.motionPreview = $('#motionMode').value;
  post({ t: 'motion', value: state.motionPreview, speed: state.motionSpeed });
  log(`预览运动 → ${state.motionPreview === 'off' ? '站定' : state.motionPreview === 'free' ? '自由走动' : '安静走动'}`);
});
$('#bodyGain').addEventListener('input', () => {
  $('#bodyGainOut').textContent = Number($('#bodyGain').value).toFixed(2);
});
$('#fitView').addEventListener('click', () => post({ t: 'view', mode: 'fit' }));
$('#view100').addEventListener('click', () => post({ t: 'view', mode: '100' }));
$('#resetPos').addEventListener('click', () => { post({ t: 'reset' }); log('位置回到 0.7W'); });
$('#clearLog').addEventListener('click', () => logEl.replaceChildren());

for (const b of document.querySelectorAll('#layers button')) {
  b.addEventListener('click', () => {
    setLayerUI(b.dataset.layer);
    post({ t: 'layer', layer: b.dataset.layer });
  });
}

for (const id of ['fitZoom', 'fitX', 'fitY']) {
  $(`#${id}`).addEventListener('input', () => {
    const z = Number($('#fitZoom').value);
    const x = Number($('#fitX').value);
    const y = Number($('#fitY').value);
    state.autoFit = false;
    state.fit = { ...state.fit, zoom: z, offset: [x, y], autoFit: false };
    $('#autoFit').checked = false;
    $('#fitZoomOut').textContent = z.toFixed(2);
    $('#fitXOut').textContent = x.toFixed(2);
    $('#fitYOut').textContent = y.toFixed(2);
    syncFitInputs();
    setDirtyBuild(true, '取景有改动 · 重新构建后安装');
    post({ t: 'fit', fit: { zoom: z, offset: [x, y], autoFit: false } });
  });
}

$('#preview').addEventListener('load', () => {
  state.previewReady = false;
  state.autoFitSent = false;
});
$('#coverPreview').addEventListener('error', () => {
  setCoverPreview('');
  setCoverState('还没有封面 · 构建后自动生成');
});
$('#modelThumb').addEventListener('error', () => {
  const thumb = $('#modelThumb');
  thumb.removeAttribute('src');
  thumb.hidden = true;
});

/* ---------------- 启动 ---------------- */

const LICENSE_KEY = 'l2d.licenseAck.v1';function syncLicenseBar() {
  const bar = $('#licenseBar');
  if (!bar) return;
  let acked = false;
  try { acked = localStorage.getItem(LICENSE_KEY) === '1'; } catch { /* ignore */ }
  if (acked) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#licenseOk')?.addEventListener('click', () => {
    try { localStorage.setItem(LICENSE_KEY, '1'); } catch { /* ignore */ }
    bar.hidden = true;
    log('已确认 Live2D 运行时许可');
  }, { once: true });
}

(async () => {
  syncLicenseBar();
  try {
    const env = await api('/api/env');
    state.env = { ...state.env, ...env };
    state.coo = env.coo ?? state.coo;
    syncCoo();
    const st = await api('/api/state');
    if (st.plan) {
      renderPlan(st.plan, st.checks, st.built);
      state.planDir = st.modelDir || '';
      if (st.modelDir) $('#modelDir').value = st.modelDir;
      if (st.built) reloadPreview();
    }
    setLayerUI(state.layer);
    syncMotionUI();
    if (!st.plan) setStatus('等待模型');
    if (!state.coo?.connected) {
      log('未检测到 Coo：构建 / 预览可用，安装已禁用', 'warn');
      if (!st.plan) setStatus('未连接 Coo · 可构建预览', 'warn');
      if (!state.coo?.saved) openSettings();
    } else {
      log(`Coo 已连接 · ${state.coo.figures}`, 'ok');
    }
    log(`简易模式 · 端口 ${location.port} · kit ${env.kit ? '本地 vendor' : '—'}`);
  } catch (e) {
    setStatus('启动失败', 'bad');
    log(e.message, 'bad');
  }
})();
