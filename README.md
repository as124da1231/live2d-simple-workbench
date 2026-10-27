# Live2D 简易工作台

Windows 10/11 + Node.js 20+。下载发布包，解压到用户目录，双击 `start.cmd`。

- 当前版本：**1.9.2**
- 仓库：<https://github.com/as124da1231/live2d-simple-workbench>
- 下载：<https://github.com/as124da1231/live2d-simple-workbench/releases/latest>

把 VTS / Live2D 模型目录转换成 Coopanion 可安装的形象包。只做底脸：不绑定 exp3、不播放 motion、不加载 pose3，不需要资源池和映射表。

**本工具是本地构建器：模型只在你自己的机器上处理，输出为单一固定形象包。它不提供加载或托管任意模型的运行时服务。**

## 运行要求

- Windows 10 / 11
- Node.js 20 或更新版本：<https://nodejs.org/>
- 解压到**可写目录**，例如 `%USERPROFILE%\Documents\Live2D-Workbench`
- 不要解压到 `C:\Program Files`：工作台要在自己旁边写 `workbench.config.json` 和 `.workbench/`
- 不需要 `npm install`，不需要构建，不联网
- Python + Pillow 可选，只用于构建时压缩大贴图；没有也能构建

## 快速开始

1. 从 Releases 下载 `Live2D-Simple-Workbench-v1.9.2.zip`
2. 解压，确认 `start.cmd` 在解压后的根目录
3. 双击 `start.cmd`。命令行窗口会打印实际地址，并自动打开浏览器
4. 首次运行：
   - 检测到 Coopanion 会自动记住路径
   - 没检测到会打开「设置 / 名片」，点 **选择 Coo 目录…**，选 Coopanion 安装目录或它的 `data/home/companion`
   - 只构建 / 预览、暂不安装，也可以稍后再选
5. 顶栏：选目录 → **扫描** → **构建** → 预览确认 → **安装**

   ```text
   选择…   [ 模型目录 ]   扫描   构建   安装
   ```

   - **扫描**：只读模型，列出参数 / role / 校验，不产出包
   - **构建**：生成形象包 + 预览 + 封面
   - **安装**：复制到 Coo 的 figures（没有 Coo 时置灰）

**一个目录下有很多模型？** 直接选**上一级目录**再点构建：左侧「模型」卡会列出这个目录（含子目录，最深 4 层）里所有带 `.model3.json` 的模型，点哪个就构建哪个，不用再来回选文件夹。

```text
G:\models\                ← 选这个
  akari_vts/
  hiyori_vts/
  tororo_vts/
  wanko_vts/
```

列表点过一次后，切换模型就是一次点击（会重新扫描 + 构建 + 出封面）。

**「选择…」是浏览器的文件夹选择框**，选完会把模型文件导入到 `.workbench/imported/`（只保留最近 3 份）。只复制 `.model3.json` / `.moc3` / 贴图 / `physics3` / `cdi3` / `motion3` / `exp3` 这些，目录里的视频和压缩包会被跳过。也可以直接在输入框里粘贴绝对路径来避免复制。

## Coo 是可选的

- 没连接 Coo：扫描、构建、预览、自动贴合、封面、名片都可用；只有「安装」置灰，悬停会说明原因
- 连接 Coo：安装会复制到 `<Coo>\data\home\companion\data\figures\<id>`
- 安装前会自动创建 `figures` 目录；已有同名包会先备份到 `figure-backups/`
- 不会修改 Coo 的 `config.json`，不会重启 Coo
- 安装后要在 Coo 的装扮页切换到该形象

## 工作流程

```text
选择模型目录
→ 扫描：参数 / role / 贴图 / PartOpacity 基线
→ 名片：名字、一句话、作者、版本、鸣谢、运动
→ 构建：生成 figure.json + profile.js + 运行时
→ 预览：桌面层 / 身体层，自动贴合，确认取景
→ 安装：预检 → 备份 → 复制到 Coo 的 figures/
```

顶栏只有四个主要动作：目录、选择、构建、安装。

## 表情

表情只走底脸通道：

```text
Coo 词 → kit 脸名 → SoulLink（VAD / FACS）→ role → 真实参数
        + 通用配方（happy / angry / …，按模型实际 role 过滤）
        + 眨眼 / 口型 / 视线 / 呼吸
```

- 不读取、不绑定原生 exp3
- 不播放 motion / Idle；只读取 motion 里的 `PartOpacity` 作为中性部件基线
- 不加载 pose3
- `models/index.js` 里没有 motions / expressions / pose
- 固定 3 列表情按钮，不出现表情卡片内部滚动
- 表情卡片标题栏有「平静」，随时回到中性

## 预览

### 桌面层

- 真实屏幕尺寸，`S = .42 × window.scale`
- 白色舞台、浅灰外围、地板 / 任务栏
- 可移动中心带、拎起带、0.7W / 记忆位置 / 当前位置
- 鼠标拖动走真实 pointer 流程

### 身体层

- 256 logo 盒、脚线 256、抓取点 `(128, 36)`
- 可见 alpha 范围、三段命中圈、视线 / 泪 / z / 心 / 气泡锚点
- 取景缩放 / 横向 / 纵向滑杆，也可以直接拖模型
- 自动贴合开关：开 = 自动量，关 = 手动；拖模型或动滑杆会切到手动
- 契约读数：抓取偏移、脚底离地、中心偏移、头顶是否可抓

自动贴合只改模型在 256 盒里的取景矩阵，不改 moc3、骨骼、表情、部件或物理。目标是：

```text
脚底 → 256
躯干可见带中心 → 128
高度 → 约 232
宽度 → ≤ 208
```

量尺寸前会强制渲染一帧中性姿势，避免呼吸 / 待机让包围盒随帧漂移。

## 运动

「设置 / 名片」里选构建运动方式：

- **灵动**：跟随 Coo 的「站定 / 安静 / 常走动」，`can.walk: true`
- **站定**：强制 `roam off`，`facing` 固定 1，`can.walk: false`

灵动交给 kit 自己的程序化运动：

```text
look / walk / run / jump / sit / expr / wait
```

所以它会走、会跑、会坐下、会睡着、会跳，也会按方向翻转。这是旧版的真实行为，不是原生 motion。想要完全不动、正面不镜像，选「站定」。

预览默认「自由」，进页面默认停在「身体层」（角色看得清）；可以在预览工具条切「桌面层 / 身体层」和「安静 / 站定」。灵动速度由 kit 自己控制，没有可调滑杆；拖拽、外部 `pet_move_to`、对话 / 倾听 / 思考时 kit 会自己让路。

## 封面

构建完成、预览就绪后自动生成封面：

```text
中性姿势 + 专用取景（高 200 / 脚底 236 / 躯干中心 128）
→ 读像素 → 翻转 → 反预乘 → 512×512 透明 PNG
→ 128×128 轴小图
```

- 写进当前构建：`thumb/cover.png`、`thumb/opt-model.png`
- 更新 `figure.json` 的 `thumb` 和 `axes[0].options[0].thumb`
- 两张都小于 1 MB
- 封面从固定基准取景出发，同一模型重复构建结果一致
- 拍封面会恢复原来的取景和命中圈，不影响预览
- 失败或超时不会阻断安装，仍可「重拍封面」

## 名片

「设置 / 名片」里编辑：

```text
名字（中 / 英）
一句话（中 / 英）
作者
版本（默认 1.0.0）
鸣谢
运动方式（灵动 / 站定）
身体幅度（0.5× – 3×，待机 / 呼吸）
动作风格（自然 / 活泼 / 安静 / 害羞）
封面（96×96 + 重拍）
```

写进 `figure.json`：

- `name` / `about`：Coo 卡片、导入页、AI 的「你现在的样子」都用这两个
- `version` / `author`：导入页显示 `版本 · 作者`；作者留空就不显示
- `credits`：鸣谢；留空就不写
- `axes[0].options[0].name`：跟着名片名字走

形象名和一句话是普通展示文本，可以带空格、逗号、括号。预检只拦控制字符，并对 `about` 里的 `< > "`、超长文本、非 `1.0.0` 版本号给提醒，不直接拒包。

`身体幅度` 和 `动作风格` 构建时写进 `profile.performance.tuning`：`bodyGain` 放大待机 / 呼吸 / 微动 / 说话时的身体动作，`style` 影响手势频率、眨眼、呼吸节奏和微动强度。**它们不影响走跑**——走路时的前倾、起伏、步幅由 kit 自己算。改完需要重新构建。

## 没连接 Coo

```text
扫描 / 构建 / 预览 / 封面 / 名片：可用
安装：按钮置灰
提示：未连接 Coo：只能构建 / 预览，不能安装
```

点右上角 `Coo`，或打开「设置 / 名片」重新选择目录。

## 端口 / 配置 / 清理

- 默认端口 `4700`，被占用会自动 `+1`，控制台打印实际地址
- `start.cmd` 会按实际端口打开浏览器
- 本机 Coo 路径记在 `workbench.config.json`，不会提交到仓库
- 构建产物、取景记忆、截图在 `.workbench/`，不会提交到仓库
- 删除 `.workbench/` 会丢掉本地构建和取景记忆，不影响源码
- 换 Coo 路径：点右上角 `Coo` 重新选择

命令行也可以手动启动：

```text
node tools/workbench/server.mjs --port 4700 --open
node tools/workbench/server.mjs --port 4700 --coo "<Coopanion 目录>"
node tools/workbench/server.mjs --port 4700 --no-coo
```

## 常见问题

**构建 / 预览正常，但安装是灰的？**
没连接 Coo。点右上角 `Coo` 选择目录；连接后安装会恢复。

**端口 4700 被占用？**
会自动用 4701、4702；以控制台打印的地址为准。

**安装后 Coo 里没变化？**
安装只复制文件，不会改 Coo 配置。去 Coo 的装扮页切换形象。

**模型有 8K 贴图，构建很慢？**
装 Python + Pillow 后构建会降采样到 2048；没有 Python 也能构建，运行时会兜底缩图。

**封面 / 名片改了没生效？**
封面和名片都在构建时写入形象包。改完点「构建」，再安装。

**模型 / 贴图版权？**
工作台不附带任何模型。导入和分发模型前，请确认自己有权使用。

## 技术说明

- 简易模式固定 `SIMPLE = true`
- 不读取 exp3；motion 只读 `PartOpacity`；不加载 pose3
- `profile.expressions` 为空；`models/index.js` 的 `motions` 为空
- 运行时 `stepMotion` / `stepExpression` 都不执行
- kit 自己的 look / walk / run / jump / sit 保留；这是 kit 的程序化运动，不是原生 motion
- 部件基线用于 hiyori 这类 `PartArmA` / `PartArmB` 双手臂模型，只显示一套手臂
- 预览使用真实 Coo kit + 包内渲染内核；桌面层和身体层共用同一个身体
- 预览目前还没有接 `/figure-frame` 的 sandbox/CSP 复刻

## 目录

```text
LICENSE / NOTICE         AGPL-3.0-or-later + 第三方许可说明
package.json             版本 / Node 要求
start.cmd                Windows 启动
pack/                    运行时（kit 后端、SoulLink、SDK）
vendor/coo-kit/kit/      Coo 的 kit 快照
tools/convert.mjs        模型 → 形象包
tools/workbench/         本地服务 + UI + 两层预览
workbench.config.json    本机 Coo 路径（运行时生成，不提交）
.workbench/              构建产物 / 取景记忆 / 截图（运行时生成，不提交）
```

## 许可证

本项目按 **AGPL-3.0-or-later** 发布，完整文本见 [LICENSE](LICENSE)。

随包包含：

- Coopanion desktop-pet kit：AGPL-3.0-or-later
- SoulLink Emotion Engine：Apache-2.0
- Live2D Cubism SDK for Web：Live2D Open Software License
- Live2D Cubism Core：Live2D Proprietary Software License

Live2D SDK / Core 不是 AGPL，使用和分发时仍需遵守 Live2D Inc. 的许可。详见 [NOTICE](NOTICE) 和 [pack/sdk/README.md](pack/sdk/README.md)。

两份许可原文随包放在 `pack/sdk/` 下：

```text
pack/sdk/LICENSE-live2d-core.txt          Live2D Proprietary Software License
pack/sdk/LICENSE-live2d-components.txt    Live2D Open Software License
```

`live2dcubismcore.min.js` 的文件头自带声明，它属于 Live2D 许可第 5 条的 **Redistributable Code**，允许随本工具原样分发；本包未修改该文件。

按该许可第 5.2.2 条，最终用户需要同意等效的保护条款。**首次打开工作台会显示一次许可提示；继续使用、构建或分发本包，即表示同意 Live2D Inc. 的上述许可。**

本仓库不包含任何 Live2D 模型、moc3、贴图或表情文件。导入的模型版权归原作者，使用前请确认授权。本工具可以加载任意模型，属于 Live2D 许可所称的「可扩展性应用」；用它发布内容前，请自行确认你与 Live2D 之间的授权安排。
