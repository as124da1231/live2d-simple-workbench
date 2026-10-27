/**
 * Live2D 工作台（本地服务，无依赖）。
 *
 * 职责只有三件：
 *   1. 扫描模型目录（复用 tools/convert.mjs --json）
 *   2. 构建成形象包（复用 convert.mjs，支持 overrides）
 *   3. 提供预览页（用真实的 kit + 包内渲染内核）
 *
 * 不碰 Coopanion 本体、不碰直播。安装只是复制到 figures/。
 *
 * 用法：
 *   node tools/workbench/server.mjs [--port 4700] [--kit <Coopanion web 目录>]
 */
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CONVERT = join(ROOT, 'tools', 'convert.mjs');
const WORK = join(ROOT, '.workbench');
const CURRENT = join(WORK, 'current');
const WORKBENCH_CONFIG = join(ROOT, 'workbench.config.json');
const rolesPath = (hash) => join(WORK, 'roles', `${hash || 'unknown'}.json`);
const overridesPath = (hash) => join(WORK, 'overrides', `${hash || 'unknown'}.json`);

async function readRoles(hash) {
  try { return JSON.parse(await readFile(rolesPath(hash), 'utf8')); }
  catch { return {}; }
}

async function saveRoles(hash, map) {
  await mkdir(join(WORK, 'roles'), { recursive: true });
  await writeFile(rolesPath(hash), JSON.stringify(map ?? {}, null, 2), 'utf8');
}

/**
 * 构建参数（取景 / 绑定的 exp3 / 锚点 / 表演调参 / 包 id）按源指纹落盘。
 * 之前只存在内存和构建产物里：重启工作台、或构建目录被滚动清掉，调了半天全丢。
 */
async function readOverrides(hash) {
  try { return JSON.parse(await readFile(overridesPath(hash), 'utf8')); }
  catch { return {}; }
}

async function saveOverrides(hash, ov) {
  if (!hash) return;
  await mkdir(join(WORK, 'overrides'), { recursive: true });
  await writeFile(overridesPath(hash), JSON.stringify(ov ?? {}, null, 2), 'utf8');
}

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', '4700')) || 4700;
let actualPort = PORT;
const OPEN = argv.includes('--open');
const NO_COO = argv.includes('--no-coo');
const KIT = resolve(arg('kit', join(ROOT, 'vendor', 'coo-kit')));

/* ---------------- Coo 目录：检测 / 记住 ---------------- */

function readWorkbenchConfig() {
  try {
    return JSON.parse(readFileSync(WORKBENCH_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 把用户选的目录（Coopanion 根目录 / data / data/home / companion / figures）归一成可用的 figures + config。 */
function resolveCoo(dir) {
  if (!dir) return null;
  const picked = resolve(String(dir));
  const candidates = [
    // Coopanion 安装根目录
    { root: picked, companion: join(picked, 'data', 'home', 'companion') },
    // 已经选到了 companion
    { root: picked, companion: picked },
    // 选到了 data 或 home
    { root: picked, companion: join(picked, 'home', 'companion') },
    { root: picked, companion: join(picked, 'companion') },
    // 选到了 companion/data/figures
    { root: picked, companion: resolve(picked, '..', '..') },
  ];
  for (const c of candidates) {
    if (!existsSync(c.companion)) continue;
    const data = join(c.companion, 'data');
    const config = join(c.companion, 'config.json');
    if (existsSync(config) || existsSync(data)) {
      return {
        connected: true,
        cooDir: c.root,
        companion: c.companion,
        figures: join(data, 'figures'),
        config,
      };
    }
  }
  return null;
}

function autoDetectCoo() {
  const env = process.env;
  const dirs = [
    'C:/Coopanion',
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Coopanion'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Coopanion'),
    env.APPDATA && join(env.APPDATA, 'Coopanion'),
    env.ProgramFiles && join(env.ProgramFiles, 'Coopanion'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Coopanion'),
  ].filter(Boolean);
  for (const dir of dirs) {
    const found = resolveCoo(dir);
    if (found) return found;
  }
  return null;
}

function saveWorkbenchConfig(coo) {
  if (!coo?.connected) return false;
  try {
    writeFileSync(WORKBENCH_CONFIG, JSON.stringify({
      cooDir: coo.cooDir ?? null,
      companion: coo.companion ?? null,
      figures: coo.figures ?? null,
      config: coo.config ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

const cliCoo = arg('coo', '');
const cliFigures = arg('figures', '');
const cliConfig = arg('config', '');
const savedConfig = readWorkbenchConfig();

let coo = null;
if (cliCoo) coo = resolveCoo(cliCoo);
if (!coo && savedConfig?.cooDir) coo = resolveCoo(savedConfig.cooDir);
if (!coo && savedConfig?.figures && existsSync(savedConfig.figures)) {
  coo = {
    connected: true,
    cooDir: savedConfig.cooDir ?? null,
    companion: savedConfig.companion ?? null,
    figures: resolve(savedConfig.figures),
    config: savedConfig.config ? resolve(savedConfig.config) : null,
  };
}
if (!coo) coo = autoDetectCoo();
if (NO_COO) coo = null;
if (!coo) coo = { connected: false, cooDir: null, companion: null, figures: null, config: null };
if (cliFigures) { coo = { ...coo, connected: true, figures: resolve(cliFigures) }; }
if (cliConfig) { coo = { ...coo, config: resolve(cliConfig) }; }

let FIGURES = coo.connected ? (coo.figures ?? null) : null;
let CONFIG = coo.connected ? (coo.config ?? null) : null;
// 自动检测到 Coo、但还没配置文件：直接记住，下次不用再猜。保存失败只影响记忆，不影响本次使用。
if (!savedConfig && coo.connected) saveWorkbenchConfig(coo);

function cooView() {
  return {
    connected: !!(coo?.connected && FIGURES),
    dir: coo?.cooDir ?? null,
    companion: coo?.companion ?? null,
    figures: FIGURES,
    config: CONFIG,
    configFile: WORKBENCH_CONFIG,
    saved: existsSync(WORKBENCH_CONFIG),
  };
}

if (!existsSync(join(KIT, 'kit', 'body.js'))) {
  console.error('找不到 Coopanion 的 kit：', join(KIT, 'kit', 'body.js'));
  console.error('用 --kit 指定 cortico-world-desktop-pet/web 目录。');
  process.exit(1);
}

/** 简易模式：不绑定任何原生资源，构建时强制清空 expressions / resourceRoles。 */
const SIMPLE = true;

let state = {
  modelDir: '',
  plan: null,
  packDir: null,
  buildDir: null,
  built: null,
  words: [],
  lastOverrides: {},
};
let buildToken = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** 跑一个 node 子进程（转换器）。 */
function runNode(args) {
  return new Promise((ok, bad) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', bad);
    p.on('close', (code) => {
      if (code === 0) ok({ out, err });
      else bad(new Error((err || out || `退出码 ${code}`).trim()));
    });
  });
}

const json = (res, code, value) => {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) throw new Error('请求过大');
  }
  return raw ? JSON.parse(raw) : {};
}

/** Windows 文件夹选择框；取消时返回 null。 */
function pickFolder(description) {
  return new Promise((ok, bad) => {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${String(description).replace(/'/g, "''")}'`,
      '$d.ShowNewFolderButton = $false',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', bad);
    p.on('close', (code) => {
      if (code === 0) return ok(out.trim() || null);
      return bad(new Error((err || `powershell exit ${code}`).trim().slice(0, 300)));
    });
  });
}

const sha = (s) => createHash('sha1').update(s).digest('hex');
const signatureOf = (plan, overrides) => sha(JSON.stringify({
  gen: plan?.generatorVersion ?? '',
  source: plan?.sourceHash ?? '',
  overrides: overrides ?? {},
}));

/** 打包前检查：block 修不好 / warn 能打但不理想 / ok / info。 */
function checksOf(plan) {
  const items = [];
  const add = (id, label, level, detail = '') => items.push({ id, label, level, detail });
  if (!plan) {
    add('model', '模型源', 'block', '先扫描模型');
    return { level: 'block', items };
  }
  const modelOk = existsSync(plan.model3Path) && existsSync(plan.mocPath);
  add('model', '模型文件', modelOk ? 'ok' : 'block', modelOk ? 'model3 / moc3 正常' : 'model3 或 moc3 不存在');

  const roles = plan.roles ?? [];
  add('roles', 'role 覆盖', roles.length >= 8 ? 'ok' : roles.length >= 4 ? 'warn' : 'block',
    `${roles.length} 个${roles.length ? '：' + roles.join(', ') : ''}`);

  if (plan.unmapped?.length) add('unmapped', '未映射参数', 'warn', plan.unmapped.join(', '));

  add('motions', '动作', plan.motions?.length ? 'ok' : 'warn',
    plan.motions?.length ? `${plan.motions.length} 段（Idle ${plan.idle || 0}）` : '没有动作，只能用 kit 动作');

  add('idle', '原生 Idle', plan.idle ? 'ok' : 'info',
    plan.idle ? `${plan.idle} 段` : '没有 Idle 组，用 SoulLink 待机');

  if (plan.expressionFiles?.length) {
    const mapped = Object.values(plan.nativeExpressions ?? {}).filter(Boolean).length;
    add('exp3map', 'exp3 映射', mapped ? 'ok' : 'warn',
      mapped ? `${mapped}/${plan.expressionFiles.length} 已映射` : `${plan.expressionFiles.length} 个未映射，仍用通用配方`);
  }

  const tex = plan.textureSizes ?? [];
  const vram = tex.reduce((n, t) => n + t.outW * t.outH * 4, 0);
  const biggest = tex.reduce((n, t) => Math.max(n, Math.max(t.outW, t.outH)), 0);
  add('textures', '贴图', plan.textures?.length ? 'ok' : 'block',
    `${plan.textures?.length ?? 0} 张${biggest ? ` · 最长边 ${biggest}` : ''}${vram ? ` · 显存约 ${(vram / 1048576).toFixed(0)} MB` : ''}`);
  if (vram > 512 * 1048576) {
    add('vram', '显存偏大', 'warn', `贴图解码后约 ${(vram / 1073741824).toFixed(1)} GB；桌宠实际只占 200 px 高，建议把最长边压到 2048`);
  }
  if (plan.maxTexture === 0) add('notexturelimit', '贴图未限尺寸', 'warn', '本次构建没有降采样（--max-texture 0）');
  if (plan.pose) add('pose', 'pose3', 'ok', '已包含');

  const level = items.some((i) => i.level === 'block') ? 'block'
    : items.some((i) => i.level === 'warn') ? 'warn' : 'ok';
  return { level, items };
}

function stateView() {
  if (state.packDir && !existsSync(state.packDir)) {
    state.packDir = null;
    state.built = null;
  }
  const plan = state.plan;
  const stale = Boolean(plan && state.built && signatureOf(plan, state.lastOverrides) !== state.built.signature);
  const checks = checksOf(plan);
  if (SIMPLE) {
    // 简易模式不把原生资源当校验项，避免“未绑 exp3”这种噪音
    checks.items = checks.items.filter((i) => !['motions', 'idle', 'exp3map', 'pose'].includes(i.id));
    checks.items.unshift({ id: 'mode', label: '模式', level: 'ok', detail: '简易模式：底脸 + 通用配方，不绑定 exp3 / pose；motion 只读 PartOpacity' });
    const has = (lv) => checks.items.some((i) => i.level === lv);
    checks.level = has('block') ? 'block' : has('warn') ? 'warn' : 'ok';
  }
  // 把 Coo 侧预检并进「校验」页：装之前就能看到 Coo 会不会拒
  const pf = state.preflight;
  if (pf) {
    for (const f of pf.fatal ?? []) checks.items.push({ id: 'preflight', label: 'Coo 预检', level: 'block', detail: f });
    for (const w of pf.warn ?? []) checks.items.push({ id: 'preflight', label: 'Coo 预检', level: 'warn', detail: w });
    const has = (lv) => checks.items.some((i) => i.level === lv);
    checks.level = has('block') ? 'block' : has('warn') ? 'warn' : 'ok';
  }
  return { ...state, coo: cooView(), checks, stale };
}

async function scan(dir) {
  if (!dir || !existsSync(dir)) throw new Error('目录不存在：' + dir);
  const { out } = await runNode([CONVERT, '--model', dir, '--json']);
  const start = out.indexOf('{');
  if (start < 0) throw new Error('转换器没有返回 JSON');
  const plan = JSON.parse(out.slice(start));
  const saved = await readRoles(plan.sourceHash);
  plan.resourceRoles = SIMPLE ? {} : saved;
  for (const r of plan.resources ?? []) {
    const role = saved[r.file];
    if (!SIMPLE && role && ['face', 'pose', 'outfit', 'other'].includes(role)) {
      r.cls = role; r.custom = true; r.why = '手动改了归类';
    }
  }
  // 只读回取景/锚点；简易模式不读绑定
  const savedOvRaw = await readOverrides(plan.sourceHash);
  const savedOv = SIMPLE
    ? Object.fromEntries(Object.entries(savedOvRaw).filter(([k]) => ['fit', 'extent', 'anchors', 'motion', 'identity'].includes(k)))
    : savedOvRaw;
  if (savedOv.fit) plan.fit = { ...(plan.fit ?? {}), ...savedOv.fit };
  if (savedOv.motion) {
    plan.motion = {
      kind: savedOv.motion.kind === 'stand' ? 'stand' : 'roam',
      speed: Math.min(2, Math.max(.5, Number(savedOv.motion.speed) || 1)),
    };
  }
  if (savedOv.identity) plan.identity = { ...(plan.identity ?? {}), ...savedOv.identity };
  state = {
    modelDir: dir, plan, packDir: null, buildDir: null, built: null, words: [],
    lastOverrides: {},
    savedOverrides: Object.keys(savedOv).length ? savedOv : null,
  };
  return stateView();
}

async function build({ id, overrides }) {
  if (!state.plan) throw new Error('先扫描模型');
  const plan = state.plan;
  const modelDir = state.modelDir;
  // 保存的参数打底，本次 UI 的覆盖；两者都按字段合并，避免只改一项就把别的冲掉
  const savedOv = await readOverrides(plan.sourceHash);
  const next = overrides ?? {};
  const frozen = {
    ...savedOv,
    ...next,
    fit: { ...(savedOv.fit ?? {}), ...(next.fit ?? {}) },
    motion: { ...(savedOv.motion ?? {}), ...(next.motion ?? {}) },
    identity: { ...(savedOv.identity ?? {}), ...(next.identity ?? {}) },
    performance: {
      ...(savedOv.performance ?? {}),
      ...(next.performance ?? {}),
      tuning: { ...(savedOv.performance?.tuning ?? {}), ...(next.performance?.tuning ?? {}) },
    },
    expressions: SIMPLE ? {} : { ...(savedOv.expressions ?? {}), ...(next.expressions ?? {}) },
    resourceRoles: SIMPLE ? {} : { ...(savedOv.resourceRoles ?? {}), ...(next.resourceRoles ?? {}) },
  };
  // 空对象没有意义，别写进 profile / overrides
  if (!Object.keys(frozen.motion).length) delete frozen.motion;
  if (!Object.keys(frozen.identity).length) delete frozen.identity;
  if (!Object.keys(frozen.performance.tuning).length) {
    const rest = { ...frozen.performance };
    delete rest.tuning;
    if (!Object.keys(rest).length) delete frozen.performance;
  }
  for (const k of ['expressions', 'resourceRoles']) {
    if (!Object.keys(frozen[k]).length) delete frozen[k];
  }
  const safeId = String(id || plan.id || 'model').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'model';
  const token = ++buildToken;
  await mkdir(join(WORK, 'builds'), { recursive: true });
  const outDir = join(WORK, 'builds', `${safeId}-${Date.now()}`);
  const overrideFile = join(WORK, `overrides-${Date.now()}.json`);
  await writeFile(overrideFile, JSON.stringify(frozen, null, 2), 'utf8');
  try {
    await runNode([
      CONVERT,
      '--model', modelDir,
      '--id', safeId,
      '--out', outDir,
      '--force',
      '--overrides', overrideFile,
    ]);
  } finally {
    // 只是给 convert 的临时入参，构建完就删，别在 .workbench 里堆几十个
    await rm(overrideFile, { force: true }).catch(() => {});
  }
  const manifest = JSON.parse(await readFile(join(outDir, 'figure.json'), 'utf8'));
  const mergedRoles = SIMPLE ? {} : { ...(await readRoles(plan.sourceHash)), ...(frozen.resourceRoles ?? {}) };
  if (!SIMPLE && Object.keys(mergedRoles).length) await saveRoles(plan.sourceHash, mergedRoles);
  plan.resourceRoles = mergedRoles;
  // 落盘：下次扫描同一模型（sourceHash 相同）自动读回，不再每次重调
  if (Object.keys(mergedRoles).length) frozen.resourceRoles = mergedRoles;
  else delete frozen.resourceRoles;
  frozen.id = safeId;
  await saveOverrides(plan.sourceHash, frozen);
  // 本次构建的值立刻反映到 /api/state，不刷新页面也能看到新名片 / 运动
  plan.fit = { ...(plan.fit ?? {}), ...(frozen.fit ?? {}) };
  plan.motion = { ...(plan.motion ?? {}), ...(frozen.motion ?? {}) };
  plan.identity = { ...(plan.identity ?? {}), ...(frozen.identity ?? {}) };
  const built = {
    id: safeId,
    signature: signatureOf(plan, frozen),
    sourceHash: plan.sourceHash ?? '',
    generatorVersion: plan.generatorVersion ?? '',
    at: new Date().toISOString(),
    words: (manifest.vocab ?? []).map((v) => v.id),
  };
  const preflightReport = await preflight(outDir, safeId);
  if (token === buildToken) {
    state.packDir = outDir;
    state.buildDir = outDir;
    state.built = built;
    state.words = built.words;
    state.lastOverrides = frozen;
    state.preflight = preflightReport;
  }
  // 只留最近 4 个构建（按修改时间，不按名字）
  const names = (await readdir(join(WORK, 'builds'))).filter((n) => n !== '.' && n !== '..');
  const entries = await Promise.all(names.map(async (n) => {
    try { return { n, t: (await stat(join(WORK, 'builds', n))).mtimeMs }; }
    catch { return { n, t: 0 }; }
  }));
  entries.sort((a, b) => a.t - b.t);
  for (const old of entries.slice(0, Math.max(0, entries.length - 4))) {
    await rm(join(WORK, 'builds', old.n), { recursive: true, force: true });
  }
  return { id: safeId, words: built.words, packDir: outDir, checks: stateView().checks, stale: false };
}

/**
 * 安装前预检：照 Coo 的 packs.ts 规则把包装一遍。
 * Coo 是「有一处不合法就整包不加载，只往 core.log 写一行」，用户看到的是「形象没了」。
 * 这里提前把能查的都查出来，别让坏包落地。
 */
const ID_RX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OPTION_ID_RX = /^[a-z0-9]{1,24}$/;
const NAME_BREAK = /[,，、\s【】<>＜＞]/;
const insidePath = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/')
  && !p.split(/[\\/]/).includes('..') && !/^[a-z]+:/i.test(p) && !/[<>"\x00-\x1f]/.test(p);
/** Coo 的 namesOf：{zh: "文本", en: "text"} —— 值必须是字符串 */
const namesOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, s] of Object.entries(v)) if (typeof s === 'string' && s.trim()) out[k] = s.trim();
  return Object.keys(out).length ? out : null;
};
/** 词表专用：names 是 {zh: ["开心"], en: ["Happy"]} —— 值是字符串数组 */
const wordNamesOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, list] of Object.entries(v)) {
    if (!Array.isArray(list) || !list.length) return null;
    if (!list.every((n) => typeof n === 'string' && n.trim())) return null;
    out[k] = list;
  }
  return Object.keys(out).length ? out : null;
};

async function preflight(dir, expectedId) {
  const fatal = [];
  const warn = [];
  let m;
  try { m = JSON.parse(await readFile(join(dir, 'figure.json'), 'utf8')); }
  catch (e) { return { fatal: [`figure.json 读不出来：${e.message}`], warn }; }

  if (m.manifest !== 2 || m.api !== 2) fatal.push(`manifest/api 必须是 2（现在是 ${m.manifest}/${m.api}）`);
  if (m.id !== expectedId) fatal.push(`包 id「${m.id}」和安装目录名「${expectedId}」不一致`);
  if (typeof m.id !== 'string' || !ID_RX.test(m.id)) fatal.push(`id 不合法：${JSON.stringify(m.id)}（只能小写字母数字和 -，最长 32）`);
  if (m.id === 'coo') fatal.push('id 不能叫 coo（内置形象）');
  if (!namesOf(m.name)) fatal.push('缺少 name');
  if (!namesOf(m.about)) fatal.push('缺少 about');
  // 形象名 / 一句话不是词表名，可以带空格、逗号、括号；Coo 只按普通文本显示。
  // 这里只拦控制字符和会被当成 HTML/标记的字符，并给出长度提醒。
  for (const [k, s] of Object.entries(namesOf(m.name) ?? {})) {
    if (/[\x00-\x1f]/.test(s)) fatal.push(`name.${k} 含控制字符`);
    if (s.length > 40) warn.push(`name.${k} 偏长（${s.length} 字）`);
  }
  for (const [k, s] of Object.entries(namesOf(m.about) ?? {})) {
    if (/[<>"]/.test(s)) warn.push(`about.${k} 含 < > " 字符，提示词/页面里可能不好看`);
    if (s.length > 240) warn.push(`about.${k} 偏长（${s.length} 字）`);
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) {
    warn.push(`版本号建议写成 1.0.0（现在是 ${JSON.stringify(m.version)}）`);
  }
  if (m.author !== undefined && typeof m.author !== 'string') warn.push('author 必须是字符串');
  else if (typeof m.author === 'string' && m.author.length > 80) warn.push(`author 偏长（${m.author.length} 字）`);
  if (!insidePath(m.entry) || typeof m.export !== 'string' || !m.export) fatal.push('entry / export 不合法');
  else if (!existsSync(join(dir, m.entry))) fatal.push(`入口文件不存在：${m.entry}`);
  else {
    const src = await readFile(join(dir, m.entry), 'utf8');
    const hasExport = new RegExp(`export\\s+(async\\s+)?(function\\s+${m.export}\\b|const\\s+${m.export}\\b|\\{[^}]*\\b${m.export}\\b)`).test(src);
    if (!hasExport) fatal.push(`入口没有导出 ${m.export}()`);
  }

  const axes = Array.isArray(m.axes) ? m.axes : [];
  if (!axes.length) fatal.push('axes 为空（Coo 至少要一个轴）');
  for (const a of axes) {
    if (typeof a?.id !== 'string' || !ID_RX.test(a.id)) { fatal.push(`轴 id 不合法：${JSON.stringify(a?.id)}`); continue; }
    if (!namesOf(a.name)) fatal.push(`轴 ${a.id} 缺 name`);
    const opts = Array.isArray(a.options) ? a.options : [];
    if (!opts.length) { fatal.push(`轴 ${a.id} 没有选项`); continue; }
    const seen = new Set();
    for (const o of opts) {
      if (typeof o?.id !== 'string' || !OPTION_ID_RX.test(o.id)) {
        fatal.push(`轴 ${a.id} 的选项 id 不合法：${JSON.stringify(o?.id)}（只能小写字母数字，最长 24，不能带 -）`);
      }
      if (seen.has(o?.id)) fatal.push(`轴 ${a.id} 的选项 id 重复：${o?.id}`);
      seen.add(o?.id);
      if (!namesOf(o?.name)) fatal.push(`轴 ${a.id} 的选项 ${o?.id} 缺 name`);
      if (o?.thumb && !insidePath(o.thumb)) fatal.push(`选项 ${o?.id} 的 thumb 路径不合法`);
      else if (o?.thumb && !existsSync(join(dir, o.thumb))) warn.push(`选项 ${o?.id} 的 thumb 不存在：${o.thumb}`);
    }
  }
  for (const p of Array.isArray(m.presets) ? m.presets : []) {
    if (typeof p?.id !== 'string' || !ID_RX.test(p.id) || !p.pick || typeof p.pick !== 'object') { fatal.push(`预设不合法：${JSON.stringify(p?.id)}`); continue; }
    for (const a of axes) {
      const ids = (a.options ?? []).map((o) => o.id);
      if (!ids.includes(p.pick[a.id])) fatal.push(`预设 ${p.id} 在轴 ${a.id} 上选了不存在的选项 ${JSON.stringify(p.pick[a.id])}`);
    }
  }

  const vocab = Array.isArray(m.vocab) ? m.vocab : [];
  if (!vocab.length) warn.push('vocab 为空：这个形象不会说话');
  const taken = new Set();
  for (const w of vocab) {
    if (typeof w?.id !== 'string' || !ID_RX.test(w.id)) fatal.push(`词 id 不合法：${JSON.stringify(w?.id)}`);
    if (!['expression', 'motion'].includes(w?.kind)) fatal.push(`词 ${w?.id} 的 kind 不认识：${w?.kind}`);
    if (!wordNamesOf(w?.names)) fatal.push(`词 ${w?.id} 缺 names`);
    if (!namesOf(w?.about)) fatal.push(`词 ${w?.id} 缺 about`);
    if (typeof w?.seconds !== 'number' || !(w.seconds > 0)) fatal.push(`词 ${w?.id} 的 seconds 必须 > 0`);
    const all = [w?.id, ...Object.values(w?.names ?? {}).flat()];
    for (const n of all) {
      if (typeof n === 'string' && NAME_BREAK.test(n)) fatal.push(`词名里有 Coo 不接受的字符：${JSON.stringify(n)}`);
      if (taken.has(n)) fatal.push(`词 id / 名字重复：${n}`);
      taken.add(n);
    }
  }

  if (m.thumb && !insidePath(m.thumb)) fatal.push('thumb 路径不合法');
  if (!m.thumb) warn.push('没有 thumb：装扮页会是空白卡片');
  else if (!existsSync(join(dir, m.thumb))) warn.push(`thumb 文件不存在：${m.thumb}`);
  for (const a of axes) {
    for (const o of a.options) {
      if (o.thumb && !insidePath(o.thumb)) fatal.push(`选项 ${o.id} 的 thumb 路径不合法`);
      else if (o.thumb && !existsSync(join(dir, o.thumb))) warn.push(`选项 ${o.id} 的 thumb 不存在：${o.thumb}`);
    }
  }

  // 引用的资源是不是真在包里（我们自己这层的问题，也会让 Coo 出白图）
  for (const rel of ['models/index.js', 'figure.js']) {
    if (!existsSync(join(dir, rel))) fatal.push(`缺少 ${rel}`);
  }
  if (existsSync(join(dir, 'models', 'index.js'))) {
    const reg = await readFile(join(dir, 'models', 'index.js'), 'utf8');
    for (const p of [...reg.matchAll(/"(textures\/[^"]+|motions\/[^"]+|expressions\/[^"]+|physics\/[^"]+)"/g)].map((x) => x[1])) {
      if (!existsSync(join(dir, 'models', m.id, p))) fatal.push(`models/index.js 引用的文件不存在：${p}`);
    }
  }

  // 和已装的其他包撞 id（Coo 会拒绝后加载的那个）
  if (FIGURES && existsSync(FIGURES)) {
    for (const name of await readdir(FIGURES)) {
      const other = join(FIGURES, name, 'figure.json');
      if (!existsSync(other)) continue;
      try {
        const om = JSON.parse(await readFile(other, 'utf8'));
        if (om.id === m.id && name !== expectedId) fatal.push(`id「${m.id}」已被 figures/${name} 占用`);
      } catch { /* 别人的坏包不归我们管 */ }
    }
  }

  return { fatal: [...new Set(fatal)], warn: [...new Set(warn)] };
}

async function install({ id, confirm, force }) {
  if (confirm !== true) throw new Error('需要确认安装');
  if (!state.packDir || !state.built) throw new Error('先构建');
  if (stateView().stale && !force) throw new Error('有未构建的修改，先重新构建');
  if (!FIGURES) throw new Error('还没有连接 Coo：先在右上角选择 Coopanion 目录，或启动时选择');
  await mkdir(FIGURES, { recursive: true });
  const safeId = String(id || state.built.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (!safeId) throw new Error('id 无效');
  const pf = await preflight(state.packDir, safeId);
  if (pf.fatal.length) {
    throw new Error('预检未通过：\n· ' + pf.fatal.join('\n· '));
  }
  const target = join(FIGURES, safeId);
  let backup = null;
  if (existsSync(target)) {
    // 备份放到 figures/ 外面：Coo 会把 figures/ 下每个目录都当形象包扫，.bak 会刷一堆
    // 「id 已被另一个形象包占用」的 WARN，还会拖慢启动。
    const vault = join(dirname(FIGURES), 'figure-backups');
    await mkdir(vault, { recursive: true });
    backup = join(vault, `${safeId}.bak-${Date.now()}`);
    await cp(target, backup, { recursive: true });
    // 只保留最近 2 份：这个目录只用来回滚，留多了纯占地方（一份几十 MB）
    try {
      const olds = (await readdir(vault))
        .filter((n) => n.startsWith(`${safeId}.bak-`))
        .sort();
      for (const n of olds.slice(0, Math.max(0, olds.length - 2))) {
        await rm(join(vault, n), { recursive: true, force: true });
      }
    } catch { /* 清理失败不影响安装 */ }
  }
  await rm(target, { recursive: true, force: true });
  await cp(state.packDir, target, { recursive: true });
  return { target, backup };
}

/* ---------------- 封面 ---------------- */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 只收 PNG data URL；解码后必须带 PNG 头，且 < 1 MB（Coo 的导入页同一上限）。 */
function pngOfDataUrl(raw) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(raw ?? ''));
  if (!m) throw new Error('封面不是 PNG data URL');
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('封面不是有效 PNG');
  if (buf.length > 1024 * 1024) throw new Error(`封面超过 1 MB（${(buf.length / 1048576).toFixed(2)} MB）`);
  return buf;
}

/**
 * 把预览拍的两张封面写进当前构建：
 *   thumb/cover.png     512×512，figure.json 的主封面
 *   thumb/opt-model.png 128×128，轴选项的小图
 * 只改这两个文件和 figure.json 的 thumb 字段；不改 fit / 词表 / 入口。
 */
async function saveCover({ id, png, png128 }) {
  if (!state.packDir || !state.built) throw new Error('先构建');
  if (String(id ?? '') !== state.built.id) throw new Error('封面和当前构建不一致，重新构建后再拍');
  const main = pngOfDataUrl(png);
  const small = pngOfDataUrl(png128);
  const dir = join(state.packDir, 'thumb');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'cover.png'), main);
  await writeFile(join(dir, 'opt-model.png'), small);
  const file = join(state.packDir, 'figure.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.thumb = 'thumb/cover.png';
  if (Array.isArray(manifest.axes) && manifest.axes[0]?.options?.[0]) {
    manifest.axes[0].options[0].thumb = 'thumb/opt-model.png';
  }
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { thumb: 'thumb/cover.png', thumb128: 'thumb/opt-model.png', bytes: main.length, bytes128: small.length };
}

async function serveFile(res, root, rel, extraHeaders = {}) {
  const clean = normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '');
  const file = join(root, clean);
  if (!file.startsWith(root + sep) && file !== root) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not found: ' + clean });
  }
}

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, stateView());
    if (req.method === 'GET' && path === '/api/env') {
      let cfg = null;
      if (CONFIG) {
        try { cfg = JSON.parse((await readFile(CONFIG, 'utf8')).replace(/^\uFEFF/, '')); } catch { cfg = null; }
      }
      const dp = cfg?.worlds?.['desktop-pet'] ?? {};
      return json(res, 200, {
        simple: SIMPLE, scale: dp.window?.scale ?? 1.7, petX: dp.petX ?? null,
        rememberPosition: !!dp.rememberPosition,
        figures: FIGURES, kit: KIT, config: CONFIG,
        coo: cooView(), port: actualPort,
      });
    }
    if (req.method === 'POST' && path === '/api/pick-dir') {
      const dir = await pickFolder('Select the model folder');
      return json(res, 200, { dir });
    }
    if (req.method === 'POST' && path === '/api/pick-coo') {
      const dir = await pickFolder('Select the Coopanion folder');
      if (!dir) return json(res, 200, { coo: cooView(), cancelled: true });
      const next = resolveCoo(dir);
      if (!next) {
        return json(res, 400, {
          error: '这个目录里没有 Coopanion 的 data/home/companion。选 Coopanion 安装目录，或它的 data/home/companion。',
        });
      }
      const saved = saveWorkbenchConfig(next);
      coo = next;
      FIGURES = next.figures;
      CONFIG = next.config;
      return json(res, 200, { coo: cooView(), saved });
    }

    if (req.method === 'POST' && path === '/api/scan') {
      const { dir } = await bodyOf(req);
      return json(res, 200, await scan(String(dir ?? '').trim()));
    }
    if (req.method === 'POST' && path === '/api/build') {
      return json(res, 200, await build(await bodyOf(req)));
    }
    if (req.method === 'POST' && path === '/api/install') {
      return json(res, 200, await install(await bodyOf(req)));
    }
    if (req.method === 'POST' && path === '/api/cover') {
      return json(res, 200, await saveCover(await bodyOf(req)));
    }
    if (req.method === 'POST' && path === '/api/shot') {
      // 预留：预览页把 PNG dataURL 传回来保存
      const { dataUrl, name } = await bodyOf(req);
      const b64 = String(dataUrl ?? '').split(',')[1] ?? '';
      if (!b64) throw new Error('没有图片数据');
      const file = join(WORK, `shot-${String(name ?? 'preview').replace(/[^a-z0-9-]/gi, '')}.png`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(b64, 'base64'));
      return json(res, 200, { file });
    }

    if (req.method === 'GET' && path === '/') return serveFile(res, HERE, 'ui.html');
    if (req.method === 'GET' && path === '/ui.css') return serveFile(res, HERE, 'ui.css');
    if (req.method === 'GET' && path === '/ui.js') return serveFile(res, HERE, 'ui.js');
    if (req.method === 'GET' && path === '/coo-mark.svg') return serveFile(res, HERE, 'coo-mark.svg');
    if (req.method === 'GET' && path === '/preview.html') {
      return serveFile(res, HERE, 'preview.html', { 'content-security-policy': PREVIEW_CSP });
    }
    if (req.method === 'GET' && path === '/preview.js') return serveFile(res, HERE, 'preview.js');
    if (req.method === 'GET' && path === '/preview.css') return serveFile(res, HERE, 'preview.css');
    if (req.method === 'GET' && path.startsWith('/kit/')) return serveFile(res, KIT, path.slice(1));
    if (req.method === 'GET' && path === '/license/core.txt') {
      return serveFile(res, resolve(ROOT, 'pack', 'sdk'), 'LICENSE-live2d-core.txt', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (req.method === 'GET' && path === '/license/components.txt') {
      return serveFile(res, resolve(ROOT, 'pack', 'sdk'), 'LICENSE-live2d-components.txt', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (req.method === 'GET' && path.startsWith('/pack/')) {
      if (!state.packDir) return json(res, 404, { error: '还没有构建包' });
      return serveFile(res, state.packDir, path.slice(6));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

function openBrowser(url) {
  if (!OPEN || process.platform !== 'win32') return;
  try {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch { /* 打不开浏览器不影响服务 */ }
}

let listenTries = 0;
function onListening() {
  actualPort = PORT + listenTries;
  const url = `http://127.0.0.1:${actualPort}/`;
  console.log(`workbench(simple) ${url}`);
  console.log(`coo     ${cooView().connected ? FIGURES : '未连接（只能构建 / 预览）'}`);
  console.log(`kit     ${KIT}`);
  console.log(`simple  ${SIMPLE ? 'on（无 exp3 / motion / pose 绑定）' : 'off'}`);
  if (OPEN) openBrowser(url);
}
function onListenError(e) {
  if (e.code === 'EADDRINUSE' && listenTries < 20) {
    console.warn(`端口 ${PORT + listenTries} 被占用，试 ${PORT + listenTries + 1}`);
    listenTries += 1;
    setTimeout(() => {
      try { server.listen(PORT + listenTries, '127.0.0.1'); }
      catch (err) { console.error(err); process.exit(1); }
    }, 80);
    return;
  }
  console.error(e);
  process.exit(1);
}
server.once('listening', onListening);
server.on('error', onListenError);
server.listen(PORT, '127.0.0.1');
