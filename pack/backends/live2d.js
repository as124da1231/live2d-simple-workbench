/**
 * Live2D 渲染后端（Cubism SDK for Web）+ kit 身体。
 *
 * 分工：
 *   - 数据：models/<id>/profile.js —— role 表、表情配方、取景、部件基线（不含逻辑）
 *   - 本文件：数据 → Cubism 参数 → 绘制。**不认识任何具体 Param 名**
 *   - kit：运动学（位移、翻转、挤压、跌落、粒子、表情状态机）
 *
 * 帧顺序（照官方 LAppModel，顺序错了会出两个已知 bug）：
 *   loadParameters → 写 role（base→表情→程序动画）→ 动作 → 部件不透明度
 *   → saveParameters → physics → update → draw
 *   ↑ save 必须在 physics 之前：physics 是「读参数→算输出」，输出被存进基准
 *     下一帧又当输入，会自激（头发/胸口越抖越大）。
 *
 * 沙箱适配：
 *   1. moc3 / model3 / physics / motion / profile 全是 JS 模块（不能 fetch）
 *   2. 着色器内联，覆盖 CubismShader_WebGL.loadShader
 *   3. 贴图走 loadImage（响应带 ACAO: null）
 *   4. canvas 经 foreignObject 放进 kit 的 SVG 组，跟随整组变换
 */
import {
  CubismFramework,
  CubismMatrix44,
  CubismModelSettingJson,
  CubismShaderManager_WebGL,
  CubismUserModel,
} from '../sdk/framework.js';
import { SHADERS } from '../sdk/shaders.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** 角色在 256 logo 方格里的画布。 */
const BOX = 256;
const CANVAS_PX = 512;
/** 简易模式：只走 role + 通用配方 + SoulLink，不播任何原生 exp3 / motion / Idle。 */
const SIMPLE = true;

let booted = false;
function boot() {
  if (booted) return;
  if (!CubismFramework.isStarted()) CubismFramework.startUp();
  if (!CubismFramework.isInitialized()) CubismFramework.initialize();
  booted = true;
}

const b64ToBuffer = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 没写 anchors 时，按可见范围推一组锚点（单位：256 logo 方格）。
 * 头在框顶、气泡在头顶、泪在脸上部、z 在右上、心在左下——不同模型头身比例不同，
 * 所以这是兜底，不是标准答案；工作台里可以逐个改。
 */
function deriveAnchors([x0, y0, x1, y1]) {
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  return {
    gaze: [cx, y0 + h * 0.2],
    tear: [cx + w * 0.16, y0 + h * 0.24],
    tears: [[cx - w * 0.12, y0 + h * 0.26], [cx + w * 0.16, y0 + h * 0.24]],
    z: [x1 - w * 0.1, y0 + h * 0.06],
    hearts: [cx - w * 0.28, y1 - h * 0.34, Math.min(w, h) * 0.36],
    bubble: [cx, y0 - 4],
  };
}

export async function createLive2DBody(base, opts, entry, kit) {
  const { host } = opts;
  const doc = host.root.ownerDocument;
  boot();

  // ---------- 数据 ----------
  let profile;
  try {
    profile = (await import(new URL(`models/${entry.id}/profile.js`, base))).default;
  } catch {
    throw new Error(`模型 ${entry.id} 缺 profile.js（role 表 / 表情配方 / 取景）`);
  }

  // ---------- 画布（放 kit 的 SVG 组里） ----------
  const canvas = doc.createElementNS(XHTML, 'canvas');
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';

  const fo = doc.createElementNS(SVGNS, 'foreignObject');
  fo.setAttribute('x', '0');
  fo.setAttribute('y', '0');
  fo.setAttribute('width', String(BOX));
  fo.setAttribute('height', String(BOX));
  fo.appendChild(canvas);

  const gl = canvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: true, antialias: true,
  });
  if (!gl) throw new Error('这个环境无法启用 WebGL');

  // ---------- 模型 ----------
  const mocMod = await import(new URL(`models/${entry.id}/${entry.moc}`, base));
  const mocBuf = b64ToBuffer(mocMod.default);

  const m3 = (await import(new URL(`models/${entry.id}/${entry.model}`, base))).default;
  const m3Bytes = new TextEncoder().encode(JSON.stringify(m3));
  const setting = new CubismModelSettingJson(m3Bytes.buffer, m3Bytes.length);

  const model = new (class extends CubismUserModel {})();
  model.loadModel(mocBuf, true);
  if (!model._model) throw new Error('moc3 解析失败');

  // ---------- 取景：按规则装进 clip 空间 ----------
  // 必须在 applyFit 之前初始化（applyFit 由工作台实时调用）
  let fitState = {
    mode: 'contain',
    anchor: 'bottom',
    padding: [0.04, 0.02],
    offset: [0, 0],
    zoom: 1,
    autoFit: true,
    ...(profile.fit ?? {}),
  };
  applyFit();

  if (entry.physics) {
    const phys = (await import(new URL(`models/${entry.id}/${entry.physics}`, base))).default;
    const bytes = new TextEncoder().encode(JSON.stringify(phys));
    model.loadPhysics(bytes.buffer, bytes.length);
  }
  if (entry.pose) {
    const pose = (await import(new URL(`models/${entry.id}/${entry.pose}`, base))).default;
    const bytes = new TextEncoder().encode(JSON.stringify(pose));
    model.loadPose(bytes.buffer, bytes.length);
  }

  model.createRenderer(canvas.width, canvas.height);
  const renderer = model.getRenderer();
  renderer.setClippingMaskBufferSize(512);
  renderer.startUp(gl);
  renderer.setIsPremultipliedAlpha(true);

  // 着色器内联
  const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
  if (shader) {
    shader.loadShader = (url) => Promise.resolve(SHADERS[String(url).split('/').pop()] ?? '');
  }
  const loading = renderer.loadShaders?.(new URL('shaders/', base).href);
  if (loading && typeof loading.then === 'function') await loading;

  // 贴图：后台加载，不阻塞 ready（8192² 在慢显卡上要几秒，kit 只等 20 秒）。
  // 尺寸兜底：包里已经缩过图（convert --max-texture），但老包 / 别人给的包可能还是 4096~8192。
  // 一张 8192² RGBA 显存 256 MB，桌宠实际只占 200 px 高——超过 maxTex 先在 2D canvas 里缩再上传。
  const maxTex = Math.min(2048, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048);
  const isPOT = (n) => n > 0 && (n & (n - 1)) === 0;
  const shrinkForUpload = (img) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const longest = Math.max(w, h);
    if (longest <= maxTex) return { src: img, w, h };
    const k = maxTex / longest;
    const nw = Math.max(1, Math.round(w * k));
    const nh = Math.max(1, Math.round(h * k));
    const c = doc.createElement('canvas');
    c.width = nw;
    c.height = nh;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, nw, nh);
    console.warn(`[l2d] 贴图超上限，运行时缩到 ${nw}×${nh}（原 ${w}×${h}）：包里跑一次构建即可持久化`);
    return { src: c, w: nw, h: nh };
  };

  let texturesReady = false;
  (async () => {
    for (let i = 0; i < entry.textures.length; i++) {
      const img = await opts.loadImage(new URL(`models/${entry.id}/${entry.textures[i]}`, base));
      const { src, w, h } = shrinkForUpload(img);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      // 缩小采样用 mipmap：8192→200 px 只用 LINEAR 会闪；缩到 2048 之后 mipmap 只要几毫秒。
      // 非 2 的幂（WebGL1）不能建 mipmap，退回 LINEAR。
      const pot = isPOT(w) && isPOT(h);
      if (pot) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pot ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      if (aniso && pot) {
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, max));
      }
      renderer.bindTexture(i, tex);
    }
    model.setInitialized(true);
    texturesReady = true;
  })().catch((e) => console.error('贴图加载失败', e));

  // ---------- 动作 ----------
  // 每条动作都必须 setEffectIds：CubismMotion 每帧读 _eyeBlinkParameterIds /
  // _lipSyncParameterIds，不设是 null → updateMotion 每帧抛 TypeError → 动作静默失效。
  const eyeBlinkIds = [];
  const lipSyncIds = [];
  for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) eyeBlinkIds.push(setting.getEyeBlinkParameterId(i));
  for (let i = 0; i < setting.getLipSyncParameterCount(); i++) lipSyncIds.push(setting.getLipSyncParameterId(i));

  const clips = new Map();
  for (const m of entry.motions ?? []) {
    try {
      const mod = await import(new URL(`models/${entry.id}/${m.file}`, base));
      const buf = b64ToBuffer(mod.default);
      const clip = model.loadMotion(buf, buf.byteLength, m.id);
      if (clip) {
        clip.setEffectIds(eyeBlinkIds, lipSyncIds);
        // 素材里可能是循环动作（VTS 当热键开关）；手势在 startClip 里强制一次性
        clip.setLoop(!!m.loop);
        if (m.fadeIn) clip.setFadeInTime(m.fadeIn);
        clips.set(m.id, clip);
      }
    } catch (e) {
      console.warn('motion 载入失败', m.id, e);
    }
  }

  // ---------- 原生表情（exp3）----------
  // 模型自带的表情文件比通用配方更贴脸；由 profile.expressions 把词映射到文件。
  const expressions = new Map();
  for (const e of entry.expressions ?? []) {
    try {
      const mod = await import(new URL(`models/${entry.id}/${e.file}`, base));
      const bytes = new TextEncoder().encode(JSON.stringify(mod.default));
      const clip = model.loadExpression(bytes.buffer, bytes.length, e.id);
      if (clip) expressions.set(e.id, clip);
    } catch (err) {
      console.warn('表情载入失败', e.id, err);
    }
  }
  let currentExpr = null;
  let expressionOverride = null;

  function stepExpression(face, dt) {
    if (SIMPLE) return;
    const want = expressionOverride ?? profile.expressions?.[face ?? 'neutral'] ?? null;
    if (want !== currentExpr) {
      try { model._expressionManager.stopAllMotions(); } catch { /* 忽略 */ }
      currentExpr = null;
      const clip = want ? expressions.get(want) : null;
      if (clip) {
        try {
          model._expressionManager.startMotion(clip, false);
          currentExpr = want;
        } catch { /* 忽略 */ }
      }
    }
    if (currentExpr) {
      try { model._expressionManager.updateMotion(model._model, dt); } catch { /* 忽略 */ }
    }
  }

  let currentId = null;
  let idlePlaying = false;
  let idleTurn = 0;
  let lastGesture = null;
  let motionWarned = false;
  const idleIds = (entry.idle ?? []).map((m) => m.id).filter((id) => clips.has(id));

  const startClip = (id, priority, loop = false) => {
    const clip = clips.get(id);
    if (!clip) return false;
    try {
      clip.setLoop(loop);
      model._motionManager.startMotionPriority(clip, false, priority);
      currentId = id;
      return true;
    } catch (e) {
      console.warn('motion 播放失败', id, e);
      return false;
    }
  };

  function startIdle() {
    if (!idleIds.length) return false;
    const id = idleIds[idleTurn++ % idleIds.length];
    model._motionManager.stopAllMotions();
    const ok = startClip(id, 1, true);
    idlePlaying = ok;
    return ok;
  }

  // ---------- role 表：语义 → 真实参数 ----------
  const ids = CubismFramework.getIdManager();
  const paramIndex = new Map();
  for (let i = 0; i < model._model.getParameterCount(); i++) {
    paramIndex.set(model._model.getParameterId(i).getString(), i);
  }

  /** 每个 role 只保留模型里真实存在的目标参数。 */
  const roles = new Map();
  for (const [name, r] of Object.entries(profile.roles ?? {})) {
    const items = [];
    for (const target of r.targets ?? []) {
      const index = paramIndex.get(target);
      if (index === undefined) continue;
      items.push({
        handle: ids.getId(target),
        index,
        min: model._model.getParameterMinimumValue(index),
        max: model._model.getParameterMaximumValue(index),
        def: model._model.getParameterDefaultValue(index),
      });
    }
    if (!items.length) continue;
    roles.set(name, { space: r.space ?? [-1, 1], def: r.default ?? 0, items });
  }

  const driven = new Set();
  for (const role of roles.values()) for (const it of role.items) driven.add(it.handle.getString());

  // 工作台/外部驱动：直接写 role（优先级最高，调试与校准时用）
  const roleOverrides = {};

  // ---------- 表演层（SoulLink）----------
  // 情绪词 → VAD → FACS → role，负责过渡、待机微动、呼吸和视线漂移。
  // 加载失败就退回下面的离散表情配方，包不会因此不可用。
  let performance = null;
  try {
    const { createPerformance } = await import('./soullink.js');
    performance = createPerformance(profile, console.warn);
    if (performance) {
      console.info('[l2d] SoulLink 表演层已启用');
      // 有原生 Idle 组就让模型自己待机，引擎只负责情绪和表情
      if (!SIMPLE && idleIds.length && profile.performance?.tuning?.nativeIdle !== false) {
        performance.setIdleEnabled(false);
        console.info('[l2d] 使用模型原生 Idle 动作');
      }
    }
  } catch (e) {
    console.warn('[l2d] SoulLink 表演层没加载，使用离散表情', e);
  }

  /**
   * 语义值 → 模型值：以 default 为锚的两段线性。
   * 这样模型范围不对称、默认值不在中点也不会错。
   */
  function writeRole(name, semantic) {
    const role = roles.get(name);
    if (!role) return;
    const [lo, hi] = role.space;
    const d = role.def;
    const v = clamp(semantic, lo, hi);
    for (const it of role.items) {
      const mv = v >= d
        ? it.def + (hi === d ? 0 : ((v - d) / (hi - d)) * (it.max - it.def))
        : it.def - (d === lo ? 0 : ((d - v) / (d - lo)) * (it.def - it.min));
      model._model.setParameterValueById(it.handle, clamp(mv, it.min, it.max));
    }
  }

  // ---------- 部件不透明度 ----------
  // Cubism SDK 把 PartOpacity 曲线按「参数」查索引（getParameterIndex），
  // 而 PartArmA/B 是部件 → 恒 -1，曲线整条失效 → 两套手臂同时显示（四只手）。
  // 所以按动作自带的目标值每帧直接写部件不透明度。
  const partIndex = new Map();
  for (let i = 0; i < model._model.getPartCount(); i++) {
    partIndex.set(model._model.getPartId(i).getString(), i);
  }
  const partTargets = new Map((entry.motions ?? []).map((m) => [m.id, m.partOpacity ?? null]));
  const baseParts = profile.parts?.base ?? { PartArmA: 1, PartArmB: 0 };

  function applyPartOpacity(id) {
    const want = (id && partTargets.get(id)) || baseParts;
    for (const name of Object.keys(want)) {
      const i = partIndex.get(name);
      if (i !== undefined) model._model.setPartOpacityByIndex(i, want[name]);
    }
  }

  /** 动作播完后，把动作碰过、role 不负责的参数慢慢拉回默认（避免姿势定格）。 */
  function easeRestToDefault(dt) {
    const rate = clamp(dt * 4, 0, 1);
    for (let i = 0; i < model._model.getParameterCount(); i++) {
      if (driven.has(model._model.getParameterId(i).getString())) continue;
      const cur = model._model.getParameterValueByIndex(i);
      const def = model._model.getParameterDefaultValue(i);
      if (cur !== def) model._model.setParameterValueByIndex(i, cur + (def - cur) * rate);
    }
  }

  function stepMotion(frame, dt) {
    if (SIMPLE) return;
    const g = frame.gesture;
    const want = g?.kind && clips.has(g.kind) ? g.kind : null;

    // 同一个手势不重复重播：kit 把 gesture 保持几帧，播完就去待机
    if (want && want !== lastGesture) {
      model._motionManager.stopAllMotions();
      idlePlaying = false;
      startClip(want, 3, false);
      lastGesture = want;
    } else if (!want) {
      lastGesture = null;
    }

    if (currentId && model._motionManager.isFinished()) {
      currentId = null;
      idlePlaying = false;
      model._motionManager.stopAllMotions();
    }

    if (!currentId) {
      // 有原生 Idle 组就让模型自己待机（比程序微动更自然），没有再回默认姿势
      if (idleIds.length && startIdle()) return;
      easeRestToDefault(dt);
      return;
    }

    try {
      model._motionManager.updateMotion(model._model, dt);
    } catch (e) {
      if (!motionWarned) {
        motionWarned = true;
        console.warn('动作更新失败（后续不再提示）', e);
      }
    }
  }

  // ---------- 每帧：base → 表演层 / 表情 → 程序动画 ----------
  function applyFrame(face, frame, dt, neutralPose = false) {
    const t = frame.t ?? 0;

    // 1) 全部 role 回到默认（写默认 == 模型默认姿势，所以是幂等的）
    for (const [name, role] of roles) writeRole(name, role.def);

    // 2) 表演层：连续情绪（VAD → FACS → role）。没有表演层才走离散配方。
    //    量取景的那几帧强制中性姿势：待机动作会把包围盒撑大，脚就量不准。
    const engine = performance && !neutralPose ? performance.update(t, dt, frame.face) : null;
    const recipe = neutralPose
      ? {}
      : (engine
        ? null
        : (profile.expression?.[frame.face ?? 'neutral'] ?? profile.expression?.neutral ?? {}));
    if (recipe) for (const [k, v] of Object.entries(recipe)) if (k !== 'fade') writeRole(k, v);

    // 3) 眼睛：形状 + 眨眼 + 困意（乘在表情之上，闭眼笑也能眨）
    let shape = 1;
    const eye = neutralPose ? null : face.eyes?.[0];
    if (eye) {
      if (eye.shape === 'down' || eye.shape === 'up') shape = 0;
      else if (eye.shape === 'lid') shape = clamp((eye.ry ?? 12) / 16, 0, 1);
    }
    const close = neutralPose ? 1 : 1 - clamp(frame.blink ?? 0, 0, 1);
    const squint = neutralPose ? 1 : 1 - clamp(frame.eyeClose ?? 0, 0, 1);
    const drowse = neutralPose ? 1 : 1 - 0.75 * clamp(frame.drowse ?? 0, 0, 1);
    const baseOpen = engine
      ? clamp(engine.eyeOpen ?? 1, 0, 1)
      : (recipe?.eyeOpen ?? roles.get('eyeOpen')?.def ?? 1);
    const open = baseOpen * shape * close * squint * drowse;
    writeRole('eyeOpen', open);
    // 测试台在存图前读这个，确认「这一帧」到底算出了什么（不是换表情那一帧）
    globalThis.__l2dLast = {
      face: neutralPose ? 'neutral*' : frame.face, open: +open.toFixed(2), shape: eye?.shape ?? null, ry: eye?.ry ?? null,
      blink: +(frame.blink ?? 0).toFixed(2), ec: +(frame.eyeClose ?? 0).toFixed(2),
      perf: !!engine, mood: globalThis.__l2dPerf?.dominant ?? null,
    };

    // 4) 口型（说话时以口型为准，但惊讶等表情的张嘴不能被压掉）
    const gap = face.gap?.[0] ?? 50;
    const talk = neutralPose ? 0 : clamp(frame.talk ?? 0, 0, 1);
    const talkOpen = clamp((gap - 44) / 22 + talk * 0.35, 0, 1);
    writeRole('mouthOpen', neutralPose ? 0 : clamp(Math.max(talkOpen, (engine?.mouthOpen ?? 0) * 0.85), 0, 1));

    // 5) 视线 + 头身跟随（表演层的待机动作叠在宿主跟随之上）
    const look = neutralPose ? [0, 0] : (Array.isArray(frame.look) ? frame.look : [0, 0]);
    const tilt = neutralPose ? 0 : (frame.tilt ?? 0);
    const lean = neutralPose ? 0 : (frame.lean ?? 0);
    const ax = engine?.angleX ?? 0;
    const ay = engine?.angleY ?? 0;
    const az = engine?.angleZ ?? 0;
    const bx = engine?.bodyX ?? 0;
    const ex = engine?.eyeBallX ?? 0;
    const ey = engine?.eyeBallY ?? 0;
    if (engine) {
      writeRole('eyeBallX', clamp(ex * 0.6 + (look[0] ?? 0) * 0.55, -1, 1));
      writeRole('eyeBallY', clamp(ey * 0.6 - (look[1] ?? 0) * 0.45, -1, 1));
      writeRole('angleX', clamp(ax * 0.75 + (look[0] ?? 0) * 0.4, -1, 1));
      writeRole('angleY', clamp(ay * 0.75 - (look[1] ?? 0) * 0.35, -1, 1));
      writeRole('angleZ', clamp(az + tilt * 0.4, -1, 1));
      writeRole('bodyX', clamp(bx + lean * 0.35, -1, 1));
      // 表情通道：引擎/配方已经算好，之前漏写，导致只有眼/嘴/头在动
      for (const k of ['eyeSmile', 'mouthForm', 'browY', 'browAngle', 'cheek']) {
        if (Number.isFinite(engine[k])) writeRole(k, engine[k]);
      }
      writeRole('breath', Number.isFinite(engine.breath) ? engine.breath : 0.5 + 0.5 * Math.sin(t * 1.6));
    } else {
      writeRole('eyeBallX', clamp(look[0] ?? 0, -1, 1));
      writeRole('eyeBallY', clamp(-(look[1] ?? 0), -1, 1));
      writeRole('angleX', clamp((look[0] ?? 0) * 0.73, -1, 1));
      writeRole('angleY', clamp(-(look[1] ?? 0) * 0.6, -1, 1));
      writeRole('angleZ', clamp(tilt * 0.67, -1, 1));
      writeRole('bodyX', clamp(lean * 0.6, -1, 1));
      writeRole('breath', neutralPose ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.6));
    }

    // 6) 外部直接驱动（工作台滑杆 / 参数面板）；放在最后，压过表情和待机
    for (const [name, value] of Object.entries(roleOverrides)) {
      if (Number.isFinite(value)) writeRole(name, value);
    }
  }

  // ---------- 取景 ----------
  // fitState 已在上方声明；这里只定义怎么应用
  function applyFit() {
    const fit = fitState;
    const cw = model._model.getCanvasWidth?.() ?? 1;
    const ch = model._model.getCanvasHeight?.() ?? 1;
    const aspect = cw / ch;
    const [px, py] = fit.padding ?? [0, 0];
    const availW = 2 * (1 - 2 * px);
    const availH = 2 * (1 - 2 * py);
    const base = fit.mode === 'cover'
      ? Math.max(availH, availW / aspect)
      : Math.min(availH, availW / aspect);
    const h = base * (Number.isFinite(fit.zoom) ? fit.zoom : 1);

    model._modelMatrix.setHeight(h);

    const [ox, oy] = fit.offset ?? [0, 0];
    const anchor = fit.anchor ?? 'center';
    const y = anchor === 'bottom' ? (-1 + py + h / 2)
      : anchor === 'top' ? (1 - py - h / 2)
        : 0;
    model._modelMatrix.setY(y + oy);
    if (typeof model._modelMatrix.setX === 'function') model._modelMatrix.setX(ox);
  }

  // ---------- 绘制 ----------
  function render() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const projection = new CubismMatrix44();
    projection.scale(canvas.height / canvas.width, 1);
    projection.multiplyByMatrix(model._modelMatrix);
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(gl.getParameter(gl.FRAMEBUFFER_BINDING), [0, 0, canvas.width, canvas.height]);
    renderer.drawModel();
  }

  /**
   * 量取景时强制中性姿势。
   * 待机 / 呼吸 / 物理会让包围盒每帧变化；直接 measure 会把“这一帧”的姿势写死，
   * 每次自动贴合就会得到不同的 zoom / offset。而且外部调用 readPixels 时，
   * 默认帧缓冲可能已经被合成器清空。先重画一帧中性姿势再读，结果才稳定。
   */
  function renderNeutralPose() {
    if (!texturesReady) return false;
    model._model.loadParameters();
    applyFrame({}, {}, 1 / 60, true);
    applyPartOpacity(null);
    model._model.saveParameters();
    // 物理是有状态的：同一中性姿势也会因为上一帧的惯性读出不同包围盒。
    // 简单模式量取景不跑物理（脚底 / 躯干 / 高度不受头发尾巴滞后影响）。
    if (!SIMPLE) {
      try { model._physics?.evaluate(model._model, 1 / 60); } catch { /* 物理失败不致命 */ }
      try { model._pose?.updateParameters(model._model, 1 / 60); } catch { /* 姿势失败不致命 */ }
    }
    model._model.update();
    render();
    return true;
  }

  function measureNeutralExtent() {
    if (!renderNeutralPose()) return null;
    return measureExtent();
  }

  /**
   * 把当前 WebGL 帧抓成透明 PNG（data URL）。
   * readPixels 是底向上、预乘 alpha；这里翻转并反预乘，再按最长边缩到 size。
   * 调用前必须刚 render 过，否则默认帧缓冲可能已被合成器清空。
   */
  function canvasPng(size = 512) {
    const w = canvas.width;
    const h = canvas.height;
    const src = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const out = doc.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const image = ctx.createImageData(w, h);
    const d = image.data;
    for (let y = 0; y < h; y++) {
      const sy = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const i = (sy * w + x) * 4;
        const o = (y * w + x) * 4;
        const a = src[i + 3];
        d[o + 3] = a;
        if (a === 0) {
          d[o] = d[o + 1] = d[o + 2] = 0;
        } else {
          // WebGL 里是预乘 alpha；2D canvas 的 ImageData 要 straight alpha
          d[o] = Math.min(255, Math.round((src[i] * 255) / a));
          d[o + 1] = Math.min(255, Math.round((src[i + 1] * 255) / a));
          d[o + 2] = Math.min(255, Math.round((src[i + 2] * 255) / a));
        }
      }
    }
    ctx.putImageData(image, 0, 0);
    if (size === w) return out.toDataURL('image/png');
    const small = doc.createElement('canvas');
    small.width = size;
    small.height = size;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(out, 0, 0, size, size);
    return small.toDataURL('image/png');
  }

  // ---------- 交给 kit ----------
  // extent / anchors 优先用实测：第一帧画出来后读一次 alpha 包围盒，
  // 换模型/换贴图都不用再手填（不同画布留白差异太大，写死一定错）。
  // profile.extent / profile.anchors 仍然可以覆盖（工作台校准后写死）。
  const DEFAULT_EXTENT = [20, 8, 236, 256];
  let extent = profile.extent ?? null;
  /** 命中圈按高度带取可见 alpha 的中心；整张 bbox 会被尾巴/胡须带偏。 */
  let hitBands = null;

  function measureExtent() {
    const w = canvas.width;
    const h = canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const rowMin = new Int32Array(h).fill(w);
    const rowMax = new Int32Array(h).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (buf[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (x < rowMin[y]) rowMin[y] = x;
          if (x > rowMax[y]) rowMax[y] = x;
        }
      }
    }
    if (x1 < 0) { hitBands = null; return null; }
    const unit = BOX / w;                       // 每像素多少 logo 单位
    const lx0 = x0 * unit, lx1 = (x1 + 1) * unit;
    const ly0 = (h - 1 - y1) * unit, ly1 = (h - y0) * unit;
    const lw = Math.max(1, lx1 - lx0), lh = Math.max(1, ly1 - ly0);
    const radii = [
      Math.min(lw * .46, lh * .18),
      Math.min(lw * .52, lh * .26),
      Math.min(lw * .48, lh * .22),
    ];
    hitBands = [0.14, 0.47, 0.80].map((k, i) => {
      const cy = ly0 + lh * k;
      const yc = Math.round(h - 1 - cy / unit);
      const half = Math.max(2, Math.round(lh * .045 / unit));
      let min = w, max = -1;
      for (let yy = Math.max(0, yc - half); yy <= Math.min(h - 1, yc + half); yy++) {
        if (rowMax[yy] < 0) continue;
        if (rowMin[yy] < min) min = rowMin[yy];
        if (rowMax[yy] > max) max = rowMax[yy];
      }
      const cx = max >= 0 ? (min + max + 1) / 2 * unit : (lx0 + lx1) / 2;
      return [cx, cy, Math.max(1, radii[i])];
    });
    // 三段的水平中心统一用躯干：头/腿的单段 span 会被尾巴、胡须带偏
    const bodyCx = hitBands[1]?.[0] ?? (lx0 + lx1) / 2;
    for (const b of hitBands) b[0] = bodyCx;
    return [
      Math.round(lx0),
      Math.round(ly0),
      Math.round(lx1),
      Math.round(ly1),
    ];
  }

  /**
   * 自动贴合：把可见 alpha 映射到 256 契约。
   * 脚 256 / 中心 128 / 高约 232 / 宽 ≤ 208；宽模型只压宽，不压脚底。
   */
  function autoFitExtent(target = {}) {
    const wantH = Number.isFinite(target.height) ? target.height : 232;
    const maxW = Number.isFinite(target.maxWidth) ? target.maxWidth : 208;
    const feet = Number.isFinite(target.feet) ? target.feet : 256;
    const center = Number.isFinite(target.center) ? target.center : 128;
    let m = measureNeutralExtent();
    if (!m) return null;
    for (let i = 0; i < 6; i++) {
      const [x0, y0, x1, y1] = m;
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      const targetH = Math.min(wantH, (maxW * h) / w);
      // 用“躯干可见带”的中心，而不是整张 bbox：尾巴/胡须会把 bbox 中心拉偏
      const cx = hitBands?.[1]?.[0] ?? (x0 + x1) / 2;
      const okH = Math.abs(h - targetH) <= 1.5;
      const okX = Math.abs(cx - center) <= 1.5;
      const okY = Math.abs(y1 - feet) <= 1.5;
      if (okH && okX && okY) break;
      if (!okH) fitState.zoom = clamp((Number(fitState.zoom) || 1) * (targetH / h), 0.15, 6);
      const [ox, oy] = fitState.offset ?? [0, 0];
      fitState.offset = [
        clamp(ox + (center - cx) / 128, -1.5, 1.5),
        clamp(oy + (y1 - feet) / 128, -1.5, 1.5),
      ];
      applyFit();
      m = measureNeutralExtent() ?? m;
    }
    return m;
  }

  let extentFrames = 0;
  const currentExtent = () => extent ?? DEFAULT_EXTENT;
  const currentHits = () => profile.hits ?? hitBands ?? (() => {
    const [x0, y0, x1, y1] = currentExtent();
    const w = x1 - x0;
    const h = y1 - y0;
    const cx = (x0 + x1) / 2;
    const r = (v) => Math.max(1, v);
    // 单圆只覆盖胸口：头/脚抓不到，空白处又会吃点击。按可见范围给头 / 身 / 下三段。
    return [
      [cx, y0 + h * .14, r(Math.min(w * .46, h * .18))],
      [cx, y0 + h * .47, r(Math.min(w * .52, h * .26))],
      [cx, y0 + h * .80, r(Math.min(w * .48, h * .22))],
    ];
  })();
  const currentAnchors = () => profile.anchors ?? deriveAnchors(currentExtent());

  const publishInfo = () => {
    globalThis.__l2dInfo = {
      extent: currentExtent(),
      measured: extent,
      anchors: currentAnchors(),
      hits: currentHits(),
      roles: [...roles.keys()],
      expressions: [...expressions.keys()],
      idle: idleIds,
      motion: profile.motion?.kind === 'stand' ? 'stand' : 'roam',
      fit: { ...fitState, offset: [...(fitState.offset ?? [0, 0])], padding: [...(fitState.padding ?? [0, 0])] },
    };
  };

  const figure = {
    get extent() { return currentExtent(); },
    get hits() { return currentHits(); },
    get anchors() { return currentAnchors(); },
    colors: { z: '#7fb0e8' },

    // 工作台调试接口：直接写 role（不是 ParamXXX），优先级高于表情/待机
    __roles: {
      list: () => [...roles.keys()],
      set(values) {
        for (const [name, value] of Object.entries(values ?? {})) {
          if (roles.has(name) && Number.isFinite(value)) roleOverrides[name] = value;
          else delete roleOverrides[name];
        }
      },
      clear() { for (const name of Object.keys(roleOverrides)) delete roleOverrides[name]; },
      read: () => ({ ...roleOverrides }),
    },

    // 工作台试看：临时指定一个 exp3，不写回 profile
    __expr: {
      list: () => [...expressions.keys()],
      set(id) {
        // '' 表示「明确不要 exp3」（压过 profile 映射）；null 表示回退到 profile
        expressionOverride = id === '' ? '' : (id && expressions.has(id) ? id : null);
      },
      clear() { expressionOverride = null; },
      read: () => expressionOverride,
    },

    // 工作台取景：位置/大小实时改，构建时写进 profile.fit
    __fit: {
      get: () => ({ ...fitState, offset: [...(fitState.offset ?? [0, 0])], padding: [...(fitState.padding ?? [0, 0])] }),
      set(values) {
        const next = { ...fitState, ...(values ?? {}) };
        if (values?.mode) next.mode = values.mode;
        fitState = next;
        applyFit();
      },
      reset() {
        fitState = { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1, ...(profile.fit ?? {}) };
        applyFit();
      },
    },

    // 工作台：改完 fit 后重量一次 alpha 包围盒（否则 extent / 命中圈还是旧的）
    __remeasure() {
      try {
        const m = measureNeutralExtent();
        if (m) { extent = m; publishInfo(); }
        return m;
      } catch { return null; }
    },

    /**
     * 封面：中性姿势 + 专用取景（高 200 / 脚底 236 / 中心 128）拍 512 和 128 两张 PNG。
     * 拍完把 fitState / extent / 命中圈全部还原，绝不影响正常预览和命中测试。
     */
    __cover() {
      if (!texturesReady) return null;
      const oldFit = {
        ...fitState,
        offset: [...(fitState.offset ?? [0, 0])],
        padding: [...(fitState.padding ?? [0, 0])],
      };
      const oldExtent = extent;
      const oldHits = hitBands;
      try {
        // 封面从固定的基准取景出发，不继承上一次的 zoom / offset；否则两次构建会差几像素。
        fitState = { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1, autoFit: false };
        applyFit();
        const m = autoFitExtent({ height: 200, feet: 236, center: 128, maxWidth: 208 });
        if (!m) return null;
        if (!renderNeutralPose()) return null;
        const png = canvasPng(canvas.width);
        const png128 = canvasPng(128);
        return png && png128 ? { png, png128 } : null;
      } catch (e) {
        console.warn('[l2d] 封面生成失败', e);
        return null;
      } finally {
        fitState = oldFit;
        applyFit();
        extent = oldExtent;
        hitBands = oldHits;
        publishInfo();
        render();
      }
    },

    draw(petG, face, frame) {
      if (fo.parentNode !== petG) petG.appendChild(fo);
      if (!texturesReady) return;

      const dt = clamp(frame.dt ?? 0.016, 0.001, 0.05);

      model._model.loadParameters();
      applyFrame(face, frame, dt, !extent);
      stepMotion(frame, dt);
      stepExpression(frame.face, dt);
      applyPartOpacity(currentId);
      model._model.saveParameters();            // ← 必须在 physics 之前
      try { model._physics?.evaluate(model._model, dt); } catch { /* 物理失败不致命 */ }
      try { model._pose?.updateParameters(model._model, dt); } catch { /* 姿势失败不致命 */ }
      model._model.update();
      render();

      globalThis.__l2dMotion = {
        id: currentId,
        idle: idlePlaying,
        idleCount: idleIds.length,
        expr: currentExpr,
        exprCount: expressions.size,
      };

      // 贴图就绪后的第 3 帧量一次可见范围（等姿势稳定，别量到眨眼/动作的瞬间）
      if (!extent && extentFrames < 30 && ++extentFrames >= 3) {
        let m = null;
        try {
          m = fitState.autoFit !== false ? autoFitExtent() : measureNeutralExtent();
        } catch (e) {
          console.warn('[l2d] 量取景失败', e);
        }
        if (m) {
          extent = m;
          publishInfo();
          console.info('[l2d] extent', JSON.stringify(m));
          console.info('[l2d] fit', JSON.stringify(fitState));
        } else if (extentFrames === 3) {
          console.info('[l2d] extent 没量到（画面全透明？）');
        }
      }
    },

    dispose() {
      fo.remove();
      try { performance?.dispose(); } catch { /* 忽略 */ }
      try { model.release?.(); } catch { /* 忽略 */ }
    },
  };

  // 只有动作词交给 kit；表情走 profile.expression，kit 自己的 KIT_EXPRESSIONS 仍然可用
  const words = {};
  for (const m of entry.motions ?? []) {
    words[m.id] = { motion: { seconds: m.duration || 3 } };
  }

  publishInfo();
  globalThis.__l2dDrive = figure.__roles;
  globalThis.__l2dFit = figure.__fit;
  globalThis.__l2dRemesure = figure.__remeasure;
  globalThis.__l2dAutoFit = () => {
    const m = autoFitExtent();
    if (m) { extent = m; publishInfo(); }
    return m;
  };
  globalThis.__l2dCover = figure.__cover;
  globalThis.__l2dExpr = figure.__expr;

  const body = kit.createBody(host, { figure, words, css: 'foreignObject{pointer-events:none}' });
  const motionKind = profile.motion?.kind === 'stand' ? 'stand' : 'roam';
  if (SIMPLE && motionKind === 'stand') {
    // 站定：无论 Coo / 预览传什么 roam，都强制 off；正面立绘也不镜像。
    const setBase = body.set.bind(body);
    body.set = (s) => setBase({ ...(s || {}), roam: 'off' });
    try { setBase({ roam: 'off' }); } catch { /* ignore */ }
    if (profile.facing !== 'mirror') {
      const placeBase = body.place.bind(body);
      body.place = (x, facing, y) => placeBase(x, 1, y);
      try { placeBase(body.layout?.().x ?? 0, 1); } catch { /* ignore */ }
      const stepBase = body.step.bind(body);
      body.step = (dt) => {
        try {
          const l = body.layout?.();
          if (l?.mode === 'idle' && !l.pressing && !l.busy) body.place(l.x, 1);
        } catch { /* ignore */ }
        stepBase(dt);
      };
    }
  }
  // roam：不拦截 set，也不驱动 place。让 kit 自己的 decide 跑
  // look / walk / run / jump / sit / expr，和旧版一致。
  return body;
}
