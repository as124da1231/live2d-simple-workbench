# SoulLink Emotion engine（随包分发）

- 名称：`@soullink-emotion/engine`
- 版本：`0.2.0-beta.1`
- 上游：https://github.com/nanlingyin/soullink-emotion-sdk
- 许可证：Apache-2.0（见同目录 `LICENSE`）

本目录包含构建产物 `index.js` 与 `chunk-OPVA6SRP.js`。
它负责 VAD 情绪状态、FACS、待机微动、眨眼、呼吸和语音动作编排；
FACS → role 的翻译在 `../../backends/soullink.js`，模型数据在 `models/<id>/profile.js`。

引擎是纯计算、零依赖、无 DOM/网络访问，因此可以整包放进 figure frame 的沙箱。
