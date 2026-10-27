# Live2D Cubism 运行时（随包）

这个目录**包含**预览和运行所需的 Cubism 运行时，不属于 AGPL：

- `live2dcubismcore.min.js` — Cubism Core
  - Live2D Proprietary Software License
  - 完整文本：本目录 `LICENSE-live2d-core.txt`
  - 该文件属于许可第 5 条的 Redistributable Code，允许随衍生作品原样分发
- `framework.js`、`shaders.js` — Live2D Cubism SDK for Web 的预构建 / 内联着色器
  - Live2D Open Software License
  - 完整文本：本目录 `LICENSE-live2d-components.txt`

使用、复制、分发这些文件时，必须同时遵守 Live2D Inc. 的许可。完整第三方说明见根目录 `NOTICE`。
按 Live2D 许可第 5.2.2 条，继续使用即表示同意上述许可；首次打开工作台会显示一次提示。
如果你要换成自己从 live2d.com 下载的 SDK，保持文件名不变即可。

## 沙箱约束（Coo 侧）

```
sandbox allow-scripts; default-src 'none'; script-src 'self';
img-src 'self' data: blob:; style-src 'unsafe-inline'; connect-src 'none'
```

- `connect-src none` → moc3/JSON 不能 fetch，已由 live2d-to-pack.py 转成 JS 模块
- 贴图可以正常 `loadImage`：figure-frame 响应带 `Access-Control-Allow-Origin: null`
- `script-src` 没有 `'wasm-unsafe-eval'` → **WASM 被禁**；Cubism Core 必须是纯 JS 版本
