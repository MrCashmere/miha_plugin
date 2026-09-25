---
name: miha-plugin-dev
description: >-
  为「羊绒家居 / miha」（HarmonyOS 宿主）编写、调试、打包 JS 插件；把 Home Assistant 集成、
  厂商开放云、自建网关的数据源逻辑移植成 miha 插件；排查「装进去就不动」「插件未能加载」
  「设备显示离线」这类插件侧故障。覆盖 plugin.json 清单与 capabilities 承诺、Plugin.register
  生命周期钩子、Host 原生桥（http / httpForm / secureStore / crypto / log / udp / tcp / tls）、
  三种登录视图（qr / web / form）、设备数据面形状与 MIoT 能力描述、stream 取流与 gatewayAdmin
  网关管理，以及打包发布到 GitHub Release 的完整流程。
  触发词：miha 插件、羊绒家居、写个插件、插件开发指南、plugin.json、Plugin.register、Host.http、
  Host.secureStore、Host.udp、扫码登录插件、移植 HA 集成、插件打包、插件调试。
license: GPL-3.0-or-later
---

# miha 插件开发

「羊绒家居」（miha）是一个 HarmonyOS 应用，采用**插件化架构**：宿主只提供
ArkWeb 的 JS 沙箱 + 一套原生桥（`Host`），**所有设备平台的数据源逻辑都由插件承担**。

> 官方仓库：<https://github.com/MrCashmere/miha_plugin>
> 完整教程：`docs/插件开发指南.md`（协议 v1，唯一的权威来源）
> 最小样例：`plugins/sample-plugin/`（form 登录只读云插件）、`plugins/sample-lan-plugin/`（UDP 探测）
> 厂商云端链路（扫码登录 / 取流 / 网关管理）属厂商专属能力，仓库不提供源码，请对照目标平台开放文档自行移植

**写插件之前先做一件事**：把 `plugins/sample-plugin/main.js` 从头读一遍。
它是「注册 → 读凭据 → 登录 → 拉设备 → 控制」的最小可运行闭环，注释里写满了踩过的坑。
照它改，比照文档从零写好得多。

---

## 0. 一句话心智模型

```
┌─────────────────────────────────────────────┐
│ 宿主（ArkTS / HarmonyOS）                     │
│   PluginManager ── 权限、卡片、登录面板、UI    │
│        │                                     │
│   PluginSandbox ── ArkWeb 里的零尺寸 Web 组件  │
│        │  runJavaScript / registerJavaScriptProxy
│        ▼                                     │
│   ┌───────────────────────────┐              │
│   │ JS 沙箱：只有两个全局对象   │              │
│   │   Plugin  ← 你注册自己     │              │
│   │   Host    ← 你借原生能力   │              │
│   │   其它一律没有             │              │
│   │   （没有 @ohos.*、没有 fetch、没有 document）
│   └───────────────────────────┘              │
└─────────────────────────────────────────────┘
```

一个插件就是一个 zip，根目录下至少：

```
my-platform-1.0.0.zip
├── plugin.json      # 清单：id、权限、能力声明、登录方式
├── main.js          # 插件逻辑（runtime = "js" 时）
└── icon.png         # 可选，插件卡片图标
```

---

## 1. 十条铁律（违反其一 = 直接失败或静默失效）

按"踩坑代价"排序。**每一条都在真机上真实发生过。**

### 🔴 1. 插件只能是一个文件，不能用 `import` / `export`

宿主只读取 `plugin.json` 的 `entry` 指向的**那一个文件**，把内容原样包进 IIFE 用
`runJavaScript` 执行。所以：

- `import` / `export` → **直接抛语法错误**
- 拆出去的 `crypto.js` 之类 → **永远不会被加载**（孤儿文件，放在 zip 里也不报错）

所有辅助函数写在这一个文件的闭包里。几百上千行是正常的。
真想拆分，只能构建期拼接：`cat a.js b.js > main.js`（闭包共享作用域，函数可直接互调）。

### 🔴 2. `capabilities` 是给宿主的**承诺**，不是愿望清单

声明 `true` 却没实现 → 宿主调用时你收到错误。
**宁可少声明。** 只读插件就别声明 `scenes` / `statistics`。

### 🔴 3. `Device` 的字段名是「米家原始命名」，不是驼峰

写成 `homeId` / `online` / `localIp` **不会报错**，只会静默变成空字符串 ——
界面上表现为「设备没有房间、显示离线、图标不对」，极难定位。

```ts
{
  did, name, model, spec_type, room_id, room_name, home_id, home_name,
  isOnline,      // ← 注意是 isOnline，不是 online
  token, local_ip, parent_id, subdir? ...
  uid, pid, icon, group_id, ssid, bssid, orderTime, rssi,
  extra: { fw_version }
}
```

宿主刻意这么设计，就是为了让**米家体系的平台能把云端对象原样透传**（映射表是 bug 温床）。
非米家平台要自己往这个形状上凑。详见 `references/protocol.md`。

### 🔴 4. 写操作失败必须 `throw`，不能返回 `false` / `undefined`

返回假值会被宿主当成「写成功」，界面显示「已打开」而设备其实没动 —— 最难查的一类 bug。

### 🔴 5. `loginPoll` **只会收到 `sessionId`**，没有第二个参数

轮询地址、会话对象必须存在**插件自己的状态里**（比如 `sessions.get(sessionId)`）。
宿主不替你保存、也不会回传。

### 🔴 6. `qr` 登录的 `pollInterval` 必须 **> 0**

宿主只在 `pollInterval > 0` 时才起轮询。省略或写 `0` = **完全不轮询**：
二维码挂着永远不被处理，用户扫了没反应，**且没有任何报错**。

### 🔴 7. 「还没扫」要返回 `state: 'pending'`，**不要抛错**

宿主对连续异常零容忍：**连续 3 次 `loginPoll` 失败就判登录失败并关弹窗**。
长轮询超时、网络抖动都属于正常情况，一律按 `pending` 返回。
真正该报错的是「二维码过期」→ `expired`，或凭据不合法 → `error`。

### 🔴 8. `secureStore.get()` 读回来**可能已经是对象**

`set(key, value)` 的 value 必须是字符串；但桥的拆包层发现存的字符串以 `{` 或 `[` 开头时，
会**直接 parse 成对象**返回。所以：

```js
const stored = await Host.secureStore.get('auth');
const data = (typeof stored === 'string') ? JSON.parse(stored) : stored;  // ✅
// const data = JSON.parse(stored);  // ❌ 对象被 String() 成 "[object Object]" → 语法错误
```

只写 `JSON.parse(stored)` 的后果：`init()` 静默 `return false`，登录后家庭 / 设备全空。

### 🔴 9. 没有 `Host.crypto.rc4`，也没有宿主级 MQTT

鸿蒙系统加密库不含 RC4，宿主无法凭空提供。需要 RC4（比如米家签名）就在插件 JS 里自己实现（十几行）。
MQTT 也没有开箱支持 —— 要连 broker 得用 `Host.tls` 自己拼报文（或者改用轮询）。

### 🔴 10. `init()` 可能被调用**多次**，且 socket 回调必须在这里注册

沙箱所在的页面切换 / 弹窗弹出都会导致 ArkWeb 重建，重建后 `init()` 会**再跑一次**。所以：

- `init()` 必须**幂等**（别重复开 socket、别重复建定时器）
- **不要**在模块顶层注册"只做一次"的东西
- socket 回调**必须在 `init()` 里重新注册** —— 回调注册表在页面重建后会清空

---

## 2. 开发流程

### Step 0 — 先判断走哪条路

| 你的平台是 | 走法 |
| --- | --- |
| REST + 固定签名 + JSON，无状态登录 | **L0 声明式**：`runtime: "declarative"`，只写 JSON，零代码 |
| 有二维码/OAuth/表单登录，或需要 Cookie 会话 | `runtime: "js"`，自己实现 `login*` |
| 局域网私有二进制协议（miio、自定义 UDP） | `runtime: "js"` + `Host.udp` / `Host.tcp` |
| 需要 MQTT 长连接 | `runtime: "js"` + `Host.tls`，自己实现 MQTT 帧 |
| 厂商私有云 / 需要抓包还原的接口 | `runtime: "js"`，按抓包结果自己实现签名与会话；优先移植社区已有开源实现 |

工作量的经验值：**纯 REST 云 API 约半天到一天；带局域网私有协议约一周。**

### Step 1 — 写 `plugin.json`

最小可用清单（完整字段见 `references/protocol.md`）：

```jsonc
{
  "schemaVersion": 1,
  "id": "com.example.myplatform",     // 全局唯一，建议反向域名
  "name": "我的平台",
  "version": "1.0.0",                 // semver
  "runtime": "js",
  "entry": "main.js",
  "hostMinVersion": "2.0.0",
  "description": "一句话说明",
  "author": "you",
  "license": "GPL-3.0-or-later",
  "permissions": ["network", "secureStore", "log"],
  "login": { "type": "form" },        // 不需要登录就整个删掉这个字段
  "capabilities": {
    "homes": true, "devices": true,
    "scenes": false, "spec": false, "statistics": false, "messages": false,
    "consumables": false, "lanControl": false, "gatewayControl": false
  },
  "update": { "source": "github", "repo": "you/repo", "assetPattern": ".*\\.zip$" }
}
```

⚠️ **没有登录需求的插件就不要写 `login` 字段** —— 那会让卡片上出现一个「登录」按钮，
点开是个空表单。缺省即表示「本插件不需要凭据」。

### Step 2 — 搭 `main.js` 骨架

```js
let auth = null;

Plugin.register({
  async init(ctx) {
    const stored = await Host.secureStore.get('auth');
    if (!stored) return false;               // false = 需要登录
    auth = (typeof stored === 'string') ? JSON.parse(stored) : stored;
    return true;                             // true = 已连接可用
  },
  async loginBegin() { /* → { sessionId, view } */ },
  async loginPoll(sessionId) { /* → { state } */ },
  async loginSubmit(sessionId, fields) { /* → { state } */ },
  async loginCancel(sessionId) { /* → { state: 'cancelled' } */ },
  async getHomes() { /* → Home[] */ },
  async getDevices(homeIds) { /* → { [did]: Device } */ },
  async getSpecForDevice(device) { return null; },
  async createTransports(device) { return []; },
  async dispose() { /* 断开长连接、停定时器 */ }
});
```

`ctx` 带 `pluginId` / `dataDir`（本插件私有沙箱目录）/ `hostVersion` / `locale`。

### Step 3 — 实现登录

按平台性质选视图：

| 平台 | `login.type` | 交互 |
| --- | --- | --- |
| 米家扫码、大部分国内厂商 | `qr` | 你给二维码 URL，宿主画图 + 轮询 |
| HA 官方 OAuth、Tuya、SmartThings | `web` | 你给授权 URL，宿主开 WebView 拦回调 |
| 自建网关、账密 | `form` | 你给字段描述，宿主画原生输入框 |

**分工**：你只给**视图数据**，宿主负责画界面、起轮询、跑倒计时、开 Web 视图、拦回调 URL、收表单值。
凭据存取（`Host.secureStore`）完全由你自己管，宿主不碰也看不见。

```js
async loginBegin() {
  const s = newSession();
  const ticket = await buildQrTicket(s);
  sessions.set(s.id, s);                     // ⚠️ 会话必须自己存
  return {
    sessionId: s.id,
    view: {
      type: 'qr',
      imageUrl: ticket.qrUrl,                // 或 imageDataUri（data: URI）
      hint: '请用平台 App 扫码',
      expiresIn: 180,                        // 秒；建议给，否则用户对着失效码干等
      pollInterval: 1000                     // 毫秒；qr 必须 > 0
    }
  };
}
```

> **为什么 `imageUrl` 要宿主去下载？** 沙箱里的 `fetch` 受 CORS 限制，
> 而二维码接口通常不带跨域头。宿主用自己的网络栈取图。

`web` 视图的 `stopPrefixes` 是**前缀匹配**（授权回调通常带一长串 query），
宿主拦下跳转后把完整 URL 作为 `fields.callbackUrl` 交给 `loginSubmit`。

`form` 的字段类型只有 `text` / `password` / `switch`；**所有表单值都是字符串**
（`switch` 传 `'true'` / `'false'`）。未知类型按 `text` 处理，不报错。

### Step 4 — 实现数据面

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `getHomes()` | `() → Home[]` | 家庭 / 房间分组的顶层容器 |
| `getDevices(homeIds?)` | `(string[]?) → Record<did, Device>` | **key 必须是 did** |
| `getScenes(homeId)` | `→ Scene[]` | 云端场景 |
| `runScene(sceneId, homeId)` | `→ Result` | 触发场景 |
| `getSpecForDevice(device)` | `→ MIoTSpec \| null` | 设备能力描述 |
| `createTransports(device)` | `→ TransportHandle[]` | 控制通道 |
| `getStatistics(did, key, type, limit, from, to)` | `→ Object[]` | 历史数据 |
| `checkMessages(beginAt?)` / `getMessageList(homeId)` | `→ MessageItem[]` | 通知 |
| `getConsumableItems(homeId)` | `→ ConsumableItem[]` | 耗材 |
| `getStreamUrl(device)` | `→ {url, kind, expiresIn, source}` | 需 `stream` |
| `saveStreamUrl(device, url)` / `clearStreamUrl(device)` | | 需 `stream` |
| `gatewayInfo / gatewayLogin / gatewayForget / gatewayClients / gatewaySetBlocked / gatewayReboot` | | 需 `gatewayAdmin` |

**非 MIoT 平台的两条路**（`getSpecForDevice`）：

1. **翻译成 MIoT**（推荐）：把 entity 映射成 `siid=1` 下的若干 `piid`，宿主 UI 全部自动复用。
2. **返回 `null`**：宿主降级为「开关 + 详情」的简化卡片。功能少，但一天能做完。

> ⚠️ 返回 `null` 的前提是 `capabilities.spec` 是 `false`。声明 `true` 却返回 `null`，
> 宿主按「拿到空 spec」处理并报错。

**控制通道 `createTransports`**：

```js
async createTransports(device) {
  return [
    { id: 'lan',   kind: 'lan',   priority: 10  },   // priority 小的先试
    { id: 'cloud', kind: 'cloud', priority: 100 }
  ];
}
// 宿主随后调用：getProperties / setProperty / callAction
```

⚠️ **写操作只在第一条可用通道上执行一次，失败不重试** —— 因为局域网超时往往只是回包丢了、
设备其实已经执行了，再往云端重发一次就是重复开灯。**所以 `priority` 的顺序是你的责任。**

可选钩子 `isTransportAvailable(transportId, device?)`：不实现则默认「可用」，
让真正的调用去失败。想省掉注定失败的外呼（比如设备已知离线）再实现它。

### Step 5 — 本地自检（**重要**）

> ⚠️ **本仓库里没有 `scripts/` 目录。** 开发指南 §13 提到的
> `simulate_plugin_load.js` / `check_bootstrap_template.js` / `verify_bootstrap_stitch.js` /
> `verify_invoke_handshake.js` 属于**宿主工程**，不在这个仓库里。
> 拿到宿主工程后才谈得上跑它们。

没有模拟器时，用下面这套低成本自检：

1. **静态检查**：`node --check main.js` —— 能直接抓到 `import` / `export` 语法错误（铁律 1）。
2. **假 `Plugin` / `Host` 跑一遍**：写个几十行的 Node 脚本，`vm` 里注入
   `Plugin = { register(o) { global.o = o } }` 和 `Host` 替身，
   然后用 IIFE 包住 `main.js` 执行，断言：
   - 顶层代码没抛异常
   - 确实调了 `Plugin.register`
   - 逐钩子调 `init` / `getHomes` / `getDevices` / `createTransports`，打印返回值
   - 记录调了哪些 `Host.*` 方法（顺带验证权限声明是否齐）
3. **别在假环境里发真请求**：`Host.http` 替身直接抛错即可，安全可反复跑。
   只做计算的部分（签名、编解码、加解密）可以验到具体数值。
4. **登录链路**：给 `Host.http` 换成返回固定假票据的替身，再多跑一步 `loginBegin()`，
   逐条复现宿主的判定（`sessionId` 空否？`view` 缺失？`view.type` 三选一？
   `imageUrl` / `pollInterval` 给了没？）。

**自检能提前抓到的**：`import`/`export`、加载期顶层异常、忘了 `Plugin.register`、
钩子返回了不可序列化的东西（函数、循环引用）。

### Step 6 — 真机验证

1. 应用内点「**安装内置示例**」，确认能装上、出现卡片（不需要网络，验证宿主链路）
2. 点「确认并启用」→ 卡片变「已连接」
3. 点卡片上的「登录」→ 确认面板按你声明的 `login.type` 渲染
4. 把自己的插件打包成 zip，用「**从文件导入**」装进来，对比行为差异

日志检索：`[plugin:<你的插件id>]` 是 `Host.log` 输出，`[PluginSandbox]` 是宿主侧加载过程
（注册失败、bootstrap 失败都打在这里）。

### Step 7 — 打包与发布

```bash
cd plugins/my-platform
zip -r ../../my-platform-1.0.0.zip .      # zip 根下必须直接是 plugin.json + main.js
```

⚠️ **别把目录本身打进 zip**（不能是 `my-platform-1.0.0/plugin.json`，必须是 `plugin.json`）。

发布（推荐 GitHub Release）：

1. 打 tag `v1.0.0`（与 `plugin.json` 的 `version` 一致；带不带 `v` 都行，宿主会自动去掉）
2. 把 zip 作为 release asset 上传
3. 可选：同名 `.sha256` 文件，宿主会校验

用户在应用里粘贴 `https://github.com/you/repo` 即可安装，宿主读 `releases/latest` 并按
`assetPattern` 匹配。⚠️ GitHub 未认证 API 限流 **60 次/小时/IP**，用户装不上时让他改用直链。

**签名机制（`plugin.sig` / `publicKey`）目前尚未实现**，宿主不做任何签名校验 ——
别在插件里填 `publicKey`，填了不会报错也不会更安全。所以只装信得过的来源。

---

## 3. 移植 Home Assistant 集成

| HA 侧的什么 | 映射到 miha 的什么 |
| --- | --- |
| `config_flow.py` 的 `async_step_auth` + 二维码 | `login.type = "qr"` |
| `config_flow.py` 的 OAuth2 `authorize_url` | `login.type = "web"` |
| `config_flow.py` 的 `async_step_user`（填 host/token） | `login.type = "form"` |
| `__init__.py` 的 `async_setup_entry` | 你的 `init()`，client 对象改写成 JS 闭包 |
| `api.py` / `client.py` 的 `async def get_xxx` | `Host.http(...)` |
| `entity.py` 的 `supported_features` / `device_class` | 决定 `getSpecForDevice` 走 MIoT 还是 `null` |
| `const.py` 的 `DOMAIN` | 作为 `plugin.id` 前缀，避免撞车 |
| `manifest.json` / `translations/` / `requirements` | **删掉**（换成 `plugin.json`；依赖用 JS 自实现） |

**最容易踩的坑**：HA 集成普遍假设"有个 Python 生态"（`paho-mqtt`、`cryptography`、各种 SDK）。
先看 `Host.crypto` 覆盖了没有（有 sha1 / sha256 / hmac-sha1 / 随机数，**没有 rc4 和对称加密**），
再没有就只能自己实现。

---

## 4. 快速参考：`Host` 桥

全部返回 Promise，都要 `await`。桥调用失败**抛异常**（不是返回 `{ok:false}`），
最常见失败原因是权限没声明。完整的参数与陷阱见 `references/host-bridge.md`。

```ts
// 网络（需 network）
Host.http(method, url, headers, body)   → { status, body, headers, cookies }
Host.httpForm(url, headers, fields)     → 同上；fields 必须是**键值对象**，不是编好的字符串！

// 私有存储（需 secureStore，按 pluginId 隔离）
Host.secureStore.get(key) / set(key, value) / delete(key)

// 加密（需 crypto）
Host.crypto.sha1Hex / sha256Hex / sha256Base64 / sha1BytesBase64 / sha256BytesBase64
Host.crypto.base64ToHex / hexToBase64 / hmacSha1 / randomBytes(n) → base64

// 日志（需 log）
Host.log.info(tag, msg) / Host.log.error(tag, msg)

// 宿主缓存的设备对象，不需要额外权限
Host.getDevice(did) → Device | null

// 原始 socket（udp/tcp 需 lan，tls 需 mqtt）
Host.udp.open/onMessage/send/close
Host.tcp.open/onMessage/onClose/send/close
Host.tls.open({host, port, clientCert, clientKey, ca})/onMessage/onClose
```

**三个高频细节**：

- `Host.http` 是你发网络请求的**唯一**方式（沙箱的 `fetch` / `XHR` 被 CORS 挡住）。
  返回的 `headers` **键名已统一小写**；`cookies` 是系统解析好的 Cookie 串。
  取 Cookie **优先用 `res.cookies`**，`headers['set-cookie']` 只作兜底。
- 很多平台的登录靠 **Cookie 串联**（先请求 A 拿 Cookie，请求 B 必须带上）。
  少了这一步服务端**不报错**，只是给一个内容不全的响应，表现成「二维码出不来」。
- 载荷跨 JS 边界**一律 Base64**（用 `btoa` / `atob`）。
  ⚠️ **别用 `TextEncoder`**：报文是任意二进制，走 UTF-8 编解码会在非 ASCII 字节上直接损坏数据。

---

## 5. 分册参考

| 文件 | 什么时候读 |
| --- | --- |
| [`references/protocol.md`](references/protocol.md) | 要写 `plugin.json`、查钩子/方法签名、`Device`/`Home` 形状、stream 与 gatewayAdmin、L0 声明式、版本协商 |
| [`references/host-bridge.md`](references/host-bridge.md) | 要调 `Host.*`：HTTP/Cookie、secureStore 形状、字节级摘要、udp/tcp/tls 的边界 |
| [`references/troubleshooting.md`](references/troubleshooting.md) | 插件**装进去不动**、没登录按钮、一直转圈、设备离线、日志里出现奇怪报错时 |
| [`../../docs/插件开发指南.md`](../../docs/插件开发指南.md) | 权威原文。分册与它冲突时，**以原文为准**（分册可能过期） |

---

## 6. 交付前检查清单

- [ ] `plugin.json` + `main.js` 在 zip **根**目录
- [ ] `main.js` 里没有 `import` / `export`，`node --check` 通过
- [ ] `Plugin.register({...})` 在顶层被调用，传入的是对象
- [ ] `capabilities` 里每个 `true` 都真的有对应实现；没实现的一律 `false`
- [ ] `permissions` 覆盖了所有实际用到的 `Host.*`（少一个 → 调用抛异常）
- [ ] 不需要登录 → 没有 `login` 字段
- [ ] `qr` 视图给了 `pollInterval > 0`；`loginPoll` 的排队态返回 `pending` 而非抛错
- [ ] 凭据读写用 `Host.secureStore`，且读取时兼容「字符串 / 对象」两种形状
- [ ] `Device` 字段名逐字对齐（`did` / `isOnline` / `room_id` / `local_ip` / `parent_id`）
- [ ] `getDevices` 返回的 key 是 `did`；返回值 JSON 可序列化（无函数、无循环引用）
- [ ] `setProperty` / `callAction` 失败时 **throw**
- [ ] `init()` 幂等；socket 回调在 `init()` 里注册
- [ ] 实现了 `dispose()`，停掉定时器 / 关掉 socket
- [ ] 打包后 zip 根下直接是 `plugin.json`（没有多套一层目录）
