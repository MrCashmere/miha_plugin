# miha_plugin

「羊绒家居」（HarmonyOS 应用）的**插件源码仓库**与**插件开发教程**。

应用本体采用插件化架构：宿主只提供 JS 沙箱 + Host 桥（网络 / 加密存储 / 摘要 / 日志 / 局域网 socket），
所有设备平台的数据源逻辑都由插件承担。只要有一个能跑通的设备平台
（Home Assistant 集成、厂商开放云、自建网关都行），照着教程写一份 JS 插件，就能被宿主运行时安装并接管设备。
当然，你甚至可以使用AI Agent来自行移植已有开源实现的项目到插件来使用。

## AI Agent 开发插件实例
涂鸦插件移植（源仓库[make-all/tuya-local](https://github.com/make-all/tuya-local)）：[MrCashmere/miha_tuya_plugin](https://github.com/MrCashmere/miha_tuya_plugin)

## 目录结构

```
docs/
  插件开发指南.md        ← 插件协议 v1 完整开发教程（清单、登录视图、Host 桥、调试方法）
plugins/
  mijia-cloud/          ← 米家云端插件（完整实现，扫码登录，v1.0.8）
  sample-plugin/        ← 最小示例：form 登录的只读云插件（对应教程 §12）
  sample-lan-plugin/    ← 局域网探测示例：Host.udp 原始 socket 桥用法（对应教程 §12.1）
skills/
  miha-plugin-dev/      ← 给 AI 助手用的插件开发 Skill（见下）
```

## 安装插件

三种方式任选：

1. **GitHub Release**：从本仓库 [Releases](https://github.com/MrCashmere/miha_plugin/releases) 下载打包好的 zip，用应用内「从文件导入」安装；
2. **直链**：在应用内填 zip 的下载直链安装；
3. **本地**：直接导入本地 zip 文件。

## 打包插件

插件目录就是一个普通的 zip（根下含 `plugin.json` + `main.js`）：

```bash
cd plugins/mijia-cloud
zip -r ../../mijia-cloud-1.0.25.zip .
```

## 教程

从 [`docs/插件开发指南.md`](docs/插件开发指南.md) 开始。纯 REST 云 API 约半天到一天可以移植一个平台；
带局域网私有协议约一周。写完可对照 `plugins/mijia-cloud/`（完整真实实现）和
`plugins/sample-plugin/`（最小可运行示例）校准写法。

## 给 AI 助手用的 Skill

[`skills/miha-plugin-dev/`](skills/miha-plugin-dev/SKILL.md) 是一份可直接被 AI Agent
加载的**插件开发 Skill**：把上手指南、协议速查、`Host` 桥陷阱、故障排查表整理成
「主入口 + 分册参考」的结构，让 AI 不用读完 1500 行原文就能写出正确的插件。

```
skills/miha-plugin-dev/
├── SKILL.md                        # 主入口：心智模型、十条铁律、7 步开发流程、交付检查清单
└── references/
    ├── protocol.md                 # plugin.json 全字段、生命周期钩子、数据面、Device 形状
    ├── host-bridge.md              # Host.http/secureStore/crypto/udp/tcp/tls 的用法与陷阱
    └── troubleshooting.md          # 症状 → 定位表、宿主机制对插件的影响
```

**怎么用**：把它复制到你的 AI 助手认识的位置即可，例如

```bash
# WorkBuddy / 通用做法：放到用户级 skills 目录
cp -r skills/miha-plugin-dev ~/.workbuddy/skills/

# Claude Code：放到项目的 .claude/skills/ 下
mkdir -p .claude/skills && cp -r skills/miha-plugin-dev .claude/skills/
```

之后问它「帮我给 XX 平台写个 miha 插件」「这个插件为什么装进去不动」，
它会自动加载这份 Skill。

> 分册是从开发指南摘出来的**速查**，与原文冲突时以 `docs/插件开发指南.md` 为准。

## License

插件代码遵循 GPL-3.0-or-later（与各插件 `plugin.json` 声明一致）。
