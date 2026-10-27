/**
 * 入口：按 skin 选的模型，交给 Live2D 后端（该后端挂在 kit 上）。
 *
 * 模型清单来自 models/index.js（由 tools/convert.mjs 生成），
 * 加模型只要往 models/ 里再丢一份、并在 figure.json 的 axes 里加个选项。
 */
export async function createFigureBody(base, opts) {
  const { kit } = opts;
  if (!kit) throw new Error('缺 kit：Live2D 后端需要 kit.createBody');

  const { models } = await import('./models/index.js');
  const first = Object.keys(models)[0];

  // scheme 是多轴选项用 '-' 拼起来的；对不上任何模型就退回第一个，
  // 免得换过别的形象后残留的 scheme 把这里顶死。
  const wanted = (opts.scheme || '').split('-')[0];
  const entry = models[wanted] ?? models[first];
  if (!entry) throw new Error('models/index.js 里没有可用模型');

  await loadScript(String(new URL('sdk/live2dcubismcore.min.js', base)));
  if (!globalThis.Live2DCubismCore) {
    throw new Error('sdk/live2dcubismcore.min.js 没加载成功');
  }

  const { createLive2DBody } = await import('./backends/live2d.js');
  return createLive2DBody(base, opts, entry, kit);
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载失败：${url}`));
    document.head.appendChild(s);
  });
}
