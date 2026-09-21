# miha_plugin

「智能家居控制器」（HarmonyOS 应用）的**插件源码仓库**与**插件开发教程**。

应用本体采用插件化架构：宿主只提供 JS 沙箱 + Host 桥（网络 / 加密存储 / 摘要 / 日志 / 局域网 socket），
所有设备平台的数据源逻辑都由插件承担。只要有一个能跑通的设备平台
（Home Assistant 集成、厂商开放云、自建网关都行），照着教程写一份 JS 插件，就能被宿主运行时安装并接管设备。

## 目录结构

```
docs/
  插件开发指南.md        ← 插件协议 v1 完整开发教程（清单、登录视图、Host 桥、调试方法）
plugins/
  mijia-cloud/          ← 米家云端插件（完整实现，扫码登录，v1.0.8）
  sample-plugin/        ← 最小示例：form 登录的只读云插件（对应教程 §12）
  sample-lan-plugin/    ← 局域网探测示例：Host.udp 原始 socket 桥用法（对应教程 §12.1）
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
zip -r ../../mijia-cloud-1.0.8.zip .
```

## 教程

从 [`docs/插件开发指南.md`](docs/插件开发指南.md) 开始。纯 REST 云 API 约半天到一天可以移植一个平台；
带局域网私有协议约一周。写完可对照 `plugins/mijia-cloud/`（完整真实实现）和
`plugins/sample-plugin/`（最小可运行示例）校准写法。

## License

插件代码遵循 GPL-3.0-or-later（与各插件 `plugin.json` 声明一致）。
