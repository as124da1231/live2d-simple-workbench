#!/usr/bin/env node
/**
 * 模型 → 形象包（沙箱形态）转换器。
 *
 * 只读：旧 pack/、旧 tools/live2d-to-pack.py、应用目录都不动。
 * 产物写到 --out（默认 build/<id>/），已存在且非空时拒绝覆盖，除非 --force。
 *
 * 用法：
 *   node tools/convert.mjs --model "<VTS/官方模型目录>" [--out build/<id>] [--id <id>]
 *                          [--runtime pack] [--force] [--dry-run]
 *
 * 产出：
 *   <out>/
 *     figure.json            清单（vocab 按实际存在的 role 生成）
 *     figure.js              入口（从 --runtime 复制）
 *     backends/live2d.js     渲染内核（从 --runtime 复制，数据驱动）
 *     sdk/                   Cubism core + framework + 内联着色器（复制）
 *     models/index.js        注册表（模型 + 动作元数据）
 *     models/<id>/
 *       profile.js           ★ role 表 / 表情配方 / 取景（探测草稿 + TODO 注释）
 *       moc3.js              base64 模块
 *       model3.js  physics.js  cdi3.js
 *       motions/*.js         每段动作（含 partOpacity / owns / seconds）
 *       textures/*.png       复制后按 --max-texture 降采样（默认 2048）
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf('--' + n); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d; };
const flag = (n) => ARGS.includes('--' + n);

// ---------------------------------------------------------------- 参数
const MODEL_DIR = arg('model');
if (!MODEL_DIR || !existsSync(MODEL_DIR)) {
  console.error('用法: node tools/convert.mjs --model "<模型目录>" [--out build/<id>] [--id <id>] [--runtime pack] [--max-texture 2048] [--force] [--dry-run] [--json] [--overrides <json>]');
  process.exit(2);
}
const RUNTIME = resolve(arg('runtime', join(HERE, '..', 'pack')));
const DRY = flag('dry-run');
const JSON_OUT = flag('json');
const FORCE = flag('force');
const OVERRIDES_PATH = arg('overrides');
/**
 * 贴图最长边上限（0 = 不缩）。
 * 桌宠在屏幕上只有 ~180–260 px 高，8192² RGBA 在显存里是 256 MB/张，纯浪费：
 * 6 张就是 1.5 GB，还会拖慢首帧。2048² 仍有 8~10 倍过采样，肉眼无损。
 */
const MAX_TEX = Math.max(0, Number(arg('max-texture', 2048)) || 0);
/** 生成器配方版本：写进 build.json；工作台用它判断包是否过期 */
const GENERATOR_VERSION = 'rt-2026-10-27.4';
/** 简易模式：只做 role + 通用配方，不产出/不引用任何原生 exp3 / motion / pose 绑定。 */
const SIMPLE = true;

const readJson = async (p) => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));

/** 读 PNG 头拿尺寸（只读 24 字节，不解码整图）。非 PNG 返回 null。 */
const pngSize = (file) => {
  try {
    const fd = readFileSync(file, { flag: 'r' });
    if (fd.length < 24 || fd[0] !== 0x89 || fd[1] !== 0x50) return null;
    if (fd.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: fd.readUInt32BE(16), h: fd.readUInt32BE(20) };
  } catch { return null; }
};
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'model';

// ---------------------------------------------------------------- 找模型文件
async function findModel3(dir) {
  const direct = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'))
    .map((e) => join(dir, e.name));
  if (direct.length) return direct[0];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = await findModel3(join(dir, e.name));
    if (sub) return sub;
  }
  return null;
}

const model3Path = await findModel3(MODEL_DIR);
if (!model3Path) {
  console.error('没找到 *.model3.json：', MODEL_DIR);
  process.exit(1);
}
const modelDir = dirname(model3Path);
const model3 = await readJson(model3Path);
const ref = model3.FileReferences ?? {};
const files = ref.FileReferences ?? ref;   // VTS 有时多包一层

const id = slug(arg('id', basename(modelDir).replace(/_vts$/i, '')));
// Coo 的 axis option id 不能带连字符（scheme 用 '-' 拼多轴），模型/包 id 可以
const optionId = id.replace(/-/g, '').slice(0, 24);
const OUT = resolve(arg('out', join(HERE, '..', 'build', id)));

// ---------------------------------------------------------------- 模型资产
const resolveAsset = (p) => {
  const direct = join(modelDir, p);
  if (existsSync(direct)) return direct;
  const flat = join(modelDir, basename(p));
  return existsSync(flat) ? flat : null;
};

const mocName = files.Moc ?? files.MocFile;
const mocPath = mocName && resolveAsset(mocName);
if (!mocPath) {
  console.error('没找到 moc3（model3.json 的 FileReferences.Moc）：', mocName);
  process.exit(1);
}

const physicsPath = files.Physics ? resolveAsset(files.Physics) : null;
const posePath = files.Pose ? resolveAsset(files.Pose) : null;
const textures = (files.Textures ?? []).map((t) => resolveAsset(t)).filter(Boolean);

const cdiPath = (() => {
  const declared = files.DisplayInfo ? resolveAsset(files.DisplayInfo) : null;
  if (declared) return declared;
  const guess = join(modelDir, basename(mocPath).replace(/\.moc3$/i, '.cdi3.json'));
  return existsSync(guess) ? guess : null;
})();

const display = cdiPath ? await readJson(cdiPath) : { Parameters: [], ParameterGroups: [] };
const params = (display.Parameters ?? []).map((p) => p.Id);
const groups = new Map((display.ParameterGroups ?? []).map((g) => [g.Id, g.Name ?? g.Id]));
const paramMeta = new Map((display.Parameters ?? []).map((p) => [
  p.Id,
  { label: p.Name ?? p.Id, group: groups.get(p.GroupId) ?? '' },
]));

// ---------------------------------------------------------------- 动作
async function collectMotions() {
  const out = [];
  const seen = new Set();
  const push = (path, group, item = {}) => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, group, loop: item.Loop ?? true, fadeIn: item.FadeInTime, fadeOut: item.FadeOutTime });
  };
  // 1) model3 里声明的动作组
  for (const [group, list] of Object.entries(files.Motions ?? {})) {
    for (const item of list ?? []) {
      const p = resolveAsset(item.File);
      if (p) push(p, group, item);
    }
  }
  // 2) VTS 常见：animations/*.motion3.json
  for (const sub of ['animations', 'motions', 'motion']) {
    const dir = join(modelDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.toLowerCase().endsWith('.motion3.json')) continue;
      push(join(dir, f), sub);
    }
  }
  // 3) 直接放在模型根目录的（witchX8 这类导出）
  for (const f of await readdir(modelDir)) {
    if (!f.toLowerCase().endsWith('.motion3.json')) continue;
    push(join(modelDir, f), 'root');
  }
  return out;
}

/** 动作里的 Parameter 曲线 id（= 这条动作会独占哪些参数）。 */
const ownsOf = (json) => [...new Set((json.Curves ?? [])
  .filter((c) => c.Target === 'Parameter' && c.Id)
  .map((c) => c.Id))];

/* ---- 资源语义分类（照 Coo 工作台的做法，先看参数/中文名，再看 cdi3 分组） ---- */
const FACE_PARAM_RX = /Eye|Mouth|Brow|Cheek|Tear|Sweat|Blush|Face|Nose|Lip|Tongue/i;
const FACE_TEXT_RX = /眼|瞳|眸|嘴|口|唇|眉|脸|颊|泪|汗|红|晕|心|星|笑|哭|怒|悲|羞|惊|困|眨|闭|舌|牙|表情|情绪/;
const POSE_PARAM_RX = /Hand|Arm|Wrist|Finger|Leg|Foot|Shoulder|Hip|BodyAngle|Rotation/i;
const POSE_TEXT_RX = /手|臂|腕|指|腿|脚|肩|腰|身|姿|抱|拳|剪|挥|伸|抬|坐|站|跳/;
const OUTFIT_PARAM_RX = /Cloth|Dress|Skirt|Shirt|Sleeve|Shoe|Hat|Wing|Tail|Weapon|Accessor/i;
const OUTFIT_TEXT_RX = /衣|裙|袖|鞋|袜|帽|饰|武器|翅膀|尾|耳|机甲|装备|背包|披风|穿脱|服装/;

function classifyResource({ name, label, group, params: list }) {
  const ids = (list ?? []).map((p) => p.id).join(' ');
  const text = `${label ?? ''} ${(list ?? []).map((p) => p.label ?? '').join(' ')}`;
  const romaji = String(name ?? '');
  if (POSE_PARAM_RX.test(ids) || POSE_TEXT_RX.test(text) || /jiantou|shou|tui|jiao|shen|bao/i.test(romaji)) {
    return { cls: 'pose', why: '参数 / 名字指向手、臂或身体' };
  }
  if (FACE_PARAM_RX.test(ids) || FACE_TEXT_RX.test(text) || /eye|yan|zui|lei|han|lian|xie|yun|xing|aixin|kongbai|yuanquan|biaoqing|happy|sad|angry|cry|smile|love|shock|surprise|emotion/i.test(romaji)) {
    return { cls: 'face', why: '参数 / 名字指向五官或情绪' };
  }
  if (/表情|嘴巴|眼|脸|情绪/.test(group ?? '')) return { cls: 'face', why: 'cdi3 分组是表情类' };
  if (/动作|姿势/.test(group ?? '')) return { cls: 'pose', why: 'cdi3 分组是动作类' };
  if (OUTFIT_PARAM_RX.test(ids) || OUTFIT_TEXT_RX.test(text) || /隐藏|穿脱|服装|部件/.test(group ?? '')) {
    return { cls: 'outfit', why: '看起来是服装 / 部件开关' };
  }
  return { cls: 'other', why: '没找到明确语义；仍可手动归类' };
}

/** 原生表情文件（exp3）：model3 声明的 + VTS 常见的 expressions/ 目录。 */
async function collectExpressions() {
  const out = [];
  const seen = new Set();
  for (const item of files.Expressions ?? []) {
    const p = resolveAsset(item.File);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, name: item.Name ?? basename(p).replace(/\.exp3\.json$/i, '') });
  }
  for (const sub of ['expressions', 'expression']) {
    const dir = join(modelDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.toLowerCase().endsWith('.exp3.json')) continue;
      const p = join(dir, f);
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, name: basename(f).replace(/\.exp3\.json$/i, '') });
    }
  }
  // 直接放在模型根目录的 exp3（witchX8 这类导出）
  for (const f of await readdir(modelDir)) {
    if (!f.toLowerCase().endsWith('.exp3.json')) continue;
    const p = join(modelDir, f);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, name: basename(f).replace(/\.exp3\.json$/i, '') });
  }
  return out;
}

/**
 * 部件不透明度目标：SDK 不认 PartOpacity 曲线（按参数查索引），必须在运行时自己写。
 * 取曲线数组里最后一个数值——动作末尾的稳态值。
 */
function partTargetsOf(json) {
  const out = {};
  for (const c of json.Curves ?? []) {
    if (c.Target !== 'PartOpacity' || !c.Id) continue;
    const nums = (c.Segments ?? []).filter((x) => typeof x === 'number');
    if (nums.length) out[c.Id] = Math.round(nums[nums.length - 1] * 1000) / 1000;
  }
  return out;
}

// ---------------------------------------------------------------- role 探测
const ROLE_RULES = [
  ['eyeOpen', ['ParamEyeLOpen', 'ParamEyeROpen'], [0, 1], 1],
  ['eyeSmile', ['ParamEyeLSmile', 'ParamEyeRSmile'], [0, 1], 0],
  ['browY', ['ParamBrowLY', 'ParamBrowRY'], [-1, 1], 0],
  ['browAngle', ['ParamBrowLAngle', 'ParamBrowRAngle'], [-1, 1], 0],
  ['mouthOpen', ['ParamMouthOpenY', 'ParamMouthOpen'], [0, 1], 0],
  ['mouthForm', ['ParamMouthForm'], [-1, 1], 0],
  ['cheek', ['ParamCheek'], [0, 1], 0],
  ['eyeBallX', ['ParamEyeBallX'], [-1, 1], 0],
  ['eyeBallY', ['ParamEyeBallY'], [-1, 1], 0],
  ['angleX', ['ParamAngleX'], [-1, 1], 0],
  ['angleY', ['ParamAngleY'], [-1, 1], 0],
  ['angleZ', ['ParamAngleZ'], [-1, 1], 0],
  ['bodyX', ['ParamBodyAngleX'], [-1, 1], 0],
  ['breath', ['ParamBreath'], [0, 1], 0],
  ['step', ['ParamStep', 'ParamLeg'], [0, 1], 0],
  ['armA', ['ParamArmLA', 'ParamArmRA', 'ParamArmLeftA', 'ParamArmRightA'], [-1, 1], 0],
  ['armB', ['ParamArmLB', 'ParamArmRB', 'ParamArmLeftB', 'ParamArmRightB'], [-1, 1], 0],
];

const have = new Set(params);
/** 参数 id 归一化：PARAM_ANGLE_X 和 ParamAngleX 视为同一个。 */
const normId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const normMap = new Map();
for (const id of params) if (!normMap.has(normId(id))) normMap.set(normId(id), id);
const roles = {};
const unmapped = [];
for (const [name, candidates, space, def] of ROLE_RULES) {
  const targets = candidates
    .map((c) => (have.has(c) ? c : normMap.get(normId(c))))
    .filter(Boolean);
  if (targets.length) roles[name] = { targets, space, default: def };
  else if (candidates.some((c) => /^Param/i.test(c))) unmapped.push(name);
}

/** 没映射上的「值得看一眼」的参数，写进 profile.js 的 TODO 注释。 */
const mapped = new Set(Object.values(roles).flatMap((r) => r.targets));
const interesting = params
  .filter((p) => !mapped.has(p) && !/^Param_Angle_Rotation_/.test(p) && /Eye|Brow|Mouth|Arm|Hand|Step|Leg|Cheek/i.test(p))
  .slice(0, 24);

// ---------------------------------------------------------------- 表情配方
// 与 hiyori 相同的语义配方；缺的 role 自动跳过（模型少参数不用改配方）。
const RECIPES = {
  neutral: {},
  happy: { eyeSmile: 1, browY: 0.35, mouthForm: 0.8, cheek: 0.55 },
  wink: { eyeSmile: 0.7, browY: 0.2, mouthForm: 0.4, cheek: 0.25 },
  love: { eyeSmile: 1, browY: 0.3, mouthForm: 0.6, cheek: 0.95 },
  shy: { eyeSmile: 0.35, browY: 0.45, mouthForm: 0.1, cheek: 1 },
  surprised: { browY: 0.8, browAngle: 1, mouthOpen: 0.45, mouthForm: 0.25, cheek: 0.15 },
  angry: { browY: -0.75, browAngle: -1, mouthForm: -0.6, cheek: 0.3 },
  sad: { browY: 0.5, browAngle: -0.4, mouthForm: -0.7, cheek: 0.2 },
  sleepy: { eyeOpen: 0.45, eyeSmile: 0.15, browY: 0.1, mouthForm: 0.05, cheek: 0.2 },
  thinking: { eyeSmile: 0.1, browY: -0.2, mouthForm: -0.15, cheek: 0.1 },
  smug: { eyeSmile: 0.6, browY: -0.25, mouthForm: 0.35, cheek: 0.3 },
  pout: { browY: 0.3, mouthForm: -0.45, cheek: 0.8 },
  worried: { browY: 0.55, browAngle: -0.5, mouthForm: -0.35, cheek: 0.25 },
  determined: { browY: -0.5, browAngle: 0.6, mouthForm: -0.1, cheek: 0.15 },
  flustered: { eyeSmile: 0.2, browY: 0.7, mouthForm: 0.1, cheek: 1 },
  scared: { browY: 0.75, browAngle: 1, mouthOpen: 0.3, mouthForm: -0.5, cheek: 0.2 },
  excited: { eyeSmile: 1, browY: 0.5, mouthForm: 0.6, cheek: 0.6 },
  cry: { browY: 0.6, browAngle: -0.6, mouthForm: -0.75, cheek: 0.5 },
  confused: { eyeSmile: 0.1, browY: 0.25, browAngle: 0.3, mouthForm: -0.2, cheek: 0.15 },
};

const usable = (recipe) => {
  const keys = Object.keys(recipe).filter((k) => roles[k]);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, recipe[k]])) : null;
};
const expressions = {};
for (const [name, recipe] of Object.entries(RECIPES)) {
  const r = usable(recipe);
  if (r) expressions[name] = r;
}

// ---------------------------------------------------------------- 写包
const motions = [];
for (const m of await collectMotions()) {
  let json;
  try { json = await readJson(m.path); }
  catch (e) {
    // 简易模式只借 PartOpacity 做中性部件基线；坏的动作文件不该阻断构建。
    console.warn(`跳过读不出的动作 ${basename(m.path)}：${e.message}`);
    continue;
  }
  const stem = basename(m.path).replace(/\.motion3\.json$/i, '');
  const mid = `m-${slug(stem)}`;   // 前缀避免和表情 id 撞名（vocab id 必须唯一）
  motions.push({
    id: mid,
    stem,
    group: m.group,
    file: `motions/${stem}.js`,
    source: m.path,
    seconds: Math.round(Number(json.Meta?.Duration ?? 0) * 1000) / 1000,
    loop: json.Meta?.Loop ?? m.loop ?? true,
    partOpacity: partTargetsOf(json),
    owns: ownsOf(json),
    raw: json,
  });
}

const idleMotions = motions.filter((m) => /idle/i.test(String(m.group ?? '')));
const expressionFiles = [];
if (!SIMPLE) {
  for (const e of await collectExpressions()) {
    const raw = await readJson(e.path);
    const stem = slug(e.name || basename(e.path).replace(/\.exp3\.json$/i, ''));
    const list = (raw.Parameters ?? [])
      .filter((p) => typeof p?.Id === 'string' && Number.isFinite(Number(p.Value)))
      .map((p) => ({
        id: p.Id,
        value: Number(p.Value),
        blend: p.Blend,
        label: paramMeta.get(p.Id)?.label ?? '',
      }));
    const main = list.find((p) => paramMeta.has(p.id));
    const rawLabel = main ? paramMeta.get(main.id).label : '';
    const label = rawLabel && rawLabel !== e.name ? `${e.name} · ${rawLabel}` : e.name;
    const group = main ? paramMeta.get(main.id).group : '';
    const auto = classifyResource({ name: e.name, label: rawLabel, group, params: list });
    expressionFiles.push({
      id: `exp-${stem}`, name: e.name, stem, file: `expressions/${stem}.js`, raw,
      params: list, label, group, cls: auto.cls, autoCls: auto.cls, why: auto.why,
    });
  }
}

// 原生 exp3 表情：名字正好是 happy/sad… 才自动映射；也接受 eyescry / signangry 这种包含词根的命名
const nativeExpressions = {};
const words = Object.keys(RECIPES);
const ALIAS = { shock: 'surprised', startle: 'surprised', surprise: 'surprised', eyeclose: 'cry', tears: 'cry' };
for (const e of expressionFiles) {
  const key = String(e.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  let word = words.find((w) => w === key || w.replace(/-/g, '') === key);
  if (!word) word = words.find((w) => w.length >= 3 && key.includes(w));
  if (!word) word = Object.entries(ALIAS).find(([k]) => key.includes(k))?.[1];
  if (word && !nativeExpressions[word]) nativeExpressions[word] = e.id;
}

const overrides = OVERRIDES_PATH ? await readJson(OVERRIDES_PATH) : {};
const nativeMap = SIMPLE ? {} : { ...nativeExpressions, ...(overrides.expressions ?? {}) };
const performance = {
  ...(overrides.performance ?? {}),
  tuning: {
    style: 'natural',
    bodyGain: 1.8,
    gain: 1.15,
    accentGain: 0.75,
    ...(overrides.performance?.tuning ?? {}),
  },
};

/* ---- 名片 / 运动：工作台传进来的构建参数 ---- */
const title = model3.Meta?.Name ?? id;
const pickText = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const expressionCount = Object.keys(expressions).length;
const identity = {
  nameZh: pickText(overrides.identity?.nameZh, title),
  nameEn: pickText(overrides.identity?.nameEn, pickText(overrides.identity?.nameZh, title)),
  aboutZh: pickText(overrides.identity?.aboutZh, `一个正面立绘的 Live2D 形象，支持 ${expressionCount} 种底脸表情。`),
  aboutEn: pickText(overrides.identity?.aboutEn, `A front-facing Live2D figure with ${expressionCount} base expressions.`),
  author: pickText(overrides.identity?.author, ''),
  version: pickText(overrides.identity?.version, '1.0.0'),
  credit: pickText(overrides.identity?.credit, ''),
};
// roam = 跟随 Coo 的走动偏好；stand = 固定站定（后端强制 roam off）
const motionSpeed = Math.min(2, Math.max(.5, Number(overrides.motion?.speed) || 1));
const motion = { kind: overrides.motion?.kind === 'stand' ? 'stand' : 'roam', speed: motionSpeed };

/* ---- 资源池：exp3 + 动作，带自动分类和手动覆盖 ---- */
const resources = [
  ...expressionFiles.map((e) => ({
    id: `exp3:${e.file}`, kind: 'exp3', file: e.file, name: e.name,
    label: e.label, group: e.group, params: e.params.length,
    cls: e.cls, autoCls: e.autoCls, why: e.why, custom: false,
  })),
  ...motions.map((m) => ({
    id: `motion:${m.file}`, kind: 'motion', file: m.file, name: m.stem,
    label: m.stem, group: m.group, seconds: m.seconds,
    cls: 'pose', autoCls: 'pose', why: '动作文件', custom: false,
  })),
];
for (const r of resources) {
  const role = overrides.resourceRoles?.[r.file];
  if (role && ['face', 'pose', 'outfit', 'other'].includes(role)) {
    r.cls = role; r.custom = true; r.why = '你手动改了归类';
  }
}

/* ---- 源指纹：只看模型内容，**不含**生成器版本 ----
 * 混进 GENERATOR_VERSION 会让升级转换器把所有手工校准（role 归类 / 取景 / 绑词）一起作废；
 * 生成器版本由 signatureOf() 单独参与过期判断。 */
const sha = (buf) => createHash('sha1').update(buf).digest('hex');
const hashParts = [`model3:${sha(JSON.stringify(model3))}`, `moc3:${sha(await readFile(mocPath))}`];
if (physicsPath) hashParts.push(`physics:${sha(JSON.stringify(await readJson(physicsPath)))}`);
if (cdiPath) hashParts.push(`cdi3:${sha(JSON.stringify(display))}`);
if (posePath) hashParts.push(`pose:${sha(JSON.stringify(await readJson(posePath)))}`);
for (const p of textures) hashParts.push(`tex:${basename(p)}:${sha(await readFile(p))}`);
if (!SIMPLE) for (const e of expressionFiles) hashParts.push(`exp3:${e.file}:${sha(JSON.stringify(e.raw))}`);
if (!SIMPLE) for (const m of motions) hashParts.push(`motion:${m.file}:${sha(JSON.stringify(m.raw))}`);
const sourceHash = sha(hashParts.join('\n'));


const plan = {
  id,
  optionId,
  title,
  identity,
  motion,
  modelDir,
  model3Path,
  mocPath,
  physicsPath,
  posePath,
  cdiPath,
  fit: overrides.fit ?? { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1 },
  textures: textures.map((p) => basename(p)),
  /** 源贴图尺寸 + 缩小后的尺寸（构建后显存估算用） */
  textureSizes: textures.map((p) => {
    const s = pngSize(p);
    if (!s) return null;
    const longest = Math.max(s.w, s.h);
    const k = MAX_TEX > 0 && longest > MAX_TEX ? MAX_TEX / longest : 1;
    return { w: s.w, h: s.h, outW: Math.max(1, Math.round(s.w * k)), outH: Math.max(1, Math.round(s.h * k)) };
  }).filter(Boolean),
  maxTexture: MAX_TEX,
  params: params.length,
  paramsList: params,
  roles: Object.keys(roles),
  roleTable: roles,
  unmapped,
  expressions: Object.keys(expressions),
  recipes: expressions,
  expressionFiles: expressionFiles.map((e) => ({ id: e.id, name: e.name, file: e.file, label: e.label })),
  nativeExpressions: nativeMap,
  resources,
  generatorVersion: GENERATOR_VERSION,
  sourceHash,
  idle: idleMotions.length,
  idleIds: idleMotions.map((m) => m.id),
  pose: Boolean(posePath),
  motions: motions.map((m) => ({ id: m.id, group: m.group, seconds: m.seconds, loop: m.loop, file: m.file })),
  overrides,
  out: OUT,
};
// 简易模式：扫描结果里不暴露原生资源，避免 UI 误以为可以绑定
if (SIMPLE) {
  plan.expressionFiles = [];
  plan.nativeExpressions = {};
  plan.resources = [];
  plan.idle = 0;
  plan.idleIds = [];
  plan.motions = [];
  plan.pose = false;
}

if (DRY || JSON_OUT) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (existsSync(OUT)) {
  const entries = await readdir(OUT);
  if (entries.length && !FORCE) {
    console.error(`输出目录已存在且非空：${OUT}\n换一个 --out，或加 --force 覆盖。`);
    process.exit(1);
  }
}
if (!SIMPLE) await mkdir(join(OUT, 'models', id, 'motions'), { recursive: true });
await mkdir(join(OUT, 'models', id, 'textures'), { recursive: true });

// 1) moc3 → base64 模块
await writeFile(
  join(OUT, 'models', id, 'moc3.js'),
  `// ${basename(mocPath)}（base64：沙箱里不能 fetch 二进制）\nexport default "${(await readFile(mocPath)).toString('base64')}";\n`,
  'utf8',
);

// 2) model3 / physics / cdi3 → JS 模块
await writeFile(join(OUT, 'models', id, 'model3.js'),
  `export default ${JSON.stringify(model3)};\n`, 'utf8');
if (physicsPath) {
  await writeFile(join(OUT, 'models', id, 'physics.js'),
    `export default ${JSON.stringify(await readJson(physicsPath))};\n`, 'utf8');
}
if (cdiPath) {
  await writeFile(join(OUT, 'models', id, 'cdi3.js'),
    `export default ${JSON.stringify(display)};\n`, 'utf8');
}
if (!SIMPLE && posePath) {
  await writeFile(join(OUT, 'models', id, 'pose.js'),
    `export default ${JSON.stringify(await readJson(posePath))};\n`, 'utf8');
}
if (!SIMPLE && expressionFiles.length) {
  await mkdir(join(OUT, 'models', id, 'expressions'), { recursive: true });
  for (const e of expressionFiles) {
    await writeFile(join(OUT, 'models', id, e.file),
      `// ${e.name}（exp3）：原生表情，由 profile.expressions 映射到词\nexport default ${JSON.stringify(e.raw)};\n`, 'utf8');
  }
}

// 3) 贴图（平铺到 textures/）
const textureFiles = [];
for (const [i, p] of textures.entries()) {
  const name = `texture_${String(i).padStart(2, '0')}${extname(p).toLowerCase() || '.png'}`;
  await copyFile(p, join(OUT, 'models', id, 'textures', name));
  textureFiles.push(`textures/${name}`);
}

// 3.5) 贴图降采样：只动 OUT 里的副本，源模型一个字节都不改。
// 没有 Pillow 也不阻断构建——运行时会兜底（backends/live2d.js 里超过 maxTex 再缩）。
let textureShrink = null;
if (MAX_TEX > 0 && textureFiles.some((f) => f.toLowerCase().endsWith('.png'))) {
  const texDir = join(OUT, 'models', id, 'textures');
  const script = join(HERE, 'shrink-textures.py');
  const r = spawnSync('python', [script, '--dir', texDir, '--max', String(MAX_TEX), '--json'], {
    encoding: 'utf8',
    timeout: 180000,
  });
  if (r.status === 0 && r.stdout) {
    try { textureShrink = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { textureShrink = null; }
    if (textureShrink?.files?.length) {
      console.log(`  贴图降采样：${textureShrink.files.length} 张 → 最长边 ${MAX_TEX}（${fmtMB(textureShrink.bytesBefore)} → ${fmtMB(textureShrink.bytesAfter)}）`);
    } else if (textureShrink) {
      console.log(`  贴图：都在 ${MAX_TEX} 以内，未改动`);
    }
  } else {
    const why = String(r.stderr || r.error?.message || 'python 不可用').trim().split('\n').pop();
    console.warn(`  贴图降采样失败，保留原尺寸：${why}`);
    textureShrink = { ok: false, error: why.slice(0, 200) };
  }
}

// 4) 动作
for (const m of (SIMPLE ? [] : motions)) {
  await writeFile(
    join(OUT, 'models', id, 'motions', `${m.stem}.js`),
    `// ${m.stem}.motion3.json（${m.seconds}s）base64\nexport default "${Buffer.from(JSON.stringify(m.raw)).toString('base64')}";\n`,
    'utf8',
  );
}

// 5) profile.js（草稿 + TODO）
const todo = [];
if (unmapped.length) todo.push(`没映射上的 role：${unmapped.join(', ')}`);
if (interesting.length) todo.push(`值得看一眼的参数：${interesting.join(', ')}`);
if (!textures.length) todo.push('没有找到贴图（model3.json 的 FileReferences.Textures）');
if (!physicsPath) todo.push('这个模型没有 physics（物理通道会自动跳过）');
if (!SIMPLE && !motions.length) todo.push('没有动作：vocab 只有表情 + kit 自带动作');
if (!SIMPLE && expressionFiles.length && !Object.keys(nativeExpressions).length) {
  todo.push(`原生表情未映射：在 profile.expressions 里把词映射到 ${expressionFiles.map((e) => e.id).join(' / ')}`);
}
if (!SIMPLE && idleMotions.length) todo.push(`原生 Idle 动作 ${idleMotions.length} 段：运行时自动循环，不用写词`);
if (!SIMPLE && posePath) todo.push('有 pose3：已随包加载，换装/手臂分组由它接管');
todo.push('extent 由运行时实测（贴图就绪第 3 帧读 alpha 包围盒）；只有实测不准时才在 profile.extent 覆盖');

const profileJs = `/**
 * ${id} 的模型数据（tools/convert.mjs 生成的草稿）。
 *
 * 格式与运行时约定见 README「数据驱动」一节：
 *   role = 语义位 → targets 是真实参数；模型没有的参数自动跳过
 *   space/default 是语义输入，真实取值范围从 moc3 读（不要写进这里）
 *
 * TODO（人工过一遍）：
${todo.length ? todo.map((t) => ` *   - ${t}`).join('\n') : ' *   - 无'}
 */
export default {
${overrides.fit ? `  fit: ${JSON.stringify(overrides.fit)},` : "  fit: { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1 },"}
  // roam：跟随 Coo 的走动偏好；stand：固定站定（后端强制 roam off）
  motion: ${JSON.stringify(motion)},
${overrides.extent ? `  extent: ${JSON.stringify(overrides.extent)},` : ''}
${overrides.anchors ? `  anchors: ${JSON.stringify(overrides.anchors)},` : ''}
  // 简易模式不播 motion，但 motion 里的 PartOpacity 是“中性姿势”的一部分：
  // 少了它，hiyori 这类模型会同时显示 PartArmA / PartArmB（四只手）。
  parts: { base: ${JSON.stringify(guessBaseParts(motions))} },
  roles: {
${Object.entries(roles).map(([n, r]) => `    ${n}: ${JSON.stringify(r)},`).join('\n')}
  },
  expression: {
${Object.entries(expressions).map(([n, r]) => `    ${n}: ${JSON.stringify(r)},`).join('\n')}
  },
${!SIMPLE && Object.keys(nativeMap).length
    ? `  // 原生 exp3 表情：词 → expressions/ 里的文件 id\n  expressions: ${JSON.stringify(nativeMap, null, 2)},\n`
    : ''}  // 表演层（SoulLink）：情绪词 → 连续参数。不写就用通用默认；
  // 换模型先调这里（强度/过渡），不要改 backends/ 里的渲染代码。
  performance: ${JSON.stringify(performance, null, 2)},
};
`;
await writeFile(join(OUT, 'models', id, 'profile.js'), profileJs, 'utf8');

/** 常驻部件基线：动作里出现过几次就用出现最多的那套（全 0/1 时取动作末尾值）。 */
function guessBaseParts(list) {
  const tally = {};
  for (const m of list) {
    for (const [part, v] of Object.entries(m.partOpacity ?? {})) {
      tally[part] ??= { 0: 0, 1: 0 };
      tally[part][v >= 0.5 ? 1 : 0] += 1;
    }
  }
  const out = {};
  for (const [part, t] of Object.entries(tally)) out[part] = t[1] >= t[0] ? 1 : 0;
  return out;
}

// 6) models/index.js
const registry = {
  [optionId]: {
    id,
    model: 'model3.js',
    moc: 'moc3.js',
    ...(physicsPath ? { physics: 'physics.js' } : {}),
    ...(!SIMPLE && posePath ? { pose: 'pose.js' } : {}),
    ...(!SIMPLE && idleMotions.length
      ? { idle: idleMotions.map((m) => ({ id: m.id, file: m.file, duration: m.seconds })) }
      : {}),
    ...(!SIMPLE && expressionFiles.length
      ? { expressions: expressionFiles.map((e) => ({ id: e.id, name: e.name, file: e.file })) }
      : {}),
    textures: textureFiles,
    motions: SIMPLE ? [] : motions.map(({ id: mid, file, seconds, loop, partOpacity }) => ({ id: mid, file, duration: seconds, loop, partOpacity })),
  },
};
await writeFile(join(OUT, 'models', 'index.js'),
  `// 由 tools/convert.mjs 生成；换模型只改这里和 models/<id>/profile.js\nexport const models = ${JSON.stringify(registry, null, 2)};\n`,
  'utf8');

// 7) 运行时代码（从 --runtime 复制，保持新包自包含）
for (const rel of ['figure.js', 'backends/live2d.js', 'backends/soullink.js']) {
  const src = join(RUNTIME, rel);
  if (!existsSync(src)) {
    console.warn(`跳过（--runtime 里没有）：${rel}`);
    continue;
  }
  await mkdir(dirname(join(OUT, rel)), { recursive: true });
  await copyFile(src, join(OUT, rel));
}
for (const rel of await readdir(join(RUNTIME, 'sdk'))) {
  const src = join(RUNTIME, 'sdk', rel);
  if ((await stat(src)).isFile()) {
    await mkdir(join(OUT, 'sdk'), { recursive: true });
    await copyFile(src, join(OUT, 'sdk', rel));
  }
}
// SoulLink 表演引擎（Apache-2.0，随包分发，含许可证）
const vendorDir = join(RUNTIME, 'vendor', 'soullink');
if (existsSync(vendorDir)) {
  for (const rel of await readdir(vendorDir)) {
    const src = join(vendorDir, rel);
    if (!(await stat(src)).isFile()) continue;
    await mkdir(join(OUT, 'vendor', 'soullink'), { recursive: true });
    await copyFile(src, join(OUT, 'vendor', 'soullink', rel));
  }
} else {
  console.warn('跳过（--runtime 里没有）：vendor/soullink');
}

// 许可文件：包里跑着三块代码，各自的许可一起带上（AGPL 要求附许可并提供源码）
const agplPath = resolve(RUNTIME, '..', 'LICENSE');
if (existsSync(agplPath)) {
  await copyFile(agplPath, join(OUT, 'LICENSE'));
} else {
  console.warn('跳过（--runtime 的上一级没有 LICENSE）');
}
await writeFile(join(OUT, 'LICENSES.txt'), `本形象包 / This figure pack
========================================

包里运行着三块代码，各自许可如下。
The files in this pack come from three sources, each under its own license.

1. figure.js、backends/
   Live2D 简易工作台 / Live2D Simple Workbench
   GNU Affero General Public License v3.0 or later
   完整文本：同目录 LICENSE
   源码：https://github.com/as124da1231/live2d-simple-workbench
   Copyright (C) 2026 as124da1231

2. sdk/
   Live2D Cubism SDK for Web（framework.js、shaders.js）
     Live2D Open Software License
     完整文本：sdk/LICENSE-live2d-components.txt
   Live2D Cubism Core（live2dcubismcore.min.js）
     Live2D Proprietary Software License
     完整文本：sdk/LICENSE-live2d-core.txt
   Copyright (C) Live2D Inc.
   Core 属于该许可第 5 条的 Redistributable Code，原样分发，未做修改。

3. vendor/soullink/
   SoulLink Emotion Engine 0.2.0-beta.1
   Apache License 2.0
   完整文本：vendor/soullink/LICENSE
   Copyright 2026 Soullink Emotion contributors

模型、贴图、moc3 由使用者自行提供，不在上述许可范围内，版权归原作者所有。
Models, textures and moc3 files are supplied by the user and are not covered
by these licenses.
`, 'utf8');

// 8) figure.json（vocab 按实际存在的 role / 动作生成）
// 注意 verify-pack 的硬规则：词名（所有语言）与 id 必须全局唯一，且不能含空格/逗号；表情也要 seconds。
const LABELS = {
  neutral: ['平静', 'Neutral'], happy: ['开心', 'Happy'], wink: ['眨眼', 'Wink'],
  love: ['喜欢', 'Love'], shy: ['害羞', 'Shy'], surprised: ['惊讶', 'Surprised'],
  angry: ['生气', 'Angry'], sad: ['难过', 'Sad'], sleepy: ['困倦', 'Sleepy'],
  thinking: ['思考', 'Thinking'], smug: ['得意', 'Smug'], pout: ['嘟嘴', 'Pout'],
  worried: ['担心', 'Worried'], determined: ['坚定', 'Determined'],
  flustered: ['慌张', 'Flustered'], scared: ['害怕', 'Scared'],
  excited: ['兴奋', 'Excited'], cry: ['哭', 'Cry'], confused: ['困惑', 'Confused'],
};
const vocabExpressions = Object.keys(expressions).map((n, i) => {
  const [zh, en] = LABELS[n] ?? [`表情${i + 1}`, `Expression${i + 1}`];
  return {
    id: n, kind: 'expression', names: { zh: [zh], en: [en] },
    about: { zh: `${zh}的表情`, en: `${en} expression` }, seconds: 0.9,
  };
});
const gestureMotions = motions.filter((m) => !/idle/i.test(String(m.group ?? '')));
const vocabMotions = (gestureMotions.length ? gestureMotions : motions).slice(0, 3).map((m, i) => ({
  id: m.id, kind: 'motion',
  names: { zh: [`动作${i + 1}`], en: [`Motion${i + 1}`] },
  about: { zh: `${m.seconds} 秒的预设动作`, en: `a ${m.seconds}s preset motion` },
  seconds: m.seconds,
}));
if (SIMPLE) vocabMotions.length = 0;
const figureJson = {
  manifest: 2,
  api: 2,
  id,
  version: identity.version,
  name: { zh: identity.nameZh, en: identity.nameEn },
  about: { zh: identity.aboutZh, en: identity.aboutEn },
  ...(identity.author ? { author: identity.author } : {}),
  ...(identity.credit ? { credits: [{ role: '形象', name: identity.credit }] } : {}),
  license: '仅供个人测试，请遵守模型自身的授权',
  entry: 'figure.js',
  export: 'createFigureBody',
  thumb: `models/${id}/${textureFiles[0]}`,
  axes: [{ id: 'model', name: { zh: '模型', en: 'Model' }, options: [{ id: optionId, name: { zh: identity.nameZh, en: identity.nameEn }, thumb: `models/${id}/${textureFiles[0]}` }] }],
  presets: [],
  vocab: [...vocabExpressions, ...(SIMPLE ? [] : vocabMotions)],
  sounds: {},
  can: { walk: motion.kind === 'roam' },
};
await writeFile(join(OUT, 'figure.json'), JSON.stringify(figureJson, null, 2) + '\n', 'utf8');
await writeFile(join(OUT, 'build.json'), JSON.stringify({
  tool: 'cortico-live2d-pack',
  generatorVersion: GENERATOR_VERSION,
  sourceHash,
  at: new Date().toISOString(),
  maxTexture: MAX_TEX,
  ...(textureShrink ? { textureShrink } : {}),
  resourceRoles: Object.fromEntries(resources.filter((r) => r.custom).map((r) => [r.file, r.cls])),
}, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------- 报告
console.log(`模型 ${basename(modelDir)} → ${OUT}`);
console.log(`  参数 ${params.length}  role 命中 ${Object.keys(roles).length}/${ROLE_RULES.length}  贴图 ${textureFiles.length}  动作 ${motions.length}`);
console.log(`  原生：Idle ${idleMotions.length} 段  表情 ${expressionFiles.length} 个  pose3 ${posePath ? '有' : '无'}`);
console.log(`  role: ${Object.keys(roles).join(', ') || '（无）'}`);
if (todo.length) console.log('  TODO:\n' + todo.map((t) => '    - ' + t).join('\n'));
console.log(`  vocab: 表情 ${vocabExpressions.length} + 动作 ${vocabMotions.length}`);
console.log('下一步：verify-pack 校验 → live2d-harness 出图看姿势 → 人工补 profile.js 的 TODO');
