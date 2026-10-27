/**
 * SoulLink 表演层：把「情绪词」变成连续的 role 曲线。
 *
 * 分工：
 *   - 引擎（pack/vendor/soullink）：VAD 情绪状态、FACS、待机微动、眨眼、呼吸、动作编排
 *   - 本文件：把 FACS 通道翻译成我们的 role 名（**不认识 ParamXXX**）
 *   - profile.performance：每个模型自己的情绪词映射与强度（数据）
 *
 * 为什么是「FACS → role」而不是「FACS → 真实参数」：
 *   role 是模型无关的语义层，换模型只要校准 role 表；这套映射所有模型共用。
 *
 * 沙箱约束：引擎是纯计算、零依赖，可以整包放进 figure frame（不联网）。
 * 授权：Apache-2.0，见 vendor/soullink/LICENSE 与 NOTICE。
 */
import {
  SoullinkRuntime,
  detectCapabilities,
  deriveParameterSmoothing,
  getVADPreset,
  motionStylePresets,
} from '../vendor/soullink/index.js';

/**
 * FACS 通道 → role。scale 为负表示反向（眉压低 = browY 负）。
 * 只列我们 role 表里存在的，模型缺哪个就自动跳过。
 */
const RULES = [
  ['headX', ['angleX'], 1, 'set'],
  ['headY', ['angleY'], 1, 'set'],
  ['headZ', ['angleZ'], 1, 'set'],
  ['bodyX', ['bodyX'], 1, 'set'],
  ['eyeOpen', ['eyeOpen'], 1, 'set'],
  ['eyeSmile', ['eyeSmile'], 1, 'set'],
  ['gazeX', ['eyeBallX'], 1, 'set'],
  ['gazeY', ['eyeBallY'], 1, 'set'],
  ['mouthOpen', ['mouthOpen'], 1, 'set'],
  ['mouthSmile', ['mouthForm'], 0.95, 'add'],
  ['mouthFrown', ['mouthForm'], -0.85, 'add'],
  ['browInnerUp', ['browY'], 1, 'add'],
  ['browDown', ['browY'], -1, 'add'],
  // 惊讶主要靠 browOuterUp；只给 browAngle 的话眉毛几乎不动
  ['browOuterUp', ['browY'], 0.9, 'add'],
  ['browOuterUp', ['browAngle'], 0.8, 'add'],
  ['blush', ['cheek'], 1, 'set'],
  ['breath', ['breath'], 1, 'set'],
];

/**
 * 引擎输出的 FACS 是「克制」的（0..1 里通常只用 0.1~0.4），
 * 这里按通道放大到我们 role 的表现力。数据可在 profile.performance.response 覆盖。
 */
const RESPONSE = {
  eyeSmile: 2,
  browY: 2.2,
  browAngle: 1.4,
  cheek: 8,
  mouthForm: 1.35,
  mouthOpen: 1,
  eyeOpen: 1,
  breath: 1,
  angleX: 1,
  angleY: 1,
  angleZ: 1,
  bodyX: 1,
  eyeBallX: 1,
  eyeBallY: 1,
};


/** 表情词 → SoulLink 的 VAD 预设。模型可以在 profile.performance.emotion 里覆盖。 */
const EMOTION = {
  neutral: 'neutral',
  happy: 'happy',
  wink: 'happy',
  love: 'affectionate',
  shy: 'shy',
  surprised: 'surprised',
  angry: 'anger',
  sad: 'sad',
  sleepy: 'tired',
  thinking: 'curious',
  smug: 'happy',
  pout: 'anger',
  worried: 'anxiety',
  determined: 'concerned',
  flustered: 'shy',
  scared: 'anxiety',
  excited: 'excited',
  cry: 'sad',
  confused: 'confused',
  calm: 'calm',
};

/**
 * 建一个表演层。失败时抛错，由调用方降级回原来的离散表情。
 *
 * @param {object} profile  模型 profile.js（用到 roles / performance）
 * @param {(msg: string, err?: unknown) => void} warn
 */
export function createPerformance(profile, warn = console.warn) {
  const config = profile.performance ?? {};
  if (config.enabled === false) return null;

  const roles = profile.roles ?? {};
  if (!Object.keys(roles).length) return null;
  const tuning = config.tuning ?? {};
  const parameterMap = {};
  const neutralParams = {};

  for (const [name, role] of Object.entries(roles)) {
    neutralParams[name] = role.default ?? 0;
  }

  for (const [key, targets, scale, mode] of RULES) {
    const hits = targets.filter((t) => roles[t]);
    if (!hits.length) continue;
    const [lo, hi] = roles[hits[0]].space ?? [-1, 1];
    parameterMap[key] = {
      targets: hits,
      mode: mode === 'add' ? 'add' : 'set',
      scale,
      min: lo,
      max: hi,
    };
  }

  const modelProfile = {
    schemaVersion: 2,
    modelId: 'role-layer',
    displayName: 'Role layer',
    version: '1.0.0',
    modelPath: '',
    parameterMap,
    neutralParams,
    idleConfig: {},
    autoProfile: { provider: 'manual', notes: ['FACS→role 通用映射；真实参数由 pack 的 role 表翻译'] },
  };
  modelProfile.capabilities = detectCapabilities(modelProfile);
  modelProfile.parameterSmoothing = deriveParameterSmoothing(modelProfile);

  const style = tuning.style && motionStylePresets[tuning.style] ? tuning.style : 'natural';
  const runtime = new SoullinkRuntime({
    profile: modelProfile,
    motionStyle: {
      ...motionStylePresets[style],
      ...(Number.isFinite(tuning.seed) ? { seed: tuning.seed } : {}),
      ...(Number.isFinite(tuning.gestureFrequency) ? { gestureFrequency: tuning.gestureFrequency } : {}),
      ...(Number.isFinite(tuning.spontaneity) ? { spontaneity: tuning.spontaneity } : {}),
      ...(Number.isFinite(tuning.idleActionGain) ? { idleActionGain: tuning.idleActionGain } : {}),
      ...(Number.isFinite(tuning.microMotionGain) ? { microMotionGain: tuning.microMotionGain } : {}),
    },
    emotionPersonality: {
      ...(Number.isFinite(tuning.reactivity) ? { reactivity: tuning.reactivity } : {}),
      ...(Number.isFinite(tuning.decayRate) ? { decayRate: tuning.decayRate } : {}),
      ...(Number.isFinite(tuning.holdSeconds) ? { emotionHoldSeconds: tuning.holdSeconds } : {}),
    },
  });

  const emotion = { ...EMOTION, ...(config.emotion ?? {}) };
  const response = { ...RESPONSE, ...(config.response ?? {}) };
  const blend = Number.isFinite(tuning.blend) ? tuning.blend : 1;
  const keepSeconds = Number.isFinite(tuning.keepSeconds) ? tuning.keepSeconds : 6;
  // 配方是「这个模型怎么演这个情绪」，引擎负责把它演活；accentGain 控制配方占比。
  const accentGain = Number.isFinite(tuning.accentGain) ? tuning.accentGain : 0.75;
  const accentSpeed = Number.isFinite(tuning.accentSpeed) ? tuning.accentSpeed : 12;

  runtime.setIdleEnabled(true);
  runtime.setLipSyncEnabled(false);           // 嘴由宿主 talk / kit 驱动，避免双重口型
  runtime.setParameterGain(Number.isFinite(tuning.gain) ? tuning.gain : 1.15);
  runtime.setBodyMotionGain(Number.isFinite(tuning.bodyGain) ? tuning.bodyGain : 1.8);
  runtime.setVADDecayRate(Number.isFinite(tuning.vadDecay) ? tuning.vadDecay : 0.03);

  let lastFace = null;
  let lastPush = -Infinity;
  let dead = false;
  let accent = {};
  let eyeMul = 1;

  return {
    /** 每帧调用；返回 role → 值的表（已只保留 role 表里有的名字）。 */
    update(t, dt, face) {
      if (dead) return null;
      try {
        const name = face ?? 'neutral';
        if (name !== lastFace || (name !== 'neutral' && t - lastPush > keepSeconds)) {
          const preset = getVADPreset(emotion[name] ?? name);
          runtime.applyVADTarget(preset, blend);
          lastFace = name;
          lastPush = t;
        }
        const snap = runtime.update(t, dt);
        const out = {};
        for (const [role, value] of Object.entries(snap.live2dParams)) {
          if (Number.isFinite(value)) out[role] = value * (response[role] ?? 1);
        }

        // 配方作为「风格层」叠加：换表情时按指数缓动交叉过去，避免瞬切。
        const recipe = profile.expression?.[name] ?? {};
        const k = 1 - Math.exp(-Math.max(0, dt) * accentSpeed);
        const want = {};
        for (const [key, value] of Object.entries(recipe)) {
          if (key === 'fade' || key === 'eyeOpen' || !Number.isFinite(value)) continue;
          want[key] = value;
        }
        const keys = new Set([...Object.keys(accent), ...Object.keys(want)]);
        for (const key of keys) {
          const aim = want[key] ?? 0;
          const now = accent[key] ?? 0;
          const next = now + (aim - now) * k;
          if (Math.abs(next) < 0.002) delete accent[key];
          else accent[key] = next;
        }
        for (const [key, value] of Object.entries(accent)) {
          if (!(key in out)) out[key] = 0;
          out[key] += value * accentGain;
        }
        const wantEye = Number.isFinite(recipe.eyeOpen) ? recipe.eyeOpen : 1;
        eyeMul += (wantEye - eyeMul) * k;
        if ('eyeOpen' in out) out.eyeOpen *= eyeMul;

        globalThis.__l2dPerf = {
          face: name,
          dominant: snap.vad.dominantEmotion,
          vad: snap.vad.current,
          target: snap.vad.target,
          facs: snap.facs,
          accent: { ...accent },
          eyeMul: +eyeMul.toFixed(3),
          roles: out,
        };
        return out;
      } catch (e) {
        dead = true;
        warn('[l2d] SoulLink 表演层出错，回退到离散表情', e);
        return null;
      }
    },
    dispose() {
      dead = true;
    },
    /** 模型有原生 Idle 动作时关掉引擎的待机层，避免两套身体动作打架。 */
    setIdleEnabled(enabled) {
      runtime.setIdleEnabled(enabled);
    },
  };
}
